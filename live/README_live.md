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

Files: `live/live_proxy.py`, `live/live_smoketest.py`, `src/js/app_live.js` (the tab), `live/stations.json` (station catalogue, embedded into the page at build time), `live/SOURCES.md` (URLs, licences, limits, gaps).
