# July 2021 floods: preparedness tool for civil protection

European AI Challenge 2026 (FARI / JRC). A single-page web tool built on the data of the July 2021 floods in Belgium, Germany and the Netherlands. It is addressed to a **regional civil protection authority**: it shows which communes had the most residents, buildings and critical sites inside the mapped flood, proposes where to focus preparedness and alert messages, finds areas that the flood cut off from hospitals, compares the 2021 flood with the official German flood zones, and plans routes to shelters that avoid the water. It is a planning aid, not a warning system: priorities and thresholds are the team's draft proposals, to be validated by the authority.

## The tool (`app/index.html`)

| Tab | What it shows |
|---|---|
| Overview | What the satellite maps cover per country, how to use the tool, communes to look at first. |
| Map | Observed 2021 flood outline, buildings and sites in or near the flood, top communes by residents in the flood. |
| Find a region | Search any commune of BE/DE/NL: its 2021 figures, modelled river-flood exposure, nearest communes with lower exposure. |
| My route | Drop a pin: routes on foot or by car to the nearest shelter or hospital, planned to avoid the flood data (computed in the browser). |
| Priority list | Communes ranked by residents, share of residents, buildings or vulnerable sites in the flood; response tier; CSV export and print. |
| Sites near the flood | OpenStreetMap sites (schools, hospitals, care homes, infrastructure...) inside the observed flood or within 100 m of it. |
| Islands (cut off) | Areas whose roads no longer reach a hospital once the flooded roads are closed, ranked by a draft rule. |
| Official flood zones (DE) | 2021 flood vs official flood zones of Rhineland-Palatinate and North Rhine-Westphalia: the "gap" and its exposure per commune and Land. |
| Live water levels | Current raw levels from official gauges (Wallonia, PEGELONLINE, Rijkswaterstaat, NRW, Waterschap Limburg; Flanders on request). |
| Alerts (inside Live water levels) | When a gauge crosses a level published by its own source (today NRW only), a strip on every tab says to stay away from nearby islands (level 1) or to consider leaving for a shelter outside the flood data (level 2); browser notifications while the page is open; a simulation mode. Not an official warning. |
| AI assistant (button on every tab) | Optional chat panel that answers from the app's own data through short tool calls (communes, priority areas, islands, official zones, live levels). Needs the local helper and a key in an environment variable, see `live/ASSISTANT.md`. |
| Advanced | Commune choropleth (response tier, exposure per 1,000, ...) and the underlying layers. |
| About | Sources, definitions, cut-offs and what the tool does not show. |

## Quick start

- **Use it:** open `app/index.html` in a browser. All data is embedded; no server is needed. An internet connection is needed for the map library (Leaflet 1.9.4 from cdnjs) and the Esri basemap tiles.
- **Rebuild it** (Python 3.13, standard library only): `py -3.13 src/build_app.py` (works from any folder). Output: `app/index.html`.
- **Live water levels:** start the local proxy `py -3.13 live/live_proxy.py` (127.0.0.1:8765, standard library only); without it three of the sources show "source unavailable". Details: `live/README_live.md`.
- **Theme:** one dark or light theme for the whole app, chosen with the sun/moon button in the top bar and remembered by the browser.
- **AI assistant:** the same local proxy serves it. The key is read from an environment variable and never reaches the page (`live/ASSISTANT.md`).
- **Streamlit:** the branch `streamlit-deploy` adds `streamlit_app.py`, `.streamlit/config.toml` and a `static/` copy of `app/`; main file path `streamlit_app.py`. The helper-based features (three live sources, NRW alerts, assistant) are not available there.
- **Re-run the data pipeline:** `pip install -r requirements.txt`, then the scripts below. They read the public challenge bucket `gs://datasets_challenge/working_data` anonymously and only read the windows they need.

## Pipeline (run order)

Commands run from the repository root, e.g. `python pipeline/prepare_hazard.py be nl de`. Parameters come from `config.json`.

