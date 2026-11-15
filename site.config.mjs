// Site-wide settings and per-post metadata.
//
// Post files in posts/ are never modified by the build. Anything that is not
// in the markdown itself (publish date, a one-line summary, draft status)
// lives here, keyed by the post's path relative to posts/ without ".md".
//
//   title       -> `title` below, else the post's first "# H1", else the file name
//   date        -> `date` below, else the first git commit of the file,
//                  else the file's mtime (untracked files)
//   description -> `description` below (optional)
//   draft       -> drafts are built by `npm run dev` but not by `npm run build`

export default {
  title: "Emir Hurturk",
  description: "Emir Hurturk's blog on systems, compilers and software engineering.",
  author: "Emir Hurturk",
  url: "https://ehurturk.github.io",
  github: "https://github.com/ehurturk",

  posts: {
    "compilers/wacc-compiler": {
      title: "Writing a Compiler for WACC in Scala 3",
      date: "2026-03-19",
      description:
        "Notes on building a WACC compiler frontend in Scala 3 for Imperial's second-year group project: parsing, renaming, typechecking.",
    },
    "systems/nvme-driver": {
      date: "2026-07-12",
      description:
        "Tracing the Linux kernel's NVMe PCI driver from module init through nvme_probe(), PCI BAR mapping, and admin queue setup.",
    },
    "systems/lea": {
      date: "2026-10-20",
      description:
        "Starting with integer addition, then why compilers prefer lea, and then going through different microprocessors on how they execute lea.",
    },
  },
};
