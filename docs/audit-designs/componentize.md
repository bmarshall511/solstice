# Componentize: final design (judge's merge)

## 0. Verdict

| Criterion | A (minimal-diff, literal moves) | B (full plugin runtime) |
|---|---|---|
| Fit to the code (checked by reading it) | **9/10**. The duplication inventory is correct: `ring()` is copied at `appliances.js:115` and `ac.js:75`, and there are three copies of the settings-write block at `app.ts:139-141`, `350-353` and `386-387`. Its `kvKey` matches today's key names exactly. Faults: its `main.js` line numbers are off by 3 to 5 lines; it says `hmH` returns byte-identical output, but it does not at h=24 (see §5); its web total of "~935" does not add up (its own rows sum to ~975). | **7/10**. Its `main.js` line numbers are right, and it correctly spots that `learnAcKw` runs 2 queries per HVAC transition on every request. Faults: it names `insights.js` as the `<span>`-label stat variant (that is `history.js:30`); its `loop.js` example calls `aurora.render(T)` with `dt`; it counts "3 detail computations per poll" when there are 4. Its generic `tickFor`/`applyFor` papers over the fact that the pool plans tomorrow nightly while the AC steps hourly. |
| Owner value | 7. A third appliance costs about 60 web lines and no edits to `app.ts` or `main.js`. | 8. It adds a Preview kill switch, a cheap strip list and the learn cache. |
| Simplicity | **9**. Two new server files, one UI file, one host. | 5. Seven new server files, a kv key migration, a lock and a generic mode engine. |
| Serverless cost | 6. It names the repeated detail work but leaves it in place. | **8**. It removes the detail work from the strip list and takes learning off the request path. |
| Privacy (public repo) | 9 | 9 |
| Risk | **9**. Same API paths, same `vercel.json`, same kv keys, same `S.pool`/`S.ac`. | 5. API paths change, the cron path is renamed (`nest`→`ac`), legacy kv rows are `DELETE`d, `S.pool` is renamed to `S.appl.pool`, and the generic tick sits on the device-write path. |

**Winner: A.** The final design keeps A's structure and its "every move is literal" rule. It adds B's placement of shared server code (settings, cron, weather), B's cost fixes (a cheap strip list, cached learning), B's Preview kill switch (moved to the device-client chokepoints), B's single `seg()` helper, B's `data-slot` addressing for the optional generated slots, B's loop registry (optional) and B's docs checklist. §7 lists what was dropped and why.

---

## 1. What the code does today (verified)

**Web.** `views/appliances.js` is 128 lines (19.6 KB) and `views/ac.js` is 85 lines (14.4 KB). They repeat the same blocks. The table is A's inventory with corrected line numbers.

| # | Pattern | Pool (`views/appliances.js`) | AC (`views/ac.js`) | Other adopters |
|---|---|---|---|---|
| W1 | short clock `8a` / `2:30p` | `hm(minutes)` L9 | `hm(hours)` L8 | — |
| W2 | badge text + `'badge'`/`'badge g'` | L39 | L20 | `panels.js:58`, `insights.js:102`, `history.js:162` (in a string) |
| W3 | `.stat` tile `<small>label</small><b>value</b>` | L48-50 (4 tiles, plus a spa row at `grid-column:1/-1`) | L36-37 (4) | `insights.js:40-41` (`<b class="up">`). `history.js:30` uses a `<span>` label and stays as it is. |
| W4 | seg toggle `.on` + `closest('button')` | L71-76 schMode, L109-112 autoMode | L38-39 presence (`data-p`), L72-73 acMode | `main.js:139` insSeg, `main.js:147` drModes, `history.js:62` hseg |
| W5 | autopilot status `<i class="off?"></i><span>` | L114 | L74 (ends with a stray `</div>`) | — |
| W6/W7 | 44 px signal ring + the row of 6 | L115-116 | L75, L77 | — |
| W8 | 7-day week strip SVG (`X=i=>12+i*42`, today boxed at y 4, bar from y 84, weekday at y 100) | L118-122 | L78-79 | — |
| W9 | `.tline` log rows | L125-126 | L81 (has an empty-state row) | — |
| W10 | reasons carousel + dots + `onscroll` | L85-93 | L59-64 | — |
| W11 | deltas 2×2 | L82-83 | L57-58 | — |
| W12 | kv rows `<span>k</span><b>v</b>` | L78, L94 | L65 | `panels.js:11`, `history.js:164-166, 199-200` |
| W13 | Apply / Show / Restore flow: `confirm()` → `Applying…` → reload → `alert` | L95-102, L124 | L66-68 | — |
| W14 | `Last read failed` span | (pool shows it in the HUD) | L40 | — |
| W15 | twin singleton + accessor | L13, L15, L41 | L6-7, L22 | `main.js:135, 139, 189-190` |
| W16 | 3-minute poll → `S[id]` → draw | L14, L17-22 | L83-85 | — |
| W17 | weekday `new Date(d+'T12:00').toLocaleDateString(…)` | L121 | L78 | `util.niceDate(d,{weekday:'short'})` |

