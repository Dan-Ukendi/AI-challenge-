"""Small local proxy for the "Live water levels" tab (Python standard library only).

Three official sources send no CORS header, so a web page cannot read them directly:
  /rws      Rijkswaterstaat ddapi20, latest water level (5-10 min), Maas stations
  /nrw      LANUK NRW hochwasserportal.nrw, 15-min levels + the source's own information levels
  /limburg  Waterschap Limburg open data, DAILY summaries (not real time)
The proxy fetches them, keeps only the stations listed in live/stations.json, converts them to the common
schema of the tab and answers with Access-Control-Allow-Origin: *.

Safety: binds to 127.0.0.1 only, answers GET on the fixed paths above only (no URL parameter, no open relay),
upstream URLs are hard-coded and whitelisted, every upstream call has a timeout, answers are cached 10-15 min.

Run:  python live/live_proxy.py            (port 8765)
      python live/live_proxy.py --port 8766
"""
import argparse
import io
import json
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent   # live/
HOST, PORT = "127.0.0.1", 8765
STALE_H = 3                      # a real-time value older than this is "old data"
DAILY_STALE_D = 3                # a daily value older than this many days is "old data"
UA = "flood-explorer-live-proxy/1.0 (local, non-commercial)"
MAX_BYTES = 40 * 1024 * 1024     # refuse absurd upstream answers

RWS_URL = "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen"
NRW_ZIP = "https://www.hochwasserportal.nrw/data/downloads/messwerte.zip"
NRW_META = "https://www.hochwasserportal.nrw/lanuv/data/internet/stations/stations.json"
LIMBURG_OBS = "https://api.waterschaplimburg.nl/opendata/v1/waterstanden/waarnemingen"
ALLOWED_HOSTS = {"ddapi20-waterwebservices.rijkswaterstaat.nl", "www.hochwasserportal.nrw", "hochwasserportal.nrw",
                 "api.waterschaplimburg.nl"}

SOURCES = {
    "rws": {"code": "rijkswaterstaat_ddapi20", "name": "Rijkswaterstaat", "ttl": 600,
            "page": "https://waterinfo.rws.nl/",
            "licence": "Rijkswaterstaat open data (CC0 under the RWS open data policy; not stated in the API response, verify). Source: Rijkswaterstaat"},
    "nrw": {"code": "nrw_lanuv", "name": "LANUK NRW (hochwasserportal.nrw)", "ttl": 600,
            "page": "https://hochwasserportal.nrw/",
            "licence": "Datenlizenz Deutschland Zero 2.0 (dl-de/zero-2-0), as stated by the hochwasserportal.nrw web application. Source: LANUK NRW"},
    "limburg": {"code": "waterschap_limburg_open_data", "name": "Waterschap Limburg (open data)", "ttl": 900,
                "page": "https://www.waterstandlimburg.nl/",
                "licence": "CC0 1.0 (open.waterschaplimburg.nl). Source: Waterschap Limburg"},
}


def load_stations():
    return json.loads((HERE / "stations.json").read_text(encoding="utf-8"))


STATIONS = load_stations()


def stations_of(code):
    return [s for s in STATIONS if s["source"] == code]


# ---------------- helpers ----------------
def http(url, data=None, headers=None, timeout=20):
    """GET (or POST when data is given) a whitelisted URL; follows redirects only inside the whitelist."""
    if urllib.parse.urlsplit(url).hostname not in ALLOWED_HOSTS:
        raise ValueError("upstream host not whitelisted")
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if urllib.parse.urlsplit(r.geturl()).hostname not in ALLOWED_HOSTS:
            raise ValueError("redirected outside the whitelist")
        body = r.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError("upstream answer too large")
    return body


def parse_ts(s):
    """ISO 8601 with offset (or Z) -> aware datetime in UTC."""
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        raise ValueError("timestamp without offset: " + s)
    return d.astimezone(timezone.utc)


def iso_utc(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) < 1e6 else None   # rejects NaN and absurd values


