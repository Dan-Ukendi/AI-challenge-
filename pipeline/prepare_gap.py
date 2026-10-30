"""2021 flood vs official German flood zones: the gap, and the exposure per commune and per Land.

Run ONCE after prepare_uesg.py (the app only reads the local result, never a service):
  python pipeline/prepare_gap.py
Needs: gcsfs pyogrio rasterio geopandas shapely  (and data/official_zones/uesg_de.gpkg, ext/lau_be_de_nl.gpkg)

Study area = the Copernicus EMS mapped areas (AOI) in Germany. Everything is clipped to it, because outside it we do not know
what flooded in 2021 (no map = not "dry"). All areas are computed in EPSG:25832 (metric).
Three zones, written the same way everywhere:
  flood  the observed 2021 flood (union of all Copernicus products)
  legal  official zone with a legal status: festgesetzt + vorläufig gesichert
  risk   "Risikogebiet außerhalb ÜSG": not a legal zone, kept apart
  gap    flood minus legal  ("flooded in 2021, outside the official zone")   [split: inside / outside a Risikogebiet]
Exposure per commune (GISCO LAU 2023 boundaries):
  buildings   GHS-OBAT building points (2020) that fall inside the zone
  residents   GHS-POP 2020 (30 arc-sec, ~1 km): each cell is cut in K x K sub-cells holding an equal share of the cell's residents
              (uniform-in-cell assumption); a sub-cell counts when its centre is inside the zone. An ESTIMATE, not a count.
Writes data/official_zones/: gap_2021_vs_official.gpkg, exposure_by_municipality.csv, exposure_by_land.csv,
       uesg_app.json (simplified shapes + numbers read by src/build_app.py)
"""
import csv
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
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

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
ZONES = DATA / "official_zones"
RAW = Path(os.environ.get("UESG_RAW_DIR") or r"C:\Users\danuk\uesg_raw")
GCS_ROOT, GDAL_PREFIX = "datasets_challenge/working_data", "/vsigs/"
CRS_WORK = "EPSG:25832"
TILE = 0.02      # degrees: buildings are read tile by tile, like fetch_country.py
K = 10           # sub-cells per population cell side
SIMPLIFY_M = 25  # display shapes only; all numbers come from the full shapes
LANDS = {"DE_05": "NRW", "DE_07": "RLP", "DE_10": "SL"}

fs = gpd_fs = gcsfs.GCSFileSystem(token="anon")
inv = pd.DataFrame(list(csv.DictReader(open(DATA / "inventory" / "inventaire_ems.csv", encoding="utf-8"))))


def load_ems(motif):
    paths = inv.loc[(inv.pays == "de") & inv.fichier.str.contains(motif, case=False), "path"]
    return pd.concat([gpd.read_file(f"{GDAL_PREFIX}{p}").to_crs(CRS_WORK) for p in paths], ignore_index=True)


def build_zones():
    """The four shapes (EPSG:25832), all clipped to the AOI."""
    aoi = load_ems("areaOfInterest").union_all()
    flood = load_ems("observed").union_all().intersection(aoi)
    z = gpd.read_file(ZONES / "uesg_de.gpkg")
    legal = z[z.statut.isin(["festgesetzt", "vorläufig gesichert"])].union_all().intersection(aoi)
    risk_all = z[z.statut == "Risikogebiet außerhalb ÜSG"].union_all().intersection(aoi)
    risk = risk_all.difference(legal)               # risk zone not already covered by a legal zone
    gap = flood.difference(legal)
    gap_in_risk, gap_out = gap.intersection(risk), gap.difference(risk)
    return {"aoi": aoi, "flood": flood, "legal": legal, "risk": risk, "gap": gap, "gap_in_risk": gap_in_risk, "gap_out": gap_out}


