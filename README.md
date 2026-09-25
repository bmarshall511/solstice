# Solstice

A personal, local-first dashboard for a Tesla Powerwall + solar system, built on the Tesla Fleet API.
Everything (readings, history, bills, tokens) is stored on your Mac in `data/`, which is git-ignored.

## Run it

```bash
nvm use 22          # Node 22+ (uses the built-in node:sqlite)
npm install
npm start           # builds the web app and serves everything on http://localhost:8787
```

- First run: open http://localhost:8787/auth/login and sign in with Tesla.
- The server polls live status every 30 s, pulls 5-minute history every 5 min, and backfills past days on first connect.
- Development: `npm run dev` (server, auto-restart) and `npm run web` (Vite on :5173 with hot reload, proxied to the server).

### Site location

The coordinates and ZIP are never in the code, because this repo and the web bundle are public. Set them in `.env` locally and in the Vercel project's environment variables. The server warns at startup if they are missing, and the web app gets them from `/api/settings`.

```bash
SITE_LAT=<latitude>     # decimal degrees; two decimals (about 1 km) is plenty
SITE_LON=<longitude>    # decimal degrees, negative west of Greenwich
SITE_ZIP=<zip>          # 5 digits, shown in Settings
```

## What's in it

| Tab | What it shows |
| --- | --- |
| **Now** | Live Powerwall orb, energy flow, outage mode, 48-hour forecast (your usage + Open-Meteo sunlight), today's totals, weather, NWS and ERCOT status |
| **History** | Day radial and week/month/year charts, 3D production landscape, Powerwall charge heatmap, records, outages, PEC bill checks (meter vs Tesla, waterfall, billing cycle) |
| **Panels** | Live 3D roof with the real sun path, clouds and rain; performance vs sunlight (compared with last year); cleaning check with real rainfall |
| **Insights** | Alerts, a what-if planner that replays your last 12 months of real data, heat vs AC usage, overnight baseline, data health |
| **Settings** | System details, PEC tariff learned from bills, alert switches, raw data, CSV export, outage preview |

Monthly PEC bills: History → **+ Add a PEC bill** → drop the PDF. It's parsed locally, checked, and reconciled with Tesla.

## Layout

| Path | Purpose |
| --- | --- |
| `server/` | Node + TypeScript: Tesla OAuth, Fleet API client, SQLite, poller, API, bill parser |
| `web/` | The Aurora PWA (Vite, three.js) |
| `site/` | Static site on Vercel hosting the Fleet API public key (`/.well-known/appspecific/…`) |
| `scripts/` | One-off tools: partner registration, bill parsing, year-over-year analysis |
| `docs/` | Fleet API research and roadmap |
| `mockups/` | Design explorations |
