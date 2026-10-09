// Experimental tab: profitability of everything manufacturable from a market BPO.
// Self-contained: reads shared settings through window.evecp and owns its own prices, volumes and filters.
// To remove: delete this file, src/tabs.js, data/all.json, the #tabs/#allview markup and window.evecp in app.js.
import { buildMods, evaluate, jobSeconds, RIG_SEC_MULT, secClass, windowHours } from "./calc.js";
import { fetchPrices, fetchVolumes } from "./api.js";

const KEY = "evecp.all.v1";
const DEFAULTS = {
  rigTier: "none", runs: 10, cat: "All", sub: "All", search: "", onlyProfit: true,
  minOrders: 5, noCapital: true, needBpo: true, sort: "maxProfit", asc: false, limit: 200, volN: 600,
};
const CAPITAL_SHIP_CONSTRUCTION = 22242;
const JITA = "s:60003760"; // 4-4; BPOs are NPC-seeded, so Jita is the reference for "can I buy this BPO"
const RIG_SIZE = { raitaru: "M-Set", azbel: "L-Set", sotiyo: "XL-Set" };

export async function initAll(root, bridge) {
  const { fmtIsk, fmtShort, fmtTime } = bridge.fmt;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let a = { ...DEFAULTS };
  try { a = { ...a, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* ignore */ } };

  root.innerHTML = "<p class='muted'>Loading blueprint data...</p>";
  const data = await fetch("data/all.json").then((r) => r.json());
  const open = new Set();
  let prices = { in: {}, out: {}, ts: 0 };
  let volumes = {};
  let bpoSale = null; // blueprint type id -> lowest Jita sell price (null until prices are loaded)
  let busy = "";

  // Build the evaluate()-shaped component objects once.
  const items = data.items.map((it) => ({
    ...it,
    comp: {
      id: it.id, name: it.name, perRun: it.perRun, time: it.time, volume: it.volume,
      materials: it.mats.map(([id, qty]) => ({ id, qty, name: data.mats[id][0], volume: data.mats[id][1] })),
    },
  }));
  const cats = ["All", ...new Set(items.map((i) => i.cat))];

  // Best applicable rigs of the chosen tier for this product, given the structure size. Returns { mat, time, names }.
  function pickRigs(it, s) {
    const none = { mat: 0, time: 0, names: [] };
    const size = RIG_SIZE[s.structure];
    if (!size || a.rigTier === "none") return none;
    const tier = a.rigTier === "II" ? /\sII$/ : /\sI$/;
    const cand = data.rigSets[it.rigSet].map((id) => ({ id, name: data.rigs[id][0], mat: data.rigs[id][1], time: data.rigs[id][2] }))
      .filter((r) => r.name.includes(`Standup ${size} `) && !r.name.includes("Thukker") && tier.test(r.name));
    const m = cand.filter((r) => r.mat < 0).sort((x, y) => x.mat - y.mat)[0];
    const picked = m ? [m] : [];
    if (!m || m.time === 0) {
      const tr = cand.filter((r) => r.mat === 0 && r.time < 0).sort((x, y) => x.time - y.time)[0];
      if (tr) picked.push(tr);
    }
    return { mat: m ? m.mat : 0, time: picked.reduce((x, r) => x + r.time, 0), names: picked.map((r) => r.name.replace("Standup ", "")) };
  }

  const book = (side, id) => prices[side][id];
  const priceOf = (s, side, id) => {
    const ov = s.overrides?.in?.[id];
    if (side === "in" && ov > 0) return Number(ov);
    const b = book(side, id);
    if (!b) return 0;
    const method = side === "in" ? s.inputMethod : s.outputMethod;
    const useSell = side === "in" ? method === "instant" : method === "order";
    const o = useSell ? b.sell : b.buy;
    const stat = s.priceStat === "best" ? (useSell ? "min" : "max") : s.priceStat;
    return o?.[stat] || 0;
  };
  const ordersOf = (s, id) => {
    const b = book("out", id);
    if (!b) return 0;
    return (s.outputMethod === "order" ? b.sell : b.buy)?.orderCount || 0;
  };

  function compute() {
    const s = bridge.s;
    const { sec, sci } = bridge.system();
    const sm = RIG_SEC_MULT[secClass(sec)];
    const base = buildMods({ ...s, rigs: [] }, [], sec);
    const bp = { me: s.defaultME, te: s.defaultTE };
    const sx = { ...s, runs: a.runs };
    return items.map((it) => {
      const rg = pickRigs(it, s);
      const mods = { ...base, rigMat: 1 + (rg.mat / 100) * sm, rigTime: 1 + (rg.time / 100) * sm };
      const ctx = { s: sx, mods, sci, adj: bridge.market.adj, inPrice: (id) => priceOf(s, "in", id), outPrice: (id) => priceOf(s, "out", id) };
      const r = evaluate(it.comp, bp, ctx);
      r.it = it; r.rigNames = rg.names; r.orders = ordersOf(s, it.id); r.ctx = ctx; r.mods = mods; r.bpo = bp;
      r.hasPrices = r.outPrice > 0 && r.lines.every((l) => l.price > 0);
      r.profitWin = r.perHour * windowHours(s);
      const v = volumes[it.id];
      r.volDay = v == null ? null : v;
      // Units one slot makes per window vs. units the market will absorb (shared market-share cap), and the best
      // profit all slots together can take from this product without out-producing the market.
      const slotUnits = (r.units / r.seconds) * 3600 * windowHours(s);
      const marketUnits = v == null ? null : v * (windowHours(s) / 24) * (s.volumeCap / 100);
      r.share = v ? slotUnits / (v * (windowHours(s) / 24)) : null;
      r.maxProfit = marketUnits == null ? null : (r.profit / r.units) * Math.min(marketUnits, slotUnits * s.slots);
      r.satSlots = marketUnits == null ? null : marketUnits / slotUnits;
      return r;
    });
  }

  const COLS = [
    ["name", "Product", (r) => esc(r.it.name)],
    ["sub", "Group", (r) => esc(r.it.sub)],
    ["outPrice", "Sell price", (r) => fmtIsk(r.outPrice, 2)],
    ["costPerUnit", "Cost / unit", (r) => fmtIsk(r.costPerUnit, 2)],
    ["profit", "Profit / job", (r) => fmtShort(r.profit)],
    ["margin", "Margin", (r) => (r.margin * 100).toFixed(1) + "%"],
    ["roi", "ROI", (r) => (r.roi * 100).toFixed(1) + "%"],
    ["seconds", "Job time", (r) => fmtTime(r.seconds)],
    ["perHour", "ISK / hour / slot", (r) => fmtShort(r.perHour)],
    ["profitWin", "Profit / window / slot", (r) => fmtShort(r.profitWin)],
    ["maxProfit", "Capped profit / window", (r) => (r.maxProfit == null ? "-" : fmtShort(r.maxProfit))],
    ["satSlots", "Slots to saturate", (r) => (r.satSlots == null ? "-" : r.satSlots.toFixed(1))],
    ["orders", "Orders", (r) => r.orders],
    ["volDay", "Vol / day", (r) => (r.volDay == null ? "-" : fmtIsk(r.volDay))],
    ["share", "Mkt share / slot", (r) => (r.share == null ? "-" : (r.share * 100).toFixed(1) + "%")],
  ];

  function detail(r) {
    const row = (l, v, c = "") => `<tr><td>${l}</td><td class="${c}">${v}</td></tr>`;
    const mats = r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${fmtIsk(l.need)}</td><td>${fmtIsk(l.price, 2)}</td><td>${fmtIsk(l.cost)}</td></tr>`).join("");
    return `<div class="cols"><div><table><tr><th>Material (${r.runs} runs)</th><th>Qty</th><th>Price</th><th>Cost</th></tr>${mats}</table>
      <p class="muted">Rigs: ${r.rigNames.length ? esc(r.rigNames.join(", ")) : "none"}</p></div>
      <div><table>
      ${row("Units produced", fmtIsk(r.units))}${row("Gross revenue", fmtIsk(r.gross))}
      ${row("Sales tax + broker", "-" + fmtIsk(r.fees))}${row("Materials", "-" + fmtIsk(r.matCost))}
      ${row("Shipping in / out", "-" + fmtIsk(r.shipIn) + " / -" + fmtIsk(r.shipOut))}
      ${row(`Job install (EIV ${fmtShort(r.eiv)})`, "-" + fmtIsk(r.installCost))}
      ${row("<b>Profit per job</b>", "<b>" + fmtIsk(r.profit) + "</b>", r.profit > 0 ? "good" : "bad")}
      </table></div></div>`;
  }

  function filtered(rows) {
    const q = a.search.toLowerCase();
    const list = rows.filter((r) =>
      (a.cat === "All" || r.it.cat === a.cat) && (a.sub === "All" || r.it.sub === a.sub) &&
      (!a.onlyProfit || (r.profit > 0 && r.hasPrices)) && r.orders >= a.minOrders &&
      !(a.noCapital && r.it.skills.some((k) => k[0] === CAPITAL_SHIP_CONSTRUCTION)) &&
      !(a.needBpo && bpoSale && !(bpoSale[r.it.bp] > 0)) &&
      (!q || r.it.name.toLowerCase().includes(q)));
    const val = (r) => (a.sort === "name" ? r.it.name : a.sort === "sub" ? r.it.sub : r[a.sort] ?? -Infinity);
    list.sort((x, y) => {
      const p = val(x), q2 = val(y);
      const c = typeof p === "string" ? p.localeCompare(q2) : p - q2;
      return a.asc ? c : -c;
    });
    return list;
  }


  // ---------- suggested plan (mirrors the Advanced components tab, but only over products with loaded volumes) ----------
  let planBuyText = "";
  const SIZES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.12, 0.06];
  const KEYS = ["gross", "mat", "shipIn", "shipOut", "install", "fees", "profit"];
  const slotTotals = (x, f) => ({
    gross: x.gross * f, mat: x.matCost * f, shipIn: x.shipIn * f, shipOut: x.shipOut * f,
    install: x.installCost * f, fees: x.fees * f, profit: x.profit * f,
  });

  // Lazy mode: one job per slot, offered at several sizes up to one that fills the window.
  function lazyCandidates(r, s) {
    const winSec = windowHours(s) * 3600;
    let fit = Math.floor(winSec / (r.seconds / r.runs));
    while (fit > 1 && jobSeconds(r.it.comp, r.bpo.te, fit, r.mods) > winSec) fit--;
    if (fit < 1 || jobSeconds(r.it.comp, r.bpo.te, fit, r.mods) > winSec) return [];
    const capUnits = r.capUnits;
    const sizes = new Set(SIZES.map((f) => Math.max(1, Math.floor(fit * f))));
    const capRuns = Math.floor(capUnits / r.it.perRun);
    if (capRuns >= 1 && capRuns < fit) sizes.add(capRuns);
    const out = [];
    for (const runs of sizes) {
      if (runs * r.it.perRun > capUnits) continue;
      const lr = evaluate(r.it.comp, r.bpo, { ...r.ctx, s: { ...r.ctx.s, runs } });
      if (lr.profit > 0) out.push({ r, lr, per: lr.profit, units: lr.units, capUnits, t: slotTotals(lr, 1) });
    }
    return out;
  }

  function allocate(cands, lazy, capital, slots) {
    let left = slots;
    let capLeft = capital;
    const used = new Map();
    const alloc = [];
    for (const c of cands) {
      if (left <= 0) break;
      const room = c.capUnits - (used.get(c.r.it.id) || 0);
      let n = Math.min(left, room / c.units, c.up > 0 ? capLeft / c.up : Infinity);
      if (lazy) n = Math.floor(n + 1e-9);
      if (!(n > 0)) continue;
      alloc.push({ ...c, n, profit: n * c.per });
      used.set(c.r.it.id, (used.get(c.r.it.id) || 0) + n * c.units);
      left -= n;
      capLeft -= n * c.up;
    }
    return { alloc, total: alloc.reduce((x, y) => x + y.profit, 0), left };
  }

  function planHtml(list, s) {
    const lazy = s.lazy;
    const win = windowHours(s);
    const capital = s.capital > 0 ? Number(s.capital) : Infinity;
    const known = list.filter((r) => r.volDay != null && r.hasPrices && r.profit > 0);
    for (const r of known) r.capUnits = r.volDay * (win / 24) * (s.volumeCap / 100);
    const cands = (lazy
      ? known.flatMap((r) => lazyCandidates(r, s))
      : known.map((r) => {
        const f = (win * 3600) / r.seconds; // jobs per slot per window
        return { r, per: r.profitWin, units: r.units * f, capUnits: r.capUnits, t: slotTotals(r, f) };
      })
    ).map((c) => ({ ...c, up: c.t.mat + c.t.shipIn + c.t.install }));

    // With limited capital also weigh profit per ISK of capital; try several blends and keep the best.
    let best = allocate([...cands].sort((x, y) => y.per - x.per), lazy, capital, s.slots);
    if (capital < Infinity) {
      for (const w of [0.25, 0.5, 0.75, 1]) {
        const score = (c) => c.per ** (1 - w) * (c.per / c.up) ** w;
        const alt = allocate([...cands].sort((x, y) => score(y) - score(x)), lazy, capital, s.slots);
        if (alt.total > best.total) best = alt;
      }
    }
    const { alloc, total, left } = best;
    const sum = Object.fromEntries(KEYS.map((k) => [k, alloc.reduce((x, y) => x + y.n * y.t[k], 0)]));
    const upfront = sum.mat + sum.shipIn + sum.install;
    const totalCost = upfront + sum.shipOut + sum.fees;

    const buy = new Map();
    for (const x of alloc) {
      const jobs = lazy ? x.n : (x.n * x.units) / x.r.units;
      for (const l of (lazy ? x.lr.lines : x.r.lines)) buy.set(l.name, (buy.get(l.name) || 0) + l.need * jobs);
    }
    planBuyText = [...buy].sort((x, y) => x[0].localeCompare(y[0])).map(([n, q]) => `${n}\t${Math.ceil(q)}`).join("\n");

    const winLabel = `${Math.floor(win / 24)}d ${win % 24}h`;
    const head = lazy
      ? "<tr><th>Product</th><th>Slots</th><th>Runs / job</th><th>Job length</th><th>Units / slot</th><th>Profit / slot</th><th>Total profit</th></tr>"
      : "<tr><th>Product</th><th>Slots</th><th>Units</th><th>Profit</th></tr>";
    const body = alloc.map((x) => lazy
      ? `<tr><td>${esc(x.r.it.name)}</td><td>${x.n}</td><td>${x.lr.runs}</td><td>${fmtTime(x.lr.seconds)}</td><td>${fmtIsk(x.units)}</td><td>${fmtIsk(x.per)}</td><td class="good">${fmtIsk(x.profit)}</td></tr>`
      : `<tr><td>${esc(x.r.it.name)}</td><td>${x.n.toFixed(1)}</td><td>${fmtIsk(x.n * x.units)}</td><td class="good">${fmtIsk(x.profit)}</td></tr>`).join("");
    const row = (l, v, c = "") => `<tr><td>${l}</td><td class="${c}">${v}</td></tr>`;
    const pct = (x) => (sum.gross ? ` <span class="muted">(${((x / sum.gross) * 100).toFixed(1)}%)</span>` : "");
    const breakdown = `<table class="summary">
        ${row("Revenue", fmtIsk(sum.gross))}
        ${row("Materials", "-" + fmtIsk(sum.mat) + pct(sum.mat))}
        ${row("Shipping in", "-" + fmtIsk(sum.shipIn) + pct(sum.shipIn))}
        ${row("Job installation", "-" + fmtIsk(sum.install) + pct(sum.install))}
        ${row("Sales tax + broker fees", "-" + fmtIsk(sum.fees) + pct(sum.fees))}
        ${row("Shipping out", "-" + fmtIsk(sum.shipOut) + pct(sum.shipOut))}
        ${row("<b>Total cost</b>", "<b>-" + fmtIsk(totalCost) + "</b>")}
        ${row("<b>Profit</b>", "<b>" + fmtIsk(total) + "</b>", total > 0 ? "good" : "")}
        ${row("Margin (profit / revenue)", sum.gross ? ((total / sum.gross) * 100).toFixed(1) + "%" : "-")}
        ${row("ROI (profit / total cost)", totalCost ? ((total / totalCost) * 100).toFixed(1) + "%" : "-")}
        ${row("<b>Capital needed up front</b>", "<b>" + fmtIsk(upfront) + "</b>" + (capital < Infinity ? ` <span class="muted">of ${fmtShort(capital)} available</span>` : ""))}
      </table>`;
    const hint = known.length
      ? `Planning over ${known.length} filtered products with loaded volumes.`
      : `<span class="warn">No products with loaded volumes yet - use "Load volumes" first. The plan only considers products whose market size is known.</span>`;
    return `<h3>Suggested plan - ${s.slots} slots, ${winLabel} window${lazy ? ", lazy mode" : ""}${capital < Infinity ? `, ${fmtShort(capital)} capital` : ""}</h3>
      <div class="muted">${hint} Slots, window, lazy mode, capital and market-share cap come from the shared settings.</div>
      ${alloc.length ? `<div><b class="good">${fmtIsk(total)} ISK</b> <span class="muted">expected profit per window${left > 0.01 ? `; ${lazy ? left : left.toFixed(1)} slots unused (slot, market-share or capital limit)` : ""}</span></div>
      <div class="plancols"><table>${head}${body}</table>${breakdown}</div>
      <p><button id="a-copybuy">Create buy order (copy multibuy)</button> <span class="muted" id="a-copymsg">${buy.size} items for the whole plan</span></p>` : ""}`;
  }

  function render() {
    if (root.hidden) return;
    const keepFocus = document.activeElement?.dataset?.a;
    const rows = compute();
    const list = filtered(rows);
    const subs = ["All", ...new Set(items.filter((i) => a.cat === "All" || i.cat === a.cat).map((i) => i.sub))];
    const head = COLS.map(([k, l]) => `<th data-sort="${k}" class="${a.sort === k ? "sorted" + (a.asc ? " asc" : "") : ""}">${l}</th>`).join("");
    const body = list.slice(0, a.limit).map((r) => {
      const cls = r.profit > 0 ? "good" : "bad";
      const cells = COLS.map(([k, , f]) => `<td${["profit", "margin", "roi", "perHour", "profitWin", "maxProfit"].includes(k) ? ` class="${cls}"` : ""}>${f(r)}</td>`).join("");
      return `<tr class="row" data-id="${r.it.id}">${cells}</tr>${open.has(r.it.id) ? `<tr class="detail"><td colspan="${COLS.length}">${detail(r)}</td></tr>` : ""}`;
    }).join("");
    const opt = (list, cur) => list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
    root.innerHTML = `
      <div class="intro"><b>All manufacturing (experimental).</b> Every product with a market BPO (${items.length}), using your shared
        skills, structure, location, fees, shipping and ME/TE defaults. Blueprint ME/TE is assumed researched to the defaults.
        <span class="muted">${prices.ts ? "Prices loaded " + new Date(prices.ts).toLocaleTimeString() : "No prices loaded yet."}</span></div>
      <div id="a-plan" class="planbox">${planHtml(list, bridge.s)}</div>
      <div class="bar">
        <button id="a-load" class="primary" ${busy ? "disabled" : ""}>Load market data</button>
        <button id="a-vol" ${busy || !prices.ts ? "disabled" : ""}>Load volumes for ${Math.min(list.length, a.volN)} filtered items</button>
        <label>Max items <input type="number" data-a="volN" min="10" max="2000" value="${a.volN}"></label>
        <span class="muted">${esc(busy)}</span>
      </div>
      <div class="bar">
        <label>Category <select data-a="cat">${opt(cats, a.cat)}</select></label>
        <label>Group <select data-a="sub">${opt(subs, a.sub)}</select></label>
        <label>Rigs <select data-a="rigTier">${[["none", "none"], ["I", "best T1 rig"], ["II", "best T2 rig"]].map(([v, l]) => `<option value="${v}" ${a.rigTier === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Runs/job <input type="number" data-a="runs" min="1" value="${a.runs}"></label>
        <label>Min orders <input type="number" data-a="minOrders" min="0" value="${a.minOrders}"></label>
        <label title="Hides capital ships, capital modules and capital components"><input type="checkbox" data-a="noCapital" ${a.noCapital ? "checked" : ""}> hide Capital Ship Construction items</label>
        <label title="Needs market data loaded; checks for BPO sell orders at Jita 4-4"><input type="checkbox" data-a="needBpo" ${a.needBpo ? "checked" : ""}> only BPOs sold in Jita</label>
        <label><input type="checkbox" data-a="onlyProfit" ${a.onlyProfit ? "checked" : ""}> profitable only</label>
        <input type="search" data-a="search" placeholder="Filter by name" value="${esc(a.search)}">
        <span class="muted">${list.length} of ${rows.length} (showing ${Math.min(list.length, a.limit)})</span>
      </div>
      <div class="tablewrap"><table id="a-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${list.length > a.limit ? `<p><button id="a-more">Show ${Math.min(200, list.length - a.limit)} more</button></p>` : ""}
      <p class="muted notes">Min orders filters out products whose market has too few orders on the side you trade, where prices are unreliable.
        Rigs: picks the best applicable Standup rig(s) of that tier for your structure size (Raitaru M, Azbel L, Sotiyo XL); ignored at NPC stations.
        Volumes come from ESI history (7-day average) and take a while for large lists, so narrow the filters first; a product's
        capped profit uses the shared market-share cap and slot count and stays blank until its volume is loaded.</p>`;
    if (keepFocus) {
      const el = root.querySelector(`[data-a="${keepFocus}"]`);
      if (el) { el.focus(); if (el.setSelectionRange && el.type === "search") el.setSelectionRange(1e6, 1e6); }
    }
  }

  async function loadPrices() {
    busy = "Loading prices...";
    render();
    try {
      await bridge.refreshShared(); // adjusted prices and cost indices come from the main tab's refresh
      const s = bridge.s;
      const matIds = Object.keys(data.mats).map(Number);
      const prodIds = items.map((i) => i.id);
      const chunks = (ids) => Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => ids.slice(i * 300, i * 300 + 300));
      const get = async (hub, ids) => Object.assign({}, ...(await Promise.all(chunks(ids).map((c) => fetchPrices(hub, c)))));
      if (s.inHub === s.outHub) {
        const p = await get(s.inHub, [...matIds, ...prodIds]);
        prices = { in: p, out: p, ts: Date.now() };
      } else {
        const [pi, po] = await Promise.all([get(s.inHub, matIds), get(s.outHub, prodIds)]);
        prices = { in: pi, out: po, ts: Date.now() };
      }
      const bp = await get(JITA, items.map((i) => i.bp));
      bpoSale = Object.fromEntries(Object.entries(bp).map(([id, b]) => [id, b.sell?.min > 0 && b.sell.orderCount > 0 ? b.sell.min : 0]));
      busy = "";
    } catch (e) {
      busy = "Error: " + e.message;
    }
    render();
  }

  async function loadVolumes() {
    const list = filtered(compute()).slice(0, a.volN).map((r) => r.it.id).filter((id) => volumes[id] == null);
    busy = "Loading volumes...";
    render();
    const v = await fetchVolumes(bridge.s.outHub, list, (d, n) => {
      const el = root.querySelector(".bar .muted");
      if (el) el.textContent = `Loading volumes ${d}/${n}`;
    });
    Object.assign(volumes, v);
    busy = "";
    render();
  }

  root.addEventListener("click", (e) => {
    if (e.target.id === "a-load") return loadPrices();
    if (e.target.id === "a-copybuy") {
      const msg = root.querySelector("#a-copymsg");
      const ok = () => { msg.textContent = "Copied - paste into the in-game Multibuy window"; };
      return navigator.clipboard.writeText(planBuyText).then(ok, () => {
        const ta = Object.assign(document.createElement("textarea"), { value: planBuyText });
        document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); ok();
      });
    }
    if (e.target.id === "a-vol") return loadVolumes();
    if (e.target.id === "a-more") { a.limit += 200; save(); return render(); }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      a.asc = a.sort === k ? !a.asc : k === "name" || k === "sub";
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
    const k = e.target.dataset.a;
    if (!k) return;
    const t = e.target;
    if (t.type === "checkbox") a[k] = t.checked;
    else if (t.type === "number") a[k] = Number(t.value);
    else a[k] = t.value;
    if (k === "cat") a.sub = "All";
    a.limit = DEFAULTS.limit;
    save(); render();
  });
  document.addEventListener("evecp:change", render);
  render();
}
