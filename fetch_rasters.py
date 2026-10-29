"""Population (GHS-POP E2020) and EFAS hazard checks over the observed flood, per country.

Reads only the flooded window of each raster from the public bucket (nothing downloaded whole).
Needs: gcsfs pyogrio rasterio geopandas shapely
Run:   python fetch_rasters.py nl      (or de / be)
Writes exposure_pop_<cc>.csv and efas_check_<cc>.csv next to this file.
"""
import csv
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
from rasterio.windows import Window, from_bounds, transform as win_transform

HERE = Path(__file__).parent
ROOT = "datasets_challenge/working_data"
GDAL_PREFIX = "/vsigs/"
OVERSAMPLE = 10  # sub-cells per GHS-POP cell side, to weight cells by flooded share

PAYS = sys.argv[1].lower()
fs = gcsfs.GCSFileSystem(token="anon")
inv = pd.DataFrame(list(csv.DictReader(open(HERE / "inventaire_ems.csv", encoding="utf-8"))))
t0 = time.time()

paths = inv.loc[(inv.pays == PAYS) & inv.fichier.str.contains("observed", case=False), "path"]
flood = pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(4326) for p in paths], ignore_index=True)
union = flood.union_all()  # union: no double counting across products
print(f"{PAYS}: flood union loaded ({time.time() - t0:.0f} s)", flush=True)


def window_for(src, geom_wgs84):
    """Pixel window of a raster covering the flood extent, plus the flood geometry in the raster CRS."""
    g = gpd.GeoSeries([geom_wgs84], crs=4326).to_crs(src.crs)
    win = from_bounds(*g.total_bounds, transform=src.transform).round_offsets().round_lengths()
    win = win.intersection(Window(0, 0, src.width, src.height))
    return win, g.iloc[0]


# --- Population: residents in the flooded area, weighted by flooded share of each cell ---
pop_path = next(p for p in fs.find(f"{ROOT}/ghs_pop") if "E2020" in p and p.endswith(".tif") and "ovr" not in p)
with rasterio.open(f"{GDAL_PREFIX}{pop_path}") as src:
    win, g = window_for(src, union)
    pop = src.read(1, window=win, masked=True).astype("float64").filled(0)
    t = win_transform(win, src.transform)
    k = OVERSAMPLE
    t_fine = t * t.scale(1 / k, 1 / k)
    fine = rasterize([(g, 1)], out_shape=(pop.shape[0] * k, pop.shape[1] * k), transform=t_fine, dtype="uint8")
    share = fine.reshape(pop.shape[0], k, pop.shape[1], k).mean(axis=(1, 3))
    touched = share > 0
    pd.DataFrame([{
        "country": PAYS, "source": "GHS-POP R2023A E2020",
        "pop_exposed_weighted": float((pop * share).sum()),
        "pop_in_touched_cells": float(pop[touched].sum()),
        "cells_touched": int(touched.sum()),
        "pop_in_window": float(pop.sum()),
    }]).to_csv(HERE / f"exposure_pop_{PAYS}.csv", index=False)
print(f"population done ({time.time() - t0:.0f} s)", flush=True)

# --- EFAS: how much of the observed flood sits inside the modelled hazard zone ---
rows = []
for rp in (10, 100, 500):
    p = next(x for x in fs.find(f"{ROOT}/cems-efas") if x.endswith(f"RP{rp}_filled_depth.tif"))
    with rasterio.open(f"{GDAL_PREFIX}{p}") as src:
        win, g = window_for(src, union)
        depth = src.read(1, window=win, masked=True)
        t = win_transform(win, src.transform)
        mask = rasterize([(g, 1)], out_shape=depth.shape, transform=t, dtype="uint8").astype(bool)
        d = depth.filled(0)
        modelled = ~np.ma.getmaskarray(depth)
        n = int(mask.sum())
        rows.append({"country": PAYS, "return_period": rp, "flood_cells": n,
                     "share_in_hazard_zone_%": 100 * float((mask & (d > 0)).sum()) / max(n, 1),
                     "share_modelled_%": 100 * float((mask & modelled).sum()) / max(n, 1),
                     "mean_depth_m_in_flood": float(d[mask & (d > 0)].mean()) if (mask & (d > 0)).any() else 0.0})
    print(f"  EFAS RP{rp} done ({time.time() - t0:.0f} s)", flush=True)
pd.DataFrame(rows).to_csv(HERE / f"efas_check_{PAYS}.csv", index=False)
print(f"{PAYS}: done ({time.time() - t0:.0f} s)")
