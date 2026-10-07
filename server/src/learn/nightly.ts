// The learning layer's nightly job (docs/audit-designs/learning-layer.md §8), run by the nightly sync cron right after the sync:
//   load     a fixed set of range queries (energy by day and hour, battery %, Nest by hour, pool readings, predictions, kv state)
//   ac       measured savings from control vs pre-cool days; this morning's trim from the last three pre-cool days of 21
//   metrics  each day's measured values, and yesterday's predictions scored against them → daily_metrics (one upsert)
//   scores   rolling 7/30/365-day MAE, MAPE and bias per model → model_scores (one upsert for every model)
//   pump     the clean-filter baseline per RPM (after the last "I cleaned the filter", else the first 60 days)
//   rules    the anomaly rules → open, update and resolve rows in `anomalies`
//   home     the home model's year fit (B2-8: kWh = a + b·max(0, high − Tc) + c·max(0, Th − low) on 365 days) → kv
//   predict  today's 48-hour forecast, the always-on load for tonight and the billing-cycle projection → predictions (one insert)
// About 20 round trips whatever the data size (no per-model or per-row queries). Every step is timed and caught on its own.
import { capacityOf, modelKwh } from '../capacity.js';
import { kv, hourWh } from '../db.js';
import { localDay, addDays, localMidnight, localAt, rfc3339 } from '../tesla/client.js';
import { learnAcKw } from '../appliances/ac.js';
import { meanByQuarter, scheduledQuarters } from '../appliances/pool.js';
import { listBills } from '../bills.js';
import { MODELS, MODEL_IDS, mean, median, round, versionOf, type ModelDef, type ModelId } from './models.js';
import { lq, learnStats, logPrediction, type Prediction } from './store.js';
import { confidence, type Tier } from './confidence.js';
import { forecast48, learnYield } from './forecast48.js';
import { homePoints, modelFor, dayScales, forecastDays, fitYear, yearPoints, wxHiLo, clearUpDays, homeSlopesKey, YEAR_DAYS, type HomeSlopes, type Temp } from './homeModel.js';
import { measuredSavings, trimFor, ranPrecool, learnAcKey, TRIM_WINDOW_DAYS, type AcDay, type PrecoolDay, type LearnAc, type TrimRecord } from './ac.js';
import { evaluateRules, type MetricsByDay, type OpenAnomaly, type Verdict } from './rules.js';
import { wxGti, gtiByDay, tempsOf, type Wx } from './wx.js';
import { panelMetrics, LAYOUT_KEY, type Layout } from '../panels.js';
import { tripDays } from '../vacation/trip.js';
import { alwaysOnKw } from '../breakdown.js';

/** The metrics an empty house would teach the at-home rules wrong (mockup ak): left out of the rules and the always-on prediction on trip days. */
export const TRIP_METRICS = ['home.alwaysOn_kw', 'home.overnight_kw', 'home.kwh', 'ac.runtime_min', 'ac.degree_hours', 'ac.cool_f', 'ac.overnight_min'];
export const LOOKBACK_DAYS = 60, SCORE_DAYS = 3, RETAIN_DAYS = 400, ALWAYS_ON_NIGHTS = 7, ALWAYS_ON_MIN = 5;
export type LogEntry = { at: number; day: string; text: string; delta?: string };
export type LearnRun = { at: number; ms: number; queries: number; scored: string[]; predicted: number; waiting: string[];
  anomalies: { opened: string[]; resolved: string[]; open: number }; trim: TrimRecord | null; tiers: Record<string, Tier>;
  steps: Record<string, { ms: number; error?: string }>; errors: string[] };

type PumpBase = { cleanedOn: string | null; from: string | null; to: string | null; baseline: Record<string, { watts: number; n: number }> };
type AcStep = { measured: ReturnType<typeof measuredSavings>; record: LearnAc };
type PredRow = { model: ModelId; target_day: string; target_hour: number; horizon: number; predicted: number; made_at: number; inputs: Record<string, any> };
type Hour = { coolMin: number; coolF: number | null; indoorF: number | null; n: number };
/** A pair to score: predicted vs measured, plus the forecast's horizon band for the 48-hour models. */
export type Pair = { predicted: number; actual: number; band?: string };
export type BandScore = { abs: number; err: number; ape: number | null; den: number; n: number };
export type DayScore = { pred: number; actual: number; err: number; abs: number; ape: number | null; den: number; n: number; bands: Record<string, BandScore> };

const hourStart = (day: string, hour: number) => localAt(day, hour);   // DST-aware (tesla/client.ts)
const expectedBuckets = (day: string) => Math.round((localMidnight(addDays(day, 1)).getTime() - localMidnight(day).getTime()) / 300_000);
export const band = (k: number) => k <= 6 ? 'h1-6' : k <= 24 ? 'h7-24' : 'h25-48';
/** The 48-hour models scored on daily totals, one pair per (day, run) (B2-1, audit L-03). fc48.soc stays hourly: a charge level has no daily total. */
export const DAILY_TOTAL_MODELS: readonly ModelId[] = ['fc48.solar', 'fc48.home'];

/**
 * One day's score for a model from its predicted/actual pairs (the 48-hour kWh models: one pair per run that forecast the day,
 * each a daily total; battery %: one per run and hour; daily models: one):
 * e = predicted − actual (+ = over-predicts), den = max(|actual|, floor), rel = e / den (absolute-unit models: e itself).
 * Stored: the day's predicted and actual (the mean over the pairs, so a daily total stays a daily total however many runs
 * forecast it), mean e, mean |e|, mean |rel|, mean den (bias = mean e / mean den over a window), the pair count, and per horizon
 * band the same four (mean |e|, mean e, mean |rel|, mean den) and its pair count.
 */
export function scoreDay(m: ModelDef, pairs: Pair[]): DayScore | null {
  if (!pairs.length) return null;
  const e = pairs.map(p => p.predicted - p.actual), den = pairs.map(p => m.abs ? 1 : Math.max(Math.abs(p.actual), m.floor));
  const rel = e.map((x, i) => Math.abs(x / den[i]));
  const by: Record<string, number[]> = {};
  pairs.forEach((p, i) => { if (p.band) (by[p.band] ??= []).push(i); });
  const pick = (a: number[], ix: number[]) => ix.map(i => a[i]);
  return { pred: mean(pairs.map(p => p.predicted)), actual: mean(pairs.map(p => p.actual)), err: mean(e), abs: mean(e.map(Math.abs)),
    ape: m.abs ? null : mean(rel), den: mean(den), n: pairs.length,
    bands: Object.fromEntries(Object.entries(by).map(([b, ix]) => [b, { abs: mean(pick(e, ix).map(Math.abs)), err: mean(pick(e, ix)), ape: m.abs ? null : mean(pick(rel, ix)),
      den: mean(pick(den, ix)), n: ix.length }])) };
}

