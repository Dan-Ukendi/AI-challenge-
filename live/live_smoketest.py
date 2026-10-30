"""Smoke test of the live water level sources: one call per source, prints OK / KO (stdlib only).

  python live/live_smoketest.py            browser-direct sources directly; proxied sources through
                                      live_proxy.py if it runs on 127.0.0.1:8765, else directly from Python
  python live/live_smoketest.py --direct   proxied sources always called directly from Python
  python live/live_smoketest.py --vmm      also make ONE request to Flanders VMM (credit system: off by default)
"""
import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone

import live_proxy as P

KIWIS = "https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json"
PEGEL = "https://pegelonline.wsv.de/webservices/rest-api/v2/stations.json"
VMM = ("https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=1&format=json"
       "&request=getTimeseriesValueLayer&timeseriesgroup_id=192780&metadata=true")


def get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": P.UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def age(ts):
    m = (datetime.now(timezone.utc) - P.parse_ts(ts)).total_seconds() / 60
    return f"{m:.0f} min" if m < 180 else f"{m / 60:.1f} h"


def report(name, n_ok, n_all, newest, note=""):
    ok = n_ok > 0
    print(f"{'OK' if ok else 'KO'}  {name:<32} {n_ok}/{n_all} stations with a value"
          + (f", newest {newest} ({age(newest)} old)" if newest else "") + (f"  {note}" if note else ""))
    return ok


def wallonie():
    sts = P.stations_of("wallonie_kiwis")
    j = get_json(KIWIS + "&request=getTimeseriesValues&period=PT3H&returnfields=Timestamp,Value&ts_id=" + ",".join(s["ts_id"] for s in sts))
    rows = {x["ts_id"]: x["data"] for x in j}
    last = [rows[s["ts_id"]][-1] for s in sts if rows.get(s["ts_id"])]
    vals = [r for r in last if P.num(r[1]) is not None]
    return report("Wallonie SPW (browser-direct)", len(vals), len(sts), max((P.iso_utc(P.parse_ts(r[0])) for r in vals), default=None))


def pegelonline():
    sts = P.stations_of("pegelonline")
    j = get_json(PEGEL + "?includeTimeseries=true&includeCurrentMeasurement=true&ids=" + ",".join(s["station_id"] for s in sts))
    cur = [t["currentMeasurement"] for x in j for t in x.get("timeseries", []) if t.get("shortname") == "W" and t.get("currentMeasurement")]
    return report("PEGELONLINE WSV (browser-direct)", len(cur), len(sts), max((P.iso_utc(P.parse_ts(c["timestamp"])) for c in cur), default=None))


def proxied(key, use_proxy):
    code, n_all = P.SOURCES[key]["code"], len(P.stations_of(P.SOURCES[key]["code"]))
    try:
        if use_proxy:
            how, p = "via proxy", get_json(f"http://127.0.0.1:{P.PORT}/{key}", timeout=90)
        else:
            how, p = "direct from Python", P.FETCHERS[key]()
    except Exception as e:
        print(f"KO  {code:<32} {type(e).__name__}: {str(e)[:150]}")
        return False
    if "error" in p:
        print(f"KO  {code:<32} {p['error'][:150]}")
        return False
    recs = p["records"]
    extra = []
    if p.get("missing"):
        extra.append("no value for " + ",".join(p["missing"]))
    if key == "nrw":
        extra.append(f"{sum(1 for r in recs if r['alert_level'])} with source thresholds, {sum(1 for r in recs if r['trend'])} with trend")
    if p.get("warning"):
        extra.append(p["warning"])
    return report(f"{code} ({how})", len(recs), n_all, max((r["timestamp_utc"] for r in recs), default=None), "; ".join(extra))


def vmm():
    j = get_json(VMM, timeout=60)
    good = [x for x in j if P.num(x.get("ts_value")) is not None and x.get("timestamp")]
    return report("Flanders VMM (1 request)", len(good), len(j), max((P.iso_utc(P.parse_ts(x["timestamp"])) for x in good), default=None))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--direct", action="store_true")
    ap.add_argument("--vmm", action="store_true")
    a = ap.parse_args()
    use_proxy = False
    if not a.direct:
        try:
            use_proxy = get_json(f"http://127.0.0.1:{P.PORT}/health", timeout=3).get("ok", False)
        except Exception:
            print(f"(live_proxy.py not reachable on 127.0.0.1:{P.PORT}: proxied sources are called directly from Python)")
    tests = [wallonie, pegelonline, lambda: proxied("rws", use_proxy), lambda: proxied("nrw", use_proxy), lambda: proxied("limburg", use_proxy)]
    if a.vmm:
        tests.append(vmm)
    ok = 0
    for t in tests:
        try:
            ok += bool(t())
        except Exception as e:
            print(f"KO  {getattr(t, '__name__', 'source'):<32} {type(e).__name__}: {str(e)[:150]}")
    print(f"{ok}/{len(tests)} sources OK")
    sys.exit(0 if ok == len(tests) else 1)


if __name__ == "__main__":
    main()
