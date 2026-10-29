# Flood Data Explorer

Interactive map and report on the July 2021 floods in Belgium, Germany and the Netherlands (European AI Challenge 2026).
It shows the observed flood, modelled water depth, residents exposed, buildings near the flood, and a draft response tier per commune.

## Open it
- **App:** open `app/index.html` in a browser (needs internet for the map tiles and Leaflet), or run
  `python -m http.server 8000 --directory app` and go to http://localhost:8000
- **Report:** open `flood_data_report.html` (self-contained, printable).

## What is in the data
| Layer | Source | Notes |
|---|---|---|
| Observed flood | Copernicus EMS Rapid Mapping (EMSR517 / 518 / 520) | All "observed event" files merged (DEL + GRA, several dates). Only mapped areas of interest (AOIs): lower bound. |
| Modelled depth | EFAS flood hazard maps (10 / 100 / 500-year) | Model, not the 2021 event. |
| Buildings | GHS-OBAT R2024A | Points within 15 m of the observed flood. Not a complete register; counted, not measured. |
| Population | GHS-POP R2023A, 2020 | Residents only; each ~1 km cell weighted by its flooded share. |
| Communes, names, official population | Eurostat GISCO LAU 2023 | **External source**, not challenge data. |
| Resident actions | Official civil-protection pages (BBK, BE-Alert, Rijksoverheid) | **External source**; links in `actions.json`. |

## Response tiers (draft)
Per commune, from residents exposed per 1,000 inhabitants **or** the absolute number of residents exposed (thresholds are percentiles of this partial sample, not official limits), and the share of the flood inside the EFAS 100-year zone. Communes mostly outside the mapped areas are shown grey, "no data" (unknown, not safe). Tiers and message focus are drafts to validate with the responsible authority.

## Parameters
All interpretation choices are in `config.json`; resident actions and their sources are in `actions.json`.

## Rebuild
Needs `gcsfs pyogrio rasterio geopandas shapely`. The challenge bucket is public and read anonymously.
```
python fetch_country.py be      # also de, nl: flood stats and buildings within the buffer
python prepare_water.py be de nl
python prepare_pop.py be de nl
python prepare_lau.py be de nl  # needs ext/lau_be_de_nl.gpkg (GISCO LAU 2023, not in this repo)
python build_app.py && python build_report.py
```
(`fetch_rasters.py` produces the population and EFAS check tables used by the report.)

## Limits
Observed water covers only the mapped AOIs on the day of the satellite pass (Germany 16, Belgium 2, Netherlands 1), so everything is a lower bound and low values can mean "not mapped". OBAT undercounts buildings in Belgium. Population and buildings are not independent. EFAS cannot separate "not modelled" from "no flood".
