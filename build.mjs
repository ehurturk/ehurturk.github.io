// Static site generator for the blog.
//
//   node build.mjs                 build ./dist (drafts excluded)
//   node build.mjs --dev --serve   build with drafts, serve on :4000, rebuild on change
//
// Markdown is read exactly as written (Material/Zensical flavour): front
// matter is ignored, the first "# H1" becomes the title, `!!!` / `???`
// admonitions, $...$ / $$...$$ math, footnotes, tables, task lists, mermaid.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeShiki from "@shikijs/rehype";
import rehypeStringify from "rehype-stringify";
import { visit, SKIP } from "unist-util-visit";
import { toString as hastToString } from "hast-util-to-string";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const POSTS = path.join(ROOT, "posts");
const ASSETS = path.join(ROOT, "assets");
const OUT = path.join(ROOT, "dist");

const args = new Set(process.argv.slice(2));
const DEV = args.has("--dev");

// ---------------------------------------------------------------------------
// Markdown preprocessing (in memory only; source files are never touched)
// ---------------------------------------------------------------------------

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function stripFrontMatter(src) {
  return src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

// Python-Markdown admonitions / pymdownx.details:
//   !!! note "Optional title"      -> static box
//   ??? info "Title"               -> collapsed <details>
//   ???+ info "Title"              -> expanded <details>
// Body is the following block indented by a tab or 4 spaces.
const ADMONITION = /^(!!!|\?\?\?\+?)\s+([\w-]+)(?:\s+"(.*)")?\s*$/;

function convertAdmonitions(src) {
  const lines = src.split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(line);
      continue;
    }
    const m = line.match(ADMONITION);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, marker, type, rawTitle] = m;
    const body = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^(\t| {4})/.test(lines[i + 1]))) {
      body.push(lines[++i].replace(/^(\t| {1,4})/, ""));
    }
    // trailing blank lines belong to the document, not the admonition
    let trailing = 0;
    while (body.length && body[body.length - 1].trim() === "") body.pop(), trailing++;

    const title = rawTitle ?? type.charAt(0).toUpperCase() + type.slice(1);
    const inner = convertAdmonitions(body.join("\n"));
    const cls = `admonition ${escapeHtml(type.toLowerCase())}`;
    if (marker === "!!!") {
      out.push(`<div class="${cls}">`);
      if (rawTitle !== "") out.push(`<p class="admonition-title">${escapeHtml(title)}</p>`);
    } else {
      out.push(`<details class="${cls}"${marker === "???+" ? " open" : ""}>`);
      out.push(`<summary>${escapeHtml(title)}</summary>`);
    }
    out.push("", inner, "", marker === "!!!" ? "</div>" : "</details>");
    for (let t = 0; t < trailing; t++) out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Unified plugins
// ---------------------------------------------------------------------------

// Pull the first H1 out of the document and use it as the page title.
function remarkExtractTitle() {
  return (tree, file) => {
    const idx = tree.children.findIndex((n) => n.type === "heading" && n.depth === 1);
    if (idx === -1) return;
    const text = (n) => (n.value ?? "") + (n.children ?? []).map(text).join("");
    file.data.title = text(tree.children[idx]).trim();
    tree.children.splice(idx, 1);
  };
}

// Rewrite relative links/images so they work at the post's URL:
//   ./other.md#x  -> /blog/<dir>/other/#x
//   ./image.png   -> /blog/<dir>/image.png  (and copy the file)
function rehypeRelativeUrls({ sourceFile, assets }) {
  const isRelative = (u) => u && !/^([a-z]+:|\/|#)/i.test(u);
  return (tree) => {
    visit(tree, "element", (node) => {
      const attr = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (!attr || !isRelative(node.properties[attr])) return;
      const [p, hash = ""] = String(node.properties[attr]).split("#");
      const abs = path.resolve(path.dirname(sourceFile), decodeURI(p));
      const rel = path.relative(POSTS, abs).split(path.sep).join("/");
      if (rel.startsWith("..")) return;
      if (rel.endsWith(".md")) {
        node.properties[attr] = `/blog/${rel.slice(0, -3)}/` + (hash ? `#${hash}` : "");
      } else {
        assets.add(rel);
        node.properties[attr] = `/blog/${rel}` + (hash ? `#${hash}` : "");
        if (node.tagName === "img") node.properties.loading = "lazy";
      }
    });
  };
}

// ```mermaid blocks are rendered client-side.
function rehypeMermaid() {
  return (tree, file) => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "pre") return;
      const code = node.children[0];
      const cls = code?.properties?.className ?? [];
      if (code?.tagName !== "code" || !cls.includes("language-mermaid")) return;
      parent.children[index] = {
        type: "element",
        tagName: "pre",
        properties: { className: ["mermaid"] },
        children: [{ type: "text", value: hastToString(code) }],
      };
      file.data.mermaid = true;
      return SKIP;
    });
  };
}

