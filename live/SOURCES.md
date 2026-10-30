# Live water levels: sources, licences, limits and gaps

For the policy brief and the AI sheet. Facts checked on 29 Oct 2026 (about 21:50-23:15 UTC) against real answers of each service; the station catalogue is in `stations.json` (58 stations, every id taken from a real answer).

**What the tab is and is not.** It shows the latest raw value that each official service publishes, unchanged. It is *not* a warning tool, the values are unvalidated, and heights cannot be compared between stations (each gauge has its own reference). The banner on the tab says so.

## Summary

| # | Source | Area | Access from the page | Update | Stations | Licence (status) |
|---|---|---|---|---|---|---|
| 1 | SPW Wallonie, KiWIS | Vesdre, Hoegne, Ourthe, Amblève, Meuse (BE) | direct (CORS `*`) | 10 min (Verviers, Theux, Hoegne: hourly) | 15 | not stated by the service (verify) |
| 2 | WSV PEGELONLINE | Rhine, Moselle federal waterways (DE) | direct (CORS `*`) | 15 min | 10 | dl-de/zero-2-0 (checked on the terms page) |
| 3 | Rijkswaterstaat ddapi20 | Maas, Dutch Limburg | through `live_proxy.py` (no CORS) | 10 min | 5 | CC0 under RWS open data policy (not in the answer; verify) |
| 4 | VMM Flanders, KiWIS | Flanders (BE) | direct, **optional, one request on click** | 15 min | not in catalogue (about 800 gauges with coordinates come from the answer) | not verified |
| 5 | LANUK NRW, hochwasserportal.nrw | Erft, Inde, Vicht, Wupper, Volme, Lenne, Hönne, Sieg, Swist, Olef (DE) | through `live_proxy.py` (no CORS) | 15 min | 20 | dl-de/zero-2-0 as stated by the portal (see discrepancy) |
| 6 | RLP, Bavaria, Saxony, joint German portal | Ahr and others (DE) | **links only**, no data read | - | - | - |
| 7 | Waterschap Limburg open data | Geul, Gulp, Selzerbeek (NL) | through `live_proxy.py` (no CORS) | **daily summary** | 8 | CC0 1.0 (stated on the open data page) |

## 1. SPW Wallonie (hydrometrie.wallonie.be)

- API: `https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=getTimeseriesValues&ts_id=<ids>&period=PT3H&returnfields=Timestamp,Value` (one request for the 15 stations). Human page: https://hydrometrie.wallonie.be/home.html
- Series: `05-Hauteur.Complet` (water height, metres). The 3 h window is needed because Verviers (L7150), Theux (L5860) and Hoegne (L5861) report hourly or lag about 1 h.
- Reference: height above the gauge's own zero, **except Liège (7102) and Namur (8001), which publish an absolute height** (about 60 m and 78.5 m; the datum is not stated).
- Trend: the service has a `990-Hauteur.Tendance` series but its values (0/1) are undocumented, so the app does **not** use it; it computes its own trend (see "Methods").
- Alert thresholds: `Hauteur.Alarme.Seuil1-4` series exist for some stations but return no values, so **no colour code** for Wallonia.
- July 2021 peak: the app reads the source's own `998-Hauteur.CrueDeReference.Top3` series for July 2021 (one request, `from=2021-07-01&to=2021-08-01`) and shows it in the station popup, e.g. Verviers 2.09 m on 14 Jul 2021, Theux 3.96 m. It compares a gauge only with itself; gauges rebuilt after 2021 may have a new zero, so the popup says so.
- Limits: 250 000 values per request; `Cache-Control: max-age=300`.
- Licence: not stated in the answers. Credit: "Service public de Wallonie (SPW MI), hydrometrie.wallonie.be". **Verify the reuse terms before publishing.**

## 2. WSV PEGELONLINE (pegelonline.wsv.de)

- API: `https://pegelonline.wsv.de/webservices/rest-api/v2/stations.json?ids=<uuids>&includeTimeseries=true&includeCurrentMeasurement=true` (one request for the 10 stations) plus `/stations/<uuid>/W/measurements.json?start=PT3H` per station for the trend (10 small requests). Human page per gauge: `https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=<number>` (checked: HTTP 200 for Trier).
- Unit and reference: cm above the gauge zero (PNP); the altitude of the gauge zero (m above NHN) is shown in the popup.
- No trend field in the API: computed by the app.
- `stateMnwMhw` (low / normal / high relative to mean low and mean high water) is shown as text, not as a colour. The characteristic values M_I, M_II, M_III are shipping marks (navigation limits), not flood warning levels, so **no colour code** for PEGELONLINE.
- Licence: the terms page https://www.pegelonline.wsv.de/gast/nutzungsbedingungen states **Datenlizenz Deutschland Zero 2.0** (read on 29 Oct 2026). Credit anyway: "WSV, pegelonline.wsv.de".

