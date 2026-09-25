// The learning layer's nightly job (docs/audit-designs/learning-layer.md §8), run by the nightly sync cron right after the sync:
//   load     a fixed set of range queries (energy by day and hour, battery %, Nest by hour, pool readings, predictions, kv state)
//   ac       measured savings from control vs pre-cool days; tomorrow morning's trim from the last three pre-cool days
//   metrics  each day's measured values, and yesterday's predictions scored against them → daily_metrics (one upsert)
//   scores   rolling 7/30/365-day MAE, MAPE and bias per model → model_scores (one upsert for every model)
//   pump     the clean-filter baseline per RPM (after the last "I cleaned the filter", else the first 60 days)
//   rules    the anomaly rules → open, update and resolve rows in `anomalies`
//   predict  today's 48-hour forecast, the always-on load for tonight and the billing-cycle projection → predictions (one insert)
// About 20 round trips whatever the data size (no per-model or per-row queries). Every step is timed and caught on its own.
import { kv } from '../db.js';
import { localDay, addDays, localMidnight, rfc3339 } from '../tesla/client.js';
import { learnAcKw } from '../appliances/ac.js';
import { meanByQuarter, scheduledQuarters } from '../appliances/pool.js';
import { listBills } from '../bills.js';
import { MODELS, MODEL_IDS, mean, median, round, type ModelDef, type ModelId } from './models.js';
import { lq, learnStats, logPrediction, type Prediction } from './store.js';
import { confidence, type Tier } from './confidence.js';
import { forecast48, learnYield } from './forecast48.js';
import { measuredSavings, trimFor, ranPrecool, learnAcKey, type AcDay, type PrecoolDay, type LearnAc, type TrimRecord } from './ac.js';
import { evaluateRules, type MetricsByDay, type OpenAnomaly, type Verdict } from './rules.js';
import { wxGti, gtiByDay, type Wx } from './wx.js';

export const LOOKBACK_DAYS = 60, SCORE_DAYS = 3, RETAIN_DAYS = 400;
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
export type DayScore = { pred: number; actual: number; err: number; abs: number; ape: number | null; den: number; n: number; bands: Record<string, number> };

const hourStart = (day: string, hour: number) => localMidnight(day).getTime() + hour * 3600e3;
const expectedBuckets = (day: string) => Math.round((localMidnight(addDays(day, 1)).getTime() - localMidnight(day).getTime()) / 300_000);
const band = (k: number) => k <= 6 ? 'h1-6' : k <= 24 ? 'h7-24' : 'h25-48';

/**
 * One day's score for a model from its predicted/actual pairs (hourly models have up to 48 × horizons; daily models one):
 * e = predicted − actual (+ = over-predicts), den = max(|actual|, floor), rel = e / den (absolute-unit models: e itself).
 * Stored: the day's predicted and actual (summed for kWh-per-hour models, averaged otherwise), mean e, mean |e|, mean |rel|,
 * mean den (bias = mean e / mean den over a window), the pair count, and mean |e| per horizon band.
 */
