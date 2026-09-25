# Solstice — working rules for Claude

Solstice is the owner's personal Tesla Powerwall + solar + pool + AC monitor. One owner, one site, no user accounts. The repo is **public** (github.com/bmarshall511/solstice); the production app is the Vercel project `solstice-energy` (its URL is in the Vercel dashboard and in Claude's memory, not here). Nothing in this file may name the owner, the address or the production URL (rule 5).

## Non-negotiable rules

1. **Two phases for any sizeable piece of work.** Phase 1 is read-only: audit, report, mockups. No app-code changes, no deploys, no writes to any device. Phase 2 builds only what the owner has approved, in batches of about five items, each verified on a live URL with screenshots before the next batch starts.
2. **Mockup approval before building anything visual or any new feature.** Mockups are HTML in `mockups/` that link `../web/src/style.css`, rendered in the browser and sent to the owner, checked at phone width (393 px) for overflow. Answering the owner's questions is **not** approval. Wait for an explicit "approved" / "go ahead" on the mockup itself, then build exactly that.
3. **Change only what is asked or approved.** A request to change one element means only that element; the rest of the screen stays identical. Never redesign surrounding UI, headers, lists or navigation.
4. **Never write to ScreenLogic (pool) or Nest (thermostat) yourself unless the owner explicitly asks in that same message.** Reading is fine. The owner chose **Auto** for both Pool and AC Autopilot on 2026-09-25 (that is the point of the feature); leave both settings alone and never flip them to Suggest or Off without being asked.
5. **No user accounts, ever.** The `MULTI_USER` code path stays off. Secrets live in `.env` and Vercel env only. Nothing personal in git: no name, address, account numbers, bills, loan or price figures, or the install documents. `data/`, `secrets/`, `.env*`, `*.pem` (except the Fleet API public key) and `mockups/d-rooftop.html` are git-ignored on purpose. Real dollar figures for the system price, loan or payback must never appear in mockups or docs.
6. **Phase 2 work happens on a branch with Vercel preview deployments.** Merge to `main` only after the owner has tried the preview and approved. Never force-push. Never drop or rewrite database tables.
7. The owner wants Claude to handle secrets and setup steps for this private app (Vercel, Neon, GCP) itself rather than asking him to, but never asks for or types Tesla credentials or payment details.

## Stack and layout

- Node 22 (`nvm use 22`; `.nvmrc`). No native npm deps (the Xcode licence is not accepted on this Mac). Vercel's project setting says Node 24.x; the app is written for 22.
- Server: TypeScript, Express 5, `server/src/`. In production the whole API is **one Vercel function**, `api/index.ts`, with `vercel.json` rewrites for `/api/*` and `/auth/*`. Locally `npm run dev` serves it on http://localhost:8787.
- Database: Neon Postgres ("solstice-db", iad1) through `@neondatabase/serverless`; PGlite for tests/local (`DATABASE_URL=pglite:<dir>`). Access is through `q`/`one`/`kv` in `server/src/db.ts`; the schema is created with `CREATE TABLE IF NOT EXISTS` on first request.
- Web: vanilla JS + three.js + Vite in `web/`. `web/src/main.js` owns all state (`S`), the render loop and navigation; views in `web/src/views/`, three.js scenes in `web/src/scenes/`. Design language: Aurora (glass cards on an aurora sky, Manrope + JetBrains Mono, tokens at the top of `web/src/style.css`).
- Data sources: Tesla Fleet API (energy scope only), Open-Meteo, PEC bill PDFs, Pentair ScreenLogic (pool, `node-screenlogic`), Google Nest SDM (AC), ERCOT dashboards, NWS alerts.
- Docs: `docs/roadmap.md`, `docs/system-specs.md` (as-built solar specs), `docs/fleet-api-energy-research.md` (every Fleet API field). Approved designs: `mockups/g-insights.html`, `mockups/h-pool-twin.html`, `mockups/i-ac.html`.

## Deploying

- Vercel's git integration is **not** auto-deploying. Deploy with `npm run deploy:preview` for a preview, `npm run deploy:prod` for production (project `solstice-energy`, team `highfivery-llc`). Each runs typecheck, the test suite and the web build first and stops on the first failure before calling `vercel deploy` (`--yes` / `--prod --yes`).
- `.vercelignore` at the repo root is an **allow-list** (`/*` then `!/api`, `!/server`, `!/web`, etc.), not a denylist — it's what actually controls what `vercel deploy` uploads, in place of `.gitignore`. When a new top-level directory becomes part of the build (installCommand, buildCommand, or something `api/index.ts` imports), add a `!/<dir>` line for it there or it silently stops being deployed.
- Integration env vars on Vercel are "sensitive": `vercel env pull` returns placeholders.
- Crons in `vercel.json`: `/api/cron/sync` nightly, `/api/cron/pool` 01:15 UTC (8:15 PM Central), `/api/cron/nest` every 5 minutes. They require `Authorization: Bearer $CRON_SECRET`.

## Gotchas (learned the hard way)