| # | Script | Main inputs | Writes |
|---|---|---|---|
| 0 | `docs/references/how_to_get_started.ipynb` (starter notebook) | challenge bucket | `data/inventory/inventaire_ems.csv` (EMS file inventory), `data/flood/my_results.gpkg` (Belgian AOI). The notebook saves next to itself: move both into `data/`. |
| 1 | `fetch_country.py <cc>` | EMS observed flood, GHS-OBAT | `data/flood/stats_aoi_*.csv`, `classes_taille_*.csv`, `bats_eau_*.gpkg` |
| 2 | `fetch_rasters.py <cc>` | GHS-POP, EFAS | `data/population/exposure_pop_*.csv`, `data/flood/efas_check_*.csv` |
| 3 | `prepare_water.py be de nl` | EMS, EFAS | `data/flood/water_*.json` (flood outline + depth images) |
| 4 | `prepare_pop.py be de nl` | EMS, GHS-POP | `data/population/pop_*.json` |
| 5 | `prepare_lau.py be de nl` | `ext/lau_be_de_nl.gpkg`, step 1, GHS-POP, EFAS | `data/communes/lau_*.json` (commune metrics) |
| 6 | `prepare_hazard.py be nl de` | `ext/lau_be_de_nl.gpkg`, EFAS RP10/100/500, GHS-POP | `data/hazard/hazard_*.json` (modelled exposure, every commune) |
| 7 | `prepare_osm.py be` (then nl, de) | Geofabrik OSM extract (snapshot 2021-01-01) into `ext/osm_pbf/`, EMS | `data/osm/osm_poi_*.json`, `osm_summary_*.json` |
| 8 | `prepare_regions.py be` | steps 5 and 7, `ext/lau_be_de_nl.gpkg` | `data/osm/regions_*.json`, `sites_*.json` |
| 9 | `prepare_routing.py be` (then nl, de) | OSM extracts, EMS, EFAS | `app/routing_data/graph_*.js`, `data/routing/routing_*.meta.json` |
| 10 | `prepare_islands.py be nl de` | step 9 graphs, OSM, GHS-POP, `ext/lau_be_de_nl.gpkg` | `data/islands/islands.json` |
| 11 | `prepare_uesg.py` | RLP OGC API Features, NRW open-data zip | `data/official_zones/uesg_de.gpkg`, `uesg_de_run.json` |
| 12 | `prepare_gap.py` | step 11, EMS, GHS-OBAT, GHS-POP, `ext/lau_be_de_nl.gpkg` | `data/official_zones/gap_2021_vs_official.gpkg`, `exposure_by_municipality.csv`, `exposure_by_land.csv`, `uesg_app.json` |
| 13 | `build_report.py` | `data/` | `docs/flood_data_report.html` (printable data report) |
| 14 | `src/build_app.py` | `data/`, `src/`, `live/stations.json`, `config.json` | `app/index.html` |

`ext/` holds large external downloads and caches (git-ignored): the GISCO LAU 2023 boundaries `ext/lau_be_de_nl.gpkg` (downloaded by hand, not by a script) and the OSM extracts. `OSM_PBF_DIR` and `UESG_RAW_DIR` can move the big raw downloads out of a synced folder.

## Method in brief

1. Observed flood = union of all Copernicus EMS "observed event" outlines per country; only the mapped areas of interest (AOI) are assessed.
2. Buildings = GHS-OBAT points inside the flood or within `building_buffer_m` (15 m) of it; counted, not measured.
3. Residents = GHS-POP E2020 cells weighted by the flooded share of each cell (sub-cell sampling): an estimate.
4. Communes = Eurostat GISCO LAU 2023; per commune: flooded area, buildings, residents exposed, share of the flood inside the EFAS 100-year zone, mapped coverage.
5. Response tier: high if the exposure rate per 1,000 or the absolute number reaches the 90th percentile of flooded communes, medium from the 60th (`tier_percentiles`); high splits into 1A (under 50% of the flood inside the modelled zone) and 1B; low-exposure communes with under 50% mapped coverage become "no data", not "safe".
6. Modelled exposure ("Find a region"): share of residents in the EFAS 10/100/500-year zones; "higher" from 10% in the 100-year zone, "lower" under 2% in the 500-year zone (`hazard_higher_pct`, `hazard_lower_pct`).
7. Sites: OpenStreetMap tags by category, position "in the flood" or "within 100 m" (`poi_near_m`).
8. Routing principle (team choice): the flood data is the side to avoid. Roads outside the water data are assumed passable; roads inside get a heavy cost (observed flood x1000, 100-year zone x40, 500-year zone x6).
9. Islands: close every car road touching the observed flood; a connected road group with no hospital, that was connected to one before, with at least 100 residents, is an island; ranked by gaps (no fire station, no shelter, vulnerable site, at least 1,000 residents), then residents.
10. Official zones (DE): gap = 2021 flood minus legal zones (festgesetzt + vorläufig gesichert), clipped to the AOI, areas in EPSG:25832.

