# Solstice enhancements and integrations: final design

Phase 1, read-only. Nothing in the repo was changed. This merges two candidate designs:
- **Candidate A** ("owner value") ranks features by what changes the owner's decisions and bills.
- **Candidate B** ("integration depth") covers what each source can really provide, and how.

**Winner: A's structure and ranking.** B's more precise integration details are grafted in. Every claim below was checked against `main` at 7cb3eef (`server/src/app.ts`, `auth.ts`, `db.ts`, `sync.ts`, `appliances/*`, `tesla/*`, `web/src/*`, `vercel.json`, `.gitignore`, `docs/*`). Three external facts were also re-checked today:
- The SunStrong `pypvs` LocalAPI doc.
- ERCOT `system-wide-prices.json`.
- ERCOT `daily-prc.json`.

Tags such as **[A]**, **[B]** and **[judge]** mark where each idea came from.

## 0. Scorecard

| Criterion (1–5) | A | B | Notes from verifying against the code |
|---|---|---|---|
| Fit to codebase | 4 | 4.5 | **A's errors:** it claims pool `planFor`'s `force` places hours; it only takes `{hours, boost}`. Its new alert kinds ignore the existing Settings keys. **B is exact:** the three inline `CRON_SECRET` checks, `home.js` line 48 sharing `panelMat`, the `ac.js` copy that already promises "ERCOT conservation call: pre-cool, then hold coastF", and the need for a new `avoid` parameter. |
| Owner value | 5 | 4 | **A:** the realized-savings ledger, the read-only Powerwall settings check, "notifications turn Suggest into savings" and the winter-storm playbook. **B:** the server alerts feed, per-person presence, and the print page for the digest. |
| Simplicity | 4 | 3 | **A:** one 5-minute tick that absorbs `/api/cron/nest`. **B:** adds a separate per-minute cron, a 30-rows-per-sample PVS table and three new docs. |
| Serverless cost | 5 | 3.5 | **A** keeps today's invocation rate. **B's** per-minute cron is 5× the invocations for outage alerts that Tesla's own app already sends. |
| Privacy / no accounts | 4 | 3.5 | **A:** an HttpOnly HMAC cookie for owner devices. **B:** keeps the owner key in `localStorage` (readable by XSS) and leaves every mutation open. **A's weak spots:** its text quotes personal dollar estimates, and it puts the key in a URL query. |
| Risk | 4 | 4 | Both keep device writes Suggest-first. |
| **Total** | **26** | **22.5** | |

**What both candidates missed (added by the judge):**
- **Tesla re-link hijack.** `/auth/login` and `/auth/callback` are open in single-owner mode. Anyone can obtain a valid signed `state` and link their own Tesla account. `exchangeCode(code, null)` then overwrites the owner's `tesla_accounts` row (`WHERE user_id IS NOT DISTINCT FROM null`), and `/auth/google` does the same to the Nest link. F0 closes this.
- **Owner figures exposed.** `GET /api/settings` returns `system.priceUsd` and the loan terms to anyone.
- **Day-ahead ERCOT prices.** `damSppData` holds tomorrow's day-ahead zone prices (verified today). It gives tomorrow's grid-stress hours in time for the 8:15 PM pool cron and the AC week preview.
- **PVS write risk.** The PVS LocalAPI also supports `vars?set=`, so the relay must be GET-only.
- **Nest eco blocks setpoints.** SDM refuses setpoint changes while Eco is on. `acTick` would fail every 5 minutes, so writes must be skipped when `state.eco`.
- **Reserve timing.** Raising the Powerwall reserve *during* a conservation window moves the house onto the grid at the worst moment. Reserve raises happen before the window, on solar.
- **Mockup names.** The `j-*` names collide with the existing `mockups/j-ui-fixes.html`, so the new mockups start at `k-`.

