// The trip report (mockup ak frame 6): what the trip used, by system, against "if you'd been home" and "empty, without Vacation mode",
// what Solstice did, the alerts, and what it will do differently next time. Built by the nightly job once a trip has ended (all its
// 5-minute energy is in by then), kept in trip.data.report, pushed the next morning from 7:00.
//   used          Tesla's home kWh over the trip, split: AC (Nest's cooling minutes × the learned draw), pool (the pump's own readings,
//                 each holding until the next for at most 20 minutes, plus the UV lamp), always-on (the quietest 5% of the trip's
//                 5-minute buckets, all the way through), water heater (3.5–5.5 kW steps above that base lasting under 45 minutes) and
//                 everything else
//   empty         the same house empty without Vacation mode: the AC at Nest Eco's 82° from this house's degree-hour model (fitted on its
//                 own non-trip days with Nest readings; 0.095 kWh per °F·h above setpoint − 9 °F until 5 such days exist), the pool's
//                 normal plan, and the rest as measured (Vacation mode doesn't change them)
//   home          the home model (learn/homeModel.ts: kWh = a + b·max(0, high − 70) on the 14 days before the trip) for each trip day
// Pure pieces first (tested on a replay of a real trip), then the database step.
import { q, kv } from '../db.js';
import { localDay, addDays, localAt, rfc3339 } from '../tesla/client.js';
import { siteLocation } from '../site.js';
import { fitHome, homeKwh, type HomePoint } from '../learn/homeModel.js';
import { notify } from '../notify.js';
import { patchTripData, tripsBetween, tripDaysOf, type Trip } from './trip.js';

export const ECO_COOL_F = 82, DEFAULT_K = .095, DEFAULT_DELTA = 9, MIN_FIT_DAYS = 5, UV_W = 60, GAP_MS = 20 * 60_000, PUSH_FROM_HOUR = 7;
const r1 = (v: number) => Math.round(v * 10) / 10;
export type Hourly = Record<string, number>;   // 'YYYY-MM-DDTHH' (Chicago) → outdoor °F
export type ReportInput = {
  from: number; to: number;
  energy: Array<{ epoch: number; homeWh: number }>;               // 5-minute buckets inside the trip
  nest: Array<{ ts: number; hvac: string; coolF: number | null }>;  // readings inside the trip
  pool: Array<{ ts: number; running: boolean; watts: number }>;     // readings inside the trip
  acKw: number; uv: boolean; temps: Hourly; model: { k: number; delta: number; days: number };
  poolNormalKwhDay: number | null; homeFit: { a: number; b: number } | null; highs: Record<string, number>;
  homeBaseKw: number | null; trip: Pick<Trip, 'backAt' | 'data'>; alerts: number;
};
export type Part = { id: 'ac' | 'pool' | 'alwaysOn' | 'waterHeater' | 'else'; used: number; empty: number };
export type Report = { v: 1; from: number; to: number; days: number; usedKwh: number; emptyKwh: number; homeKwh: number | null; savedKwh: number;
  parts: Part[]; awayBaseKw: number; homeBaseKw: number | null; did: string[]; alerts: number; next: string[];
  conf: { ac: 'measured' | 'estimated'; empty: 'estimated'; home: 'estimated' | null }; model: { k: number; delta: number; days: number } };

const hourKey = (ms: number) => rfc3339(new Date(ms)).slice(0, 13);
/** kWh the AC would use over [from, to) holding `setF`, by the degree-hour model (hours without a temperature add nothing). */
export function modelAcKwh(temps: Hourly, from: number, to: number, setF: (ms: number) => number, m: { k: number; delta: number }) {
  let kwh = 0;
  for (let t = Math.floor(from / 3600_000) * 3600_000; t < to; t += 3600_000) {
    const T = temps[hourKey(t)], frac = (Math.min(to, t + 3600_000) - Math.max(from, t)) / 3600_000;
    if (T != null && frac > 0) kwh += m.k * Math.max(0, T - (setF(t) - m.delta)) * frac;
  }
  return kwh;
}
/**
 * The degree-hour model from days with Nest readings: AC kWh a day ≈ k × Σ max(0, T_out − (setpoint − δ)), δ searched from −6 to 14 °F
 * in half degrees, k by least squares. Null with fewer than 5 days.
 */
