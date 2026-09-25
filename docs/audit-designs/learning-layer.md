# Solstice learning layer: final design (judge's merge)

This is Phase 1 and read-only. Nothing here is built until the owner approves `mockups/k-learning.html` and says go (rules 1 and 2). Nothing in this layer writes to ScreenLogic or Nest on its own (rule 4). No dollar figures for price, loan or payback appear anywhere (rule 5).

## 0. Verdict and scoring

I checked every claim against the code (`server/src/appliances/{ac,pool,autopilot}.ts`, `server/src/app.ts`, `server/src/db.ts`, `web/src/lib/model.js`, `web/src/main.js`, `web/src/views/*`, `web/index.html`, `vercel.json`, `package.json`, `tsconfig.json`).

| Criterion (1–5) | A: measurement-first | B: product-first |
|---|---|---|
| Fit to the codebase (verified) | **5**. Every claim checked out. `learnAcKw` runs 2 queries per COOLING/HEATING↔OFF transition over 14 days. It is called from `acDetail`, so it runs on every `/api/appliances`, `/api/appliances/ac` and 5-minute `acTick`. `acSlope` exists twice: `app.ts` fits 120 days, `insights.js drawAC` fits all days and sets `S.acSlope`, which the Day Ring uses. `POST /api/events` rejects `filter_cleaned`. The LATERAL SQL runs on the existing PK/indexes. The PK makes predictions idempotent. | **4**. It caught `filter_cleaned` and the all-time `measuredPoints`, but missed the N+1. Its `UNIQUE (…, made_at)` breaks its own "rerun rewrites the same rows" claim, because a rerun has a new `made_at`. `whatif.replay` scores a back-test against itself. |
| Owner value | 4 | **5**. Its badge vocabulary separates *measured* (a direct reading) from *learned* (a model with a track record). The AC trims come from the indoor-temperature trajectory. Anomalies persist and have ack/snooze/auto-close. It has a "what cannot be learned" section and back-tests winter strip heat on the 437-day backfill. |
| Simplicity | 3 (new `shared/` dir, 13 targets × 3 windows) | 3 (`daily_metrics` plus a new POST plus more UI surfaces) |
| Serverless cost | **5**. `acTick` drops from 2×transitions queries to 3 or fewer. | 4 |
| Privacy (public repo, no accounts) | 4 | 4. Neither guards `predictions.inputs`. B adds a new unauthenticated POST. |
| Risk | 4 | 3. `/api/whatif` (a public GET) gets a DB write. An anomaly card gets a "Re-apply the plan" tap, which is a new ScreenLogic write path. |
| **Total** | **25** | **23** |

**Winner: A's structure** (audit → metrics → storage → ground truth → rules → re-plan → cron → API/UI → tests → cost). From B I took the badge vocabulary, `daily_metrics`, the weekly rollups with p10/p90 bands and the improvement headline, the anomaly lifecycle, the AC coast/depth trims, the pump change-point refit, the runtime degree-hour model, the separate `wx:gti` fetch, the battery RTE, the strip-heat back-test, the per-screen surface spec, the Model Report card and the honesty section. Each section says where its ideas came from; §15 lists what was dropped and why.

**What the judge corrected (in both candidates):**
1. **Pump physics.** Both said watts *above* the curve means filter or impeller load. In speed mode an IntelliFlo holds RPM. A centrifugal pump at a fixed speed draws **less** power when flow is restricted (loaded D.E. filter, full basket, partly closed valve), and **more** when flow rises (a valve moved to waterfall/spa/cleaner) or the motor drags (bearings). The rules in §6 follow the physics. The first `filter_cleaned` event doubles as the check: watts at 1,500 RPM should step **up** after a cleaning.
2. **The refit hides the anomaly.** If the curve re-anchors to the new plateau (B) and the anomaly compares against that same curve, the anomaly closes itself. So there are two references: the **current anchors** (used for plan kWh) and a **clean-filter baseline** (used for anomalies).
3. **Pool savings from matched measured days can't be done.** Before the plan (2026-09-24) the only samples were taken while the app was open, so coverage is far below 80%. Savings are measured against a **counterfactual**: the previous schedule (`pool:applied.removed`) × the measured curve.
4. **AC savings need non-plan days.** With AC Autopilot on Auto (live today), every hot sunny day pre-cools. So there are no matched non-plan days after the Nest link. That is owner question 3 (control days).
5. **forecast48's SOC input at 05:45.** `readings` rows exist only while the app is open. Use the latest `soe` row instead; if it is older than 60 min, call `refreshLive` once.
6. **Rule 4 exposure.** AC Autopilot is `auto` on the live site. Any learned trim folded into `planFor` would reach the Nest through `acTick`. Trims therefore wait for a tap unless the owner says otherwise (question 2).
7. **Mockup name collision.** `mockups/j-ui-fixes.html` already exists (untracked), so the mockup is `mockups/k-learning.html`.
8. **Data health never shows learn errors.** `drawHealth` shows `errors.*` only for 30 minutes, so an error from a 05:45 run is gone by 06:15. The Learning row reads `learn:last` directly.
9. **Privacy guard.** `predictions.inputs` uses an explicit key whitelist. It never stores `settings.system`, a rate, or any `$` value, and a test locks this.

## 1. What exists today (audit; from A, verified)

| Model | Where | Output | Ground truth available | Stored at prediction time? |
|---|---|---|---|---|
| Pump watts/RPM | `pool.ts powerModel(measuredPoints)`: all-time median per exact RPM, `HAVING COUNT(*)>=3`; anchors 1800→287 W, 3450→2900 W; log-log between anchors, cube law outside | `W(rpm)` | `pool_readings.watts@rpm` (only when the app is open) | No |
| Pool plan kWh/day | `pool.ts planFor` / `autopilot.ts planDay`: `hourlyRpm × W + UV 60 W` | kWh, cost | Readings integration if coverage ≥ 80% | Partly (`pool:pending`, `pool:applied`, `pool:autolog` text) |
| AC kW | `ac.ts learnAcKw`: transitions ≤ 10 min × nearest `energy.home_wh*12`, 14-day median, null under 5 | `coolKw`, `heatKw` | Load steps | No. **N+1: 2 queries per transition, on every call** |
| AC kWh/day | `acDetail`: `runtimeToday × acKw` | `todayKwh` | Runtime; Tesla buckets during COOLING | No |
| AC plan savings | `ac.ts planFor kwhSaved` | kWh, $/mo | Plan vs matched days | Only `ac:plan` today |
| AC heat slope | `app.ts acSlope` (120 d, kv 6 h) **and** `insights.js drawAC` (all days, sets `S.acSlope`, used by the Day Ring) | kWh/°F | Out-of-sample days | No; the two disagree |
| Solar yield | `web/src/lib/model.js learnYield` (p60 of solar/GTI, GTI > 2.5, 30 d) + `baselineK` a year ago, in the browser | `yieldK`, `S.perf.loss` | `energy.solar_wh` vs GTI | No; browser only |
| forecast48 | `model.js forecast48` (GTI × yieldK, 14-day hourly profile, SOC sim at 0.95) | hourly s/h/soc, full, import | `energy` hourly, `soe` hourly | No; browser only |
| What-if replay | `app.ts /api/whatif replay()` | baseline import/export | `actual` already returned | No |
| Autopilot rules | `planDay` (+1 h rain, +2 h heat wave, …), AC `planFor` | hours, steps | Partly (see §14) | Text logs |

## 2. Badge vocabulary (from B; the brief's "measured / estimated / learning: 3 of 5")

