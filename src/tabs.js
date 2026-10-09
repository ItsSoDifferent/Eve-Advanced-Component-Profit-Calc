// Tab switcher. The "All manufacturing" module is only loaded the first time its tab is opened.
const tabs = document.querySelectorAll("#tabs button");
const loaded = new Set();

tabs.forEach((b) => b.addEventListener("click", async () => {
  tabs.forEach((x) => x.classList.toggle("active", x === b));
  for (const x of tabs) document.getElementById(x.dataset.tab).hidden = x.dataset.tab !== b.dataset.tab;
  const kind = b.dataset.kind;
  if (kind && !loaded.has(kind)) {
    loaded.add(kind);
    const m = await import("./all.js");
    m.initAll(document.getElementById(b.dataset.tab), window.evecp, kind);
  }
  document.dispatchEvent(new Event("evecp:change"));
}));
