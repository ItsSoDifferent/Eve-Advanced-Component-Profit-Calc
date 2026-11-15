// Reprocessing tab: scans the market for items that are worth more as reprocessed materials than as they are.
// Self-contained: reads shared settings through window.evecp and owns its own prices and filters.
// Data: data/reprocess.json (built by scripts/build_reprocess_data.py).
import { brokerFee, salesTax } from "./calc.js";
import { fetchPrices } from "./api.js";

const KEY = "evecp.reprocess.v1";
const DEFAULTS = {
  cat: "All", kind: "All", search: "", onlyProfit: true, completeOnly: true, minOrders: 3, minOutOrders: 5, minRoi: "",
  sort: "potential", asc: false, limit: 200,
};
// Where the reprocessing happens: rig size that fits, and the Upwell structure modifier "Sm" in the yield formula.
const LOC = {
  npc: { size: null, sm: 0 },
  athanor: { size: "M-Set", sm: 0.02 },
  tatara: { size: "L-Set", sm: 0.055 },
  citadelM: { size: "M-Set", sm: 0 },
  citadelL: { size: "L-Set", sm: 0 },
  citadelXL: { size: "XL-Set", sm: 0 },
};

export async function initReprocess(root, bridge) {
  const { fmtIsk, fmtShort } = bridge.fmt;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let a = { ...DEFAULTS };
  try { a = { ...a, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* ignore */ } };

  root.innerHTML = "<p class='muted'>Loading reprocessing data...</p>";
  const data = await fetch("data/reprocess.json").then((r) => r.json());
  const items = data.items;
  const cats = ["All", ...new Set(items.map((i) => i.cat))];
  const open = new Set();
  let prices = { in: {}, out: {}, ts: 0 };
  let busy = "";

  // ---------- yield ----------
  // Ore/ice/moon ore:  NPC  = base x skills x implant
  //                    Upwell = (50 + Rm) x (1 + Sec) x (1 + Sm) x skills x implant   (Sec only applies when a rig is fitted)
  // Everything else ("scrap"): base x (1 + 2% per Scrapmetal Processing level); no structure, rig or implant bonuses.
  function yieldFor(it, s, sec) {
    const loc = LOC[s.reprocLocation] || LOC.npc;
    if (it.kind === "scrap") {
      return (loc.size ? 0.5 : s.reprocBaseYield / 100) * (1 + 0.02 * (s.skills.scrapmetal || 0));
    }
    const cs = bridge.char?.skills;
    const op = cs ? cs[it.skill] || 0 : s.reprocOpLevel;
    const skills = (1 + 0.03 * s.skills.reprocessing) * (1 + 0.02 * s.skills.reprocessingEfficiency) * (1 + 0.02 * op) * (1 + s.reprocImplant / 100);
    if (!loc.size) return (s.reprocBaseYield / 100) * skills;
    const rm = Math.max(0, ...(s.reprocRigs || []).map((id) => {
      const r = rigs.find((x) => x.id === id);
      return r && r.size === loc.size && r.applies.includes(it.kind) ? r.rm : 0;
    }));
    const secMod = rm > 0 ? (sec >= 0.45 ? 0 : sec > 0 ? 0.06 : 0.12) : 0;
    return ((50 + rm) / 100) * (1 + secMod) * (1 + loc.sm) * skills;
  }
  let rigs = [];
  rigs = await fetch("data/reprocess-rigs.json").then((r) => r.json());

  // ---------- prices ----------
  const priceOf = (s, side, id) => {
    const b = prices[side][id];
    if (!b) return 0;
    const method = side === "in" ? s.inputMethod : s.outputMethod;
    const useSell = side === "in" ? method === "instant" : method === "order";
    const o = useSell ? b.sell : b.buy;
    const stat = s.priceStat === "best" ? (useSell ? "min" : "max") : s.priceStat;
    return o?.[stat] || 0;
  };
  const supplyOf = (id) => prices.in[id]?.sell?.volume || 0;
  const ordersOf = (id) => prices.in[id]?.sell?.orderCount || 0;
  // Orders behind an output's price on the side we trade (sell orders if we list, buy orders if we sell instantly).
  const outOrders = (s, id) => {
    const b = prices.out[id];
    return (s.outputMethod === "order" ? b?.sell : b?.buy)?.orderCount || 0;
  };

  // ---------- evaluation ----------
  function compute() {
    const s = bridge.s;
    const { sec } = bridge.system("reprocess");
    const adj = bridge.market.adj;
    const loc = LOC[s.reprocLocation] || LOC.npc;
    const tax = loc.size ? s.reprocTax / 100 : Math.max(0, 5 - 0.75 * s.reprocStanding) / 100;
    const inBroker = s.inputMethod === "order" ? brokerFee(s) : 0;
    const outFee = salesTax(s) + (s.outputMethod === "order" ? brokerFee(s) : 0);
    return items.map((it) => {
      const y = yieldFor(it, s, sec);
      const price = priceOf(s, "in", it.id);
      const cost = price * (1 + inBroker) * (1 + s.shipIn.collateral / 100) + it.vol * s.shipIn.perM3;
      let gross = 0, estimated = 0, outVol = 0, missing = 0;
      const lines = it.out.map(([id, q]) => {
        const n = (q / it.portion) * y; // units received per unit reprocessed
        const p = priceOf(s, "out", id);
        if (!(p > 0)) missing++;
        gross += n * p;
        estimated += n * (adj[id] || 0);
        outVol += n * (data.mats[id]?.[1] || 0);
        return { id, name: data.mats[id]?.[0] ?? id, n, p, value: n * p, orders: outOrders(s, id) };
      });
      // Thin output markets make the value unreliable: use the weakest market among outputs worth 5%+ of the total.
      const minOutOrders = Math.min(Infinity, ...lines.filter((l) => l.value >= gross * 0.05).map((l) => l.orders));
      const fees = gross * outFee;
      const shipOut = outVol * s.shipOut.perM3 + gross * (s.shipOut.collateral / 100);
      const taxCost = estimated * tax;
      const profit = gross - fees - shipOut - taxCost - cost;
      const supply = supplyOf(it.id);
      const units = supply * (s.inputCap / 100);
      return {
        it, y, price, cost, gross, fees, shipOut, taxCost, profit, lines, missing, units, supply, minOutOrders,
        roi: cost > 0 ? profit / cost : 0,
        perM3: it.vol > 0 ? profit / it.vol : 0,
        potential: cost > 0 && price > 0 ? profit * units : 0,
        capital: cost * units,
        orders: ordersOf(it.id),
        hasPrices: price > 0,
      };
    });
  }

  const COLS = [
    ["name", "Item", (r) => esc(r.it.name)],
    ["sub", "Group", (r) => esc(r.it.sub)],
    ["price", "Buy price", (r) => fmtIsk(r.price, 2)],
    ["y", "Yield", (r) => (r.y * 100).toFixed(1) + "%"],
    ["gross", "Output value", (r) => fmtIsk(r.gross, 2)],
    ["profit", "Profit / unit", (r) => fmtIsk(r.profit, 2)],
    ["roi", "ROI", (r) => (r.roi * 100).toFixed(1) + "%"],
    ["perM3", "Profit / m3", (r) => fmtShort(r.perM3)],
    ["orders", "Orders", (r) => r.orders],
    ["supply", "Supply", (r) => fmtIsk(r.supply)],
    ["potential", "Potential profit", (r) => fmtShort(r.potential)],
    ["capital", "Capital needed", (r) => fmtShort(r.capital)],
  ];

  function detail(r) {
    const row = (l, v, c = "") => `<tr><td>${l}</td><td class="${c}">${v}</td></tr>`;
    const lines = r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.n.toFixed(2)}</td><td>${l.p ? fmtIsk(l.p, 2) : "<span class='warn'>no price</span>"}</td><td>${l.orders}</td><td>${fmtIsk(l.value, 2)}</td></tr>`).join("");
    return `<div class="cols"><div><table><tr><th>Output (per unit)</th><th>Qty</th><th>Price</th><th>Orders</th><th>Value</th></tr>${lines}</table>
      <p class="muted">Reprocessed in batches of ${r.it.portion}; ${r.it.kind === "scrap" ? "scrap item (Scrapmetal Processing)" : esc(data.skillNames[r.it.skill] || "ore")}.</p></div>
      <div><table>
      ${row("Buy cost (incl. fees, shipping)", fmtIsk(r.cost, 2))}${row("Output value", fmtIsk(r.gross, 2))}
      ${row("Sales tax + broker", "-" + fmtIsk(r.fees, 2))}${row("Reprocessing tax", "-" + fmtIsk(r.taxCost, 2))}
      ${row("Shipping out", "-" + fmtIsk(r.shipOut, 2))}
      ${row("<b>Profit per unit</b>", "<b>" + fmtIsk(r.profit, 2) + "</b>", r.profit > 0 ? "good" : "bad")}
      ${row("Units you could buy", fmtIsk(r.units))}${row("Volume per unit (m3)", r.it.vol)}
      </table></div></div>`;
  }

  function filtered(rows) {
    const q = a.search.toLowerCase();
    const list = rows.filter((r) =>
      r.hasPrices && (a.cat === "All" || r.it.cat === a.cat) && (a.kind === "All" || r.it.kind === a.kind) &&
      (!a.onlyProfit || r.profit > 0) && (!a.completeOnly || r.missing === 0) && r.orders >= a.minOrders && r.minOutOrders >= a.minOutOrders &&
      (a.minRoi === "" || r.roi * 100 >= a.minRoi) && (!q || r.it.name.toLowerCase().includes(q)));
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
    const keep = document.activeElement?.dataset?.p;
    const s = bridge.s;
    const rows = compute();
    const list = filtered(rows);
    const head = COLS.map(([k, l]) => `<th data-sort="${k}" class="${a.sort === k ? "sorted" + (a.asc ? " asc" : "") : ""}">${l}</th>`).join("");
    const body = list.slice(0, a.limit).map((r) => {
      const cls = r.profit > 0 ? "good" : "bad";
      const cells = COLS.map(([k, , f]) => `<td${["profit", "roi", "perM3", "potential"].includes(k) ? ` class="${cls}"` : ""}>${f(r)}</td>`).join("");
      return `<tr class="row" data-id="${r.it.id}">${cells}</tr>${open.has(r.it.id) ? `<tr class="detail"><td colspan="${COLS.length}">${detail(r)}</td></tr>` : ""}`;
    }).join("");
    const opt = (arr, cur) => arr.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
    const top = list.filter((r) => r.potential > 0).slice(0, 5);
    const loc = LOC[s.reprocLocation] || LOC.npc;
    const sample = rows.find((r) => r.it.kind === "ore") || rows[0];
    root.innerHTML = `
      <div class="intro"><b>Reprocessing.</b> Items worth more as reprocessed materials than they cost to buy (${items.length} reprocessable items).
        Buy at your buy hub, sell the outputs at your sell hub, using the Reprocessing settings (skills, location, rigs, tax) and the shared
        market, fee and shipping settings. Ore, ice and moon-ore yield uses your actual per-ore skills when you are logged in.
        <span class="muted">Current yield for ${esc(sample.it.name)}: ${(sample.y * 100).toFixed(1)}% (${loc.size ? "Upwell structure" : "NPC station"}).
        ${prices.ts ? "Prices loaded " + new Date(prices.ts).toLocaleTimeString() : "No prices loaded yet."}</span></div>
      ${top.length ? `<div class="planbox"><h3>Best opportunities (profit if you buy ${s.inputCap}% of the listed supply)</h3><table><tr><th>Item</th><th>Profit / unit</th><th>ROI</th><th>Units</th><th>Capital</th><th>Potential profit</th></tr>${top.map((r) => `<tr><td>${esc(r.it.name)}</td><td>${fmtIsk(r.profit, 2)}</td><td>${(r.roi * 100).toFixed(1)}%</td><td>${fmtIsk(r.units)}</td><td>${fmtShort(r.capital)}</td><td class="good">${fmtShort(r.potential)}</td></tr>`).join("")}</table></div>` : ""}
      <div class="bar">
        <button id="p-load" class="primary" ${busy ? "disabled" : ""}>Load market data</button>
        <span class="muted">${esc(busy)}</span>
      </div>
      <div class="bar">
        <label>Category <select data-p="cat">${opt(cats, a.cat)}</select></label>
        <label>Type <select data-p="kind">${opt(["All", "scrap", "ore", "ice", "moon"], a.kind)}</select></label>
        <label title="Blank = no limit">Min ROI (%) <input type="number" data-p="minRoi" value="${a.minRoi}"></label>
        <label title="Sell orders behind the item you buy">Min orders <input type="number" data-p="minOrders" min="0" value="${a.minOrders}"></label>
        <label title="Orders behind your weakest valuable output (outputs worth 5%+ of the total)">Min output orders <input type="number" data-p="minOutOrders" min="0" value="${a.minOutOrders}"></label>
        <label><input type="checkbox" data-p="onlyProfit" ${a.onlyProfit ? "checked" : ""}> profitable only</label>
        <label title="Hide items where some output has no price at your sell hub"><input type="checkbox" data-p="completeOnly" ${a.completeOnly ? "checked" : ""}> all outputs priced</label>
        <input type="search" data-p="search" placeholder="Filter by name" value="${esc(a.search)}">
        <span class="muted">${list.length} of ${rows.filter((r) => r.hasPrices).length} priced items (showing ${Math.min(list.length, a.limit)})</span>
      </div>
      <div class="tablewrap"><table id="p-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${list.length > a.limit ? `<p><button id="p-more">Show ${Math.min(200, list.length - a.limit)} more</button></p>` : ""}
      <p class="muted notes">Yield formulas: ore, ice and moon ore are base x (1 + 3% x Reprocessing) x (1 + 2% x Efficiency) x (1 + 2% x ore skill) x (1 + implant),
        with the Upwell base being (50 + rig) x (1 + security bonus) x (1 + structure bonus); other items use base x (1 + 2% x Scrapmetal Processing).
        Reprocessing tax is charged on the estimated (adjusted-price) value of the outputs. Supply is the number of units on sell orders at your buy hub;
        potential profit assumes you buy the share of it set by "Max share of input supply". Large purchases move prices, so check the book before buying.
        Quantities are reprocessed in whole stacks in game, so tiny profits per unit only matter for large stacks.</p>`;
    if (keep) {
      const el = root.querySelector(`[data-p="${keep}"]`);
      if (el) { el.focus(); if (el.type === "search") el.setSelectionRange(1e6, 1e6); }
    }
  }

  async function loadPrices() {
    busy = "Loading prices...";
    render();
    try {
      await bridge.refreshShared(); // adjusted prices (for the reprocessing tax) come from the main tab's refresh
      const s = bridge.s;
      const inIds = items.map((i) => i.id);
      const outIds = Object.keys(data.mats).map(Number);
      const chunk = (ids) => Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => ids.slice(i * 300, i * 300 + 300));
      // Be gentle with the community price service: a few requests at a time.
      const get = async (hub, ids) => {
        const parts = chunk(ids);
        const out = {};
        for (let i = 0; i < parts.length; i += 4) {
          Object.assign(out, ...(await Promise.all(parts.slice(i, i + 4).map((c) => fetchPrices(hub, c)))));
          busy = `Loading prices... ${Math.min(parts.length, i + 4)}/${parts.length}`;
          const el = root.querySelector(".bar .muted");
          if (el) el.textContent = busy;
        }
        return out;
      };
      if (s.inHub === s.outHub) {
        const p = await get(s.inHub, [...new Set([...inIds, ...outIds])]);
        prices = { in: p, out: p, ts: Date.now() };
      } else {
        const [pi, po] = [await get(s.inHub, inIds), await get(s.outHub, outIds)];
        prices = { in: pi, out: po, ts: Date.now() };
      }
      busy = "";
    } catch (e) {
      busy = "Error: " + e.message;
    }
    render();
  }

  root.addEventListener("click", (e) => {
    if (e.target.id === "p-load") return loadPrices();
    if (e.target.id === "p-more") { a.limit += 200; save(); return render(); }
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
    const k = e.target.dataset.p;
    if (!k) return;
    const t = e.target;
    a[k] = t.type === "checkbox" ? t.checked : t.type === "number" ? (t.value === "" ? "" : Number(t.value)) : t.value;
    a.limit = DEFAULTS.limit;
    save(); render();
  });
  document.addEventListener("evecp:change", render);
  render();
}
