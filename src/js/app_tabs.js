// ===== Plain-language tabs for Belgium, Germany and the Netherlands.
// Inlined into app/index.html by build_app.py. Reuses D, fmt, NAMES, OSM_COLORS, TYPE_LABEL from the Advanced script that comes before.
const CODES = ["be", "de", "nl"].filter(cc => D.countries[cc] && D.countries[cc].lau);
const ALERT = { be: "BE-Alert", de: "the NINA warning app", nl: "NL-Alert" };   // the official alert service of each country
// Eurostat gives many names in the local language: add the name people may search for (our own addition, not from the data)
const ALT = { "Luik": "Liège", "Wezet": "Visé", "Bitsingen": "Bassenge", "Limburg": "Limbourg", "Voeren": "Fourons", "Kelmis": "La Calamine", "Saint-Nicolas (Luik)": "Saint-Nicolas (Liège)",
  "Brussel": "Bruxelles", "Antwerpen": "Anvers", "Gent": "Gand", "Namen": "Namur", "Bergen": "Mons", "Doornik": "Tournai", "Aarlen": "Arlon", "Leuven": "Louvain", "Mechelen": "Malines",
  "Kortrijk": "Courtrai", "Oostende": "Ostende", "Brugge": "Bruges", "Hoei": "Huy", "Ieper": "Ypres", "Nijvel": "Nivelles", "Aat": "Ath", "Moeskroen": "Mouscron", "Zinnik": "Soignies",
  "Waver": "Wavre", "Tienen": "Tirlemont", "Sint-Truiden": "Saint-Trond", "Tongeren": "Tongres", "Bastenaken": "Bastogne", "Elsene": "Ixelles", "Schaarbeek": "Schaerbeek",
  "Köln, Stadt": "Cologne", "Aachen, Stadt": "Aix-la-Chapelle", "Trier, Stadt": "Trèves", "Koblenz, Stadt": "Coblence", "Mainz, Stadt": "Mayence", "Maastricht": "Maestricht" };
const nm = c => ALT[c.name] ? (c.name.includes("(") ? ALT[c.name] : `${c.name} (${ALT[c.name]})`) : c.name;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// German spellings: "Köln" is also typed "Koeln", "München" "Muenchen": both the accent-stripped and the transliterated form are compared
const norm2 = s => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
const forms = s => [...new Set([norm(s), norm2(s)])];
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const approx = n => n < 5 ? "fewer than 10" : n < 1000 ? fmt(Math.round(n / 10) * 10) : fmt(Math.round(n / 100) * 100);
const pctText = per1000 => { const p = per1000 / 10; return p < 1 ? "less than 1%" : p < 10 ? fmt(p, 1) + "%" : fmt(Math.round(p)) + "%"; };
const pc = v => v < 1 ? "less than 1%" : fmt(Math.round(v)) + "%";
const BUF = D.cfg.building_buffer_m;
const HI = D.cfg.hazard_higher_pct, LO = D.cfg.hazard_lower_pct, MINPOP = D.cfg.candidate_min_pop;
const firstOsm = CODES.map(cc => D.countries[cc].osm).find(Boolean);
const NEAR = firstOsm ? firstOsm.summary.near_m : 100, POS_IN = "in water", POS_NEAR = `within ${NEAR} m`;
const OSM_DATE = firstOsm ? firstOsm.summary.osm_date : "";

// ---------- per-country data ----------
const CT = {};
CODES.forEach(cc => {
  const C = D.countries[cc];
  const comm = C.lau.features.map(f => ({ ...f.properties, geometry: f.geometry }));
  const byId = Object.fromEntries(comm.map(c => [c.lau_id, c]));
  const hz = (D.hazard || {})[cc] || [];
  // every commune of the country can be searched (the flood model covers the whole country); the 2021 satellite map exists only for the mapped ones
  const places = hz.length ? hz.map(h => ({ id: h.id, name: h.name, cc, h, c: byId[h.id] || null })) : comm.map(c => ({ id: c.lau_id, name: c.name, cc, h: null, c }));
  CT[cc] = { cc, C, comm, byId, places, ber: (D.regions || {})[cc] || {}, bes: (D.sites || {})[cc] || [], bounds: L.geoJSON(C.lau).getBounds(),
    zones: C.flood_aoi.map(r => r.aoi.replace("Liege", "Liège")), hasHigh: comm.some(c => c.tier === "1A" || c.tier === "1B") };
});
const ALLP = Object.fromEntries(CODES.flatMap(cc => CT[cc].places.map(p => [p.id, p])));
const ALLPLACES = CODES.flatMap(cc => CT[cc].places);
let CTRY = CODES[0];
const X = () => CT[CTRY];
const ccOf = id => id.slice(0, 2).toLowerCase();
const sitesOf = id => { const r = CT[ccOf(id)]; return r && r.ber[id] ? r.ber[id].sites : null; };
const nearCount = (id, cat) => { const s = sitesOf(id); return s ? s[cat][POS_IN] + s[cat][POS_NEAR] : 0; };
const zonesText = x => x.zones.length <= 3 ? x.zones.join(" and ") : `${x.zones.length} zones (${x.zones.slice(0, 3).join(", ")} and others)`;

const SHORT = { "1A": "Highest priority", "1B": "Highest priority", "2": "Medium priority", "3": "Lower priority", "ND": "No data" };
const PLAIN = { "1A": "Highest priority: the flood reached places the hazard maps did not show", "1B": "Highest priority: known flood zone",
  "2": "Medium priority", "3": "Lower priority, or no flood detected", "ND": "No data: mostly not mapped" };
const TIER_ORD = ["1A", "1B", "2", "3", "ND"];
const onTier = k => k === "1A" ? "#fff" : "#111";   // contrast >= 4.5:1 on every tier colour
const tierLabel = c => (c.tier === "3" && c.flood_ha <= 0) ? "No flood detected" : SHORT[c.tier];
const badgeC = c => `<span class="badge" style="background:${D.tiers[c.tier].color};color:${onTier(c.tier)}">${tierLabel(c)}</span>`;
const SINGULAR = { school: "school", kindergarten: "kindergarten", hospital: "hospital", clinic: "clinic", nursing_home: "care home", assisted_living: "assisted-living site",
  prison: "prison", fire_station: "fire station", police: "police station", substation: "power substation", water_works: "water works", wastewater_plant: "wastewater plant",
  pumping_station: "pumping station", mast: "mast", tower: "tower", fuel: "fuel station", industrial: "industrial area", landfill: "landfill", works: "industrial works",
  dam: "dam", sports_hall: "sports hall", sports_centre: "sports centre", community_centre: "community centre", townhall: "town hall",
  assembly_point: "evacuation assembly point", social_centre: "social centre", events_venue: "event venue", conference_centre: "conference centre", exhibition_centre: "exhibition centre",
  place_of_worship: "place of worship", hotel: "hotel", hostel: "hostel", guest_house: "guest house", camp_site: "camp site", library: "library", theatre: "theatre",
  arts_centre: "arts centre", stadium: "stadium", civic: "civic building", public: "public building" };
const CATP = { vulnerable: "Vulnerable sites", infrastructure: "Critical infrastructure", hazard: "Possible hazard sources", shelter: "Possible shelters" };
const CAT_ORD = ["vulnerable", "infrastructure", "hazard", "shelter"];
const posText = p => p === POS_IN ? "Inside the flood" : `Within ${NEAR} m of the flood`;
const typeText = (t, n) => `${fmt(n)} ${n === 1 ? (SINGULAR[t] || t) : (TYPE_LABEL[t] || t)}`;

function headline(c) {
  const n = esc(nm(c));
  if (c.tier === "ND") return `We do not have reliable data for <b>${n}</b>: only ${fmt(c.coverage_pct)}% of it was mapped by satellite.` +
    (c.pop_exposed > 0 ? ` In the mapped part, about ${approx(c.pop_exposed)} residents lived in the flooded area.` : "");
  if (c.pop_exposed > 0) return `About <b>${approx(c.pop_exposed)} residents</b> lived in the flooded area of <b>${n}</b> (${pctText(c.per1000)} of its residents).`;
  if (c.flood_ha > 0) return `Flooding was observed in <b>${n}</b> (${fmt(c.flood_ha, 0)} hectares), but no residents were counted in the flooded area.`;
  return `No flooding was detected in the satellite map for <b>${n}</b>. This does not prove it stayed dry: satellite maps can miss floods in narrow valleys and towns.`;
}
function reason(c) {
  const R = D.rules;
  if (c.tier === "ND") return `Only ${fmt(c.coverage_pct)}% of this commune was mapped, so we cannot say how much of it was affected. Grey does not mean safe.`;
  if (c.pop_exposed <= 0) return "No residents were counted in the flooded area. Satellite maps can miss flooding in narrow valleys and built-up areas, so check against local sources.";
  const p = [];
  if (c.per1000 >= R.rate_high) p.push(`a high share of its residents (${pctText(c.per1000)}) were in the flood`);
  else if (c.per1000 >= R.rate_medium) p.push(`a medium share of its residents (${pctText(c.per1000)}) were in the flood`);
  if (c.pop_exposed >= R.abs_high) p.push(`a large number of residents (${approx(c.pop_exposed)}) were in the flood`);
  else if (c.pop_exposed >= R.abs_medium) p.push(`a medium number of residents (${approx(c.pop_exposed)}) were in the flood`);
  if (!p.length) p.push(`${approx(c.pop_exposed)} residents (${pctText(c.per1000)}) were in the flood, fewer than in most other communes`);
  const s = p.join(" and "), out = s[0].toUpperCase() + s.slice(1) + ".";
  return out + (c.tier === "1A" ? " Less than half of the flooded land was inside a known hazard-map zone, so residents may not have expected flooding there." : "");
}
const actionsFor = c => D.tiers[c.tier].actions.map(id => D.actions[id] && D.actions[id][c.country]).filter(Boolean);

// --- geometry helpers (point in polygon, for the buildings of one commune) ---
function inRing(pt, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j];
  if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
const inGeom = (pt, g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates).some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h)));
function bboxOf(g) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; (g.type === "Polygon" ? [g.coordinates] : g.coordinates).forEach(p => p[0].forEach(([x, y]) => { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); })); return [a, b, c, d]; }

