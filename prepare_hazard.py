"""Modelled river-flood exposure per commune (EFAS hazard maps x GHS-POP residents), for every commune of a country.

Unlike the observed 2021 flood (partial: only the mapped areas), EFAS covers the whole country the same way, so it can compare
a commune with its neighbours. It is a MODEL of generic 10-, 100- and 500-year river floods: it leaves out small rivers
(catchments under 500 km2) and heavy-rain flooding, and it is not a forecast.
Needs: gcsfs pyogrio rasterio geopandas shapely  (and ext/lau_be_de_nl.gpkg from the LAU download)
Run:   python prepare_hazard.py be
Writes hazard_<cc>.json: [{id, name, lon, lat, pop, pop_official, p10, p100, p500}]  (p = % of residents inside the modelled zone)
"""
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
from rasterio.features import rasterize
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window, from_bounds, transform as win_transform

HERE = Path(__file__).parent
ROOT = "datasets_challenge/working_data"
GDAL_PREFIX = "/vsigs/"
RPS = (10, 100, 500)


def window(src, bounds, pad=0.01):
    w, s, e, n = bounds
    win = from_bounds(w - pad, s - pad, e + pad, n + pad, src.transform).round_offsets().round_lengths()
    return win.intersection(Window(0, 0, src.width, src.height))


def main(cc):
    t0 = time.time()
    lau = gpd.read_file(HERE / "ext" / "lau_be_de_nl.gpkg")
    lau = lau[lau.CNTR_CODE == cc.upper()].reset_index(drop=True)
    fs = gcsfs.GCSFileSystem(token="anon")
    print(f"{cc}: {len(lau)} communes", flush=True)

    # population (GHS-POP 2020, ~1 km cells) and the three EFAS depth rasters (~90 m cells), over the country
    pop_path = next(p for p in fs.find(f"{ROOT}/ghs_pop") if "E2020" in p and p.endswith(".tif") and "ovr" not in p)
    depth, t_efas = {}, None
    for rp in RPS:
        p = next(x for x in fs.find(f"{ROOT}/cems-efas") if x.endswith(f"RP{rp}_filled_depth.tif"))
        with rasterio.open(f"{GDAL_PREFIX}{p}") as src:
            win = window(src, lau.total_bounds)
            if t_efas is None:
                t_efas, win0 = win_transform(win, src.transform), win
            assert win == win0, "EFAS rasters are expected to share one grid"
            depth[rp] = src.read(1, window=win, masked=True).filled(0) > 0  # True = water modelled in this cell
    shape = depth[RPS[0]].shape
    with rasterio.open(f"{GDAL_PREFIX}{pop_path}") as src:
        pw = window(src, lau.total_bounds, pad=0.03)
        pop = src.read(1, window=pw, masked=True).astype("float64").filled(0)
        t_pop = win_transform(pw, src.transform)
    # spread each ~1 km population cell evenly over the finer EFAS cells it contains (totals are preserved)
    pop_e = np.zeros(shape, dtype="float64")
    reproject(pop, pop_e, src_transform=t_pop, src_crs="EPSG:4326", dst_transform=t_efas, dst_crs="EPSG:4326", resampling=Resampling.nearest)
    pop_e /= (abs(t_pop.a * t_pop.e) / abs(t_efas.a * t_efas.e))
    print(f"      rasters read ({time.time() - t0:.0f} s), EFAS grid {shape}", flush=True)

    cen = gpd.GeoSeries(lau.to_crs(3035).geometry.centroid, crs=3035).to_crs(4326)
    rows = []
    for i, r in lau.iterrows():
        x0, y0, x1, y1 = r.geometry.bounds
        c0, r1 = ~t_efas * (x0, y0)
        c1, r0 = ~t_efas * (x1, y1)
        r0, r1 = max(int(np.floor(r0)), 0), min(int(np.ceil(r1)), shape[0])
        c0, c1 = max(int(np.floor(c0)), 0), min(int(np.ceil(c1)), shape[1])
        if r1 <= r0 or c1 <= c0:
            continue
        t_sub = t_efas * rasterio.Affine.translation(c0, r0)
        mask = rasterize([(r.geometry, 1)], out_shape=(r1 - r0, c1 - c0), transform=t_sub, dtype="uint8").astype(bool)
        pe = pop_e[r0:r1, c0:c1]
        total = float(pe[mask].sum())
        pct = {f"p{rp}": (100 * float(pe[mask & depth[rp][r0:r1, c0:c1]].sum()) / total if total > 0 else 0.0) for rp in RPS}
        rows.append({"id": r.GISCO_ID, "name": r.LAU_NAME, "lon": round(cen.iloc[i].x, 4), "lat": round(cen.iloc[i].y, 4),
                     "pop": round(total), "pop_official": None if pd.isna(r.POP_2023) else int(r.POP_2023),
                     **{k: round(v, 1) for k, v in pct.items()}})
    rows.sort(key=lambda d: d["name"])
    (HERE / f"hazard_{cc}.json").write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    df = pd.DataFrame(rows)
    print(f"{cc}: {len(df)} communes -> hazard_{cc}.json ({time.time() - t0:.0f} s)")
    print("share of communes with at least 10% of residents in the 100-year zone:", f"{(df.p100 >= 10).mean():.0%}",
          "| below 2% in the 500-year zone:", f"{(df.p500 < 2).mean():.0%}")
    print("check, total residents: GHS", f"{df['pop'].sum():,.0f}", "vs official", f"{df.pop_official.sum():,.0f}")
    print(df[df.name.isin(["Verviers", "Pepinster", "Trooz", "Chaudfontaine", "Luik", "Esneux", "Dinant", "Namen", "Rochefort", "Wezet", "Brussel", "Hotton"])]
          [["name", "pop", "p10", "p100", "p500"]].to_string(index=False))


if __name__ == "__main__":
    for c in sys.argv[1:]:
        main(c.lower())