**Server** (`app.ts` appliance block L325-406, 82 lines):
- Settings are written in three places (`app.ts:139-141`, `350-353`, `386-387`).
- The `CRON_SECRET` check appears three times (`app.ts:106`, `357`, `395`).
- The Chicago-hour `Intl` expression appears four times (`pool.ts:88`, `pool.ts:128`, `ac.ts:11`, `ac.ts:17`).
- `forecast()` lives in the pool's `autopilot.ts` but the AC imports it too.
- The Open-Meteo archive fetch is inline in `acSlope()` (`app.ts:366-379`).
- The AC summary is hard-coded inline in the list route (`app.ts:330`). Only the pool uses the `Appliance` registry (`index.ts:13`).
- `cron/pool` and `cron/nest` are mounted **after** `requireUser` and `requireSite` (`app.ts:134, 144`). `cron/sync` is mounted before them.

**Cost facts found while verifying** (these drive two of the items):
1. Each 3-minute poll while the app is open runs `poolDetail` twice and `acDetail` twice. `GET /api/appliances` computes both details (`pool.ts:173`, `app.ts:330`), then the web fetches `/appliances/pool` and `/appliances/ac` again.
2. `acDetail` calls `learnAcKw` (`ac.ts:23-36`) on every call. That function runs 1 query plus **2 queries for every HVAC on/off transition in 14 days**, an N+1 over Neon HTTP. It also runs on every 5-minute `cron/nest` tick, because `acTick` calls `acDetail(fresh)`. Nest sampling started only this week (16 steps so far). At 10 to 20 cycles a day, 14 days of data will mean hundreds of queries per call, about 288 times a day from the cron alone.
3. `poolDetail` runs the `PERCENTILE_CONT` query `measuredPoints` **twice** (`pool.ts:94` and again when it builds `model.measured`).

**Every device write goes through one of two functions:** `writePoolPlan` (`screenlogic.ts:57`) and Nest's `exec` (`nest.ts:57`, used by `setCool`/`setHeat`/`setMode`/`setEco`).

---

## 2. (a) Shared web layer: one file, `web/src/lib/ui.js` (~75 lines)

Plain functions only. **String builders** return HTML. **Binders** take an element. Nothing in the file knows about pools or thermostats. It imports only `util.js`, which touches `document` only inside functions, so `node --test` can load it without jsdom.

```js
// web/src/lib/ui.js
import { niceDate } from './util.js';
/* formatting (W1, W17) */
export const hm      = mins  => …;                         // moved verbatim from appliances.js:9 (510 → "8:30a")
export const hmH     = hours => hm(Math.round(hours * 60)); // replaces ac.js:8
export const weekday = day   => niceDate(day, { weekday: 'short' });
/* string builders */
export const badgeCls = ok => 'badge' + (ok ? ' g' : '');
export const tile     = (label, value, { wide = false, cls = '' } = {}) => `<div class="stat"${wide ? ' style="grid-column:1/-1"' : ''}><small>${label}</small><b${cls ? ` class="${cls}"` : ''}>${value}</b></div>`;
export const kvRows   = rows  => rows.map(([k, v, warn]) => `<span>${k}</span><b${warn ? ' style="color:var(--warn)"' : ''}>${v}</b>`).join('');
export const deltas   = items => items.map(({ label, value, sub }) => `<div><small>${label}</small><b>${value}</b><span>${sub}</span></div>`).join('');
export const ring     = (value, label, frac, color) => …;   // the 44×44 SVG, moved verbatim
export const signals  = list  => list.map(s => ring(s.value, s.label, s.frac, s.color)).join('');
export const status   = (on, html) => `<i class="${on ? '' : 'off'}"></i><span>${html}</span>`;
export const logRow   = ({ when, html, delta, warn }) => `<div><i${warn ? ' class="w"' : ''}></i><span>${when}</span><p>${html}${delta ? `<em>${delta}</em>` : ''}</p></div>`;
export const logRows  = (entries, { max = 6, empty = '' } = {}) => entries.slice(0, max).map(l => logRow({ when: niceDate(l.day, { month: 'short', day: 'numeric' }), html: l.text, delta: l.delta })).join('') || empty;  // `empty` from B
export const readError = err => err ? ` <span style="color:var(--warn)">Last read failed: ${err}</span>` : '';
/** W8: 7 columns 42 px apart, today boxed, bars from the y=84 baseline. col(d, i, px) → { h, fill, label, opacity?, lift?, above?, after? }; output keeps the literal <text> attributes. */
export function weekStrip(days, col, { under = '' } = {}) /* → string */
/* binders */
export function badge(el, text, ok)                                           // textContent + className
export function seg(el, value, onChange, { attr = 'm', confirm = {}, eager = true } = {})  // from B: one call does the toggle, the delegate and confirm-on-value
export function reasons(listEl, dotsEl, items)                                // items [{ icon, title, body }]; writes both, binds onscroll
export async function busy(btn, label, fn, failPrefix)                        // shows label while fn runs; alert(`${failPrefix}: ${e.message}`) and restores the label on failure
export function planActions(el, { applied, applyLabel, showLabel, confirmText, apply, stepsEl, failPrefix, restore })
```

How `seg` behaves: it sets `.on` on the buttons whose `dataset[attr] === value` and assigns `el.onclick` once (the assignment is idempotent). A click on the current value does nothing. `confirm[v]` gates a value behind `window.confirm`. With `eager: true` (schMode, insSeg, drModes, hseg) it moves `.on` straight away. With `eager: false` (autopilot, presence) it waits for the reload to redraw, as today. The confirm strings pass through unchanged.

### 2.1 Exact adopters

