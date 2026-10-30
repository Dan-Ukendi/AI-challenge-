/* ---- Policy assistant: tool-grounded chat over the dataset already loaded as D ----
   DEMO ONLY: API key hardcoded for a one-day hackathon demo. Revoke/rotate after presenting. */
const ANTHROPIC_API_KEY = "PASTE_YOUR_ANTHROPIC_API_KEY_HERE";
const ASK_MODEL = "claude-sonnet-5";
const TOWN_SUMMARIES = D.town_summaries || [];
const RECOVERY = D.recovery_tracker || { entries: [] };
const KNOWN_LIMITATIONS = [
  "EMS Rapid Mapping is the only direct observation of the 2021 flood, but each map is a single satellite snapshot (not the peak) and coverage is partial: only requested areas of interest (AOIs) were mapped. Outside an AOI, \"not flooded\" means \"not mapped\", not \"safe\".",
  "EFAS hazard maps (10/100/500-year) are model-based, not observed, exclude rivers with a catchment under 500 km², and were modelled on 1990-2016 data; the 2021 flood exceeded the 500-year ceiling in places.",
  "GHS-OBAT buildings are points, not footprints, so area cannot be measured and edge buildings can fall in or out of the flood polygon depending on point placement. Belgium is undercounted relative to the other two countries.",
  "GHS-POP counts residents only (no commuters or visitors) and is modelled from built-up area, so it is not independent of the building counts. Partially flooded grid cells are weighted by flooded area share.",
  "There is no cost, damage, or investment dataset in this challenge. Any cost/recovery claim must come from a cited desk-research entry (status verified/claimed/unverified), never from estimation."
];

function askFindTowns(q) {
  q = (q || "").toLowerCase();
  return TOWN_SUMMARIES.filter(t => t.place_name.toLowerCase().includes(q));
}