export function scoreDay(m: ModelDef, pairs: Pair[]): DayScore | null {
  if (!pairs.length) return null;
  const e = pairs.map(p => p.predicted - p.actual), den = pairs.map(p => m.abs ? 1 : Math.max(Math.abs(p.actual), m.floor));
  const agg = (a: number[]) => m.agg === 'sum' ? a.reduce((s, v) => s + v, 0) : mean(a);
  const bands: Record<string, number[]> = {};
  pairs.forEach((p, i) => { if (p.band) (bands[p.band] ??= []).push(Math.abs(e[i])); });
  return { pred: agg(pairs.map(p => p.predicted)), actual: agg(pairs.map(p => p.actual)), err: mean(e), abs: mean(e.map(Math.abs)),
    ape: m.abs ? null : mean(e.map((x, i) => Math.abs(x / den[i]))), den: mean(den), n: pairs.length,
    bands: Object.fromEntries(Object.entries(bands).map(([b, v]) => [b, mean(v)])) };
}
/** The daily_metrics rows for a day's score (metric names 'score:<model>:<part>'). */
export const scoreMetrics = (model: ModelId, s: DayScore): Array<[string, number]> => [
  [`score:${model}:pred`, s.pred], [`score:${model}:actual`, s.actual], [`score:${model}:err`, s.err], [`score:${model}:abs`, s.abs], [`score:${model}:den`, s.den],
  [`score:${model}:n`, s.n], ...(s.ape != null ? [[`score:${model}:ape`, s.ape] as [string, number]] : []),
  ...Object.entries(s.bands).map(([b, v]) => [`score:${model}:abs@${b}`, v] as [string, number])];

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
  const keys = { ac: learnAcKey(siteId), last: `${siteId}:learn:last`, log: `${siteId}:learn:log`, pump: `${siteId}:learn:pump` };
  const d = await step('load', async () => {
    // one round trip each, sent together (Neon's HTTP driver runs them in parallel; PGlite queues them)
    const [kvRows, energyDaily, energyHourly, soeHourly, nestHourly, pool, preds] = await Promise.all([
      lq<{ key: string; value: any }>(`SELECT key, value FROM kv WHERE key = ANY($1::text[])`, [Object.values(keys)]),
      lq<{ day: string; solar: number; home: number; imp: number; exp: number; buckets: number; overnight_kw: number | null; overnight_n: number }>(
        `SELECT day, (SUM(solar_wh) / 1000.0)::float8 solar, (SUM(home_wh) / 1000.0)::float8 home, (SUM(import_wh) / 1000.0)::float8 imp, (SUM(export_wh) / 1000.0)::float8 exp,
           COUNT(*)::int buckets, (SUM(home_wh) FILTER (WHERE hour BETWEEN 1 AND 4) / 1000.0 / 4)::float8 overnight_kw, COUNT(*) FILTER (WHERE hour BETWEEN 1 AND 4)::int overnight_n
         FROM energy WHERE site_id = $1 AND day >= $2 AND day <= $3 GROUP BY day`, [siteId, from, today]),
      lq<{ day: string; hour: number; solar: number; home: number; n: number }>(
        `SELECT day, hour::int, (SUM(solar_wh) / 1000.0)::float8 solar, (SUM(home_wh) / 1000.0)::float8 home, COUNT(*)::int n FROM energy WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`,
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
      lq<PredRow>(`SELECT model, target_day, target_hour::int, horizon::int, predicted, made_at::float8 made_at, inputs FROM predictions
         WHERE site_id = $1 AND ((target_day >= $2 AND target_day < $3) OR (model LIKE 'ac.%' AND target_day >= $4))`, [siteId, addDays(today, -SCORE_DAYS), today, from]),
    ]);
    const kvs = Object.fromEntries(kvRows.map(r => [r.key, r.value]));
    const nest = new Map<string, Record<number, Hour>>();
    for (const r of nestHourly) (nest.get(r.day) ?? nest.set(r.day, {}).get(r.day)!)[r.hour] = { coolMin: r.cool_min, coolF: r.cool_f, indoorF: r.indoor_f, n: r.n };
    learnStats.queries++; // learnAcKw: one kv read (it recomputes at most hourly)
    const coolKw = (await learnAcKw(siteId)).coolKw;
    return { kvs, energyDaily, energyHourly, soeHourly, nest, pool, preds, coolKw, wx: await wxGti(now) };
  }, null);
  if (!d) return finish();
  const prevLast = d.kvs[keys.last] as LearnRun | undefined, prevAc = d.kvs[keys.ac] as LearnAc | undefined;
  const eHour = new Map(d.energyHourly.map(r => [`${r.day}|${r.hour}`, r]));
  const sHour = new Map(d.soeHourly.map(r => [`${r.day}|${r.hour}`, r]));
  const acKwFallback = median(d.preds.filter(p => p.model === 'ac.shifted' && p.inputs?.acKw).map(p => Number(p.inputs.acKw)));
  const kw = d.coolKw ?? (Number.isFinite(acKwFallback) ? acKwFallback : 3.4);

  /* ---------- ac: measured savings and tomorrow's trim ---------- */
  ac = await step('ac', async (): Promise<AcStep> => {
    const days: AcDay[] = d.preds.filter(p => p.model === 'ac.shifted' && p.target_day < today).map(p => { const i = p.inputs ?? {};
      return { day: p.target_day, control: !!i.control, precool: !!i.precool, high: Number(i.high), sunKwhM2: Number(i.sunKwhM2), mid: Number(i.mid), from: Number(i.from), to: Number(i.to),
        coastFrom: Number(i.coastFrom), coastTo: Number(i.coastTo), hours: Object.fromEntries(Object.entries(d.nest.get(p.target_day) ?? {}).map(([h, x]) => [h, { coolMin: x.coolMin, coolF: x.coolF }])) }; })
      .filter(x => [x.mid, x.from, x.to, x.coastFrom, x.coastTo, x.high, x.sunKwhM2].every(Number.isFinite));
    const measured = measuredSavings(days, kw);
    const last3 = days.filter(ranPrecool).sort((a, b) => a.day.localeCompare(b.day)).slice(-3);
    if (last3.length === 3) {
      const raw = await lq<{ day: string; ts: number; indoor_f: number | null; hvac: string }>(`SELECT day, ts::float8 ts, indoor_f, hvac FROM nest_readings WHERE site_id = $1 AND day = ANY($2::text[]) ORDER BY ts`,
        [siteId, last3.map(x => x.day)]);
      const pre: PrecoolDay[] = last3.map(x => { const i = d.preds.find(p => p.model === 'ac.shifted' && p.target_day === x.day)!.inputs;
        return { day: x.day, coastF: Number(i.coastF), deep: Number(i.mid) - Number(i.depth), from: x.from, to: x.to, coastFrom: x.coastFrom, coastTo: x.coastTo,
          readings: raw.filter(r => r.day === x.day).map(r => { const t = rfc3339(new Date(r.ts)); return { h: +t.slice(11, 13) + +t.slice(14, 16) / 60 + +t.slice(17, 19) / 3600, indoorF: r.indoor_f, hvac: r.hvac }; }) }; });
      const t = trimFor(pre);
      if (t) {
        trim = { ...t, day: today, ...(prevAc?.trim?.day === today && prevAc.trim.undone ? { undone: true, undoneAt: prevAc.trim.undoneAt } : {}) };
        log.push({ at: now, day: today, text: `AC trim for today: ${t.what === 'depth' ? `pre-cool ${t.amount > 0 ? 'shallower' : 'deeper'} by ${Math.abs(t.amount)}°` : `coast ${t.amount < 0 ? 'ends' : 'runs'} ${Math.abs(t.amount)} min ${t.amount < 0 ? 'earlier' : 'longer'}`}, because ${t.reason}`, delta: `${t.amount > 0 ? '+' : '−'}${Math.abs(t.amount)} ${t.unit}` });
      }
    } else waiting.push(`ac trims: ${last3.length} of 3 pre-cool days`);
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
    // always-on: the 1–5 AM load with the AC's share (cooling minutes × its learned kW) taken out
    for (const r of d.energyDaily) if (past(r.day) && r.overnight_n >= 46 && r.overnight_kw != null) {
      const acMin = metricRows.get(`${r.day}|ac.overnight_min`)?.[2] ?? 0;
      put(r.day, 'home.alwaysOn_kw', Math.max(0, r.overnight_kw - acMin / 240 * kw));
    }
    const poolDays = new Map<string, typeof d.pool>(); for (const r of d.pool) (poolDays.get(r.day) ?? poolDays.set(r.day, []).get(r.day)!).push(r);
    for (const [day, rows] of poolDays) if (past(day)) {
      put(day, 'pool.n', rows.length);
      const byRpm = new Map<number, number[]>();
      for (const r of rows) if (r.running && r.rpm > 0 && r.watts > 0) { const k = Math.round(r.rpm / 50) * 50; (byRpm.get(k) ?? byRpm.set(k, []).get(k)!).push(r.watts); }
      for (const [rpm, w] of byRpm) if (w.length >= 3) { put(day, `pool.w@${rpm}`, median(w)); put(day, `pool.w@${rpm}.n`, w.length); }
    }

    // scores for the prediction days that are complete: the last SCORE_DAYS days (idempotent, so a missed night catches up)
    const pairs = new Map<string, Pair[]>(); // 'model|day'
    const add = (model: string, day: string, p: Pair) => (pairs.get(`${model}|${day}`) ?? pairs.set(`${model}|${day}`, []).get(`${model}|${day}`)!).push(p);
    for (const p of d.preds) {
      if (p.target_day >= today || p.target_day < addDays(today, -SCORE_DAYS)) continue;
      const day = p.target_day;
      if (p.model.startsWith('fc48.')) {
        if (p.made_at > hourStart(day, p.target_hour)) continue; // a forecast only counts for hours that hadn't started
        if (p.model === 'fc48.soc') { const s = sHour.get(`${day}|${p.target_hour}`); if (s) add(p.model, day, { predicted: p.predicted, actual: s.last, band: band(p.horizon) }); }
        else { const e = eHour.get(`${day}|${p.target_hour}`); if (e && e.n >= 11) add(p.model, day, { predicted: p.predicted, actual: p.model === 'fc48.solar' ? e.solar : e.home, band: band(p.horizon) }); }
      } else if (p.model === 'pool.kwhDay') {
        if (p.made_at > hourStart(day, 0)) continue;
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
    for (const [key, ps] of pairs) {
      const [model, day] = key.split('|') as [ModelId, string], s = scoreDay(MODELS[model], ps);
      if (s) { for (const [metric, v] of scoreMetrics(model, s)) put(day, metric, v); scored.add(model); }
    }
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
       FROM unnest($5::text[]) mm(model) CROSS JOIN (VALUES ('7d', 7), ('30d', 30), ('365d', 365)) w(name, days)
       LEFT JOIN (SELECT day, split_part(metric, ':', 2) model,
                    MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'abs') abs, MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'ape') ape,
                    MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'err') err, MAX(value) FILTER (WHERE split_part(metric, ':', 3) = 'den') den
                  FROM daily_metrics WHERE site_id = $1 AND metric LIKE 'score:%' AND day >= $2 AND day < $3 GROUP BY day, split_part(metric, ':', 2)) s
         ON s.model = mm.model AND s.day >= to_char($3::date - w.days, 'YYYY-MM-DD')
       GROUP BY mm.model, w.name
       ON CONFLICT (site_id, model, "window") DO UPDATE SET mae = excluded.mae, mape = excluded.mape, bias = excluded.bias, n = excluded.n, last_day = excluded.last_day, updated_at = excluded.updated_at
       RETURNING model, "window", n, mae, mape, bias, last_day`, [siteId, addDays(today, -365), today, now, MODEL_IDS]);
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
    // 48-hour forecast: the browser's model (forecast48.ts twin) on the same inputs the Now tab uses
    const fc = fc48Inputs(d.wx, d.energyDaily, d.energyHourly, d.soeHourly, today);
    if (!fc.ready) waiting.push(`fc48: ${fc.why}`);
    else {
      const info = (await lq<{ info: any }>(`SELECT info FROM sites WHERE id = $1`, [siteId]))[0]?.info ?? {};
      const capKwh = (info.nameplate_energy ?? 0) / 1000 || 27, maxKw = (info.nameplate_power ?? 0) / 1000 || 10, reservePct = info.backup_reserve_percent ?? 20;
      const startHour = +rfc3339(new Date(now)).slice(11, 13);
      const f = forecast48({ w: fc.w, startDate: today, startHour, soc0: fc.soc0, yieldK: fc.yieldK, profile: fc.profile, capKwh, maxKw, reservePct });
      const first = { yieldK: round(fc.yieldK, 3), soc0: fc.soc0, capKwh, maxKw, reservePct, startHour };
      for (const p of f.points) {
        if (p.k < 1) continue; // the hour already under way is not a forecast
        const at = { day: p.t.slice(0, 10), hour: +p.t.slice(11, 13), horizon: p.k }, inputs = p.k === 1 ? { k: p.k, ...first } : { k: p.k };
        preds.push({ model: 'fc48.solar', ...at, value: round(p.s, 3), inputs }, { model: 'fc48.home', ...at, value: round(p.h, 3), inputs: p.k === 1 ? { ...inputs, profile: fc.profile.map(v => round(v, 3)) } : inputs },
          { model: 'fc48.soc', ...at, value: round(p.soc * 100, 1), inputs });
      }
    }
    // always-on load for tonight (hours 1–4 of tomorrow): the median of the last 30 nights, AC taken out
    const nights = Array.from({ length: 30 }, (_, i) => metrics.get(addDays(today, -1 - i))?.['home.alwaysOn_kw']).filter((v): v is number => v != null);
    if (nights.length >= 7) preds.push({ model: 'home.alwaysOn', day: addDays(today, 1), value: round(median(nights), 3), inputs: { nights: nights.length, acKw: round(kw, 2) } });
    else waiting.push(`home.alwaysOn: ${nights.length} of 7 nights`);
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
      if (ac) writes.push([keys.ac, ac.record]);
      if (d && pump) writes.push([keys.pump, pump]);
      out.ms = Math.round(performance.now() - t0); out.queries = learnStats.queries + 1;
      await lq(`INSERT INTO kv (key, value) SELECT * FROM unnest($1::text[], $2::jsonb[]) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [writes.map(w => w[0]), writes.map(w => JSON.stringify(w[1]))]);
    } catch (e) { errors.push(`kv: ${(e as Error).message}`); }
    if (errors.length) await kv.set(`${siteId}:error:learn`, { at: now, message: errors.join('; ') }).catch(() => {});
    return out;
  }
}

