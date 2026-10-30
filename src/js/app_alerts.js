// ---------- Alerts: level 1 "watch" and level 2 "consider leaving", from the live water levels (planning aid, NOT an official warning) ----------
// Thresholds come ONLY from (a) the source itself (LANUK NRW information levels, passed through by live_proxy.py) or
// (b) live/alert_thresholds.json (team drafts, embedded by build_app.py, empty by default). Nothing is derived from the 2021 peaks or invented.
// Only fresh readings (3 h at most, not daily) with the same unit and reference as the threshold can alert.
// No backend: everything runs in this page, only while it is open. Inlined after app_live.js and before app_tabs.js:
// only top-level constants here; the functions run after app_tabs.js has defined esc, fmt and approx (alertsInit is called there).
const ALERT_TEAM = /*ALERT_THRESHOLDS*/{ "entries": [] };
const AL_RADIUS_KM = (() => { const v = Number(D.cfg.alert_island_radius_km); return Number.isFinite(v) && v > 0 ? v : 15; })();   // draft key
const AL_POLL_MIN = Math.max(LIVE_REFRESH_MIN, Number(D.cfg.alert_poll_minutes) || LIVE_REFRESH_MIN);                           // draft key, never under 10
const AL_FRESH_H = 3, AL_RENOTIFY_H = 6, AL_STORE = "pcp_alerts_v1", AL_WATCH_KEY = "pcp_alert_watch";
const AL_DISCLAIMER = "Raw, unvalidated data, for information only. This is not a warning tool: follow the official services (NINA / KATWARN, BE-Alert, NL-Alert, your commune).";
// st: last level per station from fresh data (kept in localStorage); view: result of the last check; cleared: stations back below threshold
const ALERTS = { st: {}, view: {}, cleared: {}, sim: null, watch: false, evals: 0, built: false };
const AL_ISLANDS = (() => { const I = D.islands; return I && I.islands ? Object.values(I.islands).flat().filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon)) : []; })();
const AL_TEAM = alTeamEntries();

// --- thresholds ---
function alTeamEntries() {   // valid team entries only; invalid ones are listed in the Alerts section and never used
  const ok = {}, bad = [];
  (Array.isArray(ALERT_TEAM.entries) ? ALERT_TEAM.entries : []).forEach((e, i) => {
    const st = e && LIVE_STATIONS.find(s => s.source === e.source && s.station_id === String(e.station_id));
    const l1 = e && e.level1 != null ? liveNum(e.level1) : null, l2 = e && e.level2 != null ? liveNum(e.level2) : null;
    const why = !st ? "station_id and source not found in live/stations.json" : (e.level1 != null && l1 === null) || (e.level2 != null && l2 === null) ? "a level is not a number" :
      l1 === null && l2 === null ? "no level given" : l1 !== null && l2 !== null && !(l2 > l1) ? "level2 must be higher than level1" :
      !["m", "cm"].includes(e.unit) ? "unit must be \"m\" or \"cm\"" : typeof e.reference !== "string" || !e.reference ? "reference missing" : "";
    if (why) bad.push(`entry ${i + 1}: ${why}`);
    else ok[liveKey(st)] = { l1, l2, unit: e.unit, reference: e.reference, origin: "team draft", label: "team draft threshold, to validate with the authority", note: String(e.note || "") };
  });
  return { ok, bad };
}
function alThresholds(st, r) {
  // (a) the source's own levels: NRW LANUV_Info_1 -> our level 1, LANUV_Info_2 (else Info_3) -> our level 2; same series, so same reference
  if (r && r.alert_level && Array.isArray(r.alert_level.thresholds)) {
    const th = r.alert_level.thresholds, l1 = th[0] ?? null, l2 = th[1] ?? th[2] ?? null;
    if (l1 !== null || l2 !== null) return { l1, l2, unit: r.alert_level.unit, reference: r.reference, origin: "source", label: "the source's own information levels (" + LIVE_SRC[st.source].name + ")",
      invalid: l1 !== null && l2 !== null && !(l2 > l1) };
  }
  return AL_TEAM.ok[liveKey(st)] || null;   // (b) team draft, or nothing
}
// stations that can have thresholds: NRW (source levels, known once the proxy answers) and every team entry
const alStations = () => LIVE_STATIONS.filter(s => s.source === "nrw_lanuv" || AL_TEAM.ok[liveKey(s)]);

