# Solstice: feature roadmap

Design direction: **Aurora** (`mockups/c-aurora.html`). It runs locally on the Mac as an installable PWA and alerts in-app.
Status legend: ✅ in the mockup · ◻︎ planned, not mocked · ⚠️ depends on something we still need to verify

## Data sources

| Source | What it gives | How | Cost |
|---|---|---|---|
| Tesla Fleet API `live_status` | solar / home / battery / grid W, charge %, energy left, pack capacity, grid & island status, storm mode | poll every 30 s (60 s when idle) | free (energy endpoints aren't charged) |
| Tesla Fleet API `site_info` | battery count, nameplate, firmware, reserve %, mode, export rule, tariff | hourly | free |
| Tesla Fleet API `calendar_history` (energy, backup) | Wh flows by source→sink, outage events | every 5 min today, once per closed day, backfill on first run | free |
| SunPower PVS monitor (local) ◻︎ | per-module W / V from the Enphase IQ7XS microinverters (the array has no strings) | LAN poll of the PVS installer port, if it is still online | free · unverified on this unit |
| Open-Meteo | hourly forecast, sunlight on your panels (tilt 27°, azimuth 244°), cloud, temperature, rainfall, 60+ days of history | browser or server | free, no key |
| NWS `api.weather.gov` | active severe-weather alerts for LAT, LON (`SITE_LAT`, `SITE_LON`) | every 10 min | free |
| ERCOT dashboards | grid condition (normal / conservation / EEA), demand vs capacity, fuel mix for CO₂ | via the server (CORS blocks the browser) | free |
| PEC bills | kWh delivered and received, amounts, rates, read type | PDF drop (parsed locally), manual entry, or CSV from SmartHub | — |

## Features

### Now
- ✅ Liquid 3D Powerwall orb, aurora sky tinted by energy mix, a one-line summary of what's happening
- ✅ Live flow diagram (solar / grid / home / Powerwall) with animated direction and kW
- ✅ Powerwall card: %, kWh, per unit, rate, time to full or reserve, backup time, charged and discharged today, mode, Storm Watch, health
- ✅ Status chips: gateway online, NWS alerts (live), ERCOT condition, Storm Watch
- ✅ **Next 48 hours**: forecast solar, predicted usage, predicted charge curve, "full by", lowest point
- ✅ Next 12 hours of weather with expected kW; today's totals
- ✅ **Outage mode**: ember sky, banner and timer, grid shown offline, backup-remaining estimate, restore toast
- ◻︎ "Replay today" scrubber: drag through the day and watch every screen rewind

### Panels
- ✅ Roof twin with the real sun position and path, live clouds and rain, shadows, and per-panel glow
- ◻︎ Per-panel output (needs the SunPower PVS; the array is 30 AC modules with microinverters, so there are no strings)
- ✅ Cleaning check: dust score, loss pattern, real past rainfall, next rain, cost of dust, "I cleaned" logging
- ✅ Watch list for a single low panel
- ◻︎ Before/after cleaning comparison (the first 3 sunny days after logging a cleaning)
- ✅ Full-sun output vs the SunPower warranty floor (98% year 1, then −0.25%/yr; AC ≥ 90%). ◻︎ Year-by-year trend
- ◻︎ Clipping detection (each microinverter tops out at 315 VA, so the array flat-tops at 9.45 kW)
- ◻︎ After a hail warning: automatic check against the pre-storm baseline

### History
- ✅ Day radial chart; Week / Month / Year bars; outage markers
- ✅ 3D production landscape (30 days × 24 h), tap for detail
- ✅ Powerwall charge heatmap (30 days × 24 h) with cycles, days full, reserve hits, overnight low
- ✅ Records and streaks (self-powered streak, best day, biggest export, longest off-grid, lifetime, CO₂)
- ✅ Outage timeline and list (duration, cause, battery low point, solar share)
- ◻︎ Same day last year / year-over-year overlay
- ◻︎ Usage calendar heatmap (365 days)

### PEC bills
- ✅ Bill check: meter vs Tesla, export credit applied, rate change, estimated read
- ✅ 12-month meter vs Tesla chart with a flagged estimated read and true-up
- ✅ "Where the bill went" waterfall (no solar → solar direct → Powerwall → export credit → paid)
- ✅ This billing cycle: progress and projected bill
- ✅ Effective-rate trend (learned from bills, feeding every savings number)
- ◻︎ PDF parser tuned to PEC's bill layout (**needs 1–2 real bills**)
- ◻︎ Capital credits and co-op line items (PEC-specific)

### Insights and planning
- ✅ Insights as four panels (Today · Appliances · Planner · Home) with a three.js **Day Ring** (hourly loads by pool / AC estimate / rest, solar ribbon, morph modes)
- ✅ **Appliances**: pool & spa holographic flow twin driven by ScreenLogic circuits; 24-h schedule dial (now vs recommended, reasons, apply/restore); **Autopilot** (suggest/auto, nightly 8:15 PM cron, forecast + water temp + use + pollen signals, change log, D.E. filter run hours). ◻︎ AC via Nest in the same slots. ◻︎ circuit chips as controls
- ✅ Outage readiness, solar low, overnight baseline drift, Powerwall health, tomorrow's forecast
- ✅ **Heat and AC**: daily usage vs real daily high (60 days), kWh per degree, outlier days flagged
- ✅ **What-if planner**: +panels, +Powerwalls, +daily usage → a full year simulated with PEC rates, cost, payback, backup hours, honest recommendation
- ✅ Data health: last sync per source, gaps
- ◻︎ Weekly digest card (and a monthly one-page report you can save as PDF)
- ◻︎ ERCOT conservation or EEA alert: "grid is tight tonight; your batteries are X% full"
- ◻︎ Carbon: live ERCOT grid intensity; your exports' CO₂ displaced

### Settings and platform
- ✅ Connections, system details, utility, alert switches, calm mode (reduced motion), CSV export, local storage
- ✅ Performance: pauses rendering when the tab is hidden; respects the reduced-motion setting
- ◻︎ Web Push notifications for the installed PWA (after in-app alerts are proven)
- ◻︎ Optional Powerwall controls (reserve, Storm Watch, mode). These need the `energy_cmds` scope added to the Tesla app
- ◻︎ EV charging from solar, **if there's a Tesla vehicle or Wall Connector** (needs vehicle scopes)

## Build order (MVP → v1)
1. Server: Tesla OAuth (auth-code + refresh), poller, SQLite schema, history backfill, Open-Meteo and NWS, ERCOT proxy
2. Now tab with real data, including outage detection from `grid_status` / `island_status`
3. History and Powerwall analytics from stored readings
4. Weather model → performance ratio → cleaning check and alerts
5. PEC bill entry and parser → reconciliation, rates, savings, planner calibration
6. SunPower PVS per-module data, if reachable (Panels tab goes from estimated to measured)
7. Polish, the PWA manifest and service worker, and install on the phone

## Open questions
- ~~System size~~ Resolved: 30 × SunPower E19-320 AC, 9.6 kW DC / 9.45 kW AC (docs/system-specs.md). Still need the permit drawing for tilt, azimuth and layout, and the PTO date.
- One or two real PEC bills (PDF or photo) for the parser
- Do you have a Tesla vehicle or Wall Connector? (It would unlock "EV charged from sunshine".)
- Is the SunPower PVS monitor still online, and reachable on the LAN, for per-module data?