| Helper | Call sites |
|---|---|
| `hm`/`hmH` | `appliances.js:9` deleted; `ac.js:8` deleted and its 9 uses become `hmH(…)` |
| `badge`/`badgeCls` | `appliances.js:39`, `ac.js:20`, `panels.js:58`, `insights.js:102`, `history.js:162` (`badgeCls`) |
| `tile` | `appliances.js:48-50` (spa row `wide`), `ac.js:36-37`, `insights.js:40-41` (`cls:'up'`) |
| `kvRows` | `appliances.js:78` (warn when `> 5`), `appliances.js:94`, `ac.js:65`, `panels.js:11`, `history.js:164-166`, `history.js:199-200` |
| `deltas` | `appliances.js:82-83`, `ac.js:57-58` |
| `ring`/`signals` | `appliances.js:115-116`, `ac.js:75, 77` |
| `status` | `appliances.js:108, 114`, `ac.js:74` (the stray `</div>` goes) |
| `logRows`/`logRow` | `appliances.js:125-126` (plus the `warn` filter row), `ac.js:81` (`empty` = the "No changes yet" row) |
| `readError` | `ac.js:40` |
| `weekStrip` | `appliances.js:118-122` (`under` = sun area + gradient defs; `above` = boost dot; `after` = "rain"; `lift = boost ? 14 : 6`); `ac.js:78-79` (`above` = pre-cool block; `lift = 8 + depth*6`; `opacity = tm ? 1 : .7`) |
| `reasons` | `appliances.js:85-93` (tuples become objects); `ac.js:59-64` (`P.why` → `{ icon: ['☀','▮','°','⏱','⚡'][i%5], title: i ? 'Also' : 'Today', body: w + '.' }` plus the three fixed cards) |
| `seg` | `appliances.js:71-76` (schMode, bound once in `init`), `appliances.js:109-112` (autoMode, `confirm.auto`, `eager:false`), `ac.js:38-39` (presence, `attr:'p'`, `eager:false`), `ac.js:72-73` (acMode), `main.js:139` (insSeg, `attr:'p'`), `main.js:147` (drModes), `history.js:62` (hseg, `attr:'r'`) |
| `planActions`/`busy` | `appliances.js:95-102` (with `restore: { confirmText, run: api.poolRestore }`), `appliances.js:124` (apply-tomorrow, `busy`), `ac.js:66-68` |

**Composites** in `web/src/appliances/cards.js` (~20 lines, from A). They work on today's DOM through the id prefixes that already exist (pool plan `sch*`, pool autopilot `auto*`, AC `ac*`), so nothing is renamed:

```js
export function drawPlanCard(p, { deltas, reasons, steps, actions })   // $(`${p}Deltas`), $(`${p}Why`), $(`${p}Dots`), $(`${p}Steps`), $(`${p}Actions`)
export function drawAutopilotCard(p, { mode, confirmAuto, save, reload, statusOn, statusHtml, signals, tomorrow, week, log, empty })  // $(`${p}Mode`), …Status, …Signals, …Tomorrow, …Week, …Log
```

The only markup change in these PRs: the action buttons swap their ids (`poolApply`/`poolShow`/`poolRestore`/`acApply`/`acShow`) for `data-act="apply|show|restore"`. Nothing references those ids. The only id rules in `style.css` are `#aurora`, `#orb`, `#flow` and `#hchart`.

**Verification** (from A): `web/src/lib/ui.test.mjs` runs under `node --test` with golden strings copied from the current literals, for example `tile('Today','5.2 kWh · 7%')` must equal `<div class="stat"><small>Today</small><b>5.2 kWh · 7%</b></div>`. `package.json` gains `"test": "node --test web/src/lib/*.test.mjs server/src/**/*.test.ts"` (server tests go through `--import tsx`). On the Vercel preview, a DOM id/class dump of `#ip-appl` is taken before and after and diffed in `/private/tmp`, and screenshots are checked at 393 px.

---

## 3. (b) Appliance plugin contract

### 3.1 Shared server code first (B's file placement; bodies moved from `app.ts`)

```ts
// server/src/settings.ts (~20)
export const settingsFor = (req: Request) => Promise<Record<string, any>>;                  // app.ts:136
export async function saveSettings(req: Request, patch: Record<string, any>): Promise<void>; // app.ts:139-141, shallow top-level merge
export async function saveNamespace(req: Request, ns: string, next: object): Promise<void>; // replaces app.ts:350-353 and 386-387: settings[ns] = next
export function settingsOf<T extends object>(all: Record<string, any>, ns: string, defaults: T, deep: (keyof T)[] = []): T; // pool.ts:103 and ac.ts:79 (deep: ['band'])
// server/src/http.ts (~20)
export class HttpError extends Error { constructor(public status: number, msg: string) }     // error middleware app.ts:416 uses err.status ?? 500
export const requireCron: RequestHandler;                                                   // one CRON_SECRET check (app.ts:106, 357, 395)
export async function forEachSite<T>(fn: (siteId: string, settingsAll: Record<string, any>) => Promise<T>): Promise<Record<string, T | { error: string }>>;
// server/src/weather.ts (~35)
export async function forecastDays(): Promise<Daily[]>;         // moved from autopilot.ts:15-27 (kv 'pool:forecast' key unchanged)
export async function dailyHighs(days = 120): Promise<Record<string, number>>;  // moved from acSlope app.ts:369-373 (kv 'wx:highs' unchanged)
// server/src/tesla/client.ts  + export const localHour = (d = new Date()) => …   replaces the 4 Intl copies
// server/src/db.ts           + kv.memo<T>(key, ttlMs, fn): Promise<T>            stores { at, value }; used by forecast (1 h), wx:highs (12 h), ac:slope (6 h), and the learn cache (§3.4)
```