| Badge | Meaning | Rule |
|---|---|---|
| `measured` | A direct reading, no model | Pump watts now, indoor °F, today's solar kWh, a completed discharge segment |
| `learned ±X%` | Model output whose out-of-sample error is within its ceiling | confidence ≥ 0.70 |
| `estimated ±X%` | Error is known but above the ceiling, or only half-learned | n ≥ N/2 and confidence < 0.70 |
| `learning · n of N` | Not enough scored samples | n < N/2 (e.g. "learning · 3 of 10 days") |
| `unscored` | Predictions exist, but no actual has landed in 14 days | e.g. pool kWh while coverage < 80% |

X is the 30-day MAPE, or "±5 pts" for SOC and "±0.2 kW" for AC kW (absolute-unit models). Where a band is shown it is the empirical p10–p90 of relative error: `value×(1+p10) … value×(1+p90)` (B).

A called high-confidence model outputs `measured`. I dropped that because it tells the owner a model output is a reading.

## 3. Metrics, exactly (merged)

Scoring window: the last 30 days of `for_day`, at most 60 samples, at least 5.
```
e_i   = value_i − actual_i                         (A's sign: + = over-predicts)
rel_i = e_i / max(|actual_i|, floor_m)             (B: keeps every row, bounded; abs-unit models: rel_i = e_i)
MAE   = mean(|e_i|)      MAPE = mean(|rel_i|)      bias = mean(e_i) / mean(max(|actual_i|, floor_m))
p10, p90 = empirical quantiles of rel_i            (band shown next to numbers; stored as ci on new predictions)
c     = min(1, n / N_m)                            coverage of samples
a     = clamp(1 − MAPE / ceiling_m, 0, 1)          (abs models: MAE / ceilingAbs_m)
s     = clamp(1 − |bias| / (MAPE + 0.01), 0, 1)    steadiness (B)
fresh = ageDays ≤ 3 ? 1 : clamp(1 − (ageDays − 3)/27, 0, 1)   days since last scored sample or refit (A)
confidence = round2(c × (0.75·a + 0.25·s) × fresh)
tier: direct reading → measured; no scored row in 14 d → unscored; n < N/2 → learning; confidence ≥ .70 → learned; else estimated
improvement = 1 − MAPE(last 4 weeks) / MAPE(the 4 weeks before), only when both windows have n ≥ 10 (B)
drift       = 7-day MAE > 2 × 90-day MAE with n7 ≥ 7 (A)
shadow promotion: a variant replaces the live model when its 14-day MAE is ≥ 5% lower with n ≥ 14 (A); logged
```
Weekly rollups are keyed by the Chicago Monday of `for_day` (B). They drive the 8-week sparkline and the headline. The 7/30/90-day figures are computed from `predictions` at rollup time and cached in `learn:summary` (A's windows, B's storage).

Constants in `server/src/learn/models.ts`, exported for tests:

| model · target | unit | floor | N | ceiling | Prediction made | Actual |
|---|---|---|---|---|---|---|
| `pump.watts` · `rpm:<r>:c<circuit>` | W | 50 | 10 days per key | 15% | Nightly, for each (rpm, circuit) in today's schedule, from the curve frozen at start of day | `daily_metrics pool_w@<r>:c<c>` (median, ≥ 3 readings) |
| `pool.kwhDay` · `plan` / `current` | kWh | 0.5 | 14 days | 30% | Pool cron 20:15 (CDT) for D+1, both keys | Integrated readings, coverage ≥ 0.8 |
| `pool.saving` | kWh | 0.5 | 10 plan days | 60% | Pool cron, plan days | Counterfactual (§4.2) |
| `ac.kw` · `cool` / `heat` | kW (abs) | — | 10 days (≥ 2 steps/day) | ±0.5 kW | Nightly: frozen median | That day's median step |
| `ac.kwhDay` | kWh | 2 | 21 days | 40% | Nightly: `max(0,(high−80)×slope)` | Method A (runtime × coolKw); method B stored alongside |
| `ac.runtime` | min | 30 | 21 days | 40% | Nightly: degree-hour model | `nest_readings` runtime |
| `ac.saving` | kWh | 1 | 10 plan days (+ ≥ 4 matched) | 60% | When today's plan becomes approved | Matched-day residual |
| `solar.yield` (`@gti`) | kWh | 5 | 20 clear days | 15% | Nightly for yesterday, **before** refitting yieldK, on past-day GTI | Σ `solar_wh` |
| `solar.kwhDay` (`@fcst`) · `h12`/`h36`/`h60` | kWh | 5 | 30 days | 35% | Nightly: yieldK × forecast GTI for D, D+1, D+2 | Σ `solar_wh` |
| `fc48.solar` / `fc48.home` · band `h1-6`/`h7-24`/`h25-48` | kWh/h | 0.3 | 14 days per band | 40% | Nightly + the 17:45 tick | Hourly Σ `solar_wh` / `home_wh` |
| `fc48.soc` · band | pts (abs) | — | 14 days per band | 20 pts | same | Hourly AVG(`soe`) |
| `home.overnightKw` | kW | 0.2 | 14 nights | 25% | Nightly for tonight: 30-night median | Hours 1–4 of D+1 |
| `battery.capacity` | kWh | — | 5 segments | 12% | Trailing 90-day median | Each qualifying segment |
| `whatif.replay` | kWh/day | 2 | 30 days | 40% | Weekly back-test (calibration only) | Daily `import_wh` |

`solar.yield` and `solar.kwhDay` are kept apart on purpose (both candidates): "the panels model is ±4%, the weather forecast is ±11%". Open-Meteo's error is never blamed on the panels model.

## 4. Storage (A's schema for predictions and anomalies, B's daily_metrics and weekly model_scores)

Appended to `SCHEMA` in `server/src/db.ts`. It is `CREATE … IF NOT EXISTS` only, and never drops or rewrites anything (rule 6). The migration runs sequentially on first request per instance: these 7 statements add about 7 round trips (~0.2 s) to a cold start. That is acceptable.

```sql
CREATE TABLE IF NOT EXISTS predictions (
  site_id text NOT NULL, model text NOT NULL, target text NOT NULL DEFAULT '', horizon text NOT NULL,   -- 'd0','h12','h36','h60','k7',…,'replay'
  for_day text NOT NULL, for_hour smallint NOT NULL DEFAULT -1,                                          -- -1 = whole day
  made_at bigint NOT NULL, value real NOT NULL, ci_lo real, ci_hi real, version text,
  inputs jsonb NOT NULL DEFAULT '{}',
  actual real, error real, rel real, method text, scored_at bigint,                                      -- method: 'tesla','readings','schedule×curve','nest','A','B','expired'
  PRIMARY KEY (site_id, model, target, horizon, for_day, for_hour));
CREATE INDEX IF NOT EXISTS predictions_due ON predictions(site_id, for_day) WHERE scored_at IS NULL;
CREATE INDEX IF NOT EXISTS predictions_model_day ON predictions(site_id, model, for_day);

CREATE TABLE IF NOT EXISTS daily_metrics (site_id text NOT NULL, day text NOT NULL, metric text NOT NULL, value real,
  detail jsonb NOT NULL DEFAULT '{}', computed_at bigint NOT NULL, PRIMARY KEY (site_id, day, metric));

CREATE TABLE IF NOT EXISTS model_scores (site_id text NOT NULL, model text NOT NULL, target text NOT NULL DEFAULT '', week text NOT NULL,
  n int NOT NULL, mae real, mape real, bias real, p10 real, p90 real, version text, PRIMARY KEY (site_id, model, target, week));

CREATE TABLE IF NOT EXISTS anomalies (site_id text NOT NULL, rule text NOT NULL, day text NOT NULL, severity text NOT NULL,  -- day = day opened
  value real, expected real, threshold real, detail jsonb NOT NULL DEFAULT '{}',
  first_seen bigint NOT NULL, last_seen bigint NOT NULL, closed_at bigint, acked_at bigint, snooze_until text,
  PRIMARY KEY (site_id, rule, day));
```

