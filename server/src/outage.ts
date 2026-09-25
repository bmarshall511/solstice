// Outage readiness (Insights → Home, approved mockup n-outage; docs/audit-designs/visualizations.md §6): if PEC dropped now,
// how long would the Powerwalls carry the house, which loads stretch it, and would tomorrow's sun refill them.
// Read-only: the database and the caches the app already keeps (Open-Meteo 'pool:forecast', 'ercot', 'nws').
// It never calls ScreenLogic, Nest or Tesla, so it adds no SDM queries and writes nothing to any device.
import { q, one, kv } from './db.js';
import { localDay, addDays, rfc3339 } from './tesla/client.js';
import { forecast } from './appliances/autopilot.js';
import { powerModel, measuredPoints, hourlyRpm, POOL_DEFAULTS, FREEZE_CIRCUIT, type PoolSettings } from './appliances/pool.js';
import { learnAcKw, runtimeToday } from './appliances/ac.js';
import type { PoolSnapshot } from './appliances/screenlogic.js';
import { siteLocation } from './site.js';

const EFF = .95;                 // the battery model's one-way efficiency (forecast48, /api/whatif)
const HOURS = 48;                // the island simulation's horizon
const CLOUDY_KWH = 25;           // tomorrow's forecast solar below this reads "clouds" (mockup n-outage)
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/* ======================= pure pieces (tests/server/outage.test.ts) ======================= */

/** kWh the Powerwalls can deliver from `socPct` with no grid: charge × capacity × 95%. */
export const usableKwh = (socPct: number, capKwh: number) => Math.max(0, socPct) / 100 * capKwh * EFF;

export type RungId = 'on' | 'pool' | 'ac' | 'else';
export type Rung = { id: RungId; label: string; addKw: number; kw: number; hours: number | null };
/**
 * The "If it kept drawing" ladder. Each rung adds a load to the ones above it and holds that total steady:
 *   Always-on          = the learned always-on load (lowest 1–5 AM mean of the last 30 nights)
 *   + Pool pump        = the pump model's watts at the scheduled speed
 *   + AC               = learned AC kW × duty
 *   + Everything else  = whatever the house draws now beyond those (never below the rung above)
 * hours = usable kWh ÷ that rung's total kW (null when the total is 0: it would never run out).
 */
export function ladder(o: { usableKwh: number; alwaysOnKw: number; poolKw: number; acKw: number; duty: number; drawKw: number }): Rung[] {
  const on = Math.max(0, o.alwaysOnKw), pool = on + Math.max(0, o.poolKw), ac = pool + Math.max(0, o.acKw) * clamp(o.duty, 0, 1), all = Math.max(ac, o.drawKw);
  const rung = (id: RungId, label: string, below: number, kw: number): Rung => ({ id, label, addKw: r3(kw - below), kw: r3(kw), hours: kw > 0 ? r3(o.usableKwh / kw) : null });
  return [rung('on', 'Always-on', 0, on), rung('pool', '+ Pool pump', on, pool), rung('ac', '+ AC', pool, ac), rung('else', '+ Everything else', ac, all)];
}

export type IslandPoint = { k: number; soc: number; s: number; h: number; b: number; u: number };
export type Island = { points: IslandPoint[]; emptyH: number | null; sunAdds: number; minSoc: number; unmetKwh: number };
/**
 * The house cut off from PEC: forecast48's battery step (web/src/lib/model.js) with reserve 0 and no grid. Hour k runs solarKw[k]
 * against loadKw[k]; surplus charges the Powerwalls (curtailed once full), a shortfall drains them down to empty.
 *   emptyH  = hours from now until they first run dry (fractional), or null if they last the whole horizon;
 *   sunAdds = hours in the 24 after that when the sun (directly or through a recharge) keeps the house fully powered.
 */
export function simulateIsland(o: { soc0: number; capKwh: number; maxKw: number; hours?: number; solarKw: number[]; loadKw: number[] }): Island {
  const hours = o.hours ?? HOURS, cap = o.capKwh, points: IslandPoint[] = [];
  let soc = clamp(o.soc0 / 100, 0, 1), emptyH: number | null = null, unmetKwh = 0, minSoc = soc, sunAdds = 0;
  for (let k = 0; k < hours; k++) {
    const s = Math.max(0, o.solarKw[k] ?? 0), h = Math.max(0, o.loadKw[k] ?? 0), n = s - h;
    const b = n > 0 ? -Math.min(n, o.maxKw, (1 - soc) * cap / EFF) : Math.min(-n, o.maxKw, soc * cap * EFF);   // + discharge, − charge
    soc = clamp(soc + (b < 0 ? -b * EFF : -b / EFF) / cap, 0, 1);
    const u = n < 0 ? Math.max(0, h - s - b) : 0; unmetKwh += u;
    if (emptyH == null && u > 1e-6 && soc < 1e-9) emptyH = k + b / (h - s);
    if (emptyH != null && k >= Math.ceil(emptyH) && k < Math.ceil(emptyH) + 24 && u < 1e-6) sunAdds++;
    minSoc = Math.min(minSoc, soc); points.push({ k, soc, s, h, b, u });
  }
  return { points, emptyH, sunAdds, minSoc, unmetKwh };
}

