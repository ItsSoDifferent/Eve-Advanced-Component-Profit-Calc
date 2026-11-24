// Tab switcher. The "All manufacturing" module is only loaded the first time its tab is opened.
const tabs = document.querySelectorAll("#tabs button");
const loaded = new Set();

tabs.forEach((b) => b.addEventListener("click", async () => {
  tabs.forEach((x) => x.classList.toggle("active", x === b));
  for (const x of tabs) document.getElementById(x.dataset.tab).hidden = x.dataset.tab !== b.dataset.tab;
  const kind = b.dataset.kind;
  if (kind && !loaded.has(kind)) {
    loaded.add(kind);
    const root = document.getElementById(b.dataset.tab);
    try {
      if (kind === "chain") await (await import("./chain.js")).initChain(root, window.evecp);
      else if (kind === "reprocess") await (await import("./reprocess.js")).initReprocess(root, window.evecp);
      else if (kind === "tatara") await (await import("./tatara.js")).initTatara(root, window.evecp);
      else await (await import("./all.js")).initAll(root, window.evecp, kind);
    } catch (err) {
      loaded.delete(kind);
      root.innerHTML = `<p style="color:var(--bad)">Could not load this tab: ${String(err.message || err).replace(/[<&]/g, "")}. Try a hard refresh (Ctrl+Shift+R).</p>`;
    }
  }
  document.dispatchEvent(new Event("evecp:change"));
}));
