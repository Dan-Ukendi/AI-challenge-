# In-app AI assistant

A chat panel in the Paragon Crisis Portal (button **Ask the assistant**, bottom-right of every tab). It answers questions about the app's own data (July 2021 floods, Belgium, Germany, the Netherlands) by calling small tools that run in the page, and it says which tab each figure comes from. It is **planning information, not an official warning**: the panel shows this permanently, and the assistant points to NINA / KATWARN, BE-Alert, NL-Alert and the commune for real emergencies.

## Architecture

```
browser (app/index.html)                      this computer                          external
  src/js/app_assistant.js  --POST /chat-->   live/live_proxy.py  --HTTPS-->  api.anthropic.com/v1/messages
  tools run here, on D                       adds the key from the environment,
  (only short results are sent)              enforces model, size, tool and budget limits
```

- The page never holds a key. `live_proxy.py` reads the environment variable `ANTHROPIC_API_KEY` at each request and sends it upstream in the `x-api-key` header, with `anthropic-version: 2023-06-01`. The key is never written to a file, a log or an answer; `/assistant/health` only says `configured: true/false`.
- Each question is a small loop: the page sends the question, the system prompt and the tool definitions; the model asks for a tool; the page runs it on the embedded data `D` and sends back a short JSON result (top-N rows, 10 by default, 25 at most, about 5 KB at most); the model writes the answer. Every answer shows a line "Used: tool names".
- Model: `claude-sonnet-5-5` (set by the proxy; the page does not choose it), effort `low`, `max_tokens` 1024.

## Run it

1. Set the key once in your Windows user environment (System settings > Environment variables > `ANTHROPIC_API_KEY`), or only for one terminal: `$env:ANTHROPIC_API_KEY = "..."` (PowerShell). Never put it in a file of this repository.
2. Open a **new** terminal (so it sees the variable) at the repository root and start the proxy: `py -3.13 live/live_proxy.py`. It prints `assistant: POST /chat, key found` (or `NOT set`).
3. Build and open the app as usual (`py -3.13 src/build_app.py`, then `app/index.html` or `http://localhost:8000`). Click **Ask the assistant**.

Without the proxy, or without the variable, the panel shows "Assistant offline: start live/live_proxy.py with ANTHROPIC_API_KEY set" and the rest of the app works exactly as before.

## Tools (run in the browser, on the app's data)

| Tool | What it returns |
|---|---|
| `search_communes(query)` | up to 8 communes (id, country, mapped in 2021 or not), accents optional |
| `get_commune(name_or_id, country?)` | residents and buildings in the 2021 flood (estimates), share, flooded ha, area mapped, priority tier and its focus, modelled 10/100/500-year zone shares, sites near the flood, islands, official-zone gap (DE), official advice sources of the country and its alert service |
| `get_priority_areas(country?, metric, n)` | communes ranked by `pop_exposed`, `per1000`, `buildings` or `flood_ha`, plus the tier rule (thresholds from `D.rules`) |
| `get_islands(country?, n)` | ranked islands: residents cut off, gaps, nearest hospital and straight-line km, closed road links, fire stations, shelters, vulnerable sites, plus the draft ranking rule |
| `get_official_zone_gap(land_or_commune)` | NRW / RLP / Total or a German commune: 2021 flood, official zone, gap outside it, buildings, estimated residents, with the notes on statuses |
| `get_alerts()` | current in-page alert state and the stations with thresholds and their origin (source or team draft); `{"available": false}` if the alerts feature is absent |
| `get_live_levels(station_or_region)` | latest values loaded by the Live water levels tab; `{"available": false, "note": "open the Live tab..."}` before that |
| `get_dataset_limits()` | the known limits of the data (snapshots, mapped areas only, GHS-POP estimates, Länder statuses, OSM snapshot, islands from observed flood only, draft thresholds) |
| `render_chart(type, title, labels, values, unit)` | draws a small bar chart in the chat; refused if the arrays are empty or if a value was not returned by an earlier tool call of the conversation |

**Export answer** opens a clean printable page of the conversation (use the browser's Print > Save as PDF). No library is used.

## Limits and cost controls

Enforced by the proxy (environment variables, read at each request):

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTANT_MODEL` | `claude-sonnet-5-5` | allowed model(s), comma-separated; the first is used; any other model sent by a page is refused (400) |
| `ASSISTANT_MAX_TOKENS` | `1024` | cap of `max_tokens` (at most 2048) |
| `ASSISTANT_EFFORT` | `low` | effort sent upstream (`low`, `medium`, `high`; empty = not sent) |
| `ASSISTANT_MAX_BODY` | `200000` | request body cap in bytes (413 above) |
| `ASSISTANT_SESSION_TURNS` | `30` | requests per page session (header `X-Session`); 429 above |
| `ASSISTANT_HOURLY` | `120` | requests per rolling hour for the whole proxy; 429 above |
| `ASSISTANT_TIMEOUT` | `60` | upstream timeout in seconds |
| `ASSISTANT_WEB_SEARCH` | off | `1` allows the web search server tool (the page then offers it); off by default |
| `ASSISTANT_UPSTREAM` | `https://api.anthropic.com/v1/messages` | for tests only: a local mock server (`http://127.0.0.1:...`); any other host is refused |

Also enforced: only the tools above (by name) are accepted, no extra top-level fields (no streaming), at most 40 messages, localhost `Host` header only (403 otherwise), CORS limited to `file://` pages (Origin `null`), `http://localhost` and `http://127.0.0.1`. Upstream errors are passed on as they are. Nothing of a request or an answer is logged (only the request line).

In the page: the same turn cap is shown as a counter (requests used / cap), the send button is disabled during a request, the history sent is trimmed to the last 8 messages (older tool results shortened, reasoning blocks of finished answers dropped), a request is never sent above 190 KB, and 429, 503 and network errors show a clear message.

## Privacy

- Only the question, the short conversation history and short tool results (a few rows, a few KB) leave the browser, and only to the proxy on this computer, which forwards them to the API. No dataset, no map geometry, no file is sent.
- The key never reaches the page, the browser, the built `app/index.html` or the repository.
- Users are asked not to type personal data; the assistant reminds them once if they do.

The team's AI-use declaration for this assistant is kept in the team's AI sheet, not in this repository.