const ASK_TOOLS = [
  {
    name: "get_commune_stats",
    description: "Get flood-exposure stats for communes (LAU areas), optionally filtered by country and/or response tier, sorted by residents exposed (descending). Use for 'where is exposure highest' / prioritisation questions.",
    input_schema: { type: "object", properties: {
      country: { type: "string", enum: ["be", "de", "nl", "all"], description: "Country filter, default all" },
      tier: { type: "string", enum: ["1A", "1B", "2", "3", "ND"], description: "Optional response-tier filter" },
      limit: { type: "integer", description: "Max rows to return, default 20" }
    } }
  },
  {
    name: "get_evacuation_plan",
    description: "Look up a named town/place and return its exposed population plus the nearest candidate shelter buildings on the SAME side of the water and ACROSS the water, each with distance in km. Use for 'where do we move people' / 'is there a nearby shelter' questions. If the place is not found, returns a list of available place names instead of guessing.",
    input_schema: { type: "object", properties: {
      place_name: { type: "string", description: "Town or place name, partial match ok" }
    }, required: ["place_name"] }
  },
  {
    name: "list_towns",
    description: "List all town/place names available in the evacuation dataset, with country and population. Use when a place lookup fails or to see coverage.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_resident_guidance",
    description: "Get the official, source-cited resident guidance (alert registration, risk-checking, emergency plan, property protection, decide-to-shelter-or-evacuate) for a country and response tier.",
    input_schema: { type: "object", properties: {
      country: { type: "string", enum: ["be", "de", "nl"] },
      tier: { type: "string", enum: ["1A", "1B", "2", "3", "ND"] }
    }, required: ["country", "tier"] }
  },
  {
    name: "get_cost_and_recovery_data",
    description: "Get any cost, damage, investment or post-2021 recovery-action data available. IMPORTANT: this challenge provides no official cost/damage/investment dataset, so this nearly always returns an empty or near-empty entries list plus a note saying so. Call this before answering ANY cost/budget/investment/'is it getting more expensive' question, and if entries are empty, say plainly that no cost data exists rather than estimating a trend.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_dataset_overview",
    description: "Get the raw file inventory, interpretation thresholds (config.json choices), and the list of known data limitations/caveats for this dataset. Use when asked about data quality, provenance, or 'how confident are you'.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "render_chart",
    description: "Render a bar or line chart in the chat for the user. Only pass numbers that came from an earlier tool result in this same conversation — never invent or round values to look cleaner.",
    input_schema: { type: "object", properties: {
      chart_type: { type: "string", enum: ["bar", "line"] },
      title: { type: "string" },
      y_label: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      values: { type: "array", items: { type: "number" } }
    }, required: ["chart_type", "title", "labels", "values"] }
  },
  {
    name: "get_priority_areas",
    description: "Rank communes by a composite flood-risk priority score (exposure rate, absolute residents exposed, hazard-zone overlap, and data confidence). Use for 'top priority areas' / 'where should we intervene first' questions and before charting priority areas.",
    input_schema: { type: "object", properties: {
      country: { type: "string", enum: ["be", "de", "nl", "all"], description: "Country filter, default all" },
      limit: { type: "integer", description: "Max rows to return, default 10" }
    } }
  },
  {
    name: "render_dashboard",
    description: "Render a compact dashboard in the chat: a row of KPI tiles plus one or more charts. Only use numbers already returned by another tool call earlier in this conversation - never invent values.",
    input_schema: { type: "object", properties: {
      title: { type: "string" },
      kpis: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] } },
      charts: { type: "array", items: { type: "object", properties: {
        title: { type: "string" }, y_label: { type: "string" },
        labels: { type: "array", items: { type: "string" } }, values: { type: "array", items: { type: "number" } }
      }, required: ["title", "labels", "values"] } }
    }, required: ["title", "kpis"] }
  },
  {
    name: "generate_pdf_report",
    description: "Generate and download a PDF report: title, executive summary, key findings, an optional data table, an optional bar chart, cost estimates (each with source link/date/assumptions if externally sourced), policy recommendations, and a sources list. Only use data already returned by earlier tool calls or web_search results in this conversation - never fabricate numbers or sources. Triggers an immediate browser download.",
    input_schema: { type: "object", properties: {
      title: { type: "string" },
      summary: { type: "string", description: "2-4 sentence executive summary" },
      key_findings: { type: "array", items: { type: "string" } },
      table: { type: "object", properties: {
        headers: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } }
      } },
      chart: { type: "object", properties: {
        title: { type: "string" }, labels: { type: "array", items: { type: "string" } }, values: { type: "array", items: { type: "number" } }
      } },
      cost_estimates: { type: "array", items: { type: "object", properties: {
        item: { type: "string" }, amount: { type: "string" },
        source_name: { type: "string" }, source_url: { type: "string" }, source_date: { type: "string" }, assumptions: { type: "string" }
      }, required: ["item", "amount"] } },
      recommendations: { type: "array", items: { type: "string" } },
      sources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, url: { type: "string" } }, required: ["url"] } }
    }, required: ["title", "summary", "key_findings"] }
  },
  { type: "web_search_20250305", name: "web_search", max_uses: 3 }
];