All choices are recorded in `config.json`; `docs/choix_interpretation.html` is the form in which the team made them.

## Data sources, licences and limits

| Data | Source | Licence / terms | Main limits |
|---|---|---|---|
| Observed flood 2021 | Copernicus EMS Rapid Mapping (EMSR518 BE, EMSR517 DE, EMSR520 NL) | European public data, free to use with credit | Snapshot on the satellite pass, not the peak; only requested areas mapped; misses floods in narrow valleys and towns. |
| Modelled flood hazard | EFAS flood hazard maps (RP10/100/500) | European public data, free to use with credit | Model, not the 2021 event; leaves out small rivers (under 500 km2) and heavy-rain flooding. |
| Buildings | GHS-OBAT R2024A (JRC) | European public data, free to use with credit | Not a complete register: counts are minimums. |
| Population | GHS-POP R2023A, E2020 (JRC) | European public data, free to use with credit | Modelled ~1 km cells, residents only; an estimate, rough for small areas. |
| Communes | Eurostat GISCO LAU 2023 | Eurostat GISCO terms | External source, not challenge data. |
| Sites and roads | OpenStreetMap via Geofabrik, snapshot 2021-01-01 | ODbL, (c) OpenStreetMap contributors | Volunteer data, incomplete; shelters' opening and capacity unknown. |
| Official flood zones (DE) | geoportal.rlp.de (RLP), opengeodata.nrw.de (NRW) | CC BY 4.0 (RLP), dl-de/zero-2-0 (NRW), to be re-checked | Statuses differ between Länder; "Risikogebiet außerhalb ÜSG" is not a legal zone; RLP and NRW only. |
| Live water levels | SPW Wallonie, WSV PEGELONLINE, Rijkswaterstaat, LANUK NRW, Waterschap Limburg, VMM | per source, see `live/SOURCES.md` | Raw, unvalidated; heights not comparable between gauges; some licences unverified. |
| Advice to residents | BE-Alert, Centre de Crise, BBK, Rijksoverheid (`src/actions.json`) | official public pages | Only what these pages say, linked to the source. |

Basemap: Esri World Light Gray tiles. Full source details: `docs/flood_data_report.html`, `live/SOURCES.md`, `data/official_zones/uesg_de_SOURCE.txt`.

## Repository map

```
README.md          this file
requirements.txt   third-party packages of the pipeline (the app build needs none)
config.json        the team's interpretation choices, read by the scripts and embedded in the app
app/               the built tool: index.html + routing_data/ (road graphs loaded on demand)
src/               app source: build_app.py, app_template.html, js/ (tabs, route, live), actions.json
pipeline/          data preparation scripts (fetch_*, prepare_*, build_report.py)
data/              generated inputs of the app, by kind: inventory, flood, population, hazard,
                   communes, osm, routing, official_zones, islands
live/              live water level proxy, smoke test, station catalogue, sources
docs/              data report, interpretation-choices form, references/ (data documentation, starter notebook), figures/ (team figures)
ext/               large external downloads and caches (not versioned)
```

## Not done / next steps

- Validate the response tiers, the island ranking and the routing penalties with the regional civil protection authority; they are drafts.
- Routing assumes that roads outside the water data stay open; road closures, landslides and capacity of shelters are not modelled.
- No damage assessment, no water depth or peak for 2021 (not in the challenge data).
- Satellite maps miss floods: some badly hit communes show no flood; a local flood record would make the islands and priorities more complete.
- Official flood zones cover only Rhineland-Palatinate and North Rhine-Westphalia; Belgian and Dutch equivalents were not added.
- Re-check the licences marked "to be re-checked" or "verify" (RLP, NRW, Wallonia, Rijkswaterstaat, VMM) before any publication.
- `data/official_zones/uesg_de.gpkg` (about 155 MB) is not versioned (GitHub size limit): re-create it with `pipeline/prepare_uesg.py`.