export function fitAcModel(days: Array<{ acKwh: number; hours: Array<{ t: number | null; sp: number }> }>) {
  if (days.length < MIN_FIT_DAYS) return null;
  let best: { k: number; delta: number; sse: number } | null = null;
  for (let delta = -6; delta <= 14; delta += .5) {
    const x = days.map(d => d.hours.reduce((a, h) => a + (h.t == null ? 0 : Math.max(0, h.t - (h.sp - delta))), 0)), y = days.map(d => d.acKwh);
    const sxx = x.reduce((a, v) => a + v * v, 0); if (!sxx) continue;
    const k = x.reduce((a, v, i) => a + v * y[i], 0) / sxx, sse = y.reduce((a, v, i) => a + (v - k * x[i]) ** 2, 0);
    if (!best || sse < best.sse) best = { k, delta, sse };
  }
  return best && best.k > 0 ? { k: Math.round(best.k * 1000) / 1000, delta: best.delta, days: days.length } : null;
}
/** The trip's always-on (kW): the quietest 5% of its 5-minute buckets. */
export const awayBase = (energy: ReportInput['energy']) => { const kw = energy.map(e => e.homeWh * 12 / 1000).sort((a, b) => a - b); return kw.length ? kw[Math.floor(kw.length * .05)] : 0; };
/** Water-heater bursts: runs of 5-minute buckets 3.5–5.5 kW above the base lasting at most 45 minutes; their energy above the base. */
export function waterHeaterKwh(energy: ReportInput['energy'], base: number) {
  let kwh = 0, run: number[] = [];
  const close = () => { if (run.length && run.length <= 9) kwh += run.reduce((a, v) => a + v, 0) / 12; run = []; };
  for (const e of [...energy].sort((a, b) => a.epoch - b.epoch)) { const above = e.homeWh * 12 / 1000 - base; if (above >= 3.5 && above <= 5.5) run.push(above); else close(); }
  close(); return kwh;
}
/** Pump kWh from its readings: each running reading's watts until the next reading (at most 20 minutes), the UV lamp alongside. */
export function poolKwh(pool: ReportInput['pool'], to: number, uv: boolean) {
  const rows = [...pool].sort((a, b) => a.ts - b.ts); let wh = 0;
  rows.forEach((r, i) => { if (!r.running) return; const dt = Math.min(GAP_MS, (rows[i + 1]?.ts ?? to) - r.ts) / 3600_000; wh += (r.watts + (uv ? UV_W : 0)) * dt; });
  return wh / 1000;
}
/** AC kWh from Nest: cooling time (each reading holding until the next, at most 20 minutes) × the learned draw. */
export function acKwh(nest: ReportInput['nest'], to: number, acKw: number) {
  const rows = [...nest].sort((a, b) => a.ts - b.ts); let ms = 0;
  rows.forEach((r, i) => { if (r.hvac === 'COOLING') ms += Math.min(GAP_MS, (rows[i + 1]?.ts ?? to) - r.ts); });
  return ms / 3600_000 * acKw;
}

