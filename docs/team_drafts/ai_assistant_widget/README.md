# AI Policy Assistant — drop-in widget

Floating chat widget (bottom-right button, "Ask the policy assistant") for a flood-data dashboard.
Grounded in your app's own data object (`D`); uses live web search only when a question has no
answer in the local dataset (e.g. cost/damage/investment questions). Can also generate charts,
multi-KPI dashboards, and downloadable PDF reports directly from chat.

## How to integrate (4 pastes)

Your friend's app already defines `const D = {...}` somewhere in a `<script>` tag — that's the
data this widget reads from. The widget script must be pasted **after** that line so `D` already
exists when it runs.

1. **In `<head>`**, add this one line (needed for PDF report generation):
   ```html
   <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
   ```
2. Paste `widget.css` contents into his `<style>` block (anywhere, order doesn't matter).
3. Paste `widget.html` contents right before `</body>`.
4. Paste `widget.js` contents wrapped in a `<script>...</script>` tag, right after that — so it
   comes **after** the `<script>` that defines `const D = ...`.

Open the file in a browser. Done — floating button bottom-right.

## What it needs from `D`

The widget's tool functions expect this shape (same as our `build_app.py` output):
- `D.countries[cc].lau.features[].properties` — `name, country, pop_exposed, pop_total, per1000, tier, hazard_share_100, coverage_pct`
- `D.tiers`, `D.actions`, `D.sources`, `D.rules`, `D.cfg`, `D.inventory`
- `D.town_summaries` — array with `place_name, country, river, population, pct_across_water, shelters_same_side, shelters_across_water`
- `D.recovery_tracker.entries` — desk-research log (can be empty/placeholder; the widget handles that honestly)

If your friend's actual app has a differently-shaped data object, the tool functions in `widget.js`
(inside `askRunTool`) will need small adjustments to match his field names — send me his file and
I'll adapt it fast.

## API key

The key is hardcoded directly in `widget.js` (`ANTHROPIC_API_KEY`) — accepted risk for a one-day
hackathon demo. Revoke/rotate the key after presenting.

## What it does

**Core chat**: floating button + popup panel, 4 suggested-question chips, markdown-formatted
answers with real clickable source links (not just plain text URLs).

**Tools** (11 total):
- `get_commune_stats` / `get_priority_areas` — exposure stats and a transparent, auditable
  composite priority ranking (the scoring formula is returned with every result, never a black box).
- `get_evacuation_plan` / `list_towns` — same-side vs. across-water shelter options with distances.
  Always framed as a **modeled planning scenario, not an official evacuation instruction**.
- `get_resident_guidance` — official, source-cited action guidance per country/tier.
- `get_cost_and_recovery_data` + `web_search` — this challenge has no official cost dataset, so
  cost/investment questions are answered via live, cited web search instead: every externally
  sourced figure must come with a clickable link, a date (if known), and its underlying assumptions.
- `get_dataset_overview` — known data limitations, surfaced on request.
- `render_chart` / `render_dashboard` — single charts or multi-KPI/multi-chart overviews, built
  only from numbers already returned by another tool call in the same conversation.
- `generate_pdf_report` — builds and downloads a real PDF (via jsPDF) with a title, executive
  summary, key findings, a data table, an embedded chart, cost estimates (each with clickable
  source/date/assumptions), policy recommendations, and a sources list.

**Honesty rules baked into the system prompt**: never guess a number, separate "what the data
shows" from "what I'm recommending," multi-angle analysis instead of single-metric answers, and
explicit scenario-vs-official framing for evacuation and intervention-comparison questions.

**Deliberately not included** (flagged, not silently dropped): real map images embedded in PDFs
(would need a screenshot library with CORS risk) and turn-by-turn evacuation routing (would need a
routing API) — both judged too fragile to add reliably under hackathon time pressure.
