// ---------- Live water levels: current levels from official services (raw data, not a warning tool) ----------
// Stations: live/stations.json, embedded by build_app.py (every id comes from a real answer of the source).
// Wallonia (SPW KiWIS) and PEGELONLINE are read directly by the browser; Rijkswaterstaat, NRW and Waterschap Limburg
// go through live_proxy.py on this computer (they send no CORS header). One source failing never blocks the others.
// Only top-level constants here: functions run after app_tabs.js has defined esc, fmt and newMap.
const LIVE_STATIONS = /*LIVE_STATIONS*/[];
const LIVE_PROXY = "http://127.0.0.1:8765";
const LIVE_STALE_H = 3, LIVE_DAILY_STALE_D = 3, LIVE_REFRESH_MIN = 10;
const LIVE_KIWIS = "https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json";
const LIVE_PEGEL = "https://pegelonline.wsv.de/webservices/rest-api/v2/";
const LIVE_VMM = "https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=1&format=json&request=getTimeseriesValueLayer&timeseriesgroup_id=192780&metadata=true";
const LIVE_SRC = {
  wallonie_kiwis: { name: "SPW Wallonie (hydrometrie.wallonie.be)", short: "Wallonia (SPW)", via: "direct", page: "https://hydrometrie.wallonie.be/home.html",
    licence: "Licence not stated by the service; please credit Service public de Wallonie (SPW MI), hydrometrie.wallonie.be" },
  pegelonline: { name: "WSV PEGELONLINE (federal waterways)", short: "Germany, Rhine and Moselle (WSV)", via: "direct", page: "https://www.pegelonline.wsv.de/",
    licence: "Datenlizenz Deutschland Zero 2.0 (pegelonline.wsv.de terms of use). Source: WSV" },
  rijkswaterstaat_ddapi20: { name: "Rijkswaterstaat", short: "Netherlands, Maas (Rijkswaterstaat)", via: "proxy", path: "/rws", page: "https://waterinfo.rws.nl/" },
  nrw_lanuv: { name: "LANUK NRW (hochwasserportal.nrw)", short: "North Rhine-Westphalia (LANUK)", via: "proxy", path: "/nrw", page: "https://hochwasserportal.nrw/" },
  waterschap_limburg_open_data: { name: "Waterschap Limburg (open data)", short: "Dutch Limburg streams (Waterschap, daily)", via: "proxy", path: "/limburg", page: "https://www.waterstandlimburg.nl/" },
  vmm_kiwis: { name: "VMM Flanders (waterinfo.be)", short: "Flanders (VMM), optional", via: "lazy", page: "https://www.waterinfo.be/",
    licence: "Licence not verified; please credit Vlaamse Milieumaatschappij (VMM), waterinfo.be" },
};
const LIVE_REF_SHORT = { wallonie_kiwis: "above the gauge's own zero", pegelonline: "above the gauge zero", rijkswaterstaat_ddapi20: "above NAP (Dutch reference level)",
  nrw_lanuv: "above the gauge's own zero", waterschap_limburg_open_data: "probably above NAP (the source does not state it)", vmm_kiwis: "reference level not stated in the answer" };
const LIVE_COUNTRY = { BE: "Belgium", DE: "Germany", NL: "Netherlands" };
const LIVE_REGION = { "federal waterway": "Federal waterways: Rhine and Moselle", "Limburg": "Limburg (Netherlands)" };
// used ONLY with the source's own thresholds; below level 1 stays plain blue (no "green = safe" message)
const LIVE_ALERT_COL = ["#1f6feb", "#f59f00", "#e8590c", "#c92a2a"];
const LIVE_PORTALS = [
  ["Rhineland-Palatinate (Ahr, Ahrweiler, Altenahr, Moselle tributaries)", "https://hochwasser.rlp.de/", "Landesamt für Umwelt RLP"],
  ["Bavaria", "https://www.hnd.bayern.de/", "Hochwassernachrichtendienst Bayern"],
  ["Saxony", "https://www.umwelt.sachsen.de/umwelt/infosysteme/hwims/portal/web/wasserstand-uebersicht", "Landeshochwasserzentrum Sachsen"],
  ["All German states (joint portal)", "https://www.hochwasserzentralen.de/", "Länderübergreifendes Hochwasserportal"],
];
const LIVE = { map: null, layer: null, vmmLayer: null, recs: {}, status: {}, peak2021: null, timer: null, busy: false, vmmLoaded: false };

