// ===== "My route": drop a pin, see the roads to the nearest shelters that AVOID the flood data. Inlined by build_app.py before app_tabs.js.
// Team principle: the flood data is the safe side. A road outside our water data is treated as passable even in a flood this large;
// roads inside it get a heavy cost (observed 2021 flood: x1000, modelled 100-year zone: x40, 500-year zone: x6, see config.json).
// Everything runs in the browser: the pin and the road data never leave the page. Uses globals of app_tabs.js (CT, ALLPLACES, matches, nm, esc, fmt, newMap, floodLayer, inGeom) at call time only.
const RT = {};   // per country: meta (always there) and g (decoded road graph, after the data file is loaded)
Object.keys(D.routing || {}).forEach(cc => { RT[cc] = { meta: D.routing[cc], g: null, loading: null }; });
const RP = D.cfg;
const R_COL = { dry: "#1c7ed6", obs: "#c92a2a", r100: "#f76707", r500: "#e0a800" };
const rState = { kind: "shelter", mode: "foot", pin: null };
let mRoute = null, pinMarker = null, routeGroup = null, rZone = [];

// ---------- road data ----------
const b64bytes = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const typed = (s, T) => { const u = b64bytes(s); return new T(u.buffer, 0, u.byteLength / T.BYTES_PER_ELEMENT); };
function decodeGraph(R) {
  const g = { n: R.n, m: R.m, lon: typed(R.lon, Int32Array), lat: typed(R.lat, Int32Array), a: typed(R.a, Int32Array), b: typed(R.b, Int32Array), len: typed(R.len, Uint32Array),
    c: typed(R.c, Uint8Array), f: typed(R.f, Uint8Array), off: typed(R.off, Uint32Array), shp: typed(R.shp, Int32Array), dest: R.dest, speed: R.speed, bbox: R.bbox };
  const deg = new Int32Array(g.n + 1);                       // adjacency in CSR form: every edge gives up to two arcs
  for (let e = 0; e < g.m; e++) { deg[g.a[e] + 1]++; deg[g.b[e] + 1]++; }
  for (let i = 0; i < g.n; i++) deg[i + 1] += deg[i];
  g.start = deg; g.arcs = new Int32Array(2 * g.m);          // arc id = edge * 2 + (0: a to b, 1: b to a)
  const fill = deg.slice(0, g.n);
  for (let e = 0; e < g.m; e++) { g.arcs[fill[g.a[e]]++] = 2 * e; g.arcs[fill[g.b[e]]++] = 2 * e + 1; }
  // connected parts of the network, per mode: a pin must start in a part that reaches a destination (not on an isolated path)
  const components = bit => { const p = new Int32Array(g.n); for (let i = 0; i < g.n; i++) p[i] = i;
    const find = x => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    for (let e = 0; e < g.m; e++) if (g.f[e] & bit) { const ra = find(g.a[e]), rb = find(g.b[e]); if (ra !== rb) p[ra] = rb; }
    for (let i = 0; i < g.n; i++) p[i] = find(i); return p; };
  g.comp = { foot: components(2), car: components(1) };
  g.cell = 0.01; g.grid = new Map();                          // grid of nodes to snap the pin to the road network
  for (let i = 0; i < g.n; i++) { const k = Math.floor(g.lon[i] / 1e5 / g.cell) + "," + Math.floor(g.lat[i] / 1e5 / g.cell); let l = g.grid.get(k); if (!l) g.grid.set(k, l = []); l.push(i); }
  return g;
}
function loadGraph(cc) {
  const R = RT[cc];
  if (R.g) return Promise.resolve(R.g);
  if (R.loading) return R.loading;
  return (R.loading = new Promise((ok, fail) => {
    const s = document.createElement("script"); s.src = R.meta.file;   // a script tag also works when the page is opened as a local file
    s.onload = () => { try { R.g = decodeGraph(window.ROUTE_DATA[cc]); ok(R.g); } catch (e) { R.loading = null; fail(e); } };
    s.onerror = () => { R.loading = null; fail(new Error("the road data file could not be loaded (" + R.meta.file + ")")); };
    document.head.appendChild(s);
  }));
}
const countryAt = (lat, lon) => Object.keys(RT).find(cc => { const b = RT[cc].meta.bbox; return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && inGeom([lon, lat], RT[cc].meta.cover); });

