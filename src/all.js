// Experimental tab: profitability of everything manufacturable from a market BPO.
// Self-contained: reads shared settings through window.evecp and owns its own prices, volumes and filters.
// To remove: delete this file, src/tabs.js, data/all.json, the #tabs/#allview markup and window.evecp in app.js.
import { buildMods, evaluate, RIG_SEC_MULT, secClass, windowHours } from "./calc.js";
import { fetchPrices, fetchVolumes } from "./api.js";

const KEY = "evecp.all.v1";
const DEFAULTS = {
  rigTier: "none", runs: 10, cat: "All", sub: "All", search: "", onlyProfit: true,
  minOrders: 5, sort: "maxProfit", asc: false, limit: 200, volN: 600,
};
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
      r.it = it; r.rigNames = rg.names; r.orders = ordersOf(s, it.id);
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
      (!q || r.it.name.toLowerCase().includes(q)));
    const val = (r) => (a.sort === "name" ? r.it.name : a.sort === "sub" ? r.it.sub : r[a.sort] ?? -Infinity);
    list.sort((x, y) => {
      const p = val(x), q2 = val(y);
      const c = typeof p === "string" ? p.localeCompare(q2) : p - q2;
      return a.asc ? c : -c;
    });
    return list;
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
