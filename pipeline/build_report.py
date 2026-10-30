"""Build docs/flood_data_report.html: a self-contained, printable report (no external files or scripts).

Run: py -3.13 pipeline/build_report.py     (after fetch_country / fetch_rasters / prepare_water / prepare_pop)
"""
import csv
import datetime
import html
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import build_app as B  # src/build_app.py: same loaders and tier rule as the app

ROOT, DATA = B.ROOT, B.DATA
NAMES = {"be": "Belgium", "de": "Germany", "nl": "Netherlands"}
ACT = {"be": "EMSR518 (activated 14 July 2021)", "de": "EMSR517 (activated 13 July 2021)", "nl": "EMSR520 (activated 15 July 2021)"}
EPOCH = {1: "before 1980", 2: "1980–1990", 3: "1990–2000", 4: "2000–2010", 5: "2010–2020", 0: "outside built-up domain"}
USE = {1: "residential", 2: "non-residential", 0: "outside built-up domain"}
e = html.escape
n0 = lambda x: f"{x:,.0f}"
n1 = lambda x: f"{x:,.1f}"


def rd(name):
    p = DATA / name
    return list(csv.DictReader(open(p, encoding="utf-8"))) if p.exists() else None


def table(head, rows, num_from=1, left=()):
    """Columns from num_from on are right-aligned numbers, except the indices listed in left."""
    cls = lambda i: "n" if i >= num_from and i not in left else ""
    th = "".join(f'<th class="{cls(i)}">{e(h)}</th>' for i, h in enumerate(head))
    body = "".join("<tr>" + "".join(f'<td class="{cls(i)}">{c}</td>' for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f"<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>"


def svg_map(water, bats, width=720, max_h=520):
    """Overview map: observed flood outline (blue) and buildings in water (orange dots)."""
    g = water["flood"]["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    lons = [p[0] for poly in polys for p in poly[0]]
    lats = [p[1] for poly in polys for p in poly[0]]
    w, s, east, n = min(lons), min(lats), max(lons), max(lats)
    k = math.cos(math.radians((s + n) / 2))
    sc = min(width / ((east - w) * k), max_h / (n - s))
    H = (n - s) * sc
    px = lambda lon, lat: ((lon - w) * k * sc, (n - lat) * sc)
    d = []
    for poly in polys:
        for ring in poly:
            pts = [px(*p) for p in ring]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            if max(xs) - min(xs) < 1.5 and max(ys) - min(ys) < 1.5:
                continue  # sub-pixel polygon
            keep = [pts[0]]
            for p in pts[1:]:
                if abs(p[0] - keep[-1][0]) + abs(p[1] - keep[-1][1]) >= 0.8:
                    keep.append(p)
            if len(keep) >= 3:
                d.append("M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in keep) + "Z")
    dots = "".join(f"M{x:.1f} {y:.1f}h0" for x, y in (px(*f["geometry"]["coordinates"]) for f in bats["features"]))
    return (f'<svg viewBox="-8 -8 {width + 16:.0f} {H + 16:.0f}" role="img" aria-label="Overview map">'
            f'<rect x="-8" y="-8" width="{width + 16:.0f}" height="{H + 16:.0f}" fill="#f1f4f8"/>'
            f'<path d="{"".join(d)}" fill="#3b9cff" fill-opacity=".55" stroke="#0b5cad" stroke-width=".6" fill-rule="evenodd"/>'
            f'<path d="{dots}" stroke="#d9480f" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>')


def country_data(cc):
    c = B.load_country(cc)
    return c


def build():
    data = {cc: country_data(cc) for cc in B.COUNTRIES}
    th = B.assign_tiers(data)
    BUF, CFG_RP = B.CFG["building_buffer_m"], B.CFG["efas_return_period"]
    efas = {cc: rd(f"flood/efas_check_{cc}.csv") for cc in B.COUNTRIES}
    ok = [cc for cc in B.COUNTRIES if data[cc]]
    today = datetime.date.today().isoformat()

    # ---- headline table
    head_rows = []
    for cc in ok:
        c = data[cc]
        water_ha = sum(float(r["eau_ha"]) for r in c["flood_aoi"]) if "flood_aoi" in c else None
        b = c.get("buildings_summary")
        p = c.get("pop")
        head_rows.append([NAMES[cc], str(len(c["flood_aoi"])) if "flood_aoi" in c else "–", n0(water_ha) if water_ha is not None else "–",
                          n0(b["count"]) if b else "–", n0(round(p["pop_exposed"], -1)) if p else "–"])
    sections = []

    # ---- 1. water
    w = ["<h2>1. Water: where the flood was, and what a model expects</h2>",
         "<p><b>Observed flood extent</b> (Copernicus EMS Rapid Mapping): flood outlines drawn by analysts from satellite images. "
         "It is the only observation of the real 2021 flood in the challenge data. Each map is a snapshot at the satellite pass, not the peak, "
         "and only areas requested by authorities (AOIs) were mapped: outside them, &ldquo;not flooded&rdquo; means &ldquo;not mapped&rdquo;. "
         "Here the outline merges every &ldquo;observed event&rdquo; file: the delineation (DEL) products and also grading (GRA) products and later monitoring maps, so it is the "
         "<b>maximum extent seen across several dates</b>, not one snapshot. Only the flood-extent polygons are used: no depth and no damage grade.</p>",
         "<p><b>Modelled water depth</b> (EFAS river flood hazard): model-based depth for a 10-, 100- and 500-year flood across Europe. "
         "It is a model of generic floods, <i>not</i> the 2021 event. Small rivers (catchment under 500&nbsp;km²) are not modelled, and the model was run on 1990&ndash;2016 data.</p>"]
    for cc in ok:
        c = data[cc]
        w.append(f"<h3>{NAMES[cc]} <span class='sub'>{ACT[cc]}</span></h3>")
        if "water" in c:
            w.append(f'<figure>{svg_map(c["water"], c.get("buildings") or {"features": []})}<figcaption>Observed flood extent (blue) and buildings inside it (orange dots). Source: Copernicus EMS, GHS-OBAT.</figcaption></figure>')
        if "flood_aoi" in c:
            w.append(table(["Area of interest (AOI)", "AOI area (ha)", "Observed water (ha)", "Share flooded (%)"],
                           [[e(r["aoi"]), n0(float(r["aoi_ha"])), n0(float(r["eau_ha"])), n1(float(r["part_inondee_%"]))] for r in c["flood_aoi"]]))
        if "size_classes" in c:
            tot = sum(int(r["n_polygones"]) for r in c["size_classes"])
            w.append(f"<p class='note'>{n0(tot)} flood polygons (all products, before merging). Size classes:</p>")
            w.append(table(["Polygon size", "Polygons", "Share of flooded area (%)"],
                           [[e(r["classe"]), n0(int(r["n_polygones"])), n1(float(r["%_surface"]))] for r in c["size_classes"]]))
        if efas[cc]:
            w.append("<p class='note'>Share of the observed flood that lies inside the EFAS modelled hazard zone:</p>")
            w.append(table(["Modelled flood", "Observed flood cells", "Inside hazard zone (%)"],
                           [[f"{r['return_period']}-year", n0(int(r["flood_cells"])), n1(float(r["share_in_hazard_zone_%"]))] for r in efas[cc]]))
    w.append("<div class='limits'><b>Limits.</b> Observed water covers the mapped AOIs on the day of the satellite pass only, so totals are lower bounds, "
             "and AOI counts differ by country (Germany 16, Belgium 2, Netherlands 1). In EFAS, empty cells mean &ldquo;not modelled&rdquo; "
             "<i>or</i> &ldquo;no flood&rdquo; and the data does not let us tell them apart, so the share inside the hazard zone is a minimum. "
             "The 500-year map is the model ceiling and the 2021 flood exceeded it in places. Mean EFAS depths of 3&ndash;6&nbsp;m inside flooded cells may include river channels and are not quoted here.</div>")
    sections.append("".join(w))

    # ---- 2. population
    p = ["<h2>2. Population: who lived there</h2>",
         "<p><b>GHS-POP R2023A, epoch 2020</b> (JRC): estimated residents per grid cell, 30 arc-seconds (about 1&nbsp;km), modelled from census data and built-up area. "
         "2020 is used for the 2021 event (the 2025 raster is a projection). <b>Method used here:</b> each cell is weighted by the share of its area covered by the observed flood "
         "(10&times;10 sub-cells per cell). &ldquo;Touched cells&rdquo; counts whole cells the flood overlaps and is an upper bound.</p>"]
    prow = [[NAMES[cc], n0(round(data[cc]["pop"]["pop_exposed"], -1)), n0(round(data[cc]["pop"]["pop_in_touched_cells"], -2)), n0(data[cc]["pop"]["cells_touched"])]
            for cc in ok if "pop" in data[cc]]
    p.append(table(["Country", "Residents exposed (weighted)", "Residents in touched cells", "Cells touched"], prow))
    for cc in ok:
        if "pop" in data[cc]:
            p.append(f"<h3>{NAMES[cc]}: by area of interest</h3>")
            p.append(table(["AOI", "Residents exposed (weighted)", "Residents in whole AOI"],
                           [[e(r["aoi"]), n0(round(r["pop_exposed"], -1)), n0(round(r["pop_in_aoi"], -2))] for r in data[cc]["pop"]["aoi"]]))
    p.append("<div class='limits'><b>Limits.</b> Residents only (no commuters or visitors; no age or status). Only the mapped AOIs and one satellite snapshot, so figures are lower bounds. "
             "AOIs can overlap (notably in Germany), so AOI rows do not add up to the country figure, which counts each cell once. "
             "Population is modelled from built-up data, so it is <b>not independent</b> of the building counts: do not present the two as separate confirmations. "
             "Rounded to the nearest 10 (exposed) or 100 (whole cells).</div>")
    sections.append("".join(p))

    # ---- 3. buildings
    b = ["<h2>3. Buildings: what was there</h2>",
         "<p><b>GHS-OBAT R2024A</b> (JRC): one record per building, as a point (footprint centroid), reference year 2020, derived from Overture Maps building footprints. "
         f"<b>Method used here:</b> all building points inside the observed flood extent or within {BUF}&nbsp;m of it (the margin counts buildings at the flood edge, whose point may fall just outside the polygon); "
         "read tile by tile from the full country files. Buildings are <b>counted, not measured</b>: footprint area is deliberately not used. "
         "Use code: 1 = residential, 2 = non-residential, 0 = outside the built-up domain (per the OBAT documentation); all are counted. "
         "Construction epoch (1&ndash;5): before 1980, 1980&ndash;90, 1990&ndash;2000, 2000&ndash;10, 2010&ndash;20.</p>"]
    brow = []
    for cc in ok:
        feats = data[cc].get("buildings", {}).get("features", [])
        if not feats:
            continue
        pr = [f["properties"] for f in feats]
        use = Counter(x["use"] for x in pr)
        brow.append([NAMES[cc], n0(len(pr)), n0(sum(1 for x in pr if x.get("in_flood"))), n0(use[1]), n0(use[2]), n0(use[0])])
    b.append(table(["Country", f"Within {BUF} m of observed flood", "Strictly inside", "Residential", "Non-residential", "Outside built-up domain"], brow))
    for cc in ok:
        feats = data[cc].get("buildings", {}).get("features", [])
        if not feats:
            continue
        pr = [f["properties"] for f in feats]
        reg = defaultdict(lambda: [0, 0])
        for x in pr:
            reg[x["adm1"]][0] += 1
            reg[x["adm1"]][1] += int(bool(x.get("in_flood")))
        ep = Counter(x["epoch"] for x in pr)
        b.append(f"<h3>{NAMES[cc]}</h3>")
        b.append(table(["Region (GADM level 1)", f"Within {BUF} m", "Strictly inside"],
                       [[e(k), n0(v[0]), n0(v[1])] for k, v in sorted(reg.items(), key=lambda kv: -kv[1][0])]))
        b.append("<p class='note'>Construction epoch of these buildings:</p>")
        b.append(table(["Epoch", "Buildings", "Share (%)"], [[EPOCH[k], n0(ep[k]), n1(100 * ep[k] / len(pr))] for k in (1, 2, 3, 4, 5, 0) if ep[k]]))
    b.append("<div class='limits'><b>Limits.</b> OBAT coverage is limited to the Overture buildings dataset: it is <b>not</b> a complete register, and the counts above are floors. "
             "In tests, OBAT returned noticeably fewer buildings than expected inside the Belgian flood areas. Points, not footprints: a building at the flood edge can fall in or out "
             "depending on its point position. Not every record is a home. A building counts as &ldquo;hit&rdquo; only because it was overlaid on the flood extent; "
             "this is <b>not</b> a damage assessment. Height and epoch are modelled from 100&nbsp;m rasters, not measured per building.</div>")
    sections.append("".join(b))

    # ---- 4. communes and response tiers
    sw = lambda c: f'<span style="display:inline-block;width:11px;height:11px;background:{c};border:1px solid #0003;vertical-align:-1px"></span>'
    allc = [(cc, f["properties"]) for cc in ok if "lau" in data[cc] for f in data[cc]["lau"]["features"]]
    t = ["<h2>4. Communes and response tiers</h2>",
         "<p><b>Aim:</b> help a regional civil protection authority decide where to concentrate <b>preparedness and alert messages</b>. "
         "The unit is the commune (Eurostat GISCO LAU 2023, an external source, which also gives place names and official population). "
         "<b>Exposure</b> is the number of GHS-POP residents in the observed flood, weighted by the flooded share of each cell; the rate divides it by the commune's GHS-POP total.</p>",
         f"<p><b>Tier rule (our draft; thresholds are relative to this partial sample, not official limits).</b> <i>High</i>: at least {th['rate_high']:.0f} residents exposed per 1,000 inhabitants "
         f"<b>or</b> at least {th['abs_high']:.0f} residents exposed (top {100 - th['p_high']}% of the {th['n_flooded']} flooded communes). <i>Medium</i>: at least {th['rate_medium']:.0f} per 1,000 or "
         f"{th['abs_medium']:.0f} residents (top {100 - th['p_medium']}%). High is <b>1B</b> when at least {th['hazard']}% of the observed flood lies inside the EFAS {CFG_RP}-year zone, otherwise <b>1A</b>. "
         f"<b>No data</b> when a low-exposure commune has under {th['coverage']}% of its area inside a mapped area: unknown, not safe.</p>"]
    trows = []
    for k in ("1A", "1B", "2", "3", "ND"):
        tt = B.ACTIONS["tiers"][k]
        trows.append([f"{sw(tt['color'])} {k}: {e(tt['label'])}"] + [n0(sum(1 for c, p in allc if c == cc and p["tier"] == k)) for cc in ok] +
                     [e(tt["message_focus"])])
    t.append(table(["Tier"] + [NAMES[cc] for cc in ok] + ["Message focus (draft, to validate)"], trows, num_from=1, left=(len(ok) + 1,)))
    top = sorted((x for x in allc if x[1]["pop_exposed"] > 0), key=lambda x: -x[1]["pop_exposed"])[:20]
    t.append("<h3>20 communes with the most residents exposed</h3>")
    t.append(table(["Commune", "Country", "Residents exposed", "Per 1,000", "Hazard-zone share (%)", "Area mapped (%)", "Tier"],
                   [[e(p["name"]), c.upper(), n0(round(p["pop_exposed"], -1)), n1(p["per1000"]),
                     "–" if p["hazard_share_100"] is None else n0(p["hazard_share_100"]), n0(p["coverage_pct"]), p["tier"]] for c, p in top], num_from=2))
    srcs = "; ".join(f'<a href="{s["url"]}">{e(s["name"])}</a>' for s in B.ACTIONS["sources"].values())
    t.append("<div class='limits'><b>Resident actions</b> come only from official pages read for this work: " + srcs + ". "
             "For Belgium no official source was read for risk checking, emergency planning or property protection, so none is proposed. "
             "<b>Limits.</b> Tiers are relative and use a partial sample (only mapped areas; Belgium has two, the Netherlands one); a low value can mean &ldquo;not mapped&rdquo;. "
             "GHS-POP cells are about 1&nbsp;km, so figures for small communes are approximate. "
             "&ldquo;Inside the EFAS zone&rdquo; cannot separate &ldquo;not modelled&rdquo; from &ldquo;no flood modelled&rdquo;. Communes merged between 2021 and 2023 may differ from the 2021 situation.</div>")
    sections.append("".join(t))

    # ---- sources and honest status
    src = ("<h2>5. Sources and what is not covered</h2>"
           "<table><thead><tr><th>Layer</th><th>Source</th><th>Type</th></tr></thead><tbody>"
           "<tr><td>Observed flood</td><td>Copernicus EMS Rapid Mapping, EMSR517 / EMSR518 / EMSR520</td><td>Observation (satellite, analyst-drawn)</td></tr>"
           "<tr><td>Modelled depth</td><td>EFAS flood hazard maps, return periods 10 / 100 / 500 years (JRC)</td><td>Model</td></tr>"
           "<tr><td>Buildings</td><td>GHS-OBAT R2024A (JRC), built on Overture Maps</td><td>Modelled attributes on mapped footprints</td></tr>"
           "<tr><td>Population</td><td>GHS-POP R2023A, E2020 (JRC)</td><td>Model (census + built-up area)</td></tr>"
           "<tr><td>Communes, names, official population</td><td>Eurostat GISCO LAU 2023</td><td>External source (not challenge data)</td></tr>"
           "<tr><td>Resident actions</td><td>Official civil-protection pages (see section 4)</td><td>External source (not challenge data)</td></tr></tbody></table>"
           "<p>The four core layers are European public data (JRC, Copernicus), free to use with credit, read from the challenge bucket "
           "<code>gs://datasets_challenge/working_data</code>. The observed flood merges all EMS &ldquo;observed event&rdquo; files, including grading (GRA) products and later monitoring maps, as one outline. "
           "<b>Not covered:</b> the non-flood EMS layers (roads, built-up areas, hydrography), damage assessment, and any dataset beyond those listed. "
           "Interpretation choices (what counts as flood, buffer, thresholds) are recorded in <code>config.json</code>. "
           "Check each figure against its source before using it in a policy brief.</p>")
    sections.append(src)

    css = """
:root{--text:#1c2430;--muted:#667085;--line:#d9dee6;--accent:#0b5cad;--bg:#fff;--soft:#f6f7f9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,Segoe UI,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 8px;padding-top:8px;border-top:2px solid var(--accent)}
h3{font-size:16px;margin:22px 0 6px}.sub{font-weight:400;color:var(--muted);font-size:13px}
.lead{color:var(--muted);margin:0 0 16px}table{width:100%;border-collapse:collapse;margin:8px 0 12px;font-size:14px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}th{background:var(--soft)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.note{margin:10px 0 2px;color:var(--muted);font-size:13px}
.limits{background:var(--soft);border-left:4px solid #d9480f;padding:10px 12px;margin:14px 0;font-size:14px}
figure{margin:10px 0}figure svg{width:100%;height:auto;border:1px solid var(--line)}figcaption{font-size:12px;color:var(--muted)}
code{font-size:13px}@media print{main{max-width:none;padding:0}h2{break-after:avoid}table,figure,.limits{break-inside:avoid}}
"""
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>July 2021 floods: data layers report</title><style>{css}</style></head>
<body><main>
<h1>July 2021 floods: data layers report</h1>
<p class="lead">Water, population and buildings for Belgium, Germany and the Netherlands &middot; European AI Challenge 2026 &middot; generated {today}</p>
<h2 style="margin-top:20px">Summary</h2>
{table(["Country", "AOIs mapped", "Observed water (ha)", f"Buildings within {BUF} m of observed water", "Residents exposed (weighted)"], head_rows)}
<p class="note">All figures cover the mapped areas of interest on the day of the satellite pass: they are lower bounds, not national totals.</p>
{"".join(sections)}
</main></body></html>"""
    out = ROOT / "docs" / "flood_data_report.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out} ({len(page) / 1e6:.2f} MB)")


if __name__ == "__main__":
    build()