All three crons move in front of `app.use('/api', requireUser)` with `requireCron`. Today `cron/pool` and `cron/nest` only work because single-owner mode lets them through.

### 3.2 Device-write guard (merged from A's kill switch and B's Preview env; placed at the two chokepoints)

```ts
// server/src/appliances/guard.ts (~6)
export function assertDeviceWrites(what: string) {
  if (process.env.APPLIANCE_WRITES === 'off') throw new HttpError(403, `Device writes are off on this deployment (${what})`);
}
// screenlogic.ts:57 writePoolPlan → first line: assertDeviceWrites('ScreenLogic')
// nest.ts:57 exec                 → first line: assertDeviceWrites('Nest')
```

Both candidates put the guard in the route or runtime layer. Putting it in the two device clients covers every present and future path: buttons, `apply-tomorrow`, restore, the pool Auto tick and AC steps. The throw happens before `applyPlan` does any kv bookkeeping (`pool.ts:156-158`), and before `acTick` logs a step (`ac.ts:110-112`). `APPLIANCE_WRITES=off` is set on the Vercel **Preview** environment only (`npx vercel env add APPLIANCE_WRITES preview`). Production is unchanged. Verification is a local `node --test` that calls both functions with the env set and expects a 403 before any network call. The guard is **never** proven by pressing Apply on a preview.

**Previews share the production database.** A POST on a preview changes rows that production's crons act on. For example, `ac/apply` stores `approved:true` and the production 5-minute cron then moves the thermostat. So no PR in this plan exercises any POST on a preview, including settings and autopilot mode changes (B's PR 2 did).

### 3.3 The contract: `server/src/appliances/index.ts` (14 → ~50) and `host.ts` (~40)

```ts
export type Mode = 'off' | 'suggest' | 'auto';                         // moved from autopilot.ts:8, re-exported there
export const isMode = (m: unknown): m is Mode => m === 'off' || m === 'suggest' || m === 'auto';
export type Ctx = { siteId: string; settings: Record<string, any>; rate: number; slope: () => Promise<number>; fresh: boolean; act: boolean };  // slope memoised per request
export type Action = { run: (ctx: Ctx, body: any) => Promise<unknown>; writes?: boolean };
export const guarded = (run: Action['run']): Action => ({ run, writes: true });   // host: linked() required, the call is logged
export type ApplianceSummary = { id: string; name: string; status: 'linked' | 'estimated' | 'coming'; watts: number | null; kwhPerDay: number | null; savesPerMonth: number | null; source?: string; error?: string };
export type Appliance = {
  id: string; name: string; source: string;
  available(): boolean;                                   // env configured
  linked(): Promise<boolean>;                             // the device answers or consent was given
  detail(ctx: Ctx): Promise<Record<string, any>>;         // GET /api/appliances/:id
  summary(d: Record<string, any>): ApplianceSummary;      // pure, derived from the detail (from B), so the list never needs its own device read
  actions?: Record<string, Action>;                       // POST /api/appliances/:id/:action; action names = today's path segments
  ticks?: Record<string, (ctx: Ctx) => Promise<unknown>>; // GET /api/cron/:tick; key = today's vercel.json segment ('pool' | 'nest')
  kvKeys?: string[];                                      // names under `${site}:${id}:`, listed in /api/status
  schema?: string[];                                      // CREATE TABLE IF NOT EXISTS …, used by the optional registry-extras PR
};
export const kvKey = (siteId: string, id: string, name: string) => `${siteId}:${id}:${name}`;  // identical to today's keys, no migration
export const appliances: Appliance[] = [poolAppliance, acAppliance];
export const available = () => appliances.filter(a => a.available());
export const byId = (id: string) => available().find(a => a.id === id);
export const comingSoon = () => appliances.filter(a => !a.available()).map(a => ({ id: a.id, name: a.name, status: 'coming' as const, watts: null, kwhPerDay: null, savesPerMonth: null, source: a.source }));
// host.ts
export const rateFor: (siteId: string) => Promise<number>;                      // app.ts:326
export async function applianceCtx(req: Request, o?: { fresh?: boolean; act?: boolean }): Promise<Ctx>;
export async function siteCtx(siteId: string, settingsAll: Record<string, any>, o?: { fresh?: boolean; act?: boolean }): Promise<Ctx>;
export async function runTick(name: string): Promise<Record<string, unknown>>;  // forEachSite × plugins that have ticks[name] and are available() && linked(); keys `${id}:${siteId}`
```

The contract names from the brief map onto the plugin file as follows. The host only calls `available`, `linked`, `detail`, `summary`, `actions` and `ticks`. Each plugin file keeps named exports `read` (device read + `record`), `learn` (cached, §3.4) and `plan` (`planFor`). `apply` and `restore` become guarded `actions`, and `tick` becomes `ticks[…]`.

**Routes** (paths, `api.js` and `vercel.json` unchanged):

