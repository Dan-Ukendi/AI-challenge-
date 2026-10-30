"""Official German flood-zone layers (Rhineland-Palatinate + North Rhine-Westphalia) merged into one local file.

Run ONCE (the app never calls these services): it reads only local files afterwards.
  python pipeline/prepare_uesg.py
Writes data/official_zones/uesg_de.gpkg (layer "uesg_de", EPSG:25832) and data/official_zones/uesg_de_run.json (URLs, dates, counts;
summarised by hand in data/official_zones/uesg_de_SOURCE.txt).

Study area = the mapped areas (AOI) of Copernicus EMS Germany, bounding box validated with the team (step 1).
Columns of the merged layer:
  land        RLP or NRW
  statut      status taken from the source: "festgesetzt", "vorläufig gesichert" or "Risikogebiet außerhalb ÜSG"
  couche      source layer name (RLP collection id, NRW shapefile name)
  nom         river / water body name when the source gives one
  hq          flood return value given by the source (RLP "HQ"), when present
  statut_src  the source's own wording of the status (RLP "STAND_BEZ"), for traceability
  id_source   identifier of the object in the source
  attrs       all the source attributes, as JSON text (nothing is lost)
"""
import datetime
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio
import requests
import shapely
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"
ZONES = DATA / "official_zones"
RAW = Path(os.environ.get("UESG_RAW_DIR") or r"C:\Users\danuk\uesg_raw")   # big raw download, kept out of the synced project folder
CRS_WORK = "EPSG:25832"                                                     # ETRS89 / UTM 32N: metric, used for all areas
BBOX_WGS84 = (6.02745, 49.54262, 7.73199, 51.48178)                         # west, south, east, north: the mapped areas (step 1)
HEADERS = {"User-Agent": "flood-challenge-uesg/1.0 (open-data download, one-off)"}

# ---------- RLP: OGC API Features ----------
# www. is required: the server certificate does not cover the bare name geoportal.rlp.de
RLP_BASE = "https://www.geoportal.rlp.de/spatial-objects/650"
RLP_LAYERS = {   # collection id -> (default status, name column, has a bbox filter that works)
    "uesg:uesg_gesetzlich": (None, "GEW_NAME", True),                                     # status read from STAND_BEZ
    "uesg:risikogebiete_ausserhalb_uesg": ("Risikogebiet außerhalb ÜSG", "GEWAESSER", False),   # bbox filter returns nothing on this layer
    "uesg:RISIKOGEBIETE_AUSSERHALB_UESG_WEITERE": ("Risikogebiet außerhalb ÜSG", "GEW_BEZ", True),
}
# ---------- NRW: open data download (zip of shapefiles, already in EPSG:25832) ----------
NRW_ZIP_URL = "https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/hochwasser/uesg/uesg_EPSG25832_Shape.zip"
NRW_LAYERS = {"festgesetzte_Ueberschwemmungsgebiete": "festgesetzt", "vorlaeufig_gesicherte_Ueberschwemmungsgebiete": "vorläufig gesichert"}
LOG = {}   # what was fetched, for the SOURCE file


def rlp_status(text):
    """RLP 'gesetzlich' layer: take the status from the source's own wording (STAND_BEZ)."""
    t = (text or "").lower()
    if "festgesetzt" in t:
        return "festgesetzt"
    if "vorläufig" in t or "vorlaeufig" in t:
        return "vorläufig gesichert"
    return f"autre ({text})"          # not guessed: kept visible so the team can decide


def get(url, tries=6, **kw):
    """GET with a few spaced retries: the public RLP server sometimes drops the connection when it is busy."""
    for k in range(1, tries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=240, **kw)
            r.raise_for_status()
            return r
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            print(f"    attempt {k}/{tries} failed: {type(e).__name__}", flush=True)
            if k == tries:
                raise
            time.sleep(10 * k)


def fetch_rlp(collection, use_bbox):
    """Download every object of one RLP layer, following the 'next' links (limit 500 is one of the values the server accepts).
    The answer is kept in the raw folder, so a re-run does not download it again."""
    cache = RAW / ("rlp_" + collection.replace(":", "_") + ".json")
    if cache.exists():
        saved = json.loads(cache.read_text(encoding="utf-8"))
        print(f"  {collection}: {len(saved['features'])} objects read from {cache.name} (downloaded {saved['downloaded']})")
        LOG[collection] = saved["log"]
        return saved["features"]
    url = f"{RLP_BASE}/collections/{collection}/items?f=json&limit=500"
    if use_bbox:
        url += "&bbox=" + ",".join(str(v) for v in BBOX_WGS84)
    feats, pages, matched, seen = [], 0, None, set()
    while url and url not in seen:    # the server keeps offering a 'next' link on the last page: stop on a repeated link
        seen.add(url)
        d = get(url).json()           # raises if the server answers with an HTML error page
        got = d.get("features", [])
        feats += got
        matched = d.get("numberMatched", matched)
        pages += 1
        print(f"    page {pages}: {len(feats)} objects so far", flush=True)
        if len(got) < 500:            # a short page is the last one
            break
        url = next((l["href"] for l in d.get("links", []) if l.get("rel") == "next"), None)
    print(f"  {collection}: {len(feats)} objects in {pages} page(s) (server says numberMatched={matched})", flush=True)
    if matched is not None and matched != len(feats):
        raise SystemExit(f"incomplete download for {collection}: {len(feats)} of {matched}")
    log = {"objects": len(feats), "pages": pages, "bbox_filter": use_bbox, "numberMatched": matched}
    RAW.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"downloaded": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "log": log, "features": feats}), encoding="utf-8")
    LOG[collection] = log
    return feats