- **Single-owner mode**: `/api/auth/me` returns `mode: 'single'`; `requireUser` attaches the first connected site to every request with **no authentication**. Anything under `/api` is reachable by anyone who has the URL until that is changed.
- **Tesla refresh tokens are single-use.** Only one server may use the account. The cloud DB owns the token now; never run a local server against the cloud database or the old SQLite tokens.
- `calendar_history` backup `duration` is **milliseconds** (the docs say seconds). `period=day` returns 5-minute buckets; single buckets can read above the 9.45 kW AC ceiling, so peaks from buckets are inflated.
- `live_status` omits `energy_left` / `total_pack_energy` for this site. Batteries are 2 × Powerwall 2 (not 3), so there is no per-string MPPT data; per-panel data would come from the SunPower PVS, not Tesla.
- The `energy` and `soe` tables store `ts` as the Fleet API's local RFC3339 string and `day`/`hour` in America/Chicago. Every date helper (`localDay`, `localMidnight`, `rfc3339`) is Chicago-based.
- **ScreenLogic** (`server/src/appliances/screenlogic.ts`): `setPumpSpeedAsync`'s second argument is the **slot index** (0-based) in `getPumpStatus().pumpCircuits`, not the circuit id. Acks can take longer than the 2.5 s default `netTimeout`; use 8000 ms and verify the speed via status instead of treating a timeout as failure. Pump ids are 1-based on this firmware (0 times out). Always add the new schedules before deleting old ones: the first apply attempt deleted the original schedules and then failed. Original schedule (for reference): Waterfall 12a–5a @3400, Pool 8a–5p and 8p–10p @1800, High Speed 12p–6p @3000. Plan applied 2026-09-24: Pool 10a–7p @1500, High Speed 2p–3p @2400.
- **Nest**: the Google OAuth `state` TTL was raised to 1 hour because the consent page is slow. SDM is rate-limited (about 5 queries per minute per project); the 5-minute cron plus app reads must stay under it. In GCP, "Add users" on the consent screen needed a real mouse click.
- **Open-Meteo azimuth** convention: 0 = south, +90 = west, so the roof's 244° compass azimuth is `azimuth=64`. Radiation values describe the hour *ending* at the timestamp.
- Open-Meteo, NWS and ERCOT are called with no key; ERCOT blocks browser CORS so it goes through `/api/ercot`.
- PEC bills are parsed with pdf.js in-process (`server/src/pdf.ts`); the parser is tuned to PEC's layout and bills contain name/address/account, so they live only in `data/bills/` (git-ignored).
- The Fleet API public key must stay reachable at `/.well-known/appspecific/com.tesla.3p.public-key.pem` (served from `web/public/`).
- Tesla's `backup_history` endpoint intermittently returns HTTP 504; the app records the error in `kv` and keeps the last good events.
- **Day windows and DST**: `fetchDay` ends a day at `start + 24 h − 1 s`, so the DST-start day (2026-03-08) was fetched with a window that crosses midnight and stored zero rows, and the fall-back day loses its last hour. A day is marked synced even with zero buckets. Until Batch 2 fixes this, treat monthly totals containing those days as slightly low.
- **jsonb `?|` never matches numeric arrays**: `pool_readings.circuits` stores numbers (`[2,3,6]`) and the `circuits ?| array['1','2']` predicates in `autopilot.ts`/`pool.ts` only match string elements, so the "used yesterday", pool-light and use-day signals never fire. Use `jsonb_array_elements_text` instead.
- **Google consent screen is in Testing mode**, so Nest refresh tokens expire after 7 days and the app keeps reporting "linked" while every SDM call fails. Publish the consent screen (or re-link weekly) before relying on the AC cron.
- **Vercel CLI deploys upload the working directory.** A root `.vercelignore` (see Deploying) now keeps `.env*`, `secrets/`, `data/`, `docs/`, `mockups/`, `scripts/`, `tests/` and `.claude/` off every deploy by only allow-listing `api/`, `server/`, `web/` and the handful of root config files the build reads.
- **Workflow resume caching** (Claude tooling): cached agent results key on call order as well as prompt/options, so stopping and resuming a workflow re-runs stages whose call order changed.
- `learnAcKw` runs two un-indexed `energy` scans per thermostat transition on every AC read and every 5-minute cron tick; it will exceed the 60 s function limit within about two weeks of Nest history. Fixed in Batch 4 (one query, index on `energy(site_id, epoch)`, hourly cache).
- Both Autopilots run in `auto` by the owner's choice (confirmed 2026-09-25). Do not change either setting; the safety clamps in Phase 2 Batch 1 bound what they may write.

## Rendering mockups

- Open mockups through the built-in browser's static server, not `file://` (relative stylesheet links break): `.claude/launch.json` defines `mockups` (python http.server on :8765) → `http://localhost:8765/mockups/<file>.html`, emulate 375–393 px, screenshot every frame, then reset the viewport.
- Mockup names so far: a–i (earlier designs; g, h, i approved), j-ui-fixes, k–p visualizations, q-share, r-learning. Continue from s.

## Working style the owner expects

- Show, don't tell: mockups and live-URL screenshots, checked at phone width.
- Data-rich, not pared down: surface every available field (see `docs/fleet-api-energy-research.md`) but keep the roof 3D view minimal (house, panels, Powerwalls only).
- Ask questions in one list, then wait. Don't build while waiting.
- Report outcomes plainly, including failures and anything skipped.