// --- small helpers ---
async function liveFetch(url, ms, opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctl.signal });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.http = r.status; try { e.body = await r.json(); } catch (_) {} throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
const liveNum = x => { const v = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN; return Number.isFinite(v) && Math.abs(v) < 1e6 ? v : null; };
const liveTime = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const liveKey = r => r.source + ":" + r.station_id;
// trend = latest value minus the value about 1 h earlier (45-90 min); "steady" under 1 cm. Same rule as live_proxy.py.
function liveTrend(series, step) {
  if (series.length < 2) return null;
  const [t1, v1] = series[series.length - 1];
  let best = null;
  for (const [t, v] of series.slice(0, -1)) { const dt = t1 - t; if (dt >= 45 * 6e4 && dt <= 90 * 6e4 && (!best || Math.abs(dt - 36e5) < Math.abs(t1 - best[0] - 36e5))) best = [t, v]; }
  if (!best) return null;
  const d = v1 - best[1];
  return { direction: d >= step ? "rising" : d <= -step ? "falling" : "steady", change: Math.round(d * 1000) / 1000, minutes: Math.round((t1 - best[0]) / 6e4),
    method: "computed by this app: latest value minus the value about 1 hour earlier" };
}
// one record of the common schema; returns null if the value or the time is not valid
function liveRec(st, o) {
  const value = liveNum(o.value), t = liveTime(o.timestamp);
  if (value === null || t === null) return null;
  const daily = !!o.daily, ageH = (Date.now() - t) / 36e5;
  return { source: st.source, country: st.country, region: st.region, station_id: st.station_id, station_name: st.station_name, river: st.river,
    lat: st.lat, lon: st.lon, timestamp_utc: new Date(t).toISOString(), value, unit: o.unit, reference: st.reference, trend: o.trend || null,
    alert_level: o.alert_level || null, is_stale: daily ? ageH > 24 * LIVE_DAILY_STALE_D : ageH > LIVE_STALE_H, daily,
    source_url: o.source_url, official_url: o.official_url || LIVE_SRC[st.source].page, licence: o.licence || LIVE_SRC[st.source].licence, extra: o.extra || {} };
}