// --- maps (themed basemap; new maps are created lazily, the first time their tab is opened) ---
function newMap(id, bounds) {
  const m = L.map(id, { preferCanvas: true });
  // Esri grey canvas + place names, light or dark with the theme (addBasemap keeps them in the registry the theme toggle updates)
  addBasemap(m, "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ. Sites: &copy; OpenStreetMap contributors");
  m.fitBounds(bounds);
  return m;
}
// a NEW layer every time: a Leaflet layer can belong to one map only, and three maps (map, region, sites) show the flood outline
const floodLayer = cc => L.geoJSON(D.countries[cc].water.flood, { style: { color: "#0b5cad", weight: 1, fillColor: "#3b9cff", fillOpacity: 0.5 }, interactive: false });
const siteTip = s => `<b>${esc(s.name || "(no name in OpenStreetMap)")}</b><br>${SINGULAR[s.type] || s.type} &middot; ${posText(s.position)}${s.commune ? "<br>" + esc(s.commune) : ""}`;
const siteMarker = s => L.circleMarker([s.lat, s.lon], { radius: 7, color: "#111", weight: 2, fillColor: OSM_COLORS[s.categorie], fillOpacity: 0.95 }).bindTooltip(siteTip(s));
const communePopup = c => `<div style="max-width:260px"><b>${esc(nm(c))}</b><br>${badgeC(c)}<div style="margin:6px 0">${headline(c)}</div><a href="#region/${c.lau_id}"><b>Open the region page</b></a></div>`;

// ---------- country selector (Overview, Map, Priority list, Sites) ----------
const ctryBox = document.getElementById("ctry");
ctryBox.innerHTML = CODES.map(cc => `<button type="button" class="chip" data-cc="${cc}" aria-pressed="${cc === CTRY}">${NAMES[cc]}</button>`).join("");
function syncCtry() { ctryBox.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.cc === CTRY)); }
ctryBox.addEventListener("click", e => { const b = e.target.closest("button[data-cc]"); if (!b) return; CTRY = b.dataset.cc; syncCtry(); route(); });

