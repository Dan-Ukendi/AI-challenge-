"""LAU (municipality) metrics for the choropleth: per commune touched by the observed flood.

External source: Eurostat GISCO LAU 2023 boundaries (ext/lau_be_de_nl.gpkg), not challenge data.
Needs: gcsfs pyogrio rasterio geopandas shapely
Run:   python prepare_lau.py be de nl
Writes lau_<cc>.json next to this file (read by build_app.py). Parameters: config.json.
Needs bats_eau_<cc>.gpkg from fetch_country.py (run that first).
"""
import csv
import os
import sys
from pathlib import Path

os.environ["GS_NO_SIGN_REQUEST"] = "YES"
import gcsfs
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds, transform as win_transform

HERE = Path(__file__).parent
ROOT = "datasets_challenge/working_data"
GDAL_PREFIX = "/vsigs/"
import json
CFG = json.load(open(HERE / "config.json"))
K = 8                                    # sub-cells per population cell side
MIN_FLOOD_HA = CFG["min_flood_ha"]       # choice B2: 0 = keep every commune the flood touches
RP = CFG["efas_return_period"]           # choice E1

fs = gcsfs.GCSFileSystem(token="anon")
inv = pd.DataFrame(list(csv.DictReader(open(HERE / "inventaire_ems.csv", encoding="utf-8"))))
lau_all = gpd.read_file(HERE / "ext" / "lau_be_de_nl.gpkg")
pop_path = next(p for p in fs.find(f"{ROOT}/ghs_pop") if "E2020" in p and p.endswith(".tif") and "ovr" not in p)
efas_path = next(p for p in fs.find(f"{ROOT}/cems-efas") if p.endswith(f"RP{RP}_filled_depth.tif"))


def window(src, bounds):
    w, s, e, n = bounds
    win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths()
    return win.intersection(Window(0, 0, src.width, src.height))


def sub_grid(arr, transform, bounds, k=1):
    """Slice arr to the cells covering bounds; return the slice and the (k-times finer) transform of the slice."""
    w, s, e, n = bounds
    c0, r1 = ~transform * (w, s)  # bottom-left -> (col, row)
    c1, r0 = ~transform * (e, n)  # top-right
    r0, r1 = max(int(np.floor(r0)), 0), min(int(np.ceil(r1)), arr.shape[0])
    c0, c1 = max(int(np.floor(c0)), 0), min(int(np.ceil(c1)), arr.shape[1])
    sl = arr[r0:r1, c0:c1]
    t = transform * rasterio.Affine.translation(c0, r0) * rasterio.Affine.scale(1 / k, 1 / k)
    return sl, t


for cc in sys.argv[1:]:
    paths = inv.loc[(inv.pays == cc) & inv.fichier.str.contains("observed", case=False), "path"]
    flood = pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(4326) for p in paths], ignore_index=True)
    union = flood.union_all()
    # mapped extent = areas of interest (outside them, "not flooded" means "not mapped": choice B3)
    aoi_paths = inv.loc[(inv.pays == cc) & inv.fichier.str.contains("areaOfInterest", case=False), "path"]
    aoi_union = pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(4326) for p in aoi_paths], ignore_index=True).union_all()
    w, s, e, n = aoi_union.bounds
    lau = lau_all[lau_all.CNTR_CODE == cc.upper()].cx[w:e, s:n]
    lau = lau[lau.intersects(aoi_union) | lau.intersects(union)].copy()
    bats = gpd.read_file(HERE / f"bats_eau_{cc}.gpkg")
    nb = gpd.sjoin(bats, lau[["GISCO_ID", "geometry"]], predicate="within").groupby("GISCO_ID").size()

    lau_m = lau.to_crs(3035)
    aoi_m = gpd.GeoSeries([aoi_union], crs=4326).to_crs(3035).iloc[0]
    coverage = {r.GISCO_ID: float(lau_m.loc[i].geometry.intersection(aoi_m).area / lau_m.loc[i].geometry.area * 100)
                for i, r in lau.iterrows()}

    with rasterio.open(f"{GDAL_PREFIX}{pop_path}") as src:
        win = window(src, lau.total_bounds)
        pop = src.read(1, window=win, masked=True).astype("float64").filled(0)
        t_pop = win_transform(win, src.transform)
    with rasterio.open(f"{GDAL_PREFIX}{efas_path}") as src:
        ew = window(src, flood.total_bounds)
        depth = src.read(1, window=ew, masked=True).filled(0)
        t_efas = win_transform(ew, src.transform)

    rows = []
    for _, r in lau.iterrows():
        inter = union.intersection(r.geometry)
        flood_ha = float(gpd.GeoSeries([inter], crs=4326).to_crs(3035).area.iloc[0] / 1e4)
        base = {"lau_id": r.GISCO_ID, "name": r.LAU_NAME, "country": cc.upper(), "coverage_pct": coverage[r.GISCO_ID],
                "pop_official": None if pd.isna(r.POP_2023) else float(r.POP_2023)}
        if flood_ha <= MIN_FLOOD_HA:  # mapped (or partly mapped) but no flood observed: no raster work needed
            rows.append({**base, "flood_ha": 0.0, "buildings": int(nb.get(r.GISCO_ID, 0)), "pop_total": None,
                         "pop_exposed": 0.0, "hazard_share_100": None})
            continue
        sp, tf = sub_grid(pop, t_pop, r.geometry.bounds, K)
        share = lambda g: rasterize([(g, 1)], out_shape=(sp.shape[0] * K, sp.shape[1] * K), transform=tf, dtype="uint8") \
            .reshape(sp.shape[0], K, sp.shape[1], K).mean(axis=(1, 3))
        sd, td = sub_grid(depth, t_efas, inter.bounds)
        mask = rasterize([(inter, 1)], out_shape=sd.shape, transform=td, dtype="uint8").astype(bool) if sd.size else np.zeros((0, 0), bool)
        rows.append({
            **base, "flood_ha": flood_ha, "buildings": int(nb.get(r.GISCO_ID, 0)),
            "pop_total": float((sp * share(r.geometry)).sum()),
            "pop_exposed": float((sp * share(inter)).sum()),
            "hazard_share_100": 100 * float((mask & (sd > 0)).sum()) / mask.sum() if mask.sum() else None,
        })
    out = lau[["GISCO_ID", "geometry"]].rename(columns={"GISCO_ID": "lau_id"}).merge(pd.DataFrame(rows), on="lau_id")
    out["geometry"] = out.geometry.simplify(0.0005)
    out.to_file(HERE / f"lau_{cc}.json", driver="GeoJSON")
    print(f"{cc}: {len(out)} communes in the mapped areas, {int((out.flood_ha > 0).sum())} touched by the observed flood -> lau_{cc}.json", flush=True)
