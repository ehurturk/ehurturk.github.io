# ehurturk.github.io

Personal blog. Posts are plain Markdown in `posts/<category>/<slug>.md` and are published at `/blog/<category>/<slug>/`.

```sh
npm install
npm run dev     # http://localhost:4000, includes drafts, rebuilds on save
npm run build   # production build into dist/ (drafts excluded)
```

- Title: the post's first `# H1` (or `title` in `site.config.mjs`)
- Date, description, draft flag: `site.config.mjs`
- Supported: `$…$` / `$$…$$` math (KaTeX), fenced code (Shiki), `!!!` / `???` / `???+` admonitions,
  footnotes, tables, task lists, mermaid code blocks, relative images and `.md` links.

Pushing to `main` deploys via `.github/workflows/docs.yml`.