```ts
app.get('/api/cron/sync', requireCron, …existing…);
app.get('/api/cron/:tick', requireCron, wrap(async (req, res) => res.json(await runTick(req.params.tick))));  // 'pool' at 01:15 UTC, 'nest' every 5 min
// after requireSite
app.get('/api/appliances', …);            // PR server-contract: [...summaries of available(), ...comingSoon()]; PR cheap-list: registry only (§3.5)
app.get('/api/appliances/:id', wrap(async (req, res) => { const a = byId(req.params.id); if (!a) throw new HttpError(404, 'unknown appliance');
  const d = await a.detail(await applianceCtx(req, { fresh: req.query.fresh === '1' })); res.json({ ...d, summary: a.summary(d) }); }));
app.post('/api/appliances/:id/:action', express.json(), wrap(async (req, res) => {
  const a = byId(req.params.id), act = a?.actions?.[req.params.action]; if (!a || !act) throw new HttpError(404, 'unknown action');
  if (act.writes && !(await a.linked())) throw new HttpError(409, `${a.source} is not linked`);
  if (act.writes) console.log(`[appliance] ${a.id}.${req.params.action}`);
  res.json(await act.run(await applianceCtx(req, { fresh: !!act.writes }), req.body ?? {})); }));
// /auth/google and /auth/google/callback stay in app.ts (Google's registered redirect URI; linking is auth, not appliance logic)
```

**Plugin objects.** Each is a move of code that already exists:

```ts
// pool.ts
export const poolAppliance: Appliance = { id: 'pool', name: 'Pool pump', source: 'Pentair ScreenLogic',
  available: configured, linked: async () => configured(),
  detail: ctx => poolDetail(ctx.siteId, ctx.settings, ctx.rate, { fresh: ctx.fresh, act: ctx.act }),
  summary: d => ({ id: 'pool', name: 'Pool pump', status: d.linked ? 'linked' : 'estimated', watts: d.live?.watts ?? null, kwhPerDay: d.current.kwhPerDay, savesPerMonth: Math.max(0, d.current.costPerMonth - d.plan.costPerMonth) }),  // pool.ts:173-176
  actions: { apply: guarded(…app.ts:335-339), 'apply-tomorrow': guarded(…340-347), restore: guarded(…362),
             autopilot: { run: (ctx, b) => { if (!isMode(b?.mode)) throw new HttpError(400, 'mode must be off, suggest or auto'); … saveNamespace … } } },   // 348-354
  ticks: { pool: ctx => poolDetail(ctx.siteId, ctx.settings, ctx.rate, { fresh: true, act: true }).then(d => d.autopilot) },   // 356-361
  kvKeys: ['last', 'applied', 'pending', 'autolog'] };
// ac.ts (acSlope moves here from app.ts:366-379 and uses weather.dailyHighs + kv.memo)
export const acAppliance: Appliance = { id: 'ac', name: 'AC', source: 'Nest', available: nestConfigured, linked: nestLinked,
  detail: async ctx => acDetail(ctx.siteId, ctx.settings, ctx.rate, await ctx.slope(), { fresh: ctx.fresh }),
  summary: d => ({ id: 'ac', name: 'AC', status: d.linked ? 'linked' : 'estimated', watts: d.state?.hvac === 'COOLING' ? Math.round(d.learned.acKw * 1000) : 0, kwhPerDay: d.todayKwh, savesPerMonth: d.plan.costSavedMonth }),  // app.ts:330
  actions: { apply: guarded(…app.ts:382), settings: { run: …383-392 (presence → acTick) } },
  ticks: { nest: async ctx => acTick(ctx.siteId, ctx.settings, ctx.rate, await ctx.slope()) },   // 394-400
  kvKeys: ['plan', 'log', 'slope', 'learned'] };
```

Parity notes:
- Cron response keys become `${id}:${siteId}`. Only Vercel logs read them.
- `runTick` gates every tick on `available() && linked()`. `cron/nest` already does this. `cron/pool` never wrote without a snapshot anyway (`autopilot.ts:72` needs `o.snap`).
- The AC `settings` action stays unguarded at the route, as today. Any Nest write it triggers passes through `assertDeviceWrites` in `exec`.

### 3.4 Learning off the hot path (from B, reworked as a TTL memo rather than a new cron path)

- `learnAcKw` → `kv.memo(kvKey(site,'ac','learned'), 6 * 3600_000, () => learnAcKw(site))`. This removes the N+1 from every `acDetail`, including all 288 `cron/nest` ticks a day. The learned kW becomes at most 6 hours stale (it currently moves on about 16 steps).
- `measuredPoints`: compute once per `poolDetail` (today it runs twice, at `pool.ts:94` and when building `model.measured`), then memo it for 6 h at `kvKey(site,'pool','measured')`.
- `/api/cron/sync` gains one line that refreshes both memos nightly. That is optional; the TTL alone is enough.

### 3.5 Cheap strip list (from B)

`GET /api/appliances` returns `[...available().map(a => ({ id, name, source, status: 'linked'|'estimated' })), ...comingSoon()]` and reads no device and computes no detail. Every detail response already carries `summary` (§3.3). The web host draws the strip's live part (` · 153 W`) from `S[id].summary` once each detail arrives. Result: per 3-minute poll, 2 `poolDetail` + 2 `acDetail` become 1 + 1. The only visible difference is that on first load the watts appear when the detail lands (about 1 to 3 s) rather than with the list (owner question 3).

### 3.6 How things register generically

