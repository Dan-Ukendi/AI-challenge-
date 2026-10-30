"""Small local proxy for the "Live water levels" tab (Python standard library only).

Three official sources send no CORS header, so a web page cannot read them directly:
  /rws      Rijkswaterstaat ddapi20, latest water level (5-10 min), Maas stations
  /nrw      LANUK NRW hochwasserportal.nrw, 15-min levels + the source's own information levels
  /limburg  Waterschap Limburg open data, DAILY summaries (not real time)
The proxy fetches them, keeps only the stations listed in live/stations.json, converts them to the common
schema of the tab and answers with Access-Control-Allow-Origin: *.

Safety: binds to 127.0.0.1 only, answers GET on the fixed paths above only (no URL parameter, no open relay),
upstream URLs are hard-coded and whitelisted, every upstream call has a timeout, answers are cached 10-15 min.

It also serves the in-app assistant (see live/ASSISTANT.md):
  POST /chat              forwards one Messages API request. The key is read from the environment variable
                          ANTHROPIC_API_KEY at request time and never reaches the page. Server-side limits:
                          model, max_tokens, body size, tools, turns per session, requests per hour.
  GET  /assistant/health  {"configured": true/false, "model": ..., "web_search": false}  (never the key)

Run:  python live/live_proxy.py            (port 8765)
      python live/live_proxy.py --port 8766
"""
import collections
import os
import re
import argparse
import io
import json
import sys
import threading
import time
import urllib.error
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


# ---------------- assistant: POST /chat (forwarding with server-side limits) ----------------
# Every limit is enforced here, whatever the page sends. Nothing of a request or answer is logged.
ASSISTANT_UPSTREAM_DEFAULT = "https://api.anthropic.com/v1/messages"
# the tools the page defines (live/ASSISTANT.md); any other tool, or a server tool, is refused
ASSISTANT_TOOLS = {"get_commune", "search_communes", "get_priority_areas", "get_islands", "get_official_zone_gap",
                   "get_alerts", "get_live_levels", "get_dataset_limits", "render_chart"}