export type RunHour = { hour: number; predicted: number; horizon: number; madeAt: number };
/**
 * B2-1 (audit L-03): a 48-hour run's daily total for one day against the day's measured total, as one pair.
 * Hours that had begun when the run was made count at their measured value on both sides (the "so far + the rest" total), so
 * `actual` is always the real daily total. Every hour that had not begun must be in the run (so the 2-day-old run, which reaches
 * only the day's first hours, is not scored), and every hour of the day needs its energy data (`actual` holds 23, 24 or 24 hour
 * keys on a normal, spring-forward or fall-back day: `hours`). Night solar hours add nothing to either total, so they no longer
 * count as perfect zero-error hours in the solar error. band = the horizon band of the run's last hour of the day (the 05:15 run:
 * its own day → h7-24, tomorrow → h25-48).
 */
export function runDayPair(day: string, run: RunHour[], actual: ReadonlyMap<number, number>, hours: number): Pair | null {
  if (!run.length || actual.size < hours) return null;
  const madeAt = run[0].madeAt, byHour = new Map(run.map(r => [r.hour, r]));
  let pred = 0, act = 0, last: RunHour | null = null;
  for (const [h, a] of actual) {
    act += a;
    if (hourStart(day, h) < madeAt) { pred += a; continue; }   // under way or done when the run was made: known
    const r = byHour.get(h); if (!r) return null;
    pred += r.predicted; if (!last || r.hour > last.hour) last = r;
  }
  return last ? { predicted: pred, actual: act, band: band(last.horizon) } : null;
}
/** The daily_metrics rows for a day's score (metric names 'score:<model>:<part>'); `v` is the model version it scored (B2-3). */
export const scoreMetrics = (model: ModelId, s: DayScore): Array<[string, number]> => [
  [`score:${model}:v`, MODELS[model].version], [`score:${model}:pred`, s.pred], [`score:${model}:actual`, s.actual], [`score:${model}:err`, s.err], [`score:${model}:abs`, s.abs], [`score:${model}:den`, s.den],
  [`score:${model}:n`, s.n], ...(s.ape != null ? [[`score:${model}:ape`, s.ape] as [string, number]] : []),
  ...Object.entries(s.bands).flatMap(([b, v]) => [[`score:${model}:abs@${b}`, v.abs], [`score:${model}:err@${b}`, v.err], [`score:${model}:den@${b}`, v.den],
    [`score:${model}:n@${b}`, v.n], ...(v.ape != null ? [[`score:${model}:ape@${b}`, v.ape]] : [])] as Array<[string, number]>)];

/**
 * Pool kWh for a day from its readings, over the schedule the prediction assumed: the scheduled quarter-hours with a reading use it,
 * the rest of the schedule the mean of those (only when readings cover ≥ 80%), plus any quarter-hour the pump was seen running
 * outside the schedule and the plan's UV kWh. Coverage = scheduled quarter-hours with a reading ÷ scheduled quarter-hours.
 */
export function poolActual(readings: Array<{ ts: number; running: boolean; watts: number }>, sched: Array<[number, number, number?]>, uvKwh = 0) {
  const quarters = scheduledQuarters(sched.map(([start, stop]) => ({ circuitId: 0, start, stop })));
  const measured = meanByQuarter(readings.map(r => ({ ts: r.ts, watts: r.running ? r.watts : 0 })));
  const planned = quarters.filter(Boolean).length; if (!planned) return null;
  const inSched = measured.filter((w, i) => quarters[i] && w != null) as number[], coverage = inSched.length / planned, fill = mean(inSched);
  let wh = 0;
  for (let i = 0; i < 96; i++) wh += quarters[i] ? (measured[i] ?? fill) / 4 : (measured[i] ?? 0) / 4;
  return { kwh: inSched.length ? wh / 1000 + uvKwh : null, coverage: round(coverage, 3) };
}

