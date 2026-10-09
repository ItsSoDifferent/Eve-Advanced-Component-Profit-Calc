"""Build data/components.json, data/rigs.json and data/systems.json from the EVE Ref reference data dump.

Usage: python -I scripts/build_data.py <dir with extracted reference-data-latest.tar.xz> [out_dir]
Source: https://data.everef.net/reference-data/reference-data-latest.tar.xz
"""
import json, sys, os

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(out, exist_ok=True)

def load(name):
    with open(os.path.join(src, name), encoding="utf-8") as f:
        return json.load(f)

types = load("types.json")
bps = load("blueprints.json")
mgroups = load("market_groups.json")
systems = load("solar_systems.json")
regions = load("regions.json")

ROOT = "65"  # Advanced Components
subs = [g for g in mgroups.values() if str(g.get("parent_group_id")) == ROOT]
tname = lambda tid: types[str(tid)]["name"]["en"]

components, rig_ids = [], set()
for sg in sorted(subs, key=lambda g: g["name"]["en"]):
    for tid in sg.get("type_ids", []):
        t = types[str(tid)]
        bp_id = next((int(k) for k, v in t.get("produced_by_blueprints", {}).items()
                      if v["blueprint_activity"] == "manufacturing"), None)
        if bp_id is None:
            continue
        m = bps[str(bp_id)]["activities"]["manufacturing"]
        mats = []
        for mid, mat in m["materials"].items():
            mt = types[mid]
            mats.append({"id": int(mid), "name": mt["name"]["en"], "qty": mat["quantity"],
                         "volume": mt.get("packaged_volume", mt.get("volume", 0))})
        for r in t.get("engineering_rig_source_type_ids", {}).get("manufacturing", []):
            rig_ids.add(r)
        components.append({
            "id": tid, "name": t["name"]["en"], "group": sg["name"]["en"],
            "volume": t.get("packaged_volume", t.get("volume", 0)),
            "blueprint": bp_id, "blueprintName": tname(bp_id),
            "perRun": m["products"][str(tid)]["quantity"],
            "time": m["time"],
            "skills": [{"id": int(k), "level": v} for k, v in (m.get("required_skills") or {}).items()],
            "materials": mats,
        })

# every skill name referenced
skill_ids = {s["id"] for c in components for s in c["skills"]}
skills = {str(i): tname(i) for i in skill_ids}

rigs = []
for r in sorted(rig_ids):
    t = types[str(r)]
    a = {k: v["value"] for k, v in t["dogma_attributes"].items()}
    rigs.append({"id": r, "name": t["name"]["en"],
                 "mat": a.get("2594", 0), "time": a.get("2593", 0)})

sys_out = []
for s in systems.values():
    sec = s.get("security_status", 0)
    sys_out.append([s["solar_system_id"], s["name"]["en"] if isinstance(s["name"], dict) else s["name"],
                    round(sec, 2)])
sys_out.sort(key=lambda x: x[1])

def dump(name, obj):
    with open(os.path.join(out, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(name, os.path.getsize(os.path.join(out, name)))

dump("components.json", {"components": components, "skills": skills})
dump("rigs.json", rigs)
dump("systems.json", sys_out)
print(len(components), "components,", len(rigs), "rigs,", len(sys_out), "systems")
