"""Road graph and destinations for the "My route" tab: routes planned to AVOID the flood data.

Team principle (our choice): the flood data is the safe side. A road that is not in our water data (observed 2021 flood, modelled flood zones)
is assumed passable even in a flood this large; roads inside the water data are avoided (the browser applies a heavy cost to them).
The graph covers the mapped areas (AOI) and the observed flood, plus a margin (route_cover_km), so that a person inside the flood can still reach places outside it.

Needs: gcsfs pyogrio rasterio geopandas shapely pyosmium numpy   (OSM extracts come from prepare_osm.py: same OSM_PBF_DIR)
Run:   python pipeline/prepare_routing.py be      (then nl, de)
Writes app/routing_data/graph_<cc>.js  (loaded on demand by the page; works from a local file)
       data/routing/routing_<cc>.meta.json   (small: coverage outline and counts; embedded by src/build_app.py)
"""
import base64
import csv
import datetime
import json
import math
import os
import sys
import time
from array import array
from collections import Counter
from pathlib import Path

os.environ["GS_NO_SIGN_REQUEST"] = "YES"
import geopandas as gpd
import numpy as np
import osmium
import pandas as pd
import rasterio
import shapely
from rasterio.windows import transform as win_transform
from shapely.geometry import LineString, mapping

import prepare_osm as P  # reuses the extract list, the downloader and the OSM reader (importing runs nothing)

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
OUT = ROOT / "app" / "routing_data"
CFG = P.CFG
COVER_KM = CFG.get("route_cover_km", 8)
SNAP_M = CFG.get("route_snap_m", 400)

CAR = ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
       "unclassified", "residential", "living_street"]
FOOT_ONLY = ["pedestrian", "footway", "path", "cycleway"]      # footway sidewalks and crossings are skipped (they double the data in cities)
ALLOWED = CAR + FOOT_ONLY
CLS = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "pedestrian", "footway", "path", "cycleway"]
SPEED_KMH = [100, 80, 60, 50, 40, 40, 30, 10, 0, 0, 0, 0]   # car speeds by class (rough planning values)
F_CAR, F_FOOT, F_FWD, F_BACK, F_OBS, F_R100, F_R500 = 1, 2, 4, 8, 16, 32, 64


def load(cc, inv, motif):
    paths = inv.loc[(inv.pays == cc) & inv.fichier.str.contains(motif, case=False), "path"]
    return pd.concat([gpd.read_file(f"{P.GDAL_PREFIX}{p}").to_crs(4326) for p in paths], ignore_index=True)


class Roads:
    """Compact store of the road ways read so far (typed arrays: Germany has millions of nodes)."""
    def __init__(self):
        self.ref, self.lon, self.lat = array("q"), array("d"), array("d")
        self.start, self.cls, self.fl = array("q", [0]), array("B"), array("B")


def read_roads(path, cover, bounds, store):
    big = path.stat().st_size > 3e8
    cache = P.PBF_DIR / (path.stem + ".roadcache")
    fp = osmium.FileProcessor(str(path))
    fp = fp.with_locations(f"sparse_file_array,{cache}") if big else fp.with_locations()
    fp = fp.with_filter(osmium.filter.TagFilter(*[("highway", v) for v in ALLOWED]))
    x0, y0, x1, y1 = bounds
    seen = kept = 0
    for o in fp:
        if not o.is_way():
            continue
        t = o.tags
        hw = t.get("highway")
        if hw == "footway" and t.get("footway") in ("sidewalk", "crossing"):
            continue
        private = t.get("access") in ("no", "private")
        car = hw in CAR and t.get("motor_vehicle") not in ("no", "private") and not private
        foot = hw not in ("motorway", "motorway_link") and t.get("foot") != "no" and (not private or t.get("foot") in ("yes", "designated"))
        if not (car or foot):
            continue
        try:
            nodes = [(n.ref, n.lon, n.lat) for n in o.nodes]
        except Exception:  # a node outside the extract has no location
            continue
        if len(nodes) < 2:
            continue
        seen += 1
        lons = [n[1] for n in nodes]
        lats = [n[2] for n in nodes]
        if max(lons) < x0 or min(lons) > x1 or max(lats) < y0 or min(lats) > y1:
            continue
        mid = len(nodes) // 2
        if not any(shapely.contains_xy(cover, lons[i], lats[i]) for i in (0, mid, len(nodes) - 1)):
            continue
        fl = (F_CAR if car else 0) | (F_FOOT if foot else 0)
        ow = t.get("oneway")
        if car and (ow in ("yes", "1", "true") or t.get("junction") == "roundabout"):
            fl |= F_FWD
        elif car and ow == "-1":
            fl |= F_BACK
        store.ref.extend(n[0] for n in nodes)
        store.lon.extend(lons)
        store.lat.extend(lats)
        store.start.append(len(store.ref))
        store.cls.append(CLS.index(hw.replace("_link", "")))
        store.fl.append(fl)
        kept += 1
    print(f"      {path.name}: {seen:,} highways read, {kept:,} inside the coverage", flush=True)
    if big and cache.exists():
        del fp
        try:
            cache.unlink()
        except OSError:
            print(f"      (could not delete {cache.name}: delete it by hand)", flush=True)