async function askRunTool(name, input) {
  if (name === "get_commune_stats") {
    const cc = (input.country || "all").toLowerCase();
    const list = cc === "all" ? Object.keys(D.countries) : [cc];
    let rows = list.flatMap(c => (D.countries[c]?.lau?.features || []).map(f => f.properties))
      .filter(p => p.pop_exposed > 0);
    if (input.tier) rows = rows.filter(p => p.tier === input.tier);
    rows = rows.sort((a, b) => b.pop_exposed - a.pop_exposed).slice(0, input.limit || 20);
    return rows.map(p => ({ name: p.name, country: p.country, pop_exposed: Math.round(p.pop_exposed),
      pop_total: p.pop_total ? Math.round(p.pop_total) : null, per1000: Math.round(p.per1000 * 10) / 10,
      tier: p.tier, tier_label: D.tiers[p.tier]?.label, hazard_share_100_pct: p.hazard_share_100, coverage_pct: p.coverage_pct }));
  }
  if (name === "get_priority_areas") {
    const cc = (input.country || "all").toLowerCase();
    const list = cc === "all" ? Object.keys(D.countries) : [cc];
    let rows = list.flatMap(c => (D.countries[c]?.lau?.features || []).map(f => f.properties))
      .filter(p => p.pop_exposed > 0);
    const maxExp = Math.max(...rows.map(r => r.pop_exposed), 1);
    const maxRate = Math.max(...rows.map(r => r.per1000), 1);
    rows = rows.map(p => {
      const hazard = (p.hazard_share_100 || 0) / 100;
      const confidence = (p.coverage_pct || 0) / 100;
      const score = 0.35 * (p.pop_exposed / maxExp) + 0.35 * (p.per1000 / maxRate) + 0.2 * hazard + 0.1 * confidence;
      return { ...p, priority_score: Math.round(score * 1000) / 1000 };
    }).sort((a, b) => b.priority_score - a.priority_score).slice(0, input.limit || 10);
    return {
      scoring_formula: "priority_score = 0.35*(residents_exposed / max) + 0.35*(per1000_rate / max) + 0.2*(hazard_zone_overlap_pct/100) + 0.1*(mapped_coverage_pct/100). Weights are our draft interpretation choice, not an official index - shown here so the ranking is auditable, not a black box.",
      results: rows.map(p => ({ name: p.name, country: p.country, priority_score: p.priority_score,
        pop_exposed: Math.round(p.pop_exposed), per1000: Math.round(p.per1000 * 10) / 10,
        tier: p.tier, hazard_share_100_pct: p.hazard_share_100, coverage_pct: p.coverage_pct }))
    };
  }
  if (name === "get_evacuation_plan") {
    const matches = askFindTowns(input.place_name);
    if (!matches.length) return { found: false, available_places: TOWN_SUMMARIES.map(t => `${t.place_name} (${t.country})`) };
    return matches.map(t => ({
      place_name: t.place_name, country: t.country, river: t.river, population: t.population,
      pct_of_town_across_water_from_flood: t.pct_across_water,
      shelters_same_side_nearest_first: (t.shelters_same_side || []).sort((a, b) => a.distance_km - b.distance_km),
      shelters_across_water_nearest_first: (t.shelters_across_water || []).sort((a, b) => a.distance_km - b.distance_km),
      guidance: "Prefer same-side shelters; crossing water during an active flood is unsafe even if a shelter there is nominally closer."
    }));
  }
  if (name === "list_towns") return TOWN_SUMMARIES.map(t => ({ place_name: t.place_name, country: t.country, population: t.population }));
  if (name === "get_resident_guidance") {
    const tier = D.tiers[input.tier];
    if (!tier) return { found: false };
    const acts = tier.actions.map(id => {
      const a = D.actions[id]?.[input.country.toUpperCase()];
      return a ? { action: id, text: a.text, source: D.sources[a.source].name, url: D.sources[a.source].url } : null;
    }).filter(Boolean);
    return { tier: input.tier, tier_label: tier.label, message_focus: tier.message_focus,
      actions: acts.length ? acts : "No official source was read for this country for these actions." };
  }
  if (name === "get_cost_and_recovery_data") {
    const real = (RECOVERY.entries || []).filter(e => e.description && !/placeholder/i.test(e.title || ""));
    return { official_cost_dataset_exists: false,
      note: "No cost, damage, or investment dataset was provided in this challenge. Do not estimate a cost trend or investment ranking from this alone.",
      desk_research_entries: real };
  }
  if (name === "get_dataset_overview") return { inventory: D.inventory, interpretation_choices: D.cfg, tier_thresholds: D.rules, known_limitations: KNOWN_LIMITATIONS };
  if (name === "render_chart") return { rendered: true };
  if (name === "render_dashboard") return { rendered: true };
  if (name === "generate_pdf_report") {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const pageW = 210, marginX = 18, maxY = 275;
      let y = 20;
      const checkBreak = (need = 10) => { if (y + need > maxY) { doc.addPage(); y = 20; } };
      const wrapText = (text, size = 10, maxW = pageW - 2 * marginX) => { doc.setFontSize(size); return doc.splitTextToSize(text, maxW); };

      doc.setFontSize(18); doc.setFont(undefined, "bold");
      doc.text(input.title || "FloodScope AI Report", marginX, y); y += 8;
      doc.setFontSize(9); doc.setFont(undefined, "normal"); doc.setTextColor(120);
      doc.text("Generated " + new Date().toISOString().slice(0, 10) + " - FloodScope AI, July 2021 flood data (EMS Rapid Mapping, GHS-POP, GHS-OBAT, EFAS)", marginX, y); y += 8;
      doc.setTextColor(20);

      if (input.summary) {
        doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.text("Executive summary", marginX, y); y += 6;
        doc.setFont(undefined, "normal"); doc.setFontSize(10);
        const lines = wrapText(input.summary); checkBreak(lines.length * 5);
        doc.text(lines, marginX, y); y += lines.length * 5 + 4;
      }

      if (input.key_findings && input.key_findings.length) {
        checkBreak(8); doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.text("Key findings", marginX, y); y += 6;
        doc.setFont(undefined, "normal"); doc.setFontSize(10);
        input.key_findings.forEach(f => {
          const lines = wrapText("- " + f, 10, pageW - 2 * marginX - 4); checkBreak(lines.length * 5);
          doc.text(lines, marginX + 2, y); y += lines.length * 5 + 2;
        });
        y += 3;
      }

      if (input.table && input.table.headers && input.table.headers.length) {
        checkBreak(12); doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.text("Data", marginX, y); y += 6;
        const cols = input.table.headers.length;
        const colW = (pageW - 2 * marginX) / cols;
        doc.setFontSize(9); doc.setFont(undefined, "bold");
        input.table.headers.forEach((h, i) => doc.text(String(h).slice(0, 20), marginX + i * colW, y));
        y += 5; doc.setDrawColor(200); doc.line(marginX, y - 1, pageW - marginX, y - 1);
        doc.setFont(undefined, "normal");
        (input.table.rows || []).forEach(row => {
          checkBreak(6);
          row.forEach((c, i) => doc.text(String(c).slice(0, 22), marginX + i * colW, y));
          y += 5;
        });
        y += 4;
      }

      if (input.chart && input.chart.labels && input.chart.labels.length) {
        checkBreak(70);
        try {
          const svg = buildChartSVGForExport(input.chart);
          const png = await svgToPngDataUrl(svg, 500, 240);
          const imgH = (pageW - 2 * marginX) * (240 / 500);
          doc.addImage(png, "PNG", marginX, y, pageW - 2 * marginX, imgH);
          y += imgH + 6;
        } catch (chartErr) { /* skip chart silently if it fails, do not break the whole report */ }
      }

      if (input.cost_estimates && input.cost_estimates.length) {
        checkBreak(10); doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.text("Cost estimates", marginX, y); y += 6;
        doc.setFont(undefined, "normal"); doc.setFontSize(10);
        input.cost_estimates.forEach(c => {
          checkBreak(14);
          doc.setFont(undefined, "bold"); doc.text(c.item + ": " + c.amount, marginX, y); y += 5;
          doc.setFont(undefined, "normal"); doc.setFontSize(9);
          if (c.source_name || c.source_url) {
            const label = "Source: " + (c.source_name || c.source_url) + (c.source_date ? " (" + c.source_date + ")" : "");
            if (c.source_url) { doc.setTextColor(31, 111, 235); doc.textWithLink(label, marginX + 2, y, { url: c.source_url }); doc.setTextColor(20); }
            else doc.text(label, marginX + 2, y);
            y += 4.5;
          }
          if (c.assumptions) { const al = wrapText("Assumptions: " + c.assumptions, 9, pageW - 2 * marginX - 4); checkBreak(al.length * 4.5); doc.text(al, marginX + 2, y); y += al.length * 4.5; }
          doc.setFontSize(10); y += 2;
        });
        y += 2;
      }

      if (input.recommendations && input.recommendations.length) {
        checkBreak(8); doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.text("Policy recommendations", marginX, y); y += 6;
        doc.setFont(undefined, "normal"); doc.setFontSize(10);
        input.recommendations.forEach(r => {
          const lines = wrapText("- " + r, 10, pageW - 2 * marginX - 4); checkBreak(lines.length * 5);
          doc.text(lines, marginX + 2, y); y += lines.length * 5 + 2;
        });
        y += 2;
      }

      if (input.sources && input.sources.length) {
        checkBreak(8); doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.text("Sources", marginX, y); y += 6;
        doc.setFont(undefined, "normal"); doc.setFontSize(9); doc.setTextColor(31, 111, 235);
        input.sources.forEach(s => {
          checkBreak(5);
          doc.textWithLink(s.name || s.url, marginX + 2, y, { url: s.url });
          y += 4.5;
        });
        doc.setTextColor(20);
      }

      checkBreak(10); doc.setFontSize(8); doc.setTextColor(140);
      doc.text("Generated by FloodScope AI - grounded in challenge dataset and cited web sources. Not an official government report. Verify before operational use.", marginX, y);

      const filename = (input.title || "floodscope-report").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) + ".pdf";
      doc.save(filename);
      return { generated: true, filename: filename };
    } catch (e) {
      return { generated: false, error: "PDF generation failed: " + e.message };
    }
  }
  return { error: "unknown tool " + name };
}