| Concern | Today | After |
|---|---|---|
| Settings read | `settingsFor` + a per-plugin spread | `ctx.settings` + `settingsOf(all, id, DEFAULTS, deep)` |
| Settings write | 3 copies | `saveSettings` (top level), `saveNamespace(req, id, next)` |
| kv keys | ad-hoc strings | `kvKey(siteId, id, name)`, same strings as today; `kvKeys` listed in `/api/status`; the global link and cache keys (`nest:tokens`, `pool:forecast`, `wx:highs`) stay global |
| Learned models | recomputed per request | `kv.memo(kvKey(…,'learned'|'measured'), 6 h, fn)` |
| Readings tables | `db.ts:72-76` | stay in `db.ts` under `// appliance:<id>` comments. The optional PR adds `registerSchema(...sql)`, which is safe because `app.ts` imports every plugin statically and `migrate()` runs from the first-request middleware (`app.ts:21`) |
| Cron ticks | one route per appliance | `/api/cron/:tick` → `runTick(name)`. A new appliance joins an existing slot (`ticks: { pool: … }` for nightly, `{ nest: … }` for every 5 min) or adds one `vercel.json` line |
| Link/OAuth | `/auth/google` in `app.ts` | unchanged; add `link?` to the contract only when a second OAuth device exists |

### 3.7 Web view contract (from A)

```js
// web/src/appliances/pool.js (git mv from views/appliances.js) and web/src/appliances/ac.js (git mv from views/ac.js)
export default {
  id: 'pool', root: 'applPool',                // existing wrapper id in index.html
  fetch: () => api.appliance('pool'),          // api.js: appliance(id), applianceAction(id, action, body) replace the 9 named calls (same URLs)
  fallback: e => ({ error: e.message }),       // ac: { error, configured: false, linked: false } (ac.js:85)
  init(S, host) { /* seg bindings once; host.reload for Apply/Restore */ },
  draw(S) { /* drawPool as today, minus load/timer/twin boilerplate */ },
  resize() { twin?.resize(); }, render(dt, calm) { twin?.render(dt, calm); }, dispose() { twin = null; },
};
// web/src/appliances/index.js
export const APPLIANCES = [pool, ac];
// web/src/appliances/host.js (~35)
export function createApplianceHost(S, views, { strip, every = 3 * 60_000, onData }) → { select(id), selected(), reload(id), resize(), render(dt, calm), dispose() }
```

What the host does, line by line (each a move):
- Draws the strip (`appliances.js:19`) and handles strip clicks (`main.js:135`).
- `load(id)`: `S[id] = await view.fetch().catch(view.fallback)`, then `view.draw(S)`, then `onData(id)`.
- Runs one 3-minute timer for the list and all views, replacing the two timers at `appliances.js:14` and `ac.js:84`.
- `resize()` goes to every view; a hidden twin returns early. This also fixes the AC twin never being resized from `insSeg` (`main.js:139`).
- `render()` renders only the selected view.
- The AC "Link Nest" card and its `configured`/`linked` branches stay inside `ac.js` `draw()`.

---

## 4. (c) `main.js`: state `S`, render loop, scene lifecycle

`S` stays a plain object and **`S.pool` / `S.ac` stay the data slots**. `drawDayRing` (`main.js:153-156`) and `insights.js:16` keep reading them. B's rename to `S.appl.*` is dropped. The host writes `S[view.id]`. B's `S.on/emit` is replaced by the host's `onData` callback, which replaces the `S.onPool` hack (`main.js:146`, `appliances.js:21`).

Core diff (277 → ~270 lines):

```js
- import { initAppliances, poolTwin } from './views/appliances.js';            // L15
- import { initAc, thermalTwin, drawAc } from './views/ac.js';                 // L16
+ import { createApplianceHost } from './appliances/host.js';
+ import { APPLIANCES } from './appliances/index.js';
- buildFlow(); initHistory(S); initPanels(S); initPlanner(S); initAppliances(S); initAc(S);   // L133
- let applSel = 'pool'; $('applStrip').onclick = …                                            // L134-135
+ buildFlow(); initHistory(S); initPanels(S); initPlanner(S);
+ const appl = createApplianceHost(S, APPLIANCES, { strip: $('applStrip'), onData: id => { if (id === 'pool') safe(drawDayRing)(); } });
- … poolTwin()?.resize(); dayRing.resize(); };                                 // L139 (insSeg)
+ … appl.resize(); dayRing.resize(); };
- S.ringMode = 'now'; S.onPool = () => safe(drawDayRing)();                   // L146
+ S.ringMode = 'now';
- if (isOn('v-ins') && insPanel === 'appl' && applSel === 'pool') poolTwin()?.render(dt, S.calm);   // L189
- if (isOn('v-ins') && insPanel === 'appl' && applSel === 'ac') thermalTwin()?.render(dt, S.calm);  // L190
+ if (isOn('v-ins') && insPanel === 'appl') appl.render(dt, S.calm);
```

The scene lifecycle plugins see is `render(dt, calm)` on visible frames, `resize()` on layout change, and `dispose()` (new; nothing is disposed today). `main.js` keeps the visibility gate because only it knows the tab and panel. `S.calm` and `HIDDEN` stay as they are.

**Optional, B's loop registry**, only if a third animated scene arrives. `web/src/lib/loop.js`: `createLoop(S).add({ id, visible(), render({ dt, T, calm }), resize?() })`. It takes an object argument to avoid B's positional-argument mistake, and it calls `resize()` when a scene goes from hidden to visible. The 24-line `frame()` body (`main.js:174-197`) becomes six `add` calls, and the roof block becomes a named `roofFrame`. Main.js drops to about 255 lines, plus 25 in `loop.js`.

