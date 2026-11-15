// Theme toggle: cycles between light and dark, remembered per browser.
document.querySelector(".theme-toggle")?.addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

// Copy button on code blocks.
for (const pre of document.querySelectorAll(".post-content pre:not(.mermaid)")) {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.type = "button";
  btn.textContent = "copy";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
      btn.textContent = "copied";
    } catch {
      btn.textContent = "failed";
    }
    setTimeout(() => (btn.textContent = "copy"), 1500);
  });
  pre.appendChild(btn);
}
