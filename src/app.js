import {
  STRUCTURES, buildMods, evaluate, jobSeconds, windowHours, salesTax, brokerFee, secClass,
  fmtIsk, fmtShort, fmtTime,
} from "./calc.js";
import { HUBS, fetchPrices, fetchAdjusted, fetchCostIndices, fetchVolumes } from "./api.js";

const $ = (sel, root = document) => root.querySelector(sel);
const SETTINGS_KEY = "evecp.settings.v1";
const MARKET_KEY = "evecp.market.v1";

const DEFAULTS = {
  skills: { industry: 5, advancedIndustry: 5, accounting: 5, brokerRelations: 5 },
  standings: { faction: 0, corp: 0 },
  baseSalesTax: 7.5, salesTaxOverride: "", brokerFeeOverride: "",
  system: "Jita", sciOverride: "",
  structure: "raitaru", rigs: ["", "", ""], facilityTax: 1, sccSurcharge: 4,
  runs: 100, slots: 10, windowDays: 7, windowHours: 0, lazy: false, defaultME: 10, defaultTE: 20, volumeCap: 10,
  inHub: "s:60003760", outHub: "s:60003760",
  inputMethod: "instant", outputMethod: "order", priceStat: "percentile",
  shipIn: { perM3: 0, collateral: 0 }, shipOut: { perM3: 0, collateral: 0 },
  bp: {}, overrides: { in: {}, out: {} },
};

const view = { group: "All", onlyProfit: false, search: "", sort: "weeklyPerSlot", asc: false, open: new Set() };
let data, rigs, systems, s;
let lastCtx;
let planBuyText = "";
let market = { adj: {}, indices: {}, prices: {}, volumes: {}, ts: 0 };

