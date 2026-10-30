"""OpenStreetMap points of interest inside the mapped areas (AOI), with their position relative to the observed flood.

Source: a Geofabrik country extract (no live server, nothing sent anywhere). By default the 2021-01-01 snapshot, i.e. the
state of OSM about six months BEFORE the July 2021 flood; set "osm_snapshot" to "latest" in config.json for the current state.
The extract is downloaded once into ext/osm_pbf/ (md5-checked) and read locally with pyosmium.
Needs: gcsfs pyogrio geopandas shapely pyosmium
Run:   python pipeline/prepare_osm.py be         (then nl, de; the extracts are 0.4 / 1.1 / 3.5 GB for the 2021 snapshot)
Writes data/osm/osm_poi_<cc>.json (points) and data/osm/osm_summary_<cc>.json (counts); read by src/build_app.py.
Data: (c) OpenStreetMap contributors, ODbL. Incomplete by nature: see the limits printed at the end.
"""
import csv
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

os.environ["GS_NO_SIGN_REQUEST"] = "YES"
import geopandas as gpd
import osmium
import pandas as pd
import shapely
import shapely.wkb

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
GDAL_PREFIX = "/vsigs/"
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
NEAR_M = CFG.get("poi_near_m", 100)
SNAPSHOT = CFG.get("osm_snapshot", "210101")  # "latest" or YYMMDD (Geofabrik keeps 1 January snapshots)
# Geofabrik extracts per country. Only the regions that contain the mapped areas are used (far smaller than the whole country):
# DE: the EMS areas of interest lie in North Rhine-Westphalia, Rhineland-Palatinate and (one commune) Saarland; NL: Limburg.
EXTRACTS = {"be": ["belgium"], "nl": ["netherlands/limburg"],
            "de": ["germany/nordrhein-westfalen", "germany/rheinland-pfalz", "germany/saarland"]}
# untrusted download: its own folder. OSM_PBF_DIR lets you keep the big files outside a synced folder (e.g. OneDrive)
PBF_DIR = Path(os.environ.get("OSM_PBF_DIR") or ROOT / "ext" / "osm_pbf")

# ---- EDITABLE: categories and OSM tags. A rule is (key, [values]) or (key, [values], {extra_key: required_value}).
CATEGORIES = {
    "vulnerable": {"label": "Vulnerable sites", "rules": [
        ("amenity", ["hospital", "clinic", "nursing_home", "school", "kindergarten", "prison"]),
        ("social_facility", ["nursing_home", "assisted_living"])]},
    "infrastructure": {"label": "Critical infrastructure", "rules": [
        ("power", ["substation"]),
        ("man_made", ["water_works", "wastewater_plant", "pumping_station"]),
        ("amenity", ["fire_station", "police"]),
        ("man_made", ["mast", "tower"], {"tower:type": "communication"})]},
    "hazard": {"label": "Hazard sources", "rules": [
        ("amenity", ["fuel"]),
        ("landuse", ["industrial", "landfill"]),
        ("man_made", ["works"]),
        ("waterway", ["dam"])]},
    # shelter tags come from "shelter_tags" in config.json: a plain list of "key=value" texts, easy to edit
    "shelter": {"label": "Possible shelters", "rules": []},
}


def rules_from_tags(tags):
    """["leisure=sports_hall", "leisure=sports_centre", "amenity=townhall"] -> [("leisure", [...]), ("amenity", [...])]"""
    by_key = {}
    for t in tags:
        k, v = t.split("=", 1)
        by_key.setdefault(k.strip(), []).append(v.strip())
    return list(by_key.items())


CATEGORIES["shelter"]["rules"] = rules_from_tags(CFG.get("shelter_tags", [
    "leisure=sports_hall", "leisure=sports_centre", "amenity=community_centre", "amenity=townhall"]))
POSITIONS = ["in water", f"within {NEAR_M} m", "outside"]


def tag_pairs():
    """All (key, value) pairs of the rules: lets pyosmium discard everything else while reading."""
    return sorted({(key, v) for cat in CATEGORIES.values() for key, values, *_ in cat["rules"] for v in values})


def wanted_keys():
    keys = {"name"}
    for cat in CATEGORIES.values():
        for key, _, *extra in cat["rules"]:
            keys.add(key)
            keys.update(extra[0] if extra else {})
    return sorted(keys)


def classify(row):
    """First matching (categorie, type, tag) for an OSM row, or None. Missing tag columns are simply not matches."""
    for cat_id, cat in CATEGORIES.items():
        for key, values, *extra in cat["rules"]:
            v = row.get(key)
            if isinstance(v, str) and v in values and all(row.get(k) == want for k, want in (extra[0] if extra else {}).items()):
                return cat_id, v, f"{key}={v}"
    return None