- **Predictions are immutable** (A): inserted with `ON CONFLICT DO NOTHING`, so the first prediction for a key stands and a rerun never rewrites history. The time is `bigint` ms, like every other `ts` in the schema. **Ordering guard:** `scoreDue` ignores any row whose `made_at` is after the start of the hour or day it predicts (`for_day`/`for_hour`).
- **Expiry** (B): unscored rows older than 14 days get `scored_at=now, method='expired', actual=null`.
- **Retention** (A): `DELETE FROM predictions WHERE for_day < today − 400`. `daily_metrics`, `model_scores` and `anomalies` are kept (tiny).
- **`daily_metrics`** (B): each day's actuals are computed once, then reused by scoring, rules and charts, so the rules never rescan raw tables over 45–180 days. Metric names:
  - Solar and home: `solar_kwh`, `gti_kwh_m2` (detail `{src:'forecast'}`), `yield_clear` (null unless gti > 4.5 and rain < 1 mm), `rain_mm`, `home_kwh`, `import_kwh`, `export_kwh`, `overnight_kw` (hours 1–4), `overnight_ac_kw` (COOLING minutes × coolKw in hours 1–4).
  - Pool: `pool_kwh` (detail `{coverage, method, pumpMin, coveredMin}`), `pool_w@<rpm>:c<circuit>` (median, detail `{n}`).
  - AC: `ac_runtime_min`, `ac_kwh_a`, `ac_kwh_b`, `ac_steps` (detail `{cool:[…], heat:[…]}`), `ac_degree_hours`, `strip_min` (detail `{maxKw, hours[], source:'step'|'bucket'}`), `indoor_max_f`, `coast_reached_at`.
  - Battery: `battery_segment_kwh` (detail `{fromSoc, toSoc, start, end, kwh}`), `battery_rte_30d`.
  - Day context: `high_f`, `sun_kwh_m2`, `plan_applied` (detail `{pool, ac, presence}`).
- **Privacy:** `inputs` is written through `pickInputs(model, obj)`, a per-model key whitelist (e.g. `pool.kwhDay: ['hours','rpm','boost','waterTemp','sunKwhM2','mode','curveVersion']`). There is no `rate`, `cost*`, `*Usd`, `system`, or name/address field. `GET /api/learn` returns only numbers that are already public through `/api/appliances/*`.

**kv keys** (A's per-model namespace plus B's summary/log; existing keys are not renamed):
- Per site (`${siteId}:` prefix):
  - `model:pump.curve` = `{at, version, anchors:[{rpm, circuit, watts, n, since}], baseline:[{rpm, circuit, watts, n, from, to}], previous}`
  - `model:ac.kw` = `{at, version, coolKw, heatKw, n, mad, p10, p90, lastTs}`
  - `model:ac.kw@temp` = `{a, b, n}` (shadow)
  - `model:ac.runtime` = `{a, b, n, r2}`
  - `model:ac.trims` = `{coastAdjH, depthAdj, why, suggestedOn, samples:[…]}`
  - `model:solar.yield` = `{yieldK, baselineK, n, version}`
  - `model:solar.trim` = `{factor, bias30, n, appliedOn}`
  - `model:home.profile` = `{hours[24], version}` and `model:home.profile@v2` = `{weekday[24], weekend[24]}` (shadow)
  - `model:battery.capacity` = `{median90, baseline, n}`
  - `learn:summary`: the whole `/api/learn` models block, rewritten nightly, so appliance endpoints attach badges with one read
  - `learn:last` = `{at, ms, steps:{name:{ms, n, error}}, scored, predicted, anomalies}`
  - `learn:log`: the last 40 learning-log entries, the same shape as `pool:autolog`
  - `error:learn`
  - The existing `ac:slope` keeps its key and gains `{n, version}`.
- Shared (no prefix): `wx:gti` (B). One Open-Meteo forecast call with `tilt=27&azimuth=64&past_days=31&forecast_days=3&hourly=global_tilted_irradiance,temperature_2m&daily=temperature_2m_max,precipitation_sum&temperature_unit=fahrenheit&timezone=America/Chicago`, cached 1 h. This matches what the web uses to learn `yieldK`.

**Volume** (A): about 300 rows/day, which is 144 fc48 rows × 2 runs plus about 20 daily rows. That is about 110k rows a year, bounded by the 400-day retention. `inputs` is written only on `k=0` of each fc48 run. `model_scores` adds about 20 rows a week.

## 5. Ground truth per model

### 5.1 Pump curve (B's change-point + judge's baseline; A's versioning)
`server/src/learn/pool.ts`:
```ts
export function fitPumpCurve(readings: Array<{ day: string; rpm: number; circuit: number; watts: number }>,
  opts = { windowDays: 60, recentDays: 7, stepPct: .10, minN: 3, minDays: 3 }):
  { anchors: Anchor[]; changed: Array<{ rpm: number; circuit: number; from: number; to: number; since: string }>; version: string }
export function cleanBaseline(readings: …, cleanedOn: string | null): Baseline[]   // 14 days after the last filter_cleaned; else first 60 days with n ≥ 10 per key
export function integrateReadings(rows: Array<{ ts: number; running: boolean; watts: number; circuits: number[] }>, schedMin: Array<[number, number]>, loads: Record<string, number>, uvW: number):
  { kwh: number; coverage: number; coveredMin: number; pumpMin: number }
```
- **Key.** Readings are keyed by (rpm, active pump circuit), because valve actuators on Waterfall/Spa/Pool change the system head. If a key has fewer than `minN` readings, it falls back to rpm only.
- **Anchor.** The 60-day median. If the 7-day median (≥ 3 readings on ≥ 3 days) differs from it by more than 10%, the anchor becomes the 7-day median, with `since` = the first day of the plateau. `version` = a short hash of the anchors.
- `powerModel` in `pool.ts` reads anchors from `model:pump.curve`, falling back to `measuredPoints`. The dial, deltas, seasons and Autopilot then re-cost with no other change.
- **Plan hours never change from a watts change.** `planFor`'s hours depend on water temperature and the rules; `W` only affects kWh and cost. So a refit is numbers-only and safe to apply automatically. A learning-log line records it, e.g. "Pump now draws 312 W at 1,500 RPM (was 287) since Sep 21. Plan: 6.6 kWh/day, was 6.1."
- The **baseline** is what the anomaly rules compare against (§6), so a refit can't hide a fault.

### 5.2 Pool kWh/day and savings (A's coverage method + judge's counterfactual)
- **Measured.** A trapezoid integration of `watts` while `running`, gaps capped at 10 min, plus the circuit loads and UV that `poolDetail` already integrates. Coverage = sampled minutes inside the scheduled window ÷ scheduled minutes.
- **Method.** `method='readings'` when coverage ≥ 0.8. `'schedule×curve'` when coverage is between 0.3 and 0.8: that is the schedule's hours with measured watts, and it is badged `estimated`. Below 0.3 the row is left unscored.
- **Why no Tesla load steps.** A 1,500 RPM run (~150 W) is below Tesla's 5-minute noise in a ~3 kW house, so load steps can't measure the pool (A).
- **Savings.** measured saving = `kWh(previous schedule from pool:applied.removed/previousSpeeds × today's measured anchors + UV) − measured pool_kwh`, scored only on `readings` days. The prediction is `current.kwhPerDay − plan.kwhPerDay`, written at the 20:15 run. Matched pre-plan days (A/B) are not usable, because the samples taken while the app was open never reached the coverage floor.

