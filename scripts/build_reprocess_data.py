"""Build data/reprocess.json: every published, market-listed item that can be reprocessed, with its reprocessing outputs.

Usage: python -I scripts/build_reprocess_data.py <dir with extracted reference-data> [out_dir]
"""
import json, sys, os

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "data")

def load(name):
    with open(os.path.join(src, name), encoding="utf-8") as f:
        return json.load(f)

types, mg = load("types.json"), load("market_groups.json")
vol = lambda t: t.get("packaged_volume", t.get("volume", 0))

def chain(g):
    names = []
    while g and str(g) in mg:
        names.append(mg[str(g)]["name"]["en"])
        g = mg[str(g)].get("parent_group_id")
    return names[::-1]

# Items with a reprocessingSkillType attribute (790) are ore, ice or moon ore; everything else is "scrap" and only
# Scrapmetal Processing applies to it.
ICE = {18025}
MOON = {46152, 46153, 46154, 46155, 46156}

items, mats = [], {}
for tid, t in types.items():
    tm = t.get("type_materials")
    if not tm or not t.get("published") or not t.get("market_group_id"):
        continue
    skill = int((t.get("dogma_attributes", {}).get("790") or {}).get("value") or 0)
    kind = "ice" if skill in ICE else "moon" if skill in MOON else "ore" if skill else "scrap"
    path = chain(t["market_group_id"])
    outs = []
    for m in tm.values():
        mid = m["material_type_id"]
        mt = types.get(str(mid))
        if not mt:
            continue
        mats[str(mid)] = [mt["name"]["en"], vol(mt)]
        outs.append([mid, m["quantity"]])
    if not outs:
        continue
    items.append({
        "id": int(tid), "name": t["name"]["en"], "cat": path[0], "sub": path[1] if len(path) > 1 else path[0],
        "portion": t.get("portion_size", 1), "vol": vol(t), "skill": skill, "kind": kind, "out": outs,
    })

# Reprocessing rigs: rm is the rig modifier in the Upwell yield formula (+1 for T1, +3 for T2).
rigs = []
for tid, t in types.items():
    n = t["name"]["en"]
    if not n.startswith("Standup") or "Blueprint" in n or not ("Grading Processor" in n or "Reprocessing Monitor" in n):
        continue
    mult = t["dogma_attributes"]["717"]["value"]  # refiningYieldMultiplier: 0.51 (T1) / 0.53 (T2)
    applies = ["ore"] if "Asteroid" in n else ["ice"] if "Ice" in n else ["moon"] if "Moon" in n else ["ore", "ice", "moon"]
    rigs.append({"id": int(tid), "name": n, "rm": round((mult - 0.5) * 100, 3), "applies": applies,
                 "size": n.split()[1]})
rigs.sort(key=lambda r: r["name"])

items.sort(key=lambda x: (x["cat"], x["sub"], x["name"]))
skills = {str(s): types[str(s)]["name"]["en"] for s in {i["skill"] for i in items if i["skill"]}}
doc = {"items": items, "mats": mats, "rigs": rigs, "skillNames": skills}
with open(os.path.join(out, "reprocess-rigs.json"), "w", encoding="utf-8") as f:
    json.dump(rigs, f, separators=(",", ":"))
path = os.path.join(out, "reprocess.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(doc, f, separators=(",", ":"))
print(len(items), "items,", len(mats), "outputs,", len(rigs), "rigs,", os.path.getsize(path) // 1024, "KB")