ASSISTANT_KEYS = {"model", "max_tokens", "system", "tools", "messages"}   # top-level fields the page may send
ALLOWED_ORIGIN = re.compile(r"^(null|https?://(localhost|127\.0\.0\.1)(:\d{1,5})?)$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def env_int(name, default, lo, hi):
    try:
        v = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        v = default
    return max(lo, min(hi, v))


def assistant_cfg():
    """Read at request time, so a change of the environment needs no code change (the key is never stored)."""
    models = [m.strip() for m in os.environ.get("ASSISTANT_MODEL", "claude-sonnet-5-5").split(",") if m.strip()] or ["claude-sonnet-5-5"]
    upstream = os.environ.get("ASSISTANT_UPSTREAM", "").strip() or ASSISTANT_UPSTREAM_DEFAULT
    return {"models": models, "upstream": upstream,
            "max_tokens": env_int("ASSISTANT_MAX_TOKENS", 1024, 64, 2048),
            "max_body": env_int("ASSISTANT_MAX_BODY", 200_000, 10_000, 1_000_000),
            "session_turns": env_int("ASSISTANT_SESSION_TURNS", 30, 1, 1000),
            "hourly": env_int("ASSISTANT_HOURLY", 120, 1, 10_000),
            "timeout": env_int("ASSISTANT_TIMEOUT", 60, 5, 300),
            "effort": os.environ.get("ASSISTANT_EFFORT", "low").strip(),
            "web_search": os.environ.get("ASSISTANT_WEB_SEARCH", "").strip() == "1"}


def upstream_ok(url):
    """The key is only ever sent to the official API host over HTTPS, or to a local mock server (tests)."""
    u = urllib.parse.urlsplit(url)
    return (u.scheme == "https" and u.hostname == "api.anthropic.com") or (u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost"))


def key_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


_usage = {"lock": threading.Lock(), "sessions": collections.OrderedDict(), "hour": collections.deque()}


def take_turn(session, cfg):
    """Count one request; returns (ok, error code, turns used). Rolling one-hour window for the global budget."""
    now = time.time()
    with _usage["lock"]:
        hour, sess = _usage["hour"], _usage["sessions"]
        while hour and now - hour[0] > 3600:
            hour.popleft()
        used = sess.get(session, 0)
        if used >= cfg["session_turns"]:
            return False, "session_turn_cap", used
        if len(hour) >= cfg["hourly"]:
            return False, "hourly_budget", used
        hour.append(now)
        sess[session] = used + 1
        sess.move_to_end(session)
        while len(sess) > 2000:   # bounded memory
            sess.popitem(last=False)
        return True, None, used + 1


def check_chat(body, cfg):
    """Validate one /chat body; returns (error message or None, cleaned body)."""
    if not isinstance(body, dict):
        return "body must be a JSON object", None
    extra = set(body) - ASSISTANT_KEYS
    if extra:
        return "field not allowed: " + ", ".join(sorted(extra)), None
    model = body.get("model") or cfg["models"][0]
    if model not in cfg["models"]:
        return "model not allowed", None
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs or len(msgs) > 40:
        return "messages must be a list of 1 to 40 entries", None
    if any(not isinstance(m, dict) or m.get("role") not in ("user", "assistant") for m in msgs):
        return "each message needs the role user or assistant", None
    tools = body.get("tools") or []
    if not isinstance(tools, list) or len(tools) > 16:
        return "tools must be a list of at most 16 entries", None
    for t in tools:
        if not isinstance(t, dict):
            return "tool not allowed", None
        ttype = t.get("type")
        if ttype in (None, "custom") and t.get("name") in ASSISTANT_TOOLS:
            continue
        if isinstance(ttype, str) and ttype.startswith("web_search_") and cfg["web_search"]:
            continue
        return "tool not allowed: " + str(t.get("name") or ttype)[:60], None
    system = body.get("system")
    if system is not None and not isinstance(system, (str, list)):
        return "system must be text", None
    try:
        mt = int(body.get("max_tokens") or cfg["max_tokens"])
    except (TypeError, ValueError):
        return "max_tokens must be a number", None
    out = {"model": model, "max_tokens": max(1, min(mt, cfg["max_tokens"])), "messages": msgs}
    if system:
        out["system"] = system
    if tools:
        out["tools"] = tools
    if cfg["effort"] in ("low", "medium", "high"):
        out["output_config"] = {"effort": cfg["effort"]}
    return None, out


def forward_chat(payload, cfg):
    """One upstream call. Returns (status, bytes). Upstream errors are passed on as they are (they never contain the key)."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    req = urllib.request.Request(cfg["upstream"], data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
                                          "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=cfg["timeout"]) as r:
            status, data = r.status, r.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            data = e.read(256 * 1024)
            json.loads(data)
        except Exception:
            data = json.dumps({"error": "upstream_error", "status": e.code}).encode()
    except Exception as e:   # timeout, DNS, refused: the type only (no request content)
        status = 504 if "timed out" in str(e).lower() else 502
        data = json.dumps({"error": "upstream_unreachable", "detail": type(e).__name__}).encode()
    if key and key.encode() in data:   # belt and braces: the key is never sent back
        data = data.replace(key.encode(), b"[removed]")
    return status, data


class Handler(BaseHTTPRequestHandler):
    server_version = "live-proxy/1.0"

    def _send(self, code, obj, origin="*", extra=None):
        body = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", origin)
        if origin != "*":
            self.send_header("Vary", "Origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _chat_origin(self):
        """/chat answers only pages of this computer: file:// (Origin "null"), http://localhost or 127.0.0.1. None = refused."""
        o = self.headers.get("Origin")
        if o is None:
            return "null"   # not a browser (a local script): no CORS needed
        return o if ALLOWED_ORIGIN.match(o) else None

    def _chat(self):
        origin = self._chat_origin()
        if origin is None:
            return self._send(403, {"error": "forbidden_origin"})
        cfg = assistant_cfg()
        if not key_configured():
            return self._send(503, {"error": "assistant_not_configured",
                                    "message": "Assistant offline: start live/live_proxy.py with ANTHROPIC_API_KEY set"}, origin)
        if not upstream_ok(cfg["upstream"]):
            return self._send(500, {"error": "upstream_not_allowed"}, origin)
        if "json" not in (self.headers.get("Content-Type") or ""):
            return self._send(415, {"error": "content_type_must_be_json"}, origin)
        try:
            n = int(self.headers.get("Content-Length") or "-1")
        except ValueError:
            n = -1
        if n < 0:
            return self._send(411, {"error": "content_length_required"}, origin)
        if n > cfg["max_body"]:
            if n <= 5 * 1024 * 1024:   # drain (and discard) so the client can read the answer
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(left, 65536))
                    if not chunk:
                        break
                    left -= len(chunk)
            self.close_connection = True
            return self._send(413, {"error": "body_too_large", "max_bytes": cfg["max_body"]}, origin)
        session = self.headers.get("X-Session") or ""
        if not SESSION_RE.match(session):
            return self._send(400, {"error": "bad_session_header"}, origin)
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {"error": "invalid_json"}, origin)
        err, payload = check_chat(body, cfg)
        if err:
            return self._send(400, {"error": "invalid_request", "message": err}, origin)
        ok, code, used = take_turn(session, cfg)
        info = {"X-Assistant-Turns": str(used), "X-Assistant-Cap": str(cfg["session_turns"]),
                "Access-Control-Expose-Headers": "X-Assistant-Turns, X-Assistant-Cap"}
        if not ok:
            return self._send(429, {"error": code, "turns": used, "cap": cfg["session_turns"], "hourly": cfg["hourly"]}, origin, info)
        status, data = forward_chat(payload, cfg)
        self._send(status, data, origin, info)

    def _host_ok(self):
        # refuse requests whose Host header is not this machine (protects against DNS rebinding)
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost")

    def do_OPTIONS(self):
        if urllib.parse.urlsplit(self.path).path.strip("/") == "chat":   # preflight of the assistant: same origins as POST /chat
            origin = self._chat_origin()
            if origin is None or not self._host_ok():
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Session")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            return
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
        if path == "assistant/health":   # says only whether a key is set, never the key or any part of it
            cfg = assistant_cfg()
            return self._send(200, {"configured": key_configured(), "model": cfg["models"][0], "web_search": cfg["web_search"],
                                    "max_tokens": cfg["max_tokens"], "session_turns": cfg["session_turns"], "hourly": cfg["hourly"]})
        if path not in FETCHERS:
            return self._send(404, {"error": "unknown endpoint"})
        self._send(*get(path))

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden host"})
        if urllib.parse.urlsplit(self.path).path.strip("/") == "chat":
            return self._chat()
        self._send(405, {"error": "GET only"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[live_proxy] %s %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args()
    srv = ThreadingHTTPServer((HOST, a.port), Handler)
    print(f"live proxy on http://{HOST}:{a.port}  (endpoints: /rws /nrw /limburg /health; Ctrl+C to stop)")
    print(f"assistant: POST /chat, key {'found' if key_configured() else 'NOT set (the assistant shows offline)'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