export type Scenario = 'asis' | 'noac' | 'noacpool';
export const SCENARIOS: Scenario[] = ['asis', 'noac', 'noacpool'];
/**
 * The 48 hourly loads the simulation runs from now: the live draw for the current hour, then the typical hour (14-day profile),
 * minus what the scenario switches off (the AC's average draw, and the pump's scheduled kW for that hour), never below always-on.
 */
export function scenarioLoads(o: { startHour: number; profile: number[]; drawKw: number; alwaysOnKw: number; acAvgKw: number; poolKwByHour: number[] }, sc: Scenario): number[] {
  return Array.from({ length: HOURS }, (_, k) => {
    const h = (Math.floor(o.startHour) + k) % 24, base = k === 0 ? o.drawKw : o.profile[h] ?? o.drawKw;
    const off = sc === 'asis' ? 0 : o.acAvgKw + (sc === 'noacpool' ? o.poolKwByHour[h] ?? 0 : 0);
    return Math.max(o.alwaysOnKw, base - off);
  });
}

/**
 * The pump's kW for each hour of the day on its schedule (the controller runs the highest active speed), from the pool power model.
 * The UV lamp and the other circuits are left out, as in the ladder.
 */
export const poolKwByHour = (schedules: Array<{ circuitId: number; start: number; stop: number }>, speeds: Map<number, number>, W: (rpm: number) => number) =>
  hourlyRpm(schedules, speeds).map(x => W(x.rpm) * x.frac / 1000);

/** AC duty (0–1): today's measured Nest duty when there is one; else 60% on a 90°F+ day, else the heat model's kWh over 80°F spread over the day. */
export function acDuty(o: { measuredPct: number | null; high: number | null; slope: number; acKw: number }) {
  if (o.measuredPct != null) return { duty: clamp(o.measuredPct / 100, 0, 1), source: 'nest' as const };
  if (o.high == null || o.high >= 90) return { duty: .6, source: 'estimated' as const };
  return { duty: clamp(Math.max(0, o.high - 80) * o.slope / 24 / Math.max(.5, o.acKw), 0, .6), source: 'estimated' as const };
}

/** Forecast array output by simulation hour: Open-Meteo's hourly sun (kW/m², the hour ending at its timestamp) × the learned yield. */
export function solarByHour(o: { startDate: string; startHour: number; yieldK: number; sunAt: (date: string, hourEnding: number) => number }) {
  return Array.from({ length: HOURS }, (_, k) => {
    const H = Math.floor(o.startHour) + k, h = H % 24, day = addDays(o.startDate, Math.floor(H / 24));
    // the hour [h, h+1) is the value stamped h+1; 24:00 is the next day's 00:00
    return o.yieldK * (h === 23 ? o.sunAt(addDays(day, 1), 0) : o.sunAt(day, h + 1));
  });
}

export type NwsAlert = { event: string; headline: string | null; severity: string | null; ends: string | null };
export type Ercot = { condition: string | null; title: string | null; eea: number; at: string | null } | null;
/** The storm variant is on while Storm Watch is active or the NWS has any alert for the site. ERCOT alone never turns it on. */
export function stormState(o: { stormWatchEnabled: boolean | null; stormActive: boolean; nws: NwsAlert[]; ercot: Ercot }) {
  return { active: o.stormActive || o.nws.length > 0, stormWatch: { enabled: o.stormWatchEnabled, active: o.stormActive }, nws: o.nws, ercot: o.ercot };
}

/* ======================= the endpoint ======================= */

/** NWS alerts for the site, cached 5 minutes in kv (the browser fetches the same feed for the Worth knowing cards). */
async function nwsAlerts(): Promise<NwsAlert[]> {
  const hit = await kv.get<{ at: number; alerts: NwsAlert[] }>('nws');
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.alerts;
  const loc = siteLocation(); if (!loc) return [];
  const j = await fetch(`https://api.weather.gov/alerts/active?point=${loc.lat},${loc.lon}`, { headers: { 'User-Agent': 'Solstice (personal energy monitor)', Accept: 'application/geo+json' }, signal: AbortSignal.timeout(4000) })
    .then(r => r.ok ? r.json() : null).catch(() => null) as { features?: Array<{ properties: Record<string, any> }> } | null;
  if (!j) return hit?.alerts ?? [];
  const alerts = (j.features ?? []).map(f => ({ event: String(f.properties.event ?? 'Alert'), headline: f.properties.headline ?? null, severity: f.properties.severity ?? null, ends: f.properties.ends ?? f.properties.expires ?? null }));
  await kv.set('nws', { at: Date.now(), alerts });
  return alerts;
}

