# Share view: final design (judge merge of candidates A and B)

Phase 1, read-only. Nothing here has been built. Every visual item waits for an explicit approval of `mockups/k-share.html` (rule 2). Phase 2 happens on a branch with preview deploys (rule 6).

## Verdict

| Criterion (1–5) | A: privacy-engineering | B: guest experience + Frost | Notes from checking the code |
|---|---|---|---|
| Fit to codebase | 4 | 3.5 | A's line citations are accurate (`auth.ts:46` requireUser, `app.ts:79` /auth/login, `app.ts:134` `app.use('/api', requireUser)`, `app.ts:245` /api/site, rate fallbacks at `app.ts:258,290,326`, `util.js:20`, `index.html:346`, `sw.js:7`). B's are accurate as well (`sync.ts:88`, `weather.js:3`, `index.html:46`). B is wrong about one thing: it says purple `--grid` (#c4a2ff) is "not tied to a live energy flow", but `--grid` **is** the grid-flow colour (`style.css:4`). Both candidates missed three things. (1) `S.preview` already exists as the *outage* preview (`main.js:20,103,128`). (2) There is no `body.calm` class, because calm lives only in `S.calm`. (3) `/api/cron/pool` and `/api/cron/nest` are mounted *after* `app.use('/api', requireUser)`, so a blanket anonymous guard would 401 the crons. |
| Owner value | 4 | 4.5 | B lets guests keep today's kWh fresh (guest `POST /api/sync`) and has richer UI (locked cards that keep their height, a wipe from the switch, one explanation toast). |
| Simplicity | 3 | 4 | A adds a device-pairing flow. B uses a kv array for owner devices, which can race. The merge keeps A's single table and drops pairing. |
| Serverless cost | 4 | 4 | Both add one indexed lookup per request. A's "bump `last_used_at` at most every 5 min" avoids a write on every request. |
| Privacy | 5 | 3.5 | B has three weaknesses. (1) `GET /auth/owner?key=` puts the owner secret in Vercel request logs. (2) `/auth/share/:token` is logged, and iMessage/Slack unfurlers GET it, which redeems the link and inflates `uses`. (3) It keeps the AC log that says "marked away". A uses URL fragments (never logged, never unfurled), forces presence at the source, and makes `fresh` owner-only. |
| Risk | 4 | 3.5 | Both would break the client in places. A drops `ac.log`, but `ac.js:81` calls `d.log.slice`. A drops pool `snapshot.*`, but the flow twin reads `d.snapshot` (`appliances.js:26`). A drops `health.errors[*].message`, but `insights.js:100` calls `e.message.slice`. B turns error strings into booleans, but `appliances.js:40` prints `d.error`. B also uses 403 as its "role changed" signal, which misfires on every ordinary owner-only 403. The merge adds a shape-preserving rule for all of these (§3.3). |
| **Total** | **24** | **23** | **A wins on structure and the server model. B supplies the UI language and several server refinements.** |

## 0. Code facts that shape the design (verified in this audit)

| # | Fact | Where | Consequence |
|---|---|---|---|
| F1 | In single mode `requireUser` attaches the first site to every request with no check. Every `/api/*` route, including every write, is open. | `auth.ts:46-51`, `app.ts:134` | Anonymous must become "nothing" **in the same build** that adds guests. Otherwise a guest just deletes the cookie. |
| F2 | `GET /auth/login` issues `signState(0)` to anyone, and `/auth/callback` → `exchangeCode(code, null)` **updates** the `user_id IS NULL` Tesla row. `GET /auth/google` does the same for Nest (`nestExchangeCode`). | `app.ts:79-102,402-407`, `tesla/auth.ts:18-24` | A stranger can re-point the app at their own Tesla or Nest account. Both flows become owner-only, and so do their callbacks. |
| F3 | `/api/auth/me` returns `site.id` (Tesla energy_site_id) and `site.name`. No client code reads `site.id`: `main.js:252,256` only test whether `me.site` is truthy. | `app.ts:30-33` | Drop `site.id` for every role. |
| F4 | `/api/site` returns raw `site_info` (DINs, serials, gateway id, firmware). Only the raw drawer (`openRawData`, key `d`) uses it. | `app.ts:245`, `settings.js:29-36`, `main.js:125` | Owner-only endpoint. Disable the `d` shortcut for guests. |
| F5 | Tesla error strings embed `/api/1/energy_sites/<id>/…`. ScreenLogic errors embed the Pentair system name. These surface in `/api/now.health.liveError`, `health.errors[k].message`, pool/AC `error`, and the global error handler `res.status(500).json({error: err.message})`. | `tesla/client.ts:20`, `screenlogic.ts:22`, `app.ts:417-420` | Guests get fixed generic strings, never messages. |
| F6 | The owner's PEC rates are hard-coded as fallbacks on the server (`app.ts:258,290,326`) and on the client (`?? <rate>` / `?? <credit>` in `now.js:107,111`, `history.js:26,50`, `panels.js:61`, `insights.js`). `S.tariff` comes from `reconcile.at(-1).tariff` (`history.js:151`). | client and server | Nulling the tariff on the server is not enough, because the client would recompute dollars from its built-in rate. Guest mode must remove the client fallbacks. |
| F7 | ZIP "[ZIP]" is literal copy (`index.html:346`). `LAT/LON` are 2-decimal constants (`util.js:20`) and are baked into `weather.js:3` `base` at module load. The server already reads `SITE_LAT`/`SITE_LON` env (`app.ts` `acSlope`). | bundle | Anyone who loads the shell gets these values, and they are already in the public repo. Only item share-S11 can reduce this. |
| F8 | AC `presence` drives plan text ("Away: holding N° until you mark Home", `ac.ts:59`) and the log ("Set N° (marked away)", `ac.ts:111`). | `appliances/ac.ts` | Occupancy is the most sensitive physical-security signal the app has. It must be scrubbed at the source. |
| F9 | `?fresh=1` on pool and AC forces a device read. Nest SDM allows about 5 queries/min/project, and the 5-minute cron needs its share. | `app.ts:328,380` | `fresh` is owner-only. |
| F10 | The SW caches only the shell and skips `/api` and `/auth` (`sw.js:7`). Cookies are read by hand (`readCookie`, not exported). `SESSION_SECRET` is already required. The `login_attempts` table exists and is unused in single mode (`db.ts:42`). `trust proxy` is on. | `auth.ts`, `sw.js` | Everything needed is already present. Export `readCookie` and `secure` from `auth.ts`. |
| F11 | `S.preview` is taken (outage preview). Calm mode is `S.calm` only, with no DOM class. A global `prefers-reduced-motion` rule already exists (`style.css:212`). | `main.js:20,126,128` | Guest preview uses `S.asGuest` and `html[data-as=guest]`. Calm gets a new `html[data-calm]` attribute, toggled where `S.calm` changes. |
| F12 | `/api/cron/pool` and `/api/cron/nest` are defined after `app.use('/api', requireUser)`. Both use bearer auth and send no cookies. | `app.ts:134,346,392` | Guards exempt `^/api/cron/` and `/api/admin/import` explicitly. |
| F13 | The client relies on response shapes: `d.log.slice` (`ac.js:81`), `a.log.slice` (`appliances.js:113,125`), `d.snapshot` (flow twin, `appliances.js:26`), `d.applied` (`ac.js:66`, `appliances.js:95`), `e.message.slice` (`insights.js:100`), `d.error` printed (`appliances.js:40`). | views | Redaction must preserve types (§3.3). |
| F14 | `main.js:259` already does `api.settings().catch(() => ({}))`. `api.js` treats 401 as "show the MULTI_USER login form". | `main.js`, `api.js:6` | The 401 path must be re-pointed to the locked/revoked card. |

## 1. Sensitivity inventory

### 1.1 Classes and the two rules

| Class | Server behaviour for guests | UI |
|---|---|---|
| **OWNER-ONLY** | Endpoint 401/403, or the key is dropped or replaced by a generic value. No marker, so a guest never learns the field exists. | Not rendered |
| **GUEST-BLURRED** | Leaf value → `null`, and the parent object gets `redacted: [key, …]` | Frost veil in the same slot (§4) |
| **GUEST-OK** | Passed through | Same as the owner sees |

**Money rule (A and B agree): guests see energy, never dollars about this home.** Every `$` in the UI is `kWh × rate`, and `rate × kWh` reconstructs the bill, so the **tariff itself is GUEST-BLURRED**. With no rate on the client, no dollar figure can be derived. The only exceptions are the planner's generic hardware constants ($/W and per-Powerwall cost in `/api/whatif.assumptions`). They are literals in the public repo and say nothing about this home. Owner question Q1 can relax this rule.

**Identifier rule (A):** OWNER-ONLY covers anything Tesla, Pentair, Google or PEC could use to look up the account: site id, gateway id, DIN, serials, Nest device path (which embeds `NEST_PROJECT_ID`), ScreenLogic system name, utility account, meter registers and free-text notes. It also covers occupancy (`presence`, "away" text).

### 1.2 The static bundle (public to everyone, already in the public repo)

| Item | Where | Class | Decision |
|---|---|---|---|
| `LAT [lat], LON [lon]` (≈1 km cell) | `util.js:20`, `weather.js:3` | residual | share-S11 (Q5): `/api/now.site.geo` supplies the pair per role (owner 2-dec, guest 1-dec ≈ 11 km, which moves the sun position by < 0.05°) and the constants leave the bundle. |
| "[ZIP] · tilt 27° · facing 244°" | `index.html:346` | OWNER-ONLY | Copy becomes "tilt 27° · facing 244°" for **everyone** (the ZIP adds nothing to the owner's own view). |
| Roof geometry traced from satellite | `scenes/home.js` | residual | Kept (approved design, already in git). Residual risk: roof shape plus a 1 km cell. That exposure lives in the repo and cannot be fixed by the guest view. |
| Equipment strings (panels, IntelliFlo, Quad D.E. 80, gallons, air handler) | `system.ts`, `ac.ts`, `appliances.js:51` | GUEST-OK | Not identifying, already public. |
| Side-panel copy "Private to your account. Press D for raw data." | `index.html:46` | copy | Guests see "Shared view · live data yes, money no." |
| Settings header "Solstice · local on your Mac" | `index.html:343` | copy | Guests see "Shared by {ownerName} · link expires Oct 25". The owner's copy is unchanged (rule 3). |

### 1.3 Endpoints

Roles: **A** anonymous (no valid cookie), **G** guest (valid `solstice_guest`), **O** owner (valid `solstice_owner`). A "—" means 401 (anonymous) or 403 (guest).

| Endpoint | A | G | O | Guest treatment |
|---|---|---|---|---|
| `GET /api/auth/me` | role only | redacted | ✓ | §2.6. `site.id` is gone for all roles. |
| `POST /api/auth/redeem` (new) | ✓ | ✓ | ✓ | Share token → guest cookie. Rate-limited. |
| `POST /api/auth/owner` (new) | ✓ | ✓ | ✓ | `OWNER_KEY` → owner cookie. Rate-limited. |
| `POST /api/auth/logout` | — | ✓ | ✓ | Clears whichever cookie is present. Owner: revokes this device's row. |
| `POST /api/auth/setup`, `signup`, `login` | 404 in single mode | | | Dead `MULTI_USER` paths. The branch itself is untouched. |
| `GET /auth/login`, `/auth/callback`, `/auth/google`, `/auth/google/callback` | — | — | ✓ | F2. `SameSite=Lax` cookies ride the top-level OAuth redirects. |
| `GET /api/cron/*`, `POST /api/admin/import` | bearer | bearer | bearer | Explicitly exempt from cookie guards (F12). |
| `GET /api/settings` | — | `{}` | ✓ | From B. Holds `system.priceUsd/loan*/taxCreditPct`, alerts, `ac.presence`. `{}` avoids a spurious error, since boot already tolerates it (F14). |
| `PUT /api/settings` | — | — | ✓ | Guests keep calm mode in `localStorage`. |
| `GET /api/now` | — | redacted | ✓ | `site.name` → `'Home'` (at source; Tesla site names are often "<Family> Home"). `site.firmware` dropped. `health.liveError` → `'unavailable'` or null. `health.errors[k]` → `{at, message:'unavailable'}` (shape kept for `insights.js:100`). `site.geo` coarse (share-S11). |
| `POST /api/sync` | — | ✓ (budget 4000 ms) | ✓ (8000 ms) | From B. This is a freshness trigger, not a control. Tesla calls stay bounded by `due('lastHistory', 4 min)` (`sync.ts:88`), the 25 s live cache and the 1 h backups throttle. Without it, a guest's "today" would be stale whenever the owner isn't using the app (the sync cron is nightly). |
| `GET /api/status` | — | redacted | ✓ | Drop `siteId`. |
| `GET /api/day, daily, monthly, profile, grid-days, overnight, records, outages` | — | ✓ | ✓ | kWh, %, timestamps. History depth for guests is Q3. |
| `GET /api/site` | — | — | ✓ | Raw `site_info` (F4). |
| `GET /api/bills` | — | — | ✓ | Charges, totals, meter registers, `comparison.lastYearCost`. |
| `GET /api/reconcile` | — | skeleton | ✓ | Built at the source (§3.4). Keeps `billDate, period, pec.{deliveredKwh,receivedKwh,lastYearKwh}, tesla.*, lastYear.*, coverage, importGapPct, solarShareOfHome, checks[].{id,ok,label}`. `checks[].detail` → `label` when it contains `$` (from B; the "math" check quotes the total). `total, tariff, withoutSolarCost` → null + `redacted`. `charges` → `[]`. Whether bills appear at all is Q2. |
| `POST /api/bills/parse`, `POST /api/bills`, `DELETE /api/bills/:date` | — | — | ✓ | |
| `GET /api/events` | — | filtered | ✓ | From A. `WHERE type IN ('cleaned','filter_cleaned')`. `note` dropped. `note` events never reach guests. |
| `POST /api/events`, `DELETE /api/events/:id` | — | — | ✓ | |
| `GET /api/ercot` | — | ✓ | ✓ | Public data, but not an open proxy for anonymous. |
| `GET /api/whatif` | — | redacted | ✓ | `system` dropped (the real price, net, loan payment, payback). `assumptions.tariff`, `baseline/upgraded/noSystem.netCost`, `savesPerYear`, `paybackYears` → null + `redacted`. Keeps `cost`, generic `assumptions.{panelW,dollarsPerW,powerwallCost}`, all kWh/%/days, `backupHoursEvening`. |
| `GET /api/appliances` | — | redacted | ✓ | `[].savesPerMonth` → null + `redacted`. `[].error` → `'unavailable'`. |
| `GET /api/appliances/pool` | — | redacted, `fresh` ignored | ✓ | Null + `redacted`: `rate, todayCost, current.costPerMonth, plan.costPerMonth, seasons[].costPerMonth, spaSession.propaneUsd, spaSession.electricUsdPerHour, settings.propaneUsdPerGal`. Drop `snapshot.version`. `error` → `'Couldn't reach the pool controller.'`. **Keep** `snapshot` (flow twin), `applied`, `autopilot.*`, `log` (the pool log has no occupancy text), `spaSession` minutes/gallons/°F. |
| `POST /api/appliances/pool/{apply,apply-tomorrow,autopilot,restore}` | — | — | ✓ | |
| `GET /api/appliances/ac` | — | redacted at source, `fresh` ignored | ✓ | From A. Computed with `presence` forced to `'home'`, so `plan`, `steps`, `why`, `currentStep` and `week` carry no occupancy. Then `settings.presence` → null, `state.deviceId` dropped, `state.name` → `'Thermostat'` (B), `log` **filtered** to entries whose text does not match `/away|home/i` (it stays an array, see F13), `error` → `'unavailable'`, `plan.costSavedMonth` → null + `redacted`. Keeps twin, stats, learned kW, band, steps, week, `applied`. |
| `POST /api/appliances/ac/{apply,settings}` | — | — | ✓ | |
| `GET /api/export.csv` | — | — | ✓ | 437 days × 288 five-minute rows is a complete occupancy record. |
| `GET/POST/DELETE /api/shares…`, `GET/DELETE /api/devices…` (new) | — | — | ✓ | §2.5 |
| Static `/`, `/assets/*`, `/sw.js`, `/manifest.webmanifest`, `/icon.svg`, `/.well-known/appspecific/com.tesla.3p.public-key.pem` | ✓ | ✓ | ✓ | The shell carries copy only, no data. |

Secure by default: (a) any non-GET/HEAD under `/api` is owner-only unless it is on a four-entry exception list (§3.2). (b) A guest GET to a path not in `GUEST_GET` is 403 **before the handler runs** (B's deny-by-default, moved in front of the handler so it has no side effects). A future route can therefore never leak by omission.

### 1.4 Rendered fields, tab by tab

| Tab / card | GUEST-OK | GUEST-BLURRED (veil) | OWNER-ONLY (not rendered) |
|---|---|---|---|
| Now: header, chips | greeting, siteLine "{ownerName}'s home" (or "Home"), sync time, gateway/NWS/ERCOT/Storm chips, weather, **guest chip** | | |
| Now: orb, story, energy-flow house | all kW / % / direction | | |
| Now: next 48 hours | curves, "full by", kWh to buy | "(≈ $N)" in the sentence (`now.js:154`) | |
| Now: Powerwall card | model, kWh/kW per unit, reserve %, mode, Storm Watch, charged/discharged today, today's range | | |
| Now: today stats | kWh, % from solar+battery, % of today's sun | "≈ $ at PEC rates", "≈ $ credit" (`now.js:107-111`) | |
| Now: bill-due card | | | whole card (`#billDueNow`) |
| History: charts, landscape, heatmap, records, outages | all (kWh, %, dates, CO₂ at ERCOT mix) | `hstats` "≈ $" subtitles | |
| History: bills list (if Q2 = skeleton) | month, period, kWh bought/sent, "✓ matches Tesla" | bill total | "+ Add a PEC bill", bill detail sheet, Remove |
| History: bill check | labels + ✓/!, "Solar + Powerwall covered N%" | total, all-in rate, "without solar it would have been" | `$`-bearing detail sentences |
| History: meter vs Tesla | all kWh | | |
| History: where your last bill went, monthly cost | | **locked card** (same height) | |
| History: this billing cycle | day N of M, kWh bought/sent so far, last-year kWh | projected bill | |
| Panels: header, roof twin, performance, warranty | all | | |
| Panels: cleaning check | dust score, loss %, rain dates, kWh/day lost | "$/mo" value of the gap (`panels.js:61`) | "✓ I cleaned the panels", Undo |
| Insights › Today: Day Ring, legend | all | | |
| Insights › Today: alerts | stale Tesla, NWS, solar low, batteries rarely fill | $ in the overnight-drift and pool-lights copy | "PEC bill doesn't match Tesla" card |
| Insights › Appliances › Pool | twin, circuits, temps, RPM/W, turnover, measured points, dial kWh/hours/% on solar, per-program kWh, deltas in kWh/turnover/RPM, why cards, seasons kWh, Autopilot **badge**, status, signals, week, suggestion text, log, filter hours | dial `$N/mo` (`dcSub`), schedule `$` totals, cost delta tile, spa `$` and `$/h`, `savesPerMonth` in the strip | Apply to ScreenLogic, Restore, Apply tomorrow's plan, Show the settings, I cleaned the filter, Off/Suggest/Auto seg |
| Insights › Appliances › AC | twin, HUD, scrubber, stats, equipment line, comfort chart, steps (as home), band, week, filtered log, Autopilot **badge** | "Cost −$/month" | Home/Away, presence signal ring, Apply today's plan, Autopilot seg, Link Nest card, error text |
| Insights › Planner | sliders (client-side), coverage, full-battery days, kWh rows, generic installed cost, backup hours | PEC cost/yr tile, PEC energy cost row, Saves per year, Payback, tariff sentence in `planFine` | "Your system so far" → **locked card**. The recommendation sentence gets a kWh-only guest variant. |
| Insights › Home | heat vs AC chart, kWh per degree, overnight baseline, data-health rows (generic error text) | "$ a month per degree" (`acTxt`) | |
| Settings | "Your system" minus firmware, Calm mode (localStorage), Preview outage (client-only), "Shared with you" group + Leave | Utility row: "PEC" + veiled rate | Tesla row, PEC bills row, All data, Export CSV, Alerts group, Account group, Sharing group, Link Nest |
| Desktop side panel | guest copy | | `d` shortcut → no-op |

## 2. Access model

### 2.1 Link-based tokens, with a real owner preview (A and B agree)

| | Link tokens → HttpOnly cookie (**chosen**) | Owner-side "guest mode" toggle only |
|---|---|---|
| Who is identified | The requester, server-side, on every request | Nobody. A stranger with the URL still gets owner data (F1). |
| Guests use their own phones | yes | no |
| Revocation | per link, instant (row update) | impossible |
| Rule 5 (no accounts) | a capability in a link, no identity | fine |
| Role in this design | **the access model** | **the owner's preview** (§4.6), downgraded server-side so it is byte-identical to a guest |

### 2.2 How the owner is identified without accounts (from A, hardened with B)

- `OWNER_KEY`: a 32-byte base64url secret in Vercel env (Production + Preview) and in the local `.env` (git-ignored). Claude generates and sets it (rule 7), and the owner saves it in his password manager. It is a **recovery credential** and is only used to mint a device session.
- **Magic link:** `https://<app-host>/#owner=<OWNER_KEY>`. The key is in the **fragment**, so it never reaches Vercel request logs, `Referer` headers or link unfurlers. B's `GET /auth/owner?key=` was dropped for exactly this reason. On boot, `main.js` reads the fragment, calls `POST /api/auth/owner {key}` and runs `history.replaceState` to strip it. The server compares with `timingSafeEqual` (same pattern as `verifyState`), inserts an `access_tokens` row `kind='owner'` and sets `solstice_owner`.
- **Inside an installed PWA** (no address bar): the locked card has an "I'm the owner" link that reveals a key field, pasted from the password manager. It calls the same endpoint.
- **Fail closed** (B): if `OWNER_KEY` is unset in production, `/api/auth/owner` returns 503, so everyone is anonymous and nothing leaks. **Local dev** (B, tightened): when `NODE_ENV !== 'production' && !process.env.VERCEL && !process.env.OWNER_KEY`, `identify` treats the request as owner, so `npm run dev` on PGlite keeps working.
- **Rate limit:** reuse `tooManyAttempts('ip:' + req.ip)` and `recordAttempt` unchanged (8 failures / 15 min → 429) for `/api/auth/owner` and `/api/auth/redeem`. The tokens are 192–256-bit, so the limit is hygiene rather than the defence.
- **Role resolution** (`identify`): a valid owner cookie makes the request `owner`. Otherwise a valid guest cookie makes it `guest`. Otherwise it is `anonymous`. An owner who opens a guest link on his own phone stays owner (the owner cookie wins). Preview is how he sees the guest view.

### 2.3 Token format and storage (A's single table)

Tokens are a random id plus a hash, not HMAC (both candidates agree). The tokens are unguessable, only their SHA-256 is stored (the same pattern as `sessions.token_hash`), revocation is a row update, and there is no signing key whose rotation logs everyone out. An HMAC token would need a denylist for per-link revocation anyway. The existing `signState` HMAC stays for OAuth `state`.

```sql
-- appended to SCHEMA in server/src/db.ts (CREATE … IF NOT EXISTS; never dropped or rewritten, rule 6)
CREATE TABLE IF NOT EXISTS access_tokens (
  id           text PRIMARY KEY,                 -- 8-char random base64url; shown in lists, used for revoke, safe to give the guest
  kind         text NOT NULL,                    -- 'owner' | 'guest'
  token_hash   text UNIQUE NOT NULL,             -- sha256(token) hex; the token itself is never stored
  label        text,                             -- owner-private ("Dad", "Neighbor"); never sent to the guest
  scope        text NOT NULL DEFAULT 'home',     -- 'home' (| 'now' if Q4 = yes)
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,                      -- NULL = never; owner rows slide (extended on use)
  revoked_at   timestamptz,
  last_used_at timestamptz,
  uses         int NOT NULL DEFAULT 0,
  user_agent   text                              -- first 120 chars of the redeeming / unlocking UA
);
CREATE INDEX IF NOT EXISTS access_tokens_kind ON access_tokens(kind, revoked_at);
```

B's kv `owner:devices` array was dropped because concurrent unlocks race on a read-modify-write of one kv key, and a table gives one lookup, one revoke path and one list for both kinds. A's `kind='pair'` was dropped (§8).

Token sizes: guest `randomBytes(24).toString('base64url')` (32 chars, 192 bits, from B, which gives a shorter link and a sparser QR). Owner `randomBytes(32)` (43 chars).

```ts
// server/src/access.ts (new)
export type Role = 'owner' | 'guest' | 'anonymous';
export type Scope = 'home' | 'now';
export type Access = { id: string; kind: 'owner' | 'guest'; scope: Scope; label: string | null; expiresAt: string | null };
declare global { namespace Express { interface Request { role: Role; access?: Access; asGuest?: boolean } } }

export function newToken(bytes: 24 | 32): { token: string; hash: string };
export async function issueToken(kind: 'owner' | 'guest', o: { label?: string; scope?: Scope; ttlMs: number | null; userAgent?: string }): Promise<{ id: string; token: string; expiresAt: string | null }>;
export async function lookupToken(token: string): Promise<(Access & { state: 'ok' | 'revoked' | 'expired' }) | null>; // bumps uses/last_used_at at most every 5 min; owner rows slide expires_at
export async function revokeToken(id: string): Promise<void>;                 // UPDATE … SET revoked_at = now()
export async function revokeAll(kind: 'owner' | 'guest', exceptId?: string): Promise<number>;
export async function listTokens(kind: 'owner' | 'guest'): Promise<Array<Access & { createdAt: string; lastUsedAt: string | null; uses: number; userAgent: string | null; revokedAt: string | null }>>;

export const COOKIE = { owner: 'solstice_owner', guest: 'solstice_guest' } as const;
export function setCookie(req: Request, res: Response, name: string, token: string, maxAgeS: number): void; // HttpOnly; SameSite=Lax; Path=/; Secure when secure(req)
export function clearCookie(res: Response, name: string): void;

export async function identify(req: Request, res: Response, next: NextFunction): Promise<void>; // role; X-Solstice-As: guest downgrades an owner (never escalates)
export const ownerOnly: RequestHandler;     // 401 anonymous, 403 guest { error: 'Owner only' }
export const notAnonymous: RequestHandler;  // 401 { error: 'Open your share link', reason?: 'revoked' | 'expired' }
export const writeGuard: RequestHandler;    // §3.2
export const guestGate: RequestHandler;     // §3.3: GUEST_GET allowlist, before handlers
```

`readCookie` and `secure` are exported from `auth.ts` and reused.

### 2.4 Cookies

| Cookie | Set by | Value | Attributes | Lifetime | Revoked by |
|---|---|---|---|---|---|
| `solstice_owner` | `POST /api/auth/owner` | owner token (row `kind='owner'`) | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000` (400 days, Chrome's cap) | Sliding: `expires_at = now() + 400 days` on use (bump throttled to 5 min) | Devices sheet → Sign out; "Sign out other devices"; `POST /api/auth/logout` |
| `solstice_guest` | `POST /api/auth/redeem` | **the share token itself** (row `kind='guest'`) | same attributes; `Max-Age = min(seconds to expires_at, 400 days)` | Fixed to the share's expiry. The server re-checks `expires_at`/`revoked_at` on every request, so a stale cookie is inert. | Owner revokes; guest taps "Leave" |

Links are **reusable** until they expire or are revoked (B). That covers a second device, iOS PWA isolation and cookie loss. The list's `uses` / `last_used_at` / `user_agent` columns are the leak detector.

### 2.5 Creating, listing and revoking shares

```ts
POST   /api/shares        { label: string (required, ≤40), expiresIn?: '24h'|'7d'|'30d'|'1y'|null, scope?: 'home'|'now' }
                          → { id, url: `${origin}/#s=${token}`, label, scope, expiresAt }   // the only time the url exists
GET    /api/shares        → Array<{ id, label, scope, createdAt, expiresAt, lastUsedAt, uses, userAgent, revokedAt }>
DELETE /api/shares/:id    → { ok: true }             // instant: that cookie is refused on its next request
DELETE /api/shares        → { revoked: n }           // "Revoke all links"
GET    /api/devices       → owner rows, current one flagged { current: true }
DELETE /api/devices/:id   → { ok: true }             // sign out one device
DELETE /api/devices       → { revoked: n }           // "Sign out other devices" (keeps the caller's row)
POST   /api/auth/redeem   { token } → { ok: true, role: 'guest', share: { id, scope, expiresAt } }   // sets solstice_guest
                          errors: 401 { reason: 'unknown' } | { reason: 'revoked' } | { reason: 'expired' } (the latter two only after a hash match, so guessing learns nothing)
POST   /api/auth/owner    { key } → { ok: true, role: 'owner' }                                     // sets solstice_owner
```

- **Expiry:** 24 h · 7 d · **30 d (default)** · 1 yr · Never. A proposed a 7-day default and B a 30-day one. The merge takes B's, because the main use (family) would otherwise see links die silently after a week. Revocation is instant and the list shows use counts, so a long default is safe.
- **Housekeeping:** revoked and expired rows stay greyed in the list for 30 days as an audit trail. After that, the nightly `/api/cron/sync` deletes them (row deletes, no table changes).
- **Display name:** kv `share:ownerName` ("Name shown on invites", set in the Sharing group, default "The owner"). It is never hard-coded and never in git (rule 5).

### 2.6 `/api/auth/me` (how the app knows its mode)

```ts
// owner
{ mode: 'single', role: 'owner', site: { name, connected: true }, device: { id }, devices: 3, ownerName, asGuest: false }
// guest (or owner with X-Solstice-As: guest → same body plus asGuest: true)
{ mode: 'single', role: 'guest', site: { name: 'Home', connected: true }, ownerName, share: { id, scope, expiresAt } }
// anonymous
{ mode: 'single', role: 'anonymous', reason?: 'revoked' | 'expired' }
```

`main.js` stores `S.role` and `S.ownerName`, and sets `document.documentElement.dataset.role`. The existing `me.site` checks keep working for the owner. Anonymous never reaches `showAuth('connect')`, the Tesla Connect button (B).

### 2.7 First open

1. The guest opens `/#s=<token>`. The static shell loads and the aurora renders.
2. `boot()` sees `#s=`, calls `POST /api/auth/redeem`, strips the fragment and calls `/api/auth/me`, which returns `guest`.
3. **Welcome card** (from B): the existing `.auth` overlay and `.authcard` with `.authlogo`, while the real Now view renders behind it. Title "{ownerName} shared their home's energy with you". Body "Live solar, Powerwalls, pool and AC, as it happens. Dollar amounts, bills and controls stay private." Line "This link works until Oct 25" or "No expiry". Primary button "Have a look". Small print "Add to Home Screen after opening, then paste the link once more if asked." The card dissolves (`opacity .4s`, `backdrop-filter` 18px → 0). It is shown once per device via `localStorage['solstice:welcomed:' + share.id]`, wrapped in try/catch.
4. **Anonymous card:** "Solstice is private". "This is one home's energy monitor. If someone sent you a link, open it, or paste it here." Input + "Open". The input accepts a full link or a bare token, extracts it and calls redeem. Below that, a small "I'm the owner" link reveals the key field. No data, no site name.
5. **Revoked / expired card:** triggered by redeem's `reason` or by a 401 with a `reason`. "This link was turned off" / "This link has expired". "Ask {ownerName} for a new one." Same card, no input. `ownerName` is only known if the guest cookie was valid once, and it is cached in `sessionStorage`; otherwise the copy says "the owner".

## 3. Server-side enforcement

### 3.1 Middleware order in `app.ts`

```ts
app.use(migrate-once)                                       // existing
app.use(identify)                                           // new: req.role, req.access, req.asGuest
app.use(guestJson)                                          // new: wraps res.json for role 'guest' (§3.3); no-op for owner → owner bytes unchanged
// public: /api/auth/me, /api/auth/redeem, /api/auth/owner, /api/cron/*, /api/admin/import (bearer), static
app.use('/api', writeGuard)                                 // §3.2
app.use('/api', notAnonymous)                               // exempts /api/auth/{me,redeem,owner} and ^/api/cron/, /api/admin/import (F12)
app.use('/api', guestGate)                                  // guest GET not in GUEST_GET → 403, before the handler
app.use('/api', requireUser)                                // existing; single branch now only attaches siteId
app.get('/auth/login' | '/auth/callback' | '/auth/google' | '/auth/google/callback', ownerOnly, …)
app.get('/api/settings' | '/api/site' | '/api/bills' | '/api/export.csv', ownerOnly, …)
// error handler: guest/anonymous → { error: 'Something went wrong' }; owner → err.message (F5)
```

The `MULTI_USER` branch of `requireUser` is untouched (rule 5 keeps it off).

### 3.2 Write guard (A), with B's guest-sync exception

```ts
const OPEN_WRITES = /^\/(auth\/(redeem|owner|logout))$/;           // any role (logout needs a cookie)
export const writeGuard: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (OPEN_WRITES.test(req.path) || /^\/admin\/import$/.test(req.path)) return next();
  if (req.path === '/sync' && req.role === 'guest') { (req as any).syncBudget = 4000; return next(); }
  if (req.role !== 'owner') return res.status(req.role === 'anonymous' ? 401 : 403).json({ error: 'Owner only' });
  const sfs = req.headers['sec-fetch-site'];                         // CSRF belt-and-braces beyond SameSite=Lax
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ error: 'Cross-site request' });
  next();
};
```

This covers every current write (`bills*`, `events*`, `settings`, `pool/{apply,apply-tomorrow,autopilot,restore}`, `ac/{apply,settings}`, `shares*`, `devices*`) and every future one. Preview requests carry the real owner cookie, but `identify` has already downgraded `req.role`, so writes are refused in preview. That is intended: the owner sees exactly what a guest sees.

### 3.3 Redaction layer

The rules are the same for every endpoint:

- **Allowlist of routes** (B's deny-by-default, enforced by `guestGate` *before* the handler so a refused route has no side effects such as an SDM read): `GUEST_GET = new Set(['/api/auth/me','/api/now','/api/status','/api/day','/api/daily','/api/monthly','/api/profile','/api/grid-days','/api/overnight','/api/records','/api/outages','/api/reconcile','/api/events','/api/ercot','/api/whatif','/api/appliances','/api/appliances/pool','/api/appliances/ac','/api/settings'])`. All of these paths are static, so `req.path` matching is exact.
- **Per-route view functions** (B's form, A's paths), applied by wrapping `res.json` once: `res.json = b => orig(req.role === 'guest' ? guestViews[\`GET ${req.route.path}\`](b, req) : b)`.
- **Shape preservation** (new; fixes F13): redaction may only turn a leaf value into `null`, turn a string into a fixed generic string, filter an array (it stays an array) or delete a key the client never dereferences. Objects stay objects and arrays stay arrays.
- **Marker:** `veil(obj, paths)` sets each path to `null` and appends it to `redacted: string[]` on the **root** of the response (B's dotted paths, e.g. `['plan.costPerMonth','seasons[].costPerMonth']`). The UI renders a veil for any `null` money slot and can check `redacted.includes(path)` to tell "hidden" from "no data".

```ts
// server/src/redact.ts (new)
type View<T = any> = (body: T, req: Request) => unknown;
export function veil<T extends object>(obj: T, paths: string[]): T & { redacted: string[] }; // deep-clones only along touched paths; supports a.b, list[].x, map[*].x
export function strip<T extends object>(obj: T, paths: string[]): T;
export function generic<T extends object>(obj: T, paths: string[], text: string): T;         // replace strings with fixed text, keep type
export const GUEST_GET: Set<string>;
export const guestViews: Record<string, View> = {
  'GET /api/auth/me':        b => b,                                  // built per role at source
  'GET /api/settings':       () => ({}),
  'GET /api/now':            b => generic(strip(b, ['site.firmware']), ['health.liveError', 'health.errors[*].message'], 'unavailable'),
  'GET /api/status':         b => strip(b, ['siteId']),
  'GET /api/whatif':         b => veil(strip(b, ['system']), ['assumptions.tariff', 'baseline.netCost', 'upgraded.netCost', 'noSystem.netCost', 'savesPerYear', 'paybackYears']),
  'GET /api/appliances':     b => b.map(a => generic(veil(a, ['savesPerMonth']), ['error'], 'unavailable')),
  'GET /api/appliances/pool':b => generic(veil(strip(b, ['snapshot.version']), ['rate', 'todayCost', 'current.costPerMonth', 'plan.costPerMonth', 'seasons[].costPerMonth', 'spaSession.propaneUsd', 'spaSession.electricUsdPerHour', 'settings.propaneUsdPerGal']), ['error'], "Couldn't reach the pool controller."),
  'GET /api/appliances/ac':  b => generic(veil(strip({ ...b, settings: { ...b.settings, presence: null }, state: b.state && { ...b.state, name: 'Thermostat' }, log: (b.log ?? []).filter(l => !/away|home/i.test(l.text)) }, ['state.deviceId']), ['plan.costSavedMonth']), ['error'], 'unavailable'),
  'GET /api/events':         b => b.map(e => strip(e, ['note'])),     // plus type filter at source
  'GET /api/reconcile':      b => b,                                  // skeleton built at source (§3.4)
  // energy routes pass through: /api/day, daily, monthly, profile, grid-days, overnight, records, outages, ercot
};
export const guestJson: RequestHandler;
```

### 3.4 Redactions that must happen at the source (A)

- **AC presence (F8):** `GET /api/appliances/ac` calls `acDetail(id, req.role === 'guest' ? { ...settings, ac: { ...settings.ac, presence: 'home' } } : settings, …)`. The plan, steps, `why` and `week` are then computed as if the owner were home. Residual: the live `state.coolF` may read 80° while the guest's plan says 76°. That reveals less than "Away", and it is accepted.
- **`fresh` (F9):** `const fresh = req.role === 'owner' && req.query.fresh === '1'` on the pool and AC routes.
- **`/api/reconcile`:** mapped in the route for guests. `charges: []`. `checks[].detail` → `label` when `/\$/` matches. `total, tariff, withoutSolarCost` → null + `redacted`. If Q2 = hide, the route returns `[]` for guests.
- **`/api/now.site.name`** → `'Home'` inside `summary()` when `req.role === 'guest'`.
- **`/api/events`:** `AND type IN ('cleaned','filter_cleaned')` for guests.
- **`/api/sync`:** `syncSite(site(req), req.syncBudget ?? 8_000)`.
- **Error handler:** guests and anonymous get `{ error: 'Something went wrong' }`, because Tesla messages contain the site id (F5).

### 3.5 Verification (A's allow-then-deny sweep plus B's leak canary)

- **`server/src/redact.test.ts`** (node:test via tsx, no DB). It runs a fixture body for every `GUEST_GET` route through its view and asserts that no non-null leaf survives under a money key or an identifier key:
  - `MONEY = /^(total|cost(PerMonth|SavedMonth)?|netCost|savesPer(Year|Month)|paybackYears|priceUsd|netUsd|monthlyPayment|loan\w*|taxCreditPct|propaneUsd(PerGal)?|electricUsdPerHour|todayCost|withoutSolarCost|rate|importRate(AllIn)?|exportCredit|fixedMonthly|discounts|franchisePct|tariff|charges|amount|lastYearCost)$/`
  - `IDENT = /^(siteId|site_id|deviceId|device_id|serial_number|din|gateway_id|version|firmware|token|email|label|note|presence)$/`
  - Allowlist for benign collisions: `/api/whatif.cost` and `assumptions.{dollarsPerW,powerwallCost}` (generic), `/api/day.totals` (kWh), `appliances[].id` (`'pool'|'ac'`).
  - B's string sweep: no string anywhere matches `/\$\s?\d/`, `/energy_sites\/\d/`, `/enterprises\//` or `/marked away|Away:/`.
  - Shape checks: `ac.log`, `pool.autopilot.log` and `health.errors` keep their types.
- **`scripts/test-guest-leaks.ts`** (B). It runs the Express app against `DATABASE_URL=pglite:<tmpdir>` with seeded site, energy, bills, settings, events and kv rows. It walks every route as guest and as anonymous with the same sweeps, and asserts every write returns 401 (anonymous) or 403 (guest), `POST /api/sync` excepted for guests. It also asserts that the crons still answer with a bearer token. Wired as `npm test`.
- **`scripts/guest-audit.mjs`** (A). Given a **preview URL** and a share link, it redeems the link and fetches every GET as guest and as anonymous (read-only). It runs the sweep, prints violations and exits non-zero on any. This is the acceptance check for each Phase 2 batch, alongside the screenshots. It never calls a write.

### 3.6 Cost and abuse

- Each `/api` request that carries a cookie adds one indexed `SELECT` on `access_tokens.token_hash` (~5–10 ms on Neon HTTP). There is no in-process cache, so revocation is instant. Writes happen only on redeem, on unlock, and as usage bumps throttled to one per 5 minutes per token.
- Guest reads hit the existing caches: Tesla live 25 s, Nest and ScreenLogic 60 s (and `fresh` is ignored), ERCOT 5 min. `/api/whatif` (a year of hourly rows) is the heaviest guest query. If it shows up in Neon metrics, cache the baseline replay per day in kv. It is not needed at launch.
- A leaked link exposes live power and kWh history only (no money, no identifiers, no occupancy text) until it is revoked.

## 4. UI: the Frost language (B's visuals, A's helper contract)

The guest sees **the same app**: same tabs, same card heights, frost on the private panes. Nothing is pared down (working-style rule). Real values never reach the DOM, because the server sent `null`. Veils are decoys, not a filter over real text.

### 4.1 Tokens and primitives (`web/src/style.css`, added after `:root`)

The frost accent is **neutral white**, not purple. B's reason for purple was wrong: `--grid` is the live grid-flow colour, so a purple lock would read as "grid".

```css
:root{--frost:rgba(8,10,16,.45);--frost-blur:14px;--veil:rgba(242,244,248,.32);--lock:rgba(242,244,248,.55)}
/* inline veil: shape-preserving decoy text, never a real value */
.veil{display:inline-flex;align-items:center;gap:5px;font-family:"JetBrains Mono";font-weight:500;color:var(--veil);letter-spacing:.1em;
  position:relative;overflow:hidden;border-radius:6px;padding:0 3px;background:rgba(255,255,255,.06);filter:blur(.8px);cursor:help;animation:veilin .3s var(--ease) both}
.veil::before{content:"";flex:none;width:8px;height:10px;border:1.5px solid var(--lock);border-radius:2px;box-shadow:inset 0 -5px 0 var(--lock)} /* padlock */
.veil::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent);transform:translateX(-100%);animation:sweep 5.5s 1.5s infinite}
@keyframes veilin{from{opacity:0;filter:blur(6px)}}
/* locked card: frosted glass over a deterministic skeleton, same height as the owner's card */
.card.locked{position:relative}
.card.locked>*:not(.h):not(.lock){filter:blur(6px) saturate(.5);opacity:.5;pointer-events:none;user-select:none}
.card.locked::after{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--frost);backdrop-filter:blur(var(--frost-blur));-webkit-backdrop-filter:blur(var(--frost-blur))}
.card.locked .lock{position:absolute;inset:0;z-index:2;display:grid;place-content:center;gap:6px;text-align:center;font-size:12.5px;color:var(--dim)}
.card.locked .lock b{display:block;font-size:14px;color:var(--text);font-weight:600}
.card.locked .lock i{width:26px;height:26px;border-radius:9px;margin:0 auto 4px;display:grid;place-items:center;background:rgba(255,255,255,.08);border:1px solid var(--glass-b);font-style:normal}
html[data-role=guest] [data-owner],html[data-as=guest] [data-owner]{display:none!important}
.chipx.guest{background:rgba(255,255,255,.08);border-color:var(--glass-b);color:var(--text)}
html[data-as=guest] .phone{border-color:rgba(255,255,255,.32)}
html[data-calm] .veil::after,html[data-calm] .veil{animation:none}      /* new attribute toggled with S.calm (F11) */
```

- **Decoys per slot type** (B) keep widths without leaking magnitude: money `$•••`, monthly `$•••/mo`, yearly `$•,•••`, rate `$•.••••/kWh`, payback `•• yrs`. They live in `web/src/lib/frost.js`: `veil(kind)`, `lock(title, reason)`, and deterministic SVG skeletons for the waterfall, billing-cycle and monthly-cost cards. The skeletons have fixed bar patterns, are not derived from data, and are drawn at the owner card's height.
- **Tapping any veil or locked card** (B) calls the existing `toast('🔒', 'rgba(255,255,255,.14)', 'Private to {ownerName}', 'Dollar amounts, bills and controls stay with the owner.')`. That gives one explanation and no dead ends.
- `prefers-reduced-motion` is already handled globally (`style.css:212`), so no new rule is needed.

### 4.2 Money helper contract (A)

```js
// web/src/lib/util.js
export let ROLE = 'owner'; export const setRole = r => { ROLE = r; };
export const usd = (v, d = 0, kind = 'money') => v == null || !isFinite(v) ? (ROLE === 'guest' ? veil(kind) : '—')
  : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })}`;
export const money = v => usd(v, 0); export const money2 = v => usd(v, 2);   // existing names, now veil-aware; owner output byte-identical
```

- Every inline `` `$${…}` `` and `≈ $` computation in `now.js`, `history.js`, `panels.js`, `insights.js`, `appliances.js`, `ac.js` and `settings.js` becomes `usd(...)`.
- Every `S.tariff?.importRateAllIn ?? <rate>` / `?? <credit>` becomes `S.rate` / `S.exportRate`. These are set from `S.reconcile.at(-1)?.tariff`, have **no fallback**, and are null for guests (F6). The owner keeps his fallback only through the server, so his view is unchanged.
- Sentences that embed money mid-text get the veil inline. Sentences that are *only* about money (the planner recommendation, "Your system so far") get a kWh-only guest variant or a locked card.
- `textContent` assignments that currently hold money (`now.js:111`, `panels.js:61`) switch to `innerHTML` with escaped parts, or gain a sibling span, so the veil markup renders.

### 4.3 Guest badge and chrome (B's placement; A's persistent bar dropped)

- **Now:** the first chip in `#chips` is `<div class="chipx guest"><i></i>Shared by {ownerName} · live</div>`. `#siteLine` shows "{ownerName}'s home" (or "Home").
- **Settings:** the header `p` reads "Shared by {ownerName} · link expires Oct 25". A new "Shared with you" group holds that line and a **Leave** row (`POST /api/auth/logout`, then the anonymous card).
- **Desktop side panel `.demo`:** "Shared view · live data yes, money no." replaces "Private to your account. Press D for raw data.".
- **Owner preview:** a persistent pill at the toast position reads "Previewing as a guest · Exit", and the phone border gets a neutral white tint.
- A's 30 px guest bar under the island was dropped. It needs `padding-top: 96px` on `.screen` for every tab, which shifts every layout. The chip, the Settings line and the tap-a-veil toast carry the same message.

### 4.4 Share sheet (owner): Settings › new "Sharing" group

This adds one new `.sect` + `.group`. The rest of Settings is untouched (rule 3).

```
┌ group ──────────────────────────────────────────────────┐
│ ⇗  Share this app            2 active links          › │  → share sheet
│ ◐  Preview as a guest        see what they see     [sw] │  → Frost wipe (§4.5)
│ @  Name shown on invites     The owner               › │  → sheet with one text field → kv share:ownerName
│ ▣  Owner on 3 devices        sign out others         › │  → devices sheet
└─────────────────────────────────────────────────────────┘
```

Share sheet (`.sheet`, grab handle, `.shead` with ×):

```
Share Solstice
Anyone with a link sees live energy. Never dollars, never controls.
Label     [ Dad                    ]          (.fields, required, private)
Expires   ( 24h ) ( 7d ) (•30d ) ( 1 yr ) ( Never )   (.seg2)
[ Create link ]                                (.primary)
— after create (one time) —
┌ link card ─────────────────────────────────────────────┐
│ <app-host>/#s=Xq…9F                │ JetBrains Mono, middle-truncated
│ [ Copy ]  [ Share… ]  [ QR ]                             │ Share… = navigator.share; clipboard fallback
│ Shown once. Solstice keeps only a fingerprint.           │ .fine
└──────────────────────────────────────────────────────────┘
QR (toggle): 180 px, drawn client-side
ACTIVE LINKS
Dad        created Sep 25 · expires Oct 25 · opened 4× · last Sep 26 · iPhone Safari   [ Revoke ]
Neighbor   created Sep 20 · never expires · never opened                               [ Revoke ]
REVOKED (30 days)  greyed rows
                                                              [ Revoke all links ]  (.danger)
```

- Revoke → `confirm()` (the app's existing pattern) → `DELETE /api/shares/:id` → toast "Link turned off · Dad".
- The devices sheet lists "This iPhone · Safari · now" / "Mac · Chrome · 2 h ago" with Sign out on each, plus "Sign out other devices".
- **QR** (B): dynamic `import('qrcode-generator')`, a pure-JS MIT package with no native deps. It becomes its own Vite chunk and is loaded only when [QR] is tapped. The main chunk is already 742.85 kB, so A's vendored copy inside the main bundle was dropped.

### 4.5 Owner preview and the Frost wipe (B's animation; A's server-faithful mechanism)

The preview is real. While `S.asGuest` is on, `api.js` adds `X-Solstice-As: guest` to every call. `identify` downgrades `req.role` to `guest` **only if the real role is owner**, so guests cannot escalate and writes are refused. The owner therefore sees the server's actual guest payload.

1. The switch's centre `(x, y)` becomes `--x/--y` on a `.frostwipe` layer (`position:absolute; inset:0; z-index:40` inside `.phone`) that starts at `clip-path: circle(0 at var(--x) var(--y))` with `backdrop-filter: blur(0)`.
2. From 0 to 450 ms, `clip-path` grows to `circle(150% …)` and blur goes from 0 to 24px on `var(--ease)`. The aurora canvas keeps moving behind `.phone`, so the frost reads as glass sliding over a live scene.
3. At 300 ms the client sets `S.asGuest = true`, `setRole('guest')` and `html[data-as=guest]`, then re-runs `loadNow`, `loadHistory`, `loadWeather`, `loadExternal`, the pool load and `loadAc` in parallel under the frost.
4. From 750 to 1350 ms the layer retreats top to bottom (`clip-path: inset(0 0 100% 0)`), and each `.veil` plays `veilin` as it is uncovered. The preview pill drops in with the toast transform.
5. Exit reverses: bottom-up frost, refetch without the header, top-down clear. With calm mode or reduced motion, a 150 ms crossfade replaces the sweep.

## 5. Guest controls: hidden, not disabled (A and B agree)

A disabled "Apply to ScreenLogic" advertises that the app can rewrite the pool controller and the thermostat, and it invites "how do I turn this on?". Guests keep the **state** that explains what they are looking at, and the card ends with one `.fine` line where the primary button was: "{ownerName} approves changes from their own devices." That keeps the card's rhythm (B).

| Control | Guest sees |
|---|---|
| Pool Autopilot Off/Suggest/Auto (`#autoMode`), AC Autopilot (`#acMode`) | Static `.badge` "Autopilot · Suggest" (the live mode). Status sentence, signals, week and tomorrow's suggestion stay. |
| Apply to ScreenLogic, Restore, Apply tomorrow's plan, Show the settings, Apply today's plan to Nest | Hidden, plus the `.fine` line |
| Home / Away (`#acPresence`), presence signal ring | Hidden; `presence` is null server-side |
| I cleaned the panels / filter, Undo | Hidden; the last-cleaning date row stays |
| + Add a PEC bill, bill detail sheet, Remove bill | Hidden |
| Alert switches, Account, Sign out, Link Nest, Connect Tesla, Sharing group | Hidden |
| Export CSV, All data (`d` key) | Hidden; the routes 401/403 |
| Planner sliders, Day Ring modes, schedule dial Now/Rec/Both, day navigation, AC scrubber | Live (client-side reads) |
| Calm mode, Preview outage mode | Live, stored in `localStorage` for guests (try/catch) |

- **Static markup:** these elements get `data-owner` (`index.html:345-365` rows, `#alertPrefs`, `.acct`).
- **JS-generated controls** (`#poolApply`, `#acApply`, `#applyTomorrow`, `#logClean`, `#cleaned`, `data-addbill`, bill Remove, Autopilot segs, presence seg) are not emitted when `S.role !== 'owner' || S.asGuest`.
- **Server-side**, every one of these is refused by the write guard whatever the UI shows.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| **Guest installs the PWA** | Android/Chrome shares the browser's cookie jar, so it works. On iOS a Home Screen web app may not carry Safari's cookies. If the first standalone open is anonymous, the anonymous card's paste field redeems the same (reusable) link inside the PWA. `start_url` stays `/`, and the manifest is static with no token. To verify on a real iPhone in Phase 2. |
| **Owner's PWA on iOS** | Same isolation. "I'm the owner" → paste `OWNER_KEY` from the password manager. |
| **Service worker caching owner HTML** | There is no owner HTML: `/` is one shell for every role, and the role comes from `/api/auth/me` at boot. `/api` and `/auth` are never cached (`sw.js:7`). Bump `CACHE` to `solstice-v2` on ship so pre-role shells are dropped. A revoked guest who is offline sees the shell, then the revoked card once back online. |
| **Guest link leaked** | Revoke (row update, effective on the next request) or "Revoke all". `uses` / `last_used_at` / `user_agent` make a leak visible ("opened 40× · last 2 min ago"). The exposure is live kWh only. |
| **Open tab when revoked** | The next API call returns 401 with `reason:'revoked'`. `api.js` re-checks `/api/auth/me` and shows the revoked card. `main.js` also polls `/api/auth/me` every 5 min and reloads on a role change (B). Only a 401 with a `reason` triggers this, not ordinary owner-only 403s (this fixes B's 403 signal). |
| **Link previews (iMessage/Slack)** | Unfurlers fetch `/` without the fragment and without JS, so they see only the shell title and nothing is redeemed (A's fragment choice). |
| **Owner cookie lost** (cleared data, new phone) | The app boots anonymous. Use the magic link or paste the key. Nothing to reset. |
| **Owner key leaked** | Rotate `OWNER_KEY` in Vercel, redeploy, then Devices → "Sign out other devices" (sessions are rows, so rotation alone does not log devices out). |
| **Multiple owner devices** | One row per unlock. Each has a sliding 400-day cookie. The Devices sheet has per-device sign out. |
| **Owner opens a guest link** | The owner cookie wins. Use Preview. To hold a guest cookie on that device, sign out first. |
| **`OWNER_KEY` missing on Vercel** | Fails closed: everyone is anonymous and nothing leaks. The preview deploy (rule 6) catches this before production. |
| **Deploying the lockdown** | The build that adds `notAnonymous` locks out every device without a cookie, the owner's included. Sequence: Claude sets `OWNER_KEY` in Vercel (Production + Preview) → preview deploy → unlock on the preview URL → run `guest-audit.mjs` → merge only after batch 2 (the client's locked card) is in, because the current client answers a 401 with the MULTI_USER login form → unlock once per device on production. |
| **Crons and admin** | Exempt from the cookie guards by path (F12), and still bearer-protected. `test-guest-leaks.ts` asserts they still answer. |
| **Local dev** | Owner by default when there is no `OWNER_KEY`, no `VERCEL` and non-production. Cookies are set without `Secure` on http (existing `secure(req)`). Never run against the cloud DB (Tesla refresh tokens are single-use). |
| **Guest hammering endpoints** | Reads come from caches; `fresh` is ignored; guest sync is throttled by `due()`; the only per-IP limit is on the auth endpoints. |
| **Expiry and clock** | `expires_at` is compared in SQL with `now()`. Cookie `Max-Age` is a convenience, not the check. |
| **`MULTI_USER` ever on** | `identify` runs first and the multi-user branch of `requireUser` is unchanged. Nothing here uses the `users` table, and rule 5 still says never. |

## 7. Mockup and rollout

**Mockup first** (rule 2): `mockups/k-share.html` links `../web/src/style.css` and is checked at 393 px for overflow. It has seven frames:

1. Guest Now with the chip and veiled `$` subtitles.
2. Guest History with the bills skeleton, veiled totals and three locked cards.
3. Guest Appliances with the Autopilot badges and the "approves changes" line.
4. Guest Planner with the "Your system so far" locked card.
5. Settings › Sharing group, the share sheet in both states, and the devices sheet.
6. Welcome, anonymous and revoked cards.
7. Three stills plus a scripted run of the Frost wipe.

The mockup uses the name "The owner" and no real dollar figure anywhere (rule 5). The veils make that natural.

**Phase 2**, on a branch with preview deploys, in batches of about five, each verified on the preview URL with screenshots and `guest-audit.mjs`:

1. **Batch 1 (server):** share-S1, S2, S3, S4, S5.
2. **Batch 2 (client core):** share-S6, S7, S8. **No merge to `main` before batch 2**, because batch 1 alone would show the owner the MULTI_USER login form.
3. **Batch 3:** share-S9, S10, S11 (if Q5 = yes), S12.

## 8. Provenance and what was dropped

| From A (winner: structure, server model) | From B (grafted) | Dropped, and why |
|---|---|---|
| F1–F10 findings; the three-class inventory with a per-tab field table; the rule that the tariff is blurred and client fallbacks removed; the rule that identifiers are dropped, not nulled; the fragment tokens `#s=` / `#owner=` (no logs, no unfurl redemption); the single `access_tokens` table; the 5-minute usage-bump throttle; sliding 400-day owner cookies; the write guard with `Sec-Fetch-Site`; source-level AC presence forcing; `fresh` owner-only; the events type filter; the `usd()` helper contract; the money/identifier key sweep plus `guest-audit.mjs` against the preview; the lockdown deploy sequence; hidden-not-disabled | Deny-by-default guest route allowlist; guest `POST /api/sync` with a 4 s budget; fail-closed `OWNER_KEY` and the localhost dev owner; per-slot decoy strings; locked cards that keep their height with deterministic skeletons; the tap-a-veil toast; the Frost wipe from the switch position; welcome/anonymous/revoked `.authcard` states; the guest chip in `#chips`; the `.fine` "approves changes" line; `/api/settings` → `{}` for guests; `checks[].detail` → label when it contains `$`; `state.name` → 'Thermostat'; expiry choices with a 30-day default and 1 yr; reusable links; the PGlite leak canary with string regexes; the 5-min `/auth/me` poll; the lazy-loaded QR chunk; `CACHE` bump to v2; the docs item | **B `GET /auth/owner?key=`** (secret in request logs). **B `/auth/share/:token`** (logged, and unfurlers redeem it). **B kv `owner:devices` array** (read-modify-write race). **B purple frost accent** (`--grid` is the grid-flow colour). **B 403-as-role-change** (misfires on normal owner-only 403s; replaced by 401 + `reason`). **B error → boolean** (breaks `appliances.js:40` and `insights.js:100`; replaced by generic strings). **A `log` drop and `snapshot.*` drop** (break `ac.js:81` and the flow twin; replaced by a filtered log and a kept snapshot). **A device pairing (`kind='pair'`)**: a scanned QR or tapped link opens Safari, not the iOS PWA, so it does not solve the case it was for, and the paste-key field covers it. **A persistent guest bar** (shifts every tab's layout). **A vendored QR in the main chunk** (main chunk is already 742.85 kB). **Both designs' `S.preview` and `body.calm`** (collide with, or do not exist in, the current code). |

## 9. Observations outside this scope (for the orchestrator, not built here)

- **POST /api/events rejects `filter_cleaned`**: the validator allows only `['cleaned','note']` (`app.ts:271`), but "I cleaned the filter" (`appliances.js:127`) posts `filter_cleaned` and Autopilot reads it (`autopilot.ts:69`). The button likely returns HTTP 400 today.
- **`CLAUDE.md` is untracked** and contains the owner's first name, the live URL and the original pool schedule. Committing it to the public repo would conflict with rule 5 ("no name").
- The server-side PEC rate defaults (`app.ts:258,290,326`) are the owner's real tariff in a public repo. They should move to a setting.
- Both Autopilots are 'auto' on the live site, against rule 4's default. This design makes the Autopilot endpoints owner-only but does not change the modes.
- Until share-S1 ships, every write (including pool apply and Nest setpoints) and the Tesla/Google OAuth re-link are open to anyone with the URL. That argues for doing batch 1 first.
