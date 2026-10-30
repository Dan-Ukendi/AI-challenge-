"""Islands: areas the 2021 flood cuts off from hospitals by road, ranked by how urgent they are.

Method (simple, so the team can explain it):
 1. Take the road graph of the "My route" tab (prepare_routing.py): every junction and every piece of road between junctions.
 2. Keep roads a car can use. CLOSE every road piece that touches the observed 2021 flood (bridges included: an OSM bridge over the flood is closed too).
 3. Cut the remaining roads into connected groups (scipy connected_components). A group is an ISLAND when
      - it holds no hospital, and
      - before the closure it WAS connected to a hospital (so a group simply cut by the edge of our map is not counted), and
      - it has at least `island_min_pop` estimated residents.
 4. Residents: GHS-POP 2020 (~1 km cells, uniform inside a cell) under the island's outline = its junctions wrapped and widened by ~130 m (estimate, not a count).
 5. What is inside each island: shelters and hospitals from the route graph, fire stations and vulnerable sites from OpenStreetMap (2021-01-01 snapshot).
 6. Every island is a top priority. They are ranked between them by the number of gaps (no fire station inside, no shelter inside, a vulnerable site inside,
    at least `island_urgent_pop` residents), then by residents cut off.
What it does NOT know: roads the satellite maps missed (so fewer islands than reality), roads closed for other reasons, one-way rules (ignored: emergency
vehicles), whether a flooded road was really impassable, and the real travel time. Distances to the nearest hospital are straight lines.

Needs: the graphs from prepare_routing.py (app/routing_data/graph_<cc>.js), gcsfs rasterio geopandas shapely pyosmium numpy scipy pandas
Run:   python pipeline/prepare_islands.py be nl de
Writes data/islands/islands.json (read by src/build_app.py)
"""
import base64
import datetime
import json
import os
import sys
import time
from pathlib import Path

os.environ["GS_NO_SIGN_REQUEST"] = "YES"
import gcsfs
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import shapely
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds, transform as win_transform
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

import prepare_osm as P

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
CFG = P.CFG
MIN_POP, URGENT_POP = CFG.get("island_min_pop", 100), CFG.get("island_urgent_pop", 1000)
F_CAR, F_FOOT, F_FWD, F_BACK, F_OBS = 1, 2, 4, 8, 16     # edge flags, as written by prepare_routing.py
GCS_ROOT = "datasets_challenge/working_data"
fs = gcsfs.GCSFileSystem(token="anon")
VULN_RULES = [("amenity", ["hospital", "clinic", "nursing_home", "school", "kindergarten", "prison"]), ("social_facility", ["nursing_home", "assisted_living"])]
M_LON, M_LAT = 111320.0, 110540.0   # metres per degree (rough, enough for distances of a few km)


def read_graph(cc):
    """graph_<cc>.js -> dict of numpy arrays + destination list (the file is `window.ROUTE_DATA[...] = {json};`)."""
    t = (ROOT / "app" / "routing_data" / f"graph_{cc}.js").read_text(encoding="utf-8")
    d = json.loads(t[t.index("] = ") + 4:].rstrip().rstrip(";"))
    arr = lambda k, dt: np.frombuffer(base64.b64decode(d[k]), dtype=dt)
    return {"lon": arr("lon", np.int32) / 1e5, "lat": arr("lat", np.int32) / 1e5, "a": arr("a", np.int32), "b": arr("b", np.int32),
            "len": arr("len", np.uint32), "f": arr("f", np.uint8), "dest": d["dest"], "bbox": d["bbox"], "n": d["n"]}


