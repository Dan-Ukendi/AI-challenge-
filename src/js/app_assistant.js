// ---------- Assistant: a chat panel that answers from this app's data (planning information, NOT an official warning) ----------
// Inlined by build_app.py in its own script block, after app_tabs.js (it reads D, CT, ALLP, matches, nm, esc, fmt... when they exist).
// The language model is reached ONLY through live_proxy.py on this computer (POST /chat): the key stays in the proxy's environment
// and never reaches this page. The tools below run here, on D; the model receives only their short results (top-N rows, capped),
// never a dataset. Turn caps, size caps and model choice are also enforced by the proxy. See live/ASSISTANT.md.
(function () {
  "use strict";
  if (typeof D === "undefined" || !D || !document.body) return;
  const PROXY = typeof LIVE_PROXY === "string" ? LIVE_PROXY : "http://127.0.0.1:8765";
  const MAX_ROWS = 25, DEF_ROWS = 10, RESULT_CHARS = 5000, OLD_RESULT_CHARS = 1200, KEEP_MSGS = 8, MAX_STEPS = 6, MAX_BODY = 190000, TIMEOUT_MS = 90000;
  const OFFLINE = "Assistant offline: start live/live_proxy.py with ANTHROPIC_API_KEY set";
  const DISCLAIMER = "AI assistant: it can be wrong. Planning information, not an official warning. Check the numbers in the tabs.";
  const CHIPS = ["Which German islands are most urgent and why?", "Compare the official flood zone and the 2021 flood in Rhineland-Palatinate",
    "What should I tell residents of Verviers?", "Which water level stations have source alert thresholds?", "Chart the 10 communes with the most residents in the flood"];
  // top-level names of the earlier scripts, read only when they exist (typeof never throws for an undeclared name)
  const EXT = {
    forms: () => typeof forms !== "undefined" ? forms : undefined, nm: () => typeof nm !== "undefined" ? nm : undefined,
    NAMES: () => typeof NAMES !== "undefined" ? NAMES : undefined, ALERT: () => typeof ALERT !== "undefined" ? ALERT : undefined,
    ALLPLACES: () => typeof ALLPLACES !== "undefined" ? ALLPLACES : undefined, ALLP: () => typeof ALLP !== "undefined" ? ALLP : undefined,
    matches: () => typeof matches !== "undefined" ? matches : undefined, tierLabel: () => typeof tierLabel !== "undefined" ? tierLabel : undefined,
    CT: () => typeof CT !== "undefined" ? CT : undefined, sitesOf: () => typeof sitesOf !== "undefined" ? sitesOf : undefined,
    actionsFor: () => typeof actionsFor !== "undefined" ? actionsFor : undefined, OSM_DATE: () => typeof OSM_DATE !== "undefined" ? OSM_DATE : undefined,
    NEAR: () => typeof NEAR !== "undefined" ? NEAR : undefined, ICON: () => typeof ICON !== "undefined" ? ICON : undefined, svg: () => typeof svg !== "undefined" ? svg : undefined,
    ALERTS: () => typeof ALERTS !== "undefined" ? ALERTS : undefined, AL_DISCLAIMER: () => typeof AL_DISCLAIMER !== "undefined" ? AL_DISCLAIMER : undefined,
    alThresholds: () => typeof alThresholds !== "undefined" ? alThresholds : undefined, alStations: () => typeof alStations !== "undefined" ? alStations : undefined,
    LIVE: () => typeof LIVE !== "undefined" ? LIVE : undefined, LIVE_SRC: () => typeof LIVE_SRC !== "undefined" ? LIVE_SRC : undefined,
    LIVE_COUNTRY: () => typeof LIVE_COUNTRY !== "undefined" ? LIVE_COUNTRY : undefined, LIVE_STATIONS: () => typeof LIVE_STATIONS !== "undefined" ? LIVE_STATIONS : undefined,
    liveKey: () => typeof liveKey !== "undefined" ? liveKey : undefined,
  };
  const G = n => { try { return EXT[n] ? EXT[n]() : undefined; } catch (e) { return undefined; } };
  const has = n => G(n) !== undefined;

  // ---------- small helpers ----------
  const h = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rnd = (x, d = 1) => (x == null || !Number.isFinite(Number(x))) ? null : Math.round(Number(x) * 10 ** d) / 10 ** d;
  const est = n => !Number.isFinite(n) || n <= 0 ? 0 : n < 5 ? "fewer than 10" : n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100;   // residents: rounded like the tabs
  const cut = (s, n = 160) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const nRows = n => Math.max(1, Math.min(MAX_ROWS, Math.round(Number(n)) || DEF_ROWS));
  const plain = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const formsOf = s => { const f = G("forms"); return typeof f === "function" ? f(String(s)) : [plain(s)]; };
  const hit = (q, text) => { const qs = formsOf(String(q).trim()).filter(Boolean); if (!qs.length) return true; const ts = formsOf(text); return qs.some(a => ts.some(b => b.includes(a))); };
  const CCN = { BE: "be", DE: "de", NL: "nl" };
  const ccOfInput = c => c ? CCN[String(c).toUpperCase()] || null : null;
  const name = p => { const f = G("nm"); return typeof f === "function" ? f(p) : p.name; };
  const NAMES_ = G("NAMES") || { be: "Belgium", de: "Germany", nl: "Netherlands" };
  const ALERT_ = G("ALERT") || { be: "BE-Alert", de: "the NINA warning app", nl: "NL-Alert" };
  // fit a result under RESULT_CHARS by dropping rows from the end of its longest list (never cut JSON in the middle)
  function fit(o) {
    let s = JSON.stringify(o);
    while (s.length > RESULT_CHARS) {
      const k = Object.keys(o).filter(k => Array.isArray(o[k]) && o[k].length > 1).sort((a, b) => o[b].length - o[a].length)[0];
      if (!k) { s = JSON.stringify({ truncated: true, text: s.slice(0, RESULT_CHARS - 60) }); break; }
      o[k] = o[k].slice(0, Math.max(1, Math.floor(o[k].length * 0.75))); o.truncated = true; s = JSON.stringify(o);
    }
    return s;
  }

  // ---------- tools (JSON schemas sent to the model; implementations run here on D) ----------
  const CTRY_PROP = { type: "string", enum: ["BE", "DE", "NL"], description: "Country code (optional)" };
  const N_PROP = { type: "integer", minimum: 1, maximum: MAX_ROWS, description: "Number of rows (default 10, max 25)" };
  const TOOLS = [
    { name: "search_communes", description: "Find communes (municipalities) of Belgium, Germany or the Netherlands by name; accents optional (Koeln = Köln). Returns up to 8 matches with id and country.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "get_commune", description: "Facts for one commune from the app: residents and buildings in the observed July 2021 flood, priority tier, modelled flood-zone shares, sites near the flood, islands, official-zone gap (Germany), and the official advice sources of its country.",
      input_schema: { type: "object", properties: { name_or_id: { type: "string", description: "Commune name or id such as BE_63079" }, country: CTRY_PROP }, required: ["name_or_id"] } },
    { name: "get_priority_areas", description: "Communes ranked by a metric of the observed 2021 flood (mapped areas only), with the priority-tier rule used by the app.",
      input_schema: { type: "object", properties: { country: CTRY_PROP, metric: { type: "string", enum: ["pop_exposed", "per1000", "buildings", "flood_ha"], description: "pop_exposed = residents in the flood (estimate), per1000 = share of residents, buildings = buildings near the flood, flood_ha = flooded hectares" }, n: N_PROP } } },
    { name: "get_islands", description: "Islands: areas cut off from every hospital when the car roads touching the observed 2021 flood are closed. Ranked list with residents, gaps, nearest hospital, closed road links.",
      input_schema: { type: "object", properties: { country: CTRY_PROP, n: N_PROP } } },
    { name: "get_official_zone_gap", description: "Germany only: official flood zones (RLP, NRW) compared with the 2021 flood: flooded area, area outside the official zone (gap), buildings and estimated residents. Give a Land (NRW, RLP, Total) or a German commune name; empty = all Länder.",
      input_schema: { type: "object", properties: { land_or_commune: { type: "string" } } } },
    { name: "get_alerts", description: "Current state of the in-page alerts (planning aid from live water levels) and the stations that have alert thresholds, with the origin of each threshold.",
      input_schema: { type: "object", properties: {} } },
    { name: "get_live_levels", description: "Latest water levels loaded by the Live water levels tab, filtered by station, river, region or country. Only available after that tab has loaded data.",
      input_schema: { type: "object", properties: { station_or_region: { type: "string" } } } },
    { name: "get_dataset_limits", description: "The known limits of the data used by the app. Use it before drawing conclusions.",
      input_schema: { type: "object", properties: {} } },
    { name: "render_chart", description: "Draw a small bar chart in the chat. Only with numbers returned by earlier tool calls in this conversation.",
      input_schema: { type: "object", properties: { type: { type: "string", enum: ["bar"] }, title: { type: "string" }, labels: { type: "array", items: { type: "string" }, maxItems: MAX_ROWS },
        values: { type: "array", items: { type: "number" }, maxItems: MAX_ROWS }, unit: { type: "string" } }, required: ["title", "labels", "values"] } },
  ];

  const places = () => G("ALLPLACES") || [];
  function findPlaces(q, cc) {
    q = String(q || "").trim(); if (!q) return [];
    const m = G("matches"); let out = typeof m === "function" ? m(q) : [];
    if (cc) out = out.filter(p => p.cc === cc);
    if (!out.length) out = places().filter(p => (!cc || p.cc === cc) && hit(q, p.name)).slice(0, 8);
    return out.slice(0, 8);
  }
  function resolvePlace(q, cc) {
    const ALLP_ = G("ALLP") || {}, s = String(q || "").trim();
    if (ALLP_[s] || ALLP_[s.toUpperCase()]) return { p: ALLP_[s] || ALLP_[s.toUpperCase()], others: [] };
    const list = findPlaces(s, cc); if (!list.length) return { p: null, others: [] };
    const qf = formsOf(s);
    const exact = list.find(p => formsOf(p.name).some(f => qf.includes(f) || qf.some(x => f.replace(/,.*$/, "").trim() === x)));
    const p = exact || list[0];
    return { p, others: list.filter(x => x !== p).slice(0, 4).map(x => `${name(x)} (${x.id})`) };
  }
  const tierRule = () => {
    const R = D.rules;
    return `Team rule, relative across BE, DE and NL (not an official limit): highest priority if at least ${rnd(R.rate_high / 10)}% of residents or at least ${Math.round(R.abs_high)} residents were in the flood (${R.p_high}th percentile of the ${R.n_flooded} flooded communes); 1A if under ${R.hazard}% of the flooded land lies in the modelled 100-year zone, else 1B. Medium if at least ${rnd(R.rate_medium / 10)}% or ${Math.round(R.abs_medium)} residents (${R.p_medium}th percentile). "No data" when under ${R.coverage}% of the commune was mapped and the measured exposure is low.`;
  };
  const tierOf = c => { const tl = G("tierLabel"); return c ? { code: c.tier, label: typeof tl === "function" ? tl(c) : c.tier } : null; };
  const islandsAll = () => (D.islands && D.islands.islands) || {};

  const IMPL = {
    search_communes(i) {
      const r = findPlaces(i.query);
      return { query: cut(i.query, 60), results: r.map(p => ({ id: p.id, name: name(p), country: p.cc.toUpperCase(), in_2021_satellite_map: !!p.c, tier: p.c ? tierOf(p.c).label : null })),
        note: r.length ? "Use get_commune with the id." : "No commune found: try the local spelling." };
    },
    get_commune(i) {
      const { p, others } = resolvePlace(i.name_or_id, ccOfInput(i.country));
      if (!p) return { found: false, note: "not in the data: no commune with this name in Belgium, Germany or the Netherlands" };
      const c = p.c, hz = p.h, cc = p.cc, CC = cc.toUpperCase();
      const out = { id: p.id, name: name(p), country: CC, tab: `#region/${p.id}`, other_matches: others.length ? others : undefined };
      if (c) {
        out.observed_2021 = { residents_in_flood_estimate: est(c.pop_exposed), share_of_residents_pct: rnd(c.per1000 / 10), flooded_ha: rnd(c.flood_ha),
          buildings_near_flood: c.buildings, building_distance_m: D.cfg.building_buffer_m, area_mapped_pct: rnd(c.coverage_pct, 0),
          flood_inside_modelled_100yr_zone_pct: rnd(c.hazard_share_100, 0), official_population: c.pop_official || null };
        out.priority = { ...tierOf(c), focus: cut((D.tiers[c.tier] || {}).message_focus, 220) };
      } else out.observed_2021 = "not in the 2021 satellite map (outside the mapped areas): unknown, not safe";
      if (hz) out.modelled_flood_zones = { residents_model: hz.pop, pct_residents_in_10yr_zone: hz.p10, pct_residents_in_100yr_zone: hz.p100, pct_residents_in_500yr_zone: hz.p500 };
      const sOf = G("sitesOf"), st = typeof sOf === "function" ? sOf(p.id) : null;
      if (st) out.sites_near_flood = Object.fromEntries(Object.entries(st).map(([cat, v]) => [cat, Object.entries(v).filter(([k]) => k !== "outside").reduce((a, [, n]) => a + n, 0)]));
      const isl = (islandsAll()[cc] || []).filter(r => r.communes.some(x => hit(x.n.replace(/,.*$/, ""), p.name) || hit(p.name.replace(/,.*$/, ""), x.n)));
      if (isl.length) out.islands = { count: isl.length, residents_cut_off_estimate: est(isl.reduce((a, r) => a + r.residents, 0)), ranks: isl.slice(0, 5).map(r => r.rank) };
      const U = D.uesg, g = U && U.communes.find(x => x.id === p.id);
      if (g) out.official_zone_gap = { land: g.land, flooded_ha: g.flood_ha, outside_official_zone_ha: g.gap_ha, buildings_outside: g.bat_gap, residents_outside_estimate: est(g.pop_gap) };
      const af = G("actionsFor"), acts = c && typeof af === "function" ? af(c) : [D.actions.alert && D.actions.alert[CC]].filter(Boolean);
      out.official_advice = acts.slice(0, 6).map(a => ({ advice: cut(a.text, 150), source: (D.sources[a.source] || {}).name || a.source, url: (D.sources[a.source] || {}).url }));
      out.official_alert_service = ALERT_[cc];
      return out;
    },
    get_priority_areas(i) {
      const CT_ = G("CT") || {}, metric = ["pop_exposed", "per1000", "buildings", "flood_ha"].includes(i.metric) ? i.metric : "pop_exposed", n = nRows(i.n), cc = ccOfInput(i.country);
      const comm = Object.values(CT_).filter(x => !cc || x.cc === cc).flatMap(x => x.comm);
      const rows = comm.filter(c => c[metric] > 0).sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name)).slice(0, n).map((c, k) => ({
        rank: k + 1, id: c.lau_id, commune: name(c), country: c.country, priority: tierOf(c).label, residents_in_flood_estimate: est(c.pop_exposed),
        share_pct: rnd(c.per1000 / 10), buildings_near_flood: c.buildings, flooded_ha: rnd(c.flood_ha, 0), area_mapped_pct: rnd(c.coverage_pct, 0) }));
      return { country: cc ? cc.toUpperCase() : "BE, DE, NL", sorted_by: metric, rows, tab: "#priority",
        rule: tierRule() + ` This list is sorted by ${metric}; the sort is not the tier rule. Mapped areas only.` };
    },
    get_islands(i) {
      const all = islandsAll(), cc = ccOfInput(i.country), n = nRows(i.n);
      const list = (cc ? (all[cc] || []) : Object.values(all).flat()).slice().sort((a, b) => cc ? a.rank - b.rank : (b.score - a.score) || (b.residents - a.residents));
      const M = (D.islands || {}).meta || {};
      return { country: cc ? cc.toUpperCase() : "all", islands_total: list.length, per_country: Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toUpperCase(), v.length])),
        rows: list.slice(0, n).map(r => ({ country: r.cc.toUpperCase(), rank_in_country: r.rank, name: r.name, residents_cut_off_estimate: est(r.residents),
          communes: r.communes.map(x => `${x.n} ${x.pct}%`).join(", "), gaps: r.gaps, nearest_hospital: r.hospital ? r.hospital.name : null,
          hospital_km_straight_line: r.hospital ? r.hospital.km : null, closed_road_links: r.closed_links, fire_stations_inside: r.fire_n, shelters_inside: r.shelters_n,
          vulnerable_sites_inside: r.vulnerable })),
        rule: `Draft team rule: car roads touching the observed 2021 flood are closed (bridges included); a group of roads that no longer reaches any hospital is an island. Ranked by number of gaps (no fire station inside, no shelter inside, a vulnerable site inside, ${M.urgent_pop || 1000}+ residents), then residents. Islands under ${M.min_pop || 100} residents are not listed. Not complete: the satellite maps miss floods.`,
        tab: "#islands" };
    },
    get_official_zone_gap(i) {
      const U = D.uesg; if (!U) return { available: false, note: "not in the data: no official zone data in this build" };
      const q = String(i.land_or_commune || "").trim(), qn = plain(q);
      const alias = { nrw: "NRW", "north rhine-westphalia": "NRW", "nordrhein-westfalen": "NRW", rlp: "RLP", "rhineland-palatinate": "RLP", "rheinland-pfalz": "RLP", total: "Total", germany: "Total", all: "Total" };
      const pct = (a, b) => b > 0 ? Math.round(100 * a / b) : null;
      const landRow = r => ({ land: r.land, flooded_2021_ha: r.flood_ha, official_zone_ha: r.legal_ha, risk_area_not_legal_ha: r.risk_ha, gap_outside_official_zone_ha: r.gap_ha, gap_pct_of_flood: pct(r.gap_ha, r.flood_ha),
        buildings_in_flood: r.bat_flood, buildings_in_gap: r.bat_gap, residents_in_flood_estimate: est(r.pop_flood), residents_in_gap_estimate: est(r.pop_gap) });
      const comRow = c => ({ commune: c.commune, land: c.land, flooded_2021_ha: c.flood_ha, official_zone_ha: c.legal_ha, gap_outside_official_zone_ha: c.gap_ha, gap_pct_of_flood: pct(c.gap_ha, c.flood_ha),
        buildings_in_gap: c.bat_gap, residents_in_gap_estimate: est(c.pop_gap) });
      const notes = "Official zone = legally set or provisionally secured (statuses differ between Länder); RLP and NRW only; inside the satellite-mapped areas only; residents are GHS-POP estimates. A gap is not an error by the authorities: zones come from a 100-year model and 2021 was larger in places. Source: Official flood zones (DE) tab, downloaded " + ((U.meta || {}).date || "");
      const land = alias[qn] || (U.land.find(r => plain(r.land) === qn) || {}).land;
      if (!q || land) return { lands: U.land.filter(r => !land || r.land === land).map(landRow), notes, tab: "#official",
        top_communes_by_gap: U.communes.filter(c => !land || land === "Total" || c.land === land).sort((a, b) => b.gap_ha - a.gap_ha).slice(0, 5).map(comRow) };
      const m = U.communes.filter(c => hit(q, c.commune)).sort((a, b) => b.gap_ha - a.gap_ha).slice(0, 5);
      return m.length ? { communes: m.map(comRow), notes, tab: "#official" } : { found: false, note: "not in the data: no German commune of the official-zone comparison matches (only RLP and NRW communes in the mapped areas)" };
    },
    get_alerts() {
      if (!has("ALERTS")) return { available: false, note: "the alerts feature is not in this build" };
      try {
        const A = G("ALERTS"), LIVE_ = G("LIVE") || { recs: {} }, SRC = G("LIVE_SRC") || {}, key = G("liveKey"), thr = G("alThresholds"), sts = G("alStations");
        const stations = typeof sts === "function" ? sts() : [];
        const withTh = stations.slice(0, MAX_ROWS).map(st => { const r = typeof key === "function" ? LIVE_.recs[key(st)] : null, th = typeof thr === "function" ? thr(st, r) : null;
          return { station: st.station_name, river: st.river || null, source: (SRC[st.source] || {}).short || st.source,
            thresholds: th ? { origin: th.label || th.origin, level1: th.l1, level2: th.l2, unit: th.unit } : (st.source === "nrw_lanuv" ? "the source's own levels (LANUK NRW), known once the Live tab has loaded NRW data through live_proxy.py" : "none") }; });
        const active = Object.values(A.view || {}).filter(v => v && v.level > 0).slice(0, MAX_ROWS).map(v => ({ station: v.st.station_name, river: v.st.river || null, level: v.level, status: v.text,
          value: v.rec ? v.rec.value : null, unit: v.rec ? v.rec.unit : null, time_utc: v.rec ? v.rec.timestamp_utc : null, islands_near: (v.islands || []).slice(0, 3).map(x => `${x.r.name} (${rnd(x.km)} km)`) }));
        return { available: true, checks_done: A.evals || 0, simulation_running: !!A.sim, active_alerts: active, stations_with_thresholds: withTh,
          note: (G("AL_DISCLAIMER") || "Planning aid, not an official warning.") + (A.evals ? "" : " No check yet: alerts are evaluated after the Live tab loads data."), tab: "#live" };
      } catch (e) { return { available: false, note: "the alert state could not be read" }; }
    },
    get_live_levels(i) {
      const LIVE_ = G("LIVE"), q = String(i.station_or_region || "").trim();
      const recs = LIVE_ && LIVE_.recs ? Object.values(LIVE_.recs) : [];
      const CN = G("LIVE_COUNTRY") || {}, SRC = G("LIVE_SRC") || {};
      if (!recs.length) {
        const cat = (G("LIVE_STATIONS") || []).filter(s => !q || hit(q, [s.station_name, s.river, s.region, CN[s.country] || s.country].join(" "))).slice(0, 10).map(s => `${s.station_name}${s.river ? " (" + s.river + ")" : ""}`);
        return { available: false, note: "open the Live tab: no water level has been loaded in this page yet", stations_in_catalogue: cat };
      }
      const m = recs.filter(r => !q || hit(q, [r.station_name, r.river, r.region, CN[r.country] || r.country].join(" ")));
      return { available: true, matches: m.length, rows: m.slice(0, MAX_ROWS).map(r => ({ station: r.station_name, river: r.river || null, region: r.region, country: r.country, value: r.value, unit: r.unit,
        reference: cut(r.reference, 60), time_utc: r.timestamp_utc, age_min: Math.round((Date.now() - Date.parse(r.timestamp_utc)) / 6e4), trend: r.trend ? `${r.trend.direction} ${r.trend.change} in ${r.trend.minutes} min` : null,
        source_level: r.alert_level ? `${r.alert_level.level} of ${r.alert_level.max_level}` : null, old_data: !!r.is_stale, daily_value: !!r.daily, source: (SRC[r.source] || {}).short || r.source })),
        note: "Raw, unvalidated values as published by each source. Do not compare heights between stations (each gauge has its own reference).", tab: "#live" };
    },
    get_dataset_limits() {
      const U = D.uesg, M = (D.islands || {}).meta || {};
      return { limits: [
        "Satellite flood maps (Copernicus EMS rapid mapping) are single snapshots; they cover only the mapped areas and miss floods in narrow valleys, under trees and in towns (e.g. Verviers, Pepinster, Trooz).",
        "Outside the mapped areas we do not know what flooded: no data is not 'safe'.",
        "Residents are estimates from GHS-POP 2020 (cells of about 1 km, spread evenly), rounded: not a count of people.",
        `Buildings are GHS-OBAT points within ${D.cfg.building_buffer_m} m of the observed flood.`,
        "Priority tiers are relative percentiles across BE, DE and NL (team rule), not official limits.",
        "Modelled flood zones (10, 100, 500-year) leave out small rivers and heavy rain.",
        `Official German flood zones: RLP and NRW only; statuses differ between Länder (legally set or provisionally secured); downloaded ${U && U.meta ? U.meta.date : "n/a"}.`,
        `Sites come from OpenStreetMap (snapshot ${G("OSM_DATE") || "2021-01-01"}), incomplete; 'near' = within ${G("NEAR") || 100} m; near does not mean damaged.`,
        `Islands use the observed 2021 flood only (OSM roads, snapshot ${M.osm_snapshot || D.cfg.osm_snapshot}); other road closures are unknown; hospital distances are straight lines; the ranking is a draft.`,
        "Live water levels are raw, unvalidated data; heights cannot be compared between stations.",
        "Alert thresholds: NRW levels are the source's own; team thresholds (live/alert_thresholds.json) are drafts to validate. Alerts are planning aids, not official warnings.",
      ], tab: "#about" };
    },
    render_chart(i) {
      const labels = Array.isArray(i.labels) ? i.labels.map(x => cut(x, 40)) : [], values = Array.isArray(i.values) ? i.values.map(Number) : [];
      if (!labels.length || !values.length) throw new Error("labels and values must not be empty");
      if (labels.length !== values.length) throw new Error("labels and values must have the same length");
      if (labels.length > MAX_ROWS) throw new Error("at most 25 bars");
      if (values.some(v => !Number.isFinite(v))) throw new Error("values must be numbers");
      const missing = values.filter(v => !known(v));
      if (missing.length) throw new Error("these values were not returned by an earlier tool call in this conversation: " + missing.slice(0, 5).join(", "));
      S.charts.push(chartSvg(cut(i.title || "", 80), labels, values, cut(i.unit || "", 20)));
      return { rendered: true, bars: values.length };
    },
  };
  // numbers seen in tool results of this conversation (render_chart may only draw those)
  function remember(o) { if (typeof o === "number" && Number.isFinite(o)) S.nums.add(o); else if (o && typeof o === "object") Object.values(o).forEach(remember); }
  const known = v => { for (const k of S.nums) if (Math.abs(k - v) <= Math.max(0.051, Math.abs(k) * 0.005)) return true; return false; };
  function runTool(nameT, input) {
    const f = IMPL[nameT];
    if (!f) return { text: JSON.stringify({ error: "unknown tool" }), error: true };
    try { const o = f(input || {}); if (nameT !== "render_chart") remember(o); return { text: fit(o), error: false }; }
    catch (e) { return { text: JSON.stringify({ error: cut(e.message, 300) }), error: true }; }
  }

  // ---------- chart (inline SVG, colours from the theme tokens) ----------
  function chartSvg(title, labels, values, unit) {
    const W = 340, lw = 122, bw = 160, rowH = 20, top = 26, H = top + labels.length * rowH + 6, max = Math.max(...values.map(Math.abs), 1e-9);
    const f = (v) => Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en") : String(rnd(v, 1));
    const bars = labels.map((l, k) => { const y = top + k * rowH, w = Math.max(1, Math.abs(values[k]) / max * bw);
      return `<text x="${lw - 6}" y="${y + 13}" text-anchor="end"><title>${h(l)}</title>${h(cut(l, 17))}</text><rect class="as-bar" x="${lw}" y="${y + 3}" width="${rnd(w, 1)}" height="${rowH - 7}" rx="3"/><text x="${rnd(lw + w + 4, 1)}" y="${y + 13}">${h(f(values[k]))}</text>`; }).join("");
    return `<div class="as-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(title)}"><text class="as-ct" x="0" y="13">${h(cut(title, 60))}</text><text class="as-cm" x="${W}" y="13" text-anchor="end">${h(unit)}</text>${bars}</svg></div>`;
  }

  // ---------- markdown-lite: everything is escaped first; links only to http(s) or to the app's own tabs ----------
  const TAB_RE = /^#(overview|map|region|route|priority|sites|islands|official|live|advanced|about)(\/[A-Za-z0-9_-]{1,40})?$/;
  const safeHref = u => /^https?:\/\/[^\s"'<>`]+$/i.test(u) ? "web" : TAB_RE.test(u) ? "tab" : null;
  const aTag = (u, t) => safeHref(u) === "web" ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<a href="${u}">${t}</a>`;
  function inline(s) {
    const keep = [], put = x => "\u0000" + (keep.push(x) - 1) + "\u0000";
    s = s.replace(/`([^`\n]{1,200})`/g, (m, c) => put(`<code>${c}</code>`));
    s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, t, u) => safeHref(u) ? put(aTag(u, t)) : `${t} (${u})`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"'`)]+[^\s<>"'`).,;:!?])/g, (m, a, u) => a + put(aTag(u, u)));
    s = s.replace(/\*\*([^*\n]{1,300})\*\*/g, "<b>$1</b>").replace(/(^|[\s(])\*([^*\s][^*\n]{0,200}?)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
    return s.replace(/\u0000(\d+)\u0000/g, (m, k) => keep[+k]);
  }
  function md(text) {
    const L = h(text).split(/\r?\n/), out = []; let para = [], list = null;
    const flushP = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushL = () => { if (list) { out.push(`<${list.t}>${list.items.map(x => `<li>${inline(x)}</li>`).join("")}</${list.t}>`); list = null; } };
    for (let k = 0; k < L.length; k++) {
      const line = L[k], t = line.trim();
      if (/^\|.*\|$/.test(t) && k + 1 < L.length && /^\|?\s*:?-{2,}/.test(L[k + 1].trim())) {
        flushP(); flushL();
        const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
        const head = cells(t); k += 2; const rows = [];
        while (k < L.length && /^\|.*\|$/.test(L[k].trim())) rows.push(cells(L[k++]));
        k--;
        out.push(`<table><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`);
        continue;
      }
      let m;
      if (!t) { flushP(); flushL(); }
      else if ((m = t.match(/^#{1,4}\s+(.*)$/))) { flushP(); flushL(); out.push(`<h4>${inline(m[1])}</h4>`); }
      else if ((m = t.match(/^[-*•]\s+(.*)$/))) { flushP(); if (!list || list.t !== "ul") { flushL(); list = { t: "ul", items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.t !== "ol") { flushL(); list = { t: "ol", items: [] }; } list.items.push(m[1]); }
      else { flushL(); para.push(t); }
    }
    flushP(); flushL();
    return out.join("");
  }

  // ---------- system prompt ----------
  const SYSTEM = `You are the assistant inside the Paragon Crisis Portal, the planning tool of a regional civil protection authority (Belgium, Germany, the Netherlands; floods of July 2021). Users are planners.
Rules:
- Answer only from the results of your tools in this conversation. If the tools do not give it, say "not in the data". Never invent a number, name, ID, threshold, link or source.
- Get figures with a tool before you state them; one or two well-chosen calls are usually enough.
- Keep apart and label: (a) challenge data (the app's data: say which tab or tool), (b) external sources (only names and links that a tool returned), (c) assumptions (yours or the team's draft rules).
- Say "impact" or "exposure", never "damage". Never call a place "safe": say "outside our flood data".
- Remember the limits: satellite flood maps are single snapshots, partial, and miss floods; only mapped areas are covered; residents are estimates (GHS-POP, about 1 km cells); official zone statuses differ between Länder; island ranking and team alert thresholds are drafts; NRW thresholds are the source's own.
- This is planning information, NOT an official warning or evacuation instruction. For any real emergency, point to the official services: NINA or KATWARN (Germany), BE-Alert (Belgium), NL-Alert (Netherlands), and the commune. Decline to give evacuation orders to individuals.
- Cite where each figure comes from (Priority list, Find a region, Islands, Official flood zones (DE), Live water levels, Sites near the flood). You may link tabs as [Verviers](#region/BE_63079) or [Islands](#islands).
- Use render_chart only with numbers that earlier tool calls returned.
- Keep answers under about 180 words unless the user asks for a report. Reply in the user's language.
- If the user shares personal data (names, addresses, phone numbers, health details), remind them once not to, then continue without repeating it.`;

  // ---------- state ----------
  const SID = "s" + Array.from((window.crypto || {}).getRandomValues ? crypto.getRandomValues(new Uint8Array(12)) : [Date.now() % 256], b => b.toString(16).padStart(2, "0")).join("") + Date.now().toString(36);
  const S = { status: "unknown", web: false, busy: false, turns: 0, cap: 30, rounds: [], log: [], nums: new Set(), charts: [] };

  // ---------- UI ----------
  const ICON_ = G("ICON"), svgF = G("svg");
  const CHAT_PATH = '<path d="M6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-5 4.5V16h.5A2.5 2.5 0 0 1 4 13.5v-8A2.5 2.5 0 0 1 6.5 3z"/>';
  if (ICON_ && !ICON_.chat) ICON_.chat = CHAT_PATH;
  const chatIcon = size => typeof svgF === "function" && ICON_ ? svgF("chat", size) : `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${CHAT_PATH}</svg>`;
  document.body.insertAdjacentHTML("beforeend", `
<button type="button" class="as-fab" id="asFab" aria-expanded="false" aria-controls="asPanel">${chatIcon(20)}<span>Ask the assistant</span></button>
<section class="as-panel" id="asPanel" role="dialog" aria-label="AI assistant" hidden>
  <div class="as-head"><div class="as-top">${chatIcon(18)}<h2>AI assistant</h2><span class="as-count" id="asCount" title="Requests sent to the AI service in this session / limit">0 / ${S.cap}</span>
    <button type="button" class="as-x" id="asClose" aria-label="Close the assistant">&times;</button></div>
    <p class="as-disc">${h(DISCLAIMER)}</p></div>
  <div class="as-log" id="asLog" aria-live="polite"></div>
  <form class="as-form" id="asForm"><textarea id="asIn" rows="1" maxlength="1000" aria-label="Your question" placeholder="Ask about the flood data..."></textarea><button type="submit" class="btn primary" id="asSend" disabled>Send</button></form>
  <div class="as-foot"><span>Only short results leave this page. No personal data, please.</span><span><button type="button" id="asExport" disabled>Export answer</button> <button type="button" id="asClear">Clear</button></span></div>
</section>`);
  document.body.classList.add("as-on");
  const $ = id => document.getElementById(id);
  const fab = $("asFab"), panel = $("asPanel"), logEl = $("asLog"), inEl = $("asIn"), sendEl = $("asSend");
  const scrollEnd = () => { logEl.scrollTop = logEl.scrollHeight; };
  function add(cls, html, keep = true) {
    const d = document.createElement("div"); d.className = "as-msg " + cls; d.innerHTML = html; logEl.appendChild(d); scrollEnd();
    if (keep) { S.log.push({ cls, html }); $("asExport").disabled = !S.log.some(x => x.cls === "as-a"); }
    return d;
  }
  function count() { $("asCount").textContent = `${S.turns} / ${S.cap}`; }
  function setBusy(b) { S.busy = b; sendEl.disabled = b || S.status === "offline"; inEl.disabled = b; logEl.querySelectorAll(".as-chips .chip").forEach(c => { c.disabled = b; }); }
  function welcome() {
    logEl.innerHTML = "";
    add("as-a", `<p>Ask about the July 2021 flood data of this app: communes, priority list, islands, official flood zones, alerts and live levels. I answer from the app's numbers and say which tab they come from.</p>`, false);
    const c = add("as-chips", CHIPS.map(q => `<button type="button" class="chip" data-q="${h(q)}">${h(q)}</button>`).join(""), false);
    c.classList.remove("as-msg");
  }
  function offline(msg) {
    S.status = "offline"; setBusy(false);
    add("as-off", `<p style="margin:0 0 6px"><b>${h(msg || OFFLINE)}</b></p><p style="margin:0 0 6px">The rest of the app works without it. See live/ASSISTANT.md.</p><button type="button" class="btn" data-retry="1">Retry</button>`, false);
  }
  async function getJson(url, opts, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { ...(opts || {}), signal: ctl.signal }); let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ } return { r, j }; }
    finally { clearTimeout(t); }
  }
  async function health() {
    try {
      const { r, j } = await getJson(PROXY + "/assistant/health", { cache: "no-store" }, 4000);
      if (!r.ok || !j || !j.configured) { offline(); return false; }
      S.status = "ready"; S.web = !!j.web_search; S.cap = Number(j.session_turns) || S.cap; count(); setBusy(false); return true;
    } catch (e) { offline(); return false; }
  }
  let opened = false;
  async function open(show) {
    panel.hidden = !show; fab.setAttribute("aria-expanded", String(show)); place();
    if (!show) { fab.focus(); return; }
    if (!opened) { opened = true; welcome(); await health(); }
    inEl.focus();
  }
  // keep the button (and the panel above it) clear of a map control at the bottom of the window, e.g. the attribution on a phone
  function place() {
    const css = getComputedStyle(document.documentElement), vh = innerHeight, base = 18;
    const cur = parseFloat(css.getPropertyValue("--as-lift")) || 0, chrome = parseFloat(css.getPropertyValue("--chrome")) || 124;
    const fr = fab.getBoundingClientRect(), pr = panel.hidden ? null : panel.getBoundingClientRect();
    const x0 = Math.min(fr.left, pr ? pr.left : Infinity), x1 = innerWidth - base, top0 = (pr ? pr.top : fr.top) + cur;   // the button + panel stack, without lift
    const maxLift = Math.max(0, vh - chrome - 92 - 200);   // never squeeze the panel below a usable height
    let lift = 0;
    document.querySelectorAll(".tab:not([hidden]) .leaflet-bottom .leaflet-control").forEach(c => {
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= x0 || r.left >= x1) return;
      if (r.top < vh - base && r.bottom > top0 - 6) { const need = Math.ceil(vh - base - r.top + 6); if (need <= maxLift) lift = Math.max(lift, need); }
    });
    document.documentElement.style.setProperty("--as-lift", lift + "px");
  }
  let placeQ = false;
  const placeSoon = () => { if (!placeQ) { placeQ = true; requestAnimationFrame(() => { placeQ = false; place(); }); } };
  addEventListener("scroll", placeSoon, { passive: true });
  addEventListener("resize", placeSoon);
  addEventListener("hashchange", () => { [50, 400, 1200].forEach(t => setTimeout(place, t)); });
  [300, 1500].forEach(t => setTimeout(place, t));
  // content that settles later (live data, the alert strip) moves the map controls without a scroll or resize event
  if (window.ResizeObserver) { const ro = new ResizeObserver(placeSoon); [document.body, $("alertStrip"), $("banner")].forEach(e => e && ro.observe(e)); }
  setInterval(() => { if (!document.hidden) placeSoon(); }, 2000);
  fab.addEventListener("click", () => open(panel.hidden));
  $("asClose").addEventListener("click", () => open(false));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) open(false); });
  logEl.addEventListener("click", async e => {
    const c = e.target.closest("button[data-q]"); if (c && !S.busy) { ask(c.dataset.q); return; }
    const r = e.target.closest("button[data-retry]"); if (r) { r.closest(".as-msg").remove(); await health(); }
  });
  $("asForm").addEventListener("submit", e => { e.preventDefault(); const q = inEl.value.trim(); if (q && !S.busy) { inEl.value = ""; ask(q); } });
  inEl.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("asForm").requestSubmit ? $("asForm").requestSubmit() : sendEl.click(); } });
  $("asClear").addEventListener("click", () => { if (S.busy) return; S.rounds = []; S.log = []; S.nums.clear(); $("asExport").disabled = true; welcome(); if (S.status === "offline") offline(); });
  $("asExport").addEventListener("click", exportView);

  // ---------- conversation sent to the model: last rounds only, thinking blocks dropped, old tool results shortened ----------
  const noThinking = m => Array.isArray(m.content) ? { role: m.role, content: m.content.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking") } : m;
  const shortResults = m => Array.isArray(m.content) ? { role: m.role, content: m.content.map(b => b.type === "tool_result" && typeof b.content === "string" && b.content.length > OLD_RESULT_CHARS
    ? { ...b, content: b.content.slice(0, OLD_RESULT_CHARS) + " [shortened]" } : b) } : m;
  function history() {
    const n = S.rounds.length, out = [];
    for (let k = n - 1; k >= 0; k--) {
      const r = S.rounds[k];
      let msgs = k === n - 1 ? r.map(noThinking).map(shortResults) : [r[0], r[r.length - 1]];
      if (msgs.length > KEEP_MSGS) msgs = [r[0], r[r.length - 1]];
      if (out.length + msgs.length > KEEP_MSGS) break;
      out.unshift(...msgs);
    }
    return out;
  }
  async function callChat(messages) {
    const tools = S.web ? TOOLS.concat([{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]) : TOOLS;
    const body = JSON.stringify({ max_tokens: 1024, system: SYSTEM, tools, messages });
    if (body.length > MAX_BODY) return { err: "This conversation is too long. Click Clear to start again." };
    let res;
    try { res = await getJson(PROXY + "/chat", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SID }, body }, TIMEOUT_MS); }
    catch (e) { return { err: e.name === "AbortError" ? "The AI service did not answer in time. Try again." : OFFLINE, offline: e.name !== "AbortError" }; }
    const { r, j } = res, t = Number(r.headers.get("X-Assistant-Turns")), c = Number(r.headers.get("X-Assistant-Cap"));
    if (Number.isFinite(t) && t > 0) S.turns = t; if (Number.isFinite(c) && c > 0) S.cap = c; count();
    if (r.ok && j) return { j };
    const code = j && (j.error && j.error.type ? j.error.type : j.error);
    if (r.status === 503 && code === "assistant_not_configured") return { err: OFFLINE, offline: true };
    if (r.status === 429 && code === "session_turn_cap") { S.turns = S.cap; count(); return { err: `You reached the limit of ${S.cap} requests for this session. Reload the page to start a new session.` }; }
    if (r.status === 429 && code === "hourly_budget") return { err: "The hourly budget of the assistant is used up. Try again later." };
    if (r.status === 429) return { err: "The AI service is busy (rate limit). Try again in a minute." };
    if (r.status === 413) return { err: "This conversation is too long. Click Clear to start again." };
    const msg = j && (j.message || (j.error && j.error.message));
    return { err: `The request failed (HTTP ${r.status})${msg ? ": " + cut(msg, 200) : ""}.` };
  }
  async function ask(q) {
    if (S.busy) return;
    if (S.status !== "ready") { setBusy(true); const ok = await health(); setBusy(false); if (!ok) return; }
    add("as-u", `<p>${h(q)}</p>`);
    if (S.turns >= S.cap) { add("as-e", `<p>You reached the limit of ${S.cap} requests for this session. Reload the page to start a new session.</p>`); return; }
    setBusy(true); S.charts = [];
    const wait = add("as-busy", "Looking at the data...", false);
    const round = [{ role: "user", content: q }], prior = history(), used = [];
    let final = null, fail = null;
    try {
      for (let step = 0; step < MAX_STEPS && !final && !fail; step++) {
        if (S.turns >= S.cap) { fail = `You reached the limit of ${S.cap} requests for this session. Reload the page to start a new session.`; break; }
        const res = await callChat(prior.concat(round));
        if (res.err) { fail = res.err; if (res.offline) S.status = "offline"; break; }
        const j = res.j, content = Array.isArray(j.content) ? j.content : [];
        if (j.stop_reason === "tool_use") {
          round.push({ role: "assistant", content });
          const results = content.filter(b => b.type === "tool_use").map(b => { used.push(b.name); const o = runTool(b.name, b.input);
            return { type: "tool_result", tool_use_id: b.id, content: o.text, ...(o.error ? { is_error: true } : {}) }; });
          if (!results.length) { fail = "The AI service asked for a tool without naming it."; break; }
          round.push({ role: "user", content: results });
          continue;
        }
        if (j.stop_reason === "pause_turn") { round.push({ role: "assistant", content }); continue; }
        content.filter(b => b.type === "server_tool_use").forEach(b => used.push(b.name));
        let text = content.filter(b => b.type === "text").map(b => b.text).join("\n\n").trim();
        if (j.stop_reason === "refusal") text = "The assistant declined to answer this request.";
        if (!text) text = "No answer was returned. Try asking in another way.";
        if (j.stop_reason === "max_tokens") text += "\n\n*(The answer was cut at the length limit.)*";
        final = text;
        round.push({ role: "assistant", content: [{ type: "text", text }] });
      }
      if (!final && !fail) fail = `Stopped after ${MAX_STEPS} steps without a final answer. Try a narrower question.`;
    } catch (e) { fail = "Something went wrong in the page: " + cut(e.message, 120); }
    wait.remove();
    S.charts.forEach(c => add("as-a", c));
    if (final) {
      S.rounds.push(round);
      const u = [...new Set(used)];
      add("as-a", md(final) + `<p class="as-used">Used: ${u.length ? u.map(h).join(", ") : "no data tool (not based on the app's numbers)"}</p>`);
    } else {
      add("as-e", `<p>${h(fail)}</p>`);
      if (S.status === "offline") offline();
    }
    setBusy(false);
    if (!panel.hidden) inEl.focus();
  }

  // ---------- printable export (browser Print to PDF), no library ----------
  function exportView() {
    const when = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const body = S.log.map(x => x.cls === "as-u" ? `<div class="q"><b>Question</b>${x.html}</div>` : x.cls === "as-e" ? `<div class="e">${x.html}</div>` : `<div class="a">${x.html}</div>`).join("")
      .replace(/<a href="#[^"]*">([^<]*)<\/a>/g, "$1");   // in-app tab links only work inside the app
    const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Assistant conversation - Paragon Crisis Portal</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;background:#fff;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0 0 4px}
.meta{color:#555;font-size:12.5px;margin:0 0 12px}.disc{border:1px solid #ffd8a8;background:#fff4e6;color:#7a3e00;padding:8px 10px;border-radius:8px;font-size:13px}
.q{margin:16px 0 6px;padding:8px 10px;background:#eef3fd;border-radius:8px}.q b{display:block;font-size:12px;color:#1a4f9c}.a{margin:6px 0}.e{margin:6px 0;padding:6px 10px;border-left:4px solid #c2410c;background:#f6f6f6}
.as-used{color:#555;font-size:12px}table{border-collapse:collapse;font-size:12.5px}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left}a{color:#1a66e0}
.as-chart{border:1px solid #ddd;border-radius:8px;padding:8px;max-width:520px}.as-chart svg{width:100%;height:auto}.as-bar{fill:#1a66e0}.as-chart text{fill:#111;font-size:11px}.as-ct{font-weight:700;font-size:12px}.as-cm{fill:#555}
.noprint{margin:12px 0}@media print{.noprint{display:none}.q,.a,.as-chart{break-inside:avoid}}</style></head><body>
<h1>Assistant conversation</h1><p class="meta">Paragon Crisis Portal &middot; exported ${h(when)}</p>
<p class="disc">${h(DISCLAIMER)} Figures come from the app's data (July 2021 floods, mapped areas only); check them in the tabs before use.</p>
<p class="noprint"><button type="button" onclick="window.print()">Print or save as PDF</button></p>${body}</body></html>`;
    const w = window.open("", "_blank");
    if (w && w.document) { w.document.open(); w.document.write(doc); w.document.close(); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([doc], { type: "text/html" })); a.download = "assistant_conversation.html"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.PCPAssistant = { runTool: (n, i) => runTool(n, i).text, tools: TOOLS.map(t => t.name), md };
})();
