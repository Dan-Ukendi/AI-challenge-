## Live water levels tab

The tab **Live water levels** shows the current water levels published by official services in the areas hit in July 2021 (Wallonia, German federal waterways, North Rhine-Westphalia, Dutch Maas and Limburg streams). Raw, unvalidated data, for information only: it is not a warning tool.

**1. Start the small proxy** (needed for Rijkswaterstaat, NRW and Waterschap Limburg, which do not allow direct reading from a web page). From the repository root:

```
python live/live_proxy.py
```

(on this computer `python` may not be on the PATH: use `py -3.13 live/live_proxy.py`). It listens on `http://127.0.0.1:8765`, only on this computer, and only answers `/rws`, `/nrw`, `/limburg` and `/health`. Leave the window open; stop it with Ctrl+C. Python standard library only, nothing to install.

**2. Open the app**: build it with `py -3.13 src/build_app.py` if needed, then either open `app/index.html` directly, or serve it with `py -3.13 -m http.server 8000 --directory app` and open http://localhost:8000/#live. Click **Live water levels**.

Without the proxy the tab still works: Wallonia and PEGELONLINE are read directly, and the three other sources show the badge "source unavailable (start live_proxy.py)". Offline, every source shows "source unavailable". Values refresh every 10 minutes while the tab is open (button "Refresh now" for an immediate refresh). Flanders (VMM) is loaded only on click, with one request, because that service limits downloads.

**3. Check the sources** (one call each, prints OK / KO):

```
python live/live_smoketest.py            # proxied sources through the proxy if it runs, else directly
python live/live_smoketest.py --direct   # proxied sources directly from Python
python live/live_smoketest.py --vmm      # also one request to Flanders VMM
```

**Alerts.** The tab also has an **Alerts** section, and an alert strip appears under the top banner on every tab: level 1 (watch: stay away from the islands near the gauge) and level 2 (consider leaving for a shelter outside our flood data, link to My route). Thresholds come only from the source (today the 16 NRW gauges with LANUK information levels, so `live_proxy.py` must run) or from validated team entries in `live/alert_thresholds.json` (empty by default; rebuild after editing). Alerts work only while the page is open; tick "Watch the water levels in the background" to re-check every 10 minutes on any tab, and click "Enable browser notifications" for a browser notification when a gauge moves up a level (may be refused when the page is opened as a file). A simulation control shows the alerts for a demonstration, marked "SIMULATION, not real data". Not an official warning: details in `live/SOURCES.md`, section "Alerts".

Files: `live/live_proxy.py`, `live/live_smoketest.py`, `src/js/app_live.js` (the tab), `src/js/app_alerts.js` (alerts), `live/alert_thresholds.json` (team draft thresholds, empty), `live/stations.json` (station catalogue, embedded into the page at build time), `live/SOURCES.md` (URLs, licences, limits, gaps).