def read_pois(cc, bounds):
    """Fire stations and vulnerable sites from the OSM extracts (kept in a small cache next to the extracts: the read is slow)."""
    cache = P.PBF_DIR / f"islands_pois_{cc}.pkl"
    if cache.exists():
        return pd.read_pickle(cache)
    P.CATEGORIES = {"fire": {"label": "fire", "rules": [("amenity", ["fire_station"])]}, "vuln": {"label": "vulnerable", "rules": VULN_RULES}}
    parts = [P.read_pbf(P.get_pbf(e), bounds) for e in P.EXTRACTS[cc]]
    raw = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), geometry="geometry", crs=4326) if len(parts) > 1 else parts[0]
    raw = raw[~raw.duplicated(["element", "id"])]
    hit = raw.apply(lambda r: P.classify(r), axis=1)
    raw = raw[hit.notna()].copy()
    raw[["cat", "type", "tag"]] = pd.DataFrame(hit[hit.notna()].tolist(), index=raw.index)
    pts = gpd.GeoSeries(raw.to_crs(3035).geometry.representative_point(), crs=3035).to_crs(4326)
    out = pd.DataFrame({"cat": raw.cat.values, "type": raw["type"].values, "name": raw["name"].values, "lon": pts.x.values, "lat": pts.y.values})
    out.to_pickle(cache)
    return out


def load_pop(bbox):
    """GHS-POP 2020 for the map window: array of residents per ~1 km cell and its transform."""
    pop_path = next(p for p in fs.find(f"{GCS_ROOT}/ghs_pop") if "E2020" in p and p.endswith(".tif") and "ovr" not in p)
    w, s, e, n = bbox
    with rasterio.open(f"/vsigs/{pop_path}") as src:
        win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths().intersection(Window(0, 0, src.width, src.height))
        return src.read(1, window=win, masked=True).astype("float64").filled(0), win_transform(win, src.transform)


def island_pop(hull, pop, t, K=10):
    """Residents under a shape: every cell is cut in K x K sub-cells holding an equal share of the cell (uniform-in-cell assumption, as elsewhere in the app);
    the sub-cells whose centre is inside the shape are added. A small island therefore gets a small part of a cell, never the whole cell."""
    x0, y0, x1, y1 = hull.bounds
    c0, r1 = ~t * (x0, y0); c1, r0 = ~t * (x1, y1)
    r0, r1 = max(int(np.floor(r0)), 0), min(int(np.ceil(r1)), pop.shape[0]); c0, c1 = max(int(np.floor(c0)), 0), min(int(np.ceil(c1)), pop.shape[1])
    if r1 <= r0 or c1 <= c0:
        return 0.0
    sub = np.kron(pop[r0:r1, c0:c1], np.ones((K, K))) / (K * K)
    tf = t * rasterio.Affine.translation(c0, r0) * rasterio.Affine.scale(1 / K, 1 / K)
    m = rasterize([(hull, 1)], out_shape=sub.shape, transform=tf, dtype="uint8").astype(bool)
    return float(sub[m].sum())


