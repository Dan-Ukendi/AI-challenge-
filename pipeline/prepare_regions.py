"""Per-commune summaries for the plain-language tabs (Belgium first): OpenStreetMap sites assigned to each commune.

Needs: geopandas shapely (run after prepare_lau.py and prepare_osm.py)
Run:   python pipeline/prepare_regions.py be
Writes data/osm/regions_<cc>.json  {lau_id: {"sites": {categorie: {position: n}}}}   (all sites, by position)
       data/osm/sites_<cc>.json    [ {name, type, categorie, position, lon, lat, lau_id, commune} ]   (only sites in the flood or within the near distance)
Both are read by src/build_app.py.
"""
import json
import sys
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parents[1]  # repository root
DATA = ROOT / "data"


def main(cc):
    lau_ids = [f["properties"]["lau_id"] for f in json.loads((DATA / "communes" / f"lau_{cc}.json").read_text(encoding="utf-8"))["features"]]
    # the original (unsimplified) boundaries: simplified ones would misassign sites near a border
    lau = gpd.read_file(ROOT / "ext" / "lau_be_de_nl.gpkg")
    lau = lau[lau.GISCO_ID.isin(lau_ids)][["GISCO_ID", "LAU_NAME", "geometry"]]
    poi = gpd.read_file(DATA / "osm" / f"osm_poi_{cc}.json")
    summary = json.loads((DATA / "osm" / f"osm_summary_{cc}.json").read_text(encoding="utf-8"))
    positions = summary["positions"]
    j = gpd.sjoin(poi, lau, predicate="within", how="left")
    j = j[~j.index.duplicated()]  # a point on a shared border would match two communes
    lost = int(j.GISCO_ID.isna().sum())

    regions = {i: {"sites": {c: {p: 0 for p in positions} for c in summary["categories"]}} for i in lau_ids}
    for _, r in j.dropna(subset=["GISCO_ID"]).iterrows():
        regions[r.GISCO_ID]["sites"][r.categorie][r.position] += 1
    # sites in or near the flood are all kept, even one that falls outside every listed commune (commune = None)
    flagged = [{"name": r["name"] if isinstance(r["name"], str) else None, "type": r["type"], "categorie": r.categorie, "position": r.position,
                "lon": round(r.geometry.x, 5), "lat": round(r.geometry.y, 5),
                "lau_id": r.GISCO_ID if isinstance(r.GISCO_ID, str) else None, "commune": r.LAU_NAME if isinstance(r.LAU_NAME, str) else None}
               for _, r in j.iterrows() if r.position != "outside"]
    (DATA / "osm").mkdir(parents=True, exist_ok=True)
    (DATA / "osm" / f"regions_{cc}.json").write_text(json.dumps(regions, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "osm" / f"sites_{cc}.json").write_text(json.dumps(flagged, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{cc}: {len(poi)} sites -> {len(poi) - lost} assigned to a commune ({lost} outside the {len(lau_ids)} communes), "
          f"{len(flagged)} in or near the flood")
    print("communes:", sorted(lau.LAU_NAME))


if __name__ == "__main__":
    for c in sys.argv[1:]:
        main(c.lower())