### 5.3 AC kW: one query (A)
`server/src/learn/ac.ts learnAcSteps(siteId, from, to)` replaces the per-transition loop:
```sql
WITH n AS (SELECT ts, hvac, LAG(ts) OVER (ORDER BY ts) pts, LAG(hvac) OVER (ORDER BY ts) phvac
           FROM nest_readings WHERE site_id=$1 AND day BETWEEN $2 AND $3),
t AS (SELECT ts, CASE WHEN hvac<>'OFF' THEN ts ELSE pts END ton, CASE WHEN hvac<>'OFF' THEN pts ELSE ts END toff,
             CASE WHEN hvac<>'OFF' THEN hvac ELSE phvac END mode
      FROM n WHERE pts IS NOT NULL AND ts - pts <= 600000 AND hvac <> phvac AND (hvac='OFF' OR phvac='OFF'))
SELECT t.ts, t.mode, a.kw - b.kw step FROM t
CROSS JOIN LATERAL (SELECT home_wh*12/1000.0 kw FROM energy e WHERE e.site_id=$1 AND e.epoch BETWEEN t.ton-300000 AND t.ton+300000 ORDER BY ABS(e.epoch-t.ton) LIMIT 1) a
CROSS JOIN LATERAL (SELECT home_wh*12/1000.0 kw FROM energy e WHERE e.site_id=$1 AND e.epoch BETWEEN t.toff-300000 AND t.toff+300000 ORDER BY ABS(e.epoch-t.toff) LIMIT 1) b
WHERE a.kw - b.kw > .5 AND a.kw - b.kw < 25
```
- **Nightly refit.** Over 30 days: `coolKw` = median of the COOLING steps and `heatKw` = median of the HEATING steps, with n, MAD, p10 and p90 stored in `model:ac.kw`. Refits keep the existing "null under 5 samples" rule.
- **Tick and reads.** `acTick` runs `learnAcSteps` only for readings after `lastTs` (one query) and updates the cached median. `acDetail` reads the cache.
- **Scoring.** The nightly frozen median is compared with the next day's median step, on days with ≥ 2 steps (B's out-of-sample test).
- **Shadow `ac.kw@temp`** (A): OLS `step = a + b·outdoorF`, with the hour's temperature from `wx:gti`. It is promoted by the §3 rule.

### 5.4 AC kWh/day: two measurements (A)
- **Prediction.** Nightly, for today: `max(0, (high − 80) × slope)` with `slope` from `ac:slope`. This is the number the Day Ring shows. Inputs: `{high, sunKwhM2, applied, coolKw, slopeVersion}`.
- **Method A:** `runtime(day) × coolKw`. Runtime is `runtimeToday` generalised to any day as `runtimeFor(siteId, day)`, with gaps capped at 10 min. `coolKw` is the value frozen that morning.
- **Method B:** each 5-minute `energy` bucket whose Nest state was COOLING, found with `JOIN LATERAL (… nest_readings r WHERE r.ts <= e.epoch + 60000 ORDER BY r.ts DESC LIMIT 1)`, contributes `ac_wh = home_wh − baseline_wh(hour)`. `baseline_wh(hour)` is the median `home_wh` of OFF buckets within ±1 h that day, falling back to the day's OFF median. The total is `Σ ac_wh / 1000`.
- **Checks.** Method A scores the prediction. `|A − B| / B > 25%` on 3 of 7 days is logged as a `coolKw` sanity warning in the Model Report.

### 5.5 AC runtime model (B)
`runtimeModel(days: Array<{ degreeHours: number; runtimeMin: number }>): { a; b; n; r2 } | null` fits `runtime_min = a + b × Σ_h max(0, outdoor_h − cool_f_h)` on the last 30 days that have Nest data. Outdoor temperature comes from `wx:gti`; the setpoint is `nest_readings.cool_f`, hour-averaged. It needs 21 days; until then the badge reads `learning · n of 21 days`. It feeds `ac.runtime` and `ac.overrun`.

### 5.6 AC plan savings (A's matched days + judge's control days)
- **Prediction.** `plan.kwhSaved`, written from `acTick` the first time today's plan becomes approved (auto or tap) with `precool=true`. Inputs: `{high, sun, precool, depth, coastF, from, to}`.
- **Actual.** `median(ac_kwh_b on matched non-plan days) − ac_kwh_b(today)`. A matched day is one of the last 45 days with `plan_applied.ac=false`, `|high − today| ≤ 3 °F`, `|sun − today| ≤ 1.5 kWh/m²` and presence home. It needs ≥ 4 matches, otherwise the row stays unscored and the detail says why.
- **Where non-plan days come from.** With Autopilot on Auto there are none after the Nest link, so they have to come from **control days** (question 3). Until then the row stays `learning`.

### 5.7 Solar (A's split + B's horizons, fetch and trim)
- **Shared code.** `learnYield` and `forecast48` move unchanged into `shared/learn/solar.ts` and `shared/learn/forecast48.ts`: pure TypeScript with `clamp` inlined. `web/src/lib/model.js` re-exports them (`export { learnYield } from '../../../shared/learn/solar.ts'`), so the browser and the nightly job run the same math. `tsconfig.json include` gains `"shared"`.
- **Build check and fallback.** The item verifies `npm run build`, `npx tsc --noEmit` and a preview deploy. If Vite or Vercel bundling fails, the fallback is B's twin (a server copy) locked by `forecast-twin.test.ts`.
- **`@gti`.** Nightly for yesterday, before `yieldK` is refit: `yieldK × gti_kwh_m2(yesterday)`, using the forecast `past_days` GTI, the same source the web learns on.
- **`@fcst`.** Nightly for D, D+1 and D+2 (horizons `h12`, `h36`, `h60`).
- **Actual.** `SELECT SUM(solar_wh)/1000 FROM energy WHERE site_id=$1 AND day=$2`.
- **Trim.** `model:solar.trim.factor = clamp(1 − bias30/mean30 of @fcst h12, 0.9, 1.1)`, used once n ≥ 14. The Now tab's 12-hour bars and forecast48 multiply by it. Their badge reads "calibrated −6%" and a tap shows the raw number. This changes numbers, not devices, so it is automatic (A's reasoning). B's question about it was dropped: the mockup shows it, and approval covers it.

### 5.8 forecast48 (A, with judge's input fix; B's bands)
- **Runs.** Server runs happen at the nightly job (05:45 CDT) and at the 5-minute tick nearest 17:45 (evening SOC). Each run writes 48 rows × 3 targets with `horizon='k'+k`.
- **Inputs.**
  - `yieldK × solar.trim` and `model:home.profile`: the 14-day hourly means, the same SQL as `/api/profile`.
  - `capacityKwh`, `maxPowerKw` and `reservePct` from `sites.info` summary.
  - `soc0` from the latest `soe` row; if it is older than 60 min, `refreshLive` is called once.
- **Scoring.** Hourly, against `SUM(solar_wh)`, `SUM(home_wh)` and `AVG(soe)` grouped by hour, rolled up by band (`h1-6`, `h7-24`, `h25-48`). The report can then say "battery ±4 pts for the next 6 hours, ±14 pts tomorrow".
- **Shadow `fc48.home@v2`** (A): weekday/weekend hourly medians, promoted by the §3 rule.

### 5.9 Overnight baseline (B)
`home.overnightKw` is predicted nightly for tonight as the 30-night median of `overnight_kw − overnight_ac_kw`, and scored against the next morning's hours 1–4.