def build_graph(st):
    """Split the ways at junctions: nodes = junctions and ends, edges = the road pieces between them (vectorised)."""
    ref, lon, lat = np.frombuffer(st.ref, dtype=np.int64), np.frombuffer(st.lon), np.frombuffer(st.lat)
    start = np.frombuffer(st.start, dtype=np.int64)
    way = np.repeat(np.arange(len(start) - 1), np.diff(start))                 # way id of every position
    first = np.zeros(len(ref), bool); first[start[:-1]] = True
    last = np.zeros(len(ref), bool); last[start[1:] - 1] = True
    uniq, inv, cnt = np.unique(ref, return_inverse=True, return_counts=True)
    brk = first | last | (cnt[inv] >= 2)                                        # junctions and way ends
    pos = np.where(brk)[0]
    ok = way[pos[:-1]] == way[pos[1:]]                                          # consecutive break points of the same way = one edge
    p0, p1 = pos[:-1][ok], pos[1:][ok]
    # nodes
    node_refs, first_pos = np.unique(ref[pos], return_index=True)
    nlon, nlat = lon[pos][first_pos], lat[pos][first_pos]
    a = np.searchsorted(node_refs, ref[p0]); b = np.searchsorted(node_refs, ref[p1])
    # lengths from cumulative segment lengths
    dx = np.diff(lon, prepend=lon[0]) * np.cos(np.radians(lat)) * 111320.0
    dy = np.diff(lat, prepend=lat[0]) * 110540.0
    seg = np.hypot(dx, dy); seg[first] = 0                                      # no segment into the first node of a way
    cs = np.cumsum(seg)
    elen = np.round(cs[p1] - cs[p0]).astype(np.int64)
    ecls = np.frombuffer(st.cls, dtype=np.uint8)[way[p0]]
    efl = np.frombuffer(st.fl, dtype=np.uint8)[way[p0]].astype(np.int16)
    keep = (a != b) | (p1 - p0 > 3)                                             # drop tiny degenerate loops
    p0, p1, a, b, elen, ecls, efl = p0[keep], p1[keep], a[keep], b[keep], elen[keep], ecls[keep], efl[keep]
    lines = np.empty(len(p0), dtype=object)
    for i in range(len(p0)):
        lines[i] = LineString(np.column_stack((lon[p0[i]:p1[i] + 1], lat[p0[i]:p1[i] + 1])))
    return nlon, nlat, a, b, elen, ecls, efl, lines


def raster_hits(arr, transform, x, y):
    cols = np.floor((x - transform.c) / transform.a).astype(int)
    rows = np.floor((y - transform.f) / transform.e).astype(int)
    ok = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
    hit = np.zeros(len(x), dtype=bool)
    hit[ok] = arr[rows[ok], cols[ok]]
    return hit


def efas_zone(rp, bounds):
    import prepare_hazard as H   # reads the bucket listing once
    with rasterio.open(f"{P.GDAL_PREFIX}{H.EFAS_PATH[rp]}") as src:
        win = H.window(src, bounds, pad=0.02)
        return src.read(1, window=win, masked=True).filled(0) > 0, win_transform(win, src.transform)