/* =========================================================================================================================== */
export async function runLearn(siteId: string, o: { now?: number; deadline?: number } = {}): Promise<LearnRun> {
  const t0 = performance.now(), now = o.now ?? Date.now(), today = localDay(new Date(now)), yesterday = addDays(today, -1), from = addDays(today, -LOOKBACK_DAYS);
  learnStats.queries = 0;
  const steps: LearnRun['steps'] = {}, errors: string[] = [], waiting: string[] = [], log: LogEntry[] = [];
  const scored = new Set<string>(), tiers: Record<string, Tier> = {}, anomalies = { opened: [] as string[], resolved: [] as string[], open: 0 };
  let ac: AcStep | null = null, pump: PumpBase | null = null, trim: TrimRecord | null = null, predicted = 0;
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (o.deadline && Date.now() > o.deadline) { steps[name] = { ms: 0, error: 'skipped: out of time' }; errors.push(`${name}: skipped`); return fallback; }
    const s = performance.now(), ms = () => Math.round(performance.now() - s);
    try { const v = await fn(); steps[name] = { ms: ms() }; return v; }
    catch (e) { const msg = (e as Error)?.message ?? String(e); steps[name] = { ms: ms(), error: msg }; errors.push(`${name}: ${msg}`); console.error(`[learn] ${siteId} ${name}: ${msg}`); return fallback; }
  };

  /* ---------- load ---------- */
  const keys = { ac: learnAcKey(siteId), last: `${siteId}:learn:last`, log: `${siteId}:learn:log`, pump: `${siteId}:learn:pump`, pvsLayout: LAYOUT_KEY,
    youRuns: `${siteId}:pool:youRuns`, outsideRuns: `${siteId}:pool:outsideRuns`, clearup: `${siteId}:pool:clearup`,   // the last three: mockup ah's pool scoring
    versions: versionsKey(siteId), home: homeSlopesKey(siteId) };
  const d = await step('load', async () => {
    // one round trip each, sent together (Neon's HTTP driver runs them in parallel; PGlite queues them)
    const [kvRows, energyDaily, energyHourly, soeHourly, nestHourly, pool, extraRows, preds] = await Promise.all([
      lq<{ key: string; value: any }>(`SELECT key, value FROM kv WHERE key = ANY($1::text[])`, [Object.values(keys)]),
      lq<{ day: string; solar: number; home: number; imp: number; exp: number; buckets: number; overnight_kw: number | null; overnight_n: number }>(
        `SELECT day, (SUM(solar_wh) / 1000.0)::float8 solar, (SUM(home_wh) / 1000.0)::float8 home, (SUM(import_wh) / 1000.0)::float8 imp, (SUM(export_wh) / 1000.0)::float8 exp,
           COUNT(*)::int buckets, (SUM(home_wh) FILTER (WHERE hour BETWEEN 1 AND 4) / 1000.0 / NULLIF(COUNT(*) FILTER (WHERE hour BETWEEN 1 AND 4) * 5 / 60.0, 0))::float8 overnight_kw, COUNT(*) FILTER (WHERE hour BETWEEN 1 AND 4)::int overnight_n
         FROM energy WHERE site_id = $1 AND day >= $2 AND day <= $3 GROUP BY day`, [siteId, from, today]),
      lq<{ day: string; hour: number; solar: number; home: number; n: number }>(
        `SELECT day, hour::int, (${hourWh('solar_wh')} / 1000.0)::float8 solar, (${hourWh('home_wh')} / 1000.0)::float8 home, COUNT(*)::int n FROM energy WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`,   // one hour's kWh even for the repeated 01:00 (db.ts hourWh)
        [siteId, addDays(today, -15)]),
      lq<{ day: string; hour: number; n: number; last: number; at: number }>(
        `SELECT day, hour::int, COUNT(*)::int n, ((ARRAY_AGG(soe ORDER BY epoch DESC))[1])::float8 last, MAX(epoch)::float8 at FROM soe WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`,
        [siteId, addDays(today, -9)]),
      // Nest by local hour: cooling minutes (each reading holds until the next, at most 20 minutes), mean setpoint and indoor temperature
      lq<{ day: string; hour: number; cool_min: number; cool_f: number | null; indoor_f: number | null; n: number }>(
        `SELECT day, hour::int, COALESCE(SUM(LEAST(dt, 1200000)) FILTER (WHERE hvac = 'COOLING'), 0)::float8 / 60000 cool_min,
           AVG(cool_f)::float8 cool_f, AVG(indoor_f)::float8 indoor_f, COUNT(*)::int n
         FROM (SELECT day, hour, hvac, cool_f, indoor_f, COALESCE(LEAD(ts) OVER (ORDER BY ts) - ts, 0) dt FROM nest_readings WHERE site_id = $1 AND day >= $2) x
         GROUP BY day, hour`, [siteId, from]),
      lq<{ day: string; ts: number; running: boolean; watts: number; rpm: number }>(
        `SELECT day, ts::float8 ts, running, watts, rpm FROM pool_readings WHERE site_id = $1 AND day >= $2 ORDER BY ts`, [siteId, addDays(today, -14)]),
      lq<{ day: string }>(`SELECT day FROM daily_metrics WHERE site_id = $1 AND metric = 'pool.extra' AND day >= $2`, [siteId, addDays(today, -SCORE_DAYS - 1)]),
      lq<PredRow>(`SELECT model, target_day, target_hour::int, horizon::int, predicted, made_at::float8 made_at, inputs FROM predictions
         WHERE site_id = $1 AND ((target_day >= $2 AND target_day < $3) OR (model LIKE 'ac.%' AND target_day >= $4))`, [siteId, addDays(today, -SCORE_DAYS), today, from]),
    ]);
    const kvs = Object.fromEntries(kvRows.map(r => [r.key, r.value]));
    const nest = new Map<string, Record<number, Hour>>();
    for (const r of nestHourly) (nest.get(r.day) ?? nest.set(r.day, {}).get(r.day)!)[r.hour] = { coolMin: r.cool_min, coolF: r.cool_f, indoorF: r.indoor_f, n: r.n };
    learnStats.queries++; // learnAcKw: one kv read (it recomputes at most hourly)
    const coolKw = (await learnAcKw(siteId)).coolKw;
    learnStats.queries++; // mockup ak: the trip days (4 h or more away), kept out of every at-home model below; a year of them for the home model (B2-8)
    const trips = await tripDays(siteId, addDays(today, -YEAR_DAYS), today, now);
    learnStats.queries += 3; // B2-5: the one always-on definition (breakdown.ts alwaysOnKw): energy, Nest and pool readings of the nights
    const alwaysOn = await alwaysOnKw(siteId, LOOKBACK_DAYS, { now, trips, clearUp: (kvs[keys.clearup] ?? null) as { startedAt: number; until: number } | null });
    return { kvs, energyDaily, energyHourly, soeHourly, nest, pool, poolExtraDays: extraRows.map(r => r.day), preds, coolKw, wx: await wxGti(now), trips, alwaysOn };
  }, null);
  if (!d) return finish();
  const prevLast = d.kvs[keys.last] as LearnRun | undefined, prevAc = d.kvs[keys.ac] as LearnAc | undefined;
  const eHour = new Map(d.energyHourly.map(r => [`${r.day}|${r.hour}`, r]));
  const sHour = new Map(d.soeHourly.map(r => [`${r.day}|${r.hour}`, r]));
  const acKwFallback = median(d.preds.filter(p => p.model === 'ac.shifted' && p.inputs?.acKw).map(p => Number(p.inputs.acKw)));
  const kw = d.coolKw ?? (Number.isFinite(acKwFallback) ? acKwFallback : 3.4);

  /* ---------- home: the year fit of the home model (B2-8) ---------- */
  const homeSlopes = await step('home', async (): Promise<HomeSlopes | null> => {
    // highs and lows: the archive (one pull a day, kv wx:hilo) over the forecast payload's past days, which fill the archive's last few
    const temps: Record<string, Temp> = { ...tempsOf(d.wx), ...await wxHiLo(now) };
    const rows = await lq<{ day: string; kwh: number; buckets: number; extra: boolean }>(
      `SELECT e.day, (SUM(e.home_wh) / 1000.0)::float8 kwh, COUNT(*)::int buckets,
         EXISTS (SELECT 1 FROM daily_metrics m WHERE m.site_id = $1 AND m.day = e.day AND m.metric = 'pool.extra') extra
       FROM energy e WHERE e.site_id = $1 AND e.day >= $2 AND e.day < $3 AND e.home_wh IS NOT NULL GROUP BY e.day`, [siteId, addDays(today, -YEAR_DAYS), today]);
    // left out: trip days, the Clear-up's days and days the pool ran beyond its plan (a Clear-up, your runs: pool.extra)
    const exclude = new Set([...d.trips, ...clearUpDays(d.kvs[keys.clearup], now), ...rows.filter(r => r.extra).map(r => r.day)]);
    const fit = fitYear(yearPoints(rows.map(r => ({ day: r.day, kwh: r.kwh, complete: r.buckets >= .95 * expectedBuckets(r.day) })), temps, exclude));
    if (!fit) { waiting.push(`home model: ${Object.keys(temps).length ? 'fewer than 30 days with a high and a low spanning 10°' : 'no archived temperatures yet'}`); return null; }
    return { day: today, ...fit };
  }, null);
  // a failed or impossible fit keeps the last one
  const slopes = homeSlopes ?? (d.kvs[keys.home] as HomeSlopes | undefined) ?? null;

  /* ---------- ac: measured savings and tomorrow's trim ---------- */
  ac = await step('ac', async (): Promise<AcStep> => {
    const days: AcDay[] = d.preds.filter(p => p.model === 'ac.shifted' && p.target_day < today).map(p => { const i = p.inputs ?? {};
      return { day: p.target_day, control: !!i.control, precool: !!i.precool, high: Number(i.high), sunKwhM2: Number(i.sunKwhM2), mid: Number(i.mid), from: Number(i.from), to: Number(i.to),
        coastFrom: Number(i.coastFrom), coastTo: Number(i.coastTo), hours: Object.fromEntries(Object.entries(d.nest.get(p.target_day) ?? {}).map(([h, x]) => [h, { coolMin: x.coolMin, coolF: x.coolF }])) }; })
      .filter(x => [x.mid, x.from, x.to, x.coastFrom, x.coastTo, x.high, x.sunKwhM2].every(Number.isFinite));
    const measured = measuredSavings(days, kw);
    // B2-4 (O-03): only pre-cool days of the last 21 days teach a trim (the same window trimFor applies)
    const last3 = days.filter(x => ranPrecool(x) && x.day >= addDays(today, -TRIM_WINDOW_DAYS)).sort((a, b) => a.day.localeCompare(b.day)).slice(-3);
    if (last3.length === 3) {
      const raw = await lq<{ day: string; ts: number; indoor_f: number | null; hvac: string }>(`SELECT day, ts::float8 ts, indoor_f, hvac FROM nest_readings WHERE site_id = $1 AND day = ANY($2::text[]) ORDER BY ts`,
        [siteId, last3.map(x => x.day)]);
      const pre: PrecoolDay[] = last3.map(x => { const i = d.preds.find(p => p.model === 'ac.shifted' && p.target_day === x.day)!.inputs;
        return { day: x.day, coastF: Number(i.coastF), deep: Number(i.mid) - Number(i.depth), from: x.from, to: x.to, coastFrom: x.coastFrom, coastTo: x.coastTo,
          readings: raw.filter(r => r.day === x.day).map(r => { const t = rfc3339(new Date(r.ts)); return { h: +t.slice(11, 13) + +t.slice(14, 16) / 60 + +t.slice(17, 19) / 3600, indoorF: r.indoor_f, hvac: r.hvac }; }) }; });
      const t = trimFor(pre, today);
      // kept for today's plan; its learning-log line is written by the plan only if it applies (learn/ac.ts learnedPlan, B2-4)
      if (t) trim = { ...t, day: today, ...(prevAc?.trim?.day === today && prevAc.trim.undone ? { undone: true, undoneAt: prevAc.trim.undoneAt } : {}),
        ...(prevAc?.trim?.day === today && prevAc.trim.logged ? { logged: true } : {}) };
    } else waiting.push(`ac trims: ${last3.length} of 3 pre-cool days in the last ${TRIM_WINDOW_DAYS}`);
    if (!measured.measured) waiting.push(`ac savings: ${measured.precoolDays} of 5 pre-cool days compared with control days`);
    if (measured.measured && !prevAc?.measured?.measured) log.push({ at: now, day: today, text: `AC savings are now measured: ${measured.shiftedKwh} kWh shifted onto solar and ${measured.eveningAvoidedKwh} kWh avoided in the evening per pre-cool day, against ${measured.controlDays} control days`, delta: 'measured' });
    const warm = trim?.warmupFPerH ?? prevAc?.warmupFPerH ?? null;
    return { measured, record: { at: now, day: today, trim, warmupFPerH: warm, coolKw: d.coolKw,
      measured: { measured: measured.measured, shiftedKwh: measured.shiftedKwh, eveningAvoidedKwh: measured.eveningAvoidedKwh, precoolDays: measured.precoolDays, controlDays: measured.controlDays } } satisfies LearnAc };
  }, null);

  /* ---------- metrics: each day's measured values, and the scores of predictions for the last few days ---------- */
  const metricRows = new Map<string, [string, string, number]>();
  const put = (day: string, metric: string, v: number | null | undefined) => { if (v != null && Number.isFinite(v)) metricRows.set(`${day}|${metric}`, [day, metric, v]); };
  await step('metrics', async () => {
    const past = (day: string) => day >= from && day < today;
    for (const r of d.energyDaily) if (past(r.day)) {
      put(r.day, 'solar.kwh', r.solar); put(r.day, 'home.kwh', r.home); put(r.day, 'import.kwh', r.imp); put(r.day, 'export.kwh', r.exp); put(r.day, 'energy.buckets', r.buckets);
      if (r.overnight_n >= 46) put(r.day, 'home.overnight_kw', r.overnight_kw);
    }
    const soeN = new Map<string, number>(); for (const r of d.soeHourly) soeN.set(r.day, (soeN.get(r.day) ?? 0) + r.n);
    for (const [day, n] of soeN) if (past(day)) put(day, 'soe.n', n);
    const temps = new Map<string, number>(); // 'YYYY-MM-DD|H' → outdoor °F
    if (d.wx) {
      d.wx.hourly.time.forEach((t, i) => { const v = d.wx!.hourly.temperature_2m[i]; if (v != null) temps.set(`${t.slice(0, 10)}|${+t.slice(11, 13)}`, v); });
      const g = gtiByDay(d.wx);
      d.wx.daily.time.forEach((day, i) => { if (!past(day)) return; put(day, 'wx.gti', g[day]); put(day, 'wx.rain_mm', d.wx!.daily.precipitation_sum[i] ?? 0); put(day, 'wx.high_f', d.wx!.daily.temperature_2m_max[i]); });
    }
    for (const [day, hours] of d.nest) if (past(day)) {
      const hs = Object.entries(hours).map(([h, x]) => ({ h: +h, ...x })), sp = hs.map(x => x.coolF).filter((v): v is number => v != null), daySp = sp.length ? mean(sp) : null;
      put(day, 'nest.n', hs.reduce((a, x) => a + x.n, 0)); put(day, 'ac.runtime_min', hs.reduce((a, x) => a + x.coolMin, 0)); put(day, 'ac.cool_f', daySp);
      const night = hs.filter(x => x.h >= 1 && x.h <= 4);
      if (night.length) put(day, 'ac.overnight_min', night.reduce((a, x) => a + x.coolMin, 0));
      const dh = Array.from({ length: 24 }, (_, h) => { const t = temps.get(`${day}|${h}`); return t == null ? null : Math.max(0, t - (hours[h]?.coolF ?? daySp ?? 76)); });
      if (dh.filter(v => v != null).length >= 20) put(day, 'ac.degree_hours', dh.reduce((a: number, v) => a + (v ?? 0), 0));
    }
    // always-on (B2-5): the app's one definition, the quiet tenth of 1–5 AM with the AC, the pool pump and a Clear-up masked
    // (breakdown.ts alwaysOnKw); it was the 1–5 AM mean less the AC's minutes × kW, with the pump left in
    for (const n of d.alwaysOn.nights) if (past(n.day)) put(n.day, 'home.alwaysOn_kw', n.kw);
    for (const day of d.trips) if (past(day)) put(day, 'trip.day', 1);   // mockup ak: shown as "trip" in History, skipped by the at-home models
    // per-panel days (mockup u-panels): the last 21 days of PVS readings by roof position, one query (none before the relay's first poll)
    const layout = d.kvs[keys.pvsLayout] as Layout | undefined;
    if (layout) { learnStats.queries++; for (const [day, metric, v] of await panelMetrics(addDays(today, -21), today, layout)) if (past(day)) put(day, metric, v); }
    const poolDays = new Map<string, typeof d.pool>(); for (const r of d.pool) (poolDays.get(r.day) ?? poolDays.set(r.day, []).get(r.day)!).push(r);
    for (const [day, rows] of poolDays) if (past(day)) {
      put(day, 'pool.n', rows.length);
      const byRpm = new Map<number, number[]>();
      for (const r of rows) if (r.running && r.rpm > 0 && r.watts > 0) { const k = Math.round(r.rpm / 50) * 50; (byRpm.get(k) ?? byRpm.set(k, []).get(k)!).push(r.watts); }
      for (const [rpm, w] of byRpm) if (w.length >= 3) { put(day, `pool.w@${rpm}`, median(w)); put(day, `pool.w@${rpm}.n`, w.length); }
    }

    // mockup ah: days the pool ran beyond the plan (a Clear-up, your runs, runs seen outside the schedule) are not scored
    const cu = d.kvs[keys.clearup] as { startedAt: number; until: number } | null | undefined;
    const poolExtra = new Set<string>([...((d.kvs[keys.youRuns] ?? []) as Array<{ day: string }>), ...((d.kvs[keys.outsideRuns] ?? []) as Array<{ day: string }>)].map(r => r.day));
    if (cu?.startedAt) for (let x = localDay(new Date(cu.startedAt)); x <= localDay(new Date(Math.min(cu.until, now))); x = addDays(x, 1)) poolExtra.add(x);
    for (const day of d.poolExtraDays) poolExtra.add(day);
    // scores for the prediction days that are complete: the last SCORE_DAYS days (idempotent, so a missed night catches up)
    const pairs = new Map<string, Pair[]>(); // 'model|day'
    const runs = new Map<string, RunHour[]>();   // 'model|day|made_at' → the run's hours of that day
    const add = (model: string, day: string, p: Pair) => (pairs.get(`${model}|${day}`) ?? pairs.set(`${model}|${day}`, []).get(`${model}|${day}`)!).push(p);
    const TRIP_UNSCORED = ['fc48.home', 'fc48.soc', 'home.alwaysOn', 'ac.shifted', 'ac.eveningAvoided', 'bill.cycleImport'];
    for (const p of d.preds) {
      if (p.target_day >= today || p.target_day < addDays(today, -SCORE_DAYS)) continue;
      const day = p.target_day;
      if (d.trips.has(day) && TRIP_UNSCORED.includes(p.model)) continue;   // mockup ak: an empty house says nothing about the at-home models
      if (versionOf(p.inputs?.version) !== MODELS[p.model]?.version) continue;   // B2-3: a fixed model isn't judged on its predecessor's rows
      if (p.model.startsWith('fc48.')) {
        if (p.made_at > hourStart(day, p.target_hour)) continue; // a forecast only counts for hours that hadn't started
        if (p.model === 'fc48.soc') { const s = sHour.get(`${day}|${p.target_hour}`); if (s) add(p.model, day, { predicted: p.predicted, actual: s.last, band: band(p.horizon) }); }
        else { const k = `${p.model}|${day}|${p.made_at}`; (runs.get(k) ?? runs.set(k, []).get(k)!).push({ hour: p.target_hour, predicted: p.predicted, horizon: p.horizon, madeAt: p.made_at }); }
      } else if (p.model === 'pool.kwhDay') {
        if (p.made_at > hourStart(day, 0)) continue;
        if (poolExtra.has(day)) { put(day, 'pool.extra', 1); continue; }   // mockup ah: the pump ran beyond the plan, so the plan wasn't wrong
        const a = poolActual((poolDays.get(day) ?? []), (p.inputs?.sched ?? []) as Array<[number, number, number]>, Number(p.inputs?.uvKwh ?? 0));
        if (a) put(day, 'pool.coverage', a.coverage);
        if (a?.kwh != null && a.coverage >= .8) add(p.model, day, { predicted: p.predicted, actual: a.kwh });
      } else if (p.model === 'ac.shifted' || p.model === 'ac.eveningAvoided') {
        const m = ac?.measured.perDay.find(x => x.day === day);
        if (m && p.made_at <= hourStart(day, Number(p.inputs?.from ?? 11))) add(p.model, day, { predicted: p.predicted, actual: p.model === 'ac.shifted' ? m.shiftedKwh : m.eveningAvoidedKwh });
      } else if (p.model === 'bill.cycleImport') {
        const f = String(p.inputs?.from ?? ''), n = Math.round((Date.parse(day) - Date.parse(f)) / 864e5) + 1;
        const cyc = d.energyDaily.filter(r => r.day >= f && r.day <= day);
        if (f && cyc.length >= n - 1) add(p.model, day, { predicted: p.predicted, actual: cyc.reduce((a, r) => a + r.imp, 0) });
      } else if (p.model === 'home.alwaysOn') {
        const v = metricRows.get(`${day}|home.alwaysOn_kw`)?.[2];
        if (v != null && p.made_at <= hourStart(day, 1)) add(p.model, day, { predicted: p.predicted, actual: v });
      }
    }
    // B2-1: the 48-hour kWh models, one daily-total pair per (day, run)
    for (const [key, run] of runs) {
      const [model, day] = key.split('|'), act = new Map<number, number>();
      for (let h = 0; h < 24; h++) { const e = eHour.get(`${day}|${h}`); if (e && e.n >= 11) act.set(h, model === 'fc48.solar' ? e.solar : e.home); }
      const pr = runDayPair(day, run, act, Math.min(24, expectedBuckets(day) / 12));
      if (pr) add(model, day, pr);
    }
    const rescored: Array<[string, string]> = [];   // (day, model) scored now: its earlier score rows go first, so no part of an older score survives
    for (const [key, ps] of pairs) {
      const [model, day] = key.split('|') as [ModelId, string], s = scoreDay(MODELS[model], ps);
      if (s) { for (const [metric, v] of scoreMetrics(model, s)) put(day, metric, v); scored.add(model); rescored.push([day, model]); }
    }
    const skipped = [...poolExtra].filter(x => x >= addDays(today, -SCORE_DAYS) && x < today);   // a score from before the extra run was known goes
    const tripScored = [...d.trips].filter(x => x >= addDays(today, -SCORE_DAYS) && x < today);   // and one scored before the trip was known
    if (skipped.length || tripScored.length || rescored.length) await lq(`DELETE FROM daily_metrics WHERE site_id = $1 AND metric LIKE 'score:%' AND (
        (day = ANY($2::text[]) AND split_part(metric, ':', 2) = 'pool.kwhDay')
        OR (day = ANY($3::text[]) AND split_part(metric, ':', 2) = ANY($4::text[]))
        OR (day, split_part(metric, ':', 2)) IN (SELECT * FROM unnest($5::text[], $6::text[])))`,
      [siteId, skipped, tripScored, TRIP_UNSCORED, rescored.map(r => r[0]), rescored.map(r => r[1])]);
    if (!metricRows.size) return;
    const rows = [...metricRows.values()];
    await lq(`INSERT INTO daily_metrics (site_id, day, metric, value) SELECT $1, * FROM unnest($2::text[], $3::text[], $4::float8[])
      ON CONFLICT (site_id, day, metric) DO UPDATE SET value = excluded.value`, [siteId, rows.map(r => r[0]), rows.map(r => r[1]), rows.map(r => r[2])]);
  }, undefined);

  /* ---------- scores: every model × window in one statement ---------- */
  await step('scores', async () => {
    const rows = await lq<{ model: ModelId; window: string; n: number; mae: number | null; mape: number | null; bias: number | null; last_day: string | null }>(
      `INSERT INTO model_scores (site_id, model, "window", mae, mape, bias, n, last_day, updated_at)
       SELECT $1, mm.model, w.name, AVG(s.abs), AVG(s.ape), AVG(s.err) / NULLIF(AVG(s.den), 0), COUNT(s.day)::int, MAX(s.day), $4
       FROM unnest($5::text[], $6::int[]) mm(model, v) CROSS JOIN (VALUES ('7d', 7), ('30d', 30), ('365d', 365)) w(name, days)
       LEFT JOIN (SELECT day, split_part(metric, ':', 2) model,
                    MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'abs') abs, MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'ape') ape,
                    MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'err') err, MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'den') den,
                    COALESCE(MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'v'), 1) v
                  FROM daily_metrics WHERE site_id = $1 AND metric LIKE 'score:%' AND day >= $2 AND day < $3 GROUP BY day, split_part(metric, ':', 2)) s
         ON s.model = mm.model AND s.v = mm.v AND s.day >= to_char($3::date - w.days, 'YYYY-MM-DD')   -- B2-3: the current version's days only
       GROUP BY mm.model, w.name
       ON CONFLICT (site_id, model, "window") DO UPDATE SET mae = excluded.mae, mape = excluded.mape, bias = excluded.bias, n = excluded.n, last_day = excluded.last_day, updated_at = excluded.updated_at
       RETURNING model, "window", n, mae, mape, bias, last_day`, [siteId, addDays(today, -365), today, now, MODEL_IDS, MODEL_IDS.map(id => MODELS[id].version)]);
    for (const id of MODEL_IDS) {
      const m = MODELS[id], r = rows.find(x => x.model === id && x.window === m.window);
      tiers[id] = confidence(m, r && { n: r.n, mae: r.mae, mape: r.mape, bias: r.bias, lastDay: r.last_day }, today, m.kind === 'estimate' && !!ac?.measured.measured).tier;
      const was = prevLast?.tiers?.[id];
      if (was && was !== tiers[id]) log.push({ at: now, day: today, text: `${m.label}: ${was} → ${tiers[id]}`, delta: tiers[id] });
    }
  }, undefined);

  /* ---------- pump: the clean-filter baseline per RPM ---------- */
  pump = await step('pump', async (): Promise<PumpBase> => {
    const prev = d.kvs[keys.pump] as PumpBase | undefined;
    const cleanedOn = (await lq<{ day: string | null }>(`SELECT MAX(day) AS day FROM events WHERE site_id = $1 AND type = 'filter_cleaned'`, [siteId]))[0]?.day ?? null;
    const recentRpm = new Set(d.pool.filter(r => r.running && r.rpm > 0).map(r => String(Math.round(r.rpm / 50) * 50)));
    const settled = prev && prev.cleanedOn === cleanedOn && prev.to && prev.to <= yesterday && [...recentRpm].every(r => r in prev.baseline);
    if (settled) return prev!;
    // 14 days after the last cleaning; with no cleaning logged, the first 60 days of readings
    const rows = await lq<{ rpm: number; watts: number; first: string }>(`WITH f AS (SELECT MIN(day) d FROM pool_readings WHERE site_id = $1)
      SELECT rpm::float8 rpm, watts::float8 watts, (SELECT d FROM f) first FROM pool_readings
      WHERE site_id = $1 AND running AND rpm > 0 AND watts > 0 AND day >= COALESCE($2, (SELECT d FROM f)) AND day < COALESCE($3, to_char((SELECT d FROM f)::date + 60, 'YYYY-MM-DD'))`,
      [siteId, cleanedOn, cleanedOn ? addDays(cleanedOn, 14) : null]);
    const byRpm = new Map<string, number[]>();
    for (const r of rows) { const k = String(Math.round(r.rpm / 50) * 50); (byRpm.get(k) ?? byRpm.set(k, []).get(k)!).push(r.watts); }
    const baseline = Object.fromEntries([...byRpm].filter(([, w]) => w.length >= 10).map(([k, w]) => [k, { watts: round(median(w), 1), n: w.length }]));
    const first = rows[0]?.first ?? null;
    return { cleanedOn, from: cleanedOn ?? first, to: cleanedOn ? addDays(cleanedOn, 14) : first ? addDays(first, 60) : null, baseline };
  }, { cleanedOn: null, from: null, to: null, baseline: {} });

  /* ---------- rules → anomalies ---------- */
  const metrics: MetricsByDay = new Map();
  await step('rules', async () => {
    for (const r of await lq<{ day: string; metric: string; value: number }>(`SELECT day, metric, value FROM daily_metrics WHERE site_id = $1 AND day >= $2 AND day < $3 AND metric NOT LIKE 'score:%'`, [siteId, from, today]))
      (metrics.get(r.day) ?? metrics.set(r.day, {}).get(r.day)!)[r.metric] = r.value;
    // mockup ak: the baselines the rules compare against (always-on, AC run time, use) leave the trip days out, so a trip can't move them
    for (const day of d.trips) { const m = metrics.get(day); if (m) for (const k of TRIP_METRICS) delete m[k]; }
    const open = new Map((await lq<OpenAnomaly>(`SELECT id::int id, kind, day, severity, detail FROM anomalies WHERE site_id = $1 AND resolved_at IS NULL`, [siteId])).map(a => [a.kind, a]));
    const days = Array.from({ length: LOOKBACK_DAYS }, (_, i) => addDays(from, i)).filter(x => x < today);
    const verdicts = evaluateRules({ days, m: metrics, open, pumpBaseline: pump?.baseline ?? {}, expectedBuckets });
    const fire = verdicts.filter(v => v.state === 'fire'), toOpen = fire.filter(v => !open.has(v.kind)), toUpdate = fire.filter(v => open.has(v.kind));
    const toResolve = verdicts.filter(v => v.state === 'clear' && open.has(v.kind));
    for (const v of verdicts) if (v.state === 'wait') waiting.push(`${v.kind}: ${v.detail.body}`);
    const withSeen = (v: Verdict) => JSON.stringify({ ...v.detail, lastSeen: yesterday });
    if (toOpen.length) await lq(`INSERT INTO anomalies (site_id, day, kind, severity, detail, opened_at) SELECT $1, $2, k, s, dt, $6 FROM unnest($3::text[], $4::text[], $5::jsonb[]) u(k, s, dt)
      ON CONFLICT (site_id, kind) WHERE resolved_at IS NULL DO NOTHING`, [siteId, yesterday, toOpen.map(v => v.kind), toOpen.map(v => v.severity), toOpen.map(withSeen), now]);
    if (toUpdate.length) await lq(`UPDATE anomalies a SET detail = u.dt, severity = u.s FROM unnest($2::int[], $3::text[], $4::jsonb[]) u(id, s, dt) WHERE a.site_id = $1 AND a.id = u.id`,
      [siteId, toUpdate.map(v => open.get(v.kind)!.id), toUpdate.map(v => v.severity), toUpdate.map(withSeen)]);
    if (toResolve.length) await lq(`UPDATE anomalies SET resolved_at = $2 WHERE site_id = $1 AND id = ANY($3::int[])`, [siteId, now, toResolve.map(v => open.get(v.kind)!.id)]);
    for (const v of toOpen) log.push({ at: now, day: today, text: `${v.detail.title}: ${v.detail.body}`, delta: v.severity });
    for (const v of toResolve) log.push({ at: now, day: today, text: `Resolved: ${open.get(v.kind)!.detail.title}`, delta: 'resolved' });
    Object.assign(anomalies, { opened: toOpen.map(v => v.kind), resolved: toResolve.map(v => v.kind), open: open.size + toOpen.length - toResolve.length });
  }, undefined);

  /* ---------- predict: today's 48-hour forecast, tonight's always-on load, the billing-cycle projection ---------- */
  await step('predict', async () => {
    const preds: Prediction[] = [];
    // 48-hour forecast: the browser's model (forecast48.ts twin) on the same inputs the Now tab uses. Logged RAW, without the
    // B2-2 bias correction the road shows (learn/bias.ts), so the scores judge the model and never their own feedback
    const fc = fc48Inputs(d.wx, d.energyDaily, d.energyHourly.filter(r => !d.trips.has(r.day)), d.soeHourly, today, d.trips, slopes, clearUpDays(d.kvs[keys.clearup], now));   // mockup ak: trip days aren't at-home days
    if (!fc.ready) waiting.push(`fc48: ${fc.why}`);
    else {
      const info = (await lq<{ info: any }>(`SELECT info FROM sites WHERE id = $1`, [siteId]))[0]?.info ?? {};
      const capKwh = modelKwh(await capacityOf(siteId), (info.nameplate_energy ?? 0) / 1000), maxKw = (info.nameplate_power ?? 0) / 1000 || 10, reservePct = info.backup_reserve_percent ?? 20;
      const startHour = +rfc3339(new Date(now)).slice(11, 13);
      const f = forecast48({ w: fc.w, startDate: today, startHour, soc0: fc.soc0, yieldK: fc.yieldK, profile: fc.profile, capKwh, maxKw, reservePct, dayScale: fc.dayScale });
      const first = { yieldK: round(fc.yieldK, 3), soc0: fc.soc0, capKwh, maxKw, reservePct, startHour, ...(Object.keys(fc.dayScale).length ? { dayScale: fc.dayScale } : {}) };   // mockup ah: logged only when the home model applies
      for (const p of f.points) {
        if (p.k < 1) continue; // the hour already under way is not a forecast
        const at = { day: p.t.slice(0, 10), hour: +p.t.slice(11, 13), horizon: p.k }, inputs = p.k === 1 ? { k: p.k, ...first } : { k: p.k };
        preds.push({ model: 'fc48.solar', ...at, value: round(p.s, 3), inputs }, { model: 'fc48.home', ...at, value: round(p.h, 3), inputs: p.k === 1 ? { ...inputs, profile: fc.profile.map(v => round(v, 3)) } : inputs },
          { model: 'fc48.soc', ...at, value: round(p.soc * 100, 1), inputs });
      }
    }
    // always-on load for tonight (hours 1–4 of tomorrow): the median of the last 7 nights that have thermostat readings, AC taken out
    // (mockup ah: nights without Nest data kept the AC, and before 9/25 the midnight Waterfall, so the median sat at 3.75 kW)
    const nights = Array.from({ length: 30 }, (_, i) => metrics.get(addDays(today, -1 - i))).filter(m => m?.['home.alwaysOn_kw'] != null && m['nest.n'] != null)
      .slice(0, ALWAYS_ON_NIGHTS).map(m => m!['home.alwaysOn_kw']);
    if (nights.length >= ALWAYS_ON_MIN) preds.push({ model: 'home.alwaysOn', day: addDays(today, 1), value: round(median(nights), 3), inputs: { nights: nights.length, acKw: round(kw, 2) } });
    else waiting.push(`home.alwaysOn: ${nights.length} of ${ALWAYS_ON_MIN} nights with thermostat readings`);
    // the billing cycle since the newest bill: what History › Bills projects (kWh bought × 31 ÷ days elapsed), in kWh only
    learnStats.queries++; // listBills: one query
    const bills = await listBills(siteId), last = bills.reduce<typeof bills[number] | null>((a, b) => !a || b.period.to > a.period.to ? b : a, null);
    if (last) {
      const f = last.period.to, end = addDays(f, 30), el = Math.max(1, (Date.parse(today) - Date.parse(f)) / 864e5);
      const soFar = d.energyDaily.filter(r => r.day >= f && r.day <= today), imp = soFar.reduce((a, r) => a + r.imp, 0), exp = soFar.reduce((a, r) => a + r.exp, 0);
      if (today <= end) preds.push({ model: 'bill.cycleImport', day: end, horizon: Math.round((Date.parse(end) - Date.parse(today)) / 864e5), value: round(imp * 31 / el, 1),
        inputs: { from: f, to: end, elapsedDays: el, importSoFar: round(imp, 1), exportSoFar: round(exp, 1) } });
    } else waiting.push('bill.cycleImport: no bill parsed');
    predicted = await logPrediction(siteId, preds, { now });
  }, undefined);

  /* ---------- retention ---------- */
  await step('retention', () => lq(`DELETE FROM predictions WHERE site_id = $1 AND target_day < $2`, [siteId, addDays(today, -RETAIN_DAYS)]), []);
  return finish();

  async function finish(): Promise<LearnRun> {
    const out: LearnRun = { at: now, ms: 0, queries: 0, scored: [...scored], predicted, waiting, anomalies, trim, tiers, steps, errors };
    try {
      const prevLog = (d?.kvs[keys.log] as LogEntry[] | undefined) ?? [];
      const writes: Array<[string, unknown]> = [[keys.last, out], [keys.log, [...log.reverse(), ...prevLog].slice(0, 40)]];
      if (d) writes.push([keys.versions, modelVersions(d.kvs[keys.versions] as ModelVersions | undefined, today)]);
      if (ac) writes.push([keys.ac, ac.record]);
      if (d && pump) writes.push([keys.pump, pump]);
      if (homeSlopes) writes.push([keys.home, homeSlopes]);
      if (!errors.length) writes.push([`${siteId}:error:learn`, null]);   // a clean run clears the last error, in the same write (orchestrator O-10)
      out.ms = Math.round(performance.now() - t0); out.queries = learnStats.queries + 1;
      await lq(`INSERT INTO kv (key, value) SELECT * FROM unnest($1::text[], $2::jsonb[]) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [writes.map(w => w[0]), writes.map(w => JSON.stringify(w[1]))]);
    } catch (e) { errors.push(`kv: ${(e as Error).message}`); }
    if (errors.length) await kv.set(`${siteId}:error:learn`, { at: now, message: errors.join('; ') }).catch(() => {});
    return out;
  }
}

/** B2-3: each model's current version and the first nightly day it ran (kv `<site>:learn:versions`), for "re-learning since". */
export type ModelVersions = Partial<Record<ModelId, { version: number; since: string }>>;
export const versionsKey = (siteId: string) => `${siteId}:learn:versions`;
export function modelVersions(prev: ModelVersions | undefined, today: string): ModelVersions {
  return Object.fromEntries(MODEL_IDS.map(id => { const p = prev?.[id], v = MODELS[id].version;
    return [id, p && p.version === v ? p : { version: v, since: today }]; }));
}

/** The 48-hour forecast's inputs as the browser builds them: yield from the last 30 days, the 14-day hourly home profile, battery % now. */
export function fc48Inputs(w: Wx | null, daily: Array<{ day: string; solar: number }>, hourly: Array<{ day: string; hour: number; home: number }>,
  soe: Array<{ day: string; hour: number; last: number; at: number }>, today: string, trips?: ReadonlySet<string>, slopes?: HomeSlopes | null, clearUp?: ReadonlySet<string>):
  { ready: true; w: Wx; yieldK: number; profile: number[]; soc0: number; dayScale: Record<string, number> } | { ready: false; why: string } {
  if (!w) return { ready: false, why: 'no weather (SITE_LAT/SITE_LON unset or Open-Meteo down)' };
  const yieldK = learnYield(daily.filter(r => r.day >= addDays(today, -30) && r.day < today).map(r => ({ date: r.day, solar: Math.round(r.solar * 100) / 100 })), gtiByDay(w));
  if (!yieldK) return { ready: false, why: 'no solar yield learned yet' };
  const lo = addDays(today, -14), sums = new Map<number, number>();
  for (const r of hourly) if (r.day >= lo && r.day < today) sums.set(r.hour, (sums.get(r.hour) ?? 0) + r.home);
  // mockup ak: the caller leaves trip days out of `hourly`, so the average is over the other days of the 14
  const n = Math.max(1, 14 - [...(trips ?? [])].filter(d => d >= lo && d < today).length), profile = Array.from({ length: 24 }, (_, h) => sums.has(h) ? sums.get(h)! / n : 2);
  const latest = soe.reduce<{ last: number; at: number } | null>((a, r) => !a || r.at > a.at ? r : a, null);
  if (!latest) return { ready: false, why: 'no battery % yet' };
  // mockup ah / B2-8: each day's total from its forecast high and low (homeModel.ts: the year's slopes, the last 14 days' level);
  // the hours keep this profile's shape
  const temps = tempsOf(w), dayScale = dayScales(modelFor(slopes, homePoints(hourly, temps, today, clearUp)), profile, temps, forecastDays(today));
  return { ready: true, w, yieldK, profile, soc0: latest.last, dayScale };
}
