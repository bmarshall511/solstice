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

## Owner access (`OWNER_KEY`)

Solstice has no accounts. Every `/api` and `/auth` route is private to the owner, except `/api/auth/me`, the Vercel crons (which use `Authorization: Bearer $CRON_SECRET`) and the Tesla/Google OAuth callbacks (which check a signed, single-use `state`).

- Set `OWNER_KEY` in `.env` (local) and in the Vercel env (Production and Preview). Use a long random value, at least 32 characters, for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Keep it in a password manager. Never commit it.
- Open `https://<your-app>/#owner=<OWNER_KEY>` once on each device. The key travels in the URL fragment, so it never reaches server logs; the app posts it to `POST /api/auth/owner`, strips it from the address bar, and the server sets a 400-day HttpOnly `solstice_owner` cookie for that device.
- Without the cookie the app shows "Solstice is private" and every API call answers 401. If `OWNER_KEY` is unset or shorter than 32 characters, the server logs a warning at start and nobody can unlock (it fails closed), locally too.
- Sign out: `POST /api/auth/signout` (this device), `POST /api/auth/signout-others`; `GET /api/auth/devices` lists signed-in devices. Changing `OWNER_KEY` signs every device out.

## Alerts and push notifications

The server keeps an alerts feed (`GET /api/alerts`, `POST /api/alerts/:id/read`) and pushes each alert to every device that turned notifications on (`POST` / `DELETE /api/push/subscribe`). Kinds: `approval`, `billDue`, `anomaly`, `storm`, `ercot`, `panel`, `digest`. The Settings → Alerts switches silence a kind (`alerts.<kind> = false`; the existing `nws` switch covers storms, `solar` and `baseline` cover their anomalies). The feed always keeps an alert; only the push is rate-limited per kind (`PUSH_LIMITS` in `server/src/notify.ts`). There is no email.

Web Push needs a VAPID key pair in `.env` and the Vercel env (Production and Preview). Nothing is generated into the repo; without the keys alerts are still stored and nothing is pushed.

```bash
VAPID_PUBLIC_KEY=<base64url, 65-byte P-256 public key>    # served to the app by GET /api/push/key (not secret)
VAPID_PRIVATE_KEY=<base64url, 32-byte private key>        # secret
VAPID_SUBJECT=mailto:<an address you read>                # or an https: URL; push services use it to reach you
# generate a pair once:
node -e "const c=require('crypto').createECDH('prime256v1');c.generateKeys();console.log('VAPID_PUBLIC_KEY='+c.getPublicKey('base64url')+'\nVAPID_PRIVATE_KEY='+c.getPrivateKey('base64url'))"
```

Push is sent without a dependency (`server/src/push.ts`: RFC 8291 aes128gcm encryption and an RFC 8292 VAPID JWT on `node:crypto`). Only Apple, Google, Mozilla and Microsoft push endpoints are accepted. Rotating the keys invalidates every subscription, so each device has to subscribe again.

## Weekly digest, presence and Powerwall rules

- **Digest**: every Monday 07:00 Chicago the first cron tick stores last week (kWh, sunshine share, Autopilot and Powerwall actions, anomalies, confidence tiers; no dollar figures) and sends one `digest` alert. `GET /api/digest?week=2026-W39` (or any date in the week; default the last complete week).
- **Presence**: `GET /api/presence` → `{state, source, since, until}`; `POST /api/presence {state:'away', until}` or `{state:'home'}`. Order: the manual mark (Away until its time), then Nest Home/Away Assist as the thermostat's Eco state (read from the stored Nest reading, never written; `settings.ac.nestPresence: false` turns it off), then home. The AC card's Home/Away switch is the same manual mark.
- **Powerwall rules** (`energy_cmds` scope): `reserve` (tonight's reserve from the 48-hour battery model, never below `settings.powerwall.reserveFloorPct`, default 20), `storm` (100 % for an NWS storm Warning or active Storm Watch, 50 % for a Watch, then back), `export` (`pv_only` unless the bill's export credit beats a stored kWh). Each is Off, Suggest (default) or Auto: `GET /api/powerwall/rules`, `POST /api/powerwall/rules/:id {mode}`, `POST /api/powerwall/rules/:id/apply` (Suggest only). Every command is clamped in `server/src/appliances/guards.ts` (reserve 10–100 %, never below 20 % in a storm, one change per setting per hour, export rule only `battery_ok`/`pv_only`) and logged in `powerwall_log`.
- The scope list now asks for `energy_cmds`. Add "Energy Product Settings" to the Fleet API app in the Tesla developer portal, then open `/auth/login` once and approve (Tesla shows only the missing scope). `GET /api/tesla/scopes` says whether the stored token has it; until it does every command answers `scope_missing` and nothing is sent.

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
