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

## Owner access (`OWNER_KEY`)

Solstice has no accounts. Every `/api` and `/auth` route is private to the owner, except `/api/auth/me`, the Vercel crons (which use `Authorization: Bearer $CRON_SECRET`) and the Tesla/Google OAuth callbacks (which check a signed, single-use `state`).

- Set `OWNER_KEY` in `.env` (local) and in the Vercel env (Production and Preview). Use a long random value, at least 32 characters, for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Keep it in a password manager. Never commit it.
- Open `https://<your-app>/#owner=<OWNER_KEY>` once on each device. The key travels in the URL fragment, so it never reaches server logs; the app posts it to `POST /api/auth/owner`, strips it from the address bar, and the server sets a 400-day HttpOnly `solstice_owner` cookie for that device.
- Without the cookie the app shows "Solstice is private" and every API call answers 401. If `OWNER_KEY` is unset or shorter than 32 characters, the server logs a warning at start and nobody can unlock (it fails closed), locally too.
- Sign out: `POST /api/auth/signout` (this device), `POST /api/auth/signout-others`; `GET /api/auth/devices` lists signed-in devices. Changing `OWNER_KEY` signs every device out.

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
