// "Where your energy goes" (mockup y): a typical day split into what Solstice can see. AC and pool are the measured figures the History
// card already uses (acKwhBetween with the learned draw, poolKwhBetween). The rest of the house splits two ways from Tesla's 5-minute
// home load: an always-on base (the quietest tenth of the 01:00–05:00 buckets while the AC is off, less the pool pump if it ran then) and
// big loads (runs of 15 min or more at least 3 kW above that base once the AC's own draw is taken out; only the energy above the base
// counts). What is left is "everything else". Only days with Nest readings are split: without them the AC can't be told apart. Big loads
// are labelled "looks like" a water heater, dryer or oven: whole-home data can't tell those apart.
import { q, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';
import { daySpans } from './flows.js';
import { poolKwhBetween } from './appliances/pool.js';
import { acKwhBetween } from './appliances/ac.js';
import { notify } from './notify.js';

export const BURST_OVER_KW = 3, BURST_MIN_BUCKETS = 3, BASE_QUANTILE = .1, NEST_COVERAGE = .8;   // 3 kW over the base for 15 min; the quietest tenth
export type Range = 'today' | 'week' | 'month';
export type Burst = { start: number; minutes: number; kw: number; kwh: number };
type Bucket = { epoch: number; day: string; hour: number; kw: number };

/**
 * The always-on base of one night: the quietest tenth of its 01:00–05:00 buckets with the AC off, or null with fewer than 12 such
 * buckets. (A lowest 30-minute window failed on hot nights: the AC cycles every 30–40 minutes, so no window is free of it.)
 */
export function baseOf(buckets: Bucket[], acOn: (start: number) => boolean = () => false): number | null {
  const night = buckets.filter(b => b.hour >= 1 && b.hour < 5 && !acOn(b.epoch)).map(b => b.kw).sort((a, b) => a - b);
  return night.length >= 12 ? night[Math.floor(night.length * BASE_QUANTILE)] : null;
}
/** Runs of BURST_MIN_BUCKETS+ buckets at least BURST_OVER_KW above `base` once the AC's draw (`acKw` while `acOn`) is taken out, with the energy above the base. */
export function burstsOf(buckets: Bucket[], base: number, acOn: (start: number) => boolean, acKw = 0): Burst[] {
  const out: Burst[] = []; let run: Bucket[] = [];
  const close = () => { if (run.length >= BURST_MIN_BUCKETS) out.push({ start: run[0].epoch, minutes: run.length * 5,
    kw: Math.round(run.reduce((a, b) => a + b.kw, 0) / run.length * 10) / 10, kwh: Math.round(run.reduce((a, b) => a + (b.kw - base) / 12, 0) * 10) / 10 }); run = []; };
  for (const b of buckets) {
    const contiguous = !run.length || b.epoch - run[run.length - 1].epoch === 300_000;
    if (!contiguous) close();
    const kw = b.kw - (acOn(b.epoch) ? acKw : 0);
    if (kw - base >= BURST_OVER_KW) run.push({ ...b, kw }); else close();
  }
  close();
  return out;
}
/** Minutes of each local day that Nest readings cover (each holds until the next, at most 20 min). */
export function nestCoverage(readings: Array<{ ts: number; day: string }>) {
  const out = new Map<string, number>();
  for (let i = 0; i < readings.length; i++) { const r = readings[i], dt = Math.min(20 * 60_000, (readings[i + 1]?.ts ?? r.ts + 5 * 60_000) - r.ts); out.set(r.day, (out.get(r.day) ?? 0) + dt / 60_000); }
  return out;
}
/** Whether the AC ran during a bucket, from Nest readings (each holds until the next, at most 20 min). */
export function acMask(readings: Array<{ ts: number; hvac: string }>) {
  const on: Array<[number, number]> = [];
  for (let i = 0; i < readings.length; i++) { const r = readings[i]; if (r.hvac !== 'COOLING' && r.hvac !== 'HEATING') continue;
    const end = Math.min(r.ts + 20 * 60_000, readings[i + 1]?.ts ?? r.ts + 20 * 60_000); on.push([r.ts, end]); }
  return (start: number) => on.some(([a, b]) => a < start + 300_000 && b > start);
}

/** GET /api/breakdown?range=today|week|month: kWh a day by part (today: so far), today's bursts, the always-on trend. */
export async function breakdownFor(siteId: string, range: Range, settings: Record<string, any>, now = Date.now()) {
  const today = localDay(new Date(now)), from = range === 'today' ? today : addDays(today, range === 'week' ? -7 : -30), to = range === 'today' ? today : addDays(today, -1);
  const spans = daySpans(from, to, now);
  const [rows, nest, pumpNight] = await Promise.all([
    q<{ epoch: string; day: string; hour: number; wh: number }>(`SELECT epoch::text, day, hour::int, home_wh::float8 wh FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3 AND home_wh IS NOT NULL ORDER BY epoch`, [siteId, from, to]),
    q<{ ts: string; day: string; hvac: string }>(`SELECT ts::text, day, hvac FROM nest_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`, [siteId, addDays(from, -1), to]),
    q<{ day: string; kw: number }>(`SELECT day, (AVG(CASE WHEN running THEN watts ELSE 0 END) / 1000.0)::float8 kw FROM pool_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 AND hour BETWEEN 1 AND 4 GROUP BY day`, [siteId, from, to]),
  ]);
  const slope = (await kv.get<{ slope: number }>(`${siteId}:ac:slope`))?.slope ?? 2.5;
  const [pool, ac] = await Promise.all([poolKwhBetween(siteId, spans, settings), acKwhBetween(siteId, spans, slope)]);
  const nr = nest.map(r => ({ ts: Number(r.ts), day: r.day, hvac: r.hvac })), acOn = acMask(nr), covered = nestCoverage(nr), pumpKw = new Map(pumpNight.map(p => [p.day, Number(p.kw) || 0]));
  const byDay = new Map<string, Bucket[]>();
  for (const r of rows) { const b = { epoch: Number(r.epoch), day: r.day, hour: r.hour, kw: Number(r.wh) * 12 / 1000 }; const a = byDay.get(r.day); if (a) a.push(b); else byDay.set(r.day, [b]); }
  let home = 0, alwaysOn = 0, big = 0, baseSum = 0, baseDays = 0, burstCount = 0, days = 0, acSum = 0, acDays = 0; const todayBursts: Burst[] = [], allBursts: Burst[] = [];
  const acKwNow = ac.acKw ?? 2.7;
  for (const s of spans) {
    const bs = byDay.get(s.day) ?? []; if (range !== 'today' && bs.length < 0.9 * (s.lengthMs / 300_000)) continue;   // a full day needs ~all its buckets
    if ((covered.get(s.day) ?? 0) < NEST_COVERAGE * s.elapsedMs / 60_000) continue;                                   // without Nest the AC can't be told apart
    days++;
    const dayAcH = nr.filter(r => r.day === s.day).reduce((a, r, i, arr) => a + ((r.hvac === 'COOLING' || r.hvac === 'HEATING') ? Math.min(20, ((arr[i + 1]?.ts ?? r.ts + 300_000) - r.ts) / 60_000) / 60 : 0), 0);
    acSum += dayAcH * acKwNow; acDays++;
    home += bs.reduce((a, b) => a + b.kw / 12, 0);
    const raw = baseOf(bs, acOn); if (raw == null) continue;
    const base = Math.max(0, raw - (pumpKw.get(s.day) ?? 0));
    baseSum += base; baseDays++;
    alwaysOn += base * Math.min(s.elapsedMs, bs.length * 300_000) / 3600e3;
    const bursts = burstsOf(bs, base, acOn, acKwNow); burstCount += bursts.length; allBursts.push(...bursts); big += bursts.reduce((a, b) => a + b.kwh, 0);
    if (s.day === today) todayBursts.push(...bursts);
  }
  const per = (v: number) => days ? Math.round(v / days * 10) / 10 : 0;
  // AC from the same covered days as everything else (cooling or heating time x the learned draw); pool as the History card has it
  const acKwh = per(acSum), poolKwh = per(pool.kwh * (days / Math.max(1, spans.length)));
  const homeKwh = per(home), onKwh = per(alwaysOn), bigKwh = per(big), rest = Math.max(0, Math.round((homeKwh - acKwh - poolKwh - onKwh - bigKwh) * 10) / 10);
  const share = (v: number) => homeKwh ? Math.round(v / homeKwh * 100) : 0;
  const acHours = acDays ? Math.round(acSum / acKwNow / acDays * 10) / 10 : null;
  return { range, from, to, days, spanDays: spans.length, homeKwh,
    parts: [
      { id: 'ac', kwh: acKwh, share: share(acKwh), conf: 'measured', hours: acHours, kw: acKwNow },
      { id: 'alwaysOn', kwh: onKwh, share: share(onKwh), conf: 'measured', kw: baseDays ? Math.round(baseSum / baseDays * 100) / 100 : null },
      { id: 'big', kwh: bigKwh, share: share(bigKwh), conf: 'estimated', perDay: days ? Math.round(burstCount / days * 10) / 10 : 0,
        minutes: allBursts.length ? [Math.min(...allBursts.map(b => b.minutes)), Math.max(...allBursts.map(b => b.minutes))] : null,
        burstKw: allBursts.length ? Math.round(allBursts.reduce((a, b) => a + b.kw * b.minutes, 0) / allBursts.reduce((a, b) => a + b.minutes, 0) * 10) / 10 : null },
      { id: 'pool', kwh: poolKwh, share: share(poolKwh), conf: pool.source === 'readings' ? 'measured' : 'estimated' },
      { id: 'other', kwh: rest, share: share(rest), conf: 'estimated' },
    ],
    bursts: range === 'today' ? todayBursts : [],
    trend: await alwaysOnTrend(siteId, now) };
}

/* ---------- the always-on base by month and by night (the trend and the push) ---------- */
const NIGHTS_SQL = `SELECT day, (PERCENTILE_CONT(${BASE_QUANTILE}) WITHIN GROUP (ORDER BY home_wh) * 12 / 1000.0)::float8 kw
  FROM energy WHERE site_id = $1 AND day >= $2 AND hour BETWEEN 1 AND 4 AND home_wh IS NOT NULL GROUP BY day HAVING COUNT(*) >= 40 ORDER BY day`;
/** The quietest tenth of each night's 01:00–05:00 buckets since `since`, for the 13-month trend (no AC mask: Nest history is shorter). */
export const nightBases = (siteId: string, since: string) => q<{ day: string; kw: number }>(NIGHTS_SQL, [siteId, since]);
/** Thirteen months of the base: the median night of each month. Cached a day in kv. */
export async function alwaysOnTrend(siteId: string, now = Date.now()) {
  const key = `${siteId}:breakdown:trend:v2`, hit = await kv.get<{ day: string; months: Array<{ month: string; kw: number }> }>(key), today = localDay(new Date(now));
  if (hit?.day === today) return hit.months;
  const nights = await nightBases(siteId, `${addDays(today, -400).slice(0, 7)}-01`), byMonth = new Map<string, number[]>();
  for (const n of nights) { const m = n.day.slice(0, 7), a = byMonth.get(m); if (a) a.push(Number(n.kw)); else byMonth.set(m, [Number(n.kw)]); }
  const months = [...byMonth.entries()].slice(-13).map(([month, v]) => ({ month, kw: Math.round([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] * 100) / 100 }));
  await kv.set(key, { day: today, months });
  return months;
}
/**
 * Nightly: one `anomaly` push when the base has been at least 0.3 kW above its 30-day median for the last 3 nights; not again until it
 * has come back within 0.15 kW (kv `<site>:alwaysOn:alerted`).
 */
export async function alwaysOnWatch(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), nights = (await nightBases(siteId, addDays(today, -34))).filter(n => n.day < today).map(n => ({ day: n.day, kw: Number(n.kw) }));
  if (nights.length < 20) return { skipped: 'too few nights' };
  const last3 = nights.slice(-3), prior = nights.slice(-33, -3).map(n => n.kw).sort((a, b) => a - b), med = prior[Math.floor(prior.length / 2)];
  const key = `${siteId}:alwaysOn:alerted`, alerted = !!(await kv.get<boolean>(key)), latest = last3[last3.length - 1].kw;
  if (alerted && latest <= med + 0.15) { await kv.set(key, false); return { cleared: true, med }; }
  if (alerted || last3.length < 3 || !last3.every(n => n.kw >= med + 0.3)) return { ok: true, med, latest };
  const avg = last3.reduce((a, n) => a + n.kw, 0) / 3;
  await kv.set(key, true);
  return notify(siteId, 'anomaly', `Always-on is up: ${avg.toFixed(1)} kW`,
    `Three nights at ${avg.toFixed(1)} kW against your usual ${med.toFixed(1)} kW. About ${Math.round((avg - med) * 24)} kWh a day more. A fridge or freezer may be struggling, or something was left on.`,
    { kw: Math.round(avg * 100) / 100, usual: Math.round(med * 100) / 100 }, { key: `alwaysOn:${today}`, now, url: '/?go=v-ins&p=home' });
}