---

## 5. (d) Migration: small PRs, each leaving the app working

All work happens on a branch with `npx vercel deploy --yes` previews, screenshots at 393 px, and a merge only after the owner has tried the preview (rules 1, 2, 6). **No POST and no cron on any preview.** Server PRs are checked with GET diffs `curl … | jq -S 'del(..|.at?, .ts?)'` preview vs production for `/api/appliances`, `/api/appliances/pool`, `/api/appliances/ac` and `/api/settings`. Nest-backed GETs are spaced at least 60 s apart to stay under SDM's 5 queries per minute alongside the 5-minute cron. Rule 4: Apply flows are checked only as far as the `confirm()` text, then Cancel.

| # | PR (item id) | Files | Verification | Lines |
|---|---|---|---|---|
| 1 | `componentize-write-guard` | `server/src/appliances/guard.ts` (new), `server/src/http.ts` (new, `HttpError`), `screenlogic.ts`, `nest.ts`, `app.ts` (error middleware `err.status ?? 500`); Vercel Preview env `APPLIANCE_WRITES=off` | `node --test` guard test; `vercel env ls` shows it on Preview only | +12 |
| 2 | `componentize-learn-cache` | `db.ts` (`kv.memo`), `ac.ts`, `pool.ts`, `autopilot.ts`, `app.ts` (acSlope/highs/forecast use memo) | `tsc`; GET diff (learned values equal) | ≈ −5 |
| 3 | `componentize-ui-static` | `web/src/lib/ui.js`, `ui.test.mjs`, `views/appliances.js`, `views/ac.js`, `views/panels.js`, `views/insights.js`, `views/history.js`, `package.json` | `node --test`; DOM diff; screenshots | +55 ui, −45 views |
| 4 | `componentize-ui-binders` | `ui.js`, `web/src/appliances/cards.js`, the two views, `main.js`, `history.js` | click every seg; each Apply up to the confirm, then Cancel | +25, −30 |
| 5 | `componentize-web-host` | `web/src/appliances/{host,index,pool,ac}.js`, `main.js`, `lib/api.js` | strip switching, both twins render and resize, Day Ring refreshes after pool data, Nest link card when unlinked | +40, −35 |
| 6 | `componentize-server-plumbing` | `settings.ts`, `http.ts` (`requireCron`, `forEachSite`), `weather.ts`, `tesla/client.ts` (`localHour`), `app.ts` (crons before `requireUser`), `pool.ts`, `ac.ts`, `autopilot.ts` | `tsc`; GET diffs | +45 new, −40 moved |
| 7 | `componentize-server-contract` | `appliances/{index,host,pool,ac,autopilot}.ts`, `app.ts` (block 82 → ~24) | `tsc`; GET diffs; Vercel cron logs after the production deploy show both ticks returning `ok` | +90, −60 |
| 8 | `componentize-cheap-list` | `app.ts`, `appliances/host.js`, `appliances/pool.js` (strip draw) | strip still shows watts; request count per poll in the network panel goes from 3 detail requests to 2 | ≈ 0 |
| 9 | `componentize-docs` | `docs/appliances.md` ("add an appliance" checklist, no figures) | review | +40 docs |
| 10 (opt) | `componentize-slots` | `web/src/appliances/slots.js`, `web/index.html` (L243-304 → strip + 2 roots), both views | DOM diff with `data-slot` normalised; screenshots | +35, −60 |
| 11 (opt) | `componentize-registry-extras` | `db.ts` `registerSchema`, `/api/status` kvKeys, `ui.js` `dial24`, `nest:last` → `${site}:ac:last` | `tsc`; `/api/status` | ≈ 0 |
| 12 (opt) | `componentize-loop` | `web/src/lib/loop.js`, `main.js` | every tab renders; resize on tab switch | +25, −22 |
| 13 (opt) | `componentize-step-learner` | `appliances/common.ts` `learnStepKw(siteId, events)` from `learnAcKw` | `tsc` | ≈ +10 |

PR 1 goes first so every later preview is write-safe. PRs 3→5 (web) and 6→7 (server) are independent tracks. PR 8 needs 5 and 7. The optional PRs wait for owner question 1.

### Behaviour notes (not byte-identical, shown up front)

- `hmH(24)` gives `12a`, where today's `ac.js:8` shows `12p` at the scrubber's right end (`index.html:279`, `max="24"`). A rounding case like `h = 8.999` gives `9a`, not `8:60a`. Both are bug fixes and the golden tests record them.
- The learned AC kW and pool watts-per-RPM refresh at most every 6 h (PR 2).
- The strip's watts appear with the detail, not the list (PR 8).

---

## 6. Before and after

