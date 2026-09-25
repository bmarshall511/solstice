// One Chicago day, hour by hour, for the whole-home twin on the Now card (GET /api/appliances/day, mockup k-home-twin).
// Database only: it never calls ScreenLogic or Nest (no readPool/readNest), so replaying a day adds no device or SDM traffic.
// One query per table (energy, soe, pool_readings, nest_readings, kv), run together; nothing is queried per hour.
// Privacy: the endpoint is owner-only like every /api route, and it still leaves out Nest `eco` and humidity (eco reveals Away).
import { q } from '../db.js';
import { localDay } from '../tesla/client.js';
import { hourlyRpm, powerModel, pumpSchedules, meanByQuarter, quarterWh, type QuarterWatts } from './pool.js';
import type { PoolSnapshot } from './screenlogic.js';
import { AC_DEFAULTS, type AcSettings } from './ac.js';

export type AcPhase = 'pre-cool' | 'cool' | 'coast' | 'idle';
export type DayEnergy = { solarKw: number; homeKw: number; batteryKw: number; gridKw: number; importKw: number; exportKw: number; soc: number | null; buckets: number };
export type DayPool = { running: boolean; rpm: number; watts: number; meanKw: number; source: 'measured' | 'schedule' };
export type DayAc = { on: boolean; phase: AcPhase; setpointF: number | null; indoorF: number | null; kw: number; meanKw: number };
export type DayHour = { hour: number; energy: DayEnergy | null; pool: DayPool | null; ac: DayAc | null };
export type ApplianceDay = { date: string; acKw: number; coverage: { pool: number; nest: number }; hours: DayHour[] };

// Row shapes of the five queries (numbers arrive as float8/int, timestamps as text).
export type EnergyRow = { hour: number; n: number; solar: number; home: number; imp: number; exp: number; chg: number; dis: number };
export type SocRow = { hour: number; soc: number };
export type PoolRow = { ts: string | null; running: boolean | null; watts: number; rpm: number; n: number | null };
export type NestRow = { hour: number; n: number; cooling: number; indoor: number | null; cool: number | null };
type Sched = { circuitId: number; start: number; stop: number; rpm?: number };
type Applied = { plan?: { schedules?: Sched[] } } | null;

const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;
const HOUR = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d)) % 24;

/**
 * What the AC was doing in an hour, from the thermostat alone. The comfort plan (ac.ts planFor) only ever moves the cooling
 * setpoint off the middle of the owner's band for two steps: below it to pre-cool on solar surplus, up to the coast setpoint to
 * ride the Powerwalls into the evening. So in daytime hours (nightTo–nightFrom) a setpoint below the middle reads as pre-cool
 * while cooling, and one above it (up to the coast setpoint) reads as coast while not cooling. Anything else is cool / idle.
 */
export function acPhase(o: { on: boolean; setpointF: number | null; hour: number; settings: AcSettings }): AcPhase {
  const s = o.settings, b = s.band, sp = o.setpointF;
  const mid = Math.min(b.homeHi, Math.max(b.homeLo, Math.round((b.homeLo + b.homeHi) / 2)));
  const day = o.hour >= s.nightTo && o.hour < s.nightFrom;
  if (o.on) return day && sp != null && sp < mid - .25 ? 'pre-cool' : 'cool';
  return day && sp != null && sp > mid + .25 && sp <= Math.max(s.coastF, b.homeHi) + .25 ? 'coast' : 'idle';
}

/** AC power while cooling: the learned step from Tesla's load (ac.ts learnAcKw), else the heat-model estimate acDetail uses. */
export function acKwFrom(learned: { learned?: { coolKw?: number | null } } | null | undefined, slope: { slope?: number } | null | undefined) {
  const s = slope?.slope ?? 2.5;
  return learned?.learned?.coolKw ?? Math.max(2, Math.min(5, s * 1.3));
}

/**
 * Assemble the day from the query rows (pure). `span` is how many hours of the day have happened: 24 for a past day, the current
 * hour + 1 today, 0 for a future day. Hours after the span get no pool schedule, so nothing is shown for them.
 */