// --- adapters: one per source, each returns { recs:[...], note } or throws ---
async function liveWallonie() {
  const sts = LIVE_STATIONS.filter(s => s.source === "wallonie_kiwis");
  // 3 h window: some stations (Verviers, Theux, Hoegne) report hourly or lag about 1 h
  const url = LIVE_KIWIS + "&request=getTimeseriesValues&period=PT3H&returnfields=Timestamp,Value&ts_id=" + sts.map(s => encodeURIComponent(s.ts_id)).join(",");
  const [j, peak] = await Promise.all([liveFetch(url, 20000), liveWalPeak(sts)]);
  const rows = {}; (Array.isArray(j) ? j : []).forEach(x => { rows[x.ts_id] = Array.isArray(x.data) ? x.data : []; });
  const recs = [];
  sts.forEach(s => {
    const ser = (rows[s.ts_id] || []).map(r => [liveTime(r[0]), liveNum(r[1])]).filter(r => r[0] !== null && r[1] !== null).sort((a, b) => a[0] - b[0]);
    if (!ser.length) return;
    const last = ser[ser.length - 1];
    const r = liveRec(s, { value: last[1], timestamp: new Date(last[0]).toISOString(), unit: "m", trend: liveTrend(ser, 0.01), source_url: url,
      extra: peak && peak[s.reference_flood_ts_id] ? { peak2021: peak[s.reference_flood_ts_id] } : {} });
    if (r) recs.push(r);
  });
  return { recs, total: sts.length };
}
// highest level of July 2021 at the same gauge, from the source's own "reference flood" series (one request, once per page load)
async function liveWalPeak(sts) {
  if (LIVE.peak2021) return LIVE.peak2021;
  try {
    const j = await liveFetch(LIVE_KIWIS + "&request=getTimeseriesValues&from=2021-07-01&to=2021-08-01&returnfields=Timestamp,Value&ts_id=" + sts.map(s => encodeURIComponent(s.reference_flood_ts_id)).join(","), 15000);
    const out = {};
    (Array.isArray(j) ? j : []).forEach(x => { const best = (x.data || []).map(r => [liveTime(r[0]), liveNum(r[1])]).filter(r => r[0] !== null && r[1] !== null).sort((a, b) => b[1] - a[1])[0];
      if (best) out[x.ts_id] = { value: best[1], time: new Date(best[0]).toISOString() }; });
    return (LIVE.peak2021 = out);
  } catch (e) { return null; }   // optional extra: never blocks the levels
}
async function livePegel() {
  const sts = LIVE_STATIONS.filter(s => s.source === "pegelonline");
  const url = LIVE_PEGEL + "stations.json?includeTimeseries=true&includeCurrentMeasurement=true&ids=" + sts.map(s => encodeURIComponent(s.station_id)).join(",");
  const j = await liveFetch(url, 20000), byId = {};
  (Array.isArray(j) ? j : []).forEach(x => { byId[x.uuid] = x; });
  // PEGELONLINE has no trend field: the last 3 h of each gauge (small requests, in parallel, failures ignored)
  const hist = await Promise.all(sts.map(s => liveFetch(LIVE_PEGEL + "stations/" + encodeURIComponent(s.station_id) + "/W/measurements.json?start=PT3H", 15000).catch(() => null)));
  const recs = [];
  sts.forEach((s, i) => {
    const x = byId[s.station_id], w = x && (x.timeseries || []).find(t => t.shortname === "W");
    const c = w && w.currentMeasurement; if (!c) return;
    const ser = (hist[i] || []).map(m => [liveTime(m.timestamp), liveNum(m.value)]).filter(r => r[0] !== null && r[1] !== null).sort((a, b) => a[0] - b[0]);
    const gz = w.gaugeZero && liveNum(w.gaugeZero.value);
    const r = liveRec(s, { value: c.value, timestamp: c.timestamp, unit: w.unit === "cm" ? "cm" : String(w.unit || ""), trend: liveTrend(ser, 1), source_url: url,
      official_url: /^\d+$/.test(String(x.number || "")) ? "https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=" + x.number : null,
      extra: { state: c.stateMnwMhw || null, gauge_zero: gz !== null && gz !== undefined ? fmt(gz, 3) + " " + (w.gaugeZero.unit || "") : null } });
    if (r) recs.push(r);
  });
  return { recs, total: sts.length };
}
async function liveProxy(code) {
  const sts = LIVE_STATIONS.filter(s => s.source === code), byId = {};
  sts.forEach(s => { byId[s.station_id] = s; });
  let p;
  try { p = await liveFetch(LIVE_PROXY + LIVE_SRC[code].path, code === "nrw_lanuv" ? 60000 : 40000); }
  catch (e) {
    if (e.http) throw new Error((e.body && e.body.error) || "the official service did not answer through the proxy");
    throw Object.assign(new Error("source unavailable (start live_proxy.py)"), { proxyDown: true });
  }
  const recs = [];
  (p.records || []).forEach(o => {
    const s = byId[o.station_id]; if (!s) return;   // only stations of our catalogue
    const r = liveRec(s, { value: o.value, timestamp: o.timestamp_utc, unit: o.unit === "cm" || o.unit === "m" ? o.unit : "", trend: o.trend, alert_level: liveAlert(o.alert_level),
      daily: o.daily, source_url: o.source_url, licence: o.licence,
      extra: { state: o.source_status || null, remark: o.source_remark || null, daily_values: o.daily_values || null } });
    if (r) recs.push(r);
  });
  return { recs, total: sts.length, note: p.upstream_error ? "kept from an earlier answer: " + p.upstream_error : p.warning || "" };
}
function liveAlert(a) {   // validate the thresholds sent by the proxy (NRW information levels)
  if (!a || !Array.isArray(a.thresholds)) return null;
  const th = a.thresholds.map(liveNum), level = liveNum(a.level);
  return th.some(x => x !== null) && level !== null ? { level: Math.max(0, Math.min(3, Math.round(level))), thresholds: th, unit: a.unit === "cm" ? "cm" : "", scheme: String(a.scheme || "") } : null;
}
// Flanders: credit-limited service, so it is only loaded on request, with ONE request
async function liveVmm() {
  const j = await liveFetch(LIVE_VMM, 30000), recs = [];
  (Array.isArray(j) ? j : []).forEach(x => {
    const lat = liveNum(x.station_latitude), lon = liveNum(x.station_longitude);
    if (lat === null || lon === null || x.parametertype_name !== "H") return;
    const st = { source: "vmm_kiwis", country: "BE", region: "Flanders", station_id: String(x.station_no || x.ts_id), station_name: String(x.station_name || ""), river: "", lat, lon,
      reference: "unit " + String(x.ts_unitsymbol || "?") + "; reference level not stated in the answer" };
    const r = liveRec(st, { value: x.ts_value, timestamp: x.timestamp, unit: String(x.ts_unitsymbol || ""), source_url: LIVE_VMM });
    if (r) recs.push(r);
  });
  return { recs, total: Array.isArray(j) ? j.length : 0 };
}