// --- islands near a gauge (straight line, not necessarily on the same river) ---
function alKm(a, b, c, d) { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); }
const alNearIslands = st => AL_ISLANDS.map(r => ({ r, km: alKm(st.lat, st.lon, r.lat, r.lon) })).filter(x => x.km <= AL_RADIUS_KM).sort((a, b) => a.km - b.km);

// --- one station: status and level from the latest reading ---
function alEvalStation(st) {
  const k = liveKey(st), r = LIVE.recs[k], s = LIVE.status[st.source], th = alThresholds(st, r);
  const v = { key: k, st, rec: r || null, th, level: 0, status: "nodata", text: "", islands: alNearIslands(st) };
  if (!r) {
    v.text = !s || s.state === "loading" ? "Waiting for data" : s.state === "down" && /live_proxy/.test(s.msg || "") ? (st.source === "nrw_lanuv" ? "Unknown: NRW levels need live_proxy.py" : "Unknown: this source needs live_proxy.py") : "No recent data";
    return v;
  }
  if (!th) { v.status = "nothr"; v.text = "No alert thresholds"; return v; }
  if (th.invalid) { v.status = "mismatch"; v.text = "No alert: the thresholds are not in order (level 2 not above level 1)"; return v; }
  const age = (Date.now() - Date.parse(r.timestamp_utc)) / 36e5;
  if (r.is_stale || r.daily || !(age <= AL_FRESH_H) || age < -0.25) { v.text = "No recent data"; return v; }
  if (r.unit !== th.unit || r.reference !== th.reference) { v.status = "mismatch"; v.text = "No alert: unit or reference differs from the threshold's"; return v; }
  v.status = "ok";
  // the source failed at the last refresh: the last value is kept (as on the map) while it is under 3 h old, and said so
  if (s && s.state === "down") v.note = "Source not reachable at the last check" + (st.source === "nrw_lanuv" && /live_proxy/.test(s.msg || "") ? " (NRW levels need live_proxy.py)" : "") + ": using the value measured " + Math.round(age * 60) + " min ago.";
  v.level = th.l2 !== null && r.value >= th.l2 ? 2 : th.l1 !== null && r.value >= th.l1 ? 1 : 0;
  v.text = v.level === 2 ? "Level 2: consider leaving" : v.level === 1 ? "Level 1: watch" : "Below level 1";
  return v;
}

// --- state (memory + localStorage; storage can throw in private or file contexts) ---
function alLoad() {
  try {
    const j = JSON.parse(localStorage.getItem(AL_STORE) || "{}"), now = Date.now();
    Object.entries(j.st || {}).forEach(([k, s]) => { if (s && now - (s.t || 0) < AL_RENOTIFY_H * 36e5 && [0, 1, 2].includes(s.level)) ALERTS.st[k] = { level: s.level, t: s.t, notified: s.notified || {}, dismissed: s.dismissed || 0 }; });
  } catch (e) { /* no storage: memory only */ }
  try { ALERTS.watch = localStorage.getItem(AL_WATCH_KEY) === "1"; } catch (e) { /* off */ }
}
function alSave() { try { localStorage.setItem(AL_STORE, JSON.stringify({ st: ALERTS.st })); } catch (e) { /* memory only */ } }

// --- check every station after each refresh of the live sources (called by liveRefresh) ---
function alertsEvaluate() {
  const now = Date.now(), ups = [];
  ALERTS.evals++;
  alStations().forEach(st => {
    const v = alEvalStation(st); ALERTS.view[v.key] = v;
    if (v.status !== "ok") return;   // no fresh, comparable value: the last level is kept, nothing fires and nothing clears
    const prev = ALERTS.st[v.key] || { level: 0, notified: {}, dismissed: 0 };
    if (v.level > prev.level) { ups.push(v); delete ALERTS.cleared[v.key]; }
    if (v.level === 0 && prev.level > 0) ALERTS.cleared[v.key] = { st, at: now };
    ALERTS.st[v.key] = { level: v.level, t: now, notified: prev.notified || {}, dismissed: v.level === prev.level ? prev.dismissed || 0 : 0 };
  });
  // a browser notification only on an upward move, and never twice for the same level of the same gauge within 6 h
  ups.forEach(v => { const n = ALERTS.st[v.key].notified; if (now - (n[v.level] || 0) > AL_RENOTIFY_H * 36e5 && alNotify(v, false)) n[v.level] = now; });
  alSave();
  alertsRender();
}