### 5.10 Battery capacity and round trip (A's segment rule, B's signature, judge's join)
`server/src/learn/battery.ts`:
```ts
export function dischargeSegments(soe: Array<{ epoch: number; soe: number }>, energy: Array<{ epoch: number; dis: number; chg: number }>, reservePct: number):
  Array<{ start: number; end: number; fromSoc: number; toSoc: number; kwh: number; capacityKwh: number }>
```
- **Segment rule.** A segment starts where soe ≥ 95 and ends at the first point ≤ max(reserve + 2, start − 60). ΔSOC must be ≥ 60 pts, duration ≥ 3 h, and Σ`charge_wh` inside it < 50 Wh.
- **Energy.** The segment's energy is Σ`discharge_wh` of the `energy` buckets whose epoch falls inside [start, end]. This is joined by time window, not `ts` equality, because SOE granularity can differ from the 5-minute energy buckets.
- **Capacity and RTE.** `capacityKwh = kwh / (ΔSOC/100)`, an AC-side number that sits below the 27 kWh nameplate by design. `battery_rte_30d = Σdischarge / Σcharge`.
- **Baseline and reference lines.** The baseline is the median of the first 90 backfilled days. The nameplate (27 kWh) and 70% reference lines are drawn on the chart.
- **Site level only.** `live_status` omits `energy_left`/`total_pack_energy` for this site, and `components.batteries[]` carries nameplate only. Per-unit fade is not available, and the copy says so.

### 5.11 What-if replay (A)
Sundays, inside the nightly job: `replay()` is factored out of `/api/whatif` into `server/src/learn/whatif.ts` and run per day over the last 90 days. It stores daily `import` predictions with `horizon='replay'`, scored against `energy`. This is calibration, not a forecast. A persistent bias > 10% means the sim's 0.95 efficiency or its 5 kW-per-Powerwall limit is wrong. It surfaces as Planner fine print, e.g. "replay within 3.4% of what you actually bought" (B's copy).

## 6. Anomaly rules (merged; pump physics corrected)