// --- display ---
const liveTimeText = iso => { const t = Date.parse(iso), m = Math.round((Date.now() - t) / 6e4);
  return new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " <span class=\"muted\">(" +
    (m < 90 ? m + " min ago" : m < 72 * 60 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago") + ")</span>"; };
const liveValText = r => (r.unit === "m" ? r.value.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fmt(r.value, 1)) + " " + esc(r.unit);
// Liege and Namur publish an absolute height, the other Walloon gauges a height above their own zero
const liveRefShort = r => /^ABSOLUTE/.test(r.reference || "") ? "absolute height (datum not stated by the source)" : LIVE_REF_SHORT[r.source] || "";
function liveTrendText(r) {
  if (r.daily) return "daily value, no trend";
  if (!r.trend) return "trend not available";
  const cm = Math.round(r.unit === "m" ? r.trend.change * 100 : r.trend.change), chg = cm === 0 ? "no change" : (cm > 0 ? "+" : "") + fmt(cm) + " cm";
  return `${r.trend.direction === "rising" ? "&#8599; rising" : r.trend.direction === "falling" ? "&#8600; falling" : "&#8594; steady"} (${chg} in ${r.trend.minutes} min)`;
}
function liveAlertText(a) {
  const th = a.thresholds.map((x, i) => x === null ? null : `level ${i + 1}: ${fmt(x)} ${esc(a.unit)}`).filter(Boolean).join(", ");
  return a.level === 0 ? `Below the source's information level 1 <span class="muted">(${th})</span>` : `<b>Source's information level ${a.level} reached</b> <span class="muted">(${th})</span>`;
}
const liveColour = r => r.is_stale ? "#adb5bd" : r.alert_level ? LIVE_ALERT_COL[r.alert_level.level] : "#1f6feb";
function liveBadges(r, st) {
  let b = "";
  if (r && r.daily) b += ` <span class="lv-badge lv-daily">daily value, not real time</span>`;
  if (r && r.is_stale) b += ` <span class="lv-badge lv-old">old data</span>`;
  if (st && st.commune_match_confidence === "uncertain") b += ` <span class="lv-badge lv-near" title="${esc(st.note || "")}">nearby station</span>`;
  return b;
}
function livePopup(r, st) {
  const row = (k, v) => v ? `<tr><td class="muted" style="padding-right:8px;vertical-align:top">${k}</td><td>${v}</td></tr>` : "";
  const src = LIVE_SRC[r.source], e = r.extra || {}, dv = e.daily_values;
  return `<div style="max-width:320px"><b>${esc(r.station_name)}</b>${r.river ? ` <span class="muted">${esc(r.river)}</span>` : ""}${liveBadges(r, st)}
    <table style="font-size:12.5px;margin-top:6px">
    ${row(r.daily ? "Daily average" : "Water level", `<b>${liveValText(r)}</b> ${esc(liveRefShort(r))}`)}
    ${row("Reference", esc(r.reference))}
    ${row(r.daily ? "Day" : "Measured", r.daily ? esc(r.timestamp_utc.slice(0, 10)) + " (UTC day)" : liveTimeText(r.timestamp_utc) + `<br><span class="muted">${esc(r.timestamp_utc)}</span>`)}
    ${dv ? row("Day min / max", `${fmt(dv.min, 2)} / ${fmt(dv.max, 2)} m`) : ""}
    ${row("Trend", liveTrendText(r))}
    ${row("Source thresholds", r.alert_level ? liveAlertText(r.alert_level) : "none published by this source")}
    ${e.state ? row(r.source === "pegelonline" ? "Source status" : "Data status", esc(e.state) + (r.source === "pegelonline" ? ` <span class="muted">(vs mean low / mean high water)</span>` : "")) : ""}
    ${e.gauge_zero ? row("Gauge zero", esc(e.gauge_zero)) : ""}
    ${e.peak2021 ? row("July 2021 peak here", `${fmt(e.peak2021.value, 2)} m on ${esc(e.peak2021.time.slice(0, 10))} <span class="muted">(source's reference-flood series; the gauge may have been rebuilt since)</span>`) : ""}
    ${e.remark ? row("Source remark", esc(e.remark)) : ""}
    ${st && st.commune_match_confidence === "uncertain" ? row("Location note", esc(st.note || "nearby station, not in the commune itself")) : ""}
    ${row("Source", `<a href="${esc(r.official_url)}" target="_blank" rel="noopener">${esc(src.name)}</a>`)}
    ${row("Licence", esc(r.licence || ""))}
    </table></div>`;
}
function liveSourcesHtml() {
  return Object.keys(LIVE_SRC).map(k => {
    const s = LIVE.status[k] || { state: k === "vmm_kiwis" ? "off" : "loading" }, src = LIVE_SRC[k];
    const txt = s.state === "loading" ? "loading..." : s.state === "off" ? "not loaded (credit-limited service)" : s.state === "down" ? esc(s.msg) :
      `${s.n} of ${s.total} stations` + (s.note ? ` <span class="muted">(${esc(s.note)})</span>` : "");
    const cls = s.state === "ok" ? "lv-ok" : s.state === "down" ? "lv-down" : "lv-wait";
    return `<li><span class="lv-badge ${cls}">${s.state === "ok" ? "OK" : s.state === "down" ? "unavailable" : s.state === "off" ? "off" : "..."}</span> <b>${esc(src.short)}</b>: ${txt}</li>`;
  }).join("");
}
function liveRender() {
  document.getElementById("liveSrc").innerHTML = liveSourcesHtml();
  const vm = document.getElementById("liveVmm"); if (vm) vm.disabled = LIVE.vmmLoaded || LIVE.status.vmm_kiwis?.state === "loading";
  // list grouped by country, then region; stations keep the catalogue order (never sorted by height)
  const groups = {};
  LIVE_STATIONS.forEach(st => { ((groups[st.country] = groups[st.country] || {})[st.region] = groups[st.country][st.region] || []).push(st); });
  let html = "";
  ["BE", "DE", "NL"].filter(c => groups[c]).forEach(c => {
    html += `<h3 class="lv-country">${LIVE_COUNTRY[c]}</h3>`;
    Object.keys(groups[c]).forEach(reg => {
      html += `<h4 class="lv-region">${esc(LIVE_REGION[reg] || reg)}</h4>`;
      groups[c][reg].forEach(st => {
        const k = st.source + ":" + st.station_id, r = LIVE.recs[k], s = LIVE.status[st.source];
        const val = r ? `<b>${liveValText(r)}</b> <span class="muted">${esc(liveRefShort(r))}</span>` :
          `<span class="muted">${!s || s.state === "loading" ? "loading..." : s.state === "down" ? "source unavailable" : "no recent value from the source"}</span>`;
        const when = r ? (r.daily ? "day of " + esc(r.timestamp_utc.slice(0, 10)) : liveTimeText(r.timestamp_utc)) + " &middot; " + liveTrendText(r) : "";
        html += `<div class="lv-row" data-k="${esc(k)}"><span class="lv-dot" style="background:${r ? liveColour(r) : "transparent"}"></span>
          <div><b>${esc(st.station_name)}</b> <span class="muted">${esc(st.river)}</span>${liveBadges(r, st)}<br>${val}
          ${when ? `<br><span style="font-size:12.5px">${when}</span>` : ""}
          ${r && r.alert_level ? `<br><span class="lv-lvl lv-l${r.alert_level.level}">${liveAlertText(r.alert_level)}</span>` : ""}
          <br><span class="muted" style="font-size:12px">${esc(LIVE_SRC[st.source].name)}</span></div></div>`;
      });
    });
  });
  const vr = Object.values(LIVE.recs).filter(r => r.source === "vmm_kiwis");
  if (vr.length) html += `<h3 class="lv-country">Belgium: Flanders (optional)</h3><p class="muted" style="font-size:13px">${vr.length} gauges loaded from VMM, shown as small dots on the map only (click a dot). Not in our station catalogue: no commune matching was done.</p>`;
  document.getElementById("liveList").innerHTML = html;
  // map: catalogue stations always shown; hollow grey when there is no value (no map yet when the alert watch refreshes before the tab was opened)
  if (LIVE.layer) {
  LIVE.layer.clearLayers();
  LIVE_STATIONS.forEach(st => {
    const k = st.source + ":" + st.station_id, r = LIVE.recs[k];
    const m = L.circleMarker([st.lat, st.lon], { radius: 7, weight: 2, color: r ? "#1c2430" : "#868e96", fillColor: r ? liveColour(r) : "#fff", fillOpacity: r ? 0.95 : 0.4, dashArray: r && r.daily ? "3 2" : null })
      .bindTooltip(`<b>${esc(st.station_name)}</b> ${esc(st.river)}<br>${r ? liveValText(r) + (r.is_stale ? " (old data)" : "") : "no value"}`);
    m.bindPopup(() => r ? livePopup(r, st) : `<b>${esc(st.station_name)}</b><br>No value from the source right now. <a href="${esc(LIVE_SRC[st.source].page)}" target="_blank" rel="noopener">Official page</a>`);
    m._liveKey = k; m.addTo(LIVE.layer);
  });
  if (vr.length && !LIVE.vmmLayer.getLayers().length) vr.forEach(r => L.circleMarker([r.lat, r.lon], { radius: 3, weight: 1, color: "#495057", fillColor: liveColour(r), fillOpacity: 0.8 })
    .bindPopup(() => livePopup(r, null)).addTo(LIVE.vmmLayer));
  }
  document.getElementById("liveUpdated").textContent = "Last refresh: " + new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " (automatic every " + LIVE_REFRESH_MIN + " min while this tab is open" + (ALERTS.watch ? ", every " + AL_POLL_MIN + " min on any tab while \"Watch\" is on" : "") + ")";
}
async function liveRun(code, fn) {
  LIVE.status[code] = { state: "loading" };
  liveRender();
  try {
    const out = await fn();
    Object.keys(LIVE.recs).forEach(k => { if (LIVE.recs[k].source === code) delete LIVE.recs[k]; });
    out.recs.forEach(r => { LIVE.recs[liveKey(r)] = r; });
    LIVE.status[code] = { state: out.recs.length ? "ok" : "down", n: out.recs.length, total: out.total, note: out.note, msg: out.recs.length ? "" : "no valid value in the answer" };
  } catch (e) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    LIVE.status[code] = { state: "down", msg: offline ? "source unavailable (you are offline)" : e.proxyDown ? "source unavailable (start live_proxy.py)" :
      LIVE_SRC[code].via === "proxy" ? "source unavailable: " + String(e.message || e).slice(0, 160) : "source unavailable (no answer from the service; offline?)" };
  }
  liveRender();
}
async function liveRefresh() {
  if (LIVE.busy) return; LIVE.busy = true; LIVE.last = Date.now();
  try {
    await Promise.allSettled([liveRun("wallonie_kiwis", liveWallonie), liveRun("pegelonline", livePegel),
      ...["rijkswaterstaat_ddapi20", "nrw_lanuv", "waterschap_limburg_open_data"].map(c => liveRun(c, () => liveProxy(c)))]);
  } finally { LIVE.busy = false; alertsEvaluate(); }   // app_alerts.js: thresholds, strip, notifications
}
function initLive() {
  if (!LIVE.map) {
    const la = LIVE_STATIONS.map(s => s.lat), lo = LIVE_STATIONS.map(s => s.lon);
    LIVE.map = newMap("mapLive", la.length ? [[Math.min(...la) - 0.1, Math.min(...lo) - 0.1], [Math.max(...la) + 0.1, Math.max(...lo) + 0.1]] : [[49, 4.5], [51.6, 8.5]]);
    LIVE.vmmLayer = L.layerGroup().addTo(LIVE.map);
    LIVE.layer = L.layerGroup().addTo(LIVE.map);
    document.getElementById("livePortals").innerHTML = LIVE_PORTALS.map(([a, u, who]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(a)}</a> <span class="muted">${esc(who)}</span></li>`).join("");
    document.getElementById("liveRefresh").addEventListener("click", liveRefresh);
    document.getElementById("liveVmm").addEventListener("click", () => { if (LIVE.vmmLoaded) return; LIVE.vmmLoaded = true; liveRun("vmm_kiwis", liveVmm); });
    document.getElementById("liveList").addEventListener("click", e => {
      const row = e.target.closest(".lv-row[data-k]"); if (!row) return;
      const m = LIVE.layer.getLayers().find(x => x._liveKey === row.dataset.k); if (!m) return;
      LIVE.map.setView(m.getLatLng(), Math.max(LIVE.map.getZoom(), 11)); m.openPopup();
    });
    alertsSection();
    liveRender();
    if (Date.now() - (LIVE.last || 0) > 6e4) liveRefresh();   // skipped if the alert watch has just refreshed
    // automatic refresh every LIVE_REFRESH_MIN while this tab is open: one timer for the tab and the alert watch, in app_alerts.js (alTick)
  }
  setTimeout(() => LIVE.map.invalidateSize(), 0);
}