// --- texts ---
const alName = st => esc(st.station_name) + (st.river ? " (" + esc(st.river) + ")" : "");
const alThText = th => [th.l1 !== null ? `level 1 = ${fmt(th.l1, 2)} ${esc(th.unit)}` : "", th.l2 !== null ? `level 2 = ${fmt(th.l2, 2)} ${esc(th.unit)}` : ""].filter(Boolean).join(", ");
function alUnion(vs) { const m = new Map(); vs.forEach(v => v.islands.forEach(x => { const id = x.r.cc + "-" + x.r.rank; if (!m.has(id) || m.get(id).km > x.km) m.set(id, x); })); return [...m.values()].sort((a, b) => a.km - b.km); }
function alNotify(v, sim) {   // browser notification; false if not possible (no API, no permission, file:// page, error)
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return false;
    const nm = v.st.station_name + (v.st.river ? " (" + v.st.river + ")" : ""), n = v.islands.length;
    const title = (sim ? "SIMULATION - " : "") + (v.level === 2 ? "Level 2: consider leaving" : "Level 1 watch: " + nm);
    const body = (sim ? "SIMULATION, not real data. " : "") + (v.level === 2 ? `${nm}: consider going to a shelter outside our flood data. Follow the authorities.` :
      n ? `Stay away from the ${n} island${n === 1 ? "" : "s"} near this gauge (within ${AL_RADIUS_KM} km).` : "Stay away from low ground near the river. Follow the authorities.") + " Raw data, not an official warning.";
    const note = new Notification(title, { body, tag: (sim ? "pcp-sim-" : "pcp-") + v.key + "-" + v.level });
    note.onclick = () => { try { window.focus(); location.hash = "#live"; note.close(); } catch (e) { /* ignore */ } };
    return true;
  } catch (e) { return false; }
}
function alIslandsHtml(isl) {
  if (!isl.length) return `<p>No island from our data is within ${fmt(AL_RADIUS_KM)} km of this gauge. Stay away from low ground near the river and follow the authorities.</p>`;
  return `<p style="margin:8px 0 4px"><b>Islands within ${fmt(AL_RADIUS_KM)} km of this gauge</b> <span class="muted">(straight line from the gauge; "near" does not mean on the same river)</span>:</p>
    <ul class="al-isl">${isl.map(x => `<li><b>${esc(x.r.name)}</b> <span class="muted">(${esc(String(x.r.cc).toUpperCase())})</span>: about ${approx(x.r.residents)} residents cut off in 2021, ${fmt(x.km, 1)} km from the gauge</li>`).join("")}</ul>
    <a href="#islands" data-al-cc="${esc(isl[0].r.cc)}">See the islands on the Islands tab</a>`;
}
function alDetailHtml(v, sim) {
  const r = v.rec, th = v.th, nm = alName(v.st);
  const msg = v.level === 2
    ? `<p><b>Level 2 at ${nm}: consider leaving.</b> The water is above its level-2 threshold, higher than level 1. Consider leaving the at-risk area now and going to a shelter outside our flood data, to be sure. Follow the authorities and the official services. Shelters may be closed or full.</p>
       <p style="margin:8px 0"><a class="btn primary" href="#route">Plan the way to the nearest shelter (My route)</a></p>${v.islands.length ? `<p style="margin:8px 0 0">Until then, also stay away from the islands near this gauge.</p>` : ""}`
    : `<p><b>Level 1 watch at ${nm}.</b> The water is above its level-1 threshold. ${v.islands.length ? "Stay away from the islands near this gauge: areas that the 2021 flood cut off from hospitals. A sudden rise could cut you off there. Follow the authorities." : ""}</p>`;
  const facts = sim ? `<p class="muted al-small">Simulated reading: no real value and no real threshold are used.</p>`
    : `<p class="muted al-small">Latest value: <b>${liveValText(r)}</b> ${esc(liveRefShort(r))}, measured ${liveTimeText(r.timestamp_utc)}. Thresholds: ${alThText(th)}, from ${esc(th.label)}${th.note ? " (" + esc(th.note) + ")" : ""}.${v.note ? " <b>" + esc(v.note) + "</b>" : ""}</p>`;
  return `<div class="al-card al-c${v.level}${sim ? " al-sim" : ""}">${sim ? `<span class="al-simtag">SIMULATION, not real data</span> ` : ""}<span class="lv-lvl lv-l${v.level}">${v.level === 2 ? "Level 2: consider leaving" : "Level 1: watch"}</span>
    ${msg}${facts}${alIslandsHtml(v.islands)}<p class="al-fine">${AL_DISCLAIMER}</p></div>`;
}

