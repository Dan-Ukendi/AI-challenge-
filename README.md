# Flood Data Explorer

Interactive map and report on the July 2021 floods in Belgium, Germany and the Netherlands (European AI Challenge 2026).
Plain-language tabs for Belgium (overview, map, search a commune, priority list, sites near the flood, about) and an
"Advanced" explorer for all three countries.

## Open it
- **App:** open `app/index.html` in a browser, or serve it: `python -m http.server 8000 --directory app` then http://localhost:8000.
  Needs internet for the map background and Leaflet. The backgrounds are Esri tiles, which also work when the file is opened from disk
  (OpenStreetMap's own tile server blocks pages opened as local files, so it is not used).
- **Report:** open `flood_data_report.html` (self-contained, printable).

## Tabs (Belgium)
| Tab | What it answers |
|---|---|
| Overview | Headline numbers and how to use the tool |
| Map | Communes coloured by priority, flood outline, most affected communes |
| Find a region | Any Belgian commune: modelled flood exposure (higher / some / lower, never "safe"), what the 2021 satellite map shows, official advice, nearest communes with lower exposure |
| Priority list | Mapped communes ranked by residents in the flood, CSV download |
| Sites near the flood | Schools, hospitals, care homes and other OpenStreetMap sites in or within 100 m of the flood |
| Advanced | The explorer for BE, DE and NL (layers, tiers, population, buildings, depth) |
| About | Sources, definitions and limits |

## Data
| Layer | Source | Notes |
|---|---|---|
| Observed flood | Copernicus EMS Rapid Mapping (EMSR517 / 518 / 520) | All "observed event" files merged (DEL + GRA, several dates). Only the mapped areas (AOIs): a lower bound. Satellite maps can miss floods in narrow valleys and towns. |
| Modelled flood zones | EFAS flood hazard maps (10 / 100 / 500-year) | A model, not the 2021 event. Leaves out small rivers (catchments under 500 km2). |
| Buildings | GHS-OBAT R2024A | Points within 15 m of the observed flood. Not a complete register; counted, not measured. |
| Population | GHS-POP R2023A, 2020 | Residents only; each ~1 km cell weighted by its flooded share. |
| Communes, names, official population | Eurostat GISCO LAU 2023 | External source, not challenge data. |
| Sites (schools, hospitals, shelters...) | OpenStreetMap via a Geofabrik extract, state of 2021-01-01 | External source. (c) OpenStreetMap contributors, ODbL. Incomplete by nature. |
| Advice to residents | BE-Alert, BBK, Rijksoverheid official pages | External source; links in `actions.json`. |

Figures show what was inside the mapped flood, **not damage**: the challenge data has no damage assessment.

## Parameters
Interpretation choices (buffer, thresholds, OSM snapshot, shelter tags, ...) are in `config.json`; resident actions and their sources in `actions.json`.
The shelter tags are a plain list of `key=value` texts (`shelter_tags`).

## Rebuild
Needs `gcsfs pyogrio rasterio geopandas shapely pyosmium`. The challenge bucket is public and read anonymously.
External files, not in this repo: the Eurostat LAU 2023 boundaries (`ext/lau_be_de_nl.gpkg`) and the Geofabrik extract (downloaded by `prepare_osm.py`).
```
python fetch_country.py be      # also de, nl: flood stats and buildings within the buffer
python prepare_water.py be de nl
python prepare_pop.py be de nl
python prepare_lau.py be de nl
python prepare_osm.py be        # OSM sites (downloads a 0.4 GB extract for Belgium)
python prepare_regions.py be    # assigns sites to communes
python prepare_hazard.py be     # modelled flood exposure of every commune
python build_app.py && python build_report.py
```
(`fetch_rasters.py` produces the population and EFAS check tables used by the report.)

## Limits
Observed water covers only the mapped AOIs on the day of the satellite pass (Germany 16, Belgium 2, Netherlands 1), so everything is a lower bound and
low values can mean "not mapped" or "not detected". OBAT undercounts buildings in Belgium. Population and buildings are not independent.
EFAS cannot separate "not modelled" from "no flood". Priority levels are relative (percentiles across the three countries), not official limits.
This is planning information, not a warning system: in a real flood follow the authorities' instructions (BE-Alert in Belgium).
