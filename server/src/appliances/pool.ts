// Pool pump appliance: what the IntelliFlo is doing, what the current schedule costs, and a season-aware smarter schedule.
import { q, kv } from '../db.js';
import { readPool, writePoolPlan, configured, type PoolSnapshot } from './screenlogic.js';
import { localDay, addDays } from '../tesla/client.js';
import type { Appliance, ApplianceSummary } from './index.js';

export type PoolSettings = { gallons: number; filterRpm: number; boostRpm: number; poolCircuit: number; boostCircuit: number; featureCircuits: number[] };
const DEFAULTS: PoolSettings = { gallons: 15000, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5] };
// Typical pool-water temperature by month for central Texas (°F): used only for the season table; the live plan uses the real reading.
const WATER_BY_MONTH = [55, 57, 62, 70, 78, 84, 88, 88, 84, 75, 65, 58];
const FREEZE_CIRCUIT = 132; // ScreenLogic's virtual "freeze protection" pump circuit

/* ---------- power and flow models ---------- */
/**
 * Watts at a given RPM. Measured medians from this pump when we have them; a typical full-speed point (2,900 W at 3,450 RPM for an
 * IntelliFlo) until the high speeds have been measured; log-log interpolation between anchors and the cube law below the lowest one.
 */
export function powerModel(measured: Array<{ rpm: number; watts: number }>) {
  const pts = measured.filter(m => m.rpm >= 450 && m.watts > 0).map(m => ({ ...m }));
  if (!pts.some(p => p.rpm >= 1700 && p.rpm <= 1900)) pts.push({ rpm: 1800, watts: 287 }); // measured on this pump 2026-09-24
  if (!pts.some(p => p.rpm >= 3300)) pts.push({ rpm: 3450, watts: 2900 });
  pts.sort((a, b) => a.rpm - b.rpm);
  return (rpm: number) => {
    if (rpm <= 0) return 0;
    const exact = pts.find(p => Math.abs(p.rpm - rpm) <= 25); if (exact) return exact.watts;
    const lo = [...pts].reverse().find(p => p.rpm < rpm), hi = pts.find(p => p.rpm > rpm);
    if (lo && hi) { const k = Math.log(hi.watts / lo.watts) / Math.log(hi.rpm / lo.rpm); return lo.watts * (rpm / lo.rpm) ** k; }
    const near = lo ?? hi!;
    return Math.max(20, Math.min(3200, near.watts * (rpm / near.rpm) ** 3));
  };
}
/** Flow in GPM at a given RPM (no flow meter on this pump): typical IntelliFlo on residential plumbing, ~45 GPM at 1500 RPM. */
export const gpmAt = (rpm: number, gpmAt1500 = 45) => gpmAt1500 * rpm / 1500;

/* ---------- schedules → hourly RPM profile ---------- */
type Sched = { circuitId: number; start: number; stop: number };
/** For each hour of the day, the RPM the pump runs (highest active pump circuit wins, as the controller does). Fractions of hours are weighted. */
export function hourlyRpm(schedules: Sched[], speeds: Map<number, number>) {
  const out = Array.from({ length: 24 }, () => ({ rpm: 0, frac: 0 }));
  for (let h = 0; h < 24; h++) {
    for (let m = h * 60; m < h * 60 + 60; m += 15) {
      let rpm = 0;
      for (const s of schedules) { const on = s.stop > s.start ? m >= s.start && m < s.stop : m >= s.start || m < s.stop; if (on) rpm = Math.max(rpm, speeds.get(s.circuitId) ?? 0); }
      if (rpm) { out[h].rpm = Math.max(out[h].rpm, rpm); out[h].frac += .25; }
    }
  }
  return out;
}
const dayKwh = (prof: ReturnType<typeof hourlyRpm>, W: (r: number) => number) => prof.reduce((a, h) => a + W(h.rpm) * h.frac, 0) / 1000;
const hoursOn = (prof: ReturnType<typeof hourlyRpm>) => prof.reduce((a, h) => a + h.frac, 0);
const onSolarPct = (prof: ReturnType<typeof hourlyRpm>, W: (r: number) => number, solarKw: number[]) => {
  const tot = dayKwh(prof, W); if (!tot) return 0;
  return Math.round(prof.reduce((a, h, i) => a + Math.min(W(h.rpm) / 1000, solarKw[i] ?? 0) * h.frac, 0) / tot * 100);
};