function askEscape(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function askMarkdownLite(s) {
  const links = [];
  const stash = html => { links.push(html); return "" + (links.length - 1) + ""; };
  let t = askEscape(s);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => stash(`<a href="${url}" target="_blank" rel="noopener">${text}</a>`));
  t = t.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, m => stash(`<a href="${m}" target="_blank" rel="noopener">${m}</a>`));
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^- (.+)$/gm, "&bull;&nbsp;$1").replace(/\n/g, "<br>");
  t = t.replace(/(\d+)/g, (m, i) => links[+i]);
  return t;
}
function askAppend(role, text) {
  const d = document.createElement("div");
  d.className = "askMsg " + role;
  d.innerHTML = role === "bot" ? askMarkdownLite(text) : askEscape(text).replace(/\n/g, "<br>");
  document.getElementById("askMsgs").appendChild(d);
  d.scrollIntoView({ block: "end" });
  return d;
}
function buildChartHTML({ title, y_label, labels, values }) {
  const w = 300, h = 140, pad = 24, max = Math.max(1, ...values);
  const bw = (w - pad) / values.length;
  const bars = values.map((v, i) => {
    const bh = (h - pad) * (v / max), x = pad + i * bw, y = h - bh;
    return `<rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${bh}" fill="var(--accent)"></rect>
      <text x="${x + bw / 2}" y="${h + 10}" font-size="8" text-anchor="middle" fill="currentColor">${askEscape(String(labels[i]).slice(0, 8))}</text>
      <text x="${x + bw / 2}" y="${y - 2}" font-size="8" text-anchor="middle" fill="currentColor">${fmt(v)}</text>`;
  }).join("");
  return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${askEscape(title)}</div>` +
    `<svg viewBox="0 0 ${w} ${h + 16}" width="100%" style="color:var(--text)">${bars}</svg>` +
    (y_label ? `<div style="font-size:10px;color:var(--muted)">${askEscape(y_label)}</div>` : "");
}
function askRenderChart(spec) {
  const div = document.createElement("div");
  div.className = "askChart";
  div.innerHTML = buildChartHTML(spec);
  document.getElementById("askMsgs").appendChild(div);
  div.scrollIntoView({ block: "end" });
}
function askRenderDashboard({ title, kpis, charts }) {
  const div = document.createElement("div");
  div.className = "askChart";
  div.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:8px">${askEscape(title || "Dashboard")}</div>` +
    (kpis && kpis.length ? `<div style="display:grid;grid-template-columns:repeat(${Math.min(kpis.length, 3)},1fr);gap:8px;margin-bottom:10px">` +
      kpis.map(k => `<div style="text-align:center"><b style="display:block;font-size:17px;color:var(--accent)">${askEscape(String(k.value))}</b><span style="color:var(--muted);font-size:10px">${askEscape(k.label)}</span></div>`).join("") +
      `</div>` : "") +
    (charts || []).map(c => `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">${buildChartHTML(c)}</div>`).join("");
  document.getElementById("askMsgs").appendChild(div);
  div.scrollIntoView({ block: "end" });
}