def main(cc):
    t0 = time.time()
    g = read_graph(cc)
    n, f = g["n"], g["f"]
    print(f"{cc}: {n:,} junctions, {len(f):,} road pieces", flush=True)
    car = (f & F_CAR) > 0
    closed = (f & F_OBS) > 0
    a, b = g["a"], g["b"]
    car_node = np.zeros(n, bool); car_node[a[car]] = True; car_node[b[car]] = True

    def comps(mask):
        m = coo_matrix((np.ones(mask.sum(), dtype=np.int8), (a[mask], b[mask])), shape=(n, n))
        return connected_components(m, directed=False)[1]
    lab_base, lab_closed = comps(car), comps(car & ~closed)
    print(f"      car roads {int(car.sum()):,}, closed by the observed flood {int((car & closed).sum()):,} ({time.time() - t0:.0f} s)", flush=True)

    road_m = np.bincount(a[car], weights=g["len"][car] / 2, minlength=n) + np.bincount(b[car], weights=g["len"][car] / 2, minlength=n)   # half of each piece to each end
    pop, tpop = load_pop(g["bbox"])

    # hospitals, shelters from the route graph; fire stations and vulnerable sites from OSM
    d = pd.DataFrame(g["dest"])
    hosp = d[d.t == "hospital"]
    shel = d[d.k.isin(["shelter", "assembly"])]
    pois = read_pois(cc, g["bbox"])
    tree = cKDTree(np.column_stack((g["lon"][car_node] * np.cos(np.radians(50.5)), g["lat"][car_node])))
    cn = np.where(car_node)[0]

    def snap(lon, lat, max_m=400):
        dist, j = tree.query(np.column_stack((np.asarray(lon) * np.cos(np.radians(50.5)), np.asarray(lat))))
        return np.where(dist * M_LAT <= max_m, cn[j], -1)
    fire = pois[pois.cat == "fire"].reset_index(drop=True)
    vuln = pois[pois.cat == "vuln"].reset_index(drop=True)
    fire_node, vuln_node = snap(fire.lon, fire.lat), snap(vuln.lon, vuln.lat)

    ncomp = lab_closed.max() + 1
    nodes_c = np.bincount(lab_closed[car_node], minlength=ncomp)
    hosp_c = np.bincount(lab_closed[hosp.node.values], minlength=ncomp)
    base_h = np.bincount(lab_base[hosp.node.values], minlength=lab_base.max() + 1) > 0     # baseline groups that reach a hospital
    # a closed group's baseline group = the baseline group of any of its junctions
    first = np.full(ncomp, -1); first[lab_closed[::-1]] = np.arange(n)[::-1]
    had = np.zeros(ncomp, bool); ok = first >= 0; had[ok] = base_h[lab_base[first[ok]]]
    cand = np.where((hosp_c == 0) & had & (nodes_c >= 3))[0]
    print(f"      {len(cand)} road groups cut off from every hospital (hospital reachable before the flood); counting their residents ...", flush=True)
    if not len(cand):
        return []
    # shape of each group: its junctions, wrapped (concave hull) and widened by ~130 m to reach the buildings along the roads
    shape, res_c = {}, {}
    order_ = np.argsort(lab_closed[car_node], kind="stable"); cn_all = np.where(car_node)[0][order_]
    labs = lab_closed[cn_all]; lo = np.searchsorted(labs, cand); hi = np.searchsorted(labs, cand, side="right")
    for c, l0, l1 in zip(cand, lo, hi):
        mem = cn_all[l0:l1]
        shape[c] = shapely.buffer(shapely.concave_hull(shapely.multipoints(shapely.points(g["lon"][mem], g["lat"][mem])), ratio=0.3), 0.0013)
        res_c[c] = island_pop(shape[c], pop, tpop)
    cand = np.array([c for c in cand if res_c[c] >= MIN_POP], dtype=int)
    print(f"      {len(cand)} islands with at least {MIN_POP} estimated residents", flush=True)
    if not len(cand):
        return []

    lau = gpd.read_file(ROOT / "ext" / "lau_be_de_nl.gpkg")
    lau = lau[lau.CNTR_CODE == cc.upper()].to_crs(4326)
    nodes_gdf = gpd.GeoDataFrame({"w": road_m[car_node], "comp": lab_closed[car_node]}, geometry=gpd.points_from_xy(g["lon"][car_node], g["lat"][car_node]), crs=4326)
    nodes_gdf = nodes_gdf[nodes_gdf.comp.isin(cand)]
    j = gpd.sjoin(nodes_gdf, lau[["LAU_NAME", "geometry"]], how="left", predicate="within")
    j = j[~j.index.duplicated()]
    j["LAU_NAME"] = j.LAU_NAME.str.replace(r",\s*(Stadt|Gemeinde|Markt|Kreisfreie Stadt).*$", "", regex=True)   # "Sinzig, Stadt" -> "Sinzig"
    names_by = j.groupby(["comp", "LAU_NAME"]).w.sum().reset_index()

    road_len = np.bincount(lab_closed[a[car & ~closed]], weights=g["len"][car & ~closed], minlength=ncomp) / 1000
    cut = car & closed
    out = []
    for c in cand:
        mem = np.where(car_node & (lab_closed == c))[0]
        hull = shape[c].simplify(0.0003)
        cx, cy = float(g["lon"][mem].mean()), float(g["lat"][mem].mean())
        nm = names_by[names_by.comp == c].sort_values("w", ascending=False)
        tot = nm.w.sum() or 1
        communes = [{"n": r.LAU_NAME, "pct": round(100 * r.w / tot)} for r in nm.head(4).itertuples() if isinstance(r.LAU_NAME, str) and r.w / tot >= 0.1]
        # closed road pieces that touch the island: where it is cut
        side = cut & ((lab_closed[a] == c) | (lab_closed[b] == c))
        ends = np.unique(np.where(lab_closed[a[side]] == c, a[side], b[side]))
        marks = [[round(float(g["lon"][k]), 5), round(float(g["lat"][k]), 5)] for k in ends[:12]]
        dh = np.hypot((hosp.lon.values - cx) * np.cos(np.radians(cy)) * M_LON, (hosp.lat.values - cy) * M_LAT) / 1000
        i = int(dh.argmin()) if len(hosp) else None
        in_c = lambda arr: np.where(arr >= 0, lab_closed[np.maximum(arr, 0)] == c, False)
        fr, vu = fire[in_c(fire_node)], vuln[in_c(vuln_node)]
        sh = shel[lab_closed[shel.node.values] == c]
        vc = vu.type.value_counts().to_dict()
        res = float(res_c[c])
        # every island is a top priority (no hospital reachable); these gaps only rank the islands between them
        gaps = [g for g, on in (("no fire station inside", len(fr) == 0), ("no shelter inside", len(sh) == 0), ("vulnerable site inside", len(vu) > 0),
                                (f"{URGENT_POP:,}+ residents", res >= URGENT_POP)) if on]
        out.append({"cc": cc, "name": communes[0]["n"] if communes else "(no commune)", "communes": communes, "residents": int(round(res, -1)), "junctions": len(mem),
                    "road_km": round(float(road_len[c]), 1), "closed_links": int(side.sum()), "lon": round(cx, 5), "lat": round(cy, 5),
                    "hull": json.loads(shapely.to_geojson(shapely.transform(hull, lambda x: x.round(5)))), "cuts": marks,
                    "hospital": {"name": hosp.iloc[i].n, "km": round(float(dh[i]), 1)} if i is not None else None,
                    "fire": [x for x in fr.name.tolist() if isinstance(x, str)][:5], "fire_n": len(fr),
                    "shelters": [x for x in sh.n.tolist() if isinstance(x, str)][:5], "shelters_n": len(sh), "vulnerable": vc,
                    "gaps": gaps, "score": len(gaps)})
    out.sort(key=lambda r: (-r["score"], -r["residents"]))   # more gaps first, then more residents cut off
    for k, r in enumerate(out, 1):
        r["rank"] = k
    print(f"      {len(out)} islands; gaps counted: {pd.Series([r['score'] for r in out]).value_counts().sort_index().to_dict()}; residents cut off (sum): {sum(r['residents'] for r in out):,} ({time.time() - t0:.0f} s)", flush=True)
    return out


if __name__ == "__main__":
    res = {cc: main(cc) for cc in (c.lower() for c in sys.argv[1:])}
    p = DATA / "islands" / "islands.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    old = json.loads(p.read_text(encoding="utf-8"))["islands"] if p.exists() else {}
    old.update(res)
    meta = {"built": datetime.date.today().isoformat(), "min_pop": MIN_POP, "urgent_pop": URGENT_POP,
            "closed": "car roads touching the observed 2021 flood (bridges included)", "osm_snapshot": P.SNAPSHOT}
    p.write_text(json.dumps({"meta": meta, "islands": old}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("wrote", p, {k: len(v) for k, v in old.items()})