| File | Before | After core (PRs 1-9) | After optional slots and loop |
|---|---|---|---|
| `views/appliances.js` → `appliances/pool.js` | 128 (19.6 KB) | ~90 (~14 KB) | ~88 |
| `views/ac.js` → `appliances/ac.js` | 85 (14.4 KB) | ~60 (~10 KB) | ~58 |
| `lib/ui.js` (new) | — | ~75 | ~83 (`dial24`) |
| `appliances/{cards,host,index}.js` (new) | — | ~20 + ~35 + 4 | same (+~35 `slots.js`) |
| `lib/loop.js` (new) | — | — | ~25 |
| `main.js` | 277 | ~270 | ~255 |
| `lib/api.js` | 53 | ~46 | ~46 |
| `index.html` | 387 | 387 | ~327 |
| panels / insights / history | 426 | ~418 | ~418 |
| **Web total** | **1,356** | **~1,405 (+4%)** | **~1,410** |
| `app.ts` | 420 | ~350 | ~350 |
| `appliances/index.ts` + `host.ts` + `guard.ts` | 14 | ~50 + ~40 + 6 | same |
| `settings.ts` + `http.ts` + `weather.ts` (new) | — | ~20 + ~20 + ~35 | same |
| `pool.ts` / `ac.ts` / `autopilot.ts` | 178 / 115 / 83 | ~182 / ~140 / ~70 | same |
| `db.ts` / `screenlogic.ts` / `nest.ts` | 82 / 83 / 61 | ~88 / 84 / 62 | ~90 |
| **Server total** | **1,036** | **~1,147 (+11%)** | **~1,150** |

Plainly: with only two appliances the total grows by about 7%, because the contract and host are new code. What changes:
- The duplicated logic (17 web patterns, 11 server patterns) goes to zero, and the two view files shrink about 30%.
- `app.ts` stops importing pool and AC internals.
- About 1,000 Neon queries per open hour go away (the learn cache and the cheap list).
- Every device write passes one of two guarded chokepoints.
- A third appliance becomes one server file, one web file and a registry line each (about 110 + 60 lines). It needs no `app.ts`, `main.js` or `api.js` edit, and no `index.html` edit after the optional slots PR.
- Build output is unchanged; code splitting belongs to another topic.

---

## 7. Where each idea came from, and what was dropped

**From A (structure):** literal moves with golden-string tests; `lib/ui.js` as one file; `cards.js` prefix composites; `Appliance` with `actions`/`ticks` keyed by today's path and cron segments (no URL, `vercel.json` or `api.js` change); `kvKey` equal to today's keys; `Ctx` with a memoised `slope`; `guarded()` with a linked check; keeping `S.pool`/`S.ac`; the host's `onData`; the resize fan-out fix; the optional `slots`/`registry-extras`/`dial24`; moving crons ahead of `requireUser`.

**From B (grafted):**
- `settings.ts`/`http.ts`/`weather.ts` placement, because those helpers are not appliance-specific.
- `HttpError`.
- The server plumbing as its own PR.
- `summary(detail)` and the cheap `/api/appliances`.
- `learn` off the request path (as a `kv.memo` TTL instead of new cron wiring).
- The `APPLIANCE_WRITES=off` Preview env, moved to the device-client chokepoints.
- A single `seg()` with `confirm`.
- `logRows({ empty })`.
- `data-slot` addressing and server-provided guardrail chips in the optional slots PR, instead of A's id renames.
- The loop registry (optional).
- The `docs/appliances.md` checklist.
- `learnStepKw` (optional, gated).
- The observation that `S.acSlope` (web `insights.js:62-68`) duplicates the server `acSlope`. It is noted, not built here.

**Dropped:**
- **B `store.ts` key rename to `${site}:appl:${id}:*` with legacy read-through and a later `DELETE FROM kv`.** It deletes live data for a cosmetic namespace in a single-owner app. A mistake loses `applied`, which the pool Restore depends on. Rule 6 forbids rewriting tables, and this rewrite is the same kind of risk.
- **B `withLock`.** A kv lock without an atomic insert is not a lock. The button and the 01:15 UTC cron are not realistic contenders.
- **B generic `tickFor`/`applyFor` bookkeeping and the AC Suggest → pending change (B Q2).** The pool plans tomorrow nightly; the AC steps hourly with `lastStepHour`. Unifying them changes code on the device-write path, which rule 4 makes the highest-risk code in the repo, and it is a behaviour change, not a refactor.
- **B route changes** (`/apply?what=pending`, `/settings` replacing `/autopilot`) and the **`vercel.json` `nest`→`ac` cron rename.** No benefit over action names that match today's paths.
- **B `S.appl` + `S.on/emit`.** A rename across `drawDayRing` and `insights.js` for no behaviour gain. `onData` covers the single subscriber.
- **B plugin-mounted OAuth.** Google's redirect URI is registered in GCP. Wait for a second OAuth device.
- **B's four-file UI kit and the `poll` helper.** One file is enough at about 75 lines, and the host owns the only timer.
- **B `scripts/new-appliance.mjs`.** Premature until a third appliance is real.
- **B Q1 header token.** Authentication for the open POST surface is a separate topic. The guard and the action dispatcher are where a token check would go later.
- **B's "change Autopilot mode on the preview" verification step.** Previews share the production database.
- **A's route-level kill switch.** Superseded by the chokepoint guard.
- **A's claims of byte-identical `hmH` and a ~935-line web total.** Corrected above.

## 8. Found while verifying (not fixed in this plan)

1. The `learnAcKw` N+1 inside the 5-minute cron (fixed by PR 2).
2. `measuredPoints` runs twice per `poolDetail` (PR 2).
3. `/api/appliances` repeats both details (PR 8).
4. The AC twin is never resized from `insSeg` (`main.js:139`, fixed by PR 5).
5. The stray `</div>` at `ac.js:74` (PR 3).
6. `drawPool` rebinds `schMode.onclick` every 3 minutes (PR 4).
7. `nest:last` is global (optional PR 11).
8. `initAppliances`/`initAc` run at module load (`main.js:133`) before `boot()` has checked the site. They keep doing so via the host; this is harmless in single-owner mode.