def snapshot_date():
    if SNAPSHOT == "latest":
        return datetime.date.today().isoformat()
    return f"20{SNAPSHOT[:2]}-{SNAPSHOT[2:4]}-{SNAPSHOT[4:6]}"


def get_pbf(extract):
    """Path of one Geofabrik extract (e.g. "germany/saarland"), downloaded on first use (md5 checked when Geofabrik publishes one)."""
    name = f"{extract.split('/')[-1]}-{SNAPSHOT}.osm.pbf"
    path, url = PBF_DIR / name, f"https://download.geofabrik.de/europe/{extract}-{SNAPSHOT}.osm.pbf"
    if path.exists():
        return path
    PBF_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    req = urllib.request.Request(url, headers={"User-Agent": "flood-challenge-prepare_osm/1.0"})
    md5 = hashlib.md5()
    t0, done = time.time(), 0
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        print(f"      downloading {name} ({total / 1e6:,.0f} MB) ...", flush=True)
        while chunk := r.read(1 << 20):
            f.write(chunk)
            md5.update(chunk)
            done += len(chunk)
            if done % (100 << 20) < (1 << 20):
                print(f"      {done / 1e6:,.0f}/{total / 1e6:,.0f} MB ({time.time() - t0:.0f} s)", flush=True)
    try:  # Geofabrik publishes the checksum next to the file
        want = urllib.request.urlopen(url + ".md5", timeout=60).read().decode().split()[0]
        if want != md5.hexdigest():
            tmp.unlink()
            sys.exit(f"md5 mismatch for {name}: download is corrupt, try again")
        print("      md5 checked", flush=True)
    except Exception as e:
        print(f"      (md5 file not checked: {type(e).__name__})", flush=True)
    tmp.rename(path)
    return path


def read_pbf(path, aoi_bounds):
    """Matching OSM objects as rows with their geometry: nodes as points, open ways as lines, closed ways and multipolygons as areas."""
    keys, wkb = wanted_keys(), osmium.geom.WKBFactory()
    big = path.stat().st_size > 5e8  # a large extract needs a disk-based node location cache (RAM is limited)
    cache = PBF_DIR / (path.stem + ".nodecache")
    fp = osmium.FileProcessor(str(path))
    fp = fp.with_locations(f"sparse_file_array,{cache}") if big else fp.with_locations()
    fp = fp.with_areas().with_filter(osmium.filter.TagFilter(*tag_pairs()))
    x0, y0, x1, y1 = aoi_bounds
    rows, seen = [], 0
    for o in fp:
        if o.is_node():
            el, oid, g = "node", o.id, shapely.wkb.loads(wkb.create_point(o), hex=True)
        elif o.is_area():
            el, oid = ("way" if o.from_way() else "relation"), o.orig_id()
            try:
                g = shapely.wkb.loads(wkb.create_multipolygon(o), hex=True)
            except Exception:  # an invalid multipolygon: skip it rather than fail the whole file
                continue
        elif o.is_way() and not o.is_closed():  # closed ways already arrive as areas
            try:
                el, oid, g = "way", o.id, shapely.wkb.loads(wkb.create_linestring(o), hex=True)
            except Exception:
                continue
        else:
            continue
        seen += 1
        bx0, by0, bx1, by1 = g.bounds
        if bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1:  # outside the AOI bounding box
            continue
        rows.append({"element": el, "id": oid, "geometry": g, **{k: o.tags.get(k) for k in keys}})
    print(f"      read {seen:,} matching objects in the file, {len(rows):,} inside the AOI bounding box", flush=True)
    if big and cache.exists():
        del fp  # release the cache file, then delete it (it is several GB)
        try:
            cache.unlink()
        except OSError:
            print(f"      (could not delete {cache.name}: delete it by hand)", flush=True)
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=4326)