- **Code layout.** Pure detectors live in `server/src/learn/rules.ts`; the engine is in `server/src/learn/anomalies.ts` (B's `Rule` type):
  ```ts
  export type Rule = { id: string; severity: 'info'|'warn'|'high'; needs: string[]; evaluate(ctx: RuleCtx): AnomalyResult | null };
  export type AnomalyResult = { value: number; expected: number; threshold: number; detail: Record<string, unknown>; title: string; body: string; action?: 'filter_cleaned'|'cleaned'|'open_pool'|'open_panels'|'open_ac'|'snooze' };
  ```
- **Inputs.** Rules read `daily_metrics` only. A rule whose `needs` are missing reports "waiting for data" in the Model Report instead of silently not firing (B).
- **Lifecycle.** The engine writes with `INSERT … ON CONFLICT (site_id, rule, day) DO UPDATE SET last_seen, value, expected`. When a rule no longer fires past its auto-close condition, it sets `closed_at`. A new firing after close opens a new row. Ack and snooze set `acked_at` / `snooze_until`.

| rule | Signal | Fires when | Persistence | Copy (numbers filled in) | Action | Auto-close |
|---|---|---|---|---|---|---|
| `pump.below_curve` (warn) | Day median W at (rpm, circuit) vs **clean baseline** | ≤ 0.88 × baseline on ≥ 3 readings | 3 of the last 5 covered days | "Pump drawing 12% less than its clean-filter baseline at 1,500 RPM: it is moving less water. A loaded D.E. filter, a full basket or a partly closed valve does this." | I cleaned the filter (`filter_cleaned`) · snooze 14 d | 3 covered days within 5% |
| `pump.prime_loss` (high) | Readings within one run | W drops ≥ 25% within 60 min at constant RPM and stays ≤ 0.75 × baseline | 1 day | "Pump power fell 30% mid-run at the same speed: likely air in the pump or a lost prime." | open Pool | back within 10% |
| `pump.above_curve` (info) | same | ≥ 1.12 × baseline on ≥ 3 readings | 3 of 5 covered days | "Pump drawing 12% more at 1,500 RPM: it is moving more water than usual (a valve moved to waterfall/spa/cleaner) or the motor is dragging." | snooze 14 d | 3 days within 5% |
| `pool.schedule_drift` (warn) | `pool_kwh` (coverage ≥ 0.8) vs the predicted key that should have run | > 1.25 × predicted | 2 of 3 covered days | "The pump used 9.4 kWh yesterday; the plan says 6.6. The controller isn't running the plan." | **open Pool** (its existing Apply button) · That was me (ack) | 2 days within 15% |
| `ac.overrun` (warn) | `ac_runtime_min` vs `ac.runtime` expected (n ≥ 21) | actual > 1.3 × expected **and** actual − expected > max(60 min, 1.5 × MAD of residuals) | 2 of 3 days | "AC ran 1 h 40 m longer than your model expects for a 96° day. Filter, refrigerant charge or a door left open." | snooze 7 d | 3 days within 15% |
| ↳ confounds (A) | — | Suppressed when the 7-day median `cool_f` dropped ≥ 2 °F (attributed to the setpoint) and on presence-away days | | | | |
| `ac.strip_stack` (warn) | Nest: HEATING step ≥ 5 kW, or `home_wh·12 ≥ 7 kW` while HEATING. Tesla-only back-test: any 5-min bucket ≥ 8 kW 05:00–09:00 on a day with high < 45 °F (B) | `strip_min ≥ 30` on ≥ 2 mornings in 7 days with the low ≥ 35 °F | — | "Strip heat stacked on 3 mornings this week (up to 9.6 kW). A smaller overnight setback (`maxStepF`) avoids the recovery spike." | open AC | 7 days clear |
| ↳ context | — | Low < 35 °F → info only (expected). If `heatKw ≥ 5` (straight AC heating on strips), the threshold becomes steps ≥ 1.6 × `heatKw` (stages stacking) | | The back-test lets the card say "last winter the strips stacked on N mornings" before Nest has seen a heating season | | |
| `solar.step_down` (high) | Clear-day ratio = solar / (baselineK × GTI), GTI > 4.5, rain < 1 mm | Median of the last 3 clear days ≤ 0.85 × median of the prior 14 clear days | 3 clear days | "Output dropped 18% in a step since Sep 20: a section of the array may be out (microinverter or breaker)." | open Panels | 2 clear days ≥ 0.95 |
| `solar.one_panel` (info, A) | same ratio | Change-point between two clear days of −2.5% to −5% (1 of 30 panels = 3.3%) that holds ≥ 7 clear days, prior-14 MAD ≤ 1.5%, no rain ≥ 5 mm or cleaning in between | 7 clear days | "About one panel's worth (~3%) missing since Sep 18. With microinverters, one failed unit looks like this." | open Panels | ratio back within 1.5% |
| `solar.dust` (warn, B) | 7-clear-day ratio vs last year's same season, no step | 0.88–0.95, dry ≥ 21 days | — | Existing card copy + "rain Thursday may fix it" | I cleaned the panels | rain ≥ 5 mm and ratio ≥ 0.95, or a logged cleaning; ignores the 3 days after a cleaning |
| `solar.degradation` (info, B) | 90-day temperature-corrected (`gtiEff`) yield vs the same 90 days last year, ≥ 15 clear days each, no step or dust open | < 0.94 | — | "Year-over-year output down 6% on clean, clear days, far beyond the panels' rated 0.25%/yr." | open Panels | ≥ 0.96 |
| `battery.fade` | 30-day median segment capacity vs baseline (≥ 5 segments each) | ≤ 0.95 info, ≤ 0.85 warn | — | "Usable capacity 22.4 kWh per full discharge, 17% below the first 90 days on record." | — | ≥ 0.97 |
| `battery.rte_low` (B) | `battery_rte_30d` | < 0.82 | — | "Round trip 79%: 21% of what goes into the Powerwalls doesn't come back." | — | ≥ 0.85 |
| `home.overnight_creep` | `overnight_kw − overnight_ac_kw` (A: AC subtracted, not merely suppressed) | Fast: 7-night mean ≥ 1.15 × 30-night median **and** ≥ +150 W (existing rule). Slow: OLS over 60 nights > +40 W/month (A) | 3 nightly evaluations | Existing card copy + "based on N scored nights" | snooze 14 d | 7-night mean within 8% |
| `model.drift` (info, A) | Any model's 7d MAE > 2 × 90d MAE, n7 ≥ 7 | — | — | "The Tomorrow's solar model has been wrong lately: ±22% this week vs ±9% usual." | open report | 7d back under 1.5× |

## 7. Re-planning from measured results

- **Pump** (§5.1). Refits are automatic and change numbers only. Autolog line: "Pump draws 11% more than the curve at 1,500 RPM; plan re-costed" (`delta:'+0.3 kWh'`).
- **AC trims** (B's rules; the gate is the judge's and question 2's). `server/src/learn/ac.ts`:
  ```ts
  export function coastTrim(days: Array<{ precool: boolean; coastFrom: number; coastTo: number; coastF: number; indoor: Array<{ h: number; f: number }> }>): { coastAdjH: -1 | 0 | 1; why: string }
  export function depthTrim(days: Array<{ precool: boolean; from: number; to: number; deep: number; indoor: Array<{ h: number; f: number }>; runtimeInWindowMin: number }>): { depthAdj: -1 | 0; why: string }
  ```
  - **Coast shorter:** on the last 3 pre-cool days, the indoor reached `coastF` more than 60 min before `coastTo` on ≥ 2 days → `−1`, never below `coastFrom + 2`.
  - **Coast longer:** the indoor stayed ≤ `coastF − 1` at `coastTo` on 3 of 3 days → `+1`, never past 21:00.
  - **Depth:** the AC ran ≥ 50 min/h in the pre-cool window on ≥ 2 of 3 days and never reached `deep` → `depthAdj −1`, never below 1°.
  - The result is written to `model:ac.trims` and shown in the AC Autopilot card as a suggestion with **Use this**. That button calls the existing `POST /api/appliances/ac/settings` with `{learnedTrims:{coastAdjH, depthAdj}}`. `planFor` then overlays `settings.learnedTrims`: `coastTo = min(21, to + 4 + coastAdjH)`, `deep = max(low, mid − (precoolDepth + depthAdj))`. It says so in `plan.why`, e.g. "Coast shortened to 6 PM: the house reached 78° by 5:40 PM on Tue and Wed."
  - A's runtime-overrun "tuning suggestion" is replaced by these, because the indoor trajectory is the direct signal.
- **AC heat slope** (A). The server `ac:slope` becomes the only fit, refit nightly on 120 days and scored out-of-sample through `ac.kwhDay`. `drawAC` keeps drawing its scatter, but reads the slope and the Day Ring's `S.acSlope` from `/api/learn`. **Visible change:** the "about N kWh per degree" number changes from the all-days fit to the 120-day fit, so the mockup shows it.
- **Solar** (§5.7): trim factor, automatic. **forecast48 home** (§5.8): shadow promotion, automatic. **ac.kw@temp** (§5.3): shadow promotion, automatic.

## 8. Nightly job and hooks

- **Cron.** `GET /api/cron/learn` with a `CRON_SECRET` bearer. `vercel.json`: `{ "path": "/api/cron/learn", "schedule": "45 10 * * *" }`, which is 05:45 CDT / 04:45 CST. That is always after the 10:15 UTC sync (which can take up to 50 s) and always before sunrise, so the morning predictions are made before the day they predict (A's time; B's 11:20 UTC would fall at sunrise in June). It gets its own 60 s invocation with a 45 s budget.
- **Order.** Scoring happens before refits, and predictions come after refits:
```ts
// server/src/learn/index.ts
export async function runLearn(siteId: string, o: { today?: string; budgetMs?: number } = {}): Promise<LearnRun>
// 1 metrics   dailyMetrics(siteId, D) for yesterday plus any of the last 14 days missing rows with ≥ 280 energy buckets;
//             then back-fill Tesla-only metrics (solar, gti, overnight, strip buckets, battery segments) for up to 30 older days per run until the 437-day backfill is covered
// 2 score     scoreDue(siteId, yesterday): one UPDATE … FROM unnest() joining due predictions to daily_metrics / hourly energy+soe; expire rows > 14 d
// 3 rollup    weekly model_scores upsert for touched (model,target,week); 7/30/90 d from predictions; kv learn:summary
// 4 refit     pump.curve (+baseline), ac.kw (+@temp), ac.runtime, ac:slope, ac.trims (suggest only), solar.yield, solar.trim, home.profile (+@v2), battery.capacity; shadow promotion; entries → learn:log
// 5 rules     evaluate all rules; open/update/close anomalies
// 6 predict   today: solar.yield@gti(yesterday, before refit — done in step 2's pre-pass), solar.kwhDay h12/h36/h60, fc48 ×48×3, home.overnightKw, pump.watts, ac.kw, ac.kwhDay, ac.runtime
// 7 weekly    Sundays: whatif.replay over 90 days
// 8 retention predictions for_day < today − 400
```
- **Reporting.** Each step is timed and wrapped in try/catch like `syncSite`'s `run()`. Results go to `learn:last`, and failures also go to `error:learn` (A). The Data health card gets its own row read from `learn:last`: "Learning · last run 5:45 AM · 9 models scored", turning red when `steps.*.error` is set or when `at` is more than 26 h old (B). That row is needed because `drawHealth` hides `errors.*` after 30 minutes.
- **Hooks in existing code** (small edits):
  - `autopilot()` (pool cron): `recordPredictions` for `pool.kwhDay` keys `plan` and `current` (D+1) and `pool.saving`.
  - `POST /api/appliances/pool/apply-tomorrow`: nothing to write, because the `plan` key already exists.
  - `acTick`: `ac.saving` when the plan first becomes approved with `precool`; incremental `learnAcSteps`.
  - **`learnTick(siteId, now)`**: a new pre-step at the top of `/api/cron/nest`, run **before** the `nestLinked()` early return. It runs pool sampling (if approved, §9) and the 17:45 fc48 snapshot.
- **Clock note** (A): the pool cron `15 1 * * *` is 8:15 PM CDT but 7:15 PM CST. The learn cron shifts the same way and is placed so it always follows sync.

## 9. Pool sampling (both candidates; gated by question 1)
If the owner approves, `learnTick` calls `readPool()` + `recordReading()` **read-only** on every 3rd tick (15 min), only while `kv pool:last.schedules` has a pump circuit scheduled on, plus 00:30 and 03:30 checks. With today's plan (10a–7p + one boost hour) that is about 38 reads a day, not 96 (B's figure assumed all day). There are no `writePoolPlan` calls. Each read goes through Pentair's remote dispatcher in about 2–5 s, well inside the tick's 60 s. Without sampling, `pool.kwhDay` and `pool.saving` stay `unscored` and the pump curve reacts in weeks.

## 10. API (B's single summary endpoint, A's GET-only reads)
```
GET  /api/learn                  → { lastRun, models: Record<id, ModelSummary>, anomalies: Anomaly[] (open, not snoozed), log: LogEntry[] }   (one kv read + one indexed query)
GET  /api/learn/:model?days=30   → { summary, weeks: 8, byVersion: [{version, n, mape}], recent: last 30 scored pairs with inputs }
GET  /api/anomalies?days=30      → open + recently closed rows (for the history strip)
POST /api/learn/anomalies/:rule/:day   { ack: true, snoozeDays?: 7|14 }
GET  /api/cron/learn             (CRON_SECRET)
```
- `ModelSummary = { id, label, tier, badge, unit:'pct'|'abs', n, need, mae, mape, bias, p10, p90, confidence, weeks:[{week, mape, n}], improvement, version, refitAt, note?, lastScored? }`.
- `acDetail` and `poolDetail` attach `conf` from `learn:summary`, so the appliance cards need no extra request. `web/src/lib/api.js` adds `learn()`, `learnModel(id)`, `anomalies()`, `ackAnomaly(rule, day, snoozeDays)`. `main.js` loads `S.learn` in `loadHistory` and redraws the cards that carry badges.
- The POST only hides a card, but it is unauthenticated like every other `/api` POST today. It ships behind whatever write guard the security topic lands; until then it has the same exposure as `POST /api/events`.

## 11. Where it surfaces (B's per-screen spec + A's items; mockup `mockups/k-learning.html` first)

- **Badge chip.** `.conf` in `style.css`, JetBrains Mono 10.5 px. Tiers: `m` (`--home`), `l` (green, `--batt`), `e` (amber, `--solar`), `n` (mute), `u` (mute, dashed border). It is rendered by `conf(id, target?)` in `web/src/lib/conf.js` from `S.learn.models`, which also exports `band(id, value)` for p10–p90.
- **Scope.** Rule 3 applies: only the listed element changes on each card.

| Screen · card | Element | Model |
|---|---|---|
| Now · Next 48 hours | Header span → "forecast · solar ±11% · home ±14% · battery ±5 pts at 6 h"; `#fcTxt` "buy about **38 kWh (32–44)**"; "calibrated −6%" when trimmed | `fc48.*`, `solar.trim` |
| Now · Next 12 hours | `#wx12s` "kW expected · learned ±4%" | `solar.yield` |
| Now · Today | `#tSolE` "…of what today's sun allows" + chip | `solar.yield` |
| Now · Powerwall | New kv row "Usable per full discharge" → "24.1 kWh · −2% since Jul · measured" | `battery.capacity` |
| Panels · Performance | Legend "Expected from sunlight" + chip; `#prTxt` adds the band; server `solar.*` rules replace the fixed 8% `S.perf.loss` card once live | `solar.yield` |
| Insights · Today · Day Ring | Legend "AC (est.)" → "AC (learned ±22%)" once tiered; `#drTxt` names the tier | `ac.kwhDay` |
| Insights · Today · Worth knowing (`#alerts`) | `drawAlerts` appends server anomaly cards: expected vs measured vs threshold, days persisted, the confound checked, one action; client cards stay until their server twins exist | `/api/learn` |
| Insights · Appliances · Pool | "Today N kWh" chip (`measured` at coverage ≥ 0.8, else the tier); "Pump … W" `measured`; dial centre "6.1 kWh/day (5.6–6.8)"; deltas "Electricity" chip from `pool.saving`; speed³ reason names the anchor's age and n; Autopilot log gains refit entries | `pool.*`, `pump.watts` |
| Insights · Appliances · AC | "AC draw · 2.0 kW · 16 steps" + "±0.2 kW"; "Today" chip with "A 12.1 / B 11.4 kWh" on tap; deltas "AC electricity" chip ("vs 6 similar days"); Autopilot card shows the trim suggestion with **Use this**; plan `why` carries approved trims | `ac.*` |
| Insights · Home · Heat & your AC | "about N kWh a day per degree" from the server slope + `ac.kwhDay` chip | `ac.kwhDay` |
| Insights · Home · **new card "How well Solstice knows your home"** | Placement per question 4; default above Data health | `/api/learn` |
| Insights · Home · Data health | One more `.health` row from `learn:last` | `learn:last` |
| Planner | Fine print "(replay within 3.4% of what you actually bought)" | `whatif.replay` |

**Model Report card** (`web/src/views/learn.js`, container `#learnCard`):
```
How well Solstice knows your home                      [5 of 9 learned]
Forecasts are 31% more accurate than 8 weeks ago.
● Solar per sunlight        learned ±4%      ▂▂▁▁▁▁▁▁   212 days
● Tomorrow's solar          learned ±11%     ▅▄▃▃▂▂▂▂   61 days · calibrated −6%
● Pump watts                learned ±3%      ▃▂▁▁▁▁▁▁   1,500 & 2,400 RPM
◐ Pool kWh/day              unscored                    readings cover 22% of pump hours
◐ AC draw                   learned ±0.2 kW             16 steps
◐ AC kWh/day                estimated ±34%   ▇▆▅▅▄      9 of 21 days
○ AC plan savings           learning 3 of 10 plan days
● Next 48 h battery %       learned ±5 pts at 6 h · ±12 pts at 24 h
● Battery capacity          measured 24.1 kWh/discharge · −2% since Jul
Learning log:  Sep 22 · AC draw now ±0.2 kW (was ±0.5) after 16 steps
               Sep 21 · Pump curve refit: 312 W at 1,500 RPM (was 287)
```
- **Rows** are `.kv`-style with an 8-week sparkline SVG (weekly MAPE, lower is better) and a bias arrow. A row that is not learned adds one line on what would improve it, e.g. "needs 5 more sunny days" or "needs pool readings through the pump hours".
- **Tap-through.** Tapping a row opens the existing `#sheet` (the `openRawData` pattern in `views/settings.js`). It shows the last 30 predicted-vs-actual pairs, bias, p10/p90, per-version error (A) and the inputs recorded on the prediction.
- **Headline.** The median improvement across models, hidden until two models have one.
- **Sample data.** All numbers in the mockup are illustrative, with no dollar figures.

## 12. Tests (Vitest; PGlite for SQL)
- **Setup.** Add `vitest` as a devDependency. It is pure JS: its esbuild/rollup binaries are the prebuilt ones Vite 6 already installs, with nothing native to compile. Add `"test": "vitest run"` and `vitest.config.ts` including `server/src/**/*.test.ts` and `shared/**/*.test.ts`. Tests use explicit `import { describe, it, expect } from 'vitest'` with no globals, so `tsc --noEmit` stays clean. DB tests set `DATABASE_URL=pglite:` (`db.ts` maps the empty path to in-memory) and call `migrate()`; the default per-file module isolation resets the `query` singleton. If the separate tests topic lands Vitest first, reuse its config.

| File | Locks |
|---|---|
| `server/src/learn/score.test.ts` | MAE/MAPE/bias/p10/p90 on fixed arrays; the floor stops a 0.2 kWh day from blowing up MAPE; abs models report pts/kW; sign (+ = over-predicts); `improvement` null until both windows have n ≥ 10; drift at 2× |
| `server/src/learn/confidence.test.ts` | Tier boundaries at n = N/2 and 0.70; monotonic in n; biased-but-tight scores below unbiased; `fresh` = 1 at 3 d, 0 at 30 d; `unscored` after 14 d; badge strings ("learning · 3 of 10 days", "learned ±4%", "±5 pts") |
| `server/src/learn/pool.test.ts` | Anchors equal `powerModel` on today's data (±25 RPM window, log-log, cube law); change-point adopts a +12% plateau after 3 days and ignores a 2-day blip; baseline from the 14 days after `filter_cleaned`; coverage with the 10-min cap → `readings` / `schedule×curve` / unscored at 0.8 / 0.3; counterfactual saving on a fixture |
| `server/src/learn/ac.test.ts` | Step extraction (COOLING vs HEATING split, 10-min gap, 0.5–25 kW bounds); method A and method B recover a planted kWh within ±5%; `runtimeModel` null under 21 days and recovers a known a/b; `coastTrim` −1/0/+1 and `depthTrim` 2-of-3 from synthetic indoor curves; trims respect the band limits; matched-day selection |
| `server/src/learn/acSql.test.ts` (PGlite) | The single LATERAL query returns exactly the old loop's steps on a fixture, in one round trip |
| `shared/learn/solar.test.ts` | `learnYield` p60 equals the pre-move output; `@gti` vs `@fcst` separation; trim clamps to ±10% and needs n ≥ 14 |
| `shared/learn/forecast48.test.ts` | Output equals a fixture captured from today's `model.js` before the move; energy conservation at 0.95; reserve floor; band mapping `h1-6/h7-24/h25-48` |
| `server/src/learn/battery.test.ts` | A 98→22% window with 0 Wh charging → capacity = kWh/0.76; a window with 60 Wh of charging is rejected; ΔSOC < 60 rejected; time-window join with 15-min SOE and 5-min energy; RTE |
| `server/src/learn/rules.test.ts` | Every rule fires at its threshold and not just below it; every confound suppresses (setpoint drop, away, low < 35 °F, rain reset, cleaning reset); pump below/above/prime-loss direction; one-panel vs step vs dust classification; overnight fast (+15% & +150 W, not +15% & +90 W) and slow (+40 W/month) |
| `server/src/learn/predict.db.test.ts` (PGlite) | `recordPredictions` idempotent under the PK (rerun = no change); a prediction whose `made_at` is after its hour is never scored; expiry at 14 d; retention at 400 d; weekly rollup upsert |
| `server/src/learn/nightly.db.test.ts` (PGlite) | Fixtures in `energy/soe/nest_readings/pool_readings/kv` → `runLearn` writes `daily_metrics`, scores, `model_scores`, `learn:summary`, anomalies; a second run changes nothing; a failing step is recorded in `learn:last` and does not stop the others |
| `server/src/learn/rules.db.test.ts` (PGlite) | open → persists → auto-closes → reopens as a new row on a new day; snooze hides it from `/api/learn`; ack survives a rerun |
| `server/src/learn/privacy.test.ts` | Every model's `pickInputs` whitelist; no stored `inputs` or `learn:summary` key matches `/usd|cost|price|loan|rate|system|name|address/i` |

## 13. Serverless cost
- **`acTick` and the AC reads.** They drop from 2 × transitions queries (14 days of COOLING↔OFF pairs, on every tick, every `/api/appliances` and every `/api/appliances/ac`) to at most 3: one incremental step query and two kv reads. This is the largest cost win and is independent of the rest (item `learning-L5`).
- **Nightly job.** About 50–80 Neon round trips (~30 ms each), one `wx:gti` fetch, under 10 s. The back-fill adds about 30 days per run until done.
- **`learnTick`.** One kv read per tick; at 17:45, one fc48 run (~150 rows via `unnest`); pool sampling only if approved (~38 reads/day).
- **Every UI read** is one kv get (`learn:summary`) or one indexed query. No browser writes except ack/snooze.
- **Storage:** about 110k prediction rows/yr (~10–20 MB), bounded by retention.
- **Cold start:** about 7 more migration round trips.
- **New dependencies:** only `vitest` (dev).

## 14. What cannot be learned (shown as such; B)
- Per-Powerwall fade: not exposed by the Fleet energy scope for this site. Site-level only.
- Water clarity, and the value of the pool rules ("+1 h after rain", "skim boost for pollen"): not measurable. They stay rules, and the UI never calls them learned.
- Pool kWh/day and savings without sampling through the pump hours: `unscored`.
- AC kW, runtime and savings while Nest is unlinked, in HEAT mode before a heating season, or with no matched/control days: `learning`, with the reason given.
- Weather-forecast error is Open-Meteo's. It is reported separately from the panels model.

## 15. Found on the way (both candidates, verified)
- `POST /api/events` accepts only `cleaned | note`, but `views/appliances.js` posts `filter_cleaned` from "I cleaned the filter" and `autopilot.ts` reads `type='filter_cleaned'`. So the button returns 400 today, `filterHours` never resets, and the pump baseline could never reset. The fix is one line in `app.ts`, with the existing Undo path.
- `measuredPoints` uses all-time medians per RPM, which is why §5.1 adds windows.
- `acSlope` exists twice (§7).
- Client-side `drawAlerts` cards vanish on reload. §6 persists them without changing their copy.
- `readings` (30 s live rows, kept 3 days, only while the app is open) may sharpen AC steps when present. The nightly job may use them opportunistically but never depends on them.
- AC and pool Autopilot are `auto` on the live site, against rule 4's default. This layer does not change that, and flipping it back is the owner's call.

## 16. Provenance and what was dropped

**From A:**
- Audit table and the N+1 fix (LATERAL SQL)
- Immutable prediction PK with `horizon`, and the ordering guard
- Error sign, freshness, 7/30/90 windows, drift rule
- kv `model:*` namespace with versions, and per-version error
- AC kWh methods A and B
- Pool coverage and method badge
- Solar `@gti`/`@fcst` split and trim
- forecast48 at 05:45 and 17:45 with bands
- Shadow variants (`ac.kw@temp`, `fc48.home@v2`)
- `shared/learn` for yield and forecast48
- Battery segment thresholds
- `solar.one_panel` rule, the overnight AC subtraction and the slow-creep rule
- Weekly what-if calibration
- Cron at 10:45 UTC, retention, cost section, `filter_cleaned` fix

**From B:**
- Badge vocabulary (`measured` / `learned` / `estimated` / `learning · n of N` / `unscored`)
- `rel` with a floor denominator; p10/p90 bands and CI on predictions; steadiness term; improvement headline
- Weekly `model_scores`, `daily_metrics`, `learn:summary`, `learn:log`, `wx:gti`
- Pump change-point refit with `since`
- AC coast/depth trims from the indoor trajectory, and the degree-hour runtime model
- `home.overnightKw`, battery RTE rule
- Winter strip-heat back-test on the backfill
- `pool.schedule_drift`, `solar.dust`, YoY `solar.degradation`
- Anomaly lifecycle (ack, snooze, auto-close, `needs` → "waiting for data")
- Per-screen surface table, Model Report card and learning log, the Data health row
- "What cannot be learned" section, mockup-first ordering

**From the judge:**
- Pump physics and the clean baseline
- Pool counterfactual savings, AC control days
- SOC input from `soe`
- `learnTick` running before the Nest-linked early return
- Keying pump readings by circuit
- Time-window battery join
- `inputs` whitelist and privacy test
- Mockup renamed to `k-learning.html`
- Learn status read from `learn:last`, not `errors`

**Dropped:**
- A's `measured` label for high-confidence model outputs: it presents a model as a reading.
- A's MAPE row-skipping: B's floor denominator keeps every day.
- A's archive re-pull that overwrites GTI: it would score yield on a different GTI source than the one `learnYield` trains on.
- A's OLS 180-day degradation slope: seasonal temperature confounds it, and B's same-season YoY with `gtiEff` avoids that.
- A's runtime-vs-plan "tuning suggestion": superseded by B's indoor-trajectory trims.
- A's claim of about 96 pool reads/day: it is about 38 when gated to pump hours.
- B's `UNIQUE (…, made_at)`: it breaks idempotency.
- B's `whatif.replay` written and self-scored on each public `GET /api/whatif`: a side effect on a GET, and not a forecast.
- B's "Re-apply the plan" button on an anomaly card: a new ScreenLogic write path. It now links to the Pool card's existing Apply.
- B's duplicated forecast48 twin: kept only as the fallback if `shared/` fails to bundle.
- B's solar-trim owner question: the trim touches numbers, not devices, and the mockup covers it.
- B's anomaly-ack by serial id: the natural key `(rule, day)` is used instead.
- B's pump "dirty filter → above curve" copy: physically wrong.
- A's "impeller/filter load" for above-curve: physically wrong.
- The mockup names `j-models.html` and `j-learning.html`: they collide with the existing `j-ui-fixes.html`.