/* ---------- the optimizer ---------- */
export type Plan = ReturnType<typeof planFor>;
export function planFor(o: { waterTemp: number; solarKw: number[]; settings: PoolSettings; W: (r: number) => number; rate: number; month: number; names: Map<number, string> }) {
  const { waterTemp: t, settings: s, W } = o;
  // how much water to move: at least one turnover, more when warm (algae pressure and use), less when cold; and the 1 h per 10 °F rule of thumb
  const turnovers = t >= 85 ? 1.25 : t >= 70 ? 1 : t >= 60 ? .75 : .6;
  const turnoverH = s.gallons * turnovers / (gpmAt(s.filterRpm) * 60);
  const hours = Math.min(12, Math.max(4, Math.round(Math.max(turnoverH, t / 10))));
  const boostH = t >= 70 ? 1 : 0;
  // put the run where the sun is: the contiguous window with the most solar
  let best = 8, bestSum = -1;
  for (let st = 5; st + hours <= 20; st++) { const sum = o.solarKw.slice(st, st + hours).reduce((a, v) => a + v, 0); if (sum > bestSum) { bestSum = sum; best = st; } }
  const start = best, stop = best + hours;
  const boostAt = boostH ? o.solarKw.slice(start, stop).reduce((bi, v, i, arr) => v > arr[bi] ? i : bi, 0) + start : null;
  const schedules: Array<Sched & { rpm: number; name: string; why: string }> = [
    { circuitId: s.poolCircuit, start: start * 60, stop: stop * 60, rpm: s.filterRpm, name: o.names.get(s.poolCircuit) ?? 'Pool', why: `${hours} h of filtration at ${s.filterRpm.toLocaleString()} RPM, ${Math.round(turnovers * 100) / 100}× turnover of ${s.gallons.toLocaleString()} gal, while the panels are producing` }];
  if (boostAt != null) schedules.push({ circuitId: s.boostCircuit, start: boostAt * 60, stop: boostAt * 60 + 60, rpm: s.boostRpm, name: o.names.get(s.boostCircuit) ?? 'High Speed', why: `a one-hour skim boost at ${s.boostRpm.toLocaleString()} RPM at the sunniest hour, for surface debris and pollen` });
  const speeds = new Map(schedules.map(x => [x.circuitId, x.rpm]));
  const prof = hourlyRpm(schedules, speeds), kwh = dayKwh(prof, W);
  return { month: o.month, waterTemp: t, turnovers, hours, boostHours: boostH, start, stop, boostAt, schedules, kwhPerDay: Math.round(kwh * 10) / 10,
    costPerMonth: Math.round(kwh * 30.4 * o.rate), onSolarPct: onSolarPct(prof, W, o.solarKw), turnoverPerDay: Math.round(hours * gpmAt(s.filterRpm) * 60 / s.gallons * 100) / 100, hourly: prof };
}

/* ---------- storage ---------- */
export async function recordReading(siteId: string, snap: PoolSnapshot) {
  if (!snap.pump) return;
  const d = new Date(snap.at), day = localDay(d);
  await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm, water_temp, air_temp, circuits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [siteId, snap.at, day, Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d)) % 24, snap.pump.running, snap.pump.watts, snap.pump.rpm,
      snap.bodies[0]?.temp ?? null, snap.airTemp, JSON.stringify(snap.circuits.filter(c => c.on).map(c => c.id))]);
  await kv.set(`${siteId}:pool:last`, snap);
}
const measuredPoints = (siteId: string) => q<{ rpm: number; watts: number }>(`SELECT rpm::int rpm, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY watts)::float8 watts
  FROM pool_readings WHERE site_id = $1 AND running AND rpm > 0 AND watts > 0 GROUP BY rpm HAVING COUNT(*) >= 3`, [siteId]);