// ---------- routing ----------
const arcOk = (g, arc, mode) => { const e = arc >> 1, f = g.f[e], rev = arc & 1;
  if (mode === "foot") return (f & 2) !== 0;
  if (!(f & 1)) return false;
  if ((f & 4) && rev) return false;     // one-way, forward only
  if ((f & 8) && !rev) return false;    // one-way, backward only
  return true; };
const speedMs = (g, e, mode) => mode === "foot" ? 1.33 : (g.speed[g.c[e]] || 30) / 3.6;   // 4.8 km/h on foot; car speeds by road class (planning values, no traffic)
const penalty = f => (f & 16) ? RP.route_pen_observed : (f & 32) ? RP.route_pen_rp100 : (f & 64) ? RP.route_pen_rp500 : 1;
function snap(g, lat, lon, mode, roots) {   // nearest road point (in a part of the network that reaches a destination)
  const cx = Math.floor(lon / g.cell), cy = Math.floor(lat / g.cell);
  for (const r of [1, 2, 4]) {
    let best = -1, bd = Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const l = g.grid.get((cx + dx) + "," + (cy + dy)); if (!l) continue;
      for (const i of l) { if (roots && !roots.has(g.comp[mode][i])) continue;
        const d = Math.hypot((g.lon[i] / 1e5 - lon) * Math.cos(lat * Math.PI / 180), g.lat[i] / 1e5 - lat);
        if (d < bd) { let ok = false; for (let k = g.start[i]; k < g.start[i + 1]; k++) if (arcOk(g, g.arcs[k], mode)) { ok = true; break; } if (ok) { bd = d; best = i; } } }
    }
    if (best >= 0) return { node: best, meters: bd * 111000 };
  }
  return null;
}
// road points within `maxM` metres of the pin that a trip can start from (in a part of the network that reaches a destination): the `limit` nearest,
// plus the nearest few in each of 24 directions, so that a dry start on the far side of a flooded patch is tried as well
function candidates(g, lat, lon, mode, roots, maxM, limit) {
  const cx = Math.floor(lon / g.cell), cy = Math.floor(lat / g.cell), out = [], cosl = Math.cos(lat * Math.PI / 180), R = Math.ceil(maxM / 111000 / g.cell) + 1;
  for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
    const l = g.grid.get((cx + dx) + "," + (cy + dy)); if (!l) continue;
    for (const i of l) { if (roots && !roots.has(g.comp[mode][i])) continue;
      const ex = (g.lon[i] / 1e5 - lon) * cosl * 111000, ny = (g.lat[i] / 1e5 - lat) * 111000, m = Math.hypot(ex, ny); if (m > maxM) continue;
      let ok = false; for (let k = g.start[i]; k < g.start[i + 1]; k++) if (arcOk(g, g.arcs[k], mode)) { ok = true; break; }
      if (ok) out.push({ node: i, meters: m, sector: Math.floor((Math.atan2(ex, ny) + Math.PI) / (2 * Math.PI) * 24) % 24 }); }
  }
  out.sort((a, b) => a.meters - b.meters);
  const keep = new Set(out.slice(0, limit)), per = new Map();
  out.forEach(c => { const n = per.get(c.sector) || 0; if (n < 6) { per.set(c.sector, n + 1); keep.add(c); } });
  return out.filter(c => keep.has(c));
}
// the 2021 flood outline of a country, one entry per polygon with its bounding box
const floodIdx = {};
function floodPolys(cc) {
  return floodIdx[cc] || (floodIdx[cc] = (g => (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map(poly => ({ bb: bboxOf({ type: "Polygon", coordinates: [poly[0]] }), poly })))(D.countries[cc].water.flood.geometry));
}
// the polygons within `deg` degrees of a point: tested again and again for one pin, so the short list is made once
const floodNear = (cc, lat, lon, deg) => floodPolys(cc).filter(({ bb }) => lon >= bb[0] - deg && lon <= bb[2] + deg && lat >= bb[1] - deg && lat <= bb[3] + deg);
const inList = (list, lon, lat) => list.some(({ bb, poly }) => lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3] && inRing([lon, lat], poly[0]) && !poly.slice(1).some(h => inRing([lon, lat], h)));
const inFlood = (cc, lon, lat) => inList(floodNear(cc, lat, lon, 0), lon, lat);
// share of the straight pin-to-road line inside the flood outline (0 to 1), a point every ~15 m, and counted if a point ~20 m to either side is inside too
function wetShare(list, lat, lon, nlat, nlon) {
  const m = Math.hypot((nlon - lon) * Math.cos(lat * Math.PI / 180), nlat - lat) * 111000, N = Math.min(120, Math.max(8, Math.ceil(m / 15))), e = 0.0002;
  let w = 0;
  for (let s = 0; s <= N; s++) { const x = lon + (nlon - lon) * s / N, y = lat + (nlat - lat) * s / N, edge = s * m / N < 25 || (N - s) * m / N < 25;   // the margin is not applied at the two ends: a pin or a road just beside the outline is not "in" it
    if (inList(list, x, y) || (!edge && (inList(list, x + e, y) || inList(list, x - e, y) || inList(list, x, y + e) || inList(list, x, y - e)))) w++; }
  return w / (N + 1);
}
function search(g, src, mode, targets, isGood, wantGood) {
  const n = g.n, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const hd = [], hn = [];   // binary heap of (cost, node)
  const push = (d, v) => { let i = hd.length; hd.push(d); hn.push(v); while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hd[i] = hd[p]; hn[i] = hn[p]; i = p; } hd[i] = d; hn[i] = v; };
  const pop = () => { const d0 = hd[0], v0 = hn[0], d = hd.pop(), v = hn.pop(); const L = hd.length;
    if (L) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= L) break; if (c + 1 < L && hd[c + 1] < hd[c]) c++; if (hd[c] >= d) break; hd[i] = hd[c]; hn[i] = hn[c]; i = c; } hd[i] = d; hn[i] = v; } return [d0, v0]; };
  (Array.isArray(src) ? src : [{ node: src, d: 0 }]).forEach(s => { if (s.d < dist[s.node]) { dist[s.node] = s.d; push(s.d, s.node); } });   // one start, or several candidate starts each with its own cost
  const found = []; let good = 0;
  while (hd.length) {
    const [d, u] = pop(); if (d > dist[u]) continue;
    const t = targets.get(u);
    if (t) for (const di of t) { found.push({ di, cost: d, node: u }); if (isGood(di)) good++; }
    if (good >= wantGood) break;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const arc = g.arcs[k]; if (!arcOk(g, arc, mode)) continue;
      const e = arc >> 1, v = (arc & 1) ? g.a[e] : g.b[e], nd = d + g.len[e] / speedMs(g, e, mode) * penalty(g.f[e]);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = arc; push(nd, v); }
    }
  }
  return { found, prev };
}
function pathOf(g, prev, node) {   // arcs from the origin to the node
  const arcs = []; for (let a = prev[node]; a >= 0; a = prev[(a & 1) ? g.b[a >> 1] : g.a[a >> 1]]) arcs.push(a);
  return arcs.reverse();
}
function arcPoints(g, arc) {       // [lat, lon] points of one arc, shape included
  const e = arc >> 1, pts = [[g.lat[g.a[e]] / 1e5, g.lon[g.a[e]] / 1e5]];
  for (let i = g.off[e]; i < g.off[e + 1]; i++) pts.push([g.shp[2 * i + 1] / 1e5, g.shp[2 * i] / 1e5]);
  pts.push([g.lat[g.b[e]] / 1e5, g.lon[g.b[e]] / 1e5]);
  return (arc & 1) ? pts.reverse() : pts;
}
function describe(g, arcs, mode) {  // length, time without penalties, metres inside each kind of water data
  const s = { len: 0, sec: 0, obs: 0, r100: 0, r500: 0 };
  arcs.forEach(a => { const e = a >> 1, f = g.f[e], l = g.len[e]; s.len += l; s.sec += l / speedMs(g, e, mode);
    if (f & 16) s.obs += l; else if (f & 32) s.r100 += l; else if (f & 64) s.r500 += l; });
  return s;
}
const mins = sec => { const m = Math.max(1, Math.round(sec / 60)); return m >= 90 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
const km1 = m => m < 1000 ? `${fmt(Math.round(m / 10) * 10)} m` : `${fmt(m / 1000, 1)} km`;

// ---------- the tab ----------
const rOut = html => { document.getElementById("routeOut").innerHTML = html; };
function drawRoutes(g, results) {
  routeGroup.clearLayers();
  const link = (a, b, wet) => (wet ? L.polyline([a, b], { color: R_COL.obs, weight: 3, dashArray: "2 6", interactive: false })
    : themed(L.polyline([a, b], { color: "#495057", weight: 2, dashArray: "2 6", interactive: false }), t => ({ color: t === "dark" ? "#c3cad3" : "#495057" }))).addTo(routeGroup);   // pin and destination are snapped to the road network: show the short gap
  const pin = rState.pin;
  results.forEach((r, i) => {
    if (pin) link([pin.lat, pin.lon], [g.lat[r.start] / 1e5, g.lon[r.start] / 1e5], r.linkWet);
    if (r.arcs.length) { const pts = arcPoints(g, r.arcs[r.arcs.length - 1]), end = pts[pts.length - 1], d0 = g.dest[r.di]; link(end, [d0.lat, d0.lon]); }
    let seg = [], kind = null;
    const flush = () => { if (seg.length > 1) L.polyline(seg, { color: R_COL[kind], weight: i === 0 ? 6 : 3, opacity: i === 0 ? 0.95 : 0.6, dashArray: i === 0 ? null : "6 6" }).addTo(routeGroup); };
    r.arcs.forEach(a => { const f = g.f[a >> 1], k = (f & 16) ? "obs" : (f & 32) ? "r100" : (f & 64) ? "r500" : "dry", pts = arcPoints(g, a);
      if (k !== kind) { flush(); seg = pts.slice(); kind = k; } else seg.push(...pts.slice(1)); });
    flush();
    const d = g.dest[r.di];
    L.circleMarker([d.lat, d.lon], { radius: 11, color: "#111", weight: 2, fillColor: d.f === 0 ? "#2f9e44" : "#f2c14e", fillOpacity: 1 })
      .bindTooltip(`${i + 1}. ${esc(d.n || "(no name in OpenStreetMap)")}`, { permanent: true, direction: "top" }).addTo(routeGroup);
  });
}
function showResults(g, cc, snapInfo, results, mode, kind, notes) {
  const label = kind === "medical" ? "hospital or clinic" : "shelter or reception place";
  const items = results.map((r, i) => {
    const d = g.dest[r.di], s = r.stats, water = s.obs + s.r100 + s.r500;
    const wet = water === 0 ? `<span class="st st-dry">${svg("check", 14)}<span><b>No water from our data on this route.</b></span></span>`
      : `<span class="st st-wet">${svg("wave", 14)}<span><b>Still crosses water from our data:</b> ${s.obs ? `${km1(s.obs)} of the 2021 flood` : ""}${s.obs && (s.r100 || s.r500) ? ", " : ""}${s.r100 ? `${km1(s.r100)} of the modelled 100-year zone` : ""}${s.r100 && s.r500 ? ", " : ""}${s.r500 ? `${km1(s.r500)} of the 500-year zone` : ""}. It is the least-wet route we found.</span></span>`;
    return `<li class="rt-card${i === 0 ? " first" : ""}"><div class="rt-head"><span class="rt-n">${i + 1}</span><b>${esc(d.n || "(no name in OpenStreetMap)")}</b> <span class="muted">${esc(SINGULAR[d.t] || d.t)}</span></div>
      <div class="rt-big"><b>${mins(s.sec)}</b><span class="muted">${mode === "foot" ? "on foot" : "by car"} &middot;</span><b>${km1(s.len)}</b></div>${wet}
      ${d.f ? `<div class="muted" style="margin-top:6px">This place is inside the flood data (${d.f & 1 ? "2021 flood" : d.f & 2 ? "modelled 100-year zone" : "modelled 500-year zone"}): less suitable.</div>` : ""}</li>`;
  }).join("");
  const heading = kind === "medical" ? (results.length === 1 ? "hospital or clinic" : "hospitals and clinics") : (results.length === 1 ? "shelter or reception place" : "shelters and reception places");
  rOut(`${notes.join("")}<h3>Nearest ${heading}, by travel time</h3>${items ? `<ol class="rt-list">${items}</ol>` : `<p class="muted">No ${label} reachable in the covered area. Try the other option, or look at Find a region.</p>`}
    <p class="muted" style="font-size:13px">Starting road point chosen to avoid the flood outline (${fmt(snapInfo.meters, 0)} m from the pin). Times are planning values (${mode === "foot" ? "4.8 km/h" : "typical speeds by road class, no traffic"}), without stops or obstacles.
    Capacity and opening are unknown: ask the commune. Routes are drawn <span class="sw" style="background:${R_COL.dry}"></span><b>blue</b> when outside the water data, <span class="sw" style="background:${R_COL.obs}"></span><b>red</b> inside the 2021 flood, <span class="sw" style="background:${R_COL.r100}"></span><b>orange</b> inside the modelled 100-year zone, <span class="sw" style="background:${R_COL.r500}"></span><b>yellow</b> in the 500-year zone.</p>`);
}
async function placePin(lat, lon) {
  rState.pin = { lat, lon };
  if (!pinMarker) {
    pinMarker = L.marker([lat, lon], { draggable: true, icon: L.divIcon({ html: "&#128205;", className: "pin", iconSize: [28, 28], iconAnchor: [14, 26] }) }).addTo(mRoute);
    pinMarker.on("dragend", () => { const p = pinMarker.getLatLng(); placePin(p.lat, p.lng); });
  } else pinMarker.setLatLng([lat, lon]);
  await computeRoute();
}
async function computeRoute() {
  const pin = rState.pin; if (!pin) return;
  const { lat, lon } = pin, mode = rState.mode, kind = rState.kind;
  routeGroup.clearLayers();
  const cc = countryAt(lat, lon);
  if (!cc) {
    const have = Object.keys(RT).map(c => NAMES[c]).join(", ");
    rOut(`<div class="note"><b>Outside the covered area.</b> Routes are planned only around the mapped floods (${esc(have)}); the dashed outlines on the map show where. For other places, use <a href="#region">Find a region</a>.</div>`);
    return;
  }
  rOut(`<p class="muted">Loading the road data for ${esc(NAMES[cc])} ...</p>`);
  let g;
  try { g = await loadGraph(cc); } catch (e) { rOut(`<div class="note"><b>Could not load the road data:</b> ${esc(e.message)}.</div>`); return; }
  if (rState.pin !== pin) return;   // the pin moved while loading
  const kinds = kind === "medical" ? ["medical"] : ["shelter", "assembly"];
  const targets = new Map();
  g.dest.forEach((d, i) => { if (kinds.includes(d.k)) { let l = targets.get(d.node); if (!l) targets.set(d.node, l = []); l.push(i); } });
  const roots = new Set([...targets.keys()].map(nd => g.comp[mode][nd]));   // only start from a part of the network that reaches a destination
  const nearest = snap(g, lat, lon, mode, roots);   // nearest road point, whatever the water
  if (!nearest) { rOut(`<div class="note">No ${mode === "foot" ? "walkable" : "drivable"} road near this point leads to a ${kind === "medical" ? "hospital or clinic" : "shelter"}. Move the pin onto a main road, or try the other way of travelling.</div>`); return; }
  if (nearest.meters > 1500) { rOut(`<div class="note">The nearest road that leads anywhere is ${fmt(nearest.meters / 1000, 1)} km from this point. Move the pin closer to a road.</div>`); return; }
  // Where to start: not simply the nearest road point. Every road point within reach is a possible start; the straight line from the pin to it costs
  // walking time, multiplied by the observed-flood penalty for the part inside the 2021 flood outline. One search from all of them finds the cheapest whole trip.
  const all = candidates(g, lat, lon, mode, roots, Math.max(1500, nearest.meters * 1.5), 60), nearFlood = floodNear(cc, lat, lon, 0.03);
  all.forEach(c => { c.wet = wetShare(nearFlood, lat, lon, g.lat[c.node] / 1e5, g.lon[c.node] / 1e5); c.d = c.meters / 1.33 * (1 + (RP.route_pen_observed - 1) * c.wet); });
  const dry = all.filter(c => c.wet === 0), cand = dry.length ? dry : all;   // a start whose line to the pin touches the flood is used only when there is no other start
  const good = di => g.dest[di].f === 0;                            // outside all the water data
  const { found, prev } = search(g, cand.map(c => ({ node: c.node, d: c.d })), mode, targets, good, 3);
  const pick = found.filter(x => good(x.di)).slice(0, 3);
  if (pick.length < 3) found.filter(x => !good(x.di)).slice(0, 3 - pick.length).forEach(x => pick.push(x));
  const byNode = new Map(all.map(c => [c.node, c]));
  const results = pick.map(x => { const arcs = pathOf(g, prev, x.node), start = arcs.length ? ((arcs[0] & 1) ? g.b[arcs[0] >> 1] : g.a[arcs[0] >> 1]) : x.node, c = byNode.get(start);
    return { di: x.di, arcs, start, linkWet: c ? c.wet > 0 : false, linkM: c ? c.meters : 0, linkWetM: c ? c.meters * c.wet : 0, stats: describe(g, arcs, mode) }; });
  rState.results = results;
  const first = results[0], info = { node: first ? first.start : nearest.node, meters: first ? first.linkM : nearest.meters };
  drawRoutes(g, results);
  const fg = D.countries[cc].water.flood.geometry;
  const nearWet = byNode.get(nearest.node), moved = first && first.start !== nearest.node && nearWet && nearWet.wet > 0;
  // where the pin stands against the water data
  const here = inFlood(cc, lon, lat);
  let near = 0; for (let k = g.start[info.node]; k < g.start[info.node + 1]; k++) near |= g.f[g.arcs[k] >> 1];
  const notes = [];
  if (here || (near & 16)) notes.push(`<div class="note" style="border-left-color:#c92a2a"><b>Your pin is inside the 2021 flood data.</b> The route leaves it by the way that crosses the least water. In a real flood, follow the instructions of the authorities and ${esc(ALERT[cc])}.</div>`);
  else if (near & 32) notes.push(`<div class="note" style="border-left-color:#f76707">The roads next to your pin are inside the <b>modelled 100-year flood zone</b>.</div>`);
  else if (near & 64) notes.push(`<div class="note" style="border-left-color:#e0a800">The roads next to your pin are inside the <b>modelled 500-year flood zone</b>.</div>`);
  else notes.push(`<p>The roads next to your pin are <b>outside the water data</b> (2021 flood and modelled zones).</p>`);
  if (first && first.linkWetM >= 10) notes.push(`<div class="note" style="border-left-color:#c92a2a"><b>The first part is not a planned route.</b> From your pin to the road (dotted line, ${km1(info.meters)}), about ${km1(first.linkWetM)} is a straight line across the 2021 flood outline. It cannot be avoided: your pin is inside the flood, or the water lies between the pin and every road within reach. We start from the road point where this part is the shortest. The planned route below starts at that road and avoids the water where it can.</div>`);
  else if (moved) notes.push(`<div class="note" style="border-left-color:#2f9e44">The nearest road point is inside the flood outline. The route starts instead from a road point ${km1(info.meters)} away that you reach without crossing the flood outline.</div>`);
  showResults(g, cc, info, results, mode, kind, notes);
  if (results.length) { const b = L.latLngBounds([[lat, lon]]); results.forEach(r => r.arcs.forEach(a => arcPoints(g, a).forEach(p => b.extend(p)))); mRoute.fitBounds(b.pad(0.15), { maxZoom: 15 }); }
}
function initRoute() {
  if (!mRoute) {
    const keys = Object.keys(RT);
    if (!keys.length) { document.getElementById("routeOut").innerHTML = `<div class="note">The road data was not built yet (run prepare_routing.py).</div>`; return; }
    let bounds = null;
    keys.forEach(cc => { const b = RT[cc].meta.bbox, lb = L.latLngBounds([[b[1], b[0]], [b[3], b[2]]]); bounds = bounds ? bounds.extend(lb) : lb; });
    mRoute = newMap("mapRoute", bounds); routeGroup = L.layerGroup().addTo(mRoute);
    keys.forEach(cc => {   // the observed flood and the outline of the area where routes are planned
      floodLayer(cc).addTo(mRoute);
      themed(L.geoJSON({ type: "Feature", geometry: RT[cc].meta.cover }, { style: { color: "#495057", weight: 1.5, dashArray: "5 5", fill: false }, interactive: false }), t => ({ color: t === "dark" ? "#aab3bf" : "#495057" })).addTo(mRoute);
    });
    mRoute.on("click", e => placePin(e.latlng.lat, e.latlng.lng));
    document.getElementById("rGeo").addEventListener("click", () => {
      if (!navigator.geolocation) { rOut(`<div class="note">Your browser cannot give your position.</div>`); return; }
      navigator.geolocation.getCurrentPosition(p => { mRoute.setView([p.coords.latitude, p.coords.longitude], 14); placePin(p.coords.latitude, p.coords.longitude); },
        () => rOut(`<div class="note">Your position could not be read. Click the map instead.</div>`), { timeout: 15000 });
    });
    document.querySelectorAll("#tab-route input[name=rKind], #tab-route input[name=rMode]").forEach(el => el.addEventListener("change", () => {
      rState.kind = document.querySelector("input[name=rKind]:checked").value; rState.mode = document.querySelector("input[name=rMode]:checked").value; computeRoute(); }));
    document.getElementById("rZone").addEventListener("change", e => {
      rZone.forEach(l => mRoute.removeLayer(l)); rZone = [];
      if (e.target.checked) keys.forEach(cc => { const z = D.countries[cc].water.efas["100"]; rZone.push(L.imageOverlay(z.png, z.bounds, { opacity: 0.55 }).addTo(mRoute)); });
    });
    const rq = document.getElementById("rq"), rr = document.getElementById("rresults");
    rq.addEventListener("input", () => { const m = matches(rq.value).filter(p => RT[p.cc] && p.h); rr.hidden = !rq.value.trim();
      rr.innerHTML = m.length ? m.map(p => `<li><a href="#route" data-lat="${p.h.lat}" data-lon="${p.h.lon}"><span>${esc(nm(p))} <span class="muted">${p.cc.toUpperCase()}</span></span></a></li>`).join("") : `<li><a class="muted" style="pointer-events:none">No commune found in the covered countries.</a></li>`; });
    rr.addEventListener("click", e => { const a = e.target.closest("a[data-lat]"); if (!a) return; e.preventDefault(); mRoute.setView([+a.dataset.lat, +a.dataset.lon], 13); rr.hidden = true; });
  }
  setTimeout(() => mRoute.invalidateSize(), 0);
}