// --- the strip under the top banner (every tab) ---
function alProxyDown() { const s = LIVE.status.nrw_lanuv; return !!(s && s.state === "down" && /live_proxy/.test(s.msg || "")); }
function alBar(level, sim, tag, msg, acts) {
  return `<div class="al-bar al-${level}${sim ? " al-sim" : ""}"${level === 2 && !sim ? ' role="alert"' : ""}>${sim ? `<span class="al-simtag">SIMULATION, not real data</span>` : ""}<span class="al-tag">${tag}</span>
    <div class="al-msg">${msg}</div><div class="al-act">${acts}</div>${level ? `<div class="al-fine">${AL_DISCLAIMER}</div>` : ""}</div>`;
}
function alLevelBar(vs, level, sim, extra) {
  const names = vs.map(v => `<b>${alName(v.st)}</b>`).join(", "), isl = alUnion(vs), many = vs.length > 1;
  const det = `<button type="button" class="btn al-btn" data-al="${sim ? "simdetails" : "details"}">Show details</button>`;
  if (level === 2) return alBar(2, sim, "Level 2: consider leaving",
    `Water at ${names} is above ${many ? "their level-2 thresholds" : "its level-2 threshold"} (higher than level 1). Consider leaving the at-risk area now and going to a shelter outside our flood data, to be sure. Follow the authorities.${extra}`,
    `<a class="btn al-btn" href="#route">Plan my route to a shelter</a>${det}${sim ? `<button type="button" class="btn al-btn" data-al="endsim">End simulation</button>` : ""}`);
  const islTxt = isl.length ? ` Stay away from the islands near ${many ? "these gauges" : "this gauge"} (areas the 2021 flood cut off from hospitals): a sudden rise could cut you off. <b>${isl.length} island${isl.length === 1 ? "" : "s"}</b> within ${fmt(AL_RADIUS_KM)} km: ${isl.slice(0, 3).map(x => esc(x.r.name) + " " + fmt(x.km, 1) + " km").join(", ")}${isl.length > 3 ? ", ..." : ""}.`
    : ` No island from our data within ${fmt(AL_RADIUS_KM)} km: stay away from low ground near the river and follow the authorities.`;
  return alBar(1, sim, "Level 1 watch", `Water at ${names} is above ${many ? "their level-1 thresholds" : "its level-1 threshold"}.${islTxt}${extra}`,
    `${det}${isl.length ? `<a class="btn al-btn" href="#islands" data-al-cc="${esc(isl[0].r.cc)}">Islands</a>` : ""}${sim ? `<button type="button" class="btn al-btn" data-al="endsim">End simulation</button>` : `<button type="button" class="btn al-btn" data-al="dismiss1" aria-label="Dismiss the level 1 watch">Dismiss</button>`}`);
}
function alStripHtml() {
  let h = "";
  const act = Object.values(ALERTS.view).filter(v => v.status === "ok" && v.level > 0), l2 = act.filter(v => v.level === 2), l1 = act.filter(v => v.level === 1);
  const l1shown = l1.filter(v => (ALERTS.st[v.key] || {}).dismissed !== 1);
  if (l2.length) h += alLevelBar(l2, 2, false, l1.length ? ` <span class="al-more">${l1.length} other gauge${l1.length === 1 ? "" : "s"} at level 1.</span>` : "");
  else if (l1shown.length) h += alLevelBar(l1shown, 1, false, "");
  const cl = Object.entries(ALERTS.cleared);
  if (!act.length && cl.length) h += alBar(0, false, "Level back below threshold",
    `${cl.map(([, c]) => `<b>${alName(c.st)}</b> at ${new Date(c.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`).join(", ")}. Keep following the authorities.`,
    `<button type="button" class="btn al-btn" data-al="dismissclear">Dismiss</button>`);
  if (!act.length && ALERTS.watch && alProxyDown()) h += alBar(0, false, "Watching water levels", "NRW levels need live_proxy.py (not reachable on this computer), so no NRW gauge can alert.",
    `<button type="button" class="btn al-btn" data-al="details">Show details</button>`);
  if (ALERTS.sim) h += alLevelBar([ALERTS.sim], ALERTS.sim.level, true, "");   // real alerts always come first
  return h;
}

// --- the Alerts section inside the Live water levels tab ---
function alertsSection() {
  if (ALERTS.built) return; ALERTS.built = true;
  const box = document.getElementById("liveAlerts"), withIsl = LIVE_STATIONS.map(s => [s, alNearIslands(s).length]);
  const best = withIsl.reduce((a, b) => b[1] > a[1] ? b : a, withIsl[0]);
  box.innerHTML = `<p class="al-disc"><b>${AL_DISCLAIMER}</b></p>
    <p class="muted al-small" style="margin:8px 0">Two levels per gauge, only where a threshold exists. <b>Level 1 (watch)</b>: stay away from the islands near the gauge, areas the 2021 flood cut off from hospitals. <b>Level 2 (higher)</b>: consider leaving the at-risk area for a shelter outside our flood data. "Near" means within ${fmt(AL_RADIUS_KM)} km in a straight line (draft setting), not necessarily on the same river. Only readings under ${AL_FRESH_H} hours old, in the same unit and reference as the threshold, can alert.</p>
    <div class="pcard" style="padding:12px 14px">
      <label class="check"><input type="checkbox" id="alWatch"> <b>Watch the water levels in the background</b></label>
      <p class="muted al-small" style="margin:0 0 10px 26px">Checks the sources every ${fmt(AL_POLL_MIN)} min while this page is open, on any tab. There is no server: closing the page stops it.</p>
      <p style="margin:0;display:flex;flex-wrap:wrap;gap:8px;align-items:center"><button type="button" class="btn" id="alNotifBtn">Enable browser notifications</button> <span id="alNotifState" class="muted al-small"></span></p>
    </div>
    <div id="alProxy"></div>
    <h4 class="al-h">Active alerts</h4><div id="alActive"></div>
    <h4 class="al-h">Gauges that can alert</h4><div id="alStatus"></div>
    <details class="pcard al-simbox" id="alSimBox"><summary><b>Simulation for demonstrations</b> <span class="al-simtag">SIMULATION, not real data</span></summary>
      <p class="muted al-small" style="margin:6px 0">Shows what the strip, the details and the browser notification would look like. It never changes the real alert state and uses no real value.</p>
      <label class="al-small" for="alSimSt">Gauge</label>
      <select id="alSimSt" style="width:100%;padding:6px 8px;margin:2px 0 8px">${LIVE_STATIONS.map(s => { const n = alNearIslands(s).length;
        return `<option value="${esc(liveKey(s))}"${s === best[0] ? " selected" : ""}>${esc(s.station_name)} (${esc(s.river)}), ${n} island${n === 1 ? "" : "s"} near</option>`; }).join("")}</select>
      <fieldset class="seg"><legend>Level</legend>
        <label><input type="radio" name="alSimLv" value="1" checked><span>Level 1 watch</span></label>
        <label><input type="radio" name="alSimLv" value="2"><span>Level 2 leave</span></label></fieldset>
      <label class="check al-small"><input type="checkbox" id="alSimNotif"> Also show a test browser notification (marked SIMULATION)</label>
      <p style="margin:8px 0;display:flex;flex-wrap:wrap;gap:8px"><button type="button" class="btn primary" id="alSimGo">Show the simulation</button> <button type="button" class="btn" id="alSimEnd">End simulation</button></p>
      <p class="muted al-small" id="alSimNote" style="margin:0"></p>
      <div id="alSim"></div>
    </details>`;
  const w = document.getElementById("alWatch"); w.checked = ALERTS.watch;
  w.addEventListener("change", () => alSetWatch(w.checked));
  document.getElementById("alNotifBtn").addEventListener("click", alAskPermission);
  document.getElementById("alSimGo").addEventListener("click", alSimRun);
  document.getElementById("alSimEnd").addEventListener("click", () => { ALERTS.sim = null; document.getElementById("alSimNote").textContent = ""; alertsRender(); });
  alertsRender();
}
function alNotifText() {
  const file = location.protocol === "file:" ? " Opened as a local file: the browser may refuse notifications; the strip at the top still works." : "";
  try {
    if (!("Notification" in window)) return "Not supported by this browser: the strip at the top still works.";
    const p = Notification.permission;
    return (p === "granted" ? "On: a notification appears when a gauge moves up a level." : p === "denied" ? "Blocked by the browser (change it in the site settings): the strip at the top still works." : "Off.") + (p === "granted" ? "" : file);
  } catch (e) { return "Not available here: the strip at the top still works."; }
}
async function alAskPermission() {   // must run from the click (user gesture)
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (e) { /* degrade silently */ }
  alertsRender();
}
function alSetWatch(on) {
  ALERTS.watch = !!on;
  try { localStorage.setItem(AL_WATCH_KEY, on ? "1" : "0"); } catch (e) { /* memory only */ }
  if (on && Date.now() - (LIVE.last || 0) >= AL_POLL_MIN * 6e4) liveRefresh();
  alertsRender();
}
function alSimRun() {
  const key = document.getElementById("alSimSt").value, st = LIVE_STATIONS.find(s => liveKey(s) === key);
  const lv = document.querySelector('input[name="alSimLv"]:checked'), level = lv && lv.value === "2" ? 2 : 1;
  if (!st) return;
  ALERTS.sim = { key, st, rec: null, th: null, level, status: "sim", islands: alNearIslands(st) };   // never written to ALERTS.st nor to storage
  const want = document.getElementById("alSimNotif").checked;
  document.getElementById("alSimNote").textContent = !want ? "Simulation shown in the strip at the top and below. No browser notification (not asked)." :
    alNotify(ALERTS.sim, true) ? "Simulation shown, with a test browser notification marked SIMULATION." : "Simulation shown. No browser notification: not enabled or not supported here (click \"Enable browser notifications\" first).";
  alertsRender();
}
function alStatusHtml() {
  const vs = alStations().map(st => ALERTS.view[liveKey(st)] || alEvalStation(st));
  const others = LIVE_STATIONS.length - vs.length, src = vs.filter(v => v.th && v.th.origin === "source").length, team = vs.filter(v => v.th && v.th.origin === "team draft").length;
  const chip = v => v.status === "ok" ? `<span class="lv-lvl lv-l${v.level}">${esc(v.text)}</span>` : `<span class="al-chip">${esc(v.text)}</span>`;
  return `<p class="muted al-small" style="margin:0 0 8px">${src + team} gauge${src + team === 1 ? "" : "s"} with thresholds right now (${src} from the source, ${team} team draft${team === 1 ? "" : "s"}). ${others} other gauges (Wallonia, PEGELONLINE, Rijkswaterstaat, Waterschap Limburg) have no alert thresholds and never alert: validated thresholds can be added in <code>live/alert_thresholds.json</code>.</p>
    ${AL_TEAM.bad.length ? `<div class="note">Ignored entries in live/alert_thresholds.json: ${AL_TEAM.bad.map(esc).join("; ")}.</div>` : ""}
    ${vs.map(v => `<div class="al-row" data-al-k="${esc(v.key)}">${chip(v)} <b>${esc(v.st.station_name)}</b> <span class="muted">${esc(v.st.river)}</span>
      ${v.rec ? `<br><span class="muted al-small">${liveValText(v.rec)}, ${liveTimeText(v.rec.timestamp_utc)}${v.th ? ` &middot; ${alThText(v.th)} (${v.th.origin === "source" ? "source" : "team draft"})` : ""}</span>` : ""}${v.note ? `<br><span class="al-small" style="color:var(--warn)">${esc(v.note)}</span>` : ""}</div>`).join("")}`;
}
function alertsRender() {
  const strip = document.getElementById("alertStrip");
  if (strip) { const h = alStripHtml(); if (strip.innerHTML !== h) strip.innerHTML = h; }
  const box = document.getElementById("liveAlerts");
  if (box) box.dataset.evals = ALERTS.evals;
  if (!ALERTS.built) return;
  document.getElementById("alNotifState").textContent = alNotifText();
  const b = document.getElementById("alNotifBtn");
  try { const p = "Notification" in window ? Notification.permission : "none"; b.disabled = p !== "default"; b.textContent = p === "granted" ? "Browser notifications on" : "Enable browser notifications"; } catch (e) { b.disabled = true; }
  document.getElementById("alWatch").checked = ALERTS.watch;
  document.getElementById("alProxy").innerHTML = alProxyDown() ? `<div class="note"><b>NRW levels need live_proxy.py.</b> The helper is not reachable on this computer, so the NRW gauges (the only ones with the source's own thresholds today) cannot alert. Start it with <code>python live/live_proxy.py</code>.</div>` : "";
  const act = Object.values(ALERTS.view).filter(v => v.status === "ok" && v.level > 0).sort((a, b) => b.level - a.level);
  document.getElementById("alActive").innerHTML = act.length ? act.map(v => alDetailHtml(v, false)).join("") :
    `<p class="muted al-small">${ALERTS.evals ? "No gauge is above a threshold in the latest check." : "Not checked yet."}${Object.keys(ALERTS.cleared).length ? " Back below threshold: " + Object.values(ALERTS.cleared).map(c => alName(c.st)).join(", ") + "." : ""}</p>`;
  document.getElementById("alStatus").innerHTML = alStatusHtml();
  document.getElementById("alSim").innerHTML = ALERTS.sim ? alDetailHtml(ALERTS.sim, true) : "";
}
function alGoDetails(id) {
  const go = () => { const el = document.getElementById(id); if (el) { if (id === "alSim") document.getElementById("alSimBox").open = true; el.scrollIntoView({ block: "start" }); } };
  if (location.hash.slice(1).split("/")[0] !== "live") { location.hash = "#live"; setTimeout(go, 60); } else go();
}
function alClick(e) {
  const a = e.target.closest("[data-al], [data-al-cc]"); if (!a) return;
  if (a.dataset.alCc) {   // open the Islands tab on the country of the nearest island
    if (CODES.includes(a.dataset.alCc)) { CTRY = a.dataset.alCc; syncCtry(); }
    if (location.hash === "#islands") initIslands();
    return;
  }
  const act = a.dataset.al;
  if (act === "details") alGoDetails("alertsHead");
  if (act === "simdetails") alGoDetails("alSim");
  if (act === "endsim") ALERTS.sim = null;
  if (act === "dismissclear") ALERTS.cleared = {};
  if (act === "dismiss1") { Object.values(ALERTS.view).forEach(v => { if (v.status === "ok" && v.level === 1 && ALERTS.st[v.key]) ALERTS.st[v.key].dismissed = 1; }); alSave(); }
  alertsRender();
}
// poll: the live tab refreshes every LIVE_REFRESH_MIN while open; with "Watch" on, every AL_POLL_MIN on any tab (never faster than 10 min)
function alTick() {
  const onLive = location.hash.slice(1).split("/")[0] === "live" && LIVE.map, per = onLive ? LIVE_REFRESH_MIN : AL_POLL_MIN;
  if ((onLive || ALERTS.watch) && Date.now() - (LIVE.last || 0) >= per * 6e4 - 5e3) liveRefresh();
}
function alertsInit() {
  alLoad();
  document.getElementById("alertStrip").addEventListener("click", alClick);
  document.getElementById("liveAlerts").addEventListener("click", alClick);
  setInterval(alTick, 6e4);
  alertsRender();
  if (ALERTS.watch) liveRefresh();
}