// ---------- state helpers ----------
const merge = (base, over) => {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === "object") {
    const o = {};
    for (const k of Object.keys(base)) o[k] = merge(base[k], over?.[k]);
    if (over) for (const k of Object.keys(over)) if (!(k in o)) o[k] = over[k];
    return o;
  }
  return over === undefined ? base : over;
};
const load = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const save = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => {
  const ks = p.split(".");
  const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- settings panel ----------
const num = (path, label, hint, attrs = "") => ({ path, label, hint, type: "number", attrs });
const sel = (path, label, opts, hint) => ({ path, label, hint, type: "select", opts });

function sections() {
  const hubOpts = HUBS.map((h) => [h.id, h.label]);
  const rigOpts = [["", "(none)"], ...rigs.map((r) => [r.id, r.name.replace("Standup ", "")])];
  return [
    { title: "Skills", open: true, fields: [
      num("skills.industry", "Industry (-4% time/lvl)", "", 'min="0" max="5"'),
      num("skills.advancedIndustry", "Advanced Industry (-3% time/lvl)", "", 'min="0" max="5"'),
      num("skills.accounting", "Accounting (sales tax)", "", 'min="0" max="5"'),
      num("skills.brokerRelations", "Broker Relations", "", 'min="0" max="5"'),
      num("standings.faction", "Faction standing (broker fee)", "Effective standing, 0-10", 'min="0" max="10" step="0.1"'),
      num("standings.corp", "Corp standing (broker fee)", "Effective standing, 0-10", 'min="0" max="10" step="0.1"'),
    ] },
    { title: "Manufacturing location", open: true, fields: [
      { path: "system", label: "System", type: "system" },
      num("sciOverride", "Cost index override (%)", "Blank = live ESI value", 'step="0.01" placeholder="auto"'),
      sel("structure", "Structure", Object.entries(STRUCTURES).map(([k, v]) => [k, v.label])),
      { type: "rigs", opts: rigOpts },
      num("facilityTax", "Facility tax (%)", "Charged on EIV by the structure owner", 'step="0.1" min="0"'),
      num("sccSurcharge", "SCC surcharge (%)", "On EIV; 4% at time of writing", 'step="0.1" min="0"'),
    ] },
    { title: "Blueprints & plan", open: true, fields: [
      num("defaultME", "Default blueprint ME", "Per-blueprint overrides are in the table", 'min="0" max="10"'),
      num("defaultTE", "Default blueprint TE", "Even values 0-20", 'min="0" max="20" step="2"'),
      num("runs", "Runs per job", "Affects rounding of material quantities", 'min="1"'),
      num("slots", "Manufacturing slots", "Used for the weekly plan", 'min="1"'),
      num("windowDays", "Plan window: days", "Use less than 7d/0h so jobs finish before you can restart them", 'min="0" max="7"'),
      num("windowHours", "Plan window: extra hours", "", 'min="0" max="23"'),
      { path: "lazy", label: "Lazy mode", type: "checkbox", hint: "Whole slots only; each slot runs one job sized to fill the window, so you set it and forget it" },
      num("volumeCap", "Max share of weekly market volume (%)", "Caps units the plan will sell per product", 'min="0" step="1"'),
    ] },
    { title: "Market", open: true, fields: [
      sel("inHub", "Buy inputs at", hubOpts),
      sel("outHub", "Sell products at", hubOpts),
      sel("inputMethod", "Input method", [["instant", "Buy from sell orders (instant)"], ["order", "Place buy orders"]]),
      sel("outputMethod", "Output method", [["order", "Place sell orders"], ["instant", "Sell to buy orders (instant)"]]),
      sel("priceStat", "Price statistic", [["percentile", "Percentile (outlier-resistant)"], ["best", "Best price"], ["median", "Median"], ["weightedAverage", "Weighted average"]]),
    ] },
    { title: "Taxes & fees", fields: [
      num("baseSalesTax", "Base sales tax (%)", "Reduced 11% per Accounting level", 'step="0.1"'),
      num("salesTaxOverride", "Sales tax override (%)", "Blank = from skills", 'step="0.01" placeholder="auto"'),
      num("brokerFeeOverride", "Broker fee override (%)", "Blank = from skills/standings (structures set their own)", 'step="0.01" placeholder="auto"'),
      { type: "feeinfo" },
    ] },
    { title: "Shipping", fields: [
      num("shipIn.perM3", "Inputs: ISK per m3", "", 'min="0"'),
      num("shipIn.collateral", "Inputs: collateral (% of value)", "", 'min="0" step="0.1"'),
      num("shipOut.perM3", "Outputs: ISK per m3", "", 'min="0"'),
      num("shipOut.collateral", "Outputs: collateral (% of value)", "", 'min="0" step="0.1"'),
    ] },
    { title: "Materials (price overrides)", fields: [{ type: "materials" }] },
  ];
}

function fieldHtml(f) {
  if (f.type === "system") {
    return `<label class="full">System<input list="systemlist" data-path="system" value="${esc(s.system)}">
      <span class="hint" id="sysinfo"></span></label>`;
  }
  if (f.type === "rigs") {
    return [0, 1, 2].map((i) => `<label class="full">Rig ${i + 1}<select data-path="rigs.${i}" data-int>${
      f.opts.map(([v, l]) => `<option value="${v}" ${String(s.rigs[i]) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")
    }</select></label>`).join("") + `<div class="hint">Rig bonuses are scaled by system security (x1.0 high, x1.9 low, x2.1 null/WH). Ignored at NPC stations.</div>`;
  }
  if (f.type === "feeinfo") return `<div class="full hint" id="feeinfo"></div>`;
  if (f.type === "materials") return `<div class="mats" id="mats"></div>`;
  const v = getPath(s, f.path);
  if (f.type === "checkbox") {
    return `<label>${esc(f.label)}</label><input type="checkbox" data-path="${f.path}" ${v ? "checked" : ""}>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}`;
  }
  const input = f.type === "select"
    ? `<select data-path="${f.path}">${f.opts.map(([o, l]) => `<option value="${o}" ${o === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
    : `<input type="number" data-path="${f.path}" value="${v}" ${f.attrs || ""}>`;
  return `<label>${esc(f.label)}</label>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}`;
}

function renderSettings() {
  const wasOpen = new Set([...document.querySelectorAll("#settings details[open]")].map((d) => d.dataset.t));
  $("#settings").innerHTML = sections().map((sec) =>
    `<details data-t="${sec.title}" ${(wasOpen.size ? wasOpen.has(sec.title) : sec.open) ? "open" : ""}><summary>${sec.title}</summary><div>${sec.fields.map(fieldHtml).join("")}</div></details>`
  ).join("") + `<datalist id="systemlist">${systems.map((x) => `<option value="${esc(x[1])}">`).join("")}</datalist>`;
  renderSideInfo();
}

function renderSideInfo() {
  const sys = currentSystem();
  const el = $("#sysinfo");
  if (el) {
    if (!sys) el.textContent = "Unknown system";
    else {
      const idx = sciFor(sys);
      el.textContent = `${secClass(sys[2])}sec ${sys[2].toFixed(1)} - manufacturing cost index ${(idx * 100).toFixed(2)}%`;
    }
  }
  const fi = $("#feeinfo");
  if (fi) fi.textContent = `Effective sales tax ${(salesTax(s) * 100).toFixed(2)}%, broker fee ${(brokerFee(s) * 100).toFixed(2)}%`;
  renderMats();
}

function allMaterials() {
  const m = new Map();
  for (const c of data.components) for (const x of c.materials) m.set(x.id, x.name);
  return [...m].sort((a, b) => a[1].localeCompare(b[1]));
}

function renderMats() {
  const el = $("#mats");
  if (!el) return;
  el.innerHTML = `<table><tr><th>Item</th><th>Market</th><th>Override</th></tr>${allMaterials().map(([id, name]) => {
    const mp = marketPrice(id, "in");
    const ov = s.overrides.in[id] ?? "";
    return `<tr><td title="${esc(name)}">${esc(name)}</td><td>${fmtIsk(mp, 2)}</td><td><input class="ovr" data-side="in" data-id="${id}" type="number" min="0" step="any" value="${ov}"></td></tr>`;
  }).join("")}</table>`;
}

// ---------- market lookups ----------
const currentSystem = () => systems.find((x) => x[1].toLowerCase() === String(s.system).trim().toLowerCase());
const sciFor = (sys) => (s.sciOverride !== "" && s.sciOverride != null ? s.sciOverride / 100 : market.indices[sys?.[0]] ?? 0);

// side "in": we are the buyer. instant -> sell orders, order -> buy orders. "out": we are the seller.
function marketPrice(id, side) {
  const method = side === "in" ? s.inputMethod : s.outputMethod;
  const book = market.prices[side === "in" ? "in" : "out"]?.[id];
  if (!book) return 0;
  const useSell = side === "in" ? method === "instant" : method === "order";
  const o = useSell ? book.sell : book.buy;
  if (!o) return 0;
  const stat = s.priceStat === "best" ? (useSell ? "min" : "max") : s.priceStat;
  return o[stat] || 0;
}
const inPrice = (id) => (s.overrides.in[id] > 0 ? Number(s.overrides.in[id]) : marketPrice(id, "in"));
const outPrice = (id) => (s.overrides.out[id] > 0 ? Number(s.overrides.out[id]) : marketPrice(id, "out"));

// ---------- results ----------
function computeRows() {
  const sys = currentSystem();
  const mods = buildMods(s, rigs, sys ? sys[2] : 1);
  const ctx = lastCtx = { s, mods, sci: sciFor(sys), adj: market.adj, inPrice, outPrice };
  return data.components.map((c) => {
    const o = s.bp[c.blueprint] || {};
    const bp = { me: o.me ?? s.defaultME, te: o.te ?? s.defaultTE, custom: !!(o.me != null || o.te != null) };
    const r = evaluate(c, bp, ctx);
    const vol = market.volumes[c.id];
    r.weeklyVol = vol == null ? null : (vol * windowHours(s)) / 24;
    r.maxSlots = r.weeklyVol == null ? Infinity : (r.weeklyVol * (s.volumeCap / 100)) / r.unitsPerWeekPerSlot;
    r.share = r.weeklyVol ? r.unitsPerWeekPerSlot / r.weeklyVol : null;
    r.hasPrices = r.outPrice > 0 && r.lines.every((l) => l.price > 0);
    return r;
  });
}

const COLS = [
  ["name", "Product", (r) => r.comp.name],
  ["group", "Group", (r) => r.comp.group],
  ["me", "ME / TE", null],
  ["outPrice", "Sell price", (r) => fmtIsk(r.outPrice, 2)],
  ["costPerUnit", "Cost / unit", (r) => fmtIsk(r.costPerUnit, 2)],
  ["profit", "Profit / job", (r) => fmtShort(r.profit)],
  ["margin", "Margin", (r) => (r.margin * 100).toFixed(1) + "%"],
  ["roi", "ROI", (r) => (r.roi * 100).toFixed(1) + "%"],
  ["seconds", "Job time", (r) => fmtTime(r.seconds)],
  ["perHour", "ISK / hour / slot", (r) => fmtShort(r.perHour)],
  ["weeklyPerSlot", "Profit / window / slot", (r) => fmtShort(r.weeklyPerSlot)],
  ["share", "Mkt share / slot", (r) => (r.share == null ? "?" : (r.share * 100).toFixed(1) + "%")],
];

function renderResults() {
  const rows = computeRows();
  renderPlan(rows);
  const q = view.search.toLowerCase();
  let list = rows.filter((r) =>
    (view.group === "All" || r.comp.group === view.group) &&
    (!view.onlyProfit || r.profit > 0) &&
    (!q || r.comp.name.toLowerCase().includes(q)));
  const key = view.sort;
  const val = (r) => (key === "name" || key === "group" ? r.comp[key] : key === "me" ? r.bp.me : r[key] ?? -Infinity);
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return view.asc ? c : -c;
  });
  $("#count").textContent = `${list.length} of ${rows.length} products`;

  const head = COLS.map(([k, label]) => `<th data-sort="${k}" class="${view.sort === k ? "sorted" + (view.asc ? " asc" : "") : ""}">${label}</th>`).join("");
  const body = list.map((r) => {
    const cls = r.profit > 0 ? "good" : "bad";
    const cells = COLS.map(([k, , f]) => {
      if (k === "me") return `<td><input data-bp="${r.comp.blueprint}" data-f="me" type="number" min="0" max="10" value="${r.bp.me}"> <input data-bp="${r.comp.blueprint}" data-f="te" type="number" min="0" max="20" step="2" value="${r.bp.te}"></td>`;
      if (k === "outPrice") return `<td><input class="price ovr" data-side="out" data-id="${r.comp.id}" type="number" min="0" step="any" value="${s.overrides.out[r.comp.id] ?? ""}" placeholder="${fmtIsk(marketPrice(r.comp.id, "out"), 2)}"></td>`;
      const c = ["profit", "margin", "roi", "perHour", "weeklyPerSlot"].includes(k) ? ` class="${cls}"` : "";
      return `<td${c}>${f(r)}</td>`;
    }).join("");
    const open = view.open.has(r.comp.id);
    return `<tr class="row" data-id="${r.comp.id}">${cells}</tr>${open ? `<tr class="detail"><td colspan="${COLS.length}">${detailHtml(r)}</td></tr>` : ""}`;
  }).join("");
  $("#table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

function detailHtml(r) {
  const row = (l, v, cls = "") => `<tr><td>${l}</td><td class="${cls}">${v}</td></tr>`;
  const skillNames = data.skills;
  const mats = r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${fmtIsk(l.need)}</td><td>${fmtIsk(l.price, 2)}</td><td>${fmtIsk(l.cost)}</td></tr>`).join("");
  return `<div class="cols">
    <div><table><tr><th>Material (${r.runs} runs)</th><th>Qty</th><th>Price</th><th>Cost</th></tr>${mats}</table>
      <p class="muted">Needs: ${r.comp.skills.map((k) => `${skillNames[k.id]} ${k.level}`).join(", ")}</p></div>
    <div><table>
      ${row("Units produced", fmtIsk(r.units))}
      ${row("Gross revenue", fmtIsk(r.gross))}
      ${row("Sales tax + broker", "-" + fmtIsk(r.fees))}
      ${row("Materials", "-" + fmtIsk(r.matCost))}
      ${row("Shipping in", "-" + fmtIsk(r.shipIn))}
      ${row("Shipping out", "-" + fmtIsk(r.shipOut))}
      ${row(`System cost (EIV ${fmtShort(r.eiv)} x ${(r.sci * 100).toFixed(2)}%)`, "-" + fmtIsk(r.sysCost))}
      ${row("Facility tax", "-" + fmtIsk(r.facility))}
      ${row("SCC surcharge", "-" + fmtIsk(r.scc))}
      ${row("<b>Profit per job</b>", "<b>" + fmtIsk(r.profit) + "</b>", r.profit > 0 ? "good" : "bad")}
      ${row("Per window, all slots on this", fmtIsk(r.weeklyTotal))}
      ${row("Units / window / slot", fmtIsk(r.unitsPerWeekPerSlot))}
      ${row("Market volume / window", r.weeklyVol == null ? "unknown" : fmtIsk(r.weeklyVol))}
    </table></div></div>`;
}

// Lazy mode: one job per slot, with the run count chosen so it just fits inside the window.
function lazyCandidate(r) {
  const winSec = windowHours(s) * 3600;
  const { mods } = lastCtx;
  let runs = Math.floor(winSec / (r.seconds / r.runs));
  while (runs > 1 && jobSeconds(r.comp, r.bp.te, runs, mods) > winSec) runs--;
  if (runs < 1 || jobSeconds(r.comp, r.bp.te, runs, mods) > winSec) return null;
  const lr = evaluate(r.comp, r.bp, { ...lastCtx, s: { ...s, runs } });
  if (!(lr.profit > 0) || !r.hasPrices) return null;
  const cap = r.weeklyVol == null ? Infinity : Math.floor((r.weeklyVol * (s.volumeCap / 100)) / lr.units);
  return { r, lr, per: lr.profit, maxSlots: cap, units: lr.units };
}

function renderPlan(rows) {
  const lazy = s.lazy;
  const win = windowHours(s);
  const cands = (lazy
    ? rows.map(lazyCandidate).filter(Boolean)
    : rows.filter((r) => r.profit > 0 && r.hasPrices).map((r) => ({ r, per: r.weeklyPerSlot, maxSlots: r.maxSlots, units: r.unitsPerWeekPerSlot }))
  ).sort((a, b) => b.per - a.per);
  let left = s.slots, total = 0;
  const alloc = [];
  for (const c of cands) {
    if (left <= 0) break;
    const n = Math.min(left, lazy ? Math.floor(c.maxSlots) : c.maxSlots);
    if (!(n > 0)) continue;
    alloc.push({ ...c, n, profit: n * c.per });
    left -= n; total += n * c.per;
  }
  // Aggregate inputs for the whole plan, in the "Item name<TAB>quantity" form the in-game multibuy accepts.
  const buy = new Map();
  for (const a of alloc) {
    const jobs = lazy ? a.n : (a.n * a.units) / a.r.units; // non-lazy: jobs of s.runs runs, fractional total
    const lines = lazy ? a.lr.lines : a.r.lines;
    for (const l of lines) buy.set(l.name, (buy.get(l.name) || 0) + l.need * jobs);
  }
  planBuyText = [...buy].sort((x, y) => x[0].localeCompare(y[0]))
    .map(([name, q]) => `${name}\t${Math.ceil(q)}`).join("\n");
  const missing = rows.filter((r) => !r.hasPrices).length;
  const pending = !market.ts ? "<p class='warn'>No market data yet - press Refresh.</p>" : "";
  const winLabel = `${Math.floor(win / 24)}d ${win % 24}h`;
  const head = lazy
    ? "<tr><th>Product</th><th>Slots</th><th>Runs / job</th><th>Job length</th><th>Units / slot</th><th>Profit / slot</th><th>Total profit</th></tr>"
    : "<tr><th>Product</th><th>Slots</th><th>Units</th><th>Profit</th></tr>";
  const body = alloc.map((a) => lazy
    ? `<tr><td>${esc(a.r.comp.name)}</td><td>${a.n}</td><td>${a.lr.runs}</td><td>${fmtTime(a.lr.seconds)}</td><td>${fmtIsk(a.units)}</td><td>${fmtIsk(a.per)}</td><td class="good">${fmtIsk(a.profit)}</td></tr>`
    : `<tr><td>${esc(a.r.comp.name)}</td><td>${a.n.toFixed(1)}</td><td>${fmtIsk(a.n * a.units)}</td><td class="good">${fmtIsk(a.profit)}</td></tr>`).join("");
  $("#plan").innerHTML = `<h3>Suggested plan - ${s.slots} slots, ${winLabel} window${lazy ? ", lazy mode" : ""}</h3>${pending}
    <div><b class="${total > 0 ? "good" : ""}">${fmtIsk(total)} ISK</b>
    <span class="muted"> expected profit per window${left > 0.01 ? `; ${lazy ? left : left.toFixed(1)} slots idle (nothing profitable within the market-share cap)` : ""}${missing ? `; ${missing} products lack prices` : ""}</span></div>
    ${alloc.length ? `<table>${head}${body}</table><p><button id="copybuy">Create buy order (copy multibuy)</button> <span class="muted" id="copymsg">${buy.size} items for the whole plan</span></p>` : ""}`;
}

// ---------- market refresh ----------
async function refresh() {
  const btn = $("#refresh");
  btn.disabled = true;
  const status = (t) => ($("#status").textContent = t);
  try {
    status("Loading prices...");
    const matIds = allMaterials().map((m) => m[0]);
    const prodIds = data.components.map((c) => c.id);
    const [adj, indices] = await Promise.all([fetchAdjusted(), fetchCostIndices()]);
    market.adj = adj; market.indices = indices;
    if (s.inHub === s.outHub) {
      const p = await fetchPrices(s.inHub, [...matIds, ...prodIds]);
      market.prices = { in: p, out: p };
    } else {
      const [pi, po] = await Promise.all([fetchPrices(s.inHub, matIds), fetchPrices(s.outHub, prodIds)]);
      market.prices = { in: pi, out: po };
    }
    market.ts = Date.now();
    save(MARKET_KEY, { ...market, hubs: [s.inHub, s.outHub] });
    renderSideInfo(); renderResults();
    status("Loading trade volumes...");
    market.volumes = await fetchVolumes(s.outHub, prodIds, (d, n) => status(`Loading trade volumes ${d}/${n}`));
    save(MARKET_KEY, { ...market, hubs: [s.inHub, s.outHub] });
    status(`Updated ${new Date(market.ts).toLocaleTimeString()}`);
  } catch (e) {
    status("Error: " + e.message);
  } finally {
    btn.disabled = false;
    renderResults();
  }
}

// ---------- events ----------
function onSettingChange(e) {
  const t = e.target;
  if (t.dataset.path) {
    let v = t.value;
    if (t.type === "checkbox") v = t.checked;
    else if (t.type === "number") v = v === "" ? "" : Number(v);
    else if (t.hasAttribute("data-int")) v = v === "" ? "" : Number(v);
    setPath(s, t.dataset.path, v);
    save(SETTINGS_KEY, s);
    if (t.dataset.path === "inHub" || t.dataset.path === "outHub") refresh();
    if (["inputMethod", "outputMethod", "priceStat", "inHub", "outHub"].includes(t.dataset.path)) renderMats();
    renderSideInfo(); renderResults();
  } else if (t.classList.contains("ovr")) {
    const v = t.value === "" ? undefined : Number(t.value);
    const m = s.overrides[t.dataset.side];
    if (v === undefined) delete m[t.dataset.id]; else m[t.dataset.id] = v;
    save(SETTINGS_KEY, s);
    renderResults();
  } else if (t.dataset.bp) {
    const o = (s.bp[t.dataset.bp] ||= {});
    o[t.dataset.f] = Number(t.value);
    save(SETTINGS_KEY, s);
    renderResults();
  } else if (t.dataset.view) {
    view[t.dataset.view] = t.type === "checkbox" ? t.checked : t.value;
    renderResults();
  }
}

function init() {
  s = merge(DEFAULTS, load(SETTINGS_KEY));
  const cached = load(MARKET_KEY);
  if (cached && cached.hubs?.[0] === s.inHub && cached.hubs?.[1] === s.outHub) market = { ...market, ...cached };
  $("#settings").addEventListener("change", onSettingChange);
  $("#toolbar").addEventListener("input", onSettingChange);
  $("#table").addEventListener("change", onSettingChange);
  $("#table").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      view.asc = view.sort === k ? !view.asc : k === "name" || k === "group";
      view.sort = k;
      return renderResults();
    }
    if (e.target.closest("input")) return;
    const tr = e.target.closest("tr.row");
    if (tr) {
      const id = Number(tr.dataset.id);
      view.open.has(id) ? view.open.delete(id) : view.open.add(id);
      renderResults();
    }
  });
  $("#plan").addEventListener("click", async (e) => {
    if (e.target.id !== "copybuy") return;
    const msg = $("#copymsg");
    try {
      await navigator.clipboard.writeText(planBuyText);
      msg.textContent = "Copied - paste into the in-game Multibuy window";
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: planBuyText });
      document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
      msg.textContent = "Copied - paste into the in-game Multibuy window";
    }
  });
  $("#refresh").addEventListener("click", refresh);
  $("#reset").addEventListener("click", () => {
    if (!confirm("Reset all settings and price overrides?")) return;
    s = merge(DEFAULTS, null); save(SETTINGS_KEY, s);
    renderSettings(); renderResults();
  });
  const groups = ["All", ...new Set(data.components.map((c) => c.group))];
  $("[data-view=group]").innerHTML = groups.map((g) => `<option>${g}</option>`).join("");
  renderSettings();
  renderResults();
  if (market.ts) $("#status").textContent = `Cached from ${new Date(market.ts).toLocaleString()}`;
  if (!market.ts || Date.now() - market.ts > 3600e3) refresh();
}

(async () => {
  const j = (f) => fetch(`data/${f}`).then((r) => r.json());
  [data, rigs, systems] = await Promise.all([j("components.json"), j("rigs.json"), j("systems.json")]);
  rigs = rigs.filter((r) => !r.name.includes("Outpost"));
  init();
})();