def read_buildings(zones):
    """GHS-OBAT points inside (flood U legal U risk), read tile by tile and kept in a local cache."""
    cache = RAW / "obat_de_zones.gpkg"
    if cache.exists():
        print(f"  buildings read from {cache.name}")
        return gpd.read_file(cache)
    wide = gpd.GeoSeries([shapely.union_all([zones["flood"], zones["legal"], zones["risk"]])], crs=CRS_WORK).to_crs(4326).iloc[0]
    path = next(p for p in fs.find(f"{GCS_ROOT}/obat_de") if p.endswith(".gpkg"))
    x0, y0, x1, y1 = wide.bounds
    boxes = [shapely.box(x, y, x + TILE, y + TILE) for x in np.arange(x0, x1, TILE) for y in np.arange(y0, y1, TILE)]
    boxes = [b for b in boxes if wide.intersects(b)]
    print(f"  {len(boxes)} tiles to read", flush=True)

    shapely.prepare(wide)            # prepared once: testing points against this big shape is then fast

    def one(b):
        t = gpd.read_file(f"{GDAL_PREFIX}{path}", bbox=b.bounds)
        return t[shapely.contains_xy(wide, t.geometry.x.values, t.geometry.y.values)] if len(t) else t

    parts, t0 = [], time.time()
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, t in enumerate(ex.map(one, boxes), 1):
            parts.append(t)
            if i % 100 == 0 or i == len(boxes):
                print(f"    {i}/{len(boxes)} tiles ({time.time() - t0:.0f} s)", flush=True)
    b = pd.concat([p for p in parts if len(p)], ignore_index=True)
    b = gpd.GeoDataFrame(b[~b.geometry.to_wkb().duplicated()][["id", "geometry"]], crs=4326).reset_index(drop=True)
    RAW.mkdir(parents=True, exist_ok=True)
    b.to_file(cache, driver="GPKG")
    return b