const shikiOptions = {
  themes: { light: "github-light", dark: "github-dark" },
  defaultColor: false,
  defaultLanguage: "text",
  fallbackLanguage: "text",
  langs: [
    "asm", "c", "cpp", "scala", "rust", "python", "bash", "shell", "console",
    "haskell", "java", "javascript", "typescript", "json", "toml", "yaml",
    "make", "cmake", "diff", "llvm", "go", "ocaml", "zig", "html", "css",
  ],
  transformers: [
    {
      pre(node) {
        if (this.options.lang && this.options.lang !== "text") node.properties["data-lang"] = this.options.lang;
      },
    },
  ],
};

async function renderMarkdown(src, sourceFile, assets) {
  const md = convertAdmonitions(stripFrontMatter(src));
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkExtractTitle)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeRelativeUrls, { sourceFile, assets })
    .use(rehypeMermaid)
    .use(rehypeKatex, { strict: false })
    .use(rehypeShiki, shikiOptions)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: "append",
      properties: { className: ["anchor"], ariaHidden: "true", tabIndex: -1 },
      content: { type: "text", value: "#" },
      test: (node) => node.tagName !== "h1",
    })
    .use(rehypeStringify)
    .process(md);
  return { html: String(file), title: file.data.title, mermaid: !!file.data.mermaid, words: md.split(/\s+/).length };
}