## 3. Rijkswaterstaat (ddapi20)

- API: `POST https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen` (no key needed; a dummy `X-API-KEY` header is sent). No CORS header, not even on the pre-flight: only reachable through `live_proxy.py` (`GET /rws`). Human page: https://waterinfo.rws.nl/
- The answer mixes about 60 series for 5 locations (live and historic, NAP and TAW). The proxy keeps `Hoedanigheid = NAP`, `WaardeBepalingsMethode = other:F007` (live 10-min mean), unit cm, newest time per location.
- Stations: `maastricht.sintpieter`, `eijsden.grens`, `roermond.boven`, `steyl` (Belfeld beneden), `venlo`. Plain `maastricht` and `roermond` have no live water level.
- Unit and reference: cm relative to NAP. Values are flagged "Ongecontroleerd" (not checked), shown in the popup.
- No trend and no thresholds in this endpoint.
- Licence: CC0 under the Rijkswaterstaat open data policy, **not stated in the answer: verify**. Credit: "Rijkswaterstaat".
- Quirk: the RWS catalogue describes its only WATHTE metadata as "t.o.v. Mean Sea Level", while the live answers say NAP.

## 4. VMM Flanders (waterinfo.be), optional

- API: `https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=1&format=json&request=getTimeseriesValueLayer&timeseriesgroup_id=192780&metadata=true` (group "WEBLayer_Download_Waterstand_15m", id found with `getGroupList`). CORS `*`. About 345 KB, 1 085 series.
- The service limits downloads with a credit system (amounts not published). The tab therefore makes **no request unless the user clicks "Load Flanders"**, and then exactly one (the browser test counted one).
- The answer gives unit (m) but not the reference level; the app says "reference level not stated". The gauges are not in our catalogue, so no commune matching was done; they appear as small dots on the map only.
- Licence: not verified. Credit: "Vlaamse Milieumaatschappij (VMM), waterinfo.be".
- Requests used while building: 1 by the probe, 5 to find the request (group list, 3 rejected parameter tries, 1 value layer), 2 by the browser tests (one click each).

## 5. LANUK NRW (hochwasserportal.nrw)

- Data: `https://www.hochwasserportal.nrw/data/downloads/messwerte.zip` (follows a 302; 1 MB zip, one 12 MB text file `station_no;time;value(cm)`, the last 7 days at 15 min for 254 stations). Metadata: `https://www.hochwasserportal.nrw/lanuv/data/internet/stations/stations.json` (571 KB, UTF-8). No CORS: through `live_proxy.py` (`GET /nrw`), which keeps only our 20 stations. Human page: https://hochwasserportal.nrw/
- Unit and reference: cm above the gauge's own zero (`GAUGE_DATUM` mostly empty).
- **Alert thresholds: yes, the source's own.** `LANUV_Info_1/2/3` (information levels 1-3, cm). The tab colours a station yellow, orange or red only when the source's level 1, 2 or 3 is reached; below level 1 it stays plain blue (never "green = safe"). Four stations have no thresholds: Roetgen_W, Hagen-Ambrock, Balve-Garbeck, Balve_Helle.
- The source's own remark is shown when present (e.g. Altena: gauge permanently damaged, data supplied provisionally).
- Limits: the whole 12 MB file is read at each refresh (cached 10 min by the proxy; thresholds cached 24 h).
- Licence: see the discrepancy below.

## 6. No open data service: official portals (links only)

Rhineland-Palatinate https://hochwasser.rlp.de/ (Ahr: Ahrweiler, Altenahr, Schuld), Bavaria https://www.hnd.bayern.de/, Saxony https://www.umwelt.sachsen.de/umwelt/infosysteme/hwims/portal/web/wasserstand-uebersicht, all German states https://www.hochwasserzentralen.de/ (all answered HTTP 200). No documented open API was found for RLP; the `lhpapi` Python package scrapes an undocumented service and is **not used**.

## 7. Waterschap Limburg open data

