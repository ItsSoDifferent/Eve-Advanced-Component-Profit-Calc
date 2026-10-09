import {
  STRUCTURES, buildMods, evaluate, jobSeconds, windowHours, inputMap, inputRoom, tightestInputs, salesTax, brokerFee, secClass,
  fmtIsk, fmtShort, fmtTime,
} from "./calc.js";
import { HUBS, fetchPrices, fetchAdjusted, fetchCostIndices, fetchVolumes } from "./api.js";

const $ = (sel, root = document) => root.querySelector(sel);
const SETTINGS_KEY = "evecp.settings.v1";
const MARKET_KEY = "evecp.market.v3";

const DEFAULTS = {
  skills: { industry: 5, advancedIndustry: 5, reactions: 5, accounting: 5, brokerRelations: 5 },
  standings: { faction: 0, corp: 0 },
  baseSalesTax: 7.5, salesTaxOverride: "", brokerFeeOverride: "",
  system: "Jita", sciOverride: "",
  reactSystem: "Tama", reactSciOverride: "", reactStructure: "tatara", reactRigs: ["", "", ""], reactFacilityTax: 1,
  structure: "raitaru", rigs: ["", "", ""], facilityTax: 1, sccSurcharge: 4,
  runs: 100, slots: 10, reactSlots: 10, windowDays: 7, windowHours: 0, lazy: false, capital: "", defaultME: 10, defaultTE: 20, volumeCap: 10, inputCap: 25,
  inHub: "s:60003760", outHub: "s:60003760",
  inputMethod: "instant", outputMethod: "order", priceStat: "percentile",
  shipIn: { perM3: 0, collateral: 0 }, shipOut: { perM3: 0, collateral: 0 },
  bp: {}, overrides: { in: {}, out: {} },
};