const solarProfile = async (siteId: string) => {
  const rows = await q<{ hour: number; kw: number }>(`SELECT hour::int, (SUM(solar_wh) / 1000.0 / 14)::float8 kw FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY hour`, [siteId, addDays(localDay(), -14), localDay()]);
  const out = Array(24).fill(0); rows.forEach(r => out[r.hour] = r.kw); return out;
};

/* ---------- the appliance ---------- */
export async function poolDetail(siteId: string, settingsAll: Record<string, any>, rate: number, opts: { fresh?: boolean } = {}) {
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) };
  let snap = await kv.get<PoolSnapshot>(`${siteId}:pool:last`) ?? null, error: string | null = null;
  if (configured() && (opts.fresh || !snap || Date.now() - snap.at > 60_000)) {
    try { snap = await readPool(); await recordReading(siteId, snap); } catch (e: any) { error = e.message; }
  }
  const W = powerModel(await measuredPoints(siteId)), solarKw = await solarProfile(siteId), month = new Date().getMonth();
  const names = new Map((snap?.circuits ?? []).map(c => [c.id, c.name]));
  const speeds = new Map((snap?.pump?.circuits ?? []).map(c => [c.circuitId, c.isRpm ? c.speed : 0]));
  const pumpCircuits = new Set(speeds.keys()); pumpCircuits.delete(FREEZE_CIRCUIT);
  const current = (snap?.schedules ?? []).filter(s => pumpCircuits.has(s.circuitId)).map(s => ({ ...s, rpm: speeds.get(s.circuitId) ?? 0, name: names.get(s.circuitId) ?? `Circuit ${s.circuitId}` }));
  const prof = hourlyRpm(current, speeds), kwh = dayKwh(prof, W);
  const waterTemp = snap?.bodies[0]?.temp ?? WATER_BY_MONTH[month];
  const plan = planFor({ waterTemp, solarKw, settings, W, rate, month, names });
  const seasons = [[11, 'Dec–Feb'], [2, 'Mar–May'], [5, 'Jun–Aug'], [8, 'Sep–Nov']].map(([m, label]) => {
    const months = [m as number, ((m as number) + 1) % 12, ((m as number) + 2) % 12], avg = Math.round(months.reduce((a, i) => a + WATER_BY_MONTH[i], 0) / 3);
    const p = planFor({ waterTemp: avg, solarKw, settings, W, rate, month: m as number, names });
    return { label, waterTemp: p.waterTemp, hours: p.hours, boostHours: p.boostHours, rpm: settings.filterRpm, kwhPerDay: p.kwhPerDay, costPerMonth: p.costPerMonth, current: [11, 0, 1].includes(month) ? m === 11 : Math.floor(month / 3) === Math.floor((m as number) / 3) };
  });
  // today's estimate from the schedule model, up to now, plus the running measured watts if the pump is on
  const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date())) % 24;
  const todayKwh = prof.slice(0, hourNow).reduce((a, h) => a + W(h.rpm) * h.frac, 0) / 1000;
  const home = await q<{ kwh: number }>(`SELECT (SUM(home_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day = $2`, [siteId, localDay()]);
  const applied = await kv.get<any>(`${siteId}:pool:applied`) ?? null;
  return { id: 'pool', name: 'Pool pump', linked: configured() && !!snap, error, settings, snapshot: snap,
    live: snap?.pump ? { watts: snap.pump.watts, rpm: snap.pump.rpm, running: snap.pump.running, gpm: snap.pump.gpm, at: snap.at, waterTemp, airTemp: snap.airTemp, freezeMode: snap.freezeMode,
      on: snap.circuits.filter(c => c.on).map(c => c.name), activeRpm: Math.max(0, ...snap.circuits.filter(c => c.on).map(c => speeds.get(c.id) ?? 0)) } : null,
    model: { measured: await measuredPoints(siteId), curve: [1000, 1500, 1800, 2400, 3000, 3450].map(r => ({ rpm: r, watts: Math.round(W(r)) })) },
    current: { schedules: current, hours: Math.round(hoursOn(prof) * 10) / 10, kwhPerDay: Math.round(kwh * 10) / 10, costPerMonth: Math.round(kwh * 30.4 * rate), onSolarPct: onSolarPct(prof, W, solarKw),
      turnoverPerDay: Math.round(prof.reduce((a, h) => a + gpmAt(h.rpm) * 60 * h.frac, 0) / settings.gallons * 100) / 100, hourly: prof,
      byProgram: current.map(s => { const p = hourlyRpm([s], speeds); return { name: s.name, rpm: s.rpm, start: s.start, stop: s.stop, kwhPerDay: Math.round(dayKwh(p, W) * 10) / 10 }; }) },
    plan, seasons, solarKw, todayKwh: Math.round(todayKwh * 10) / 10, todayCost: Math.round(todayKwh * rate * 100) / 100, shareOfHomePct: home[0]?.kwh ? Math.round(todayKwh / home[0].kwh * 100) : null,
    rate, applied };
}