function buildChartSVGForExport({ title, labels, values }) {
  const w = 500, h = 220, pad = 40, max = Math.max(1, ...values);
  const bw = (w - pad) / values.length;
  const bars = values.map((v, i) => {
    const bh = (h - pad) * (v / max), x = pad + i * bw, y = h - bh;
    return `<rect x="${x + 4}" y="${y}" width="${bw - 8}" height="${bh}" fill="#1f6feb"></rect>
      <text x="${x + bw / 2}" y="${h + 14}" font-size="11" text-anchor="middle" fill="#1c2430">${askEscape(String(labels[i]).slice(0, 12))}</text>
      <text x="${x + bw / 2}" y="${y - 4}" font-size="11" text-anchor="middle" fill="#1c2430">${fmt(v)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h + 20}" width="${w}" height="${h + 20}">` +
    `<rect width="${w}" height="${h + 20}" fill="#ffffff"></rect>` +
    `<text x="${w / 2}" y="16" font-size="13" font-weight="bold" text-anchor="middle" fill="#1c2430">${askEscape(title || "")}</text>` +
    bars + `</svg>`;
}
function svgToPngDataUrl(svgString, width, height) {
  return new Promise((resolve, reject) => {
    const svg64 = btoa(unescape(encodeURIComponent(svgString)));
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = width * scale; canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("chart image failed to render"));
    img.src = "data:image/svg+xml;base64," + svg64;
  });
}

const ASK_SYSTEM = `You are FloodScope AI, an evidence-based flood-risk decision-support assistant for crisis-coordinators and policymakers covering the Belgium-Germany-Netherlands border region, built around the July 2021 flood data.

Core rule: never guess or estimate a number, a cost, or a source. Answer only using what your tools return. If a tool returns no match or an empty/near-empty result, say so plainly instead of filling the gap with a plausible-sounding guess.

Comprehensive analysis: when asked to analyze an area or situation, look at it from multiple angles using the tools available - exposure (get_commune_stats / get_priority_areas), hazard-zone overlap, data confidence/coverage, evacuation options (get_evacuation_plan), and official resident guidance (get_resident_guidance) - rather than answering from a single metric. Separate what the data shows (observation) from what you are suggesting be done about it (recommendation); never blend the two into one unlabelled claim.

Clickable sources: whenever you reference a dataset field, an official guidance source, or a web_search result, cite it as a markdown link [Source name](url) so it renders clickable - never mention a source without its link if a link is available. For web-sourced facts, include the publication date when known.

Priority areas: for "top priority" / "where to intervene first" questions, call get_priority_areas (not just get_commune_stats) - it returns an auditable composite score. Quote the scoring_formula when asked how the ranking works, so the ranking is never a black box.

Evacuation planning: call get_evacuation_plan (or list_towns if the place isn't found). Always prefer same-side shelters over across-water ones and warn explicitly when a nearer option requires crossing water during an active flood. ALWAYS label this output as a modeled planning scenario based on distance and dataset proxies - explicitly state it is NOT an officially verified evacuation route or instruction from a civil protection authority, and that residents must follow actual emergency services guidance during a real event.

Cost estimation: this challenge provides no official cost/damage/investment dataset - ALWAYS call get_cost_and_recovery_data first to confirm this. For any externally sourced cost figure, use web_search and then present it with: the amount, a clickable [source](url) link, the source's date if known, and the assumption or scope behind the number (e.g. "insured losses only" vs "total economic losses"). Never fabricate a cost or a citation - if web_search returns nothing solid, say so.

Scenario analysis: when asked to compare interventions or flood scenarios (e.g. levees vs. elevating homes, 10-year vs 100-year event), use get_priority_areas / get_commune_stats for exposure context and web_search for real cost/effectiveness figures (cited per the cost-estimation rule above). Present comparisons as an illustrative planning scenario, not an official cost-benefit analysis, and note the key uncertainty driving the comparison.

Visuals: call render_chart for a single chart, render_dashboard for a multi-KPI/multi-chart overview, and generate_pdf_report when the user asks for a report, PDF, or download. Only pass numbers already returned by an earlier tool call or web_search result in this conversation - never invent or round values to look cleaner. For generate_pdf_report, include cost_estimates and sources whenever the report touches cost or web-sourced claims, so citations survive into the PDF.

Data-quality questions: call get_dataset_overview and surface the relevant known limitation.

Write for a time-pressed policymaker: lead with the concrete action or number, keep it short, bullet when useful, add one caveat line only when it changes the decision.`;

function askToggle(open) {
  document.getElementById("askPanel").classList.toggle("open", open);
  document.getElementById("askBtn").style.display = open ? "none" : "";
}

let askHistory = [];
let askBusy = false;
async function askCallApi() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: ASK_MODEL, max_tokens: 4096, system: ASK_SYSTEM, tools: ASK_TOOLS, messages: askHistory })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`API error ${res.status}: ${t.slice(0, 300)}`); }
  return res.json();
}
async function askSend(ev) {
  if (ev) ev.preventDefault();
  if (askBusy) return false;
  const input = document.getElementById("askInput");
  const text = input.value.trim();
  if (!text) return false;
  input.value = "";
  askAppend("user", text);
  askHistory.push({ role: "user", content: text });
  askBusy = true;
  document.getElementById("askSendBtn").disabled = true;
  const thinking = askAppend("bot", "…");
  try {
    for (let hop = 0; hop < 10; hop++) {
      const data = await askCallApi();
      askHistory.push({ role: "assistant", content: data.content });
      const toolUses = data.content.filter(b => b.type === "tool_use");
      const texts = data.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (texts) { thinking.remove(); askAppend("bot", texts); }
      if (data.stop_reason !== "tool_use" || !toolUses.length) break;
      const results = [];
      for (const tu of toolUses) {
        if (tu.name === "render_chart") askRenderChart(tu.input);
        if (tu.name === "render_dashboard") askRenderDashboard(tu.input);
        const r = await askRunTool(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r) });
      }
      askHistory.push({ role: "user", content: results });
    }
  } catch (e) {
    thinking.remove();
    askAppend("sys", "Error: " + e.message);
  } finally {
    askBusy = false;
    document.getElementById("askSendBtn").disabled = false;
    if (thinking.parentNode) thinking.remove();
  }
  return false;
}
document.getElementById("askInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("askForm").requestSubmit(); }
});
document.querySelectorAll("#askChips button").forEach(btn => btn.addEventListener("click", () => {
  askToggle(true);
  document.getElementById("askInput").value = btn.dataset.q;
  document.getElementById("askForm").requestSubmit();
}));