// ---------------------------------------------------------------------------
// Post discovery
// ---------------------------------------------------------------------------

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function gitDate(file) {
  try {
    const out = execFileSync("git", ["log", "--follow", "--format=%aI", "--", file], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? out.split("\n").pop() : null;
  } catch {
    return null;
  }
}

async function loadPosts(config) {
  const posts = [];
  for (const file of walk(POSTS).filter((f) => f.endsWith(".md"))) {
    const key = path.relative(POSTS, file).split(path.sep).join("/").slice(0, -3);
    const meta = config.posts[key] ?? {};
    if (meta.draft && !DEV) continue;
    const assets = new Set();
    const r = await renderMarkdown(fs.readFileSync(file, "utf8"), file, assets);
    const date = new Date(meta.date ?? gitDate(file) ?? fs.statSync(file).mtime);
    posts.push({
      key,
      url: `/blog/${key}/`,
      tag: key.includes("/") ? key.split("/")[0] : null,
      title: meta.title ?? r.title ?? path.basename(key),
      description: meta.description ?? "",
      draft: !!meta.draft,
      date,
      minutes: Math.max(1, Math.round(r.words / 220)),
      html: r.html,
      mermaid: r.mermaid,
      assets,
    });
  }
  return posts.sort((a, b) => b.date - a.date);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const fmtDate = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const isoDate = (d) => d.toISOString().slice(0, 10);

function layout(config, { title, description, body, mermaid = false, katex = true }) {
  const pageTitle = title ? `${escapeHtml(title)} | ${escapeHtml(config.title)}` : escapeHtml(config.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${escapeHtml(description || config.description)}">
<meta name="author" content="${escapeHtml(config.author)}">
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.title)}" href="/feed.xml">
<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,600;1,400&display=swap">
${katex ? '<link rel="stylesheet" href="/assets/katex/katex.min.css">\n' : ""}<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="site-title" href="/">${escapeHtml(config.title)}</a>
    <nav>
      <a href="/">Posts</a>
      <a href="${config.github}">GitHub</a>
      <a href="/feed.xml">RSS</a>
      <button class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg></button>
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">&copy; ${new Date().getFullYear()} ${escapeHtml(config.author)}</div>
</footer>
<script src="/assets/main.js" defer></script>
${mermaid ? `<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true,theme:matchMedia("(prefers-color-scheme: dark)").matches||document.documentElement.dataset.theme==="dark"?"dark":"default"});</script>\n` : ""}</body>
</html>
`;
}

function postPage(config, post) {
  const body = `<article class="post">
  <header class="post-header">
    <h1 class="post-title">${escapeHtml(post.title)}</h1>
    <p class="post-meta">
      <time datetime="${isoDate(post.date)}">${fmtDate(post.date)}</time>
      ${post.tag ? `<span>·</span> <span>${escapeHtml(post.tag)}</span>` : ""}
      <span>·</span> <span>${post.minutes} min read</span>
      ${post.draft ? '<span class="draft">draft</span>' : ""}
    </p>
  </header>
  <div class="post-content">
${post.html}
  </div>
</article>`;
  return layout(config, { title: post.title, description: post.description, body, mermaid: post.mermaid });
}

function indexPage(config, posts) {
  const byYear = new Map();
  for (const p of posts) {
    const y = p.date.getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  const sections = [...byYear]
    .map(
      ([year, ps]) => `<h2 class="year">${year}</h2>
<ul class="post-list">
${ps
  .map(
    (p) => `  <li>
    <time datetime="${isoDate(p.date)}">${p.date.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" })}</time>
    <div>
      <a class="post-link" href="${p.url}">${escapeHtml(p.title)}</a>${p.draft ? ' <span class="draft">draft</span>' : ""}
      ${p.description ? `<p class="post-desc">${escapeHtml(p.description)}</p>` : ""}
    </div>
  </li>`,
  )
  .join("\n")}
</ul>`,
    )
    .join("\n");
  const body = `<section class="intro">
  <p>${escapeHtml(config.description)}</p>
</section>
${sections}`;
  return layout(config, { body, katex: false });
}

function feed(config, posts) {
  const items = posts
    .map(
      (p) => `  <item>
    <title>${escapeHtml(p.title)}</title>
    <link>${config.url}${p.url}</link>
    <guid>${config.url}${p.url}</guid>
    <pubDate>${p.date.toUTCString()}</pubDate>
    <description>${escapeHtml(p.description)}</description>
  </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escapeHtml(config.title)}</title>
  <link>${config.url}/</link>
  <description>${escapeHtml(config.description)}</description>
${items}
</channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function write(rel, content) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function build() {
  const t0 = Date.now();
  const config = (await import(pathToFileURL(path.join(ROOT, "site.config.mjs")).href + `?t=${t0}`)).default;
  const posts = await loadPosts(config);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  fs.cpSync(ASSETS, path.join(OUT, "assets"), { recursive: true });
  const katexDist = path.join(ROOT, "node_modules/katex/dist");
  fs.mkdirSync(path.join(OUT, "assets/katex"), { recursive: true });
  fs.copyFileSync(path.join(katexDist, "katex.min.css"), path.join(OUT, "assets/katex/katex.min.css"));
  fs.cpSync(path.join(katexDist, "fonts"), path.join(OUT, "assets/katex/fonts"), { recursive: true });

  for (const post of posts) {
    write(`blog/${post.key}/index.html`, postPage(config, post));
    for (const a of post.assets) {
      const src = path.join(POSTS, a);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, "blog", a));
      else console.warn(`warning: ${post.key} references missing file ${a}`);
    }
  }
  write("index.html", indexPage(config, posts));
  write("feed.xml", feed(config, posts.filter((p) => !p.draft)));
  write(
    "404.html",
    layout(config, { title: "Not found", body: '<h1>Not found</h1><p>That page does not exist. <a href="/">Back to posts</a>.</p>', katex: false }),
  );
  write(".nojekyll", "");
  console.log(`built ${posts.length} posts in ${Date.now() - t0}ms${DEV ? " (with drafts)" : ""}`);
}

await build();

if (args.has("--serve")) {
  const port = Number(process.env.PORT) || 4000;
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".xml": "application/xml", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
  http
    .createServer((req, res) => {
      let p = path.join(OUT, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!p.startsWith(OUT)) return res.writeHead(403).end();
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
      if (!fs.existsSync(p)) {
        res.writeHead(404, { "content-type": "text/html" });
        return res.end(fs.readFileSync(path.join(OUT, "404.html")));
      }
      res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    })
    .listen(port, () => console.log(`serving http://localhost:${port}`));

  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e)), 100);
  };
  fs.watch(POSTS, { recursive: true }, rebuild);
  fs.watch(ASSETS, { recursive: true }, rebuild);
  fs.watch(path.join(ROOT, "site.config.mjs"), rebuild);
}