/** The 48-hour forecast's inputs as the browser builds them: yield from the last 30 days, the 14-day hourly home profile, battery % now. */
export function fc48Inputs(w: Wx | null, daily: Array<{ day: string; solar: number }>, hourly: Array<{ day: string; hour: number; home: number }>,
  soe: Array<{ day: string; hour: number; last: number; at: number }>, today: string):
  { ready: true; w: Wx; yieldK: number; profile: number[]; soc0: number } | { ready: false; why: string } {
  if (!w) return { ready: false, why: 'no weather (SITE_LAT/SITE_LON unset or Open-Meteo down)' };
  const yieldK = learnYield(daily.filter(r => r.day >= addDays(today, -30) && r.day < today).map(r => ({ date: r.day, solar: Math.round(r.solar * 100) / 100 })), gtiByDay(w));
  if (!yieldK) return { ready: false, why: 'no solar yield learned yet' };
  const lo = addDays(today, -14), sums = new Map<number, number>();
  for (const r of hourly) if (r.day >= lo && r.day < today) sums.set(r.hour, (sums.get(r.hour) ?? 0) + r.home);
  const profile = Array.from({ length: 24 }, (_, h) => sums.has(h) ? sums.get(h)! / 14 : 2);
  const latest = soe.reduce<{ last: number; at: number } | null>((a, r) => !a || r.at > a.at ? r : a, null);
  if (!latest) return { ready: false, why: 'no battery % yet' };
  return { ready: true, w, yieldK, profile, soc0: latest.last };
}