def b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def round_coords(o, nd=4):
    return round(o, nd) if isinstance(o, float) else [round_coords(v, nd) for v in o]


def main(cc):
    t0 = time.time()
    inv = pd.DataFrame(list(csv.DictReader(open(DATA / "inventory" / "inventaire_ems.csv", encoding="utf-8"))))
    print(f"[1/6] {cc}: observed flood and coverage (mapped areas + flood + {COVER_KM} km) ...", flush=True)
    flood = load(cc, inv, "observed").union_all()
    aoi = load(cc, inv, "areaOfInterest").union_all()   # the mapped areas: the satellite may have missed floods inside them (e.g. the Vesdre valley), so they stay covered
    cover_m = gpd.GeoSeries([flood.union(aoi)], crs=4326).to_crs(3035).iloc[0].buffer(COVER_KM * 1000, resolution=4).simplify(150)
    cover = gpd.GeoSeries([cover_m], crs=3035).to_crs(4326).iloc[0]
    shapely.prepare(cover); shapely.prepare(flood)
    bounds = cover.bounds
    print(f"      coverage {cover_m.area / 1e6:,.0f} km2", flush=True)

    print("[2/6] roads from the OSM extracts ...", flush=True)
    store = Roads()
    for extract in P.EXTRACTS[cc]:
        read_roads(P.get_pbf(extract), cover, bounds, store)
    print(f"      {len(store.cls):,} ways ({time.time() - t0:.0f} s)", flush=True)

    print("[3/6] graph ...", flush=True)
    nlon, nlat, ea, eb, elen, ecls, efl, lines = build_graph(store)
    del store
    m, n = len(ea), len(nlon)
    simple = shapely.simplify(lines, 0.00008)  # ~9 m: keeps the shape of the road, drops most vertices
    del lines
    print(f"      {n:,} nodes, {m:,} edges ({time.time() - t0:.0f} s)", flush=True)

    print("[4/6] which edges are in the water data ...", flush=True)
    efl = efl.astype(np.int16)
    efl[shapely.intersects(flood, simple)] |= F_OBS      # flood first: it is the prepared geometry
    dens = shapely.segmentize(simple, 0.0005)            # a sample every ~40-55 m so a flood zone cannot slip between two vertices
    xy, idx = shapely.get_coordinates(dens, return_index=True)
    del dens
    for rp, flag in ((100, F_R100), (500, F_R500)):
        arr, tr = efas_zone(rp, bounds)
        hit = raster_hits(arr, tr, xy[:, 0], xy[:, 1])
        efl[np.bincount(idx[hit], minlength=m) > 0] |= flag
    del xy, idx
    print(f"      edges in the observed flood: {int(((efl & F_OBS) > 0).sum()):,}, in the 100-year zone: {int(((efl & F_R100) > 0).sum()):,}, "
          f"500-year: {int(((efl & F_R500) > 0).sum()):,} ({time.time() - t0:.0f} s)", flush=True)

    print("[5/6] destinations (shelters, hospitals) ...", flush=True)
    P.CATEGORIES = {"dest": {"label": "destinations", "rules": P.rules_from_tags(CFG.get("shelter_tags", [])) + [("amenity", ["hospital", "clinic"])]}}
    parts = [P.read_pbf(P.get_pbf(e), bounds) for e in P.EXTRACTS[cc]]
    raw = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), geometry="geometry", crs=4326) if len(parts) > 1 else parts[0]
    raw = raw[~raw.duplicated(["element", "id"])]
    hitc = raw.apply(lambda r: P.classify(r), axis=1)
    raw = raw[hitc.notna()].copy()
    raw[["cat", "type", "tag"]] = pd.DataFrame(hitc[hitc.notna()].tolist(), index=raw.index)
    pts = gpd.GeoSeries(raw.to_crs(3035).geometry.representative_point(), crs=3035).to_crs(4326)
    keep = shapely.contains_xy(cover, pts.x.values, pts.y.values)
    raw, pts = raw[keep].copy(), pts[keep]
    dx, dy = pts.x.values, pts.y.values
    flood_buf = gpd.GeoSeries([flood], crs=4326).to_crs(3035).iloc[0].buffer(P.NEAR_M)
    shapely.prepare(flood_buf)
    dflag = shapely.intersects(flood_buf, gpd.GeoSeries(pts, crs=4326).to_crs(3035).values).astype(int)   # 1 = in or within 100 m of the observed flood
    for rp, bit in ((100, 2), (500, 4)):
        arr, tr = efas_zone(rp, bounds)
        dflag = dflag | (raster_hits(arr, tr, dx, dy).astype(int) * bit)
    # snap every destination to the nearest junction that cars AND people on foot can use
    both = np.zeros(n, dtype=bool)
    sel = (efl & (F_CAR | F_FOOT)) == (F_CAR | F_FOOT)
    both[ea[sel]] = True; both[eb[sel]] = True
    cand = np.where(both)[0]
    tree = shapely.STRtree(shapely.points(nlon[cand], nlat[cand]))
    pairs, _ = tree.query_nearest(shapely.points(dx, dy), return_distance=True, all_matches=False)
    dest = []
    for qi, ti in zip(pairs[0], pairs[1]):
        j = cand[ti]
        d_m = math.hypot((dx[qi] - nlon[j]) * math.cos(math.radians(dy[qi])) * 111320.0, (dy[qi] - nlat[j]) * 110540.0)
        if d_m > SNAP_M:
            continue
        typ, nm = raw.iloc[qi]["type"], raw.iloc[qi]["name"]
        kind = "medical" if typ in ("hospital", "clinic") else ("assembly" if typ == "assembly_point" else "shelter")
        dest.append({"n": nm if isinstance(nm, str) and nm else None, "t": typ, "k": kind, "lon": round(float(dx[qi]), 5), "lat": round(float(dy[qi]), 5),
                     "node": int(j), "f": int(dflag[qi])})
    print(f"      {len(dest):,} destinations kept {dict(Counter(d['k'] for d in dest))}; outside the flood data: {sum(1 for d in dest if d['f'] == 0):,}", flush=True)

    print("[6/6] export ...", flush=True)
    q = lambda v: np.round(np.asarray(v) * 1e5).astype(np.int32)
    off, shp = [0], []
    for ln in simple:
        c = np.asarray(ln.coords)[1:-1]   # the end points are the nodes
        shp.append(q(c).ravel())
        off.append(off[-1] + len(c))
    shp = np.concatenate(shp) if shp else np.zeros(0, dtype=np.int32)
    data = {"bbox": [round(v, 5) for v in bounds], "n": n, "m": m, "cls": CLS, "speed": SPEED_KMH, "dest": dest,
            "lon": b64(q(nlon)), "lat": b64(q(nlat)), "a": b64(ea.astype(np.int32)), "b": b64(eb.astype(np.int32)), "len": b64(elen.astype(np.uint32)),
            "c": b64(ecls.astype(np.uint8)), "f": b64(efl.astype(np.uint8)), "off": b64(np.array(off, dtype=np.uint32)), "shp": b64(shp),
            "built": datetime.date.today().isoformat()}
    OUT.mkdir(parents=True, exist_ok=True)
    js = OUT / f"graph_{cc}.js"
    js.write_text('window.ROUTE_DATA = window.ROUTE_DATA || {};\nwindow.ROUTE_DATA["%s"] = %s;\n' % (cc, json.dumps(data, separators=(",", ":"))), encoding="utf-8")
    cov = mapping(cover.simplify(0.004))
    meta = {"bbox": data["bbox"], "cover": {"type": cov["type"], "coordinates": round_coords(cov["coordinates"])}, "nodes": n, "edges": m, "dest": len(dest),
            "built": data["built"], "file": f"routing_data/graph_{cc}.js", "cover_km": COVER_KM, "km2": round(cover_m.area / 1e6)}
    (DATA / "routing").mkdir(parents=True, exist_ok=True)
    (DATA / "routing" / f"routing_{cc}.meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    print(f"{cc}: graph_{cc}.js {js.stat().st_size / 1e6:.1f} MB | {n:,} nodes, {m:,} edges, {len(dest)} destinations | {time.time() - t0:.0f} s")


if __name__ == "__main__":
    for c in sys.argv[1:]:
        main(c.lower())
