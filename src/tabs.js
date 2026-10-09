// Tab switcher. The "All manufacturing" module is only loaded the first time its tab is opened.
const tabs = document.querySelectorAll("#tabs button");
let allLoaded = false;

tabs.forEach((b) => b.addEventListener("click", async () => {
  tabs.forEach((x) => x.classList.toggle("active", x === b));
  for (const id of ["results", "allview"]) document.getElementById(id).hidden = id !== b.dataset.tab;
  if (b.dataset.tab === "allview" && !allLoaded) {
    allLoaded = true;
    const m = await import("./all.js");
    m.initAll(document.getElementById("allview"), window.evecp);
  }
  document.dispatchEvent(new Event("evecp:change"));
}));
