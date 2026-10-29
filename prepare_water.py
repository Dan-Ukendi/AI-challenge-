"""Map layers for the app: observed flood outline + EFAS modelled water depth, per country.

Reads only the flooded window of each EFAS raster from the public bucket.
Needs: gcsfs pyogrio rasterio geopandas shapely
Run:   python prepare_water.py be de nl
Writes water_<cc>.json next to this file (read by build_app.py).
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
from rasterio.windows import Window, from_bounds
from shapely.geometry import mapping

HERE = Path(__file__).parent
ROOT = "datasets_challenge/working_data"
GDAL_PREFIX = "/vsigs/"
MAX_PX = 1600  # longest side of each depth image
PAD = 0.02     # degrees of margin around the flood extent
# depth bins (m): upper bound -> RGBA, light to dark blue
BINS = [(0.5, (198, 219, 239, 190)), (1, (158, 202, 225, 200)), (2, (107, 174, 214, 210)),
        (4, (49, 130, 189, 220)), (float("inf"), (8, 48, 107, 235))]

fs = gcsfs.GCSFileSystem(token="anon")
inv = pd.DataFrame(list(csv.DictReader(open(HERE / "inventaire_ems.csv", encoding="utf-8"))))


def png_rgba(rgba):
    """Encode an (h, w, 4) uint8 array as PNG, stdlib only."""
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def depth_image(depth):
    """Colour a depth grid (nan = no water) and shrink it to MAX_PX, keeping the deepest value per block."""
    f = max(1, -(-max(depth.shape) // MAX_PX))
    h, w = (-(-s // f) * f for s in depth.shape)
    padded = np.full((h, w), np.nan, dtype="float32")
    padded[:depth.shape[0], :depth.shape[1]] = depth
    small = np.nanmax(padded.reshape(h // f, f, w // f, f), axis=(1, 3)) if f > 1 else padded
    rgba = np.zeros(small.shape + (4,), dtype="uint8")
    lo = 0.0
    for hi, col in BINS:
        rgba[(small > lo) & (small <= hi)] = col
        lo = hi
    return rgba


for cc in sys.argv[1:]:
    paths = inv.loc[(inv.pays == cc) & inv.fichier.str.contains("observed", case=False), "path"]
    flood = pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(4326) for p in paths], ignore_index=True)
    union = flood.union_all().simplify(0.0003)  # ~30 m
    out = {"flood": {"type": "Feature", "properties": {}, "geometry": json.loads(json.dumps(mapping(union)))}, "efas": {}}
    west, south, east, north = flood.total_bounds
    for rp in (10, 100, 500):
        p = next(x for x in fs.find(f"{ROOT}/cems-efas") if x.endswith(f"RP{rp}_filled_depth.tif"))
        with rasterio.open(f"{GDAL_PREFIX}{p}") as src:
            win = from_bounds(west - PAD, south - PAD, east + PAD, north + PAD, src.transform)
            win = win.round_offsets().round_lengths().intersection(Window(0, 0, src.width, src.height))
            depth = src.read(1, window=win, masked=True).astype("float32").filled(np.nan)
            b = rasterio.windows.bounds(win, src.transform)
        png = png_rgba(depth_image(depth))
        out["efas"][str(rp)] = {"bounds": [[b[1], b[0]], [b[3], b[2]]],  # [[south, west], [north, east]]
                                "png": "data:image/png;base64," + base64.b64encode(png).decode()}
        print(f"{cc} RP{rp}: {depth.shape} px, {len(png) / 1e3:,.0f} KB png", flush=True)
    s = json.dumps(out, separators=(",", ":"))
    (HERE / f"water_{cc}.json").write_text(s)
    print(f"{cc}: water_{cc}.json {len(s) / 1e6:.2f} MB", flush=True)
