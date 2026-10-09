// Network access: Fuzzwork market aggregates and public ESI endpoints (all CORS-enabled).

export const HUBS = [
  { id: "s:60003760", label: "Jita 4-4 (The Forge)", region: 10000002 },
  { id: "s:60008494", label: "Amarr VIII (Domain)", region: 10000043 },
  { id: "s:60011866", label: "Dodixie IX (Sinq Laison)", region: 10000032 },
  { id: "s:60004588", label: "Rens VI (Heimatar)", region: 10000030 },
  { id: "s:60005686", label: "Hek VIII (Metropolis)", region: 10000042 },
  { id: "r:10000002", label: "The Forge (whole region)", region: 10000002 },
  { id: "r:10000043", label: "Domain (whole region)", region: 10000043 },
];

const regionOf = (hub) => (HUBS.find((h) => h.id === hub) || {}).region || 10000002;

/** Returns { [typeId]: { buy:{...}, sell:{...} } } with numeric fields. */
export async function fetchPrices(hub, typeIds) {
  const [kind, id] = hub.split(":");
  const param = kind === "s" ? "station" : "region";
  const url = `https://market.fuzzwork.co.uk/aggregates/?${param}=${id}&types=${typeIds.join(",")}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fuzzwork ${r.status}`);
  const raw = await r.json();
  const conv = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, Number(x)]));
  const out = {};
  for (const [tid, v] of Object.entries(raw)) out[tid] = { buy: conv(v.buy), sell: conv(v.sell) };
  return out;
}

export async function fetchAdjusted() {
  const r = await fetch("https://esi.evetech.net/latest/markets/prices/");
  if (!r.ok) throw new Error(`ESI prices ${r.status}`);
  const out = {};
  for (const p of await r.json()) out[p.type_id] = p.adjusted_price || 0;
  return out;
}

export async function fetchCostIndices() {
  const r = await fetch("https://esi.evetech.net/latest/industry/systems/");
  if (!r.ok) throw new Error(`ESI indices ${r.status}`);
  const out = { manufacturing: {}, reaction: {} };
  for (const s of await r.json()) {
    for (const act of Object.keys(out)) {
      const m = s.cost_indices.find((c) => c.activity === act);
      out[act][s.solar_system_id] = m ? m.cost_index : 0;
    }
  }
  return out;
}

/**
 * Average daily traded volume over the last 7 calendar days, per type. ESI history omits days with no trades, so
 * the window is by date (not by the last 7 entries) and the total is divided by 7, otherwise a rarely traded item
 * would look like it trades every day.
 */
export async function fetchVolumes(hub, typeIds, onProgress) {
  const region = regionOf(hub);
  const out = {};
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < typeIds.length) {
      const id = typeIds[i++];
      try {
        const r = await fetch(`https://esi.evetech.net/latest/markets/${region}/history/?type_id=${id}`);
        if (r.ok) {
          const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
          const h = (await r.json()).filter((d) => d.date >= cutoff);
          out[id] = h.reduce((a, d) => a + d.volume, 0) / 7;
        }
      } catch {
        /* leave undefined */
      }
      if (onProgress) onProgress(++done, typeIds.length);
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));
  return out;
}
