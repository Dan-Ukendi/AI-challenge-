"""Build app/index.html from the local challenge outputs (stdlib only).

Parameters (the team's interpretation choices): config.json. Resident actions and their sources: actions.json.
Run:   py -3.13 build_app.py
Serve: py -3.13 -m http.server 8000 --directory app   ->  http://localhost:8000
"""
import csv
import json
import re
import sqlite3
import struct
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "app"
CFG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
ACTIONS = json.loads((HERE / "actions.json").read_text(encoding="utf-8"))
COUNTRIES = ("be", "de", "nl")


def read_csv(name):
    with open(HERE / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def read_classes(name):
    """classes_taille_*.csv has two 'surface_ha' columns (class label, then area): rename the first."""
    with open(HERE / name, encoding="utf-8", newline="") as f:
        rows = list(csv.reader(f))
    head = ["classe"] + rows[0][1:]
    return [dict(zip(head, r)) for r in rows[1:]]


def wkb_coords(blob):
    """Decode a GeoPackage geometry blob (Point or Polygon) to coordinates."""
    flags = blob[3]
    env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    wkb = blob[8 + env:]
    end = "<" if wkb[0] == 1 else ">"
    gtype = struct.unpack(end + "I", wkb[1:5])[0] % 1000
    if gtype == 1:
        return "Point", list(struct.unpack(end + "2d", wkb[5:21]))
    if gtype == 3:
        n_rings = struct.unpack(end + "I", wkb[5:9])[0]
        pos, rings = 9, []
        for _ in range(n_rings):
            n = struct.unpack(end + "I", wkb[pos:pos + 4])[0]
            pos += 4
            pts = struct.unpack(end + f"{2 * n}d", wkb[pos:pos + 16 * n])
            pos += 16 * n
            rings.append([[pts[i], pts[i + 1]] for i in range(0, 2 * n, 2)])
        return "Polygon", rings
    raise ValueError(f"unsupported geometry type {gtype}")


def read_gpkg(name):
    con = sqlite3.connect(HERE / name)
    table = con.execute("select table_name from gpkg_contents").fetchone()[0]
    cur = con.execute(f'select * from "{table}"')
    cols = [d[0] for d in cur.description]
    feats = []
    for row in cur:
        rec = dict(zip(cols, row))
        gtype, coords = wkb_coords(rec.pop("geom"))
        feats.append({"type": "Feature", "properties": rec,
                      "geometry": {"type": gtype, "coordinates": coords}})
    return {"type": "FeatureCollection", "features": feats}


def inventory():
    """Count EMS files and features per country and layer type."""
    rows = read_csv("inventaire_ems.csv")
    files, feats = Counter(), Counter()
    for r in rows:
        m = re.search(r"_([A-Za-z]+[ALP])_r\d+_v\d+", r["fichier"])
        key = (r["pays"].upper(), m.group(1) if m else "other")
        files[key] += 1
        feats[key] += int(r["n_entites"] or 0)
    return [{"country": c, "layer": l, "files": files[(c, l)], "features": feats[(c, l)]}
            for c, l in sorted(files)]


def load_buildings(cc):
    """Building points only: footprint area is dropped on purpose (choice C2: count buildings, do not measure them)."""
    bats = read_gpkg(f"bats_eau_{cc}.gpkg")
    for f in bats["features"]:
        for k in ("area", "perimeter", "shapefactor"):
            f["properties"].pop(k, None)
    by_adm = defaultdict(lambda: [0, 0])
    for f in bats["features"]:
        p = f["properties"]
        by_adm[p["adm1"]][0] += 1
        by_adm[p["adm1"]][1] += int(bool(p.get("in_flood")))
    summary = {"count": len(bats["features"]),
               "inside": sum(v[1] for v in by_adm.values()),
               "by_adm1": [{"adm1": k, "count": v[0], "inside": v[1]} for k, v in by_adm.items()]}
    return bats, summary


def load_country(cc):
    """Load whichever outputs exist for one country; None if none do."""
    out = {}
    if (HERE / f"stats_aoi_{cc}.csv").exists():
        out["flood_aoi"] = read_csv(f"stats_aoi_{cc}.csv")
    if (HERE / f"classes_taille_{cc}.csv").exists():
        out["size_classes"] = read_classes(f"classes_taille_{cc}.csv")
    if (HERE / f"bats_eau_{cc}.gpkg").exists():
        out["buildings"], out["buildings_summary"] = load_buildings(cc)
    if (HERE / f"water_{cc}.json").exists():  # made by prepare_water.py
        out["water"] = json.loads((HERE / f"water_{cc}.json").read_text())
    if (HERE / f"pop_{cc}.json").exists():  # made by prepare_pop.py
        out["pop"] = json.loads((HERE / f"pop_{cc}.json").read_text())
    if (HERE / f"lau_{cc}.json").exists():  # made by prepare_lau.py (Eurostat GISCO LAU boundaries)
        out["lau"] = json.loads((HERE / f"lau_{cc}.json").read_text(encoding="utf-8"))
    if (HERE / f"osm_poi_{cc}.json").exists() and (HERE / f"osm_summary_{cc}.json").exists():  # made by prepare_osm.py (OpenStreetMap, ODbL)
        out["osm"] = {"poi": json.loads((HERE / f"osm_poi_{cc}.json").read_text(encoding="utf-8")),
                      "summary": json.loads((HERE / f"osm_summary_{cc}.json").read_text(encoding="utf-8"))}
    # my_results.gpkg is the Belgian area of interest (EMSR518, Liege) from the starter notebook
    if cc == "be" and (HERE / "my_results.gpkg").exists():
        out["aoi"] = read_gpkg("my_results.gpkg")
    return out or None


# --- Response tiers (choices G1-G3, E2-E3, B3): rule on rate AND absolute number, thresholds are percentiles ---
def percentile(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, int(round(q / 100 * (len(v) - 1))))]