- API: `https://api.waterschaplimburg.nl/opendata/v1/waterstanden/waarnemingen` (2.2 MB, about 15 days of daily summaries). No CORS: through `live_proxy.py` (`GET /limburg`, cached 15 min). Human page: https://www.waterstandlimburg.nl/
- **Daily summary only, not real time**: one value per day (min, max, first, last, average), published once a day (about 02:00 UTC), so the newest value is 1-2 days old. The tab shows the daily average with the badge "daily value, not real time" and a dashed marker.
- Unit not stated; values (about 67 m at Valkenburg) suggest m NAP: shown as "probably above NAP (the source does not state it)".
- Licence: **CC0 1.0** (open data page); the source disclaims liability for errors. Credit: "Waterschap Limburg".

## Licence discrepancies and open questions

1. **NRW**: it is often assumed to be "Datenlizenz Deutschland Namensnennung 2.0" (dl-de/by-2-0), but the hochwasserportal.nrw web application states **Datenlizenz Deutschland Zero 2.0** (dl-de/zero-2-0). We found no separate legal page confirming either; we credit LANUK NRW in any case.
2. **PEGELONLINE**: the probe first guessed dl-de/by-2-0; the official terms page states **dl-de/zero-2-0**. The tab uses the terms page.
3. **Rijkswaterstaat** (CC0) and **Wallonia** (unknown) are not stated in the API answers: to verify before any publication.
4. **VMM**: not verified.

## Stations: missing or uncertain matches

The tab marks uncertain matches with the badge "nearby station" and never claims a gauge is in a commune when it is not.

- **No station at all**: Trooz (nearest Chaudfontaine, downstream, and Pepinster, upstream), Spa (6538 "Spa aerodrome" measures rain only), Esneux (shown: Comblain-au-Pont upstream, Sauheid downstream), Plettenberg (shown: Roenkhausen, upstream on the Lenne), Neuenrade (shown: Balve-Garbeck and Balve_Helle on the Hönne), a gauge named Euskirchen (shown: Arloff, on the Erft in the municipality), the Ahr (RLP: link only).
- **Uncertain** (catalogue flag): Hoegne L5861, Pepinster Pont SNCB (on the Hoegne, not the Vesdre), Namur (river not confirmed), Arloff, Mulartshuette and Roetgen_W (Vichtbach), Roenkhausen, Balve-Garbeck, Balve_Helle, Valkenburg Polfermolen, Wittem (Selzerbeek), Hommerich.
- **Not probed**: a second Liège station (5491).
- **Seen stale on 29 Oct 2026**: Schin op Geul (10.H.199), newest daily value 17 Oct 2026 (badge "old data").

## Methods used by the app (for the AI sheet)

- **Common schema** for every source: `source, country, region, station_id, station_name, river, lat, lon, timestamp_utc, value, unit, reference, trend, alert_level, is_stale, source_url, licence` (plus `official_url`, `daily` and a few display extras).
- **Old data**: a real-time value older than 3 hours; a daily value older than 3 days.
- **Trend** (Wallonia, PEGELONLINE, NRW): latest value minus the value about 1 hour earlier (between 45 and 90 minutes); under 1 cm is "steady". Computed by the app, not by the sources. No trend for Rijkswaterstaat (endpoint gives only the last value) or Limburg (daily).
- **Colours**: only from the source's own thresholds (NRW). No thresholds are invented and heights are never ranked or compared across stations.
- **Station positions** come from the catalogue coordinates (`stations.json`), not from geocoding.
- Every value is checked (finite number, valid time) and every text is escaped before display. One source failing never blocks the others; the page shows "source unavailable" badges instead of errors, also offline.

## Test results (29 Oct 2026, about 22:10-22:20 UTC)

`live_smoketest.py` (through the proxy and directly from Python, same result):

```
OK  Wallonie SPW (browser-direct)    15/15 stations with a value, newest 2026-10-29T22:00:00Z (8 min old)
OK  PEGELONLINE WSV (browser-direct) 10/10 stations with a value, newest 2026-10-29T22:00:00Z (8 min old)
OK  rijkswaterstaat_ddapi20 (via proxy) 5/5 stations with a value, newest 2026-10-29T21:50:00Z (18 min old)
OK  nrw_lanuv (via proxy)            20/20 stations with a value, newest 2026-10-29T22:00:00Z (8 min old)  16 with source thresholds, 20 with trend
OK  waterschap_limburg_open_data (via proxy) 8/8 stations with a value, newest 2026-10-28T00:00:00Z (46.1 h old)
5/5 sources OK
```

Headless Chrome test of the built page: 58/58 stations with a value (served over http and opened as a local file); with the proxy blocked, Wallonia and PEGELONLINE still show (25 stations) and the three proxied sources show "source unavailable (start live_proxy.py)"; offline, every source shows "source unavailable (you are offline)" and the page keeps working; "Load Flanders" made exactly one request (801 gauges with coordinates and a level).
