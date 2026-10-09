"""Build data/all.json: every product that can be manufactured from a BPO sold on the market.

Usage: python -I scripts/build_all_data.py <dir with extracted reference-data> [out_dir]
"""
import json, sys, os

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "data")

def load(name):
    with open(os.path.join(src, name), encoding="utf-8") as f:
        return json.load(f)

types, bps, mg = load("types.json"), load("blueprints.json"), load("market_groups.json")
en = lambda tid: types[str(tid)]["name"]["en"]
vol = lambda t: t.get("packaged_volume", t.get("volume", 0))

def chain(g):
    """Market group names from the top-level group down to g."""
    names = []
    while g and str(g) in mg:
        names.append(mg[str(g)]["name"]["en"])
        g = mg[str(g)].get("parent_group_id")
    return names[::-1]

rig_sets, rig_set_ix, rig_ids = [], {}, set()
items, mats = [], {}
for bid, bp in bps.items():
    m = bp["activities"].get("manufacturing")
    if not m or not m.get("products") or not m.get("materials"):
        continue
    bt = types.get(bid)
    # Only blueprints that exist as BPOs on the market (excludes invention/T2 and other BPC-only blueprints).
    if not bt or not bt.get("published") or not bt.get("market_group_id"):
        continue
    pid = next(iter(m["products"]))
    p = types.get(pid)
    if not p or not p.get("published") or not p.get("market_group_id"):
        continue
    # Faction, limited-time, officer and T2 items have blueprints in the SDE that players can't buy as BPOs.
    if p.get("meta_group_id") not in (None, 1, 54):
        continue
    path = chain(p["market_group_id"])
    rs = tuple(sorted(p.get("engineering_rig_source_type_ids", {}).get("manufacturing", [])))
    if rs not in rig_set_ix:
        rig_set_ix[rs] = len(rig_sets)
        rig_sets.append(list(rs))
        rig_ids.update(rs)
    for mid, mat in m["materials"].items():
        mt = types[mid]
        mats[mid] = [mt["name"]["en"], vol(mt)]
    items.append({
        "id": int(pid), "name": p["name"]["en"], "cat": path[0], "sub": path[1] if len(path) > 1 else path[0],
        "bp": int(bid), "perRun": m["products"][pid]["quantity"], "time": m["time"], "volume": vol(p),
        "mats": [[int(k), v["quantity"]] for k, v in m["materials"].items()],
        "rigSet": rig_set_ix[rs],
        "skills": [[int(k), v] for k, v in (m.get("required_skills") or {}).items()],
    })

rigs = {}
for r in sorted(rig_ids):
    a = {k: v["value"] for k, v in types[str(r)]["dogma_attributes"].items()}
    rigs[r] = [en(r), a.get("2594", 0), a.get("2593", 0)]

items.sort(key=lambda x: (x["cat"], x["sub"], x["name"]))
skill_names = {str(s[0]): en(s[0]) for it in items for s in it["skills"]}
doc = {"items": items, "mats": mats, "rigs": rigs, "rigSets": rig_sets, "skillNames": skill_names}
path = os.path.join(out, "all.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(doc, f, separators=(",", ":"))
print(len(items), "items,", len(mats), "materials,", len(rigs), "rigs,", os.path.getsize(path) // 1024, "KB")
