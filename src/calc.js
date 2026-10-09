// Pure calculation logic. No DOM, no network.

export const STRUCTURES = {
  station: { label: "NPC station", me: 1, time: 1, cost: 1 },
  raitaru: { label: "Raitaru", me: 0.99, time: 0.85, cost: 0.97 },
  azbel: { label: "Azbel", me: 0.99, time: 0.8, cost: 0.96 },
  sotiyo: { label: "Sotiyo", me: 0.99, time: 0.7, cost: 0.95 },
};

export const secClass = (sec) => (sec >= 0.45 ? "high" : sec > 0 ? "low" : "null");
export const RIG_SEC_MULT = { high: 1.0, low: 1.9, null: 2.1 };

const blank = (v) => v === "" || v == null;

export function salesTax(s) {
  if (!blank(s.salesTaxOverride)) return s.salesTaxOverride / 100;
  return (s.baseSalesTax / 100) * (1 - 0.11 * s.skills.accounting);
}

export function brokerFee(s) {
  if (!blank(s.brokerFeeOverride)) return s.brokerFeeOverride / 100;
  const pct = 3 - 0.3 * s.skills.brokerRelations - 0.03 * s.standings.faction - 0.02 * s.standings.corp;
  return Math.max(1, pct) / 100;
}

// Combined multipliers for a build setup.
export function buildMods(s, rigs, sysSec) {
  const st = STRUCTURES[s.structure];
  const secMult = RIG_SEC_MULT[secClass(sysSec)];
  let rigMat = 1;
  let rigTime = 1;
  if (s.structure !== "station") {
    for (const id of s.rigs) {
      const r = rigs.find((x) => x.id === id);
      if (!r) continue;
      rigMat *= 1 + (r.mat / 100) * secMult;
      rigTime *= 1 + (r.time / 100) * secMult;
    }
  }
  const skillTime = (1 - 0.04 * s.skills.industry) * (1 - 0.03 * s.skills.advancedIndustry);
  return { structMat: st.me, structTime: st.time, structCost: st.cost, rigMat, rigTime, skillTime };
}

// Materials needed for one job of `runs` runs.
export function jobMaterials(comp, me, runs, mods) {
  const mult = (1 - me / 100) * mods.structMat * mods.rigMat;
  return comp.materials.map((m) => {
    const raw = Math.round(m.qty * runs * mult * 100) / 100; // game rounds to 2dp before ceil
    return { ...m, need: Math.max(runs, Math.ceil(raw)) };
  });
}

export function jobSeconds(comp, te, runs, mods) {
  return Math.ceil(comp.time * runs * (1 - te / 100) * mods.skillTime * mods.structTime * mods.rigTime);
}

/**
 * Evaluate one product.
 * ctx: { s, mods, sci, adj (typeId->adjusted price), inPrice(typeId), outPrice(typeId) }
 */
export function evaluate(comp, bp, ctx) {
  const { s, mods } = ctx;
  const runs = s.runs;
  const mats = jobMaterials(comp, bp.me, runs, mods);

  // Job installation cost, based on estimated item value (ME 0 quantities).
  const eiv = comp.materials.reduce((a, m) => a + m.qty * runs * (ctx.adj[m.id] || 0), 0);
  const sysCost = eiv * ctx.sci * mods.structCost;
  const facility = eiv * (s.facilityTax / 100);
  const scc = eiv * (s.sccSurcharge / 100);
  const installCost = sysCost + facility + scc;

  // Inputs
  const inBroker = s.inputMethod === "order" ? brokerFee(s) : 0;
  let matCost = 0;
  let inVol = 0;
  const lines = mats.map((m) => {
    const price = ctx.inPrice(m.id);
    const cost = m.need * price * (1 + inBroker);
    matCost += cost;
    inVol += m.need * m.volume;
    return { ...m, price, cost };
  });
  const shipIn = inVol * s.shipIn.perM3 + matCost * (s.shipIn.collateral / 100);

  // Outputs
  const units = comp.perRun * runs;
  const outPrice = ctx.outPrice(comp.id);
  const gross = units * outPrice;
  const sellBroker = s.outputMethod === "order" ? brokerFee(s) : 0;
  const fees = gross * (salesTax(s) + sellBroker);
  const shipOut = units * comp.volume * s.shipOut.perM3 + gross * (s.shipOut.collateral / 100);

  const totalCost = matCost + shipIn + installCost + shipOut + fees;
  const profit = gross - totalCost;
  const seconds = jobSeconds(comp, bp.te, runs, mods);
  const hours = seconds / 3600;
  const perHour = profit / hours;
  const weeklyPerSlot = perHour * 24 * 7;
  return {
    comp, bp, runs, units, lines, eiv, sci: ctx.sci, sysCost, facility, scc, installCost,
    matCost, shipIn, shipOut, gross, fees, outPrice, totalCost, profit,
    margin: gross ? profit / gross : 0,
    roi: totalCost ? profit / totalCost : 0,
    seconds, perHour, weeklyPerSlot,
    unitsPerWeekPerSlot: (units / hours) * 24 * 7,
    weeklyTotal: weeklyPerSlot * s.slots,
    costPerUnit: totalCost / units,
  };
}

export const fmtIsk = (n, d = 0) =>
  isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "-";

export const fmtShort = (n) => {
  if (!isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
};

export const fmtTime = (sec) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (d ? d + "d " : "") + (h || d ? h + "h " : "") + m + "m";
};
