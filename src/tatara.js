// Tatara finder tab: lists public Tataras in low/null-sec systems next to high-sec, filtered by reaction cost index.
// Needs the ESI scope esi-universe.read_structures.v1 (structure names/types are not public). Self-contained:
// data/tatara-systems.json is [systemId, name, sec, region, adjacent highsec name, its sec, [jumps to Jita, Amarr, Dodixie, Rens, Hek]].
import * as esi from "./esi.js";

const KEY = "evecp.tatara.v1";
const K_STRUCT = "evecp.tatara.structs"; // { structureId: [systemId, name, ownerId] | 1 (other type) | 0 (no access) }
const K_RESULTS = "evecp.tatara.results";
const TATARA = 35836, SCOPE = "esi-universe.read_structures.v1";
const HUBS = ["Jita", "Amarr", "Dodixie", "Rens", "Hek"];
const DEFAULTS = { maxIdx: 4, hub: -1, sort: "idx" };

const secColor = (s) => (s >= 0.5 ? "#2fefef" : s >= 0.3 ? "#df6000" : s > 0 ? "#d73000" : "#f00000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

export async function initTatara(root, bridge) {
  let a = { ...DEFAULTS, ...lsGet(KEY, {}) };
  root.innerHTML = "<p class='muted'>Loading system data...</p>";
  const sys = await fetch("data/tatara-systems.json").then((r) => r.json());
  const sysById = new Map(sys.map((x) => [x[0], x]));
  let busy = false;

  root.innerHTML = `
    <div class="intro">Public Tataras in low/null-sec systems next to high-sec, filtered by reaction cost index. Structure details are
      not public, so this needs the <code>${SCOPE}</code> scope: log in from the Character panel (if you logged in before this tab
      existed, log out and in again). Your application at developers.eveonline.com must have that scope enabled.</div>
    <div class="bar">
      <span id="t-who" class="muted"></span>
      <label>Max reaction index % <input type="number" id="t-max" step="0.1" min="0" value="${a.maxIdx}"></label>
      <label>Trade hub <select id="t-hub"><option value="-1">Nearest</option>${HUBS.map((h, i) => `<option value="${i}">${h}</option>`).join("")}</select></label>
      <label>Sort <select id="t-sort"><option value="idx">Reaction index</option><option value="hub">Hub jumps</option><option value="name">System</option></select></label>
      <button class="primary" id="t-scan">Scan</button><button id="t-copy">Copy list</button><button id="t-clear">Clear cache</button>
    </div>
    <div class="tprog"><i id="t-prog"></i></div>
    <p class="muted" id="t-status"></p>
    <div id="t-out"></div>
    <p class="muted notes">ESI does not expose rigs: to confirm a T2 reaction rig, check the structure's bonuses in the in-game Industry window.
      Jumps are the shortest gate route and ignore Thera and Ansiblex. The first scan checks every public structure and can take a few
      minutes; results are cached so later scans only look at new structures.</p>`;
  const $ = (id) => root.querySelector("#" + id);
  $("t-hub").value = a.hub; $("t-sort").value = a.sort;
  const status = (t, err) => { $("t-status").innerHTML = err ? `<span style="color:var(--bad,#ff6b6b)">${esc(t)}</span>` : esc(t); };
  const prog = (f) => { $("t-prog").style.width = Math.max(0, Math.min(1, f)) * 100 + "%"; };
  const save = () => lsSet(KEY, a);

  function showWho() {
    const c = esi.character();
    $("t-who").textContent = !esi.loggedIn() ? "Not logged in" : esi.hasScope(SCOPE) ? `Logged in as ${c.name}` : `Logged in as ${c.name}, but without structure access: log out and in again`;
  }

  // ---------- ESI ----------
  let BASE = "https://esi.evetech.net/latest", QS = "";
  async function get(path, opt = {}) {
    for (let n = 0; n < 5; n++) {
      const h = { Accept: "application/json" };
      if (opt.auth) h.Authorization = "Bearer " + opt.auth;
      if (opt.body) h["Content-Type"] = "application/json";
      const url = BASE + path + (QS ? (path.includes("?") ? "&" : "?") + QS : "");
      let r;
      try { r = await fetch(url, { method: opt.body ? "POST" : "GET", headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
      catch { await sleep(1500 * (n + 1)); continue; }
      const remain = r.headers.get("x-esi-error-limit-remain"), reset = +r.headers.get("x-esi-error-limit-reset");
      if (remain != null && +remain < 20) { status(`Pausing ${reset}s for the ESI error limit...`); await sleep((reset + 1) * 1000); }
      if (r.status === 429) { const w = +r.headers.get("retry-after") || 10; status(`Rate limited, waiting ${w}s...`); await sleep(w * 1000); continue; }
      if (r.status >= 500 && r.status !== 503) { await sleep(1500 * (n + 1)); continue; }
      return r;
    }
    throw new Error("ESI not responding for " + path);
  }
  const slash = () => (BASE.endsWith("latest") ? "/" : "");
  async function loadIndices() {
    let r = await get("/industry/systems/").catch(() => null);
    if (!r || !r.ok) { BASE = "https://esi.evetech.net"; QS = "compatibility_date=2025-12-16"; r = await get("/industry/systems"); }
    if (!r.ok) throw new Error(`Could not load cost indices (${r.status})`);
    const idx = {};
    for (const s of await r.json()) {
      const c = (s.cost_indices || []).find((x) => x.activity === "reaction");
      if (c) idx[s.solar_system_id] = c.cost_index;
    }
    return idx;
  }

  async function scan() {
    if (busy) return;
    if (!esi.loggedIn()) { status("Log in first (Character panel): structure details need your token", true); return; }
    if (!esi.hasScope(SCOPE)) { status("Your login lacks structure access. Log out and log in again (and make sure the scope is enabled on your EVE application).", true); return; }
    busy = true; $("t-scan").disabled = true; prog(0);
    try {
      status("Loading reaction cost indices...");
      const idx = await loadIndices();
      status("Loading public structure list...");
      const lr = await get("/universe/structures" + slash());
      if (!lr.ok) throw new Error(`Structure list failed (${lr.status})`);
      const ids = await lr.json();
      const cache = lsGet(K_STRUCT, {});
      const todo = ids.filter((id) => !(id in cache));
      let done = 0, stop = false, auth = await esi.accessToken();
      status(`${ids.length} public structures, ${todo.length} not cached yet...`);
      const worker = async () => {
        while (todo.length && !stop) {
          const id = todo.pop();
          if (done % 200 === 0) auth = (await esi.accessToken().catch(() => null)) || auth;
          const r = await get(`/universe/structures/${id}${slash()}`, { auth }).catch(() => null);
          if (r && r.ok) { const j = await r.json(); cache[id] = j.type_id === TATARA ? [j.solar_system_id, j.name, j.owner_id] : 1; }
          else if (r && (r.status === 403 || r.status === 404)) cache[id] = 0;
          else if (r && r.status === 401) { stop = true; status("Token rejected, log in again", true); }
          done++;
          if (done % 25 === 0) { prog(done / Math.max(1, done + todo.length)); status(`Checking structures... ${done} done, ${todo.length} left`); lsSet(K_STRUCT, cache); }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      lsSet(K_STRUCT, cache);
      if (stop) return;
      const hits = [];
      for (const id of ids) { const c = cache[id]; if (Array.isArray(c) && sysById.has(c[0])) hits.push({ id, sys: c[0], name: c[1], owner: c[2], idx: idx[c[0]] }); }
      const owners = [...new Set(hits.map((h) => h.owner))], names = {};
      for (let i = 0; i < owners.length; i += 900) {
        const r = await get("/universe/names" + slash(), { body: owners.slice(i, i + 900) }).catch(() => null);
        if (r && r.ok) for (const n of await r.json()) names[n.id] = n.name;
      }
      hits.forEach((h) => { h.ownerName = names[h.owner] || ""; });
      lsSet(K_RESULTS, { at: Date.now(), hits });
      prog(1); render();
    } catch (e) { status(e.message, true); }
    finally { busy = false; $("t-scan").disabled = false; }
  }

  // ---------- results ----------
  function rows() {
    const res = lsGet(K_RESULTS, null);
    if (!res) return null;
    const max = parseFloat(a.maxIdx) / 100, hub = +a.hub;
    const out = res.hits.filter((h) => h.idx == null || h.idx < max).map((h) => {
      const s = sysById.get(h.sys), d = s[6];
      let hi = hub;
      if (hub < 0) { hi = 0; d.forEach((v, i) => { if (v >= 0 && (d[hi] < 0 || v < d[hi])) hi = i; }); }
      return { ...h, s, hubName: HUBS[hi], jumps: d[hi] };
    });
    out.sort((x, y) => (a.sort === "hub" ? x.jumps - y.jumps : a.sort === "name" ? x.s[1].localeCompare(y.s[1]) : (x.idx ?? 0) - (y.idx ?? 0)));
    return { at: res.at, total: res.hits.length, out };
  }
  const pct = (h) => (h.idx == null ? "n/a" : (h.idx * 100).toFixed(2) + "%");
  function render() {
    showWho();
    const r = rows();
    if (!r) { $("t-out").innerHTML = ""; return; }
    status(`${r.out.length} match${r.out.length === 1 ? "" : "es"} (of ${r.total} public Tataras next to high-sec), scanned ${new Date(r.at).toLocaleString()}`);
    $("t-out").innerHTML = r.out.map((h) => `<div class="tcard"><b>${esc(h.name)}</b>
      <div class="tmeta"><span><b style="color:${secColor(h.s[2])}">${h.s[2].toFixed(1)}</b> ${esc(h.s[1])}</span><span>${esc(h.s[3])}</span>
        <span>next to ${esc(h.s[4])} (<b style="color:${secColor(h.s[5])}">${h.s[5].toFixed(1)}</b>)</span>
        <span>Reaction index <b>${pct(h)}</b></span><span><b>${h.jumps < 0 ? "-" : h.jumps + "j"}</b> to ${h.hubName}</span>
        ${h.ownerName ? `<span>Owner: ${esc(h.ownerName)}</span>` : ""}</div></div>`).join("") || `<div class="intro">No Tataras match. Try raising the max index.</div>`;
  }

  $("t-max").addEventListener("change", (e) => { a.maxIdx = e.target.value; save(); render(); });
  $("t-hub").addEventListener("change", (e) => { a.hub = e.target.value; save(); render(); });
  $("t-sort").addEventListener("change", (e) => { a.sort = e.target.value; save(); render(); });
  $("t-scan").addEventListener("click", scan);
  $("t-clear").addEventListener("click", () => { lsDel(K_STRUCT); lsDel(K_RESULTS); $("t-out").innerHTML = ""; prog(0); status("Cache cleared"); });
  $("t-copy").addEventListener("click", () => {
    const r = rows();
    if (!r || !r.out.length) { status("Nothing to copy yet"); return; }
    const txt = r.out.map((h) => [h.name, h.s[1], h.s[2].toFixed(1), h.s[3], pct(h), `${h.jumps}j ${h.hubName}`, h.ownerName].join("\t")).join("\n");
    navigator.clipboard.writeText(txt).then(() => status(`Copied ${r.out.length} rows`)).catch(() => status("Copy failed", true));
  });
  // The login can change in the Character panel while this tab exists.
  document.addEventListener("evecp:change", showWho);
  render();
}