def trend_of(series, step):
    """series: [(utc datetime, value)] sorted. Compare the latest value with the one about 1 h earlier.
    step: change below which the level is called steady (same unit as the values)."""
    if len(series) < 2:
        return None
    t1, v1 = series[-1]
    cands = [(abs((t1 - t - timedelta(hours=1)).total_seconds()), t, v) for t, v in series[:-1]
             if timedelta(minutes=45) <= t1 - t <= timedelta(minutes=90)]
    if not cands:
        return None
    _, t0, v0 = min(cands, key=lambda c: c[0])
    d = v1 - v0
    return {"direction": "rising" if d >= step else "falling" if d <= -step else "steady",
            "change": round(d, 3), "minutes": int((t1 - t0).total_seconds() // 60),
            "method": "computed by this app: latest value minus the value about 1 hour earlier"}


def record(st, src, ts, value, unit, source_url, trend=None, alert=None, daily=False, extra=None):
    now = datetime.now(timezone.utc)
    stale = (now - ts > timedelta(days=DAILY_STALE_D)) if daily else (now - ts > timedelta(hours=STALE_H))
    rec = {"source": st["source"], "source_name": src["name"], "country": st["country"], "region": st["region"],
           "station_id": st["station_id"], "station_name": st["station_name"], "river": st["river"],
           "lat": st["lat"], "lon": st["lon"], "timestamp_utc": iso_utc(ts), "value": value, "unit": unit,
           "reference": st["reference"], "trend": trend, "alert_level": alert, "is_stale": stale,
           "source_url": source_url, "official_url": src["page"], "licence": src["licence"], "daily": daily}
    rec.update(extra or {})
    return rec


# ---------------- adapters (one per source, all return the common schema) ----------------
def fetch_rws():
    src, sts = SOURCES["rws"], stations_of("rijkswaterstaat_ddapi20")
    body = {"LocatieLijst": [{"Code": s["station_id"]} for s in sts],
            "AquoPlusWaarnemingMetadataLijst": [{"AquoMetadata": {"Compartiment": {"Code": "OW"}, "Grootheid": {"Code": "WATHTE"}}}]}
    # no key is needed (verified); a dummy X-API-KEY header is sent as requested by the project brief
    raw = http(RWS_URL, json.dumps(body).encode(), {"Content-Type": "application/json", "X-API-KEY": "dummy"}, timeout=25)
    j = json.loads(raw)
    best = {}
    for w in j.get("WaarnemingenLijst") or []:
        md = w.get("AquoMetadata", {})
        # many series per location: keep the live one (F007) relative to NAP, then the newest value
        if md.get("Hoedanigheid", {}).get("Code") != "NAP" or md.get("WaardeBepalingsMethode", {}).get("Code") != "other:F007":
            continue
        if md.get("Eenheid", {}).get("Code") != "cm":
            continue
        code = w.get("Locatie", {}).get("Code")
        for m in w.get("MetingenLijst") or []:
            v = num(m.get("Meetwaarde", {}).get("Waarde_Numeriek"))
            try:
                t = parse_ts(m["Tijdstip"])
            except (KeyError, ValueError):
                continue
            if v is None or v > 9e8:      # RWS uses 999999999 as "no value"
                continue
            if code not in best or t > best[code][0]:
                best[code] = (t, v, m.get("WaarnemingMetadata", {}).get("Statuswaarde"))
    recs, missing = [], []
    for s in sts:
        if s["station_id"] not in best:
            missing.append(s["station_id"])
            continue
        t, v, status = best[s["station_id"]]
        recs.append(record(s, src, t, v, "cm", RWS_URL, extra={"source_status": status}))
    return {"records": recs, "missing": missing}


_nrw_meta = {"t": 0, "data": None}


def nrw_thresholds():
    """station_no -> the source's own information levels (cm); refreshed once a day."""
    if _nrw_meta["data"] is None or time.time() - _nrw_meta["t"] > 86400:
        meta = json.loads(http(NRW_META, timeout=30).decode("utf-8"))   # UTF-8, not the Windows default
        _nrw_meta["data"] = {m.get("station_no"): m for m in meta if isinstance(m, dict)}
        _nrw_meta["t"] = time.time()
    return _nrw_meta["data"]


def fetch_nrw():
    src, sts = SOURCES["nrw"], stations_of("nrw_lanuv")
    want = {s["station_id"] for s in sts}
    zf = zipfile.ZipFile(io.BytesIO(http(NRW_ZIP, timeout=40)))
    name = next(n for n in zf.namelist() if n.lower().endswith(".txt"))
    series = {k: [] for k in want}
    with zf.open(name) as f:
        for line in io.TextIOWrapper(f, encoding="utf-8", errors="replace"):
            no, _, rest = line.partition(";")
            if no not in want:
                continue
            ts, _, val = rest.strip().partition(";")
            v = num(val)
            try:
                t = parse_ts(ts)
            except ValueError:
                continue
            if v is not None:
                series[no].append((t, v))
    try:
        meta, meta_err = nrw_thresholds(), None
    except Exception as e:  # thresholds are optional: the levels still show, without colour
        meta, meta_err = {}, f"thresholds unavailable: {e}"
    recs, missing = [], []
    for s in sts:
        ser = sorted(series[s["station_id"]])
        if not ser:
            missing.append(s["station_id"])
            continue
        t, v = ser[-1]
        m = meta.get(s["station_id"]) or {}
        th = [num(m.get(f"LANUV_Info_{i}")) for i in (1, 2, 3)]
        alert = None
        if any(x is not None for x in th):
            level = sum(1 for x in th if x is not None and v >= x)
            alert = {"level": level, "max_level": 3, "thresholds": th, "unit": "cm",
                     "scheme": "LANUK information levels 1-3 (Informationswert), the source's own thresholds"}
        extra = {"source_remark": (m.get("INTERNET_BEMERKUNG") or "").strip() or None}
        recs.append(record(s, src, t, v, "cm", NRW_ZIP, trend=trend_of(ser, 1.0), alert=alert, extra=extra))
    out = {"records": recs, "missing": missing}
    if meta_err:
        out["warning"] = meta_err
    return out


def fetch_limburg():
    src, sts = SOURCES["limburg"], stations_of("waterschap_limburg_open_data")
    want = {s["station_id"] for s in sts}
    best = {}
    for o in json.loads(http(LIMBURG_OBS, timeout=40).decode("utf-8")):
        lid = o.get("locationId")
        if lid not in want:
            continue
        try:
            t = parse_ts(o["observationTimestamp"])
        except (KeyError, ValueError):
            continue
        if lid not in best or t > best[lid][0]:
            best[lid] = (t, o.get("values") or {})
    recs, missing = [], []
    for s in sts:
        if s["station_id"] not in best:
            missing.append(s["station_id"])
            continue
        t, vals = best[s["station_id"]]
        v = num(vals.get("average"))
        if v is None:
            missing.append(s["station_id"])
            continue
        daily = {k: num(vals.get(k)) for k in ("min", "max", "first", "last", "average")}
        recs.append(record(s, src, t, v, "m", LIMBURG_OBS, daily=True,
                           extra={"daily_values": daily, "value_kind": "daily average (the day starting at timestamp_utc)"}))
    return {"records": recs, "missing": missing}


FETCHERS = {"rws": fetch_rws, "nrw": fetch_nrw, "limburg": fetch_limburg}


# ---------------- cache ----------------
_cache = {k: {"t": 0, "payload": None} for k in FETCHERS}
_locks = {k: threading.Lock() for k in FETCHERS}


def get(key):
    """Cached payload for one source. On upstream failure, serve the last good answer (marked) if any."""
    src, c = SOURCES[key], _cache[key]
    with _locks[key]:   # one upstream call at a time per source
        if c["payload"] and time.time() - c["t"] < src["ttl"]:
            return 200, {**c["payload"], "cached": True}
        try:
            p = FETCHERS[key]()
            p.update({"source": src["code"], "fetched_utc": iso_utc(datetime.now(timezone.utc)), "cache_seconds": src["ttl"]})
            c["payload"], c["t"] = p, time.time()
            return 200, {**p, "cached": False}
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:300]
            if c["payload"]:
                return 200, {**c["payload"], "cached": True, "upstream_error": msg}
            return 502, {"source": src["code"], "error": "the official service did not answer: " + msg}


class Handler(BaseHTTPRequestHandler):
    server_version = "live-proxy/1.0"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        # refuse requests whose Host header is not this machine (protects against DNS rebinding)
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden host"})
        path = urllib.parse.urlsplit(self.path).path.strip("/")
        if path in ("", "health"):
            return self._send(200, {"ok": True, "endpoints": ["/" + k for k in FETCHERS],
                                    "cache_seconds": {k: v["ttl"] for k, v in SOURCES.items()}})
        if path not in FETCHERS:
            return self._send(404, {"error": "unknown endpoint"})
        self._send(*get(path))

    def do_POST(self):
        self._send(405, {"error": "GET only"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[live_proxy] %s %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args()
    srv = ThreadingHTTPServer((HOST, a.port), Handler)
    print(f"live proxy on http://{HOST}:{a.port}  (endpoints: /rws /nrw /limburg /health; Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