export function buildDay(o: { date: string; span: number; energy: EnergyRow[]; soc: SocRow[]; pool: PoolRow[]; nest: NestRow[];
  snapshot: PoolSnapshot | null; applied: Applied; settings: AcSettings; acKw: number }): ApplianceDay {
  const E = new Map(o.energy.map(r => [Number(r.hour), r])), SOC = new Map(o.soc.map(r => [Number(r.hour), Number(r.soc)]));
  const N = new Map(o.nest.map(r => [Number(r.hour), r]));

  // pool: the day's readings (ts set) and the pump's measured watts per RPM (ts null: the power-model points, ≥ 3 readings each)
  const readings = o.pool.filter(r => r.ts != null), W = powerModel(o.pool.filter(r => r.ts == null).map(r => ({ rpm: Number(r.rpm), watts: Number(r.watts) })));
  const byHour = new Map<number, PoolRow[]>();
  for (const r of readings) { const h = hourOfTs(Number(r.ts)); (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(r); }
  const measured: QuarterWatts = meanByQuarter(readings.map(r => ({ ts: Number(r.ts), watts: r.running ? Number(r.watts) : 0 })));
  // the stored schedule: the last controller snapshot's pump programs, else the plan Solstice last applied
  let sched: { schedules: Sched[]; speeds: Map<number, number> } | null = null;
  const ps = pumpSchedules(o.snapshot);
  if (ps.schedules.length) sched = ps;
  else if (o.applied?.plan?.schedules?.length) { const s = o.applied.plan.schedules; sched = { schedules: s, speeds: new Map(s.map(x => [x.circuitId, Number(x.rpm ?? 0)])) }; }
  const prof = hourlyRpm(sched?.schedules ?? [], sched?.speeds ?? new Map());
  const wh = quarterWh(prof, W, measured); // pump Wh per quarter-hour: measured watts where read, the schedule × curve elsewhere

  const hours: DayHour[] = Array.from({ length: 24 }, (_, hour) => {
    const e = E.get(hour), n = N.get(hour), rows = byHour.get(hour) ?? [], inSpan = hour < o.span;
    const energy: DayEnergy | null = e && Number(e.n) > 0 ? { solarKw: r2(e.solar), homeKw: r2(e.home), batteryKw: r2(e.dis - e.chg), gridKw: r2(e.imp - e.exp),
      importKw: r2(e.imp), exportKw: r2(e.exp), soc: SOC.has(hour) ? r1(SOC.get(hour)!) : null, buckets: Number(e.n) } : null;
    const meanKw = r3(wh.slice(hour * 4, hour * 4 + 4).reduce((a, v) => a + v, 0) / 1000);
    let pool: DayPool | null = null;
    if (rows.length) {
      const on = rows.filter(r => r.running), running = on.length * 2 >= rows.length;
      pool = { running, rpm: running ? Math.round(avg(on.map(r => Number(r.rpm))) / 10) * 10 : 0, watts: running ? Math.round(avg(on.map(r => Number(r.watts)))) : 0, meanKw, source: 'measured' };
    } else if (sched && inSpan) {
      const p = prof[hour], running = p.frac >= .5;
      pool = { running, rpm: running ? p.rpm : 0, watts: running ? Math.round(W(p.rpm)) : 0, meanKw, source: 'schedule' };
    }
    let ac: DayAc | null = null;
    if (n && Number(n.n) > 0) {
      const frac = Number(n.cooling) / Number(n.n), on = frac >= .5, setpointF = n.cool == null ? null : r1(Number(n.cool));
      ac = { on, phase: acPhase({ on, setpointF, hour, settings: o.settings }), setpointF, indoorF: n.indoor == null ? null : r1(Number(n.indoor)),
        kw: on ? r2(o.acKw) : 0, meanKw: r3(o.acKw * frac) };
    }
    return { hour, energy, pool, ac };
  });
  const cov = (has: (h: number) => boolean) => o.span > 0 ? r3(Array.from({ length: o.span }, (_, h) => has(h)).filter(Boolean).length / o.span) : 0;
  return { date: o.date, acKw: r2(o.acKw), coverage: { pool: cov(h => byHour.has(h)), nest: cov(h => (N.get(h)?.n ?? 0) > 0) }, hours };
}
const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
/** The Chicago hour of an epoch-ms timestamp (pool_readings.hour holds the same; the ts keeps the quarter-hour too). */
const hourOfTs = (ts: number) => HOUR(new Date(ts));

/** Hours of `date` that have happened (Chicago): 24 before today, the current hour + 1 today, 0 after. */
export function spanOf(date: string, now = new Date()) { const today = localDay(now); return date < today ? 24 : date > today ? 0 : HOUR(now) + 1; }

/**
 * The day for the twin. `settingsAll` is the signed-in user's settings when there is one (MULTI_USER); in single-owner mode it is
 * undefined and the owner's settings come from kv in the same query as the pool and AC keys.
 */
export async function applianceDay(siteId: string, date: string, settingsAll?: Record<string, any>): Promise<ApplianceDay> {
  const keys = [`${siteId}:pool:last`, `${siteId}:pool:applied`, `${siteId}:ac:learned`, `${siteId}:ac:slope`, 'settings:owner'];
  const [energy, soc, pool, nest, kvRows] = await Promise.all([
    q<EnergyRow>(`SELECT hour::int AS hour, COUNT(*)::int AS n,
        (AVG(COALESCE(solar_wh, 0)) * 12 / 1000)::float8 AS solar, (AVG(COALESCE(home_wh, 0)) * 12 / 1000)::float8 AS home,
        (AVG(COALESCE(import_wh, 0)) * 12 / 1000)::float8 AS imp, (AVG(COALESCE(export_wh, 0)) * 12 / 1000)::float8 AS exp,
        (AVG(COALESCE(charge_wh, 0)) * 12 / 1000)::float8 AS chg, (AVG(COALESCE(discharge_wh, 0)) * 12 / 1000)::float8 AS dis
      FROM energy WHERE site_id = $1 AND day = $2 GROUP BY hour ORDER BY hour`, [siteId, date]),
    q<SocRow>(`SELECT hour::int AS hour, AVG(soe)::float8 AS soc FROM soe WHERE site_id = $1 AND day = $2 GROUP BY hour`, [siteId, date]),
    // the day's readings, then the pump's median watts per RPM over all readings (ts NULL), as measuredPoints() computes them
    q<PoolRow>(`SELECT ts::text AS ts, running, watts::float8 AS watts, rpm::float8 AS rpm, NULL::int AS n FROM pool_readings WHERE site_id = $1 AND day = $2
      UNION ALL
      SELECT NULL, NULL, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY watts)::float8, rpm::int::float8, COUNT(*)::int
      FROM pool_readings WHERE site_id = $1 AND running AND rpm > 0 AND watts > 0 GROUP BY rpm HAVING COUNT(*) >= 3`, [siteId, date]),
    q<NestRow>(`SELECT hour::int AS hour, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE hvac = 'COOLING'))::int AS cooling,
        AVG(indoor_f)::float8 AS indoor, (MODE() WITHIN GROUP (ORDER BY cool_f))::float8 AS cool
      FROM nest_readings WHERE site_id = $1 AND day = $2 GROUP BY hour`, [siteId, date]),
    q<{ key: string; value: any }>(`SELECT key, value FROM kv WHERE key = ANY($1::text[])`, [settingsAll ? keys.slice(0, 4) : keys]),
  ]);
  const K = new Map(kvRows.map(r => [r.key, r.value]));
  const all = settingsAll ?? K.get('settings:owner') ?? {};
  const settings: AcSettings = { ...AC_DEFAULTS, ...(all.ac ?? {}), band: { ...AC_DEFAULTS.band, ...(all.ac?.band ?? {}) } };
  return buildDay({ date, span: spanOf(date), energy, soc, pool, nest, snapshot: K.get(keys[0]) ?? null, applied: K.get(keys[1]) ?? null, settings,
    acKw: acKwFrom(K.get(keys[2]), K.get(keys[3])) });
}