export async function applyPlan(siteId: string, plan: Plan, snap: PoolSnapshot, settings: PoolSettings) {
  if (!snap.pump) throw new Error('No pump found on the controller');
  const replace = [settings.poolCircuit, settings.boostCircuit, ...settings.featureCircuits];
  const r = await writePoolPlan({ pumpId: snap.pump.id, speeds: plan.schedules.map(s => ({ circuitId: s.circuitId, rpm: s.rpm })), replaceCircuits: replace,
    schedules: plan.schedules.map(s => ({ circuitId: s.circuitId, start: s.start, stop: s.stop })) });
  const record = { at: Date.now(), plan: { start: plan.start, stop: plan.stop, boostAt: plan.boostAt, schedules: plan.schedules }, removed: r.removed, added: r.added,
    previousSpeeds: snap.pump.circuits.filter(c => replace.includes(c.circuitId)) };
  await kv.set(`${siteId}:pool:applied`, record);
  await kv.set(`${siteId}:pool:last`, null as any);
  return record;
}

export async function restorePrevious(siteId: string, snap: PoolSnapshot) {
  const rec = await kv.get<any>(`${siteId}:pool:applied`); if (!rec || !snap.pump) throw new Error('Nothing to restore');
  const circuits = [...new Set([...rec.removed.map((x: any) => x.circuitId), ...rec.plan.schedules.map((x: any) => x.circuitId)])] as number[];
  await writePoolPlan({ pumpId: snap.pump.id, speeds: rec.previousSpeeds.map((c: any) => ({ circuitId: c.circuitId, rpm: c.speed })), replaceCircuits: circuits,
    schedules: rec.removed.map((x: any) => ({ circuitId: x.circuitId, start: x.start, stop: x.stop, dayMask: x.dayMask })) });
  await kv.set(`${siteId}:pool:applied`, null as any);
  await kv.set(`${siteId}:pool:last`, null as any);
}

export const poolAppliance: Appliance = {
  id: 'pool', name: 'Pool pump', source: 'Pentair ScreenLogic',
  available: () => configured(),
  summary: async (siteId, settings, rate): Promise<ApplianceSummary> => {
    const d = await poolDetail(siteId, settings, rate);
    return { id: 'pool', name: 'Pool pump', status: d.linked ? 'linked' : 'estimated', watts: d.live?.watts ?? null, kwhPerDay: d.current.kwhPerDay, savesPerMonth: Math.max(0, d.current.costPerMonth - d.plan.costPerMonth) };
  },
};
