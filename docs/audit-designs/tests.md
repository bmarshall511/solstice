# Solstice test harness: final design (judged merge)

Phase 1, read-only. I wrote nothing in the repo. To check the numbers, I ran the real functions from `server/src` and `web/src/lib` with `node --import tsx` under Node 22 (in both `TZ=America/Chicago` and `TZ=UTC`), and ran the SQL in PGlite 0.5.8 in memory. Those scripts are in the scratchpad (`judge/v1.mts`, `v2.mts`, `v3.mjs`, `v4.mjs`). In the tables, **✓v** marks a value I re-derived myself. Unmarked values come from a candidate that ran the code, and they get recomputed when the tests are written.

## 0. Verdict

| Criterion | A: pure-model golden lock | B: behaviour specs with bug ratchets |
|---|---|---|
| Fit to the codebase (checked against the code) | 8: the numbers match the code (I checked 20+ of them). But it pins `TZ=America/Chicago` while production (Vercel) runs UTC, it has one wrong claim (it says the month error lands on the 1st of the month; it lands on the last evening of the month), and it moves `pool.ts`/`autopilot.ts`/`ac.ts` into `*-model.ts` files without needing to (importing `pool.ts` does not connect to anything) | 9: the numbers match. `TZ=UTC` matches Vercel. It found **BUG-1** (I confirmed it in PGlite: `'[2,3,6]'::jsonb ?\| array['3']` returns 0 rows). It also found BUG-4 (the season highlight) and BUG-5 (Off does not stop an approved AC plan) |
| Owner value | 7: locks behaviour but misses three real bugs | 9: finds a production data bug that silently disables three Autopilot signals. Its integration specs prove that Suggest mode never writes to ScreenLogic, which is rule 4 as a test |
| Simplicity | 6: three projects, a single fork with `isolate:false` (so tests share state and need TRUNCATE), snapshots on top of explicit asserts, four file moves | 8: two projects, per-file PGlite, table-driven cases, no moves |
| Serverless cost | 10: nothing is added at runtime. The `learnAcKwFrom` refactor removes about 32 queries per `acDetail` call | 10: the same, and the same refactor |
| Privacy (public repo) | 9: `setup.ts` refuses any non-PGlite `DATABASE_URL`, strips the device and Tesla env vars, and blocks every non-localhost `fetch`. The fixture-hygiene test has the fullest regex set | 7: its fixture includes a fake street address (the address regex would flag it), and it adds a git-ignored `tests/fixtures/private/` folder for real bill text. That folder doesn't fit this Mac anyway: `data/bills/` holds parsed JSON, not text |
| Risk | 8: lock first, refactor under the goldens | 7: its "refactor" table mixes in behaviour changes (R5, R6, R7, R11, R13, R15). Its `deploy:*` scripts call `vercel` without `npx` (the Vercel CLI isn't installed, so they would fail). Its `check` script skips the build |
| **Total /60** | **48** | **50** |

**B wins narrowly.** The final design keeps B's spec model: numbered, table-driven cases; `it.fails` ratchets for known bugs; B's bug list; B's integration specs; and B's `acDecision`/`replay` signatures. From A it takes the harness around those specs: three projects with global mocks for the pure tests, the full safety rails, the fixture-hygiene regexes, the `pec.ts` extraction, the Express-over-socket API tests, the extra golden cases, the gating rules for batches that change behaviour, and the single-PEC-parser item. Section 13 lists where each idea came from and what was dropped.

## 1. Toolchain

### package.json (diff)

```jsonc
"devDependencies": { "vitest": "^3.2.4" },       // the only new dependency; @electric-sql/pglite ^0.5.8 is already there; no native deps
"scripts": {
  "test":           "vitest run",
  "test:watch":     "vitest",
  "check":          "npm run typecheck && npm test && npm run build",
  "deploy:preview": "npm run check && npx vercel deploy --yes",
  "deploy:prod":    "npm run check && npx vercel deploy --prod --yes"
}
```

- `test:update` is left out on purpose because there are no snapshots (see section 5).
- Run everything under Node 22 (`nvm use 22`). The default shell on this Mac is v20.19.0. Vitest 3.2 accepts 20, but 22 matches `engines` and `.nvmrc`.
- Vitest 3.2 brings its own vite 7 for transforms. `npm run build` stays on the repo's vite 6.4.3, and both designers confirmed the two copies don't conflict.

### tsconfig.json

Change `"include"` to `["server/src", "api", "tests/server", "tests/db"]`. This makes `npm run typecheck` check the TS specs, which catches signature drift during the refactors in section 6. The JS web specs are skipped because `allowJs` is off. Test files import with the same `.js` specifiers the code uses (`../../server/src/appliances/pool.js`); tsc (NodeNext) and Vitest both resolve them to `.ts`.

### vitest.config.ts (repo root; `web/vite.config.js` stays the build config)

```ts
import { defineConfig } from 'vitest/config';
const serverEnv = { TZ: 'UTC', DATABASE_URL: 'pglite:memory://' };   // UTC = what the Vercel function runs with
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', environment: 'node', include: ['tests/server/**/*.test.ts'], env: serverEnv,
                setupFiles: ['tests/setup.ts', 'tests/server/pure-mocks.ts'] } },
      { test: { name: 'db', environment: 'node', include: ['tests/db/**/*.test.ts'], env: serverEnv,
                setupFiles: ['tests/setup.ts'] } },          // default isolation: one in-memory PGlite per file, files run in parallel
      { test: { name: 'web', environment: 'node', include: ['tests/web/**/*.test.js'], env: { TZ: 'America/Chicago' } } },
      { test: { name: 'hygiene', environment: 'node', include: ['tests/hygiene.test.ts'] } },
    ],
  },
});
```

Why the projects are split this way:

- **`server`** is for pure code only. `pure-mocks.ts` replaces `db.js` with a `q`/`one`/`kv` that **throws** `"db in pure test"`, and mocks `pdf.js`, `screenlogic.js` and `nest.js`. If any function that claims to be pure touches the database, its test goes red. A `vi.mock` in a setup file applies to every file in the project, so nobody can forget it.
- **`db`** runs the real `db.ts` on PGlite. Every file gets a fresh database, so there's no TRUNCATE bookkeeping (this is B's choice over A's `singleFork` + `isolate:false`). **Budget: at most three files in `tests/db/`.**
- **`web`** runs in Chicago time because the browser does.
- Tests that need another TZ set `process.env.TZ` inside the test and restore it afterwards. B verified that Node re-reads `TZ` at runtime.

### Directory layout (one `tests/` tree, never beside the source)

```
vitest.config.ts
tests/
  setup.ts                 safety rails (section 3), used by server + db
  hygiene.test.ts          privacy guard (section 5)
  fixtures/
    README.md              policy: hand-written, synthetic, 2026 dates, zero real accounts/readings/tokens; nothing derived from data/
    pec-bill.ts            synthetic pdftotext-shaped PEC bill (section 8, case 25) + mutation helpers
    forecast.ts            Open-Meteo-shaped payloads (server Daily[] and web hourly GTI)
    screenlogic.ts         PoolSnapshot: pump id 1, circuits Pool 6 / High Speed 8 / Waterfall 5 / Spa 1 / freeze 132, 3 schedules
    nest.ts                NestState: deviceId 'dev-test', mode COOL, coolF 80, hvac OFF, humidity 45
    tesla.ts               6 calendar_history buckets (not 288) for syncSite
  server/
    pure-mocks.ts
    pool-model.test.ts     powerModel, gpmAt, hourlyRpm, seasonOf, turnoverPerDay, integrateExtras, spaSession
    pool-plan.test.ts      planFor (pool), planDay, pollenFor, heatDaysAt, parseOpenMeteo
    ac.test.ts             planFor (AC), stepAt, acDecision, learnAcKwFrom, nearestKw, runtimeFrom, heatSlope, mergeAcSettings, outdoorUnitLabel
    planner.test.ts        replay, loanPayment, systemEconomics
    dates.test.ts          rfc3339, localMidnight, localDay, addDays, dayWindow, energyRow, warrantedDcPct, systemYear
    bills.test.ts          parsePecText (from pec.ts), gapPct, reconcileBill, whToKwh
  db/
    db.test.ts             migrate, kv, saveEnergyRows upsert, measuredPoints, BUG-1 ?| ratchet, saveBill/listBills
    api.test.ts            Express app on 127.0.0.1:0 + fetch (no supertest)
    integration.test.ts    autopilot() suggest/auto, acTick stepping, syncSite with a fake Tesla client
  web/
    model.test.js          learnYield, forecast48
    util.test.js           fmtDur, clock12, hourLabel, money, money2, kwh, addDays, localDate, localHour, niceDate, sunAt
    weather.test.js        WMO, WICON, hourlyIndex (the fetch builders are never called)
```

Tests live outside `server/` and `web/` so that neither Vercel's function trace of `api/index.ts` nor `vite build` ever picks one up. It also gives one place to audit for personal data.

## 2. Database tests with PGlite

- `DATABASE_URL=pglite:memory://` comes from the config `env`, so it overrides anything exported in the shell. `db.ts` then calls `new PGlite('memory://')`. Vitest does not load `.env`.
- `beforeAll(migrate)` runs the real `CREATE TABLE IF NOT EXISTS` schema, so the tests run the same SQL Neon runs. Both designers verified `PERCENTILE_CONT … WITHIN GROUP`, multi-array `unnest` upserts and the `jsonb` operators in PGlite.
- Only the three files in `tests/db/` execute queries. A PGlite boot costs about 1.0–1.4 s, and the files run in parallel.

## 3. Safety rails: `tests/setup.ts` (A's version, plus B's fake-clock note)

```ts
import { vi, beforeAll } from 'vitest';
beforeAll(() => {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('pglite:')) throw new Error(`tests refuse to run against DATABASE_URL=${url.slice(0, 12)}…`);
  for (const k of ['SCREENLOGIC_SYSTEM', 'SCREENLOGIC_PASSWORD', 'NEST_PROJECT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
                   'TESLA_CLIENT_ID', 'TESLA_CLIENT_SECRET', 'TESLA_REDIRECT_URI', 'CRON_SECRET', 'SETUP_TOKEN', 'POSTGRES_URL']) delete process.env[k];
});
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', (input: any, init?: any) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.startsWith('http://127.0.0.1')) return realFetch(input, init);      // only the in-process Express app
  throw new Error(`unmocked fetch in test: ${u}`);
});
```

What this guarantees:

- `configured()` (ScreenLogic) and `nestConfigured()` are false unless a test mocks the module. So even a forgotten mock cannot open a ScreenLogic or Nest connection.
- Open-Meteo, Tesla, ERCOT, NWS and Google fail loudly unless the test mocks them.
- `config.clientId` and the other Tesla config values are lazy getters in `config.ts`, so stripping the env vars breaks nothing until something calls `teslaFor`, and that is always mocked.
- Only `Date` is ever faked: `vi.useFakeTimers({ toFake: ['Date'], now })`. B verified that this leaves PGlite's own timers working.

## 4. Mocking policy

| Dependency | `server` project (pure) | `db` project |
|---|---|---|
| `db.ts` (Neon/PGlite) | global mock whose `q`/`one`/`kv` throw | real, on PGlite |
| `pdf.ts` (pdf.js loads in 0.3–0.75 s) | global mock `{ pdfToLayoutText: vi.fn() }`, not needed once `parsePecText` lives in `pec.ts` | mocked in `api.test.ts` unless a bill upload is exercised |
| `appliances/screenlogic.ts` | global mock: `configured: () => false`, `readPool`/`writePoolPlan`/`withUnit` are `vi.fn()` | `integration.test.ts`: `configured: () => true`, `readPool` returns `fixtures/screenlogic.ts`, `writePoolPlan` records its calls and returns `{ removed: [], added: [11, 12] }`. The real module and `node-screenlogic` are never loaded |
| `appliances/nest.ts` | global mock: `nestConfigured: () => false`, `setCool: vi.fn()` | `integration.test.ts`: `nestConfigured: () => true`, `nestLinked: async () => true`, `readNest` returns the fixture, `setCool` records `(deviceId, f)` |
| Open-Meteo (server `forecast()`) | pass `Daily[]` straight to `planDay`, and call `parseOpenMeteo` on fixture JSON | **seed `kv 'pool:forecast'` with `{ at: Date.now(), days }`** so `forecast()` returns the cache and never fetches (B) |
| Open-Meteo (web) | n/a | n/a; `forecast48` and `learnYield` take plain objects |
| Tesla Fleet API | n/a | partial `vi.mock('…/tesla/client.js')` that replaces only `teslaFor`, so the date helpers stay real |
| Clock | `vi.useFakeTimers({ toFake: ['Date'], now })` only where code reads the clock | same |

## 5. Fixtures and privacy policy (public repo, rule 5)

- **Everything is synthetic and hand-written.** No test reads `data/`, `secrets/` or `mockups/d-rooftop.html`, and no fixture is derived from them. `tests/fixtures/README.md` says so.
- **The PEC fixture** uses public tariff numbers only: 0.072 energy + 0.030346 PCRF = 0.102346, a 0.071921 DG credit, $32.50 service availability, and a 3.96 % franchise fee. These are the same numbers `app.ts` already hard-codes as its fallback, so the test also proves the parser and the fallback agree. Meter `12345678`. **No service-address line, no account number, no name.**
- **Money in tests** uses obviously round placeholders: `{ priceUsd: 10000, taxCreditPct: 30, loanYears: 10, loanRatePct: 5 }`. The owner's real loan terms (which are currently visible on the public `/api/settings`) must never appear.
- **No snapshots.** A used `toMatchSnapshot()` on summarised objects. The final design uses explicit numeric expects plus one **key-shape assertion** per view-facing object instead (for example `expect(Object.keys(plan)).toEqual([...])` for the fields `web/src/views/ac.js` reads: `steps, precool, precoolFrom, precoolTo, coastFrom, coastTo`, and `learned.acKw/samples/source`). This avoids a careless `-u` hiding a regression and keeps the PR diffs readable.
- **`tests/hygiene.test.ts`** (A's regexes, B's wider scope, plus mockups and docs):
  - over `tests/**`, excluding the hygiene test itself: no run of 9 or more digits other than all zeros; no `$` amount of 1,000 or more (`/\$\s?\d{1,3}(,\d{3})+/`); no `(Loan|Payback|Account #)` followed by a non-zero figure; no street-address shape (`/\d{3,5} [A-Z][a-z]+ (St|Dr|Ln|Rd|Ct|Cir|Blvd|Trl|Way)\b/`).
  - over `tests/fixtures/**`: only 2026 dates.
  - over `mockups/*.html` and `docs/*.md`: no `/(loan|net cost|payback|price|system cost)[^$\n]{0,40}\$\s?\d/i`. **Today this fails on `mockups/g-insights.html`**, so it lands as the ratchet `it.fails('PRIV-1 …')`. It flips when the privacy batch replaces those figures with placeholders. Git history still holds them, and rule 6 forbids rewriting it; that belongs to the privacy topic.

## 6. Refactors required to make the code testable

### 6a. Refactors that don't change behaviour (item tests-T4)

Pure functions stay next to the code they come from; there are no `*-model.ts` moves. **The one move is `bills.ts` → `pec.ts`**, which keeps pdf.js out of the pure suite and gives the bill script something to import. The callers delegate to the new functions. Nothing changes an HTTP response, a stored row or a device write. The wave-1 specs (tests-T2 and tests-T3) must stay green through this item; that is the proof.

| # | File | New export / signature | Source today |
|---|---|---|---|
| X1 | `server/src/pec.ts` (new); `bills.ts` re-exports it | `parsePecText(text: string): Bill`, plus `money`, `num`, `isoDate`, and the `Bill`/`Charge` types | `bills.ts` lines 4–75 |
| X2 | `appliances/pool.ts` | export `dayKwh`, `hoursOn`, `onSolarPct`; `export const POOL_DEFAULTS` (the existing `DEFAULTS`); export `UV_W`, `WATER_BY_MONTH`, `FREEZE_CIRCUIT` | module-private today |
| X3 | `pool.ts` | `measuredPoints(siteId)` exported for `db.test.ts` | line 94 |
| X4 | `pool.ts` | `seasonOf(month: number): 0\|1\|2\|3` (0 = Dec–Feb … 3 = Sep–Nov), and `seasonTable(o: { month: number; solarKw: number[]; settings: PoolSettings; W: (r: number) => number; rate: number; names: Map<number,string> }): Season[]`. `seasonTable` **keeps today's `current` formula** until tests-T8 | `poolDetail` lines 122–126 |
| X5 | `pool.ts` | `turnoverPerDay(prof: ReturnType<typeof hourlyRpm>, designGpm = 120): number`. `poolDetail` calls it **without** `designGpm` for now, which is today's behaviour | line 144 |
| X6 | `pool.ts` | `integrateExtras(readings: Array<{ ts: number; hour: number; running: boolean; circuits: number[] }>, loads: Record<string, number>, uv: boolean): { hourly: number[]; kwh: number }` (10-minute gap cap) | lines 116–117 |
| X7 | `pool.ts` | `currentSchedules(snap: PoolSnapshot \| null): { names: Map<number,string>; speeds: Map<number,number>; current: Array<Sched & { rpm: number; name: string }> }` | lines 109–112 |
| X8 | `pool.ts` | `spaSession(snap: PoolSnapshot \| null, s: PoolSettings, W: (r: number) => number, rate: number, spaRpm: number): SpaSession` | lines 135–138 |
| X9 | `appliances/autopilot.ts` | export `useDays(siteId)`; export `pollenFor(month)`; `heatDaysAt(days: Daily[], i: number): number`; `parseOpenMeteo(json: unknown): Daily[]` (`forecast()` becomes cache + fetch + `parseOpenMeteo`); export the `Daily` type | lines 20–34, 59 |
| X10 | `appliances/ac.ts` | `export type AcRec = { date: string; approved: boolean; lastStepHour: number \| null }` and `acDecision(o: { settings: AcSettings; plan: AcPlan; hour: number; state: Pick<NestState,'mode'\|'coolF'> \| null; rec: AcRec \| null }): { rec: AcRec; set?: { next: number; target: number; final: boolean; text: string } }`. It covers the rec default, auto-approval, the stepping rule and the band clamp **verbatim**. `acTick` becomes: `acDetail` → `acDecision` → `setCool` + `kv` writes | `acTick` lines 102–111 |
| X11 | `ac.ts` | `learnAcKwFrom(readings: Array<{ ts: number; hvac: string }>, kwAt: (ts: number) => number \| undefined): { coolKw: number \| null; heatKw: number \| null; samples: number; heatSamples: number }` and `nearestKw(buckets: Array<{ epoch: number; homeWh: number }>, ts: number, windowMs = 300_000): number \| undefined` (returns `homeWh·12/1000` of the nearest bucket; on a tie the earlier bucket wins). `learnAcKw(siteId)` becomes **two queries**: the readings, plus one energy query for `epoch BETWEEN min(ts)−5 min AND max(ts)+5 min`. Today it runs 2 queries per HVAC switch (about 32 or more per `acDetail`, every 5 minutes) | lines 23–36 |
| X12 | `ac.ts` | `runtimeFrom(readings: Array<{ ts: number; hvac: string }>): { minutes: number; duty: number \| null }` | lines 38–42 |
| X13 | `ac.ts` | `mergeAcSettings(settingsAll: Record<string, any>): AcSettings`; `export const AC_DEFAULTS`; `outdoorUnitLabel(heatKw: number \| null): string` | lines 10, 79, 95 |
| X14 | `ac.ts` (moved from `app.ts` `acSlope`) | `heatSlope(points: Array<{ t: number; u: number }>): number` (at least 10 points: OLS slope clamped to [0.5, 6]; otherwise 2.5; NaN falls back to 2.5). `acSlope` keeps the kv and Open-Meteo plumbing | `app.ts` about lines 370–378 |
| X15 | `server/src/planner.ts` (new, moved from `app.ts` `/api/whatif`) | `replay(rows: Array<{ day: string; hour: number; s: number; h: number }>, o: { solarScale: number; capKwh: number; maxKw: number; reserve: number; extraEveningKwh: number; tariff: { importRateAllIn: number; exportCredit: number \| null } }): { importKwh; exportKwh; solarKwh; homeKwh; selfPowered; batteryFullDays; netCost }`; `loanPayment(priceUsd: number, ratePct: number, years: number): number \| null`; `systemEconomics(sys, savesPerYear: number, now: number): SystemEconomics \| null`. The route keeps the SQL and calls these | `app.ts` lines 294–319 |
| X16 | `server/src/reconcile.ts` | `whToKwh(wh: unknown): number \| null`; `gapPct(billed: number \| null, measured: number \| null): number \| null`; `reconcileBill(bill: Bill, tesla: Totals, lastYear: Totals): ReconcileRow` (the async-map body verbatim). `reconcile(siteId)` maps over `reconcileBill` | lines 10, 19, 16–35 |
| X17 | `server/src/sync.ts` | `export const energyRow = (b: EnergyBucket): EnergyRow` (the `cols` mapping); export `EnergyRow` | lines 30–37 |
| X18 | `server/src/tesla/client.ts` | `dayWindow(day: string, now = Date.now()): { start: Date; end: Date }`. It **keeps** `end = min(now, start + 864e5 − 1000)` until tests-T8. `fetchDay` calls it | `sync.ts` line 58 |
| X19 | `server/src/app.ts` | `export { summary as siteSummary }` (low priority) | already pure |

`web/src/lib/model.js`, `util.js` and `weather.js` need no refactor; they are pure ESM already. `planFor` (pool and AC), `stepAt`, `powerModel`, `gpmAt`, `hourlyRpm`, `planDay`, the date helpers, `warrantedDcPct` and `systemYear` are already pure and exported.

### 6b. Fixes that change behaviour (tests-T7 and tests-T8, each needs its own approval)

Each fix flips exactly one ratchet in section 7. **None of them is part of the harness.**

## 7. The bug ratchet (B's mechanism, with A's quirks folded in)

Known bugs land as `it.fails('BUG-n …')`, which asserts the **intended** value; a comment above records today's value. Vitest passes an `it.fails` test only while its assertion fails. That means `main` stays green while the bug stands, and the test goes red when a batch fixes the behaviour without flipping the marker to `it`. A marker flipped without a fix also goes red. The fix PR lists the tags it flipped, and review checks that list against the batch's approved items. B verified the mechanism on BUG-2.

| Tag | Where | Today (✓v = re-derived) | Intended | Fix item |
|---|---|---|---|---|
| **BUG-1** | the `circuits ?\| array[...]` predicates in `useDays`, in `autopilot`'s `yesterdayUsed`, and in `poolDetail`'s `lightReadings30d` | `recordReading` stores numbers (`[2,3,6]`), and `?\|` matches only string elements. ✓v: 0 rows. So the pool-use signals never fire, "+1 h: the pool was used yesterday" can never appear, and `lightReadings30d` is always 0 | `EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) e WHERE e = ANY($n::text[]))` ✓v: 1 row | T7 |
| **BUG-5** | `acTick` | with `autopilot: 'off'` and a same-day `{approved: true}` record, it still calls `setCool` | depends on owner question 1 | T7 |
| BUG-2 | pool `planFor` window | with all-zero `solarKw`, `bestSum = -1` makes the run start at 05:00 in the dark (✓v: 75 °F gives 5–13; 88 °F gives 5–14 with boostAt 5) | `let best = 8, bestSum = 0` gives start 8 | T8 |
| BUG-3 | `hourlyRpm`/`dayKwh` split hour | 10:00–10:30 at 1500 plus 10:30–11:00 at 2400 bills hour 10 as `{2400, 1}` = **0.798 kWh** ✓v | per-slice integration, **0.482 kWh** ✓v (owner question 3) | T8 |
| BUG-4 | `poolDetail` season `current` flag | wrong for months 3, 4, 6, 7, 9 and 10. For example, in October the table highlights Dec–Feb (verified by reading the code) | `seasonOf(m)` for m = 0..11 is `[0,0,1,1,1,2,2,2,3,3,3,0]` | T8 |
| BUG-6 | `planDay` month, plus `new Date().getMonth()` in `poolDetail` and `pollenFor` | `new Date('2026-10-01').getMonth()` is **8 under Chicago, 9 under UTC** ✓v. In production (UTC), the `new Date()` calls roll over to next month from 19:00 Central on the **last** day of each month | `Number(date.slice(5, 7)) - 1`, and a Chicago-based `localMonth()` | T8 |
| BUG-7 | `poolDetail.current.turnoverPerDay` | ignores `settings.designGpm` (latent: the default is 120) | `turnoverPerDay(prof, settings.designGpm)` | T8 |
| BUG-8 | AC `planFor`, heat wave | high 101 with the peak at 14:00: the step moves to 11 but **`precoolFrom` stays 12** and the text says "from 12:00 to 17:00" ✓v | compute `from = high >= 100 ? 11 : Math.max(11, peak − 2)` before building the steps | T8 |
| BUG-9 | `dayWindow` / `fetchDay` | on 2026-11-01 (a 25-hour day) the window ends at `2026-11-01T22:59:59-06:00` ✓v, so 23:00–23:59 CST is never fetched. On 2026-03-08 (23 hours) it overlaps the next day by one hour | `end = min(now, localMidnight(addDays(day, 1)) − 1 s)` | T8 |
| BUG-10 | `forecast48.low` | starts as `{ soc: 1, h: 0 }` and later becomes `{ soc, t }` | `{ soc: 1, t: null }` | T8 |
| Q1 | `hourlyRpm` when `start === stop` | treated as all day (✓v: 24 hours on) | zero length means off | T8 |
| PRIV-1 | `mockups/g-insights.html` | contains loan and cost dollar figures | no match | privacy topic |

These are **noted but not ratcheted**, because neither can happen today:

- A's Q4: `acDecision` can issue a no-op `setCool` when the step's target clamps onto the current setpoint. `planFor` only ever emits steps inside `[min(homeLo,nightLo), max(homeHi,nightHi,awayF)]`, so this is unreachable; the clamp is still covered in the `acDecision` table.
- A's Q7: `addYears('2024-02-29', -1)` returns `'2023-02-29'`. That's harmless in a string range comparison.

## 8. First batch: 33 concrete cases (tests-T2 and tests-T3, no app-code change)

Shared inputs:

- `S = POOL_DEFAULTS` (copied into the test until X2 exports it): 14,995 gal, design 120 GPM, 1500/2400 RPM, circuits 6/8, UV on.
- `W0 = powerModel([])`; `W1 = powerModel([{1500,153},{1800,287}])`; rate 0.1064.
- `BELL = [0,0,0,0,0,0,0,.5,1.5,3,4.5,5.5,6,6,5.5,4.5,3,1.5,.5,0,0,0,0,0]` kW.
- `SOL = [0,0,0,0,0,0,.2,1,2.5,4,5.5,6.5,7,7.2,6.5,5.5,4,2.6,1,.2,0,0,0,0]` kW.
- `AC = AC_DEFAULTS`: band 74–78, night 74–76, away 80, night 22→7, depth 2, coast 78, step 2, humidity cap 60.
- `sun13[h] = max(0, 1 − |h−13|/7)`.

### Pool power and flow (`pool-model.test.ts`)

| # | Case | Expected |
|---|---|---|
| 1 | `W0` at 0/200/450/1000/1500/1790/1800/2400/3000/3450/4000/5000 | 0 / 20 / 20 / 49.211 / **166.088** (cube law) / 287 (±25 snap) / 287 / **798.118** (log-log, k = 3.5553) / 1764.427 / 2900 / 3200 / 3200 ✓v |
| 2 | `W1` at 1500/1650/1000/2400; `powerModel([{400,100},{1500,0},{1750,250}])` | 153 / 212.571 / 45.333 / 798.118 ✓v; second set: 400 RPM and the 0 W point are dropped, and 1750 suppresses the 1800 default, so W(1800) = **276.770** and W(1500) = 157.434 ✓v |
| 3 | `gpmAt` at 3450; 1500; (1500, 100); 0; 1800 | 120; 52.174; 43.478; 0; 62.609 |
| 4 | `hourlyRpm` with speeds {6: 1500, 8: 2400}: Pool 600–1140; plus High Speed 840–900; start 615; wrap 1380→300; circuit 99 | hours 10–18 `{1500, 1}` (9 h on); h14 `{2400, 1}` with h13 and h15 `{1500, 1}`; h10 frac .75; on hours `{23, 0, 1, 2, 3, 4}`; all zero |
| 5 | ratchets **Q1** (600–600) and **BUG-3** (split hour 10) | `it.fails`: 0 hours on (today 24 ✓v); hour-10 energy 0.482 kWh (today 0.798 ✓v) |

### Pool plan (`pool-plan.test.ts`): `planFor({ waterTemp, solarKw, settings: S, W, rate: .1064, month: 8, names: new Map() })`

| # | Case | hours, boost, start–stop, boostAt | kWh/day, $/mo, onSolar %, turnover/day, uvKwh |
|---|---|---|---|
| 6 | BELL, 50 / 65 / 75 °F | 5,0,10–15 / 7,0,9–16 / 8,0,9–17, boostAt null (turnovers .6 / .75 / 1) | 1.1, 4 / 1.6, 5 / 1.8, 6, all 100 %; turnover 1.04 / 1.46 / 1.67 ✓v |
| 7 | BELL, 88 / 100 / 130 °F | 9,1,8–17,12 / 10,1,8–18,12 / **12 (clamp)**,1,7–19,12 | 2.7, 9, 100, 1.88, .54 / 2.9, 9, 2.09, .6 / 3.3, 11, 2.51, .72 ✓v |
| 8 | BELL 88 °F schedule shape | `schedules` = `[{6,480,1020,1500,'Pool'},{8,720,780,2400,'High Speed'}]`; `why[0]` = "9 h of filtration at 1,500 RPM, 1.25× turnover of 14,995 gal, while the panels are producing"; key-shape assertion on the plan object | — |
| 9 | SOL, 88 / 55 / 30 / 120 °F; 88 with `W1` | 9,1,9–18,13 / 6,0,10–16 / 4,0,11–15 / 12,1,7–19,13; with W1: same shape | 2.7, 9 / 1.4, 4 / 0.9, 3 / 3.3, 11; with W1: **2.6, 8** ✓v |
| 10 | variants: `force {hours 4, boost 0}` at 88 (BELL); `uv: false` at 75 | 4 h 11–15, boostAt null; **boost 1** (without UV the boost rule is t ≥ 70) | 0.9; 2.0, uvKwh 0 |
| 11 | ratchet **BUG-2**: all-zero solar at 75 | `it.fails`: start 8, stop 16 (today 5–13 ✓v) | — |

### Autopilot day plan (`planDay`). Base day: `{ date '2026-07-15', high 85, rainMm 0, rainPct 0, sunKwhM2 6, hourlySun BELL/7.56 }`, water 88, pollen low

| # | Adjustment | Expected |
|---|---|---|
| 12 | none | 9 h, boost 1, 8–17, `why: []`, and `plan` **is the very `planFor` object** (no re-plan) |
| 13 | `prev.rainMm 5` / day 5 mm with 60 % / day 5 mm with 59 % | 10 h 8–18, "+1 h and a skim boost: rain yesterday brings debris" / same with "rain likely" / base (59 % is not rainy) |
| 14 | `heatDays 3` / `high 96.4` / both | 11 h 7–18, "+2 h: day 3 of a heat wave (highs ≥ 95°F)" / 10 h, "+1 h: high of 96°F" / only the +2 |
| 15 | `useYesterday` / pollen high at water 65 / water 50 / sun 2 kWh/m² / rain + heat + use | 10 h, "+1 h: the pool was used yesterday" / 6 h, boost 1, `['skim boost: oak pollen season','−1 h: water below 70°F']` / 4 h / base hours plus "cloudy: the run follows the brightest hours" / **12 h clamp**, 7–19, three reasons |
| 16 | ratchet **BUG-6**: date `'2026-10-01'` with `process.env.TZ = 'America/Chicago'` inside the test | `it.fails`: `plan.month === 9` (today 8 ✓v; under UTC it passes as 9 ✓v, which is asserted as a plain `it`) |

### AC plan (`ac.test.ts`): `planFor({ date '2026-07-15', high 96, sunKwhM2 6, hourlySun: sun13, settings: AC, acKw 2.016, slope 2.5, rate .1064, humidity null })`

| # | Case | Expected |
|---|---|---|
| 17 | hot and sunny | steps `[[7,76],[11,74],[16,78],[20,76],[22,76]]`, precool true, 11–16, coastTo 20, **kwhSaved 0.6, costSavedMonth 2** ✓v (pinned to today's formula; owner question 2); why = `['Pre-cool to 74° from 11:00 to 16:00 while the panels peak (6 kWh/m² of sun, high 96°)', 'Coast to 78° until 20:00 so the batteries carry a lighter evening']` |
| 18 | ratchet **BUG-8**: high 101, `sun14` | plain `it`: steps `[[7,76],[11,74],[17,78],[21,76],[22,76]]`, coastTo 21, third why "Heat wave: pre-cool starts at 11:00 so the system never falls behind" ✓v. `it.fails`: `precoolFrom === 11` and why[0] contains "from 11:00" (today 12 ✓v) |
| 19 | no pre-cool: high 85 / sun 4 / humidity 65; boundary high 88 with sun 4.5 | steps `[[7,76],[21,76],[22,76]]`, with "Mild day (high 85°): no pre-cool needed" / "Cloudy: no solar surplus to pre-cool with" / "Humidity 65%: no coast, holding 76°"; the boundary gives precool **true** |
| 20 | away; band 72–73 with night 70–72; slope 4 | `[[0,80,'marked away']]`, coastTo 21, "Away: holding 80° until you mark Home", `stepAt(away, 5).coolF === 80`; mid 73, deep 72, coast 73, night 72, kwhSaved **0** (the negative is clamped); kwhSaved **1.0**, $3 |
| 21 | `stepAt(#17)` at 0, 3, 6, 7, 10, 11, 15, 16, 19, 20, 21, 22, 23 | step hours 22,22,22,7,7,11,11,16,16,20,20,22,22 and coolF 76,76,76,76,76,74,74,78,78,76,76,76,76 ✓v (hours before the first step wrap to the last one) |

### Dates and system (`dates.test.ts`), under both TZ=UTC and TZ=America/Chicago (loop), which proves the Intl helpers don't depend on TZ

| # | Case | Expected |
|---|---|---|
| 22 | `rfc3339` | `2026-09-24T05:00Z` → `2026-09-24T00:00:00-05:00`; `2026-01-15T06:00Z` → `…T00:00:00-06:00`; `2026-03-08T07:59:59Z` → `2026-03-08T01:59:59-06:00`; `2026-03-08T08:00Z` → `2026-03-08T03:00:00-05:00` ✓v; `2026-11-01T06:30Z` → `2026-11-01T01:30:00-05:00` and `T07:30Z` → `01:30:00-06:00` ✓v (01:30 happens twice); with `'UTC'` as the zone → `+00:00` |
| 23 | `localMidnight`; `localDay` | 03-08 → 06:00Z, 03-09 → 05:00Z, 11-01 → 05:00Z, 11-02 → 06:00Z, 09-24 → 05:00Z ✓v; so 03-08 is **23 h** and 11-01 is **25 h**. `localDay(2026-09-25T04:59Z)` = `2026-09-24`; `T05:00Z` = `2026-09-25` |
| 24 | `addDays`; `warrantedDcPct`; `systemYear` | 03-08+1 = 03-09; 11-01+1 = 11-02; 01-01−1 = 2025-12-31; 12-31+1 = 2027-01-01; 2024-02-28+1 = 02-29; **2026-09-25 − 437 = 2025-07-15** ✓v (the backfill horizon); −365 = 2025-09-25 ✓v. `warrantedDcPct(0,1,2,6,10,25,30)` = 98, 98, 97.75, 96.75, 95.75, 92, 92; `systemYear('2026-09-25')` = 6 |

### Bills (`bills.test.ts`, importing `pec.js` once X1 lands; until then `bills.js` with pdf.ts mocked)

Fixture: `tests/fixtures/pec-bill.ts` exports this text (✓v parsed):

```
Pedernales Electric Cooperative                 Bill Date:  09/15/2026
                                                 Due Date: 10/06/2026

Meter        From       To        Days   Previous   Present   Mult   Usage    Register
12345678     08/12/26   09/11/26   30     10,000     11,200    1      1,200    Delivered
12345678     08/12/26   09/11/26   30     5,000      5,300     1      300      Received

Service Availability Charge                                   $32.50
Energy Charge                     1,200 kWh @ $0.072000       $86.40
Power Cost Recovery Charge        1,200 kWh @ $0.030346       $36.42
Distributed Generation Credit       300 kWh @ -$0.071921     -$21.58
Franchise Fee                                                  $6.15
Paperless Billing Credit                                      -$2.50
Current Charges                                              $137.39

Total energy use      Total energy use
   1,200      1,350
   $137.39    $151.20
Average temperature
This month vs. this month last year
   1,500     45
   $150.25   88°
 kWh/Day
```

| # | Case | Expected |
|---|---|---|
| 25 | `parsePecText(fixture)` | billDate `2026-09-15`, dueDate `2026-10-06`, period `{2026-08-12, 2026-09-11, 30}`, delivered 1200, received 300, total 137.39, 6 charges, tariff `{importRate .102346, importRateAllIn .1064, exportCredit .071921, fixedMonthly 32.5, discounts −2.5, franchisePct .0396}` (this is **exactly the `app.ts` fallback**), comparison `{1200, 1350, 1500, 45, 150.25, 88}`, checks `{true, true}` ✓v |
| 26 | mutations | no `Delivered` line throws "Couldn't find the meter readings. Is this a PEC bill?"; no `Current Charges` throws "Couldn't find the bill total."; no `Bill Date` makes billDate fall back to `2026-09-11`; no `Received` gives receivedKwh 0; present 11,199 makes registersConsistent false; total $137.40 still gives lineItemsSumToTotal true (off by less than .02), and $138.39 gives false |

### Web (`tests/web/*.test.js`)

| # | Case | Expected |
|---|---|---|
| 27 | `learnYield`: solar 50/60/70/80/90 with GTI 10, plus solar .5 (excluded, ≤ 1) and GTI 2 (excluded, ≤ 2.5); B's set {42/6, 40/5, 36/4, 30/3, 10/2, .5/5}; `[]` | **8** (ratios [5..9], index floor(5 × .6) = 3) ✓v; **9** ✓v; null |
| 28 | `forecast48`, surplus: GTI `[0,500,1000,800]` from `2026-09-25T10`, soc0 50, yieldK 8, profile 2 kW, 27 kWh / 10 kW / 20 % | s `[4,8,6.4,0]`, soc `[.57037,.78148,.93630,.85832]`, g all 0, importKwh 0, full null, low `{.85832, '2026-09-25T13:00'}` ✓v. A's case (GTI `[0,100,400,800,900]` from 06:00, soc0 40): s `[3.2,6.4,7.2,0]`, soc `[.44222,.59704,.78,.70203]`, low `t '2026-07-15T09:00'` ✓v |
| 29 | `forecast48` deficit (profile 12 kW) / full (GTI 2000, soc 95, profile 0); ratchet **BUG-10** with 2 rows | soc pinned at .2 after k0, g `[.305,4,5.6,12]`, importKwh 21.905 / soc `[1,1,1]`, full `'…T10:00'`, g `[−14.579,−16,0]`; `it.fails`: `low.t === null` |
| 30 | `util.js` | `fmtDur(1.5)` = '1h 30m', `(.25)` = '15m', `(0)` = '—'; `clock12(13.5)` = '1:30 PM', `(0)` = '12:00 AM', `(25)` = '1:00 AM'; `hourLabel` 0/12/23 = '12a'/'12p'/'11p'; `money(-1234.5)` = '−$1,235'; `money2(-3.456)` = '−$3.46'; `addDays('2026-11-01',1)` = '2026-11-02'; `localDate(2026-09-25T04:59Z)` = '2026-09-24'; `localHour(2026-09-25T04:30Z)` = 23.5; `sunAt('2026-06-21T18:00Z')` elevation 79.79° azimuth 131.36°; `'2026-12-21T18:00Z'` 35.64° / 171.55°; `WMO` 0 Clear, 3 Overcast, 45 Fog, 61 Rain, 95 Storms |

### Database (`tests/db/db.test.ts`, tests-T3)

| # | Case | Expected |
|---|---|---|
| 31 | `migrate()` twice; kv round-trip `{x: 1}`; `kv.set(k, null)`; missing key; `saveEnergyRows` with 2 rows, then an upsert of 1 with a new solar value | no-op; `{x: 1}`; `null`; `undefined`; still 2 rows, value replaced |
| 32 | `measuredPoints` (X3; before X3, the same SQL inline) on 3 readings each of {150,153,160} W at 1500 and {285,287,290} W at 1800, plus 2 at 2400 | `[{1500,153},{1800,287}]`; 2400 is dropped by `HAVING COUNT(*) >= 3` |
| 33 | ratchet **BUG-1**: a `recordReading`-shaped row with `circuits '[2,3,6]'`, then the `useDays` predicate | `it.fails`: count 1 (today 0 ✓v). A plain `it` asserts the `jsonb_array_elements_text` form returns 1 ✓v |

`tests/db/api.test.ts` (tests-T3, from A). It seeds one `tesla_accounts` + `sites` row (`'s'`), serves `app` with `createServer(app).listen(0)` and uses the real `fetch` to 127.0.0.1. It asserts:

- `/api/auth/me` returns `{mode:'single',…}`.
- `PUT /api/settings {pool:{autopilot:'suggest'}}` followed by `GET` returns the merged object.
- `/api/day?date=2026-09-24` over a seeded bucket returns `buckets[0]` = `{t 13.0833, solar 6, home 4.44, grid −0.9, battery −0.66}` and `totals.solar .5`.
- `GET /api/cron/sync|pool|nest` returns 401 with no bearer and with any bearer (`CRON_SECRET` is unset).
- `POST /api/appliances/pool/autopilot {mode:'x'}` returns 400; `'suggest'` returns `{ok, mode}`, stores `kv settings` with pool.autopilot = 'suggest', and **`writePoolPlan` is never called**.
- `POST /api/events {type:'cleaned', day:'2026-9-1'}` returns 400.

This file becomes the base for the later auth batch (the unauthenticated POSTs).

## 9. Wave 2 (tests-T5, after the tests-T4 extractions)

- **`acDecision`** (X10). Settings `AC`, the #17 plan at hour 13 (step `[11,74]`), `state {mode COOL}`:

  | Setup | Result |
  |---|---|
  | rec approved, coolF 80 | `set {next 78, target 74, final false}`, lastStepHour unchanged |
  | coolF 76 | `set {74, 74, true}`, lastStepHour 11 |
  | coolF null | next = target 74 |
  | step 72 | target clamped to 74 (lo) |
  | step 85 | target clamped to 80 (hi = max(78, 76, 80)) |
  | mode HEAT | no set |
  | coolF 74 (equals step) | no set |
  | lastStepHour 11 | no set |
  | suggest, rec null | `rec.approved false`, no set |
  | auto, rec null | `rec.approved true` |
  | away plan (80), coolF 76 | `set {78, 80, false}` |
  | ratchet **BUG-5**: autopilot 'off', rec `{approved: true}`, coolF 80 | `it.fails`: no set |

- **`learnAcKwFrom`** (X11):
  - A's case: 6 OFF→COOLING pairs 5 minutes apart with Δ kW `[1.8,1.92,2.016,2.016,2.1,2.28]`, 1 HEATING pair with Δ 3.0, 1 pair 11 minutes apart (skipped), 1 pair with Δ 0.3 (dropped). Result `{coolKw 2.016, heatKw null, samples 6, heatSamples 1}`. With the first 4 pairs only: `coolKw null`. With 5 pairs: 2.016 (the upper median, index `floor(n/2)`).
  - B's case: Δ `[2.0,1.9,2.1,2.3,1.8]` gives 2.0; OFF→HEATING Δ 6 ×5 gives `heatKw 6`.
  - `nearestKw`: a bucket at ts+4 min with 150 Wh gives 1.8 kW; nothing within ±5 min gives `undefined`.
- **`runtimeFrom`** (X12): COOLING 5 min, OFF 5 min, COOLING 20 min (capped to 10) gives `{minutes 15, duty 75}`.
- **`heatSlope`** (X14): 12 points with u = 5 + 2·(t−80) give **2**; 9 points give 2.5; a negative slope gives **.5**; a slope of 9 gives **6**; all t = 90 (NaN) gives 2.5.
- **`replay`** (X15):
  - B's rows `[{12h, s5, h2}, {13h, s5, h2}, {18h, s0, h3}]`, reserve .2, tariff {.1064, .0719}. Baseline (1, 27, 10): `{0,0,10,7,100,0,0}` ✓v. No system (0,0,0): import 7, netCost 1 ✓v. No battery (1,0,0): import 3, export 6, selfPowered 57 ✓v. 1 kWh battery: import 2, export 5, selfPowered 68, fullDays 1 ✓v. Scale 2: export 2, fullDays 1 ✓v. `extraEveningKwh 6`: home 8 ✓v.
  - A's two synthetic days (solar 6 kW for hours 08–17 **inclusive**; home 2 kW, rising to 5 kW for hours 17–22 **inclusive**). Baseline `{37,29,120,132,72,2,2}` ✓v. No system `{132,0,0,132,0,0,14}` ✓v. Cap 40.5 with 21.5 kW gives `{17,6,120,132,87,2,1}` ✓v. `extraEveningKwh 6` gives `{47,27,120,144,67,2,3}` ✓v. Scale 2 gives `{37,149,240,132,72,2,−7}` ✓v. `[]` gives all zeros with selfPowered 0.
  - `loanPayment(10000, 6, 10)` = **111**; `(12000, 0, 10)` = 100; `(12000, 5, 0)` = null.
  - `systemEconomics({priceUsd 10000, taxCreditPct 30, loanYears 10, loanRatePct 5}, 500, Date.UTC(2026,8,25))` gives netUsd 7000 and paybackYears 14.
- **Pool** (X4–X8):
  - ratchet **BUG-4** `seasonOf` = `[0,0,1,1,1,2,2,2,3,3,3,0]`. A plain `it` pins `seasonTable({month: 3,…}).find(s => s.current).label` = 'Jun–Aug' (today's value); `it.fails` expects 'Mar–May'.
  - `turnoverPerDay` of the 9 h at 1500 profile gives 1.88; ratchet **BUG-7** with designGpm 100.
  - `integrateExtras`: light 500 W + UV 60 W for 10 min gives h12 .093 kWh; blower + spa light 1,200 W for 5 min gives h13 .105; total .2.
  - `spaSession` 95→102 °F: rise 7, btu 58,380, heatMinutes **11**, propaneGal **.78**, propaneUsd 2.34, pumpWattsAtSpa **2195** (W0(3190)), electricUsdPerHour **.36**.
  - `currentSchedules` on the fixture excludes freeze circuit 132.
- **Reconcile** (X16):
  - `gapPct`: (850, 867.3) → **2** ok; (850, 900) → **5.9** not ok; (1000, 1043) → 4.3 ok; (1200, 1131) → −5.7 not ok; (0, 50), (null, 50) and (1000, null) → null.
  - Export check `|exp − received| ≤ max(5, 5 %)`: (284, 300) fails, (286, 300) ok, (0, 4) ok, (9, 3) fails.
  - `reconcileBill`: home 2400 with import 867.3 gives solarShareOfHome **64** and withoutSolarCost **285.36**; 20 of 31 days gives coverage .65.
  - `whToKwh(867345)` = 867.3, `(null)` = null, `('1234')` = 1.2.
- **Sync** (X17, X18):
  - `energyRow`: solar 600; consumer from solar/battery/grid 300/50/20; battery from grid 5; grid export from solar 100; battery from solar 200; battery exported 50 → `{day '2026-09-24', hour 13, solar 600, home 370, imp 25, exp 100, chg 205, dis 50}`.
  - ratchet **BUG-9** `dayWindow('2026-11-01').end` expects `2026-11-01T23:59:59-06:00`.
- **`tests/db/integration.test.ts`** (B), with a fake Date of 2026-09-25 13:00 CDT and the forecast seeded in kv:
  - `autopilot(..., act: true, mode 'suggest')` sets `pending true`, stores `kv '<site>:pool:pending'` with plan.hours as expected, **does not call `writePoolPlan`**, logs `log[0].delta` = 'waiting for you', and returns `nextRunAt` `2026-09-26T01:15:00.000Z`.
  - With mode `'auto'`: `writePoolPlan` is called once with `replaceCircuits [6, 8, 5]` and the plan's two schedules. A second run with the same plan does not call it again (the `same` check).
  - With mode `'off'`: no call.
  - `acTick` (Nest COOL, coolF 80, `kv '<site>:ac:plan' = {today, approved: true, lastStepHour: null}`) calls `setCool('dev-test', 78)` once. Run again with coolF 76, it calls `setCool(…, 74)` and sets lastStepHour 11.
  - `syncSite` with a fake Tesla client and a stale `lastHistory` stores 3 energy rows. If `backup_history` throws a 504, the error is recorded in `kv '<site>:error:lastBackups'` and the stored events are unchanged. With `lastHistory` 1 minute old, nothing is fetched.

## 10. CI (GitHub Actions on PR and push to main; the repo is public, so Actions are free)

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push: { branches: [main] }
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy: { matrix: { node: [22, 24] } }   # 22 = engines/.nvmrc; 24 = Vercel's current project setting, until that mismatch is fixed
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: npm }
      - run: npm ci                    # no native deps; PGlite is WASM
      - run: npm run typecheck
      - run: npm test                  # CI=true is set by Actions
      - run: npm run build             # the same vite build Vercel runs
```

- No secrets are needed. Tests never reach the network (the fetch guard) or Neon (PGlite).
- Vercel is **not** deploying from git, so CI is a gate only and never deploys.
- A run takes about 40 s, mostly `npm ci`. The tests themselves take about 3 s.
- Branch protection on `main` requiring `ci` is a repo setting that needs the owner's go-ahead (owner question 6).

## 11. How the tests gate Phase 2 batches

1. **Order of the test batches:**
   - Batch 1 = tests-T1, T2, T3, T6. These change only `package.json`, `tsconfig.json`, `vitest.config.ts`, `tests/**` and `.github/**`; **no app code**. Known bugs land as ratchets, so this merges green.
   - Batch 2 = tests-T4, T5, T9: extractions that don't change behaviour. The batch 1 specs must stay green unchanged.
   - Batch 3 = tests-T7 and tests-T8: the behaviour-changing fixes, only the ones the owner approves.
2. **Every later batch** lives on a branch (rule 6). CI must be green on the PR before `npm run deploy:preview` runs. The deploy scripts run `check` (typecheck → tests → build) themselves and refuse to deploy when anything is red.
3. **A batch that touches model code has one of two shapes:**
   - (a) It preserves behaviour: every existing expectation is untouched.
   - (b) It changes behaviour: its approved scope names the change, it flips the matching `BUG-n` `it.fails` → `it` or edits the explicit numbers, and the write-up quotes old → new figures (for example "hour-10 pump energy 0.798 → 0.482 kWh") next to the preview screenshots.
4. **New logic ships with its spec in the same batch.** Test files count toward the "about five items". New device-facing code must go through a pure decision function (like `acDecision`) so it can be tested without ScreenLogic, Nest or Tesla.
5. **Rule 4 as code.** The rails in `setup.ts` strip the device env and throw on any fetch. The integration specs assert `writePoolPlan` and `setCool` are never called in Suggest or Off mode. No test run can write to the pool controller, the thermostat, Neon or Tesla. The live Autopilots currently being in `auto` is a settings problem that tests can't fix. The Suggest-mode specs make sure a code change never widens it.
6. **Verification for a test-only batch** (rule 1): the green CI run link, plus preview-URL screenshots at 393 px of the Insights, Pool and AC screens, showing they didn't change.

## 12. Timing budget (target < 5 s)

| Piece | Measured by the candidates | Projected |
|---|---|---|
| Vitest start + transform + collect | about 0.8 s | about 0.9 s |
| `server` + `web` + `hygiene` (pure) | 2–17 ms per file | < 0.3 s |
| `db` project: 3 files × PGlite boot (about 1.0–1.4 s each, in parallel) | A: 0.96 s per boot; B: 5 files / 15 tests in 1.9 s | about 1.5 s wall |
| `api.test.ts` app import (pdf.js) + about 15 requests | 0.35 s | about 0.6 s |
| **Total** | 1.65 s (A, 14 tests) / 1.9 s (B, 15 tests) | **about 2.5–3 s for about 120 tests** |

## 13. Provenance and what was dropped

- **From B (the winner):**
  - the spec-table format and the `it.fails` ratchet;
  - BUG-1 (confirmed in PGlite), BUG-2, BUG-3, BUG-4, BUG-5, BUG-7, BUG-9, BUG-10;
  - `TZ=UTC` for server code;
  - per-file PGlite isolation instead of `singleFork` + `isolate:false`;
  - seeding `kv 'pool:forecast'` instead of mocking HTTP;
  - the partial `tesla/client.js` mock and faking only `Date`;
  - the `acDecision` signature with the rec/auto/Off logic inside, and `seasonOf`, `turnoverPerDay`, `integrateExtras`, `energyRow`, `dayWindow`;
  - the PEC fixture text, the `SOL` array, and the planner and web cases;
  - the integration specs (suggest vs auto vs same-plan skip, `acTick` stepping, `syncSite` with a 504);
  - the `kwhSaved` and Off owner questions.
- **From A:**
  - the separate `server` / `db` / `web` projects, with `db.ts` throwing inside pure tests;
  - the full `setup.ts` rails (refuse non-PGlite URLs, strip the env, allow fetch only to 127.0.0.1);
  - the fixture-hygiene regex set;
  - the `bills.ts` → `pec.ts` split;
  - `learnAcKwFrom` over arrays (combined with B's `kwAt` so the caller makes one query), plus `runtimeFrom`, `mergeAcSettings`, `outdoorUnitLabel`, `spaSession`, `currentSchedules`, `parseOpenMeteo`, `heatDaysAt`, `loanPayment`/`systemEconomics`, `reconcileBill`/`whToKwh`, `siteSummary`;
  - the Express-over-socket `api.test.ts`;
  - the BELL-based golden tables and the DST fall-back / `addDays(−437)` / `util` / `sunAt` / `WMO` cases;
  - Q1 (start == stop means all day), and the wider form of BUG-6/Q2 (`new Date().getMonth()` in `poolDetail` and `pollenFor`);
  - `check` including the build, and `npx vercel` in the deploy scripts;
  - the two gating shapes (behaviour-preserving vs behaviour-changing);
  - tests-T9 (one PEC parser).
- **New in the merge:**
  - the Node 22 + 24 CI matrix, which covers the Vercel 24.x setting until it is fixed;
  - scanning `mockups/` and `docs/` in the hygiene test, which puts rule 5 in CI (PRIV-1 ratchet on `g-insights.html`).
- **Dropped:**
  - A's Tier-A `*-model.ts` moves: churn with no benefit, since importing `pool.ts`/`ac.ts` does not connect and the global mocks cover it. Only `pec.ts` survives.
  - A's snapshots and `test:update`: replaced by explicit numbers and key-shape assertions.
  - A's `singleFork` + `isolate:false`: shared state and TRUNCATE bookkeeping.
  - A's Chicago TZ pin for server code: production runs UTC.
  - A's `weekPlans` extraction: covered by the integration spec.
  - A's Q4 (no-op `setCool`) and Q7 (`addYears` leap day) as ratchets: unreachable or harmless, kept as notes.
  - B's `tests/fixtures/private/` real-bill block: it would put real bill text inside the repo tree, and `data/bills/` holds parsed JSON anyway.
  - B's fake street address in the fixture: fails the hygiene regex.
  - B's env placeholders for Tesla and `SESSION_SECRET`: the config getters are lazy and single-owner mode never needs them.
  - B's `vercel deploy` without `npx` and its `check` without the build.
  - The fixes B put in its refactor table (R5, R6, R7, R11, R13's new end, R15): moved to tests-T7 and tests-T8 so the refactor batch stays behaviour-preserving.
  - B's "ratchet style" owner question: decided here in favour of ratchets.