// ---------- Overview ----------
// Small inline SVG icon set (one style: 24 px grid, rounded 1.8 px strokes or plain fills, colour = currentColor): no image files, works offline
const ICON = {
  person: '<circle cx="12" cy="7.5" r="4"/><path d="M4 21.5c0-4.6 3.6-8 8-8s8 3.4 8 8z"/>',
  house: '<path d="M3 11.2 12 3l9 8.2V21H3z"/><path d="M10 21v-5.5h4V21" fill="none" stroke="var(--card)" stroke-width="1.6"/>',
  wave: '<path d="M3 8.5c3-3 6 3 9 0s6 3 9 0M3 14c3-3 6 3 9 0s6 3 9 0M3 19.5c3-3 6 3 9 0s6 3 9 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  shield: '<path d="M12 2.5 20 5.5v6c0 5-3.4 8.7-8 10.5-4.6-1.8-8-5.5-8-10.5v-6z"/><path d="M12 8v7M8.5 11.5h7" fill="none" stroke="var(--card)" stroke-width="2" stroke-linecap="round"/>',
  cross: '<circle cx="12" cy="12" r="10"/><path d="M12 7v10M7 12h10" fill="none" stroke="var(--card)" stroke-width="2.2" stroke-linecap="round"/>',
  school: '<path d="M2 9.5 12 4.5l10 5-10 5z"/><path d="M6 12.5v4.2c0 1.6 2.7 3 6 3s6-1.4 6-3v-4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  care: '<path d="M3 11.2 12 3l9 8.2V21H3z"/><path d="M12 17.5s-3.2-1.9-3.2-4.1a1.8 1.8 0 0 1 3.2-1.1 1.8 1.8 0 0 1 3.2 1.1c0 2.2-3.2 4.1-3.2 4.1z" fill="var(--card)"/>',
  pin: '<path d="M12 2.5c-4 0-7 3-7 6.9 0 5 7 12.1 7 12.1s7-7.100 7-12.100c0-3.900-3-6.900-7-6.900z"/><circle cx="12" cy="9.400" r="2.600" fill="var(--card)"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  alert: '<path d="M12 3 22 20H2z"/><path d="M12 9.500v4.500M12 17v.1" fill="none" stroke="var(--card)" stroke-width="2.200" stroke-linecap="round"/>',
  map: '<path d="M9 4 3 6.500v13.500l6-2.500 6 2.500 6-2.500V4l-6 2.500z"/><path d="M9 4v13.500M15 6.500V20" fill="none" stroke="var(--card)" stroke-width="1.600"/>',
  route: '<circle cx="6" cy="18" r="2.600"/><circle cx="18" cy="6" r="2.600"/><path d="M6 15.400V9a3 3 0 0 1 3-3h6.200M18 8.600V15a3 3 0 0 1-3 3H8.800" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  list: '<path d="M8 6.500h13M8 12h13M8 17.500h13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.800" cy="6.500" r="1.500"/><circle cx="3.800" cy="12" r="1.500"/><circle cx="3.800" cy="17.500" r="1.500"/>',
  search: '<circle cx="10.500" cy="10.500" r="6.500" fill="none" stroke="currentColor" stroke-width="2.200"/><path d="m15.500 15.500 5.500 5.500" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6M4.8 4.8l1.8 1.8M17.4 17.4l1.8 1.8M4.8 19.2l1.8-1.8M17.4 6.6l1.8-1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  moon: '<path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z"/>',
  download: '<path d="M12 3.5v11M7 10l5 5 5-5M4.5 19.5h15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  print: '<path d="M7 9V3.5h10V9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4.5 9h15a2 2 0 0 1 2 2v6h-4v-2.5h-11V17h-4v-6a2 2 0 0 1 2-2z"/><path d="M7 14.5h10v6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  filter: '<path d="M3 4.5h18l-7 8.2v6.3l-4 2v-8.3z"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5.2l3.4 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  flame: '<path d="M12 2.5c.6 3.2 2.6 4.8 4.2 6.6A7 7 0 0 1 19 14.2a7 7 0 0 1-14 0c0-2.6 1.3-4.4 2.6-5.6.2 1.7 1 2.8 2.2 3.3C9.4 8.4 10.4 5 12 2.5z"/>',
  bed: '<path d="M2.5 6v13M2.5 15.5h19V19M21.5 15.5v-3.2a3 3 0 0 0-3-3H11v6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.8" cy="11.8" r="2.3"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  road: '<path d="M9 3 5 21M15 3l4 18M12 5v2.5M12 10.8v2.5M12 16.5V19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  walk: '<circle cx="13" cy="4.5" r="2.2"/><path d="M10.5 21l2-6.5 2.5 2.5V21M8 12.5l2-4.5 3.5-.5 2.5 3.5 2.5 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  car: '<path d="M5 11.5 6.8 6.6a2 2 0 0 1 1.9-1.3h6.6a2 2 0 0 1 1.9 1.3l1.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3.5 12.5A1.5 1.5 0 0 1 5 11h14a1.5 1.5 0 0 1 1.5 1.5V17h-17z"/><path d="M5.5 17v2.2M18.5 17v2.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7.5v.1" fill="none" stroke="var(--card)" stroke-width="2.2" stroke-linecap="round"/>',
  layers: '<path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="m2.5 12.5 9.5 5 9.5-5M2.5 16.5l9.5 5 9.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  sites: '<path d="M12 2.500c-4 0-7 3-7 6.900 0 5 7 12.100 7 12.100s7-7.100 7-12.100c0-3.900-3-6.900-7-6.900z"/><circle cx="12" cy="9.400" r="2.600" fill="var(--card)"/>'
};
const svg = (name, size = 20, extra = "") => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" ${extra}>${ICON[name]}</svg>`;
// static buttons of the page carry data-ic="name": their icon is added here (one icon set, no image files)
document.querySelectorAll("[data-ic]").forEach(el => el.insertAdjacentHTML("afterbegin", svg(el.dataset.ic, 16)));
// theme button: ONE theme for the whole app (dark or light, maps included), remembered by the browser
(function () {
  const b = document.getElementById("themeBtn"); if (!b) return;
  b.innerHTML = ["sun", "moon"].map(n => `<svg class="ic th-${n}" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${ICON[n]}</svg>`).join("");
  b.addEventListener("click", () => setTheme(curTheme() === "dark" ? "light" : "dark"));
  syncThemeBtn();
})();
const SITE_ICON = { hospital: "cross", clinic: "cross", school: "school", kindergarten: "school", nursing_home: "care", assisted_living: "care", prison: "shield" };
// pictogram row: one icon stands for `unit` residents (or buildings...); the last icon is partly filled for the remainder, so the row is the true number, rounded
function pictogram(name, value, unit, size, label) {
  const full = Math.floor(value / unit), part = value / unit - full, items = [];
  for (let i = 0; i < full; i++) items.push(svg(name, size));
  if (part >= 0.08) { const id = "pg" + name + Math.round(value);
    items.push(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="${id}"><stop offset="${part}" stop-color="currentColor"/><stop offset="${part}" stop-color="currentColor" stop-opacity=".18"/></linearGradient></defs><g fill="url(#${id})">${ICON[name]}</g></svg>`); }
  return `<div class="pic" role="img" aria-label="${esc(label)}">${items.join("")}</div>`;
}
const niceUnit = (v, maxIcons) => [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000].find(u => v / u <= maxIcons) || 500000;
// thin bar on a lighter track of the same colour (the unfilled part reads as part of the same measure)
const bar = (share, tip) => `<div class="mbar" title="${esc(tip)}"><i style="width:${Math.max(2, Math.round(share * 100))}%"></i></div>`;

function renderOverview() {
  const x = X(), C = x.C, N = NAMES[CTRY];
  const ha = C.flood_aoi.reduce((a, r) => a + Number(r.eau_ha), 0);
  const v = x.bes.filter(s => s.categorie === "vulnerable"), vIn = v.filter(s => s.position === POS_IN).length;
  const vTypes = [...v.reduce((m, s) => m.set(s.type, (m.get(s.type) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  const top = x.comm.filter(c => c.pop_exposed > 0).sort((a, b) => b.pop_exposed - a.pop_exposed).slice(0, 3);
  const others = CODES.filter(cc => cc !== CTRY).map(cc => NAMES[cc]).join(" and ");
  const res = C.pop.pop_exposed, rUnit = niceUnit(res, 12);
  const bs = C.buildings_summary, inShare = bs.count ? bs.inside / bs.count : 0;
  const zonesBars = [...C.flood_aoi].sort((a, b) => b.eau_ha - a.eau_ha).slice(0, 4), maxHa = Math.max(...zonesBars.map(r => Number(r.eau_ha)), 1);
  const steps = [["#map", "map", "Look at the map", "See which communes were most affected. Click one for a summary."],
    ["#region", "search", "Find a region", "Search any commune of the three countries: its exposure, what was in the 2021 flood, what to tell residents."],
    ["#priority", "list", "Use the priority list", "The communes ranked by residents in the flood. Download it as a spreadsheet."],
    ["#sites", "sites", "Check sites near the flood", "Schools, hospitals, care homes and other sites in or next to the flood."],
    ["#route", "route", "Plan a route", "Drop a pin and see the roads to the nearest shelters, planned to avoid the water in our data."]];
  document.getElementById("ovBody").innerHTML = `
    <section class="ov-hero">
      <div class="ov-eyebrow">${svg("wave", 18)} Flood preparedness &middot; ${esc(N)}</div>
      <h1>What the satellite maps show for ${esc(N)}, July 2021</h1>
      <p>Satellites mapped the flood in ${esc(zonesText(x))}. This tool shows what was inside the mapped flood: people, buildings and important sites. Choose a tab above to explore.</p>
    </section>
    <div class="ov-grid">
      <article class="ov-card ov-hero-card">
        <div class="ov-label"><span class="ov-badge">${svg("person", 18)}</span>Residents in the flooded area</div>
        <div class="ov-value ov-xl">about ${approx(res)}</div>
        ${pictogram("person", res, rUnit, 40, `${fmt(Math.round(res / 100) * 100)} residents, one icon is about ${fmt(rUnit)} residents`)}
        <div class="ov-cap">Each icon is about ${fmt(rUnit)} residents (GHS-POP 2020, an estimate).</div>
      </article>
      <article class="ov-card">
        <div class="ov-label"><span class="ov-badge">${svg("house", 18)}</span>Buildings in or near the flood</div>
        <div class="ov-value">${fmt(bs.count)}</div>
        <div class="pic pic-split" role="img" aria-label="${fmt(bs.inside)} of ${fmt(bs.count)} buildings are strictly inside the flood">${Array.from({ length: 10 }, (_, i) => `<span class="${i < Math.round(inShare * 10) ? "on" : "off"}">${svg("house", 22)}</span>`).join("")}</div>
        <div class="ov-cap"><b>${fmt(bs.inside)}</b> strictly inside, ${fmt(bs.count - bs.inside)} within ${BUF} m of it.</div>
      </article>
      <article class="ov-card">
        <div class="ov-label"><span class="ov-badge">${svg("wave", 18)}</span>Flooded land mapped</div>
        <div class="ov-value">${fmt(Math.round(ha / 10) * 10)} <small>ha</small></div>
        <div class="ov-bars">${zonesBars.map(r => `<div class="ov-row"><span title="${esc(r.aoi)}">${esc(r.aoi)}</span>${bar(Number(r.eau_ha) / maxHa, `${r.aoi}: ${fmt(Math.round(r.eau_ha))} ha flooded`)}<b>${fmt(Math.round(r.eau_ha))}</b></div>`).join("")}</div>
        <div class="ov-cap">Hectares flooded in ${x.zones.length === 1 ? "the zone" : "the " + x.zones.length + " mapped zones"}${x.zones.length > zonesBars.length ? " (largest shown)" : ""}.</div>
      </article>
      <article class="ov-card">
        <div class="ov-label"><span class="ov-badge">${svg("shield", 18)}</span>Vulnerable sites near the flood</div>
        <div class="ov-value">${v.length}</div>
        <div class="ov-chips">${vTypes.length ? vTypes.map(([t, n]) => `<span class="ov-chip" title="${esc(typeText(t, n))}">${svg(SITE_ICON[t] || "pin", 16)}<b>${n}</b> ${esc(n === 1 ? (SINGULAR[t] || t) : (TYPE_LABEL[t] || t))}</span>`).join("") : '<span class="muted">None within ' + NEAR + ' m</span>'}</div>
        <div class="ov-cap">Within ${NEAR} m of the flood${vIn ? `, ${vIn} inside it` : ", none inside it"}.</div>
      </article>
    </div>
    <div class="ov-note">${svg("alert", 22)}<div><b>What these numbers are not.</b> They count what was <i>inside</i> the observed flood. They are not damage figures: the challenge data has no damage assessment. They cover only the mapped zones on the day of the satellite pass, so they are minimums. A commune with little data is shown in grey, not as safe, and a commune with no flood shown may still have been flooded: satellite maps can miss floods in narrow valleys and towns, so check against local sources.</div></div>
    <h2 class="ov-h2">How to use this tool</h2>
    <div class="ov-steps">${steps.map(([href, ic, t, d], i) => `<a href="${href}" class="ov-step"><span class="ov-num">${i + 1}</span><span class="ov-ico">${svg(ic, 22)}</span><span class="ov-st"><b>${t}</b>${d}</span><span class="ov-go">${svg("arrow", 18)}</span></a>`).join("")}</div>
    ${top.length ? `<h2 class="ov-h2">Where to look first in ${esc(N)}</h2>
      <div class="ov-top">${top.map(c => `<a href="#region/${c.lau_id}" class="ov-card ov-comm"><b>${esc(nm(c))}</b><span class="ov-value ov-m">about ${approx(c.pop_exposed)}</span><span class="muted">residents &middot; ${pctText(c.per1000)}</span>${bar(c.pop_exposed / top[0].pop_exposed, `${nm(c)}: about ${approx(c.pop_exposed)} residents`)}${badgeC(c)}</a>`).join("")}</div>` : ""}
    <p class="muted" style="margin-top:22px">Use the country buttons above to switch to ${esc(others)}. Layers, tiers and depth maps: <a href="#advanced">Advanced</a>. Sources, definitions and limits: <a href="#about">About</a>.</p>`;
}

// ---------- Map ----------
let mMain = null, mFor = null; const mL = {};
function mapLayer(k) {  // buildings and sites layers are built the first time they are switched on
  const x = X();
  if (mL[k]) return mL[k];
  if (k === "flood") return (mL.flood = floodLayer(CTRY));
  if (k === "bld") return (mL.bld = L.layerGroup(x.C.buildings.features.map(f => L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { radius: 3, color: "#d9480f", weight: 1, fillOpacity: 0.8, interactive: false }))));
  return (mL.sites = L.layerGroup(x.bes.map(siteMarker)));
}
function syncLayers() {
  [["layerFlood", "flood"], ["layerBld", "bld"], ["layerSites", "sites"]].forEach(([id, k]) => {
    const on = document.getElementById(id).checked, l = mapLayer(k);
    if (on && !mMain.hasLayer(l)) l.addTo(mMain); else if (!on && mMain.hasLayer(l)) mMain.removeLayer(l);
  });
}
function initMap() {
  const x = X();
  if (!mMain) {
    mMain = newMap("mapMain", x.bounds);
    ["layerFlood", "layerBld", "layerSites"].forEach(id => document.getElementById(id).addEventListener("change", syncLayers));
  }
  if (mFor !== CTRY) {
    Object.values(mL).forEach(l => l && mMain.hasLayer(l) && mMain.removeLayer(l));
    Object.keys(mL).forEach(k => delete mL[k]);
    if (mL.communes) mMain.removeLayer(mL.communes);
    mL.communes = L.geoJSON(x.C.lau, { style: f => ({ fillColor: D.tiers[f.properties.tier].color, fillOpacity: 0.65, color: "#555", weight: 0.8 }),
      onEachFeature: (f, l) => { const c = x.byId[f.properties.lau_id]; l.bindPopup(() => communePopup(c)); l.bindTooltip(nm(c), { sticky: true });
        l.on("mouseover", () => l.setStyle({ weight: 2.5 })); l.on("mouseout", () => mL.communes.resetStyle(l)); } }).addTo(mMain);
    mFor = CTRY;
    document.getElementById("mapIntro").textContent = `${NAMES[CTRY]}: ${x.zones.length === 1 ? "the zone" : "the " + x.zones.length + " zones"} mapped by satellite (${x.zones.length <= 3 ? x.zones.join(", ") : x.zones.slice(0, 3).join(", ") + " and others"}). Click a commune on the map.`;
    const present = TIER_ORD.filter(k => x.comm.some(c => c.tier === k));
    document.getElementById("legendMain").innerHTML = present.map(k => `<div class="lg-row"><span class="sw" style="background:${D.tiers[k].color}"></span><span>${PLAIN[k]}</span> <span class="muted">(${x.comm.filter(c => c.tier === k).length})</span></div>`).join("") +
      `<div class="muted" style="font-size:12px;margin-top:8px">Priority compares communes across the three countries together${x.hasHigh ? "." : `, so no commune in ${esc(NAMES[CTRY])} reaches "highest priority".`}</div>`;
    const top10 = x.comm.filter(c => c.pop_exposed > 0).sort((a, b) => b.pop_exposed - a.pop_exposed).slice(0, 10);
    document.getElementById("topList").innerHTML = top10.map((c, i) =>
      `<li><span class="rk">${i + 1}</span><a href="#region/${c.lau_id}">${esc(nm(c))}</a><span class="tl-meta"><span class="muted">about ${approx(c.pop_exposed)} residents (${pctText(c.per1000)})</span> ${badgeC(c)}</span>${bar(c.pop_exposed / top10[0].pop_exposed, `${nm(c)}: about ${approx(c.pop_exposed)} residents`).replace('class="mbar"', 'class="mbar thin"')}</li>`).join("");
    mMain.fitBounds(x.bounds);
    syncLayers();
  }
  setTimeout(() => mMain.invalidateSize(), 0);
}

// ---------- Find a region ----------
let mReg = null, regGroup = null;
const qEl = document.getElementById("q"), resEl = document.getElementById("results");
const VERDICT = { higher: { label: "Higher flood exposure", color: "#c92a2a", fg: "#fff" }, some: { label: "Some flood exposure", color: "#f2c14e", fg: "#111" },
  lower: { label: "Lower modelled exposure", color: "#a5d8ff", fg: "#111" } };  // never "safe": the model leaves out small rivers and heavy rain
const vbadge = p => { const V = VERDICT[verdict(p)]; return `<span class="badge" style="background:${V.color};color:${V.fg}">${V.label}</span>`; };
function verdict(p) {
  const c = p.c, h = p.h;
  if ((h && h.p100 >= HI) || (c && ["1A", "1B", "2"].includes(c.tier))) return "higher";
  if (h && h.p500 < LO && !(c && c.pop_exposed > 0)) return "lower";
  return "some";
}
const rad = d => d * Math.PI / 180;
const distKm = (a, b) => { const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
function compass(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)), x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360 / 45) % 8];
}
// nearest communes of the SAME country (centre to centre) with lower modelled exposure and enough residents to be a plausible reception place
const nearest = (p, k) => p.h ? CT[p.cc].places.filter(q => q.id !== p.id && q.h && q.h.pop >= MINPOP && verdict(q) === "lower")
  .map(q => ({ q, d: distKm(p.h, q.h) })).sort((a, b) => a.d - b.d).slice(0, k) : [];

ALLPLACES.forEach(p => { p.fs = forms(p.name); p.fa = ALT[p.name] ? forms(ALT[p.name]) : []; });   // computed once: ~12,000 communes are searched on every keystroke
const matches = t => { const qs = forms(t.trim()).filter(Boolean); if (!qs.length) return [];
  const hit = p => qs.some(q => p.fs.some(f => f.includes(q)) || p.fa.some(f => f.includes(q)));
  const starts = p => qs.some(q => p.fs.some(f => f.startsWith(q)));
  return ALLPLACES.filter(hit)
    .sort((a, b) => (starts(a) ? 0 : 1) - (starts(b) ? 0 : 1) || (a.cc === CTRY ? 0 : 1) - (b.cc === CTRY ? 0 : 1) || a.name.localeCompare(b.name)).slice(0, 8); };
qEl.addEventListener("input", () => { const m = matches(qEl.value); resEl.hidden = !qEl.value.trim();
  resEl.innerHTML = m.length ? m.map(p => `<li><a href="#region/${p.id}"><span>${esc(nm(p))} <span class="muted">${p.cc.toUpperCase()}</span></span><span>${vbadge(p)}</span></a></li>`).join("")
    : `<li><a class="muted" style="pointer-events:none">No commune found in Belgium, Germany or the Netherlands. Try the local spelling.</a></li>`; });
// ---------- Browse A-Z: country chips, a letter bar, the communes of one letter (state kept across tab switches; the address is not changed) ----------
const AZ_LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];
const azKey = name => { const ch = norm(name)[0] || ""; return /[a-z]/.test(ch) ? ch.toUpperCase() : "#"; };   // diacritics removed (Ä -> A, É -> E); anything else, e.g. 's-Hertogenbosch, goes under #
let AZ = null, azC = null, azL = null;   // azC: null = follow the selected country; azL: null = first letter with communes
function azIndex() {
  if (AZ) return AZ;
  AZ = { all: {} }; CODES.forEach(cc => { AZ[cc] = {}; });
  [...ALLPLACES].sort((a, b) => norm(nm(a)).localeCompare(norm(nm(b)))).forEach(p => {
    const k = azKey(p.name); (AZ[p.cc][k] = AZ[p.cc][k] || []).push(p); (AZ.all[k] = AZ.all[k] || []).push(p);
  });
  return AZ;
}
const VCOL = v => VERDICT[v].color;
function renderAZ() {
  const box = document.getElementById("azBody"); if (!box || !document.getElementById("azBox").open) return;
  const ix = azIndex(), c = azC || CTRY, set = ix[c], letter = azL && (set[azL] || []).length ? azL : AZ_LETTERS.find(l => (set[l] || []).length);
  const list = set[letter] || [], all = c === "all";
  box.innerHTML = `<div class="az-row" role="group" aria-label="Country">${["all", ...CODES].map(k => `<button type="button" class="chip" data-azc="${k}" aria-pressed="${k === c}">${k === "all" ? "All" : NAMES[k]}</button>`).join("")}</div>
    <div class="az-letters" role="group" aria-label="First letter">${AZ_LETTERS.map(l => { const n = (set[l] || []).length;
      return `<button type="button" data-azl="${l === "#" ? "%23" : l}" aria-pressed="${l === letter}" ${n ? "" : "disabled"} title="${n ? fmt(n) + (n === 1 ? " commune" : " communes") : "No commune"}" aria-label="${l === "#" ? "Other characters" : l}: ${fmt(n)} ${n === 1 ? "commune" : "communes"}">${l}</button>`; }).join("")}</div>
    <div class="az-meta"><span><b>${fmt(list.length)}</b> ${list.length === 1 ? "commune" : "communes"} under ${letter === "#" ? "other characters" : letter}${all ? "" : " in " + esc(NAMES[c])}</span>
      <span>Flood exposure (model): ${["higher", "some", "lower"].map(v => `<span style="margin-right:8px"><i style="background:${VCOL(v)}"></i>${VERDICT[v].label.split(" ")[0]}</span>`).join("")}</span></div>
    <div class="az-grid">${list.map(p => { const v = verdict(p); return `<a href="#region/${p.id}" title="${esc(nm(p))}: ${VERDICT[v].label}"><i class="az-d" style="background:${VCOL(v)}"></i><span>${esc(nm(p))}</span>${all ? `<small>${p.cc.toUpperCase()}</small>` : ""}</a>`; }).join("")}</div>`;
}
document.getElementById("azBody").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  if (b.dataset.azc) { azC = b.dataset.azc; azL = null; } else if (b.dataset.azl) azL = decodeURIComponent(b.dataset.azl);
  const sel = b.dataset.azc ? `[data-azc="${b.dataset.azc}"]` : `[data-azl="${b.dataset.azl}"]`;
  renderAZ(); const f = document.querySelector("#azBody " + sel); if (f) f.focus();   // keep the keyboard focus on the pressed button
});
document.getElementById("azBox").addEventListener("toggle", renderAZ);
qEl.addEventListener("input", () => { document.getElementById("azBox").hidden = !!qEl.value.trim() && !resEl.hidden; });   // while typing, the search results replace the browse list
qEl.addEventListener("keydown", e => { if (e.key === "Enter") { const m = matches(qEl.value); if (m[0]) location.hash = "#region/" + m[0].id; } });

function stayHtml(p) {
  const h = p.h, c = p.c, v = verdict(p), cand = v === "lower" ? [] : nearest(p, 3), CC = p.cc.toUpperCase(), x = CT[p.cc];
  const acts = ["alert", "decide", "emergency"].map(id => D.actions[id] && D.actions[id][CC]).filter(Boolean);
  const seen = c ? (c.pop_exposed > 0 ? `about ${approx(c.pop_exposed)} residents (${pctText(c.per1000)}) lived in the area the satellite map shows as flooded.`
      : "no flood was detected in the satellite map here, but satellite maps can miss floods in narrow valleys and towns.")
    : `this commune was outside the zones mapped by satellite in ${NAMES[p.cc]}, so there is no 2021 map for it.`;
  // the satellite map and the model can disagree: say so instead of leaving two contradictory badges
  const gap = c && v === "higher" && h && h.p100 >= HI && c.per1000 < D.rules.rate_medium
    ? " The flood model shows much more exposure than the satellite map did, so the 2021 map may have missed floods here." : "";
  const advice = { higher: "A large share of the residents live where river floods can reach. If a flood warning is issued here, take it seriously and be ready to leave if the authorities say so.",
    some: "Part of this commune can be reached by river floods. Know your alert service and which streets are at risk.",
    lower: "Few residents live inside modelled river-flood zones. This does not mean it cannot flood: small rivers and heavy-rain flooding are not in the model." }[v];
  return `<h2>${esc(nm(p))} <span class="muted" style="font-weight:400">${esc(NAMES[p.cc])}</span> ${vbadge(p)}</h2>
    <h3 style="margin-top:4px">Stay or move? Planning information, not an order</h3>
    <div class="note"><b>This is not a warning and not an evacuation order.</b> It comes from a flood model and a 2021 satellite map, not from live data. In a real flood, follow ${ALERT[p.cc]} and the instructions of the authorities, who decide whether to stay or leave. This tool cannot tell you whether a road is open or a place can take you in.</div>
    ${h ? `<p><b>Modelled river flooding:</b> ${pc(h.p100)} of the residents live inside the zone of a 100-year flood (a flood with a 1% chance each year); ${pc(h.p10)} inside a 10-year zone and ${pc(h.p500)} inside a 500-year zone.</p>` : ""}
    <p><b>July 2021:</b> ${seen}${gap}</p>
    <p>${advice}</p>
    <h3>If a flood really happens (official advice)</h3>
    <ul>${acts.map(a => `<li>${esc(a.text)} <a href="${D.sources[a.source].url}" target="_blank" rel="noopener">[official source]</a></li>`).join("")}</ul>
    ${v !== "lower" ? `<h3>Nearest communes with lower modelled exposure</h3>
      <p class="muted" style="margin:0 0 4px">Planning candidates only, in the same country, among communes of at least ${fmt(MINPOP)} residents with no flood detected in 2021. Where to go, which route to take and whether there is room are decided by the authorities.</p>
      ${cand.length ? `<ol>${cand.map(({ q, d }) => `<li><a href="#region/${q.id}"><b>${esc(nm(q))}</b></a> &middot; ${fmt(d, 0)} km ${compass(p.h, q.h)} &middot; <span class="muted">${pc(q.h.p100)} of residents in a 100-year zone; ${q.c ? "no flood detected in the 2021 map" : "not covered by the 2021 map"}</span></li>`).join("")}</ol>`
        : `<p class="muted">No candidate found.</p>`}
      <p class="muted" style="font-size:13px;margin:0">A commune on this list is not guaranteed safe: small rivers and heavy-rain flooding are not in the model, and the 2021 map can miss floods.</p>` : ""}
    <p class="muted" style="font-size:13px;margin:10px 0 0">Model: EFAS flood hazard maps (EU) for 10-, 100- and 500-year river floods, which leave out small rivers (catchments under 500 km&sup2;); residents: GHS-POP 2020. Thresholds (higher: at least ${HI}% of residents in the 100-year zone, or a medium or higher 2021 priority; lower: under ${LO}% in the 500-year zone and no 2021 flood detected) are our draft choices.</p>
    <p class="noprint" style="margin:8px 0 0"><button class="chip" onclick="window.print()">Print this page</button></p>`;
}
const unmappedHtml = p => `<div class="rcard"><h2>What the July 2021 satellite map shows</h2><p>No satellite flood map covers <b>${esc(nm(p))}</b>: it lies outside the zones mapped in ${esc(NAMES[p.cc])} (${esc(zonesText(CT[p.cc]))}). This does not mean it was not flooded in 2021.</p></div>`;

function regionHtml(c) {
  const sites = sitesOf(c.lau_id), exposed = c.pop_exposed > 0, cov = c.coverage_pct, x = CT[c.country.toLowerCase()];
  const covCol = cov >= 80 ? "#2f9e44" : cov >= 50 ? "#f2c14e" : "#c92a2a";
  const flagged = x.bes.filter(s => s.lau_id === c.lau_id);
  const acts = actionsFor(c);
  const tot = k => Object.values(sites[k]).reduce((a, b) => a + b, 0);
  return `<div class="rcard">
    <h2>What the July 2021 satellite map shows ${badgeC(c)}</h2>
    <div class="headline">${headline(c)}</div>
    <p class="muted" style="margin:2px 0 10px">${PLAIN[c.tier]}. ${esc(reason(c))}</p>
    <h3>Impact: what was in the flood</h3>
    <div class="big">
      <div class="k"><b>${exposed ? approx(c.pop_exposed) : "none counted"}</b><span>residents in the flooded area${exposed ? ` (${pctText(c.per1000)} of the commune)` : ""}</span></div>
      <div class="k"><b>${fmt(c.buildings)}</b><span>buildings in or within ${BUF} m of the flood</span></div>
      <div class="k"><b>${fmt(c.flood_ha, 0)}</b><span>hectares flooded</span></div>
      <div class="k"><b>${c.hazard_share_100 == null ? "n/a" : fmt(c.hazard_share_100) + "%"}</b><span>of the flooded land was already inside a 100-year hazard-map zone</span></div>
    </div>
    <p class="muted" style="font-size:13px;margin:0">These figures count what was inside the observed flood. They are <b>not damage counts</b>: the challenge data has no damage assessment.</p>
    ${sites ? `<h3>Sites near the flood</h3>
      <p>OpenStreetMap (as of ${esc(OSM_DATE)}) lists <b>${tot("vulnerable")}</b> vulnerable sites (schools, care homes, hospitals) in the mapped part of this commune: <b>${sites.vulnerable[POS_IN]}</b> inside the flood and <b>${sites.vulnerable[POS_NEAR]}</b> within ${NEAR} m of it.</p>
      ${flagged.length ? `<ul>${flagged.map(s => `<li><span class="sw" style="background:${OSM_COLORS[s.categorie]}"></span><b>${esc(s.name || "(no name in OpenStreetMap)")}</b>, ${SINGULAR[s.type] || s.type} <span class="muted">(${CATP[s.categorie].toLowerCase()}; ${posText(s.position).toLowerCase()})</span></li>`).join("")}</ul>`
        : `<p class="muted">No listed site was inside the flood or within ${NEAR} m of it.</p>`}` : ""}
    <h3>What to tell residents</h3>
    <p class="muted" style="margin:0 0 4px"><b>Draft message focus (to validate with the responsible authority):</b> ${esc(c.tier === "3" && c.flood_ha <= 0 ? "General alert-registration awareness. No flood was detected here, but satellite maps can miss floods, so do not treat this commune as safe." : D.tiers[c.tier].message_focus)}</p>
    ${acts.length ? `<ul>${acts.map(a => `<li>${esc(a.text)} <a href="${D.sources[a.source].url}" target="_blank" rel="noopener">[official source]</a></li>`).join("")}</ul>` : `<p class="muted">No official guidance was read for this case.</p>`}
    <h3>How reliable is this?</h3>
    <div class="bar"><i style="width:${Math.min(100, cov)}%;background:${covCol}"></i></div>
    <p style="margin:0">${fmt(cov)}% of this commune was mapped by satellite. ${cov >= 80 ? "Most of the commune was inside a mapped area." : cov >= 50 ? "Part of the commune was not mapped: treat figures as minimums." : "Most of the commune was not mapped: these figures are incomplete."}</p>
    <p class="muted" style="font-size:13px;margin:4px 0 0">"Mapped" means the commune lay inside an area the analysts were asked to map. Flooding inside it can still be missed, especially in narrow valleys and towns, so a low figure is a minimum.</p>
    <p class="noprint" style="margin-top:10px"><button class="chip" onclick="window.print()">Print this region</button> <a class="chip" href="#priority">Back to the priority list</a></p>
  </div>`;
}
function showRegion(id) {
  const p = ALLP[id], view = document.getElementById("regionView"), box = document.getElementById("mapRegionBox");
  if (!p) {
    const top = CT[CTRY].comm.filter(x => x.pop_exposed > 0).sort((a, b) => b.pop_exposed - a.pop_exposed).slice(0, 6);
    view.innerHTML = `<p class="muted" style="margin-top:14px">Not sure where to start? Try one of these (${esc(NAMES[CTRY])}):</p><p>${top.map(x => `<a class="chip" href="#region/${x.lau_id}">${esc(nm(x))}</a>`).join("")}</p>`;
    box.hidden = true; document.getElementById("azBox").hidden = !!qEl.value.trim() && !resEl.hidden;
    const az = document.getElementById("azBox"); if (!az.open) az.open = true; else renderAZ(); return;   // opening fires "toggle", which renders
  }
  qEl.value = nm(p); resEl.hidden = true;
  const az = document.getElementById("azBox"); az.hidden = false; az.open = false;   // a commune is open: the browse list folds away above it
  const x = CT[p.cc];
  view.innerHTML = `<div class="rcard">${stayHtml(p)}</div>` + (p.c ? regionHtml(p.c) : unmappedHtml(p));
  box.hidden = false;  // the map needs a visible container before it is created
  if (!mReg) { mReg = newMap("mapRegion", x.bounds); regGroup = L.layerGroup().addTo(mReg); }
  regGroup.clearLayers();
  floodLayer(p.cc).addTo(regGroup);
  let bounds;
  if (p.c) {
    const outline = themed(L.geoJSON({ type: "Feature", geometry: p.c.geometry }, { style: { color: "#111", weight: 3, fill: false }, interactive: false }), t => ({ color: t === "dark" ? "#f1f3f5" : "#111" })).addTo(regGroup);
    const [bx0, by0, bx1, by1] = bboxOf(p.c.geometry);
    x.C.buildings.features.forEach(f => { const [lx, ly] = f.geometry.coordinates; if (lx >= bx0 && lx <= bx1 && ly >= by0 && ly <= by1 && inGeom([lx, ly], p.c.geometry)) L.circleMarker([ly, lx], { radius: 3, color: "#d9480f", weight: 1, fillOpacity: 0.8, interactive: false }).addTo(regGroup); });
    x.bes.filter(s => s.lau_id === id).forEach(s => siteMarker(s).addTo(regGroup));
    bounds = outline.getBounds();
  } else {
    L.circleMarker([p.h.lat, p.h.lon], { radius: 8, color: "#111", weight: 3, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(esc(nm(p)), { permanent: true, direction: "top" }).addTo(regGroup);
    bounds = L.latLngBounds([[p.h.lat, p.h.lon]]);
  }
  if (verdict(p) !== "lower") nearest(p, 3).forEach(({ q, d }) => {
    L.circleMarker([q.h.lat, q.h.lon], { radius: 7, color: "#1c7ed6", weight: 2, fillColor: "#a5d8ff", fillOpacity: 1 }).bindTooltip(`${esc(nm(q))} (${fmt(d, 0)} km)`, { permanent: true, direction: "top" }).addTo(regGroup);
    bounds.extend([q.h.lat, q.h.lon]);
  });
  mReg.invalidateSize(); mReg.fitBounds(bounds.pad(0.15), { maxZoom: 12 });
}

// ---------- Priority list ----------
function prRows() {
  const x = X(), only = document.getElementById("prOnly").checked, key = document.getElementById("prSort").value;
  const val = { pop: c => -c.pop_exposed, share: c => -c.per1000, bld: c => -c.buildings, vuln: c => -nearCount(c.lau_id, "vulnerable") }[key];
  return x.comm.filter(c => !only || c.pop_exposed > 0).sort((a, b) => key === "name" ? a.name.localeCompare(b.name) : (val(a) - val(b)) || a.name.localeCompare(b.name));
}
function renderPriority() {
  const x = X(), rows = prRows();
  document.getElementById("prLead").textContent = `${NAMES[CTRY]}: communes in the mapped zones, ranked by the number of residents who lived in the flooded area.`;
  document.getElementById("prNote").textContent = `Priority levels compare communes across Belgium, Germany and the Netherlands together, so they are relative, not official limits.${x.hasHigh ? "" : ` In ${NAMES[CTRY]} no commune reaches "highest priority" because the mapped zones are small compared with the largest floods.`} Click a row to open the commune.`;
  document.getElementById("prTable").innerHTML = `<div class="tbl-wrap"><table class="pr-table"><thead><tr><th>#</th><th>Commune</th><th>Priority</th><th class="n">Residents in the flood</th><th class="n">Share of residents</th>
    <th class="n">Buildings near the flood</th><th class="n">Vulnerable sites near the flood</th><th class="n">Area mapped</th></tr></thead><tbody>` +
    rows.map((c, i) => `<tr class="click" data-id="${c.lau_id}"><td>${i + 1}</td><td><a href="#region/${c.lau_id}">${esc(nm(c))}</a></td><td>${badgeC(c)}</td>
      <td class="n">${c.pop_exposed > 0 ? approx(c.pop_exposed) : "-"}</td><td class="n">${c.pop_exposed > 0 ? pctText(c.per1000) : "-"}</td><td class="n">${fmt(c.buildings)}</td>
      <td class="n">${sitesOf(c.lau_id) ? nearCount(c.lau_id, "vulnerable") : "-"}</td><td class="n">${fmt(c.coverage_pct)}%</td></tr>`).join("") + `</tbody></table></div>` +
    `<p class="muted" style="font-size:13px">${rows.length} communes shown.</p>`;
}
document.getElementById("prTable").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if (tr && e.target.tagName !== "A") location.hash = "#region/" + tr.dataset.id; });
document.getElementById("prSort").addEventListener("change", renderPriority);
document.getElementById("prOnly").addEventListener("change", renderPriority);
document.getElementById("prCsv").addEventListener("click", () => {
  const head = ["commune", "priority", "residents_in_flood_(rounded)", "share_of_residents_%", `buildings_within_${BUF}_m`, "hectares_flooded", "flood_in_100yr_hazard_zone_%", "area_mapped_%", "vulnerable_sites_near_flood"];
  const rows = prRows().map(c => [nm(c), tierLabel(c), Math.round(c.pop_exposed / 10) * 10, (c.per1000 / 10).toFixed(1), c.buildings, c.flood_ha.toFixed(1), c.hazard_share_100 == null ? "" : Math.round(c.hazard_share_100), Math.round(c.coverage_pct), sitesOf(c.lau_id) ? nearCount(c.lau_id, "vulnerable") : ""]);
  const csv = [head, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${NAMES[CTRY].toLowerCase()}_communes_flood_priority.csv`; a.click(); URL.revokeObjectURL(a.href);
});

// ---------- Sites near the flood ----------
let mSites = null, siteLayer = null, sitesFor = null, sitesFlood = null; const stOn = new Set(CAT_ORD);
function renderSites() {
  const x = X(), q = norm(document.getElementById("stQ").value.trim());
  const list = x.bes.filter(s => stOn.has(s.categorie) && (!q || norm((s.name || "") + " " + (s.commune || "") + " " + (SINGULAR[s.type] || s.type)).includes(q)))
    .sort((a, b) => CAT_ORD.indexOf(a.categorie) - CAT_ORD.indexOf(b.categorie) || (a.position === POS_IN ? 0 : 1) - (b.position === POS_IN ? 0 : 1) || (a.name || "~").localeCompare(b.name || "~"));
  document.getElementById("stCount").textContent = `${NAMES[CTRY]}: ${list.length} of ${x.bes.length} sites in or within ${NEAR} m of the flood (${x.bes.filter(s => s.position === POS_IN).length} inside it).`;
  document.getElementById("stTable").innerHTML = `<table class="site-tbl"><thead><tr><th>Site</th><th>Where</th></tr></thead><tbody>` + list.slice(0, 400).map((s, i) =>
    `<tr class="click" data-i="${i}"><td><span class="sw" style="background:${OSM_COLORS[s.categorie]}"></span><b>${esc(s.name || "(no name in OpenStreetMap)")}</b><br><span class="muted">${SINGULAR[s.type] || s.type}${s.commune ? ", " + esc(s.commune) : ""}</span></td><td><span class="pos${s.position === POS_IN ? " in" : ""}">${posText(s.position)}</span></td></tr>`).join("") + `</tbody></table>` +
    (list.length > 400 ? `<p class="muted" style="font-size:13px">The first 400 are listed; use the filters to narrow down.</p>` : "");
  renderSites.list = list;
  if (siteLayer) { siteLayer.clearLayers(); list.forEach(s => siteMarker(s).addTo(siteLayer)); }
}
function initSites() {
  const x = X();
  if (!mSites) {
    document.getElementById("stChips").addEventListener("click", e => { const b = e.target.closest("button[data-k]"); if (!b) return;
      stOn.has(b.dataset.k) ? stOn.delete(b.dataset.k) : stOn.add(b.dataset.k); b.setAttribute("aria-pressed", stOn.has(b.dataset.k)); renderSites(); });
    document.getElementById("stQ").addEventListener("input", renderSites);
    document.getElementById("stTable").addEventListener("click", e => { const tr = e.target.closest("tr[data-i]"); if (!tr) return;
      const s = renderSites.list[+tr.dataset.i]; mSites.setView([s.lat, s.lon], 16); L.popup().setLatLng([s.lat, s.lon]).setContent(siteTip(s)).openOn(mSites); });
    mSites = newMap("mapSites", x.bounds); siteLayer = L.layerGroup().addTo(mSites);
  }
  if (sitesFor !== CTRY) {
    if (sitesFlood) mSites.removeLayer(sitesFlood);
    sitesFor = CTRY; sitesFlood = floodLayer(CTRY).addTo(mSites);
    document.getElementById("stChips").innerHTML = CAT_ORD.map(k => `<button class="chip" type="button" data-k="${k}" aria-pressed="${stOn.has(k)}"><span class="sw" style="background:${OSM_COLORS[k]}"></span>${CATP[k]} <span class="n">${x.bes.filter(s => s.categorie === k).length}</span></button>`).join("");
    mSites.fitBounds(x.bounds);
    renderSites();
  }
  setTimeout(() => mSites.invalidateSize(), 0);
}

// ---------- About ----------
const AB_SECS = [["ab-shows", "map", "What it shows"], ["ab-src", "list", "Where the numbers come from"], ["ab-words", "info", "What the words mean"], ["ab-not", "alert", "What it does not show"]];
const abH = id => { const [, ic, t] = AB_SECS.find(x => x[0] === id); return `<span class="ov-badge">${svg(ic, 18)}</span>${t}`; };
// the table of contents scrolls inside the page: it does not change the address, so the router (#about) is untouched
document.getElementById("aboutBody").addEventListener("click", e => { const b = e.target.closest("[data-sec]"); if (!b) return;
  const el = document.getElementById(b.dataset.sec), still = matchMedia("(prefers-reduced-motion: reduce)").matches; if (el) el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" }); });
function renderAbout() {
  const R = D.rules, srcs = ["bealert", "bbk", "nlalert"].filter(k => D.sources[k]).map(k => `<a href="${D.sources[k].url}" target="_blank" rel="noopener">${esc(D.sources[k].name.split(":")[0])}</a>`).join(", ");
  document.getElementById("aboutBody").innerHTML = `
    <h1>About this tool</h1>
    <p class="lead">What it shows, where the numbers come from, and what it cannot tell you.</p>
    <nav class="ab-toc" aria-label="On this page">${AB_SECS.map(([id, ic, t]) => `<button type="button" class="chip" data-sec="${id}">${svg(ic, 16)}${t}</button>`).join("")}</nav>
    <section class="pcard ab-sec" id="ab-shows"><h2>${abH("ab-shows")}</h2>
    <p>For the zones of Belgium, Germany and the Netherlands that satellites mapped in July 2021, it shows how many residents, buildings and important sites were inside the flood, commune by commune. It also suggests where to concentrate preparedness and alert messages, and gives the modelled river-flood exposure of every commune.</p>
    </section>
    <section class="pcard ab-sec" id="ab-src"><h2>${abH("ab-src")}</h2>
    <div class="tbl-wrap"><table><thead><tr><th>What</th><th>Source</th><th>In plain words</th></tr></thead><tbody>
      <tr><td>The flood</td><td>Copernicus Emergency Management Service, satellite mapping (EMSR518 Belgium, EMSR517 Germany, EMSR520 Netherlands)</td><td>Flood outlines drawn by analysts from satellite images, published 15 to 18 July 2021. A snapshot, not the peak. Only requested areas were mapped.</td></tr>
      <tr><td>Residents</td><td>GHS-POP 2020 (EU Joint Research Centre)</td><td>A modelled estimate of people per 1 km square. Residents only, no commuters or visitors.</td></tr>
      <tr><td>Buildings</td><td>GHS-OBAT (EU Joint Research Centre), built on Overture Maps</td><td>One point per building known to the map. Not a complete register: counts are minimums.</td></tr>
      <tr><td>Flood zones (model)</td><td>EFAS flood hazard maps (EU)</td><td>A model of where a 10-, 100- or 500-year river flood is expected. Not the 2021 event itself.</td></tr>
      <tr><td>Sites (schools, hospitals, ...)</td><td>OpenStreetMap, state on ${esc(OSM_DATE)} (external source)</td><td>Volunteer-made map. Incomplete: a site may exist and not be listed.</td></tr>
      <tr><td>Communes, names, official population</td><td>Eurostat GISCO, 2023 (external source)</td><td>Official commune boundaries. Names are in the local language; we add some common alternative names in the search.</td></tr>
      <tr><td>Advice to residents</td><td>Official pages: ${srcs}, Rijksoverheid, Centre de Crise (external sources)</td><td>Only what these pages say, shown with its source. Not every country has every kind of advice.</td></tr>
    </tbody></table></div></section>
    <section class="pcard ab-sec" id="ab-words"><h2>${abH("ab-words")}</h2>
    <ul>
      <li><b>Residents in the flooded area:</b> residents of the 1 km squares that the flood covers, counted in proportion to the share of each square that was flooded. An estimate, rounded.</li>
      <li><b>Buildings in or near the flood:</b> buildings inside the flood outline or within ${BUF} m of it (a building at the edge may sit just outside the line).</li>
      <li><b>Hazard-map zone:</b> the share of the flooded land that the 100-year flood map already flagged. A low share means the flood reached places the maps did not show (or that the maps do not cover small rivers).</li>
      <li><b>Priority:</b> highest, medium or lower, from the share of residents in the flood and their number. Cut-offs: high from ${fmt(R.rate_high, 0)} per 1,000 residents or ${fmt(R.abs_high, 0)} residents; medium from ${fmt(R.rate_medium, 0)} per 1,000 or ${fmt(R.abs_medium, 0)} residents. They compare communes across the three countries, so they are relative, not official limits.</li>
      <li><b>No data (grey):</b> less than ${R.coverage}% of the commune was mapped. Unknown, not safe.</li>
      <li><b>Flood exposure (higher, some, lower) in "Find a region":</b> from a flood <i>model</i> (EFAS), not from the 2021 map. It is the share of residents living inside the zone of a 10-, 100- or 500-year river flood. <i>Higher</i>: at least ${D.cfg.hazard_higher_pct}% of residents in the 100-year zone, or a medium or higher 2021 priority. <i>Lower</i>: under ${D.cfg.hazard_lower_pct}% in the 500-year zone and no flood detected in 2021. Everything else is <i>some</i>. We never say "safe": the model leaves out small rivers and heavy-rain flooding. These cut-offs are our draft choices.</li>
      <li><b>My route:</b> drop a pin and the page finds the nearest shelters, reception places or hospitals by travel time, on foot or by car, using the roads of OpenStreetMap (state of ${esc(OSM_DATE)}). <b>The team's principle:</b> the flood data is the safe side. A road that is not in our water data is assumed passable even in a flood this large, and roads inside it are avoided: they get a heavy cost (the 2021 observed flood x${D.cfg.route_pen_observed}, the modelled 100-year zone x${D.cfg.route_pen_rp100}, the 500-year zone x${D.cfg.route_pen_rp500}), so the page crosses them only when there is no other way, and then says how much water it still crosses. A shelter inside the water data is only suggested when nothing else is reachable. The calculation runs in your browser: your pin is not sent anywhere. Routes are planned only around the mapped areas (the dashed outlines on the map).</li>
      <li><b>Nearest communes with lower exposure:</b> the three closest communes of the same country (centre to centre) with lower exposure and at least ${fmt(D.cfg.candidate_min_pop)} residents. A planning aid only: the authorities decide where people go.</li>
    </ul></section>
    <section class="pcard ab-sec" id="ab-not"><h2>${abH("ab-not")}</h2>
    <ul><li>Whether a road is really passable: the routes assume that roads outside our water data stay open in a flood. Real floods differ from 2021 and from the model, roads can be closed or blocked, and the small rivers and heavy-rain floods that the model leaves out can cut roads we show as free. Shelters are places listed in OpenStreetMap: we do not know if they are open, or how many people they can take, and street names are not given. Never drive through flooded roads.</li>
      <li>Live conditions: this is not a warning system. It cannot say whether a place is safe <i>now</i>, whether roads are open, or whether a reception place has room. In a real flood, follow ${ALERT.be}, ${ALERT.de} or ${ALERT.nl}, and the authorities.</li>
      <li>Damage, injuries or deaths: the challenge data has no damage assessment.</li>
      <li>How deep the 2021 water was, or its peak: the satellite maps show the extent on one day.</li>
      <li>Anything outside the mapped zones, which is blank or grey, not safe.</li>
      <li>Every flooded place: the satellite maps can miss flooding in narrow valleys and built-up areas. Some communes known to have been badly hit in July 2021 show no flood here, so always check local sources.</li>
      <li>Priority levels and the "draft message focus" are our proposals, to validate with the responsible authority.</li></ul></section>
    <p class="muted">The full technical report is the file <code>docs/flood_data_report.html</code> in the project. Map background: Esri World Light Gray or World Dark Gray, following the light or dark theme (all tabs). Sites: &copy; OpenStreetMap contributors.</p>`;
}

// ---------- Official flood zones (Germany only): 2021 flood vs the zones the authorities map ----------
// Everything comes from D.uesg (made offline by prepare_uesg.py + prepare_gap.py): the app calls no service.
let mOff = null;
function offCommunePopup(c) {
  const row = (label, a, b) => `<tr><td>${label}</td><td style="text-align:right">${a}</td><td style="text-align:right">${b}</td></tr>`;
  return `<div style="max-width:300px"><b>${esc(c.commune)}</b> <span class="muted">${c.land}</span>
    <table style="width:100%;font-size:13px;margin:6px 0;border-collapse:collapse"><tr><th></th><th style="text-align:right">Official zone</th><th style="text-align:right">Flooded 2021, outside it</th></tr>
    ${row("Area (ha)", fmt(c.legal_ha), fmt(c.gap_ha))}${row("Buildings", fmt(c.bat_legal), fmt(c.bat_gap))}${row("Residents (estimate)", "about " + approx(c.pop_legal), "about " + approx(c.pop_gap))}</table>
    <span class="muted" style="font-size:12px">Flooded in 2021 (mapped): ${fmt(c.flood_ha)} ha, ${fmt(c.bat_flood)} buildings, about ${approx(c.pop_flood)} residents. Estimates by our team, see the notes.</span></div>`;
}
function offPanelHtml(U) {
  const pct = (a, b) => b > 0 ? Math.round(100 * a / b) + "%" : "-";
  const st = (v, l) => `<div class="off-stat"><b>${v}</b><span>${l}</span></div>`;
  const tiles = U.land.map(r => `<div class="pcard off-card${r.land === "Total" ? " total" : ""}"><h4>${svg(r.land === "Total" ? "layers" : "map", 18)}${esc(r.land)}</h4><div class="off-stats">
      ${st(fmt(r.flood_ha), "2021 flood (ha)")}${st(`${fmt(r.gap_ha)} <small class="muted" style="font-size:13px;font-weight:500">(${pct(r.gap_ha, r.flood_ha)})</small>`, "of which outside the official zone")}
      <div class="off-gap">${bar(r.flood_ha > 0 ? r.gap_ha / r.flood_ha : 0, `${r.land}: ${pct(r.gap_ha, r.flood_ha)} of the 2021 flood (mapped) lies outside the official zone`)}</div>
      ${st(fmt(r.bat_flood), "buildings in the flood")}${st(fmt(r.bat_gap), "of which outside")}${st(approx(r.pop_flood), "residents in the flood*")}${st(approx(r.pop_gap), "of which outside*")}</div></div>`).join("");
  const sw = (bg, extra = "") => `<span class="sw" style="background:${bg};${extra}"></span>`;
  return `<h2>2021 flood vs the official flood zones</h2>
    <p class="muted" style="margin:0 0 8px">Germany only, inside the areas mapped by satellite. Red hatching is where the water went in 2021 although the authorities did not map a legal flood zone there.</p>
    <div class="pcard"><div class="off-legend">
    <div>${sw("#3b7dd8aa")} <span>Official flood zone (legally set or provisionally secured)</span></div>
    <div>${sw("#bcd4f5", "border-style:dashed")} <span>Flood-risk area outside the legal zones (not a legal zone)</span></div>
    <div>${sw("transparent", "border:2px solid var(--off-flood)")} <span>Flooded in July 2021 (satellite maps)</span></div>
    <div>${sw("repeating-linear-gradient(45deg,#d6336c 0 2px,#fff 2px 5px)")} <span><b>Flooded in 2021, outside the official zone</b></span></div></div>
    <details style="margin:8px 0 0;border-top:1px solid var(--line);padding-top:4px"><summary><b>Layers</b></summary>
      ${[["legal", "Official zone", 1], ["risk", "Flood-risk area (not legal)", 1], ["flood", "2021 flood outline", 1], ["gap", "Flooded in 2021, outside the official zone", 1], ["com", "Communes (click for numbers)", 1]].map(([k, l, on]) =>
        `<label class="check"><input type="checkbox" data-offl="${k}" ${on ? "checked" : ""}> ${l}</label>`).join("")}</details></div>
    <h3>Key numbers per Land</h3>
    <div class="off-grid">${tiles}</div>
    <p class="muted" style="font-size:12px;margin:4px 0">* estimates, rounded. NRW = North Rhine-Westphalia, RLP = Rhineland-Palatinate.</p>
    <h3>Read this before using the numbers</h3>
    <div class="off-notes">
      <div class="callout warn">${svg("alert", 18)}<div><b>Only mapped areas.</b> Where Copernicus did not map the flood, we do not know what flooded: absence of red does not mean dry. Satellite maps also miss floods in narrow valleys and towns.</div></div>
      <div class="callout">${svg("info", 18)}<div><b>Not the same status everywhere.</b> The Länder do not label zones the same way. "Official zone" here means "legally set" or "provisionally secured" (RLP and NRW). The flood-risk areas outside the legal zones are shown apart and are not counted as official.</div></div>
      <div class="callout">${svg("info", 18)}<div><b>Residents are an estimate.</b> Population comes from GHS-POP 2020, cells of about 1 km, spread evenly inside each cell. Do not read it as a count of people, and small areas are rough.</div></div>
      <div class="callout">${svg("info", 18)}<div><b>Buildings</b> are GHS-OBAT building points (2020) that lie inside each shape.</div></div>
      <div class="callout">${svg("info", 18)}<div><b>A gap is not an error by the authorities.</b> Zones are drawn from a 100-year flood model and 2021 was larger in places. The gap shows where the official map and 2021 differ, to be checked locally.</div></div>
    </div>
    <h3>Sources</h3>
    <p style="font-size:12.5px;margin:0">Official zones: Rhineland-Palatinate (geoportal.rlp.de, CC BY 4.0, Wasserwirtschaftsverwaltung RLP) and North Rhine-Westphalia (opengeodata.nrw.de, LANUK, Datenlizenz Deutschland Zero 2.0), downloaded ${esc(U.meta.date)}. 2021 flood: Copernicus EMS rapid mapping. Buildings: GHS-OBAT. Residents: GHS-POP 2020. Commune boundaries: Eurostat GISCO LAU 2023. Gap and exposure numbers: calculations by the team, not an official figure.</p>`;
}
function initOfficial() {
  const U = D.uesg;
  if (!U) { document.getElementById("offPanel").innerHTML = "<p>No official flood zone data in this build.</p>"; return; }
  if (!mOff) {
    mOff = newMap("mapOff", [[49.55, 6.0], [51.5, 7.8]]);
    const L_ = {}, svg = L.svg({ padding: 0.5 }).addTo(mOff);
    // hatch pattern for the gap (canvas paths cannot be hatched, so this layer uses an SVG renderer)
    svg._container.insertAdjacentHTML("afterbegin", `<defs><pattern id="gapHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff" fill-opacity="0.35"/><rect width="2.5" height="6" fill="#d6336c"/></pattern></defs>`);
    L_.legal = L.geoJSON(U.shapes.legal, { style: { color: "#2b62b8", weight: 0.6, fillColor: "#3b7dd8", fillOpacity: 0.4 }, interactive: false });
    L_.risk = L.geoJSON(U.shapes.risk, { style: { color: "#7aa6e6", weight: 0.8, dashArray: "4 3", fillColor: "#bcd4f5", fillOpacity: 0.3 }, interactive: false });
    L_.flood = themed(L.geoJSON(U.shapes.flood, { style: { color: "#7b2cbf", weight: 1.6, fill: false }, interactive: false }), t => ({ color: t === "dark" ? "#c99bf2" : "#7b2cbf" }));
    L_.gap = L.geoJSON(U.shapes.gap, { renderer: svg, className: "gap-hatch", style: { color: "#d6336c", weight: 0.8, fillOpacity: 1 }, interactive: false });
    L_.com = L.layerGroup(U.communes.map(c => themed(L.geoJSON(c.geom, { style: { color: "#666", weight: 0.5, fillOpacity: 0, opacity: 0.6 } }), t => ({ color: t === "dark" ? "#9aa5b4" : "#666" }))
      .bindPopup(() => offCommunePopup(c)).bindTooltip(c.commune, { sticky: true })));
    document.getElementById("offPanel").innerHTML = offPanelHtml(U);
    document.getElementById("offPanel").addEventListener("change", e => {
      const k = e.target.dataset.offl; if (!k) return;
      if (e.target.checked) L_[k].addTo(mOff); else mOff.removeLayer(L_[k]);
      if (L_.gap && mOff.hasLayer(L_.gap)) L_.gap.bringToFront();
    });
    ["legal", "risk", "flood", "gap", "com"].forEach(k => L_[k].addTo(mOff));
  }
  setTimeout(() => mOff.invalidateSize(), 0);
}

// ---------- Islands: areas the 2021 flood cuts off from hospitals (made offline by prepare_islands.py) ----------
let mIsl = null, islGroup = null, islFor = null;
const ISL_COL = "#c92a2a";   // every island has the same colour: an island is a top priority, the list order ranks them
const islBadge = () => `<span class="badge" style="background:${ISL_COL};color:#fff">Highest priority</span>`;
function islandCard(r) {
  const vul = Object.entries(r.vulnerable).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ");
  const names = a => a.length ? " (" + a.map(esc).join(", ") + ")" : "";
  const where = r.communes.map(c => `${esc(c.n)} ${c.pct}%`).join(", ");
  const row = (ic, cls, html) => `<div class="isl-row ${cls}">${svg(ic, 16)}<span>${html}</span></div>`;
  return `<div class="rcard isl-card lift" data-isl="${r.cc}-${r.rank}">
    <span class="isl-rank">#${r.rank}</span>
    <div style="min-width:0">
    <div class="isl-head"><b>${esc(r.name)}</b> ${islBadge()}</div>
    <div class="isl-big">about ${approx(r.residents)} <small>residents cut off</small></div>${r.communes.length > 1 ? `<div class="muted" style="font-size:13px">${where}</div>` : ""}
    <div class="isl-rows">
      ${row("cross", r.hospital ? "" : "none", r.hospital ? `Nearest hospital: ${esc(r.hospital.name || "(no name)")}, ${fmt(r.hospital.km, 1)} km away in a straight line, not reachable by road while the flooded roads are closed.` : "No hospital found in our data.")}
      ${row("flame", r.fire_n ? "has" : "none", `Fire station inside: ${r.fire_n ? "yes" + names(r.fire) : "none found"}.`)}
      ${row("bed", r.shelters_n ? "has" : "none", `Shelter inside: ${r.shelters_n ? r.shelters_n + names(r.shelters) : "none found"}.`)}
      ${vul ? row("shield", "none", `Vulnerable sites inside: ${esc(vul)}.`) : ""}
      ${row("road", "", `${r.closed_links} road link${r.closed_links === 1 ? "" : "s"} closed by the flood; ${fmt(r.road_km, 1)} km of road stay open inside.`)}
    </div>
    ${r.gaps.length ? `<div class="isl-why"><b>Ranked here because:</b> ${r.gaps.map(g => `<span class="ov-chip">${esc(g)}</span>`).join("")}</div>` : ""}
    <div class="isl-prop"><b>Proposed before the water arrives</b> (to validate with the responsible authority): pre-position medics, generators and boats${r.shelters_n ? "" : ", and open a shelter inside the island"}.</div>
    </div>
  </div>`;
}
function initIslands() {
  const I = D.islands, list = I ? (I.islands[CTRY] || []) : [], N = NAMES[CTRY];
  if (!mIsl) mIsl = newMap("mapIsl", X().bounds);
  if (islGroup) mIsl.removeLayer(islGroup);
  islGroup = L.layerGroup().addTo(mIsl);
  floodLayer(CTRY).addTo(islGroup);
  const layers = {};
  list.forEach(r => {
    const poly = L.geoJSON(r.hull, { style: { color: ISL_COL, weight: 2, fillColor: ISL_COL, fillOpacity: 0.45 } }).addTo(islGroup);
    poly.bindPopup(() => islandCard(r), { maxWidth: 340 });
    r.cuts.forEach(c => L.circleMarker([c[1], c[0]], { radius: 5, color: "#fff", weight: 1.5, fillColor: "#111", fillOpacity: 1 }).bindTooltip("Road closed by the flood: the island is cut here").addTo(islGroup));
    layers[r.cc + "-" + r.rank] = { poly, r };
  });
  if (islFor !== CTRY) { islFor = CTRY; mIsl.fitBounds(X().bounds); }
  const tot = list.reduce((a, r) => a + r.residents, 0);
  document.getElementById("islPanel").innerHTML = `
    <h2>Islands: areas the 2021 flood cuts off</h2>
    <p class="muted" style="margin:0 0 8px">We closed every car road that touches the observed 2021 flood, bridges included, and looked for groups of roads that no longer reach any hospital. Each group with enough residents is an island. Every island is a top priority; the list ranks them.</p>
    <div class="note" style="margin:12px 0"><b>${esc(N)}:</b> ${list.length ? `${list.length} island${list.length === 1 ? "" : "s"} found, about ${approx(tot)} residents cut off.` : "no island found with the observed 2021 flood."} <b>This is not a complete list:</b> it only sees roads the satellite maps showed under water, and satellite maps miss floods (for example in Verviers, Pepinster or Trooz).</div>
    <div class="lg-row" style="margin:0 0 12px"><span class="sw" style="background:${ISL_COL}"></span><span style="margin-right:12px">Island</span><span class="sw" style="background:#111;box-shadow:0 0 0 1px #fff"></span><span>road cut</span></div>
    <div id="islList">${list.map(islandCard).join("")}</div>
    <h3>How to read this</h3>
    <ul style="padding-left:18px;font-size:13px;margin:0">
      <li><b>Ranking</b> (our draft rule, to validate): an island with more gaps comes first (no fire station inside, no shelter inside, a vulnerable site inside, at least ${fmt(I ? I.meta.urgent_pop : 1000)} residents), then the one with more residents cut off. Islands under ${fmt(I ? I.meta.min_pop : 100)} residents are not listed.</li>
      <li><b>Residents are an estimate</b> from GHS-POP 2020 (cells of about 1 km, spread evenly), under the island's outline. Not a count.</li>
      <li><b>Closed roads</b> = every car road piece that touches the observed flood. We do not know if a flooded road was really impassable, or if other roads were closed (landslides, damage). Travel times and one-way rules are not modelled.</li>
      <li>An island must have been connected to a hospital before the flood in our road data, so areas cut only by the edge of our map are not counted. Roads outside the map are unknown.</li>
      <li>Fire stations, shelters and vulnerable sites come from OpenStreetMap (snapshot ${esc(I ? I.meta.osm_snapshot : "")}, incomplete). Distances to hospitals are straight lines.</li>
    </ul>
    <p class="muted" style="font-size:12px">Roads: &copy; OpenStreetMap contributors (Geofabrik extract, 1 January 2021). Flood: Copernicus EMS. Residents: GHS-POP 2020. Calculations by the team, not an official figure.</p>`;
  document.getElementById("islList").onclick = e => { const c = e.target.closest("[data-isl]"); if (!c) return; const o = layers[c.dataset.isl]; if (o) { mIsl.fitBounds(o.poly.getBounds().pad(2), { maxZoom: 14 }); o.poly.openPopup(); } };
  setTimeout(() => mIsl.invalidateSize(), 0);
}

// ---------- Router (the address, e.g. #region/BE_62063, says which tab is open) ----------
const TABS = ["overview", "map", "region", "route", "priority", "sites", "islands", "official", "live", "advanced", "about"];
let advReady = false;
function route() {
  const [tab, id] = (location.hash.slice(1) || "overview").split("/");
  const t = TABS.includes(tab) ? tab : "overview";
  if (t === "region" && id && ALLP[id]) { CTRY = ALLP[id].cc; syncCtry(); }   // opening a commune also switches the country
  TABS.forEach(x => { document.getElementById("tab-" + x).hidden = x !== t; });
  document.querySelectorAll("#nav a[data-tab]").forEach(a => a.setAttribute("aria-current", a.dataset.tab === t ? "page" : "false"));
  ctryBox.hidden = !["overview", "map", "priority", "sites", "islands"].includes(t);
  if (t === "overview") renderOverview();
  if (t === "map") initMap();
  if (t === "region") showRegion(id);
  if (t === "priority") renderPriority();
  if (t === "sites") initSites();
  if (t === "islands") initIslands();
  if (t === "official") initOfficial();
  if (t === "live") initLive();
  if (t === "route") initRoute();
  if (t === "advanced") { map.invalidateSize(); if (!advReady) { advReady = true; show("all"); } }  // the explorer was created while hidden
  if (t !== "map" && t !== "sites" && t !== "route" && t !== "official" && t !== "islands" && t !== "live") window.scrollTo(0, 0);
}
renderAbout();
alertsInit();   // app_alerts.js: alert strip under the banner on every tab, background watch if it was left on
addEventListener("hashchange", route);
route();