def load_rlp():
    parts = []
    for cid, (status, name_col, has_bbox) in RLP_LAYERS.items():
        g = gpd.GeoDataFrame.from_features(fetch_rlp(cid, has_bbox), crs="EPSG:4326").to_crs(CRS_WORK)
        g = g[g.intersects(gpd.GeoSeries([box(*BBOX_WGS84)], crs="EPSG:4326").to_crs(CRS_WORK).iloc[0])]   # keep what touches the study area
        attrs = g.drop(columns="geometry")
        out = gpd.GeoDataFrame({
            "land": "RLP",
            "statut": [status or rlp_status(t) for t in attrs.get("STAND_BEZ", pd.Series([None] * len(g), index=g.index))],
            "couche": cid,
            "nom": attrs.get(name_col),
            "hq": attrs["HQ"].astype(str) if "HQ" in attrs else None,
            "statut_src": attrs.get("STAND_BEZ"),
            "id_source": attrs.get("gml_id"),
            "attrs": attrs.apply(lambda r: json.dumps({k: (None if pd.isna(v) else v) for k, v in r.items()}, ensure_ascii=False, default=str), axis=1),
        }, geometry=g.geometry.values, crs=CRS_WORK)
        print(f"     kept {len(out)} inside the study area; status values: {out.statut.value_counts().to_dict()}")
        parts.append(out)
    return pd.concat(parts, ignore_index=True)


def download_nrw():
    """The zip is downloaded once and checked against the size the server announces."""
    RAW.mkdir(parents=True, exist_ok=True)
    zp = RAW / "uesg_EPSG25832_Shape.zip"
    head = requests.head(NRW_ZIP_URL, headers=HEADERS, timeout=60, allow_redirects=True)
    size, modified = int(head.headers["Content-Length"]), head.headers.get("Last-Modified")
    if not (zp.exists() and zp.stat().st_size == size):
        print(f"  downloading {NRW_ZIP_URL} ({size / 1e6:.1f} MB) ...")
        with requests.get(NRW_ZIP_URL, headers=HEADERS, timeout=300, stream=True) as r, open(zp, "wb") as f:
            r.raise_for_status()
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        if zp.stat().st_size != size:
            raise SystemExit("NRW download incomplete")
    LOG["nrw_zip"] = {"bytes": size, "last_modified_header": modified, "sha256": hashlib.sha256(zp.read_bytes()).hexdigest()}
    return zp


def load_nrw():
    zp = download_nrw()
    # the study-area box in the layer's own CRS (EPSG:25832), so the shapefile is read through a bbox filter and not entirely
    bb = tuple(gpd.GeoSeries([box(*BBOX_WGS84)], crs="EPSG:4326").to_crs(CRS_WORK).total_bounds)
    parts = []
    for layer, status in NRW_LAYERS.items():
        path = f"/vsizip/{zp.as_posix()}/{layer}.shp"
        info = pyogrio.read_info(path)
        g = pyogrio.read_dataframe(path, bbox=bb)
        print(f"  {layer}: CRS {info['crs']}, columns {list(info['fields'])}, {info['features']:,} objects in NRW, {len(g)} in the study area")
        LOG[layer] = {"crs": str(info["crs"]), "columns": list(info["fields"]), "objects_total": int(info["features"]), "objects_in_study_area": len(g)}
        if str(g.crs).upper() not in ("EPSG:25832",):
            g = g.to_crs(CRS_WORK)
        attrs = g.drop(columns="geometry")
        name = next((c for c in attrs.columns if c.lower() in ("gewaesser", "gew_name", "gewname", "name", "gewaessername", "gewässer")), None)
        idc = next((c for c in attrs.columns if c.lower() in ("objectid", "id", "gml_id", "uesg_id", "fid")), None)
        parts.append(gpd.GeoDataFrame({
            "land": "NRW", "statut": status, "couche": layer,
            "nom": attrs[name] if name else None, "hq": None, "statut_src": None,
            "id_source": attrs[idc].astype(str) if idc else None,
            "attrs": attrs.apply(lambda r: json.dumps({k: (None if pd.isna(v) else v) for k, v in r.items()}, ensure_ascii=False, default=str), axis=1),
        }, geometry=g.geometry.values, crs=CRS_WORK))
    return pd.concat(parts, ignore_index=True)


def main():
    ZONES.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    print("RLP ...")
    rlp = load_rlp()
    print("NRW ...")
    nrw = load_nrw()
    all_ = gpd.GeoDataFrame(pd.concat([rlp, nrw], ignore_index=True), geometry="geometry", crs=CRS_WORK)
    bad = ~all_.geometry.is_valid
    all_.loc[bad, "geometry"] = shapely.make_valid(all_.loc[bad, "geometry"].values)    # repair invalid polygons (needed for later overlays)
    all_ = all_[~all_.geometry.is_empty]
    all_["surface_ha"] = (all_.area / 1e4).round(2)
    out = ZONES / "uesg_de.gpkg"
    if out.exists():
        out.unlink()
    all_.to_file(out, layer="uesg_de", driver="GPKG")
    print(f"\nwrote {out}: {len(all_):,} objects, {int(bad.sum())} geometries repaired, CRS {all_.crs.to_string()}")
    print(all_.groupby(["land", "statut", "couche"]).agg(objets=("surface_ha", "size"), ha_somme=("surface_ha", "sum")).round(0).to_string())

    LOG["run"] = {"date": now, "bbox_wgs84": BBOX_WGS84, "objects": len(all_), "repaired": int(bad.sum())}
    (ZONES / "uesg_de_run.json").write_text(json.dumps(LOG, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("run log: data/official_zones/uesg_de_run.json (the SOURCE file is written from it)")


if __name__ == "__main__":
    main()