/** Everything the Outage readiness card shows. `settingsAll` is the owner's settings (pool pump circuits and speeds). */
export async function outageDetail(siteId: string, settingsAll: Record<string, any> = {}, now = new Date()) {
  const today = localDay(now), tomorrow = addDays(today, 1), stamp = rfc3339(now), startHour = +stamp.slice(11, 13) + +stamp.slice(14, 16) / 60;
  const [site, reading, profileRows, nights, events] = await Promise.all([
    one<{ info: any }>('SELECT info FROM sites WHERE id = $1', [siteId]),
    one<{ ts: string; load_w: number; soc: number; storm_mode_active: boolean }>('SELECT ts, load_w, soc, storm_mode_active FROM readings WHERE site_id = $1 ORDER BY ts DESC LIMIT 1', [siteId]),
    q<{ hour: number; kw: number }>(`SELECT hour::int, AVG(kwh)::float8 kw FROM (SELECT day, hour, SUM(home_wh) / 1000.0 kwh FROM energy
      WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour) x GROUP BY hour`, [siteId, addDays(today, -14), today]),
    // 1–5 AM means of the last 30 complete nights (at least 36 of the 48 five-minute buckets)
    q<{ kw: number }>(`SELECT (SUM(home_wh) / 1000.0 / 4)::float8 kw FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 AND hour BETWEEN 1 AND 4
      GROUP BY day HAVING COUNT(*) >= 36`, [siteId, addDays(today, -30), today]),
    q<{ ts: string; duration_s: number }>('SELECT ts, duration_s FROM backup_events WHERE site_id = $1 ORDER BY epoch DESC', [siteId]),
  ]);
  const info = site?.info ?? {};
  const capKwh = (info.nameplate_energy ?? 0) / 1000 || 27, maxKw = (info.nameplate_power ?? 0) / 1000 || 10, batteries = info.battery_count ?? 2;
  const soc = reading?.soc ?? (await one<{ soe: number }>('SELECT soe FROM soe WHERE site_id = $1 ORDER BY epoch DESC LIMIT 1', [siteId]))?.soe ?? 0;
  const profile = Array.from({ length: 24 }, (_, h) => profileRows.find(r => r.hour === h)?.kw ?? null);
  const typical = profile.filter((v): v is number => v != null);
  const drawKw = reading ? Math.max(0, reading.load_w) / 1000 : profile[Math.floor(startHour)] ?? 2;
  const alwaysOnKw = nights.length ? Math.min(...nights.map(n => n.kw)) : typical.length ? Math.min(...typical) : Math.min(drawKw, .6);
  const prof = profile.map(v => v ?? drawKw);

  // pool pump: the schedule on the controller as last read (or the plan last applied), watts from the pump's power model
  const pool: PoolSettings = { ...POOL_DEFAULTS, ...(settingsAll.pool ?? {}) };
  const [snap, applied, measured] = await Promise.all([kv.get<PoolSnapshot | null>(`${siteId}:pool:last`), kv.get<any>(`${siteId}:pool:applied`), measuredPoints(siteId)]);
  const W = powerModel(measured);
  let schedules: Array<{ circuitId: number; start: number; stop: number }> = [], speeds = new Map<number, number>();
  if (snap?.pump) {
    speeds = new Map(snap.pump.circuits.filter(c => c.circuitId !== FREEZE_CIRCUIT).map(c => [c.circuitId, c.isRpm ? c.speed : 0]));
    schedules = (snap.schedules ?? []).filter(s => speeds.has(s.circuitId));
  } else if (applied?.plan?.schedules?.length) {
    schedules = applied.plan.schedules; speeds = new Map(applied.plan.schedules.map((s: any) => [s.circuitId, s.rpm]));
  }
  const poolRpm = speeds.get(pool.poolCircuit) || pool.filterRpm, poolKw = W(poolRpm) / 1000, poolHourly = poolKwByHour(schedules, speeds, W);

  // AC: the kW learned from Nest load steps (or the heat model's estimate, as the AC card does) × duty
  const [learned, slopeHit, rt] = await Promise.all([learnAcKw(siteId), kv.get<{ slope: number }>(`${siteId}:ac:slope`), runtimeToday(siteId)]);
  const slope = slopeHit?.slope ?? null, acKw = learned.coolKw ?? (slope ? clamp(slope * 1.3, 2, 5) : 3.4);

  // forecast: today, tomorrow, and the past days that teach the yield (kWh made per kWh/m² of sun)
  let days: Awaited<ReturnType<typeof forecast>> = [];
  try { days = await forecast(); } catch { /* no location or Open-Meteo down: no solar in the simulation */ }
  const byDate = new Map(days.map(d => [d.date, d]));
  const past = days.filter(d => d.date < today && d.sunKwhM2 > 1).map(d => d.date);
  const made = past.length ? await q<{ day: string; kwh: number }>(`SELECT day, (SUM(solar_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day = ANY($2::text[]) GROUP BY day`, [siteId, past]) : [];
  const pairs = made.filter(m => m.kwh > 1).map(m => [m.kwh, byDate.get(m.day)!.sunKwhM2]);
  const yieldK = pairs.length ? clamp(pairs.reduce((a, p) => a + p[0], 0) / pairs.reduce((a, p) => a + p[1], 0), 2, 9.45) : 9.45 * .8; // .8 × AC rating: the pool planner's rule
  const solarKw = solarByHour({ startDate: today, startHour, yieldK, sunAt: (d, h) => byDate.get(d)?.hourlySun[h] ?? 0 });
  const tomorrowKwh = byDate.get(tomorrow) ? r1(byDate.get(tomorrow)!.sunKwhM2 * yieldK) : null;
  const { duty, source: dutySource } = acDuty({ measuredPct: rt.duty, high: byDate.get(today)?.high ?? null, slope: slope ?? 2.5, acKw });

  const usable = usableKwh(soc, capKwh), acAvgKw = acKw * duty;
  const loadIn = { startHour, profile: prof, drawKw, alwaysOnKw, acAvgKw, poolKwByHour: poolHourly };
  const scenarios = Object.fromEntries(SCENARIOS.map(sc => {
    const loadKw = scenarioLoads(loadIn, sc), sim = simulateIsland({ soc0: soc, capKwh, maxKw, solarKw, loadKw });
    return [sc, { drawKw: r3(loadKw[0]), backupH: loadKw[0] > 0 ? r3(usable / loadKw[0]) : null,
      island: { emptyH: sim.emptyH == null ? null : r3(sim.emptyH), emptyAt: sim.emptyH == null ? null : Math.round(now.getTime() + sim.emptyH * 3600e3),
        sunAdds: sim.sunAdds, minSoc: r3(sim.minSoc), unmetKwh: r2(sim.unmetKwh),
        points: sim.points.map(p => ({ k: p.k, soc: r3(p.soc), s: r3(p.s), h: r3(p.h), b: r3(p.b), u: r3(p.u) })) } }];
  }));

  const yearAgo = addDays(today, -365), recent = events.filter(e => e.ts.slice(0, 10) >= yearAgo);
  const longest = recent.reduce<typeof recent[number] | null>((a, e) => !a || e.duration_s > a.duration_s ? e : a, null);
  const ercot = await kv.get<{ data: { condition: string | null; title: string | null; eea: number; at: string | null } }>('ercot');
  const nws = await nwsAlerts().catch(() => []);

  return {
    at: now.getTime(), date: today, startHour: r3(startHour), readingAt: reading ? Number(reading.ts) : null,
    soc: r1(soc), capacityKwh: capKwh, usableKwh: r2(usable), reservePct: info.backup_reserve_percent ?? null, maxKw, batteries, drawKw: r3(drawKw),
    loads: { alwaysOnKw: r3(alwaysOnKw), poolKw: r3(poolKw), poolRpm, acKw: r2(acKw), acSource: learned.coolKw ? 'measured' : 'estimated', acDuty: r2(duty), dutySource },
    ladder: ladder({ usableKwh: usable, alwaysOnKw, poolKw, acKw, duty, drawKw }),
    scenarios,
    solar: { tomorrowKwh, cloudy: tomorrowKwh != null && tomorrowKwh < CLOUDY_KWH, yieldK: r2(yieldK) },
    outages: { list: recent.map(e => ({ ts: e.ts, duration_s: e.duration_s })), last: events[0] ? { ts: events[0].ts, duration_s: events[0].duration_s } : null, count12: recent.length, longest12: longest },
    storm: stormState({ stormWatchEnabled: info.user_settings?.storm_mode_enabled ?? null, stormActive: !!reading?.storm_mode_active, nws,
      ercot: ercot?.data ? { condition: ercot.data.condition ?? null, title: ercot.data.title ?? null, eea: ercot.data.eea ?? 0, at: ercot.data.at ?? null } : null }),
  };
}