def main(cc):
    out_poi, out_sum = DATA / "osm" / f"osm_poi_{cc}.json", DATA / "osm" / f"osm_summary_{cc}.json"
    out_poi.parent.mkdir(parents=True, exist_ok=True)
    import gcsfs
    fs = gcsfs.GCSFileSystem(token="anon")  # public challenge bucket, read-only
    inv = pd.DataFrame(list(csv.DictReader(open(DATA / "inventory" / "inventaire_ems.csv", encoding="utf-8"))))

    def load(motif):
        paths = inv.loc[(inv.pays == cc) & inv.fichier.str.contains(motif, case=False), "path"]
        return pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(4326) for p in paths], ignore_index=True)

    print(f"[1/5] loading {cc} observed flood and areas of interest ...", flush=True)
    aoi_union = load("areaOfInterest").union_all()
    water_m = gpd.GeoSeries([load("observed").union_all()], crs=4326).to_crs(3035).iloc[0]
    aoi_km2 = gpd.GeoSeries([aoi_union], crs=4326).to_crs(3035).area.iloc[0] / 1e6

    print(f"[2/5] OSM extracts: Geofabrik {EXTRACTS[cc]}, snapshot {SNAPSHOT} ({snapshot_date()}) ...", flush=True)
    parts = []
    for extract in EXTRACTS[cc]:
        pbf = get_pbf(extract)
        t0 = time.time()
        print(f"      reading {pbf.name} ...", flush=True)
        parts.append(read_pbf(pbf, aoi_union.bounds))
        print(f"      read in {time.time() - t0:.0f} s", flush=True)
    raw = pd.concat(parts, ignore_index=True) if len(parts) > 1 else parts[0]
    raw = gpd.GeoDataFrame(raw, geometry="geometry", crs=4326)
    raw = raw[~raw.duplicated(["element", "id"])]  # an object on the border of two extracts appears in both
    print(f"      {len(raw):,} objects; geometry sources: {raw.element.value_counts().to_dict()} "
          f"(areas = building outlines and polygons, nodes = points)", flush=True)

    print("[3/5] classifying and taking representative points ...", flush=True)
    hit = raw.apply(lambda r: classify(r), axis=1)
    raw = raw[hit.notna()].copy()
    raw[["categorie", "type", "tag"]] = pd.DataFrame(hit[hit.notna()].tolist(), index=raw.index)
    pts_m = raw.to_crs(3035).geometry.representative_point()
    pts = gpd.GeoSeries(pts_m, crs=3035).to_crs(4326)
    keep = pts.within(aoi_union).values  # clip to the true AOI (the bounding box was only a pre-filter)
    raw, pts_m, pts = raw[keep], pts_m[keep], pts[keep]
    dup = ~raw.assign(g=pts.to_wkb()).duplicated(["g", "tag", "name"]).values  # a building drawn twice (node + outline)
    raw, pts_m, pts = raw[dup], pts_m[dup], pts[dup]

    print(f"[4/5] position relative to the observed flood (near = {NEAR_M} m) ...", flush=True)
    near_zone = water_m.buffer(NEAR_M)
    shapely.prepare(water_m); shapely.prepare(near_zone)  # much faster point-in-polygon tests on the big German outlines
    raw["position"] = ["in water" if p.within(water_m) else (POSITIONS[1] if p.within(near_zone) else "outside") for p in pts_m]
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(g.x, 5), round(g.y, 5)]},
              "properties": {"name": n if isinstance(n, str) and n else None, "categorie": c, "type": t, "tag": tg,
                             "position": pos, "osm": f"{el}/{i}"}}
             # column access by name: raw.type would be geopandas' geometry type, not our "type" column
             for g, n, c, t, tg, pos, el, i in zip(pts, raw["name"], raw["categorie"], raw["type"], raw["tag"], raw["position"], raw["element"], raw["id"])]
    out_poi.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print("[5/5] summary ...", flush=True)
    df = pd.DataFrame([f["properties"] for f in feats])
    tab = df.pivot_table(index=["categorie", "type"], columns="position", values="osm", aggfunc="count", fill_value=0).reindex(columns=POSITIONS, fill_value=0)
    tab["total"] = tab.sum(axis=1)
    counts = [{"categorie": c, "type": t, **{p: int(r[p]) for p in POSITIONS}, "total": int(r["total"])} for (c, t), r in tab.iterrows()]
    summary = {"country": cc.upper(), "near_m": NEAR_M, "positions": POSITIONS, "n_poi": len(df), "aoi_km2": round(aoi_km2),
               "source": "Geofabrik extract", "snapshot": SNAPSHOT, "osm_date": snapshot_date(),
               "categories": {k: v["label"] for k, v in CATEGORIES.items()}, "counts": counts}
    out_sum.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(tab.to_string())
    print(f"\n{cc}: {len(df)} points of interest -> {out_poi.name} ({out_poi.stat().st_size / 1e3:,.0f} KB), {out_sum.name}")


if __name__ == "__main__":
    for country in [a for a in sys.argv[1:] if not a.startswith("--")]:
        main(country.lower())
