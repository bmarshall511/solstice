// "Where your energy goes" (mockup y): a typical day split into what Solstice can see. AC and pool are the measured figures the History
// card already uses (acKwhBetween with the learned draw, poolKwhBetween). The rest of the house splits two ways from Tesla's 5-minute
// home load: an always-on base (the lowest 30-minute average between 01:00 and 05:00, less the pool pump if it ran then) and big loads
// (runs of 15 min or more at least 3 kW above that base while the AC is off; only the energy above the base counts). What is left is
// "everything else". Big loads are labelled "looks like" a water heater, dryer or oven: whole-home data can't tell those apart.
import { q, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';
import { daySpans } from './flows.js';
import { poolKwhBetween } from './appliances/pool.js';
import { acKwhBetween } from './appliances/ac.js';
import { notify } from './notify.js';

export const BURST_OVER_KW = 3, BURST_MIN_BUCKETS = 3, BASE_WINDOW = 6;   // 3 kW above the base, 15 min, a 30-minute base window
export type Range = 'today' | 'week' | 'month';
export type Burst = { start: number; minutes: number; kw: number; kwh: number };
type Bucket = { epoch: number; day: string; hour: number; kw: number };

/** The always-on base of one night: the lowest 30-minute mean of home kW in 01:00–05:00, or null with too few buckets. */
export function baseOf(buckets: Bucket[]): number | null {
  const night = buckets.filter(b => b.hour >= 1 && b.hour < 5);
  let best: number | null = null;
  for (let i = BASE_WINDOW - 1; i < night.length; i++) {
    const w = night.slice(i - BASE_WINDOW + 1, i + 1); if (w[w.length - 1].epoch - w[0].epoch !== (BASE_WINDOW - 1) * 300_000) continue;   // contiguous only
    const m = w.reduce((a, b) => a + b.kw, 0) / BASE_WINDOW; if (best == null || m < best) best = m;
  }
  return best;
}
/** Runs of BURST_MIN_BUCKETS+ buckets at least BURST_OVER_KW above `base` while the AC is off (`acOn(epoch)`), with the energy above the base. */
export function burstsOf(buckets: Bucket[], base: number, acOn: (start: number) => boolean): Burst[] {
  const out: Burst[] = []; let run: Bucket[] = [];
  const close = () => { if (run.length >= BURST_MIN_BUCKETS) out.push({ start: run[0].epoch, minutes: run.length * 5,
    kw: Math.round(run.reduce((a, b) => a + b.kw, 0) / run.length * 10) / 10, kwh: Math.round(run.reduce((a, b) => a + (b.kw - base) / 12, 0) * 10) / 10 }); run = []; };
  for (const b of buckets) {
    const contiguous = !run.length || b.epoch - run[run.length - 1].epoch === 300_000;
    if (!contiguous) close();
    if (b.kw - base >= BURST_OVER_KW && !acOn(b.epoch)) run.push(b); else close();
  }
  close();
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
    q<{ ts: string; hvac: string }>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`, [siteId, addDays(from, -1), to]),
    q<{ day: string; kw: number }>(`SELECT day, (AVG(CASE WHEN running THEN watts ELSE 0 END) / 1000.0)::float8 kw FROM pool_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 AND hour BETWEEN 1 AND 4 GROUP BY day`, [siteId, from, to]),
  ]);
  const slope = (await kv.get<{ slope: number }>(`${siteId}:ac:slope`))?.slope ?? 2.5;
  const [pool, ac] = await Promise.all([poolKwhBetween(siteId, spans, settings), acKwhBetween(siteId, spans, slope)]);
  const acOn = acMask(nest.map(r => ({ ts: Number(r.ts), hvac: r.hvac }))), pumpKw = new Map(pumpNight.map(p => [p.day, Number(p.kw) || 0]));
  const byDay = new Map<string, Bucket[]>();
  for (const r of rows) { const b = { epoch: Number(r.epoch), day: r.day, hour: r.hour, kw: Number(r.wh) * 12 / 1000 }; const a = byDay.get(r.day); if (a) a.push(b); else byDay.set(r.day, [b]); }
  let home = 0, alwaysOn = 0, big = 0, baseSum = 0, baseDays = 0, burstCount = 0, days = 0; const todayBursts: Burst[] = [];
  for (const s of spans) {
    const bs = byDay.get(s.day) ?? []; if (range !== 'today' && bs.length < 0.9 * (s.lengthMs / 300_000)) continue;   // a full day needs ~all its buckets
    days++;
    home += bs.reduce((a, b) => a + b.kw / 12, 0);
    const raw = baseOf(bs); if (raw == null) continue;
    const base = Math.max(0, raw - (pumpKw.get(s.day) ?? 0));
    baseSum += base; baseDays++;
    alwaysOn += base * Math.min(s.elapsedMs, bs.length * 300_000) / 3600e3;
    const bursts = burstsOf(bs, base, acOn); burstCount += bursts.length; big += bursts.reduce((a, b) => a + b.kwh, 0);
    if (s.day === today) todayBursts.push(...bursts);
  }
  const per = (v: number) => days ? Math.round(v / days * 10) / 10 : 0;
  // AC and pool come as range totals; spread over the days that have energy data, like the rest
  const acKwh = per(ac.kwh * (days / Math.max(1, ac.days || days))), poolKwh = per(pool.kwh * (days / Math.max(1, spans.length)));
  const homeKwh = per(home), onKwh = per(alwaysOn), bigKwh = per(big), rest = Math.max(0, Math.round((homeKwh - acKwh - poolKwh - onKwh - bigKwh) * 10) / 10);
  const share = (v: number) => homeKwh ? Math.round(v / homeKwh * 100) : 0;
  const acHours = ac.acKw ? Math.round(acKwh / ac.acKw * 10) / 10 : null;
  return { range, from, to, days, homeKwh,
    parts: [
      { id: 'ac', kwh: acKwh, share: share(acKwh), conf: ac.source === 'readings' ? 'measured' : 'estimated', hours: acHours, kw: ac.acKw },
      { id: 'alwaysOn', kwh: onKwh, share: share(onKwh), conf: 'measured', kw: baseDays ? Math.round(baseSum / baseDays * 100) / 100 : null },
      { id: 'big', kwh: bigKwh, share: share(bigKwh), conf: 'estimated', perDay: days ? Math.round(burstCount / days * 10) / 10 : 0 },
      { id: 'pool', kwh: poolKwh, share: share(poolKwh), conf: pool.source === 'readings' ? 'measured' : 'estimated' },
      { id: 'other', kwh: rest, share: share(rest), conf: 'estimated' },
    ],
    bursts: range === 'today' ? todayBursts : [],
    trend: await alwaysOnTrend(siteId, now) };
}

/* ---------- the always-on base by month and by night (the trend and the push) ---------- */
const NIGHTS_SQL = `WITH b AS (SELECT day, hour, epoch, AVG(home_wh) OVER w AS m, COUNT(*) OVER w AS n, MIN(epoch) OVER w AS e0
    FROM energy WHERE site_id = $1 AND day >= $2 AND home_wh IS NOT NULL WINDOW w AS (PARTITION BY day ORDER BY epoch ROWS BETWEEN 5 PRECEDING AND CURRENT ROW))
  SELECT day, (MIN(m) * 12 / 1000.0)::float8 kw FROM b WHERE hour BETWEEN 1 AND 4 AND n = 6 AND epoch - e0 = 1500000 AND hour >= 1 GROUP BY day ORDER BY day`;
/** The always-on base of each night since `since` (the pump is not subtracted here; it rarely runs 1–5 AM). */
export const nightBases = (siteId: string, since: string) => q<{ day: string; kw: number }>(NIGHTS_SQL, [siteId, since]);
/** Thirteen months of the base: the median night of each month. Cached a day in kv. */
export async function alwaysOnTrend(siteId: string, now = Date.now()) {
  const key = `${siteId}:breakdown:trend`, hit = await kv.get<{ day: string; months: Array<{ month: string; kw: number }> }>(key), today = localDay(new Date(now));
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