/** The report from its inputs (pure). */
export function buildReport(o: ReportInput): Report {
  const days = (o.to - o.from) / 864e5, used = o.energy.reduce((a, e) => a + e.homeWh, 0) / 1000;
  const base = awayBase(o.energy), hours = (o.to - o.from) / 3600_000;
  const ac = acKwh(o.nest, o.to, o.acKw), pool = poolKwh(o.pool, o.to, o.uv), always = Math.min(used, base * hours);
  const wh = waterHeaterKwh(o.energy, base), rest = Math.max(0, used - ac - pool - always - wh);
  const acEmpty = Math.max(ac, modelAcKwh(o.temps, o.from, o.to, () => ECO_COOL_F, o.model)), poolEmpty = o.poolNormalKwhDay != null ? Math.max(pool, o.poolNormalKwhDay * days) : pool;
  const parts: Part[] = [{ id: 'ac', used: r1(ac), empty: r1(acEmpty) }, { id: 'pool', used: r1(pool), empty: r1(poolEmpty) }, { id: 'alwaysOn', used: r1(always), empty: r1(always) },
    { id: 'waterHeater', used: r1(wh), empty: r1(wh) }, { id: 'else', used: r1(rest), empty: r1(rest) }];
  const empty = parts.reduce((a, p) => a + p.empty, 0);
  // home: each (part-)day of the trip at the home model's kWh for its high
  let home: number | null = null;
  if (o.homeFit) {
    home = 0;
    for (let d = localDay(new Date(o.from)); d <= localDay(new Date(o.to - 1)); d = addDays(d, 1)) {
      const a = localAt(d, 0), b = localAt(addDays(d, 1), 0), frac = Math.max(0, (Math.min(o.to, b) - Math.max(o.from, a)) / (b - a));
      if (o.highs[d] != null) home += homeKwh(o.homeFit, o.highs[d]) * frac;
    }
    home = r1(home);
  }
  const ac0 = o.trip.data.ac as { welcome?: { startAt: number; reachedAt?: number; target: number } } | undefined, did: string[] = [], next: string[] = [];
  for (const l of (o.trip.data.log ?? []) as Array<{ text: string; delta?: string }>) if (['ac', 'pool', 'trip', 'watch'].includes(l.delta ?? '') && !/^Vacation mode started|^Trip planned/.test(l.text)) did.push(l.text);
  const w = ac0?.welcome;
  if (w?.reachedAt && o.trip.backAt) { const early = (o.trip.backAt - w.reachedAt) / 3600_000; if (early >= 1) next.push(`The house was ready ${r1(early)} h early, so cooling will start later on a day like that`); else if (early < 0) next.push(`The house reached ${w.target}° ${Math.round(-early * 60)} min after you were due, so cooling will start earlier next time`); }
  if (o.homeBaseKw != null && o.homeBaseKw - base >= .1) next.push(`While you were away the house drew ${r1(base * 100) / 100} kW at its quietest, ${Math.round((o.homeBaseKw - base) * 100) / 100} kW less than when you're home`);
  next.push('Log a pool test so the next trip’s pool plan can learn from it');
  return { v: 1, from: o.from, to: o.to, days: r1(days), usedKwh: r1(used), emptyKwh: r1(empty), homeKwh: home, savedKwh: r1(Math.max(0, empty - used)), parts,
    awayBaseKw: Math.round(base * 100) / 100, homeBaseKw: o.homeBaseKw != null ? Math.round(o.homeBaseKw * 100) / 100 : null, did: did.slice(-12), alerts: o.alerts, next,
    conf: { ac: o.nest.length ? 'measured' : 'estimated', empty: 'estimated', home: o.homeFit ? 'estimated' : null }, model: o.model };
}