def main():
    t0 = time.time()
    ZONES.mkdir(parents=True, exist_ok=True)
    print("zones ...", flush=True)
    Z = build_zones()
    ha = {k: round(g.area / 1e4) for k, g in Z.items()}
    print("  areas (ha):", ha, f"({time.time() - t0:.0f} s)", flush=True)

    # communes touching the AOI, German Länder only
    lau = gpd.read_file(ROOT / "ext" / "lau_be_de_nl.gpkg")
    lau = lau[lau.GISCO_ID.str[:5].isin(LANDS)].to_crs(CRS_WORK)
    lau = lau[lau.intersects(Z["aoi"])].reset_index(drop=True)
    lau["land"] = lau.GISCO_ID.str[:5].map(LANDS)
    print(f"  {len(lau)} communes touch the study area")

    # areas per commune (ha): the zones cut by the commune boundaries
    rows = pd.DataFrame({"land": lau.land, "id": lau.GISCO_ID, "commune": lau.LAU_NAME})
    for k in ("flood", "legal", "risk", "gap", "gap_in_risk", "gap_out"):
        rows[f"{k}_ha"] = [round(c.intersection(Z[k]).area / 1e4, 1) for c in lau.geometry]

    # buildings: which zones each OBAT point is in, then counted per commune
    b = read_buildings(Z).to_crs(CRS_WORK)
    print(f"  {len(b):,} buildings in the zones ({time.time() - t0:.0f} s)", flush=True)
    for k in ("flood", "legal", "risk", "gap"):
        shapely.prepare(Z[k])
        b[k] = shapely.contains_xy(Z[k], b.geometry.x.values, b.geometry.y.values)
    j = gpd.sjoin(b, lau[["GISCO_ID", "geometry"]], predicate="within").drop_duplicates("id")
    cnt = j.groupby("GISCO_ID")[["flood", "legal", "risk", "gap"]].sum().astype(int).add_prefix("bat_")
    rows = rows.join(cnt, on="id").fillna({c: 0 for c in cnt.columns})

    # residents: GHS-POP cut in K x K sub-cells, summed where the sub-cell centre is in each zone
    pop_path = next(p for p in fs.find(f"{GCS_ROOT}/ghs_pop") if "E2020" in p and p.endswith(".tif") and "ovr" not in p)
    z4326 = {k: gpd.GeoSeries([Z[k]], crs=CRS_WORK).to_crs(4326).iloc[0] for k in ("flood", "legal", "risk", "gap")}
    lau4326 = lau.to_crs(4326)
    with rasterio.open(f"{GDAL_PREFIX}{pop_path}") as src:
        w, s, e, n = lau4326.total_bounds
        win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths().intersection(Window(0, 0, src.width, src.height))
        pop = src.read(1, window=win, masked=True).astype("float64").filled(0)
        t = win_transform(win, src.transform)
    fine = np.kron(pop, np.ones((K, K))) / (K * K)                  # same residents, spread evenly over the sub-cells
    t_fine, shape = t * t.scale(1 / K, 1 / K), fine.shape
    com = rasterize([(g, i + 1) for i, g in enumerate(lau4326.geometry)], out_shape=shape, transform=t_fine, dtype="int32")
    tot = np.bincount(com.ravel(), weights=fine.ravel(), minlength=len(lau) + 1)[1:]
    rows["pop_commune_ghs"] = tot.round().astype(int)
    for k in ("flood", "legal", "risk", "gap"):
        m = rasterize([(z4326[k], 1)], out_shape=shape, transform=t_fine, dtype="uint8").astype(bool)
        rows[f"pop_{k}"] = np.bincount(com[m], weights=fine[m], minlength=len(lau) + 1)[1:].round().astype(int)
    print(f"  residents done ({time.time() - t0:.0f} s)", flush=True)

    rows = rows[(rows.flood_ha > 0) | (rows.legal_ha > 0) | (rows.risk_ha > 0)].sort_values(["land", "gap_ha"], ascending=[True, False])
    rows.to_csv(ZONES / "exposure_by_municipality.csv", index=False, encoding="utf-8")
    num = [c for c in rows.columns if c.endswith("_ha") or c.startswith(("bat_", "pop_"))]
    land = rows.groupby("land")[num].sum().round(0).astype(int)
    land.loc["Total"] = land.sum()
    land.to_csv(ZONES / "exposure_by_land.csv", encoding="utf-8")

    # shapes: full geometry kept in the gpkg (EPSG:25832), simplified in the json for the map
    out = ZONES / "gap_2021_vs_official.gpkg"
    if out.exists():
        out.unlink()
    g = gpd.GeoDataFrame({"cas": ["hors zone légale, dans un Risikogebiet", "hors zone légale ni Risikogebiet"],
                          "surface_ha": [ha["gap_in_risk"], ha["gap_out"]]}, geometry=[Z["gap_in_risk"], Z["gap_out"]], crs=CRS_WORK)
    g.to_file(out, layer="ecart_2021_vs_officiel", driver="GPKG")

    def light(g, decimals):
        """GeoJSON with rounded coordinates (smaller file); the shape is repaired first."""
        return json.loads(shapely.to_geojson(shapely.transform(shapely.make_valid(g), lambda a: a.round(decimals))))

    def shape(k, tol=SIMPLIFY_M):
        return light(gpd.GeoSeries([Z[k].simplify(tol)], crs=CRS_WORK).to_crs(4326).iloc[0], 5)
    # commune outlines for the click popups (simplified, only the communes of the table)
    outl = lau.set_index("GISCO_ID").geometry.simplify(60).to_crs(4326)
    outl = {i: light(outl[i], 4) for i in rows.id}
    app = {"shapes": {k: shape(k) for k in ("legal", "risk", "flood", "gap")},
           "communes": [{**r, "geom": outl[r["id"]]} for r in rows[["id", "commune", "land", "flood_ha", "legal_ha", "gap_ha", "gap_in_risk_ha", "bat_flood", "bat_legal", "bat_gap",
                             "pop_flood", "pop_legal", "pop_gap", "pop_commune_ghs"]].to_dict("records")],
           "land": land.reset_index().to_dict("records"), "areas_ha": ha}
    (ZONES / "uesg_app.json").write_text(json.dumps(app, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(land.to_string())
    print(f"done in {time.time() - t0:.0f} s; uesg_app.json {(ZONES / 'uesg_app.json').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
