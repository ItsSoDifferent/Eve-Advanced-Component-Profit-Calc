// Reaction chain tab: build advanced components from inputs you either buy or make yourself through reactions.
// Self-contained: reads shared settings through window.evecp and owns its own prices, volumes and filters.
// Data: data/components.json, data/rigs.json and data/reactions.json.
import {
  brokerFee, buildMods, evaluate, inputRoom, jobMaterials, jobSeconds, tightestInputs, windowHours,
} from "./calc.js";
import { fetchPrices, fetchVolumes } from "./api.js";

const KEY = "evecp.chain.v1";
const DEFAULTS = { reactRuns: 100, mode: "best", group: "All", search: "", onlyProfit: true, sort: "maxProfit", asc: false };
const REACT_STRUCT = { athanor: { time: 1, size: "M-Set" }, tatara: { time: 0.75, size: "L-Set" } };
const SIZES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.12, 0.06];
const KEYS = ["gross", "mat", "shipOut", "install", "fees", "profit"];

export async function initChain(root, bridge) {
  const { fmtIsk, fmtShort, fmtTime } = bridge.fmt;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let a = { ...DEFAULTS };
  try { a = { ...a, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* ignore */ } };

  root.innerHTML = "<p class='muted'>Loading data...</p>";
  const j = (f) => fetch(`data/${f}`).then((r) => r.json());
  const [comps, mfgRigs, react] = await Promise.all([j("components.json"), j("rigs.json"), j("reactions.json")]);
  const components = comps.components;
  const open = new Set();
  let prices = { in: {}, out: {}, ts: 0 };
  let volumes = {};
  let busy = "";
  let planBuyText = "";

  // Names/volumes for everything we may buy, and reaction formulas by the product they make.
  const names = {};
  const vols = {};
  for (const c of components) {
    for (const m of c.materials) { names[m.id] = m.name; vols[m.id] = m.volume; }
    names[c.id] = c.name; vols[c.id] = c.volume;
  }
  for (const [id, [n, v]] of Object.entries(react.mats)) { names[id] = n; vols[id] = v; }
  const formulas = new Map();
  for (const it of react.items) {
    names[it.id] = it.name; vols[it.id] = it.volume;
    formulas.set(it.id, {
      ...it,
      comp: {
        id: it.id, name: it.name, perRun: it.perRun, time: it.time, volume: it.volume,
        materials: it.mats.map(([id, qty]) => ({ id, qty, name: react.mats[id][0], volume: react.mats[id][1] })),
      },
    });
  }
  const groups = ["All", ...new Set(components.map((c) => c.group))];

  // ---------- prices ----------
  const marketPrice = (s, side, id) => {
    const b = prices[side][id];
    if (!b) return 0;
    const method = side === "in" ? s.inputMethod : s.outputMethod;
    const useSell = side === "in" ? method === "instant" : method === "order";
    const o = useSell ? b.sell : b.buy;
    const stat = s.priceStat === "best" ? (useSell ? "min" : "max") : s.priceStat;
    return o?.[stat] || 0;
  };
  // Effective per-unit cost of buying an input, including broker fee, collateral and shipping.
  const buyCost = (s, id) => {
    const ov = s.overrides?.in?.[id];
    const p = ov > 0 ? Number(ov) : marketPrice(s, "in", id);
    if (!(p > 0)) return null;
    const broker = s.inputMethod === "order" ? brokerFee(s) : 0;
    return p * (1 + broker) * (1 + s.shipIn.collateral / 100) + (vols[id] || 0) * s.shipIn.perM3;
  };
  const outPrice = (s, id) => {
    const ov = s.overrides?.out?.[id];
    return ov > 0 ? Number(ov) : marketPrice(s, "out", id);
  };

  // ---------- reactions ----------
  function reactionSetup(s) {
    const { sec, sci, wh } = bridge.system("reaction");
    const sm = wh || sec > 0 ? 1 : 1.1; // reactor rigs: x1.0 low-sec/wormhole, x1.1 null-sec
    const st = REACT_STRUCT[s.reactStructure];
    const size = `Standup ${st.size} `;
    const mods = (F) => {
      const ok = new Set(react.rigSets[F.rigSet]);
      const rg = (s.reactRigs || []).filter((id) => id && ok.has(id) && react.rigs[id] && react.rigs[id][0].startsWith(size));
      return {
        structMat: 1, structCost: 1, structTime: st.time, skillTime: 1 - 0.04 * (s.skills.reactions || 0),
        rigMat: rg.reduce((f, id) => f * (1 + (react.rigs[id][1] / 100) * sm), 1),
        rigTime: rg.reduce((f, id) => f * (1 + (react.rigs[id][2] / 100) * sm), 1),
      };
    };
    return { sci, mods, tax: s.reactFacilityTax };
  }

  // Returns unit(id) -> { cost, raw: Map(rawId -> qty per unit), made: Map(reactionProductId -> units per unit),
  // rsec: reaction slot-seconds per unit, make } for the given make-or-buy mode (none | best | all).
  function sourcing(s, mode) {
    const R = reactionSetup(s);
    const adj = bridge.market.adj;
    const memo = new Map();
    const busy = new Set();
    const buy = (id) => {
      const c = buyCost(s, id);
      return c == null ? null : { cost: c, raw: new Map([[id, 1]]), made: new Map(), rsec: 0, make: false };
    };
    const make = (id) => {
      const F = formulas.get(id);
      if (!F || busy.has(id)) return null;
      busy.add(id);
      const runs = a.reactRuns;
      const mods = R.mods(F);
      const units = F.perRun * runs;
      let cost = 0;
      let rsec = 0;
      const raw = new Map();
      const made = new Map();
      let ok = true;
      for (const m of jobMaterials(F.comp, 0, runs, mods)) {
        const u = unit(m.id);
        if (!u) { ok = false; break; }
        cost += m.need * u.cost;
        rsec += m.need * u.rsec;
        for (const [k, q] of u.raw) raw.set(k, (raw.get(k) || 0) + m.need * q);
        for (const [k, q] of u.made) made.set(k, (made.get(k) || 0) + m.need * q);
        if (u.make) made.set(m.id, (made.get(m.id) || 0) + m.need);
      }
      busy.delete(id);
      if (!ok) return null;
      const eiv = F.comp.materials.reduce((x, m) => x + m.qty * runs * (adj[m.id] || 0), 0);
      cost += eiv * (R.sci + R.tax / 100 + s.sccSurcharge / 100);
      rsec += jobSeconds(F.comp, 0, runs, mods);
      for (const m of [raw, made]) for (const [k, q] of m) m.set(k, q / units);
      return { cost: cost / units, raw, made, rsec: rsec / units, make: true };
    };
    const unit = (id) => {
      if (memo.has(id)) return memo.get(id);
      const b = buy(id);
      let res = b;
      if (mode !== "none") {
        const m = make(id);
        if (m && (!b || mode === "all" || m.cost < b.cost)) res = m;
      }
      memo.set(id, res);
      return res;
    };
    return unit;
  }

  // Slot-seconds of reactor time one unit of this product takes by itself (no sub-reactions), for the plan's job list.
  function ownSeconds(s, id) {
    const F = formulas.get(id);
    const R = reactionSetup(s);
    return jobSeconds(F.comp, 0, a.reactRuns, R.mods(F)) / (F.perRun * a.reactRuns);
  }

  // ---------- evaluation ----------
  function evalComp(s, c, mode, runs, unitFn, extra) {
    const { sec, sci } = bridge.system();
    const mods = buildMods(s, mfgRigs, sec);
    const o = s.bp[c.blueprint] || {};
    const bp = { me: o.me ?? s.defaultME, te: o.te ?? s.defaultTE };
    // Input costs already include broker/shipping/collateral, so stop evaluate() from adding them again.
    const sx = { ...s, runs, inputMethod: "instant", shipIn: { perM3: 0, collateral: 0 } };
    const ctx = { s: sx, mods, sci, adj: bridge.market.adj, inPrice: (id) => unitFn(id)?.cost ?? 0, outPrice: (id) => outPrice(s, id) };
    const r = evaluate(c, bp, ctx);
    const raw = new Map();
    const made = new Map();
    let rsec = 0;
    for (const l of r.lines) {
      const u = unitFn(l.id);
      if (!u) continue;
      rsec += l.need * u.rsec;
      for (const [k, q] of u.raw) raw.set(k, (raw.get(k) || 0) + l.need * q);
      for (const [k, q] of u.made) made.set(k, (made.get(k) || 0) + l.need * q);
      if (u.make) made.set(l.id, (made.get(l.id) || 0) + l.need);
    }
    return { ...r, c, mode, raw, made, rsec, ctx, bp, hasPrices: r.outPrice > 0 && r.lines.every((l) => l.price > 0), madeIds: r.lines.filter((l) => unitFn(l.id)?.make).map((l) => l.name), ...extra };
  }

  function compute() {
    const s = bridge.s;
    const mkU = { chain: sourcing(s, a.mode), buy: sourcing(s, "none") };
    const win = windowHours(s);
    return components.map((c) => {
      const chain = evalComp(s, c, a.mode, s.runs, mkU.chain);
      const buy = evalComp(s, c, "none", s.runs, mkU.buy);
      const r = { ...chain, c, buy, mkU };
      r.saving = buy.costPerUnit ? 1 - chain.costPerUnit / buy.costPerUnit : 0;
      r.profitWin = r.perHour * win;
      r.reactSlots = (r.rsec / r.seconds) * 1; // reaction slots needed per manufacturing slot, running continuously
      const v = volumes[c.id];
      r.volDay = v == null ? null : v;
      const slotUnits = (r.units / r.seconds) * 3600 * win;
      const marketUnits = v == null ? null : v * (win / 24) * (s.volumeCap / 100);
      r.maxProfit = marketUnits == null ? null : (r.profit / r.units) * Math.min(marketUnits, slotUnits * s.slots);
      return r;
    });
  }

  // ---------- plan ----------
  const slotTotals = (x, f) => ({
    gross: x.gross * f, mat: x.matCost * f, shipOut: x.shipOut * f, install: x.installCost * f, fees: x.fees * f, profit: x.profit * f,
  });
  const inputSupply = (id) => (prices.in[id]?.sell?.volume || 0) * (bridge.s.inputCap / 100);

  function candidates(rows, s) {
    const win = windowHours(s);
    const winSec = win * 3600;
    const out = [];
    for (const r of rows) {
      if (!(r.volDay > 0)) continue;
      const capUnits = r.volDay * (win / 24) * (s.volumeCap / 100);
      const versions = r.made.size ? [["chain", r], ["buy", r.buy]] : [["buy", r.buy]];
      for (const [ver, base] of versions) {
        if (!base.hasPrices) continue;
        const unitFn = ver === "chain" ? r.mkU.chain : r.mkU.buy;
        const mode = ver === "chain" ? a.mode : "none";
        const make = (res, f) => ({
          r, ver, res, per: res.profit * f, units: res.units * f, capUnits, f,
          t: slotTotals(res, f),
          inputs: new Map([...res.raw].map(([k, q]) => [k, q * f])),
          made: new Map([...res.made].map(([k, q]) => [k, q * f])),
          react: (res.rsec * f) / winSec,
        });
        if (s.lazy) {
          let fit = Math.floor(winSec / (r.seconds / r.runs));
          while (fit > 1 && jobSeconds(r.c, base.bp.te, fit, base.ctx.mods) > winSec) fit--;
          if (fit < 1 || jobSeconds(r.c, base.bp.te, fit, base.ctx.mods) > winSec) continue;
          const sizes = new Set(SIZES.map((x) => Math.max(1, Math.floor(fit * x))));
          const capRuns = Math.floor(capUnits / r.c.perRun);
          if (capRuns >= 1 && capRuns < fit) sizes.add(capRuns);
          for (const runs of sizes) {
            if (runs * r.c.perRun > capUnits) continue;
            const lr = evalComp(s, r.c, mode, runs, unitFn);
            if (lr.profit > 0) out.push({ ...make(lr, 1), runs });
          }
        } else if (base.profit > 0) {
          out.push({ ...make(base, winSec / base.seconds), runs: r.runs });
        }
      }
    }
    return out.map((c) => ({ ...c, up: c.t.mat + c.t.install }));
  }

  function allocate(cands, s, capital) {
    const lazy = s.lazy;
    let left = s.slots;
    let reactLeft = s.reactSlots;
    let capLeft = capital;
    const used = new Map();
    const usedIn = new Map();
    const alloc = [];
    for (const c of cands) {
      if (left <= 0) break;
      const room = c.capUnits - (used.get(c.r.c.id) || 0);
      let n = Math.min(left, room / c.units, c.up > 0 ? capLeft / c.up : Infinity, inputRoom(c, usedIn, inputSupply), c.react > 0 ? reactLeft / c.react : Infinity);
      if (lazy) n = Math.floor(n + 1e-9);
      if (!(n > 0) || n * c.units < c.r.c.perRun) continue;
      alloc.push({ ...c, n, profit: n * c.per });
      used.set(c.r.c.id, (used.get(c.r.c.id) || 0) + n * c.units);
      for (const [id, q] of c.inputs) usedIn.set(id, (usedIn.get(id) || 0) + n * q);
      left -= n;
      reactLeft -= n * c.react;
      capLeft -= n * c.up;
    }
    return { alloc, total: alloc.reduce((x, y) => x + y.profit, 0), left, reactLeft, usedIn };
  }

  function planHtml(rows, s) {
    const lazy = s.lazy;
    const win = windowHours(s);
    const capital = s.capital > 0 ? Number(s.capital) : Infinity;
    const cands = candidates(rows, s);
    let best = allocate([...cands].sort((x, y) => y.per - x.per), s, capital);
    // Reactor time and capital are both scarce, so also try ranking by profit per unit of each and keep the best.
    const orders = [(c) => c.per / Math.max(c.react, 1e-6), (c) => c.per / Math.max(c.up, 1)];
    for (const score of orders) {
      const alt = allocate([...cands].sort((x, y) => score(y) - score(x)), s, capital);
      if (alt.total > best.total) best = alt;
    }
    const { alloc, total, left, reactLeft, usedIn } = best;
    const tight = tightestInputs(usedIn, inputSupply, (id) => names[id] ?? id);
    const sum = Object.fromEntries(KEYS.map((k) => [k, alloc.reduce((x, y) => x + y.n * y.t[k], 0)]));
    const upfront = sum.mat + sum.install;
    const totalCost = upfront + sum.shipOut + sum.fees;

    // Raw purchases (multibuy) and reactor jobs the plan needs.
    const buy = new Map();
    const madeTotal = new Map();
    for (const x of alloc) {
      const jobs = x.n; // candidate quantities are already per slot per window
      for (const [id, q] of x.inputs) buy.set(id, (buy.get(id) || 0) + q * jobs);
      for (const [id, q] of x.made) madeTotal.set(id, (madeTotal.get(id) || 0) + q * jobs);
    }
    planBuyText = [...buy].map(([id, q]) => [names[id] ?? id, Math.ceil(q)]).sort((x, y) => x[0].localeCompare(y[0])).map(([n, q]) => `${n}\t${q}`).join("\n");
    const reactJobs = [...madeTotal].map(([id, units]) => {
      const F = formulas.get(id);
      return { name: names[id], units, slots: (units * ownSeconds(s, id)) / (win * 3600), runs: units / F.perRun };
    }).sort((x, y) => y.slots - x.slots);

    const row = (l, v, c = "") => `<tr><td>${l}</td><td class="${c}">${v}</td></tr>`;
    const pct = (x) => (sum.gross ? ` <span class="muted">(${((x / sum.gross) * 100).toFixed(1)}%)</span>` : "");
    const head = lazy
      ? "<tr><th>Product</th><th>Inputs</th><th>Slots</th><th>Runs / job</th><th>Units / slot</th><th>Reactor slots</th><th>Total profit</th></tr>"
      : "<tr><th>Product</th><th>Inputs</th><th>Slots</th><th>Units</th><th>Reactor slots</th><th>Profit</th></tr>";
    const body = alloc.map((x) => lazy
      ? `<tr><td>${esc(x.r.c.name)}</td><td>${x.ver === "chain" ? "reacted" : "bought"}</td><td>${x.n}</td><td>${x.runs}</td><td>${fmtIsk(x.units)}</td><td>${(x.n * x.react).toFixed(2)}</td><td class="good">${fmtIsk(x.profit)}</td></tr>`
      : `<tr><td>${esc(x.r.c.name)}</td><td>${x.ver === "chain" ? "reacted" : "bought"}</td><td>${x.n.toFixed(1)}</td><td>${fmtIsk(x.n * x.units)}</td><td>${(x.n * x.react).toFixed(2)}</td><td class="good">${fmtIsk(x.profit)}</td></tr>`).join("");
    const breakdown = `<table class="summary">
        ${row("Revenue", fmtIsk(sum.gross))}
        ${row("Inputs (bought + reacted, incl. shipping)", "-" + fmtIsk(sum.mat) + pct(sum.mat))}
        ${row("Job installation (components)", "-" + fmtIsk(sum.install) + pct(sum.install))}
        ${row("Sales tax + broker fees", "-" + fmtIsk(sum.fees) + pct(sum.fees))}
        ${row("Shipping out", "-" + fmtIsk(sum.shipOut) + pct(sum.shipOut))}
        ${row("<b>Total cost</b>", "<b>-" + fmtIsk(totalCost) + "</b>")}
        ${row("<b>Profit</b>", "<b>" + fmtIsk(total) + "</b>", total > 0 ? "good" : "")}
        ${row("Margin (profit / revenue)", sum.gross ? ((total / sum.gross) * 100).toFixed(1) + "%" : "-")}
        ${row("ROI (profit / total cost)", totalCost ? ((total / totalCost) * 100).toFixed(1) + "%" : "-")}
        ${row("<b>Capital needed up front</b>", "<b>" + fmtIsk(upfront) + "</b>" + (capital < Infinity ? ` <span class="muted">of ${fmtShort(capital)} available</span>` : ""))}
        ${row("Reactor slots used", `${(s.reactSlots - reactLeft).toFixed(2)} of ${s.reactSlots}`)}
      </table>`;
    const reactTable = reactJobs.length
      ? `<table><tr><th>Reaction to run</th><th>Units</th><th>Runs</th><th>Reactor slots</th></tr>${reactJobs.map((x) => `<tr><td>${esc(x.name)}</td><td>${fmtIsk(x.units)}</td><td>${x.runs.toFixed(0)}</td><td>${x.slots.toFixed(2)}</td></tr>`).join("")}</table>`
      : "";
    const winLabel = `${Math.floor(win / 24)}d ${win % 24}h`;
    const known = rows.filter((r) => r.volDay > 0).length;
    const hint = known ? `Planning over ${known} components with known volume.` : `<span class="warn">Load market data first (it also loads component volumes).</span>`;
    return `<h3>Suggested plan - ${s.slots} manufacturing + ${s.reactSlots} reaction slots, ${winLabel} window${lazy ? ", lazy mode" : ""}${capital < Infinity ? `, ${fmtShort(capital)} capital` : ""}</h3>
      <div class="muted">${hint} Component jobs follow lazy mode; reactor jobs are sized to the need (fractional slots).</div>
      ${alloc.length ? `<div><b class="good">${fmtIsk(total)} ISK</b> <span class="muted">expected profit per window${left > 0.01 ? `; ${lazy ? left : left.toFixed(1)} manufacturing slots unused (slot, market, input, reactor or capital limit)` : ""}</span></div>
      ${tight.length ? `<div class="muted">Tightest raw inputs: ${tight.map((x) => `${esc(x.name)} ${Number.isFinite(x.pct) ? (x.pct * 100).toFixed(0) + "%" : "no supply"}`).join(", ")}</div>` : ""}
      <div class="plancols"><table>${head}${body}</table>${breakdown}${reactTable}</div>
      <p><button id="c-copybuy">Create buy order (copy multibuy)</button> <span class="muted" id="c-copymsg">${buy.size} raw inputs for the whole plan</span></p>` : ""}`;
  }

  // ---------- table ----------
  const COLS = [
    ["name", "Product", (r) => esc(r.c.name)],
    ["group", "Group", (r) => esc(r.c.group)],
    ["outPrice", "Sell price", (r) => fmtIsk(r.outPrice, 2)],
    ["buyCost", "Cost / unit (buy all)", (r) => fmtIsk(r.buy.costPerUnit, 2)],
    ["costPerUnit", "Cost / unit (chained)", (r) => fmtIsk(r.costPerUnit, 2)],
    ["saving", "Saved", (r) => (r.saving * 100).toFixed(1) + "%"],
    ["profit", "Profit / job", (r) => fmtShort(r.profit)],
    ["margin", "Margin", (r) => (r.margin * 100).toFixed(1) + "%"],
    ["perHour", "ISK / hour / slot", (r) => fmtShort(r.perHour)],
    ["reactSlots", "Reactor slots / slot", (r) => r.reactSlots.toFixed(2)],
    ["madeIds", "Reacted inputs", (r) => (r.madeIds.length ? esc(r.madeIds.join(", ")) : "-")],
    ["maxProfit", "Capped profit / window", (r) => (r.maxProfit == null ? "-" : fmtShort(r.maxProfit))],
    ["volDay", "Vol / day", (r) => (r.volDay == null ? "-" : fmtIsk(r.volDay))],
  ];

  function detail(r) {
    const row = (l, v, c = "") => `<tr><td>${l}</td><td class="${c}">${v}</td></tr>`;
    const lines = r.lines.map((l) => {
      const u = r.mkU.chain(l.id);
      return `<tr><td>${esc(l.name)}</td><td>${u?.make ? "react" : "buy"}</td><td>${fmtIsk(l.need)}</td><td>${fmtIsk(l.price, 2)}</td><td>${fmtIsk(l.cost)}</td><td>${fmtIsk(r.mkU.buy(l.id)?.cost ?? 0, 2)}</td></tr>`;
    }).join("");
    return `<div class="cols"><div><table><tr><th>Input (${r.runs} runs)</th><th>Source</th><th>Qty</th><th>Unit cost</th><th>Cost</th><th>Buy price</th></tr>${lines}</table></div>
      <div><table>
      ${row("Units produced", fmtIsk(r.units))}${row("Gross revenue", fmtIsk(r.gross))}
      ${row("Sales tax + broker", "-" + fmtIsk(r.fees))}${row("Inputs", "-" + fmtIsk(r.matCost))}
      ${row("Job install (EIV " + fmtShort(r.eiv) + ")", "-" + fmtIsk(r.installCost))}
      ${row("<b>Profit per job (chained)</b>", "<b>" + fmtIsk(r.profit) + "</b>", r.profit > 0 ? "good" : "bad")}
      ${row("Profit per job (buy all inputs)", fmtIsk(r.buy.profit), r.buy.profit > 0 ? "good" : "bad")}
      ${row("Job time", fmtTime(r.seconds))}
      </table></div></div>`;
  }

  function filtered(rows) {
    const q = a.search.toLowerCase();
    const list = rows.filter((r) =>
      (a.group === "All" || r.c.group === a.group) && (!a.onlyProfit || (r.profit > 0 && r.hasPrices)) &&
      (!q || r.c.name.toLowerCase().includes(q)));
    const val = (r) => (a.sort === "name" ? r.c.name : a.sort === "group" ? r.c.group : a.sort === "madeIds" ? r.madeIds.length : a.sort === "buyCost" ? r.buy.costPerUnit : r[a.sort] ?? -Infinity);
    list.sort((x, y) => {
      const p = val(x), q2 = val(y);
      const c = typeof p === "string" ? p.localeCompare(q2) : p - q2;
      return a.asc ? c : -c;
    });
    return list;
  }

  function render() {
    if (root.hidden) return;
    const s = bridge.s;
    const keep = document.activeElement?.dataset?.c;
    const rows = compute();
    const list = filtered(rows);
    const head = COLS.map(([k, l]) => `<th data-sort="${k}" class="${a.sort === k ? "sorted" + (a.asc ? " asc" : "") : ""}">${l}</th>`).join("");
    const body = list.map((r) => {
      const cls = r.profit > 0 ? "good" : "bad";
      const cells = COLS.map(([k, , f]) => `<td${["profit", "margin", "perHour", "maxProfit"].includes(k) ? ` class="${cls}"` : ""}>${f(r)}</td>`).join("");
      return `<tr class="row" data-id="${r.c.id}">${cells}</tr>${open.has(r.c.id) ? `<tr class="detail"><td colspan="${COLS.length}">${detail(r)}</td></tr>` : ""}`;
    }).join("");
    const sec = bridge.system("reaction").sec;
    const warn = sec >= 0.45 ? ` <span class="warn">Your reaction system is high-sec, where reactions cannot be run.</span>` : "";
    root.innerHTML = `
      <div class="intro"><b>Reaction chain.</b> Advanced components built from inputs that you either buy or react yourself. Each input is
        costed at the cheaper of its market price and its reaction cost (nested reactions included), using your reaction system,
        structure, rigs, Reactions skill and facility tax.${warn}
        <span class="muted">${prices.ts ? "Prices loaded " + new Date(prices.ts).toLocaleTimeString() : "No prices loaded yet."}</span></div>
      <div id="c-plan" class="planbox">${planHtml(rows, s)}</div>
      <div class="bar">
        <button id="c-load" class="primary" ${busy ? "disabled" : ""}>Load market data</button>
        <span class="muted">${esc(busy)}</span>
      </div>
      <div class="bar">
        <label>Reacted inputs <select data-c="mode">${[["best", "when cheaper than buying"], ["all", "always (when possible)"], ["none", "never (buy everything)"]].map(([v, l]) => `<option value="${v}" ${a.mode === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Reaction runs/job <input type="number" data-c="reactRuns" min="1" value="${a.reactRuns}"></label>
        <label>Group <select data-c="group">${groups.map((g) => `<option ${g === a.group ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></label>
        <label><input type="checkbox" data-c="onlyProfit" ${a.onlyProfit ? "checked" : ""}> profitable only</label>
        <input type="search" data-c="search" placeholder="Filter by name" value="${esc(a.search)}">
        <span class="muted">${list.length} of ${rows.length}</span>
      </div>
      <div class="tablewrap"><table id="c-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted notes">Reaction slot-time is spent on the intermediates each component needs; a component job's input list is expanded
        all the way down to the raw moon goo, gas and fuel blocks you would actually buy. Reaction material and job costs use the
        reaction runs per job above. Sell-side fees and shipping are not charged on intermediates you make and use yourself.</p>`;
    if (keep) {
      const el = root.querySelector(`[data-c="${keep}"]`);
      if (el) { el.focus(); if (el.type === "search") el.setSelectionRange(1e6, 1e6); }
    }
  }

  async function loadAll() {
    busy = "Loading prices...";
    render();
    try {
      await bridge.refreshShared();
      const s = bridge.s;
      const matIds = Object.keys(names).map(Number); // every input we might buy or reaction product we might price
      const compIds = components.map((c) => c.id);
      const chunks = (ids) => Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => ids.slice(i * 300, i * 300 + 300));
      const get = async (hub, ids) => Object.assign({}, ...(await Promise.all(chunks(ids).map((c) => fetchPrices(hub, c)))));
      if (s.inHub === s.outHub) {
        const p = await get(s.inHub, matIds);
        prices = { in: p, out: p, ts: Date.now() };
      } else {
        const [pi, po] = await Promise.all([get(s.inHub, matIds), get(s.outHub, compIds)]);
        prices = { in: pi, out: po, ts: Date.now() };
      }
      busy = "Loading volumes...";
      render();
      volumes = await fetchVolumes(s.outHub, compIds, (d, n) => {
        const el = root.querySelector(".bar .muted");
        if (el) el.textContent = `Loading volumes ${d}/${n}`;
      });
      busy = "";
    } catch (e) {
      busy = "Error: " + e.message;
    }
    render();
  }

  root.addEventListener("click", (e) => {
    if (e.target.id === "c-load") return loadAll();
    if (e.target.id === "c-copybuy") {
      const msg = root.querySelector("#c-copymsg");
      const ok = () => { msg.textContent = "Copied - paste into the in-game Multibuy window"; };
      return navigator.clipboard.writeText(planBuyText).then(ok, () => {
        const ta = Object.assign(document.createElement("textarea"), { value: planBuyText });
        document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); ok();
      });
    }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      a.asc = a.sort === k ? !a.asc : k === "name" || k === "group";
      a.sort = k; save(); return render();
    }
    const tr = e.target.closest("tr.row");
    if (tr) {
      const id = Number(tr.dataset.id);
      open.has(id) ? open.delete(id) : open.add(id);
      render();
    }
  });
  root.addEventListener("input", (e) => {
    const k = e.target.dataset.c;
    if (!k) return;
    const t = e.target;
    a[k] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
    save(); render();
  });
  document.addEventListener("evecp:change", render);
  render();
}