def assign_tiers(countries):
    """Set per1000 and tier on every commune; return the thresholds used (computed on all flooded communes)."""
    props = [f["properties"] for c in countries.values() if c and "lau" in c for f in c["lau"]["features"]]
    for p in props:
        p["per1000"] = 1000 * p["pop_exposed"] / p["pop_total"] if p.get("pop_total") else 0
    flooded = [p for p in props if p["pop_exposed"] > 0 and p.get("pop_total")]
    q = CFG["tier_percentiles"]
    th = {"rate_high": percentile([p["per1000"] for p in flooded], q["high"]),
          "rate_medium": percentile([p["per1000"] for p in flooded], q["medium"]),
          "abs_high": percentile([p["pop_exposed"] for p in flooded], q["high"]),
          "abs_medium": percentile([p["pop_exposed"] for p in flooded], q["medium"]),
          "hazard": CFG["hazard_known_pct"], "coverage": CFG["nodata_coverage_pct"],
          "p_high": q["high"], "p_medium": q["medium"], "n_flooded": len(flooded)}
    for p in props:
        if p["per1000"] >= th["rate_high"] or p["pop_exposed"] >= th["abs_high"]:
            t = "1B" if (p["hazard_share_100"] or 0) >= th["hazard"] else "1A"
        elif p["per1000"] >= th["rate_medium"] or p["pop_exposed"] >= th["abs_medium"]:
            t = "2"
        else:
            t = "3"
        if t == "3" and p["coverage_pct"] < th["coverage"]:
            t = "ND"  # low exposure measured, but most of the commune was never mapped: unknown, not safe
        p["tier"] = t
    return th


def main():
    countries = {cc: load_country(cc) for cc in COUNTRIES}
    th = assign_tiers(countries)
    # per-commune site summaries for the plain-language tabs (made by prepare_regions.py; Belgium only for now)
    regions = {cc: json.loads((HERE / f"regions_{cc}.json").read_text(encoding="utf-8")) for cc in COUNTRIES if (HERE / f"regions_{cc}.json").exists()}
    sites = {cc: json.loads((HERE / f"sites_{cc}.json").read_text(encoding="utf-8")) for cc in COUNTRIES if (HERE / f"sites_{cc}.json").exists()}
    # modelled river-flood exposure of every commune (made by prepare_hazard.py)
    hazard = {cc: json.loads((HERE / f"hazard_{cc}.json").read_text(encoding="utf-8")) for cc in COUNTRIES if (HERE / f"hazard_{cc}.json").exists()}
    data = {"inventory": inventory(), "tiers": ACTIONS["tiers"], "actions": ACTIONS["actions"], "sources": ACTIONS["sources"],
            "rules": th, "cfg": CFG, "countries": countries, "regions": regions, "sites": sites, "hazard": hazard}
    OUT.mkdir(exist_ok=True)
    html = (HERE / "app_template.html").read_text(encoding="utf-8")
    html = html.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False))
    (OUT / "index.html").write_text(html, encoding="utf-8")
    for cc, c in countries.items():
        n = len(c["buildings"]["features"]) if c and "buildings" in c else 0
        tiers = Counter(f["properties"]["tier"] for f in c["lau"]["features"]) if c and "lau" in c else {}
        print(f"{cc}: {'loaded' if c else 'no outputs found'}, {n} buildings, communes by tier {dict(sorted(tiers.items()))}")
    print("thresholds:", {k: (round(v, 1) if isinstance(v, float) else v) for k, v in th.items()})
    print(f"wrote {OUT / 'index.html'}")


if __name__ == "__main__":
    main()