/* ---------- the database step ---------- */
/** Hourly outdoor °F for [from, to] (Chicago hours): the learning layer's cache when it covers them, else Open-Meteo (up to 92 days back). */
export async function hourlyTemps(from: number, to: number, fetcher: typeof fetch = fetch): Promise<Hourly> {
  const out: Hourly = {}, c = await kv.get<{ w: { hourly: { time: string[]; temperature_2m: Array<number | null> } } }>('wx:gti');
  c?.w?.hourly?.time?.forEach((t, i) => { const v = c.w.hourly.temperature_2m[i]; if (v != null) out[t.slice(0, 13)] = v; });
  if (out[hourKey(from)] != null && out[hourKey(to - 3600_000)] != null) return out;
  const loc = siteLocation(); if (!loc) return out;
  const past = Math.min(92, Math.ceil((Date.now() - from) / 864e5) + 1);
  const j = await fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&past_days=${past}&forecast_days=1&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=America%2FChicago`,
    { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null) as any;
  j?.hourly?.time?.forEach((t: string, i: number) => { const v = j.hourly.temperature_2m[i]; if (v != null) out[t.slice(0, 13)] = v; });
  return out;
}
type FitRows = { fitNest: Array<{ ts: string; day: string; hvac: string; cool_f: number | null }>; fitEnergy: Array<{ day: string; kwh: number; n: number }>; before: Array<{ v: number }> };
/** The rows the house model fits on: Nest readings and daily home kWh before `at`, and the always-on nights of the 14 days before it. */
async function fitRows(siteId: string, at: number): Promise<FitRows> {
  const [fitNest, fitEnergy, before] = await Promise.all([
    q<{ ts: string; day: string; hvac: string; cool_f: number | null }>(`SELECT ts::text, day, hvac, cool_f FROM nest_readings WHERE site_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts`, [siteId, at - 30 * 864e5, at]),
    q<{ day: string; kwh: number; n: number }>(`SELECT day, (SUM(home_wh) / 1000.0)::float8 kwh, COUNT(*)::int n FROM energy WHERE site_id = $1 AND epoch >= $2 AND epoch < $3 GROUP BY day`, [siteId, at - 15 * 864e5, at]),
    q<{ v: number }>(`SELECT value::float8 v FROM daily_metrics WHERE site_id = $1 AND metric = 'home.alwaysOn_kw' AND day >= $2 AND day < $3`, [siteId, addDays(localDay(new Date(at)), -14), localDay(new Date(at))]),
  ]);
  return { fitNest, fitEnergy, before };
}
/**
 * This house's own model as of `at`, from the 30 days before it (other trips' days left out): the AC's degree-hour model, the home model
 * (kWh against the day's high) and the always-on at home (the median of the nightly figures), plus each day's high from `temps`.
 */
export async function houseModel(siteId: string, at: number, temps: Hourly, acKw: number, rows?: FitRows) {
  const r = rows ?? await fitRows(siteId, at), fitFrom = at - 30 * 864e5;
  const highs: Record<string, number> = {}; for (const [h, v] of Object.entries(temps)) { const d = h.slice(0, 10); highs[d] = Math.max(highs[d] ?? -Infinity, v); }
  const other = tripDaysOf(await tripsBetween(siteId, localDay(new Date(fitFrom)), localDay(new Date(at))), localDay(new Date(fitFrom)), localDay(new Date(at)));
  const byDay = new Map<string, Array<{ ts: number; hvac: string; coolF: number | null }>>();
  for (const x of r.fitNest) if (!other.has(x.day)) (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)!).push({ ts: Number(x.ts), hvac: x.hvac, coolF: x.cool_f });
  const fitDays = [...byDay].filter(([, rows]) => rows.length >= 60).map(([day, rows]) => {
    const sp = (h: number) => { const xs = rows.filter(y => +rfc3339(new Date(y.ts)).slice(11, 13) === h && y.coolF != null).map(y => y.coolF!); return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 77; };
    return { acKwh: acKwh(rows, rows.at(-1)!.ts + 300_000, acKw), hours: Array.from({ length: 24 }, (_, h) => ({ t: temps[`${day}T${String(h).padStart(2, '0')}`] ?? null, sp: sp(h) })) };
  });
  const model = fitAcModel(fitDays) ?? { k: DEFAULT_K, delta: DEFAULT_DELTA, days: 0 };
  const pts: HomePoint[] = r.fitEnergy.filter(x => x.n >= 276 && highs[x.day] != null && !other.has(x.day)).map(x => ({ day: x.day, high: highs[x.day], kwh: x.kwh }));
  const homeFit = fitHome(pts), homeBase = r.before.length ? [...r.before.map(b => b.v)].sort((a, b) => a - b)[Math.floor(r.before.length / 2)] : null;
  return { model, homeFit, homeBase, highs };
}

/**
 * Build and store a trip's report. `deps` come from app.ts: the learned AC draw, the pool's normal kWh a day, whether the UV lamp runs,
 * and (for tests) the hourly temperatures.
 */
export async function tripReport(siteId: string, trip: Trip, deps: { acKw: number; poolNormalKwhDay: number | null; uv: boolean; temps?: Hourly }) {
  const from = trip.startedAt ?? trip.leaveAt, to = trip.endedAt ?? Date.now(), fitFrom = from - 30 * 864e5;   // the model fits on the 30 days before
  const [energy, nest, pool, alerts, rows] = await Promise.all([
    q<{ epoch: string; home_wh: number | null }>(`SELECT epoch::text, home_wh FROM energy WHERE site_id = $1 AND epoch >= $2 AND epoch < $3`, [siteId, from, to]),
    q<{ ts: string; hvac: string; cool_f: number | null }>(`SELECT ts::text, hvac, cool_f FROM nest_readings WHERE site_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts`, [siteId, from, to]),
    q<{ ts: string; running: boolean; watts: number }>(`SELECT ts::text, running, watts FROM pool_readings WHERE site_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts`, [siteId, from, to]),
    q<{ n: number }>(`SELECT COUNT(*)::int n FROM alerts WHERE site_id = $1 AND kind = 'vacation' AND created_at >= $2 AND created_at < $3`, [siteId, new Date(from).toISOString(), new Date(to).toISOString()]),
    fitRows(siteId, from),
  ]);
  const temps = deps.temps ?? await hourlyTemps(fitFrom, to);
  const { model, homeFit: fit, homeBase, highs } = await houseModel(siteId, from, temps, deps.acKw, rows);
  const report = buildReport({ from, to, energy: energy.map(e => ({ epoch: Number(e.epoch), homeWh: Number(e.home_wh ?? 0) })), nest: nest.map(n => ({ ts: Number(n.ts), hvac: n.hvac, coolF: n.cool_f })),
    pool: pool.map(p => ({ ts: Number(p.ts), running: p.running, watts: Number(p.watts) })), acKw: deps.acKw, uv: deps.uv, temps, model, poolNormalKwhDay: deps.poolNormalKwhDay,
    homeFit: fit, highs, homeBaseKw: homeBase, trip, alerts: alerts[0]?.n ?? 0 });
  await patchTripData(trip.id, { report });
  return report;
}

/** From 7:00 on the morning after a trip ends: one push that its report is ready (the nightly job built it). */
export async function reportPush(siteId: string, trip: Trip, now = Date.now()) {
  const r = trip.data.report as Report | undefined; if (!r || trip.data.reportPushedAt) return { skipped: true };
  if (+rfc3339(new Date(now)).slice(11, 13) < PUSH_FROM_HOUR) return { waiting: true };
  await patchTripData(trip.id, { reportPushedAt: now });
  const res = await notify(siteId, 'vacation', 'Your trip report', `${r.usedKwh} kWh over ${r.days} days, against about ${r.emptyKwh} empty without Vacation mode${r.homeKwh != null ? ` and ${r.homeKwh} if you'd been home` : ''}.`,
    { report: trip.id }, { key: `vac:report:${trip.id}`, windowH: 24 * 30, now, url: '/?go=v-now&trip=report' });
  return { notified: res.stored };
}

/* ---------- the estimate on the Vacation sheet (frame 2) ---------- */
/** Measured on this house's past trip (Phase 1 audit): the always-on away, a night's water-heater burst, and the small loads, a day. */
export const AWAY_BASE_KW = .47, WH_KWH_DAY = 1.3, SMALL_KWH_DAY = 2;
/**
 * A trip's estimate before it starts, per day and in total: "a day at home" (the home model at each day's forecast high), "empty, without
 * Vacation mode" (the away base, a water-heater burst and small loads, the AC at Nest Eco's 82° and the pool's normal plan) and "with
 * Vacation mode" (the same with the AC holding 85° and the trip pool plan). Days past the forecast take the last 7 days' hours.
 * The away base and loads come from the last trip's report when there is one.
 */
export async function estimateTrip(siteId: string, o: { leaveAt: number; backAt: number | null; acKw: number; poolNormalKwhDay: number | null; poolTripKwhDay: number | null; temps?: Hourly; now?: number }) {
  const now = o.now ?? Date.now(), from = Math.max(o.leaveAt, now), to = o.backAt ?? from + 7 * 864e5, temps = o.temps ?? await hourlyTemps(now - 31 * 864e5, now);
  const { model, homeFit, highs } = await houseModel(siteId, now, temps, o.acKw);
  const last = (await q<{ report: Report | null }>(`SELECT data->'report' report FROM trips WHERE site_id = $1 AND state = 'ended' AND data ? 'report' ORDER BY ended_at DESC LIMIT 1`, [siteId]))[0]?.report ?? null;
  const base = last?.awayBaseKw ?? AWAY_BASE_KW, lastDays = last?.days || 1;
  const wh = last ? (last.parts.find(p => p.id === 'waterHeater')?.used ?? 0) / lastDays : WH_KWH_DAY, small = last ? (last.parts.find(p => p.id === 'else')?.used ?? 0) / lastDays : SMALL_KWH_DAY;
  // the typical hour of the last 7 days, for days past the forecast
  const typical = Array.from({ length: 24 }, (_, h) => { const xs = Object.entries(temps).filter(([k]) => +k.slice(11, 13) === h && Date.parse(`${k.slice(0, 10)}T12:00:00Z`) > now - 8 * 864e5).map(([, v]) => v); return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null; });
  const t: Hourly = { ...temps };
  for (let x = Math.floor(from / 3600_000) * 3600_000; x < to; x += 3600_000) { const k = hourKey(x); if (t[k] == null && typical[+k.slice(11, 13)] != null) t[k] = typical[+k.slice(11, 13)]!; }
  const days = (to - from) / 864e5, acEmpty = modelAcKwh(t, from, to, () => ECO_COOL_F, model), acTrip = modelAcKwh(t, from, to, () => 85, model);
  const fixed = (base * 24 + wh + small) * days, poolEmpty = (o.poolNormalKwhDay ?? 0) * days, poolTrip = (o.poolTripKwhDay ?? o.poolNormalKwhDay ?? 0) * days;
  let home: number | null = null;
  if (homeFit) { home = 0; for (let d = localDay(new Date(from)); d <= localDay(new Date(to - 1)); d = addDays(d, 1)) {
    const a = localAt(d, 0), b = localAt(addDays(d, 1), 0), frac = Math.max(0, (Math.min(to, b) - Math.max(from, a)) / (b - a)), high = highs[d] ?? Math.max(...Object.entries(t).filter(([k]) => k.startsWith(d)).map(([, v]) => v), -Infinity);
    if (Number.isFinite(high)) home += homeKwh(homeFit, high) * frac; } }
  const empty = fixed + acEmpty + poolEmpty, vacation = fixed + acTrip + poolTrip, per = (v: number) => r1(v / days);
  return { days: r1(days), open: o.backAt == null, perDay: { home: home != null ? per(home) : null, empty: per(empty), vacation: per(vacation) },
    total: { home: home != null ? r1(home) : null, empty: r1(empty), vacation: r1(vacation) },
    saving: { acPerDay: per(acEmpty - acTrip), poolPerDay: per(poolEmpty - poolTrip), totalKwh: r1(empty - vacation) },
    model: { ...model, fromLastTrip: !!last }, conf: 'estimated' as const };
}
