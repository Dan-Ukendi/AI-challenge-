"""Reproduce the starter notebook's flood stats and buildings-in-water export for one country.

Reads the public challenge bucket anonymously (nothing downloaded whole).
Needs: gcsfs pyogrio rasterio geopandas shapely
Run:   python pipeline/fetch_country.py nl      (or de / be)
Writes data/flood/stats_aoi_<cc>.csv, classes_taille_<cc>.csv, bats_eau_<cc>.gpkg.
"""
import csv
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ["GS_NO_SIGN_REQUEST"] = "YES"  # lets GDAL read the public bucket anonymously
import gcsfs
import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
OUT = DATA / "flood"
OUT.mkdir(parents=True, exist_ok=True)
BUCKET, FOLDER = "datasets_challenge", "working_data"
GDAL_PREFIX = "/vsigs/"
ISO3 = {"be": "BEL", "de": "DEU", "nl": "NLD"}
TUILE = 0.02  # tile size in degrees (~1.5 x 2 km): OBAT is in EPSG:4326

import json
BUFFER_M = json.load(open(ROOT / "config.json"))["building_buffer_m"]  # choice C3
PAYS = sys.argv[1].lower()
fs = gcsfs.GCSFileSystem(token="anon")
inv = pd.DataFrame(list(csv.DictReader(open(DATA / "inventory" / "inventaire_ems.csv", encoding="utf-8"))))


def load(motif):
    paths = inv.loc[(inv.pays == PAYS) & inv.fichier.str.contains(motif, case=False), "path"]
    return pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(3035).assign(produit=p.split("/")[-2])
                      for p in paths], ignore_index=True)


t0 = time.time()
f = load("observed")
a = load("areaOfInterest")
f["surface_ha"] = f.area / 1e4
print(f"{PAYS}: {len(f)} flood polygons, {f.produit.nunique()} products ({time.time() - t0:.0f} s)", flush=True)

# Flooded share per AOI (union avoids double counting across products)
a["aoi"] = a["locality"] if "locality" in a.columns else a.index.astype(str)
a = a.dissolve("aoi").reset_index()
inter = gpd.overlay(gpd.GeoDataFrame(geometry=[f.union_all()], crs=3035), a[["aoi", "geometry"]])
par_aoi = pd.DataFrame({"aoi_ha": a.set_index("aoi").area / 1e4,
                        "eau_ha": inter.dissolve("aoi").area / 1e4}).fillna(0)
par_aoi["part_inondee_%"] = 100 * par_aoi.eau_ha / par_aoi.aoi_ha
par_aoi.to_csv(OUT / f"stats_aoi_{PAYS}.csv")

classes = pd.cut(f.surface_ha, bins=[0, 0.1, 1, 10, 100, float("inf")],
                 labels=["< 0.1 ha", "0.1–1 ha", "1–10 ha", "10–100 ha", "> 100 ha"])
taille = f.groupby(classes, observed=False).surface_ha.agg(n_polygones="count", surface_ha="sum")
taille["%_polygones"] = 100 * taille.n_polygones / taille.n_polygones.sum()
taille["%_surface"] = 100 * taille.surface_ha / taille.surface_ha.sum()
taille.to_csv(OUT / f"classes_taille_{PAYS}.csv")
print(f"stats saved ({time.time() - t0:.0f} s)", flush=True)

# Buildings (GHS-OBAT) inside observed water, read tile by tile
gpkg = next(p for p in fs.find(f"{BUCKET}/{FOLDER}/obat_{PAYS}") if p.endswith(".gpkg"))
# Water polygons widened by BUFFER_M metres (a building point at the flood edge can fall in or out)
eau = gpd.GeoDataFrame(geometry=f.to_crs(3035).buffer(BUFFER_M), crs=3035).to_crs(4326)
flood_union = f.to_crs(4326).union_all()
x0, y0, x1, y1 = eau.total_bounds
grid = gpd.GeoDataFrame(geometry=[shapely.box(x, y, x + TUILE, y + TUILE)
                                  for x in np.arange(x0, x1, TUILE) for y in np.arange(y0, y1, TUILE)], crs=4326)
grid = grid.loc[gpd.sjoin(grid, eau[["geometry"]], predicate="intersects").index.unique()]
print(len(grid), "tiles to read", flush=True)


def lire(geom):
    b = gpd.read_file(f"{GDAL_PREFIX}{gpkg}", bbox=geom.bounds)
    return gpd.sjoin(b, eau[["geometry"]], predicate="within").drop(columns="index_right") if len(b) else b


morceaux = []
with ThreadPoolExecutor(max_workers=8) as ex:
    for i, r in enumerate(ex.map(lire, grid.geometry), 1):
        morceaux.append(r)
        if i % 25 == 0 or i == len(grid):
            print(f"  {i}/{len(grid)} tiles ({time.time() - t0:.0f} s)", flush=True)

bats = pd.concat([m for m in morceaux if len(m)], ignore_index=True)
bats = bats[~bats.geometry.to_wkb().duplicated()].reset_index(drop=True)
bats["in_flood"] = bats.within(flood_union)  # False = only inside the buffer around the flood
bats.to_file(OUT / f"bats_eau_{PAYS}.gpkg")
print(f"{PAYS}: {len(bats)} buildings within {BUFFER_M} m of observed water, {int(bats.in_flood.sum())} strictly inside ({time.time() - t0:.0f} s)")
