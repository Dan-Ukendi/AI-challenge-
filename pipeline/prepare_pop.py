"""Population layers for the app: GHS-POP E2020 exposure per country and per area of interest (AOI).

Each GHS-POP cell is weighted by the share of its area covered by the observed flood (Annex 2 advice).
Reads only the flooded window of the raster from the public bucket.
Needs: gcsfs pyogrio rasterio geopandas shapely
Run:   python pipeline/prepare_pop.py be de nl
Writes data/population/pop_<cc>.json (read by src/build_app.py).
"""
import base64
import csv
import json
import os
import struct
import sys
import zlib
from pathlib import Path

os.environ["GS_NO_SIGN_REQUEST"] = "YES"
import gcsfs
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds, transform as win_transform, bounds as win_bounds

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
GCS_ROOT = "datasets_challenge/working_data"
OUT = DATA / "population"
OUT.mkdir(parents=True, exist_ok=True)
GDAL_PREFIX = "/vsigs/"
K = 10      # sub-cells per cell side, for the flooded-share weighting
PAD = 0.1   # degrees of margin around the flood extent
# residents per cell -> RGBA (light to dark orange)
BINS = [(1, None), (50, (254, 237, 222, 170)), (200, (253, 190, 133, 190)), (1000, (253, 141, 60, 205)),
        (5000, (217, 72, 1, 220)), (float("inf"), (127, 39, 4, 235))]

fs = gcsfs.GCSFileSystem(token="anon")
inv = pd.DataFrame(list(csv.DictReader(open(DATA / "inventory" / "inventaire_ems.csv", encoding="utf-8"))))
pop_path = next(p for p in fs.find(f"{GCS_ROOT}/ghs_pop") if "E2020" in p and p.endswith(".tif") and "ovr" not in p)


def png_rgba(rgba):
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def load(cc, motif):
    paths = inv.loc[(inv.pays == cc) & inv.fichier.str.contains(motif, case=False), "path"]
    return pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(4326) for p in paths], ignore_index=True)


for cc in sys.argv[1:]:
    flood, aoi = load(cc, "observed"), load(cc, "areaOfInterest")
    union = flood.union_all()
    aoi["aoi"] = aoi["locality"] if "locality" in aoi.columns else aoi.index.astype(str)
    aoi = aoi.dissolve("aoi").reset_index()

    with rasterio.open(f"{GDAL_PREFIX}{pop_path}") as src:
        w, s, e, n = flood.total_bounds
        win = from_bounds(w - PAD, s - PAD, e + PAD, n + PAD, src.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, src.width, src.height))
        pop = src.read(1, window=win, masked=True).astype("float64").filled(0)
        t = win_transform(win, src.transform)
        b = win_bounds(win, src.transform)
    t_fine = t * t.scale(1 / K, 1 / K)
    fine_shape = (pop.shape[0] * K, pop.shape[1] * K)

    def share(geom):
        """Share of each population cell covered by geom."""
        fine = rasterize([(geom, 1)], out_shape=fine_shape, transform=t_fine, dtype="uint8")
        return fine.reshape(pop.shape[0], K, pop.shape[1], K).mean(axis=(1, 3))

    total = share(union)
    rows = []
    for _, r in aoi.iterrows():
        in_aoi = share(r.geometry)
        sh = share(union.intersection(r.geometry)) if union.intersects(r.geometry) else np.zeros_like(pop)
        rows.append({"aoi": r["aoi"], "pop_in_aoi": float((pop * in_aoi).sum()), "pop_exposed": float((pop * sh).sum())})

    rgba = np.zeros(pop.shape + (4,), dtype="uint8")
    lo = 0.0
    for hi, col in BINS:
        if col:
            rgba[(pop > lo) & (pop <= hi)] = col
        lo = hi
    png = png_rgba(rgba)
    out = {"source": "GHS-POP R2023A E2020",
           "pop_exposed": float((pop * total).sum()),
           "pop_in_touched_cells": float(pop[total > 0].sum()),
           "cells_touched": int((total > 0).sum()),
           "aoi": sorted(rows, key=lambda x: -x["pop_exposed"]),
           "image": {"bounds": [[b[1], b[0]], [b[3], b[2]]], "png": "data:image/png;base64," + base64.b64encode(png).decode()}}
    (OUT / f"pop_{cc}.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"{cc}: exposed {out['pop_exposed']:,.0f} | touched cells {out['pop_in_touched_cells']:,.0f} | "
          f"{len(rows)} AOIs | image {pop.shape} px {len(png) / 1e3:,.0f} KB", flush=True)