const view = { group: "All", onlyProfit: false, search: "", sort: "weeklyPerSlot", asc: false, open: new Set() };
let data, rigs, reactRigList, systems, s;
let lastCtx;
let planBuyText = "";
let market = { adj: {}, indices: {}, reactionIndices: {}, prices: {}, volumes: {}, ts: 0 };

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
  const reactRigOpts = [["", "(none)"], ...reactRigList.map((r) => [r.id, r.name.replace("Standup ", "")])];
  return [
    { title: "Skills", open: true, fields: [
      num("skills.industry", "Industry (-4% time/lvl)", "", 'min="0" max="5"'),
      num("skills.advancedIndustry", "Advanced Industry (-3% time/lvl)", "", 'min="0" max="5"'),
      num("skills.reactions", "Reactions (-4% reaction time/lvl)", "", 'min="0" max="5"'),
      num("skills.accounting", "Accounting (sales tax)", "", 'min="0" max="5"'),
      num("skills.brokerRelations", "Broker Relations", "", 'min="0" max="5"'),
      num("standings.faction", "Faction standing (broker fee)", "Effective standing, 0-10", 'min="0" max="10" step="0.1"'),
      num("standings.corp", "Corp standing (broker fee)", "Effective standing, 0-10", 'min="0" max="10" step="0.1"'),
    ] },
    { title: "Manufacturing location", open: true, fields: [
      { path: "system", label: "System", type: "system", info: "sysinfo" },
      num("sciOverride", "Cost index override (%)", "Blank = live ESI value", 'step="0.01" placeholder="auto"'),
      sel("structure", "Structure", Object.entries(STRUCTURES).map(([k, v]) => [k, v.label])),
      { type: "rigs", path: "rigs", label: "Rig", opts: rigOpts, hint: "Rig bonuses are scaled by system security (x1.0 high, x1.9 low, x2.1 null/WH). Ignored at NPC stations." },
      num("facilityTax", "Facility tax (%)", "Charged on EIV by the structure owner", 'step="0.1" min="0"'),
      { type: "subhead", label: "Reactions (used by the Reactions tab)" },
      { path: "reactSystem", label: "Reaction system", type: "system", info: "rsysinfo" },
      num("reactSciOverride", "Reaction cost index override (%)", "Blank = live ESI value", 'step="0.01" placeholder="auto"'),
      sel("reactStructure", "Reaction structure", [["athanor", "Athanor (no bonus)"], ["tatara", "Tatara (-25% time)"]]),
      { type: "rigs", path: "reactRigs", label: "Reactor rig", opts: reactRigOpts, hint: "M-set rigs fit an Athanor, L-set a Tatara; a rig only helps reactions of its own type (composite / hybrid / biochemical; L-set covers all). Low-sec x1.0, null-sec x1.1, wormhole x1.0; reactions cannot run in high-sec." },
      num("reactFacilityTax", "Reaction facility tax (%)", "Charged on EIV by the structure owner", 'step="0.1" min="0"'),
      num("sccSurcharge", "SCC surcharge (%)", "On EIV; 4% at time of writing", 'step="0.1" min="0"'),
    ] },
    { title: "Blueprints & plan", open: true, fields: [
      num("defaultME", "Default blueprint ME", "Per-blueprint overrides are in the table", 'min="0" max="10"'),
      num("defaultTE", "Default blueprint TE", "Even values 0-20", 'min="0" max="20" step="2"'),
      num("runs", "Runs per job", "Affects rounding of material quantities", 'min="1"'),
      num("slots", "Manufacturing slots", "Used for the weekly plan", 'min="1"'),
      num("reactSlots", "Reaction slots", "Used for the Reactions tab plan (Mass Reactions skills)", 'min="1"'),
      num("windowDays", "Plan window: days", "Use less than 7d/0h so jobs finish before you can restart them", 'min="0" max="7"'),
      num("windowHours", "Plan window: extra hours", "", 'min="0" max="23"'),
      { path: "lazy", label: "Lazy mode", type: "checkbox", hint: "Whole slots only; each slot runs one job sized to fill the window, so you set it and forget it" },
      num("capital", "Starting capital (ISK)", "Blank = unlimited. Caps materials + inbound shipping + job fees paid up front", 'min="0" step="any" placeholder="unlimited"'),
      num("inputCap", "Max share of input supply (%)", "Caps materials the plan will buy, as a share of the units on sell orders at the buy hub", 'min="0" step="1"'),
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
  if (f.type === "subhead") return `<h3 class="full" style="margin-top:8px">${esc(f.label)}</h3>`;
  if (f.type === "system") {
    return `<label class="full">${esc(f.label)}<input list="systemlist" data-path="${f.path}" value="${esc(getPath(s, f.path))}">
      <span class="hint" id="${f.info || "sysinfo"}"></span></label>`;
  }
  if (f.type === "rigs") {
    return [0, 1, 2].map((i) => `<label class="full">${esc(f.label)} ${i + 1}<select data-path="${f.path}.${i}" data-int>${
      f.opts.map(([v, l]) => `<option value="${v}" ${String(getPath(s, f.path)[i]) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")
    }</select></label>`).join("") + `<div class="hint">${esc(f.hint)}</div>`;
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
  const rsys = systems.find((x) => x[1].toLowerCase() === String(s.reactSystem).trim().toLowerCase());
  const rel = $("#rsysinfo");
  if (rel) {
    if (!rsys) rel.textContent = "Unknown system";
    else {
      const idx = s.reactSciOverride !== "" && s.reactSciOverride != null ? s.reactSciOverride / 100 : market.reactionIndices[rsys[0]] ?? 0;
      rel.textContent = `${secClass(rsys[2])}sec ${rsys[2].toFixed(1)} - reaction cost index ${(idx * 100).toFixed(2)}%${rsys[2] >= 0.45 ? " - reactions cannot run in high-sec" : ""}`;
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

// Read-only window onto shared state for the "All manufacturing" tab (src/all.js).
window.evecp = {
  get s() { return s; },
  get market() { return market; },
  get fmt() { return { fmtIsk, fmtShort, fmtTime }; },
  system: (kind = "manufacturing") => {
    if (kind === "reaction") {
      const sys = systems.find((x) => x[1].toLowerCase() === String(s.reactSystem).trim().toLowerCase());
      const sci = s.reactSciOverride !== "" && s.reactSciOverride != null ? s.reactSciOverride / 100 : market.reactionIndices[sys?.[0]] ?? 0;
      return { sec: sys ? sys[2] : 1, sci, wh: !!sys && /^J\d{6}$/.test(sys[1]) };
    }
    const sys = currentSystem();
    return { sec: sys ? sys[2] : 1, sci: sciFor(sys) };
  },
  refreshShared: async () => { if (!market.ts) await refresh(); },
};

function renderResults() {
  document.dispatchEvent(new Event("evecp:change"));
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

// Lazy mode: one job per slot. A job never needs to fill the whole window, so offer several job sizes (largest first):
// shorter jobs let the planner fit tight capital or market-share limits instead of dropping a product altogether.
const LAZY_SIZES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.12, 0.06];
function lazyCandidates(r) {
  if (!r.hasPrices) return [];
  const winSec = windowHours(s) * 3600;
  const { mods } = lastCtx;
  const perRun = r.comp.perRun;
  let fit = Math.floor(winSec / (r.seconds / r.runs));
  while (fit > 1 && jobSeconds(r.comp, r.bp.te, fit, mods) > winSec) fit--;
  if (fit < 1 || jobSeconds(r.comp, r.bp.te, fit, mods) > winSec) return [];
  const capUnits = r.weeklyVol == null ? Infinity : r.weeklyVol * (s.volumeCap / 100);
  const sizes = new Set(LAZY_SIZES.map((f) => Math.max(1, Math.floor(fit * f))));
  const capRuns = Math.floor(capUnits / perRun);
  if (capRuns >= 1 && capRuns < fit) sizes.add(capRuns);
  const out = [];
  for (const runs of sizes) {
    if (runs * perRun > capUnits) continue;
    const lr = evaluate(r.comp, r.bp, { ...lastCtx, s: { ...s, runs } });
    if (lr.profit > 0) out.push({ r, lr, per: lr.profit, units: lr.units, capUnits, t: slotTotals(lr, 1) });
  }
  return out;
}

const SUM_KEYS = ["gross", "mat", "shipIn", "shipOut", "install", "fees", "profit"];

// Per-slot totals for one window, so allocation and the breakdown can just multiply by slot count.
function slotTotals(src, f) {
  return {
    gross: src.gross * f, mat: src.matCost * f, shipIn: src.shipIn * f, shipOut: src.shipOut * f,
    install: src.installCost * f, fees: src.fees * f, profit: src.profit * f,
  };
}

// Units of an input the plan may buy: a share of what is listed on sell orders at the buy hub.
const inputSupply = (id) => (market.prices.in?.[id]?.sell?.volume || 0) * (s.inputCap / 100);

function allocate(cands, lazy, capital) {
  let left = s.slots, capLeft = capital;
  const used = new Map(); // product id -> units already planned, shared by all job sizes of that product
  const usedIn = new Map(); // material id -> units the plan already buys
  const alloc = [];
  for (const c of cands) {
    if (left <= 0) break;
    const room = c.capUnits - (used.get(c.r.comp.id) || 0);
    let n = Math.min(left, room / c.units, c.up > 0 ? capLeft / c.up : Infinity, inputRoom(c, usedIn, inputSupply));
    if (lazy) n = Math.floor(n + 1e-9);
    if (!(n > 0) || n * c.units < c.r.comp.perRun) continue; // less than one run of output: nothing to sell
    alloc.push({ ...c, n, profit: n * c.per });
    used.set(c.r.comp.id, (used.get(c.r.comp.id) || 0) + n * c.units);
    for (const [id, q] of c.inputs) usedIn.set(id, (usedIn.get(id) || 0) + n * q);
    left -= n; capLeft -= n * c.up;
  }
  const total = alloc.reduce((a, x) => a + x.profit, 0);
  return { alloc, total, left, usedIn };
}

function renderPlan(rows) {
  const lazy = s.lazy;
  const win = windowHours(s);
  const capital = s.capital > 0 ? Number(s.capital) : Infinity;
  const cands = (lazy
    ? rows.flatMap(lazyCandidates)
    : rows.filter((r) => r.profit > 0 && r.hasPrices).map((r) => {
      const f = r.unitsPerWeekPerSlot / r.units; // jobs per slot per window
      return { r, per: r.weeklyPerSlot, units: r.unitsPerWeekPerSlot, capUnits: r.weeklyVol == null ? Infinity : r.weeklyVol * (s.volumeCap / 100), t: slotTotals(r, f) };
    })
  ).map((c) => ({
    ...c, up: c.t.mat + c.t.shipIn + c.t.install,
    inputs: inputMap(c.lr ? c.lr.lines : c.r.lines, c.lr ? 1 : c.units / c.r.units), // per slot, per window
  }));

  // Without a capital limit, profit per slot is the right ranking. With one, weigh in profit per ISK of capital too
  // (a greedy heuristic, so try several blends and keep the best result).
  let best = allocate([...cands].sort((a, b) => b.per - a.per), lazy, capital);
  if (capital < Infinity) {
    for (const w of [0.25, 0.5, 0.75, 1]) {
      const score = (c) => c.per ** (1 - w) * (c.per / c.up) ** w;
      const alt = allocate([...cands].sort((a, b) => score(b) - score(a)), lazy, capital);
      if (alt.total > best.total) best = alt;
    }
  }
  const { alloc, total, left, usedIn } = best;
  const tight = tightestInputs(usedIn, inputSupply, (id) => allMaterials().find((m) => m[0] === id)?.[1] ?? id);

  const sum = Object.fromEntries(SUM_KEYS.map((k) => [k, alloc.reduce((a, x) => a + x.n * x.t[k], 0)]));
  const upfront = sum.mat + sum.shipIn + sum.install;
  const totalCost = upfront + sum.shipOut + sum.fees;

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
  const row = (l, v, cls = "") => `<tr><td>${l}</td><td class="${cls}">${v}</td></tr>`;
  const pct = (x) => (totalCost ? ` <span class="muted">(${((x / sum.gross) * 100).toFixed(1)}%)</span>` : "");
  const breakdown = `<table class="summary">
      ${row("Revenue", fmtIsk(sum.gross))}
      ${row("Materials", "-" + fmtIsk(sum.mat) + pct(sum.mat))}
      ${row("Shipping in", "-" + fmtIsk(sum.shipIn) + pct(sum.shipIn))}
      ${row("Job installation (system, facility, SCC)", "-" + fmtIsk(sum.install) + pct(sum.install))}
      ${row("Sales tax + broker fees", "-" + fmtIsk(sum.fees) + pct(sum.fees))}
      ${row("Shipping out", "-" + fmtIsk(sum.shipOut) + pct(sum.shipOut))}
      ${row("<b>Total cost</b>", "<b>-" + fmtIsk(totalCost) + "</b>")}
      ${row("<b>Profit</b>", "<b>" + fmtIsk(total) + "</b>", total > 0 ? "good" : "")}
      ${row("Margin (profit / revenue)", sum.gross ? ((total / sum.gross) * 100).toFixed(1) + "%" : "-")}
      ${row("ROI (profit / total cost)", totalCost ? ((total / totalCost) * 100).toFixed(1) + "%" : "-")}
      ${row("<b>Capital needed up front</b>", "<b>" + fmtIsk(upfront) + "</b>" + (capital < Infinity ? ` <span class="muted">of ${fmtShort(capital)} available</span>` : ""))}
    </table>`;
  $("#plan").innerHTML = `<h3>Suggested plan - ${s.slots} slots, ${winLabel} window${lazy ? ", lazy mode" : ""}${capital < Infinity ? `, ${fmtShort(capital)} capital` : ""}</h3>${pending}
    <div><b class="${total > 0 ? "good" : ""}">${fmtIsk(total)} ISK</b>
    <span class="muted"> expected profit per window${left > 0.01 ? `; ${lazy ? left : left.toFixed(1)} slots unused (slot, market-share, input-supply or capital limit)` : ""}${missing ? `; ${missing} products lack prices` : ""}</span></div>
    ${tight.length ? `<div class="muted">Tightest inputs (share of the allowed supply on the market): ${tight.map((x) => `${esc(x.name)} ${Number.isFinite(x.pct) ? (x.pct * 100).toFixed(0) + "%" : "no supply"}`).join(", ")}</div>` : ""}
    ${alloc.length ? `<div class="plancols"><table>${head}${body}</table>${breakdown}</div><p><button id="copybuy">Create buy order (copy multibuy)</button> <span class="muted" id="copymsg">${buy.size} items for the whole plan</span></p>` : ""}`;
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
    market.adj = adj; market.indices = indices.manufacturing; market.reactionIndices = indices.reaction;
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
  market.indices ||= {}; market.reactionIndices ||= {};
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
  let reactions;
  [data, rigs, systems, reactions] = await Promise.all([j("components.json"), j("rigs.json"), j("systems.json"), j("reactions.json")]);
  reactRigList = Object.entries(reactions.rigs).map(([id, [name, mat, time]]) => ({ id: Number(id), name, mat, time }))
    .filter((r) => !r.name.includes("Thukker")).sort((x, y) => x.name.localeCompare(y.name));
  rigs = rigs.filter((r) => !r.name.includes("Outpost"));
  init();
})();