**Rule check (CLAUDE.md):**
- **Rule 1 (two phases):** Phase 1 only.
- **Rule 2 (mockups first):** every visual item names its mockup (§14).
- **Rule 3 (change only what's asked):** existing Settings rows and keys are reused, not redesigned.
- **Rule 4 (ScreenLogic and Nest):** no new write paths to ScreenLogic or Nest. Presence and ERCOT act only through the existing `acTick` gate (plan approved, or Autopilot Auto).
- **Rule 5 (no accounts, nothing personal in git):**
  - There is no users table, password or identity.
  - All secrets are in env.
  - Panel serials, layout, the digest address and the PVS serial suffix stay in the DB or env, never in git.
  - No personal dollar figures appear in this doc. Candidate estimates are restated in kWh.
- **Rule 6 (schema):** only `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.

**Precondition flagged to the orchestrator (not a design question):** both Autopilots are `auto` on the live site. N0 moves the Nest cron into the tick unchanged, so rule 4 requires both to be back in Suggest before N0 ships.

## 1. Where the value is (so the ranking is honest) [A]

| Fact | Consequence |
|---|---|
| PEC is a flat-rate co-op. The learned tariff is import ≈ $0.XX/kWh all-in and export credit ≈ $0.XX/kWh; these rates come only from parsed bills (the code has no fallback rate). There is no TOU and no VPP. | ERCOT prices never reach the bill. They are an outage-risk and grid-citizenship signal. TOU-aware reserve arbitrage is **dropped** (both candidates agree). |
| ~76 kWh/day, and solar covers ~49%. The Powerwalls rarely reach 100% (`drawAlerts`). | The lever is moving load into the solar curve and out of the night, which is what the pool and AC Autopilots do. Value comes from plans being *seen, approved and verified*. |
| The pool schedule changed on 2026-09-24. Using the measured pump curve (153 W @1,500 RPM, 287 W @1,800, log-log above), the old schedule was ≈20–26 kWh/day (Waterfall 12a–5a @3,400 ≈ 13.7 kWh; High Speed 12p–6p @3,000 ≈ 10.6 kWh; Pool at 1,800 ≈ 1.7 kWh). The new one is ≈2.3 kWh/day. | This is the largest saving in the house, and nothing yet *proves* it. Hence the realized-savings ledger (D1b). |
| In Suggest mode, a plan nobody sees never runs. | Notifications are the enabler: "tomorrow's pool plan is waiting" and "pre-cool day, approve?" (N2). |
| Tesla's own app already pushes outages and Storm Watch. | Solstice pushes what Tesla doesn't: approvals, bill due, anomalies, storm *preparation*, grid stress, panel faults and the digest. Outage pushes add a backup-hours estimate. |
| Every `/api` mutation, plus `/auth/login` and `/auth/google`, is reachable unauthenticated. | Push, webhooks and Powerwall commands need a device-pairing secret first (F0). |

**Ranking:**
1. F0 pairing.
2. N0/N1/N2 alerts, push and approvals.
3. D1a/D1b/D1c cost, savings and digest.
4. P1 settings check and reserve advisor.
5. S1 storm behaviour.
6. E1/E2 ERCOT.
7. A1 presence.
8. V1/V2 PVS per-panel data.
9. P2 Powerwall writes.
10. X1 spa, Z1 extras, EV1.

---

## F0. Owner device pairing (a device secret, not an account) [A, hardened by judge]

- **Env:**
  - `OWNER_KEY`: 32+ random characters. Claude sets it in Vercel and `.env` (rule 7).
  - `SESSION_SECRET`: already exists.
- **Pairing:** `POST /auth/owner` with body `{ key }`, using `timingSafeEqual`, limited to 5 tries per 15 min per IP in `kv`.
  - On success it sets cookie `solstice_owner = HMAC-SHA256(SESSION_SECRET, OWNER_KEY)`: `HttpOnly; Secure; SameSite=Lax; Max-Age=34560000` (400 days).
  - This is a POST rather than A's `GET ?key=`, so the key never lands in Vercel logs or browser history.
  - Rotating `OWNER_KEY` un-pairs every device.
- **Middleware:** `requireOwner` covers:
  - every `POST`/`PUT`/`DELETE` under `/api`, except `/api/cron/*` (`CRON_SECRET`), `/api/hook/*` and `/api/ingest/*` (their own bearer tokens), and `/api/admin/import` (`SETUP_TOKEN`);
  - **`GET /auth/login` and `GET /auth/google`** (closes the re-link hijack). The callbacks arrive as top-level GET redirects, so the Lax cookie is sent and the callback checks it too;
  - digest routes (they carry dollar figures).
- **Privacy fix:** `GET /api/settings` omits `system` and `/api/whatif` returns `system: null` unless the request carries the owner cookie. Every other GET is unchanged; tightening GETs belongs to the security topic.
- **Signatures:**

```ts
// server/src/auth.ts (additions)
export const ownerCookieValue: () => string;                          // HMAC of OWNER_KEY with secret()
export function isOwner(req: Request): boolean;                       // timingSafeEqual on the cookie
export function requireOwner(req: Request, res: Response, next: NextFunction): void; // 403 { error: 'pair', pair: true }
// server/src/secrets.ts (new) [B]
export function bearerOk(req: Request, envName: string): boolean;    // Authorization: Bearer <env>, timingSafeEqual, false when env unset
export const requireBearer: (envName: string) => RequestHandler;       // 401 { error: 'unauthorized' }; replaces the 3 inline CRON_SECRET checks
```

- **Web:**
  - `web/src/lib/api.js`: `call()` handles `403 {pair:true}` through a new `setUnpaired()` hook, beside the existing `onUnauthorized`.
  - Settings → Connections gains a "Pair this device" row, a sheet with a password field that POSTs `/auth/owner`.
- **Acceptance:** `curl -X POST …/api/appliances/pool/autopilot -d '{"mode":"auto"}'` returns 403. The same call with the cookie returns 200. `GET /api/settings` without the cookie has no `system` key. `GET /auth/login` without the cookie returns 403.

## N0. Server alerts feed, `notify()` and a 5-minute tick [A tick + B alerts table]

The tick replaces `/api/cron/nest` rather than adding B's per-minute cron. `/api/cron/nest` stays as an alias that calls `tick` during the transition.

```ts
// server/src/notify.ts
export type AlertKind = 'outage'|'lowBatt'|'solar'|'nws'|'bill'|'baseline'|'stale'          // existing Settings → Alerts keys, reused
                      | 'plan'|'billDue'|'digest'|'ercot'|'storm'|'panel';                     // new rows (mockup k)
export async function notify(siteId: string, kind: AlertKind, n: { title: string; body: string; url?: string; key?: string }): Promise<{ stored: boolean; pushed: number; pruned: number }>;
// 1. skip if settings:owner.alerts[kind] === false   2. dedupe kv `notified:${key}` for 24 h
// 3. INSERT INTO alerts (always: the in-app feed)     4. Web Push fan-out (N1)   5. email only for kind 'digest' when RESEND_API_KEY is set
// server/src/tick.ts
export async function tick(siteId: string, now = new Date()): Promise<Record<string, unknown>>;
// Promise.allSettled of steps, each with AbortSignal.timeout(15_000) and its own kv `${id}:due:<step>` timer
```

```sql
CREATE TABLE IF NOT EXISTS alerts (id serial PRIMARY KEY, site_id text NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL,
  url text, key text, at timestamptz NOT NULL DEFAULT now(), read boolean NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS alerts_site_at ON alerts(site_id, at);
```

| Tick step | Every | Rule → `notify` |
|---|---|---|
| `refreshLive` + state edges | 5 min | **outage:** `grid_status !== 'Active'` or `off_grid` edge. The push carries SOC and "~N h at your evening load", which is more than Tesla's own push. **Restored** is the reverse edge. **lowBatt:** SOC < 30% while islanded. **storm:** `storm_mode_active` false→true. **stale:** no live data for 30 min (the in-app card still appears at 3 min, as today). |
| `acTick` | 5 min | Unchanged semantics, and still gated by approval or Auto (rule 4). **New:** skip `setCool` while `state.eco` (SDM rejects it). |
| NWS (S1) | 5 min | `nws` |
| ERCOT (E1) | 5 min | `ercot` |
| Pool read (`readPool` + `recordReading`) | 15 min, 06:00–23:00 | Read only. Feeds X1 and pump learning. |
| PVS health (V1) | 5 min | `panel` |
| Plan approvals (N2) | 20:20 and 07:00 / 09:00 | `plan` |
| Daily 07:00 | 1/day | **solar:** 7-clear-day loss ≥ 8% via M1. **baseline:** the 1–5 AM 7-night average is > 1.15 × the prior-30-night median and at least 150 W higher (the rule moved from `drawAlerts`). **billDue:** `period.to + 33 days`, the `drawBillDue` maths moved server-side. **bill:** a reconcile gap over 5% when a bill is saved. |

- **Other routes:**
  - `GET /api/alerts?since=` feeds `drawAlerts` in `web/src/views/insights.js`. Server alerts become the first cards; the existing client-side cards stay, and `insDot` lights for unread alerts.
  - `POST /api/alerts/read` (owner).
- **`vercel.json`:** `{ "path": "/api/cron/tick", "schedule": "*/5 * * * *" }` replaces the nest entry. Crons do not run on preview deployments, so each preview is tested by calling `/api/cron/tick` with `CRON_SECRET`.
- **Serverless fit:** 8,640 invocations/month, the same as today's nest cron. Tesla energy endpoints are "not charged" (`docs/fleet-api-energy-research.md` §3). Nest stays at 1 read per 5 min, well under ~5 QPM. ScreenLogic goes from "whenever the app is open" to at most 4 logins per hour.
- **Acceptance:** with a readings fixture whose `grid_status` flips to `Islanded`, one `GET /api/cron/tick` inserts exactly one `outage` alert row, and a second call inserts none.

## N1. Web Push for the installed PWA [A + B]

- **Package:** `web-push@3.6.7`, pure JS (`asn1.js`, `http_ece`, `jws`, `https-proxy-agent`, `minimist`), so no native deps (the Xcode licence is not accepted on this Mac).
- **Env:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:`, env only). Generate once with `npx web-push generate-vapid-keys`.
- **Table:**

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint text PRIMARY KEY, site_id text NOT NULL, p256dh text NOT NULL, auth text NOT NULL,
  ua text, created_at timestamptz NOT NULL DEFAULT now(), last_ok timestamptz, fails int NOT NULL DEFAULT 0);
```

- **Routes:**
  - `GET /api/push/key`: the public key, not secret.
  - `POST /api/push/subscribe {endpoint, keys:{p256dh, auth}, ua}`: owner cookie.
  - `DELETE /api/push/subscribe`: owner cookie.
  - `POST /api/push/test`: owner cookie.
- **Sending:** `sendNotification(sub, JSON.stringify({title, body, url, tag}), { vapidDetails, TTL: 3600 })`. A 404 or 410 deletes the row; after 5 failures in a row the row is removed.
- **Client, `web/src/lib/push.js` (new):**
  - On a tap in Settings → Alerts ("Notify this device"): `Notification.requestPermission()`, then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, then POST the subscription.
  - On every app open, `getSubscription()` and re-POST if the endpoint changed (iOS rotates endpoints).
  - When `!('PushManager' in window)` the row says "Add Solstice to your Home Screen first". iOS 16.4+ delivers push only to Home-Screen apps; the manifest already has `display: standalone`.
- **Service worker, `web/public/sw.js`:**
  - Bump `CACHE` to `solstice-v2`.
  - `push` → `showNotification(title, { body, icon: '/icon-180.png', tag, data: { url } })`.
  - `notificationclick` → focus an open client and `postMessage({ go })`, or else `openWindow(url)`.
  - iOS ignores action buttons, so approvals deep-link instead.
- **Deep links:** `web/src/main.js` gets a tiny `?go=v-ins&panel=appl&app=pool` router in `boot()` that calls the existing `go()` and clicks the segment buttons.
- **Privacy:** a subscription holds only a push endpoint (a bearer capability) and lives only in the DB.
- **Acceptance:**
  - On the installed iPhone PWA, turning "Notify this device" on and tapping "Send a test" shows a lock-screen notification within 10 s, and tapping it opens Insights → Appliances.
  - Settings → Preview outage produces no push (the preview stays client-side).

## N2. Plan approvals that reach the phone [A + B]

- **Pool:** at 20:20 Central (right after `/api/cron/pool` stores `${id}:pool:pending`), push "Tomorrow's pool plan is waiting: 9 h at 1,500 RPM, +1 h after rain". If it is still pending at 07:00, send a reminder.
- **AC:** on a day where `plan.precool` or a `gridEvent` applies and `${id}:ac:plan` is not approved by 09:00, push "Pre-cool day: approve?".
- Both deep-link to Insights → Appliances. They run only in Suggest mode.
- **Acceptance:** with Suggest set and a pending pool plan, the 20:20 tick inserts one `plan` alert and pushes once. Applying the plan stops the 07:00 reminder.

## D1a. Daily cost ledger and "what did yesterday cost" [A + B]

```ts
// server/src/costs.ts
export type DayCost = { date: string; importKwh: number; exportKwh: number; energyUsd: number; creditUsd: number; fixedUsd: number; netUsd: number;
  noSolarUsd: number; savedUsd: number; poolKwh: number | null; poolUsd: number | null; acKwh: number | null; acUsd: number | null; restKwh: number };
export async function dailyCosts(siteId: string, days: number): Promise<DayCost[]>;   // GET /api/costs?days=30
```

- **Tariff:** from the latest bill (`listBills().at(-1).tariff`), falling back to the constants already in `app.ts`.
- **Fixed share:** `fixedMonthly × 12 / 365`.
- **No-solar cost:** `home × importRateAllIn`.
- **Pool kWh:** from the schedule model (`poolDetail().current.hourly` via `powerModel`) plus the extras integrated from `pool_readings`.
- **AC kWh:** `nest_readings` runtime × learned `coolKw`.
- **Where it shows:**
  - A "Yesterday" line under the Today stats on Now: "Yesterday: net · without solar · pool · AC".
  - A row per day in History → Day.
  - It feeds the digest. No push of its own.
- **Acceptance [B]:** summed over the days of the last billing cycle, `netUsd` is within 5% of that bill's energy charges in `reconcile`.

## D1b. Realized-savings ledger [A, method tightened by judge]

- **Pool, primary method:** model-based.
  - The baseline is the original schedule, stored once in `settings.pool.baselineSchedule`: Waterfall 12a–5a @3,400; Pool 8a–5p and 8p–10p @1,800; High Speed 12p–6p @3,000.
  - This matters because `${id}:pool:applied.removed` is overwritten by each Autopilot re-apply, so the original schedule can't be recovered from it.
  - For each day since `applied.at`, the saving is baseline kWh minus the running plan's kWh at the measured pump curve, split into the overnight share (valued at the import rate) and the midday share (valued at the export credit).
- **Pool, cross-check:** the measured 1–5 AM average (`/api/overnight`) for 30 nights before vs after 2026-09-24. It is labelled "weather-confounded check", not "proof".
- **AC:** on approved pre-cool days, the heat-model residual (`acSlope × (high − 80) + intercept`) summed.
- **Storage:** no new table. `GET /api/savings` is computed and cached in kv `${id}:savings` for 6 h.
- **UI:** one line on each Appliances card ("Measured so far: N kWh · $X") and in the digest.
- **Acceptance:** `GET /api/savings` returns `pool.kwh > 0` since 2026-09-24, the model-based figure, and the overnight cross-check, each with its `method` string.

## M1. Server-side yield model and GTI archive [A `solar.ts` / B `model.ts` → `server/src/model.ts`]

- A port of `learnYield` from `web/src/lib/model.js`, plus the clear-day loss computation that `main.js` does in `computeModel`.
- Input: daily GTI from Open-Meteo `archive-api` with `tilt=27&azimuth=64`, cached per day in kv `wx:gti`.
- Needed by the `solar` push, the S1 hail check and the digest's `perfPct`.
- **Acceptance:** `yieldK` from the server matches `S.yieldK` in the app within 1% for the same 60 days.

## D1c. Weekly digest [A contents + B delivery]

```ts
// server/src/digest.ts
export type Digest = { week: string; from: string; to: string;
  totals: { solar: number; home: number; import: number; export: number; selfPct: number; vsLastWeek: Record<string, number>; vsSameWeekLastYear: Record<string, number> };
  money: { energyUsd: number; creditUsd: number; fixedUsd: number; noSolarUsd: number; mtdProjectedBill: number };
  powerwall: { fullDays: number; reserveHits: number; cyclesKwh: number; overnightLowPct: number; outages: Array<{ ts: string; minutes: number }> };
  solar: { perfPct: number | null; bestDay: { date: string; kwh: number }; clearDays: number; clippedBuckets: number; weakestPanel?: { serial: string; pct: number } };
  loads: { poolKwh: number; poolUsd: number; acKwh: number; acUsd: number; precoolDays: number; spaSessions: number; propaneGal: number; savedUsd: number };
  grid: { conservationHours: number; maxPriceUsdMwh: number; co2AvoidedKg: number };
  anomalies: string[]; records: string[];
  next: { sunKwhM2: number[]; highs: number[]; rainPct: number[]; precoolDays: number; poolHours: number[] };
  todo: Array<{ text: string; go: string }> };
export async function buildDigest(siteId: string, weekEnding: string): Promise<Digest>;
export function renderDigestHtml(d: Digest): string;   // inline CSS, Aurora colours, no external assets (email- and print-safe)
```

```sql
CREATE TABLE IF NOT EXISTS digests (site_id text NOT NULL, week text NOT NULL, data jsonb NOT NULL, html text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (site_id, week));
```

- **Schedule:** Monday 07:00 Central, `{ "path": "/api/cron/digest", "schedule": "0 12 * * 1" }`. This is B's timing: it runs after the 10:15 UTC nightly sync has closed Sunday. A's Sunday-evening digest would have missed Sunday night.
- **Routes (owner cookie):**
  - `GET /api/digest?week=`
  - `GET /api/digest/:week/html`, the same HTML as the email, which doubles as the print / "save as PDF" monthly one-pager from the roadmap. This avoids a new SPA route, since `vercel.json` only rewrites `/api` and `/auth`.
- **Delivery without accounts:**
  1. **In-app:** a "Your week" card at the top of Insights → Today, with a sheet for the full view.
  2. **Push:** `notify('digest')`, e.g. "Your week: 41% self-powered, 2 things to do".
  3. **Optional email via Resend** when `RESEND_API_KEY` and `DIGEST_EMAIL_TO` are set:
     - `POST https://api.resend.com/emails` with `{ from: 'Solstice <onboarding@resend.dev>', to, subject, html }`, header `Idempotency-Key: <week>`.
     - `onboarding@resend.dev` only delivers to the Resend account's own address. the owner creates that account himself; Claude does not create accounts.
- **Contents:**
  - CO₂ comes from the real ERCOT fuel mix (Z1).
  - Anomalies include "Tue used 18 kWh more than a 96° day usually does", "overnight baseline up 12%" and "PEC bill 6% above Tesla".
  - To-dos deep-link via `?go=`.
- **Privacy:** the digest holds dollar figures, so it lives only in the DB, the owner-gated routes and email. It is never in the repo.
- **Acceptance:** `GET /api/cron/digest` (cron secret) creates the `2026-W39` row; its totals equal `SUM` over `energy` for those 7 days; the card appears; one push arrives; and, if configured, one email with the same numbers.

## P1. Powerwall settings check and backup-reserve advisor (read-only, no new scope) [A + B risk ladder]

`sites.info` already holds `default_real_mode`, `backup_reserve_percent`, `components.customer_preferred_export_rule`, `components.disallow_charge_from_grid_with_solar_installed` and `user_settings.storm_mode_enabled`.

| Setting | Right answer for a flat-rate PEC member | Why |
|---|---|---|
| Operating mode | `self_consumption` | Time-Based Control gains nothing without TOU. With `battery_ok` it can export stored solar at the credit rate and buy it back at the import rate. |
| Export rule | `pv_only` | Same reason. |
| Grid charging | disallowed | There is no cheap window. |
| Storm Watch | enabled | Free insurance. |
| Reserve % | from the advisor | |

```ts
// server/src/powerwall.ts
export async function settingsCheck(siteId: string): Promise<Array<{ id: string; ok: boolean; current: string; suggested: string; why: string; kwhPerYear?: number }>>;
export async function reserveAdvisor(siteId: string, days = 60): Promise<{ current: number; recommended: number; reason: string;
  options: Array<{ reservePct: number; nightsAtReserve: number; kwhIdlePerYear: number; usdPerYear: number; backupHoursEvening: number }>; outages12mo: number; longestOutageH: number }>;
```

- **Calm baseline [A]:** for candidate reserves of 10/15/20/30%, count the nights in `soe` that reach the reserve.
  - Idle kWh per year = `nights × (current − candidate)/100 × capacityKwh × 365/days`, valued at the import rate.
  - Backup hours = `candidate × capacityKwh / evening load`, where the evening load is the `/api/profile` average for hours 18–07, not a fixed 4 kW.
- **Risk overlay [B]:**
  - 20% (or the calm pick) when nothing is active.
  - 50% when a Storm/Winter Watch is active for tomorrow.
  - 100% for a Warning tonight or ERCOT EEA ≥ 1.
  - Each comes with its reason.
- **Where it shows:** the "Backup reserve" row in Settings → Your system (today "Set in the Tesla app") gains the advice, plus a card in Insights → Home. Without `energy_cmds`, the card lists the Tesla-app steps.
- **Acceptance:** with a synthetic Tornado Watch for tonight, it recommends 100% with the watch as the reason. With nothing active, it recommends the calm option and shows no action.

## P2. `energy_cmds`: reserve, Storm Watch, mode, and Storm Guard (opt-in, Suggest-first) [A + B]

- **Scope:** add `energy_cmds` in the Tesla developer portal (~10 min to apply) and append it to `config.scopes`.
  - `authorizeUrl` already sends `prompt_missing_scopes=true`.
  - the owner re-consents once at `/auth/login` in his own browser; Claude never types Tesla credentials (rule 7).
  - `exchangeCode` replaces the tokens in place, so single-use refresh tokens stay consistent.
  - `tesla_accounts.scope` tells the UI whether commands are available.
- **Client:**

```ts
// server/src/tesla/client.ts (teslaFor additions; all energy commands are "not charged", 30/min)
post: <T>(path: string, body: unknown) => Promise<T>;
setReserve: (site: string, pct: number) => Promise<void>;        // POST /api/1/energy_sites/{id}/backup {backup_reserve_percent}
setStormMode: (site: string, enabled: boolean) => Promise<void>; // …/storm_mode {enabled}
setMode: (site: string, mode: 'self_consumption' | 'autonomous') => Promise<void>; // …/operation {default_real_mode}
setExportRule: (site: string, rule: 'pv_only' | 'battery_ok' | 'never', noGridCharge?: boolean) => Promise<void>; // …/grid_import_export
// server/src/powerwall.ts
export async function stormGuard(siteId: string, s: { nws: NwsAlert[]; ercot: Ercot; stormWatchOn: boolean; stormActive: boolean; soc: number; reservePct: number; solarKw: number },
  mode: 'off' | 'suggest' | 'auto'): Promise<{ action: 'raise' | 'restore' | 'none'; to?: number; why: string }>;
```

- **Routes (owner cookie):** `POST /api/powerwall/reserve {pct, revertAt?}`, `/storm-mode {enabled}`, `/mode {mode}`, `/export-rule`, `/guard {mode}`. Each refreshes `site_info` and logs an `events` row with `type='powerwall'`.
- **Storm Guard triggers:**
  - An NWS Warning: Severe Thunderstorm, Tornado, Winter Storm, Ice Storm, Extreme Cold or High Wind.
  - A Winter Storm Watch 24–48 h ahead.
  - ERCOT EEA ≥ 2.
  - **[B]** Storm Watch is on but `storm_mode_active` is still false 30 min into a Warning whose `ends` is ≥ 2 h away.
- **Storm Guard action:** raise the reserve to 100%, and store the previous value in kv `${id}:pw:revert`. The tick restores it 2 h after the later of the alert's `ends` and grid-stable.
- **Guardrails:**
  - Clamp 10–100.
  - Automatic writes ≤ 1 per hour; manual taps ≤ 1 per 5 min.
  - Never change the mode automatically.
  - **Never raise the reserve inside an ERCOT conservation window unless EEA ≥ 2** (judge): holding the batteries idle moves the house onto the grid at the worst hour.
  - Every rule stays Suggest until the owner flips that specific rule to Auto.
- **Acceptance:** with an injected NWS Warning fixture in kv, the card says "raise reserve to 100%", and in Suggest mode nothing is written until "Apply" is tapped. After Apply, `GET /api/site` shows `reservePct: 100` within a minute, and the revert fires after the fixture expires.

## S1. NWS-driven storm behaviour, hail baseline and winter playbook [A + B]

- **Endpoint:** `GET https://api.weather.gov/alerts/active?point=${SITE_LAT},${SITE_LON}`, server-side with `User-Agent: solstice/1.0 (${NWS_CONTACT ?? 'github.com/bmarshall511/solstice'})`.
- **Polling:** the tick polls it every 5 min, cached in kv `nws` and deduped by `id` in kv `nws:seen`.
- **Fields used:** `event`, `severity`, `urgency`, `certainty`, `messageType`, `onset`, `ends`, `expires`, `headline`, `description`, and `parameters.maxHailSize` / `maxWindGust` / `tornadoDetection`. When the parameter is missing, the hail size comes from `description` with `/(\d(?:\.\d+)?)\s*inch/`.

```ts
// server/src/nws.ts
export type NwsAlert = { id: string; event: string; severity: string; urgency: string; certainty: string; onset: string | null; ends: string | null; headline: string;
  hailIn: number | null; gustMph: number | null; tornado: string | null; kind: 'severe' | 'winter' | 'flood' | 'heat' | 'wind' | 'other'; messageType: 'Alert' | 'Update' | 'Cancel' };
export async function nwsActive(): Promise<NwsAlert[]>;
export async function nwsWatch(siteId: string): Promise<void>;   // in tick
export function stormPlan(a: NwsAlert, s: { stormWatch: boolean; stormActive: boolean; soc: number; reservePct: number; heatKw: number | null; freezeMode: boolean | null }): { steps: string[]; reserveTo?: number; hailBaseline: boolean };
```

1. **Severe or Extreme Warning:** `notify('nws')` with the headline and the Powerwall state ("Powerwalls 64% · Storm Watch on · Tesla has not started charging").
2. **Storm Watch off** (`summary().stormWatch === false`): offer "Turn Storm Watch on" (P2) or the Tesla-app steps.
3. **Top-up suggestion:** SOC < 80%, onset < 6 h away, and forecast solar can't close the gap. This goes to P1/P2.
4. **Hail baseline:** when `hailIn ≥ 1.0` or on a Tornado Warning, insert an `events` row with `type='hail_baseline'`, day = today and `note` = JSON `{ alertId, yieldK, clearDays: [...], perPanel?: { serial: kwhPerKwhM2 } }`, built from M1 and, if present, V1 `pvs_daily`.
   - After `ends + 1 day`, compare the first 3 clear days (GTI > 4.5 kWh/m²).
   - An array drop > 5%, or > 10% for any panel, triggers `notify('solar' | 'panel')` and a "Post-storm check" card on the Panels tab with before/after values and a nudge to photograph the roof for a claim.
   - `drawCleaning` shows the baseline line when one exists.
5. **Winter Storm / Ice Storm / Extreme Cold / Hard Freeze** (the Uri case): a "Winter storm playbook" card, pushed when the Watch is issued (24–48 h ahead):
   - Expected backup hours on strip heat (`learned.heatKw`) vs holding a lower setpoint. The advice differs when `heatKw < 5` (heat pump).
   - ScreenLogic `freezeMode`, read-only. The pump runs at the controller's freeze-protection speed (virtual circuit 132), with estimated kWh.
   - Reserve to 100% before onset.
6. **Heat Advisory:** handled by the existing AC pre-cool logic (`high ≥ 88`). Nothing new.
7. **Cancel or expiry:** a quiet "all clear" in-app card, no push.

- **Privacy:** lat/lon come from the `SITE_LAT`/`SITE_LON` env, as today.
- **Acceptance:** replaying a stored Severe Thunderstorm Warning with `maxHailSize: "1.75"` through `nwsWatch` creates one `hail_baseline` event and one `nws` alert; a second replay creates nothing.

## E1. ERCOT prices, grid level and day-ahead stress hours [A + B + judge]

Verified today, no key needed:
- **`system-wide-prices.json`**:
  - `rtSppData[]`: 15-min real-time SPP with `intervalEnding`, `timestamp`, `lzLcra`, `lzAen`, `hbHubAvg` … in $/MWh.
  - **`damSppData[]`**: day-ahead hourly prices for tomorrow (`hourEnding`, `lzLcra`, …).
- **`daily-prc.json`**: `current_condition.{state, title, condition_note, eea_level, prc_value}` plus the PRC series.
- **`supply-demand.json`**: already used.
- **`fuel-mix.json`**: see Z1.
- `todays-outlook.json` is Incapsula-blocked and unused.

The load zone defaults to `lzLcra`, is selectable in `settings.grid.zone`, and is unverified for PEC.

```ts
// server/src/ercot.ts (moves the inline /api/ercot route out of app.ts; same kv 'ercot' 5-min cache, last-good fallback)
export type Ercot = { at: string; condition: string; title: string; note: string; eea: number; prcMw: number | null; demandMw: number | null; capacityMw: number | null;
  price: { zone: string; nowUsdMwh: number | null; todayMaxUsdMwh: number | null; series: Array<{ t: string; usdMwh: number }>; tomorrowDam: Array<{ h: number; usdMwh: number }> };
  level: 'normal' | 'tight' | 'conservation' | 'eea1' | 'eea2' | 'eea3';
  window: { from: number; to: number; source: 'note' | 'dam' | 'default' } | null; tomorrowWindow: { from: number; to: number } | null; co2KgPerKwh: number | null };
export async function ercotNow(): Promise<Ercot>;
export async function ercotWatch(siteId: string): Promise<void>;   // level edge → notify('ercot'), kv 'ercot:level'
```

- **Level:**
  - `eea{n}` when `eea_level ≥ 1`.
  - Otherwise `conservation` when `state !== 'normal'`.
  - Otherwise `tight` when PRC < 3,000 MW or the zone price ≥ $500/MWh.
  - Otherwise `normal`.
- **Window**, in order of preference:
  1. Parsed from `condition_note` (e.g. "between 4 and 7 p.m.") **[A]**.
  2. From day-ahead prices: the contiguous hours in 13–22 where `lzLcra ≥ max(3 × the day's median, $150/MWh)` **[judge]**.
  3. `settings.grid.window`, default 16–20, while the level is not normal **[B]**.
- **`tomorrowWindow`** is computed from `damSppData` once it is published (≈13:30 CPT), so the 20:15 pool cron and the AC week preview see it.
- **Now tab:** the chip becomes "ERCOT normal · $41/MWh · 76% load". A "Grid is tight tonight" card appears only while the level is not normal, showing the window, Powerwall % and what Solstice is doing, plus one line: "PEC bills a flat rate; this is about grid stress, not your bill."
- **Acceptance:** `GET /api/ercot` returns `price.nowUsdMwh` equal to the latest `rtSppData.lzLcra` (19.7 at 09:45 today), and `tomorrowDam` has 24 entries after 14:00.

## E2. Conservation-window behaviour [A + B]

- **AC:** `planFor` in `server/src/appliances/ac.ts` gains `gridEvent?: { from: number; to: number; level: string }`. When `presence === 'home'` and it is not humid:
  - pre-cool to `max(band.homeLo, mid − precoolDepth)` from `max(11, from − 3)`;
  - coast at `min(coastF, band.homeHi)` from `from` to `to`;
  - then back to `mid`.
  - Steps stay ≤ `maxStepF` per tick. It runs even on cloudy days, because the ERCOT ask is itself the reason.
  - `acDetail` passes `ercotNow().window`; the week preview uses `tomorrowWindow`.
- **Pool [B]:** `planFor` in `pool.ts` gains `avoid?: number[]`. The contiguous-window search and `boostAt` skip those hours. This is threaded through `planDay` in `autopilot.ts` and applies to tomorrow's plan only; today's applied schedule is never rewritten.
- **Powerwall:**
  - **Conservation without EEA:** no reserve change. The card says "Powerwalls will carry ~X kWh of the 4–7 PM window", from `forecast48`.
  - **EEA ≥ 1:** suggest a higher reserve before the window, on solar (P1; one tap with P2).
  - **EEA 3:** a push, since rotating outages are possible.
- **Acceptance:** with kv `ercot` forced to `level: 'conservation'` and `window: {from: 16, to: 19}`, `GET /api/appliances/ac` shows a pre-cool step at 13:00 and a coast step at 16:00, the chip turns amber, and tomorrow's pool plan has no hour in 16–19.

## A1. Presence without accounts [A precedence + B per-person]

Sources are resolved in `server/src/appliances/presence.ts`, in this order:
1. The latest explicit event (manual button, or webhook with every `who` away) wins until `awayUntil` or the next schedule boundary.
2. Otherwise a schedule rule.
3. Otherwise Nest eco, if enabled.
4. Otherwise `home`.

```ts
export type PresenceSource = 'manual' | 'shortcut' | 'schedule' | 'nest-eco' | 'default';
export function resolvePresence(s: AcSettings & { schedule?: Array<{ days: number[]; from: number; to: number; presence: 'home' | 'away' }>; awayUntil?: number; useNestEco?: boolean },
  events: { manual?: { state: 'home' | 'away'; at: number; until?: number }; who: Record<string, { state: 'home' | 'away'; at: number }> }, nest: NestState | null, now: Date):
  { presence: 'home' | 'away'; source: PresenceSource; since: number; until?: number };
```

1. **iPhone Shortcuts webhook:**
   - Setup: a personal automation for "When I Leave" / "When I Arrive", set to Run Immediately (iOS 17+; a banner still shows), using the action "Get Contents of URL".
   - Request: `POST /api/hook/presence` with header `Authorization: Bearer <PRESENCE_HOOK_TOKEN>` and body `{"who":"phone1","state":"away"}`. Use neutral labels, no names in git or docs.
   - Why not HMAC: Shortcuts has no HMAC action, so the "signature" is a 32-byte capability token that exists only in env and in the Shortcut. HTTPS protects it in transit. A SHA-256 timestamped variant is possible with "Generate Hash" but is not worth the Shortcut complexity.
   - Server: accepts only `home|away`; `who` must match `/^[a-z0-9-]{1,16}$/`; rate-limited to 30/h via kv; logs to `${id}:ac:log`; stores kv `${id}:presence`.
   - Presence becomes away only when every known `who` is away.
2. **Nest eco as a proxy (opt-in [B]):**
   - `NestState.eco` (`MANUAL_ECO`, already read every 5 min) maps to away.
   - Off by default, because a manual Eco tap would also read as away.
   - While eco is on, `acTick` skips setpoint writes, which SDM rejects in Eco.
3. **Leaving button with a return time [A]:** the existing Home/Away seg (`POST /api/appliances/ac/settings {presence}`) gains "Away until 6 PM" (`awayUntil`), so a forgotten button never leaves the house hot.
4. **Time-of-day rules:** `settings.ac.schedule`, edited in a small sheet on the AC card.

- **Display:** `acDetail` returns `presence: {state, source, since, until}` so the card can say why it thinks the house is empty.
- **Rule 4:** the only resulting write is the away setpoint the AC plan already makes, and still only when the plan is approved or Autopilot is Auto.
- **Setup doc:** the Shortcut recipe goes in `docs/presence.md`, with screens and no secrets.
- **Acceptance:** `curl -X POST …/api/hook/presence -H 'Authorization: Bearer …' -d '{"who":"phone1","state":"away"}'` makes `GET /api/appliances/ac` return `presence.state: 'away', source: 'shortcut'` within one tick. A wrong token returns 401.

## V1. SunPower PVS per-panel relay and ingest [A access path + B relay/security + judge]

**What the PVS provides:** for each of the 30 SPR-E19-320-AC modules, reported through its IQ7XS:
- `pMppt1Kw`, `ltea3phsumKwh` (lifetime AC kWh), `vMppt1V`, `iMppt1A`, `tHtsnkDegc` and a state;
- production and consumption meters at `/sys/devices/11|12/meter/data`, if CTs exist.

Tesla only sees the array total, so this is the only route to a weak or dead panel, hail damage and per-panel degradation.

**Access (verified in SunStrong's `pypvs` `doc/LocalAPI.md` today):**
- The LocalAPI "is available on the PVS Ethernet and Wi-Fi interfaces" on **PVS6 build ≥ 61840**. For current firmware the relay therefore reaches the PVS at its **home-LAN IP with no extra hardware** [A].
- Login: `GET https://<pvs>/auth?login` with `Authorization: Basic base64("ssm_owner:" + last 5 of serial)`, which returns `{"session": …}` and a cookie.
- Data: `GET /vars?match=/sys/devices&fmt=obj` once, then the same query with a `cache=` id, as SunStrong recommends. Query no faster than every few seconds; we need one per 5 min.
- PVS5 support is "coming soon" per the doc (unverified).
- **Legacy firmware only:** unauthenticated `http://172.27.153.1/cgi-bin/dl_cgi?Command=DeviceList` on the installer port. That needs a USB-Ethernet adapter from the Mac, or a Pi / travel router at the PVS [B]. Never bridge that port into the home LAN, because it runs its own DHCP [A].

**Relay (push only, no tunnel [B]):**

```
scripts/pvs-relay.mjs                         # Node 22, zero deps, in git with no secrets
scripts/com.solstice.pvs-relay.plist.example  # ~/Library/LaunchAgents, StartInterval 300, StandardErrorPath ~/Library/Logs/solstice/
~/.solstice/relay.env                         # outside the repo: PVS_HOST, PVS_SERIAL_SUFFIX, PVS_CERT_SHA256, SOLSTICE_URL, INGEST_TOKEN
```

- Tries the LocalAPI first, then the legacy `dl_cgi`, and reports which answered.
- TLS verification is disabled **only** for the PVS request (`node:https`, `rejectUnauthorized: false`). The self-signed certificate's SHA-256 is pinned on first contact (`PVS_CERT_SHA256`) [judge]. The POST to Vercel keeps full TLS.
- **GET-only:** the relay never calls `vars?set=` [judge].
- Payload: `{ at, pvs: { swRev }, meters: {prodKw, prodKwhLife, consKw?, consKwhLife?} | null, inverters: [{ serial, kw, kwhLife, v, a, tempC, state }] }`.
- launchd does not run while the Mac sleeps. If this Mac sleeps, the same script runs on a Pi Zero 2 W (owner question).

**Server:**

```ts
// server/src/pvs.ts
app.post('/api/ingest/pvs', requireBearer('INGEST_TOKEN'), express.json({ limit: '256kb' }), …); // ≤ 40 inverters, |at − now| ≤ 15 min, ≥ 60 s since last sample
export async function ingestPvs(siteId: string, body: PvsPayload): Promise<{ inverters: number }>;
export async function pvsDetail(siteId: string): Promise<{ at: number; swRev: string; panels: Array<{ serial: string; pos: [row: number, col: number] | null; kw: number; kwhToday: number; kwhLife: number; tempC: number; state: string; ratioToMedian: number | null }>; array: { kw: number; todayKwh: number; medianKwh: number }; weakest: { serial: string; pct: number } | null; health: string[] }>;  // GET /api/pvs
export async function pvsHealth(siteId: string): Promise<void>;   // in tick
```

```sql
CREATE TABLE IF NOT EXISTS pvs_samples (site_id text NOT NULL, ts bigint NOT NULL, inverters jsonb NOT NULL, meters jsonb, PRIMARY KEY (site_id, ts));  -- 7-day retention, pruned in /api/cron/sync
CREATE TABLE IF NOT EXISTS pvs_daily (site_id text NOT NULL, serial text NOT NULL, day text NOT NULL, kwh real NOT NULL, peak_kw real, max_temp_c real, PRIMARY KEY (site_id, serial, day));  -- forever
```

- **Storage choice:** one jsonb row per sample (288/day, 7 days) plus a per-day rollup (~11k rows/yr). This replaces A's four tables and B's 30-rows-per-sample table (~8.6k rows/day).
- **Daily energy:** `pvs_daily.kwh` = today's latest `kwhLife` minus the first `kwhLife` seen today. This is cumulative, so gaps while the Mac sleeps don't corrupt it.
- **kv:** `pvs:last` holds the latest snapshot. `pvs:layout` (serial → roof position) and `pvs:inverters` (first/last seen) live in the DB only, never in git.
- **Health:**
  - Relay silent for > 60 min during daylight → `notify('panel')`.
  - Outlier: a panel below 92% of the array-median kWh on 3 clear days.
  - Dead: state not working, or 0 kWh on a day with GTI > 3 kWh/m².
  - Both raise `notify('panel')` and a Panels card.
  - Per-panel lifetime kWh per year is tracked against SunPower's 0.25%/yr floor.
- **Acceptance:** `curl -H "Authorization: Bearer …" -d @fixture.json …/api/ingest/pvs` returns 200 and `GET /api/pvs` returns 30 panels. Zeroing one inverter in the fixture for 3 clear "days" raises one `panel` alert.

## V2. Per-panel UI [B grid + A roof]

- **Panels tab, "Per panel · live" card:** a 3 × 10 grid that mirrors `scenes/home.js` (3 rows up the slope × 10 along the ridge).
  - Each cell shows today's kWh, coloured by its ratio to the array median.
  - Tap a cell for the panel's day curve, lifetime kWh and heat-sink temperature.
  - Includes a "Weakest panel" line.
- **Roof scene:** `home.js` line 48 shares one `panelMat` across all 30 meshes.
  - Give each mesh `panelMat.clone()`.
  - In `sun` mode, drive `emissiveIntensity` from `S.pvs.panels[i].kw / 0.315` (the per-module AC cap) when present; otherwise fall back to the array ratio as today.
  - No new objects: the roof stays minimal per CLAUDE.md.
- **Layout mapping:** a one-time sheet in Settings maps serials to roof positions and writes kv `pvs:layout`.
- **Temperature:** the measured heat-sink temperature replaces the NOCT guess in the cell-temperature correction.
- **Copy:** the "About panel-level data" card changes from "system-level" to "measured".
- **Acceptance:** within 5 minutes of a relay run in daylight, the grid shows 30 filled cells and the roof glow varies per panel.

## X1. Spa sessions and propane [A + B]

- `ALTER TABLE pool_readings ADD COLUMN IF NOT EXISTS heating boolean`, filled from `snap.bodies[1].heating` in `recordReading`.
- `spaSessions(siteId, days)` derives sessions from consecutive 15-min tick readings where the spa circuit is on and/or the heater is heating. Each session has start, end, heater minutes, rise, propane gallons (the existing `spaSession` maths: `btu / .82 / 91,500`) and electric cost (`W(spaRpm) + blower`). There is no new table; results are cached in kv.
- Propane fills are logged like cleanings: an `events` row with `type='propane_fill'` and `note` = `{gal, usd}`. This lets `propaneUsdPerGal` be learned instead of using the $3.00 default.
- The pool card gets a "Spa · last 30 days" row, and the digest includes it.
- **Acceptance:** a heating spa reading followed 40 minutes later by a non-heating one yields one session with a non-zero propane estimate in `GET /api/appliances/pool`.

## EV1. EV readiness (built dormant; observe only) [A + B]

- **Wall Connector (free, existing `energy_device_data` scope):**
  - Data sources: `site_info.components.wall_connectors[]`, `live_status.wall_connectors[].{din, wall_connector_state, wall_connector_fault_state, wall_connector_power}`, and `GET …/telemetry_history?kind=charge&start_date&end_date&time_zone`, which returns `charge_history[].{charge_start_time.seconds, charge_duration.seconds, energy_added_wh}`.
  - Storage: `refreshLive` stores the power with `ALTER TABLE readings ADD COLUMN IF NOT EXISTS ev_w real`.
  - A plugin in `server/src/appliances/ev.ts`, registered in `appliances/index.ts`, adds a "Charging" appliance with:
    - a live kW pill;
    - sessions, cached in kv;
    - **charged from sunshine** = per 5-min bucket `min(ev, max(0, solar − (home − ev)))`;
    - cost per session;
    - a "best charge window" line on the 48-hour card;
    - `off_grid_vehicle_charging_reserve` shown from `site_info`.
- **Vehicle:**
  - `vehicle_device_data` data calls are billed: 500 per $1 against the $10/month credit. Read `charge_state` only while the Wall Connector reports charging, and never wake the car (a sleeping car returns 408).
  - No vehicle commands. Control needs `vehicle_cmds`, a virtual key and Tesla's signed-command proxy, which is a long-running service that doesn't fit one Vercel function.
  - Tesla's own *Charge on Solar* already does solar-following for a Powerwall household; Solstice verifies it.
- **Acceptance:** with a `wall_connectors` entry in a `site_info` fixture, `GET /api/appliances` lists `ev` as linked and `GET /api/now` includes `ev: {state, kw}`. Without one, nothing changes.

## Z1. Small extras that earn a line [A + B]

- **Grid carbon [B formula]:** from `fuel-mix.json`, intensity = `Σ gen_f × ef_f / Σ gen`.
  - Factors: gas 0.41, coal + lignite 1.0, other 0.5 t CO₂/MWh; wind, solar, nuclear, hydro and storage 0.
  - Cached with the ERCOT snapshot.
  - Replaces the fixed `.37` in Records (`history.js` line 103) and the digest.
  - Per bucket: `export_wh × intensity` is CO₂ displaced.
  - Acceptance: noon intensity on a sunny day < 21:00 intensity the same day.
- **Rain rules [B, corrected; A's "skip the boost when > 20 mm" is dropped as the wrong direction]:**
  - Add `hourly=precipitation` to `forecast()` and place the skim boost after the forecast rain ends.
  - ≥ 5 mm of observed rain logs an `events` row with `type='rain_wash'`, and `drawCleaning` starts its dust window from it, the way it does from a cleaning.
  - Acceptance: with 8 mm forecast at 14:00 tomorrow, `boostAt ≥ 16`.
- **Clipping count [A]:** counts 5-min buckets with `solar_wh × 12 / 1000 ≥ 9.3 kW`, labelled approximate because single buckets read inflated. Shown in the digest and as a Panels roadmap item.

## 12. Cron and function budget after this design

| Cron | Schedule (UTC) | Work |
|---|---|---|
| `/api/cron/sync` | `15 10 * * *` | Unchanged, plus pruning `pvs_samples` older than 7 days. |
| `/api/cron/pool` | `15 1 * * *` | Unchanged; E2 `avoid` hours are applied through `planDay`. |
| `/api/cron/tick` | `*/5 * * * *` | Replaces `/api/cron/nest` (kept as an alias): live/outage, acTick, NWS, ERCOT, pool read every 15 min, PVS health, approvals, Storm Guard, daily 07:00 checks. |
| `/api/cron/digest` | `0 12 * * 1` | The weekly digest. |

**Incremental cost ≈ $0 on the current Pro plan:**
- Invocations stay at today's 5-minute rate, plus ~8.6k PVS ingests per month.
- Neon compute is already kept warm by the 5-minute cron.
- All Tesla energy endpoints are free.
- NWS, ERCOT and Open-Meteo need no key.
- Resend is on its free tier.
- The only new dependency is `web-push`.

**New env vars:** `OWNER_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `INGEST_TOKEN`, `PRESENCE_HOOK_TOKEN`, `NWS_CONTACT`, and optionally `RESEND_API_KEY` and `DIGEST_EMAIL_TO`.

## 13. What was dropped and why

- **B's per-minute `/api/cron/watch`:** 5× the invocations. Its main gain is outage latency, and Tesla already pushes outages. The 5-minute tick is enough.
- **B's `OWNER_KEY` in `localStorage` sent as a header:** readable by any XSS. Replaced by an HttpOnly HMAC cookie. A's `GET /auth/owner?key=` was replaced by POST so the key stays out of logs.
- **A's claim that pool `force` places hours:** false. Replaced by B's `avoid?: number[]` parameter.
- **A's rain skip:** wrong direction.
- **A's Sunday-evening digest:** Sunday wasn't synced yet.
- **A's `pvs_inverters` / `pvs_samples` / `pvs_hourly` / `pvs_daily` set and B's `pvs_readings`:** replaced by the lighter `pvs_samples(jsonb)` + `pvs_daily`.
- **A's `spa_sessions` and `savings` tables:** now derived and cached.
- **B's "USB-Ethernet to the installer port" as the default path:** outdated for current firmware; kept only as the legacy fallback.
- **TOU-aware reserve arbitrage:** PEC is flat-rate. Revisit only if the owner moves to a TOU or demand-response plan.
- **Vehicle commands:** a signed-command proxy doesn't fit one function, and Tesla's Charge on Solar covers it.
- **The registered ERCOT Public API:** not needed; the dashboards suffice.
- **Candidates' personal dollar estimates:** rule 5 hygiene. This doc keeps kWh and public tariff rates, and runtime code computes dollars from the DB.
- **`who: "<owner name>"` in docs:** rule 5 (no name in git).
- **Mockup names `j-*`:** they collide with the existing `mockups/j-ui-fixes.html`.

## 14. Mockups (rule 2) and build batches (rules 1 and 6)

**Mockups, each linking `../web/src/style.css` and checked at 393 px before any build:**
- `mockups/k-alerts-push.html`: alerts feed, Settings → Alerts new rows and push switch, "Pair this device".
- `mockups/l-money-digest.html`: the Yesterday row, the "Measured so far" lines, the digest card and the print/email page.
- `mockups/m-grid-storm.html`: ERCOT chip and card, storm, winter and post-storm cards, the settings check and reserve advisor.
- `mockups/n-panels-pvs.html`: the 3×10 grid, per-panel roof glow and the layout sheet.
- `mockups/o-presence.html`: AC card presence source, "away until" and the schedule sheet.

EV1 gets no mockup until hardware exists.

**Build batches, each on a branch with a Vercel preview and verified on the preview URL (crons invoked manually there):**
1. F0, N0, N1, N2, D1a.
2. M1, D1b, D1c, E1, S1.
3. P1, E2, A1, X1, Z1.
4. V1 and V2 (after the PVS/relay answer), and P2 (after the owner re-consents with `energy_cmds`).
5. EV1, only if a Wall Connector or vehicle appears in `products`.
