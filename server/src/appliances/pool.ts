// Pool pump appliance: what the IntelliFlo is doing, what the current schedule costs, and a season-aware smarter schedule.
import { q, kv } from '../db.js';
import { readPool, writePoolPlan, configured, type PoolSnapshot } from './screenlogic.js';
import { localDay, addDays, rfc3339 } from '../tesla/client.js';
import type { Appliance, ApplianceSummary } from './index.js';
import { autopilot, type Mode } from './autopilot.js';
import { GuardRefusal, type PoolGuardContext } from './guards.js';
import { usd } from '../tariff.js';
import { confidenceFor } from '../learn/confidence.js';

export type PoolSettings = { gallons: number; spaGallons: number; designGpm: number; filterRpm: number; boostRpm: number; poolCircuit: number; boostCircuit: number; featureCircuits: number[]; autopilot: Mode; uv: boolean;
  heaterBtu: number; propaneUsdPerGal: number; loads: Record<string, number> };
// From the construction plan: 14,995 gal pool, ~1,000 gal spa, designed for 120 GPM; Ultra UV sanitizer; 400k BTU propane heater;
// other circuits' draws (W): 1.5 HP blower, 500 W pool light, 100 W spa light, ~60 W UV lamp while the pump runs.
const DEFAULTS: PoolSettings = { gallons: 14995, spaGallons: 1000, designGpm: 120, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5], autopilot: 'suggest', uv: true,
  heaterBtu: 400_000, propaneUsdPerGal: 3.0, loads: { '2': 1100, '3': 500, '4': 100 } };
export { DEFAULTS as POOL_DEFAULTS };
const UV_W = 60;
// Typical pool-water temperature by month for central Texas (°F): used only for the season table; the live plan uses the real reading.
const WATER_BY_MONTH = [55, 57, 62, 70, 78, 84, 88, 88, 84, 75, 65, 58];
/** Meteorological season of a 0-based month: 0 Dec–Feb, 1 Mar–May, 2 Jun–Aug, 3 Sep–Nov. */
const seasonOf = (m: number) => Math.floor((m + 1) % 12 / 3);
export const FREEZE_CIRCUIT = 132; // ScreenLogic's virtual "freeze protection" pump circuit

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
/** Flow in GPM at a given RPM (no flow meter on this pump): scaled from the plan's design point (120 GPM at full speed), ~52 GPM at 1500 RPM. */
export const gpmAt = (rpm: number, designGpm = 120) => designGpm * rpm / 3450;

/* ---------- schedules → 15-minute RPM profile ---------- */
type Sched = { circuitId: number; start: number; stop: number };
/** Whether a schedule covers a minute of the day. A stop before the start wraps midnight; start === stop reads as all day (Q1). */
const covers = (s: Sched, m: number) => s.stop > s.start ? m >= s.start && m < s.stop : m >= s.start || m < s.stop;
/** The 15-minute slice of the Chicago day a timestamp falls in: 0 = 00:00–00:15 … 95 = 23:45–24:00. */
export const quarterOf = (ts: number) => { const t = rfc3339(new Date(ts)); return Math.floor((Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16))) / 15); };
/** Which of the day's 96 quarter-hours any of these schedules covers (the pump's scheduled hours, whatever its speed). */
export const scheduledQuarters = (schedules: Sched[]) => Array.from({ length: 96 }, (_, i) => schedules.some(s => covers(s, i * 15)));
/** The RPM the pump runs in each of the day's 96 quarter-hours (highest active pump circuit wins, as the controller does). */
export const quarterRpm = (schedules: Sched[], speeds: Map<number, number>) =>
  Array.from({ length: 96 }, (_, i) => schedules.reduce((rpm, s) => covers(s, i * 15) ? Math.max(rpm, speeds.get(s.circuitId) ?? 0) : rpm, 0));
/**
 * For each hour of the day: the top RPM (for display), the fraction of the hour the pump runs, and its four quarter-hour RPMs
 * (`slices`). Energy and flow are integrated from the slices, so a speed change mid-hour counts each speed for its own minutes.
 */
export function hourlyRpm(schedules: Sched[], speeds: Map<number, number>) {
  const qr = quarterRpm(schedules, speeds);
  return Array.from({ length: 24 }, (_, h) => { const slices = qr.slice(h * 4, h * 4 + 4); return { rpm: Math.max(0, ...slices), frac: slices.filter(r => r > 0).length / 4, slices }; });
}
type Profile = ReturnType<typeof hourlyRpm>;
/** Measured pump watts per quarter-hour of one day (96 entries, null where there is no reading). */
export type QuarterWatts = ReadonlyArray<number | null>;
/**
 * Pump energy of each of the day's 96 quarter-hours, Wh: the pump's measured watts where a reading exists for that quarter-hour,
 * otherwise the model W(rpm) at the slice's scheduled speed. Each slice is a quarter of an hour.
 */
export const quarterWh = (prof: Profile, W: (r: number) => number, measured?: QuarterWatts) =>
  prof.flatMap((h, i) => h.slices.map((r, k) => (measured?.[i * 4 + k] ?? W(r)) / 4));
/** Pump kWh for a day, integrated in 15-minute steps (measured watts where `measured` has a reading for the quarter-hour). */
export const dayKwh = (prof: Profile, W: (r: number) => number, measured?: QuarterWatts) => quarterWh(prof, W, measured).reduce((a, v) => a + v, 0) / 1000;
const hoursOn = (prof: Profile) => prof.reduce((a, h) => a + h.frac, 0);
const onSolarPct = (prof: Profile, W: (r: number) => number, solarKw: number[]) => {
  const tot = dayKwh(prof, W); if (!tot) return 0;
  return Math.round(prof.reduce((a, h, i) => a + h.slices.reduce((b, r) => b + Math.min(W(r) / 1000, solarKw[i] ?? 0) / 4, 0), 0) / tot * 100);
};

/* ---------- the optimizer ---------- */
export type Plan = ReturnType<typeof planFor>;
export function planFor(o: { waterTemp: number; solarKw: number[]; settings: PoolSettings; W: (r: number) => number; rate: number | null; month: number; names: Map<number, string>; force?: { hours: number; boost: number } }) {
  const { waterTemp: t, settings: s, W } = o;
  // how much water to move: at least one turnover, more when warm (algae pressure and use), less when cold; and the 1 h per 10 °F rule of thumb
  const turnovers = t >= 85 ? 1.25 : t >= 70 ? 1 : t >= 60 ? .75 : .6;
  const turnoverH = s.gallons * turnovers / (gpmAt(s.filterRpm, s.designGpm) * 60);
  const hours = o.force?.hours ?? Math.min(12, Math.max(4, Math.round(Math.max(turnoverH, t / 10))));
  const boostH = o.force?.boost ?? ((s.uv ? t >= 85 : t >= 70) ? 1 : 0); // with UV sanitizing the flow, long low runs matter more than boosts
  // put the run where the sun is: the contiguous window with the most solar; with no solar data, the default 08:00 start
  let best = 8, bestSum = 0;
  for (let st = 5; st + hours <= 20; st++) { const sum = o.solarKw.slice(st, st + hours).reduce((a, v) => a + v, 0); if (sum > bestSum) { bestSum = sum; best = st; } }
  const start = best, stop = best + hours;
  const boostAt = boostH ? o.solarKw.slice(start, stop).reduce((bi, v, i, arr) => v > arr[bi] ? i : bi, 0) + start : null;
  const schedules: Array<Sched & { rpm: number; name: string; why: string }> = [
    { circuitId: s.poolCircuit, start: start * 60, stop: stop * 60, rpm: s.filterRpm, name: o.names.get(s.poolCircuit) ?? 'Pool', why: `${hours} h of filtration at ${s.filterRpm.toLocaleString()} RPM, ${Math.round(turnovers * 100) / 100}× turnover of ${s.gallons.toLocaleString()} gal, while the panels are producing` }];
  if (boostAt != null) schedules.push({ circuitId: s.boostCircuit, start: boostAt * 60, stop: boostAt * 60 + 60, rpm: s.boostRpm, name: o.names.get(s.boostCircuit) ?? 'High Speed', why: `a one-hour skim boost at ${s.boostRpm.toLocaleString()} RPM at the sunniest hour, for surface debris and pollen` });
  const speeds = new Map(schedules.map(x => [x.circuitId, x.rpm]));
  const prof = hourlyRpm(schedules, speeds), kwh = dayKwh(prof, W) + (s.uv ? hoursOn(prof) * UV_W / 1000 : 0);
  return { month: o.month, waterTemp: t, turnovers, hours, boostHours: boostH, start, stop, boostAt, schedules, kwhPerDay: Math.round(kwh * 10) / 10,
    costPerMonth: usd(kwh * 30.4, o.rate), onSolarPct: onSolarPct(prof, W, o.solarKw), turnoverPerDay: Math.round(hours * gpmAt(s.filterRpm, s.designGpm) * 60 / s.gallons * 100) / 100, hourly: prof, uvKwh: s.uv ? Math.round(hoursOn(prof) * UV_W) / 1000 : 0 };
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
/**
 * One day's readings as measured pump watts per quarter-hour (see QuarterWatts): the mean of the readings taken in each
 * quarter-hour, 0 W for a reading with the pump off. Past days are integrated from these and the schedule when they are shown;
 * no daily total is stored.
 */
export async function measuredQuarters(siteId: string, day: string): Promise<Array<number | null>> {
  const rows = await q<{ ts: string; running: boolean; watts: number }>(`SELECT ts::text, running, watts FROM pool_readings WHERE site_id = $1 AND day = $2`, [siteId, day]);
  return meanByQuarter(rows.map(r => ({ ts: Number(r.ts), watts: r.running ? Number(r.watts) : 0 })));
}
export function meanByQuarter(rows: Array<{ ts: number; watts: number }>) {
  const sum = Array<number>(96).fill(0), n = Array<number>(96).fill(0);
  for (const r of rows) { const i = quarterOf(r.ts); sum[i] += r.watts; n[i]++; }
  return sum.map((v, i) => n[i] ? v / n[i] : null);
}
/** The controller's pump programs from a snapshot: schedules of the pump's circuits (not freeze protection) and each circuit's RPM (0 if set in GPM). */
export function pumpSchedules(snap: PoolSnapshot | null) {
  const speeds = new Map((snap?.pump?.circuits ?? []).map(c => [c.circuitId, c.isRpm ? c.speed : 0]));
  const pumpCircuits = new Set(speeds.keys()); pumpCircuits.delete(FREEZE_CIRCUIT);
  return { speeds, schedules: (snap?.schedules ?? []).filter(s => pumpCircuits.has(s.circuitId)) };
}
export const measuredPoints = (siteId: string) => q<{ rpm: number; watts: number }>(`SELECT rpm::int rpm, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY watts)::float8 watts
  FROM pool_readings WHERE site_id = $1 AND running AND rpm > 0 AND watts > 0 GROUP BY rpm HAVING COUNT(*) >= 3`, [siteId]);
const solarProfile = async (siteId: string) => {
  const rows = await q<{ hour: number; kw: number }>(`SELECT hour::int, (SUM(solar_wh) / 1000.0 / 14)::float8 kw FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY hour`, [siteId, addDays(localDay(), -14), localDay()]);
  const out = Array(24).fill(0); rows.forEach(r => out[r.hour] = r.kw); return out;
};

/* ---------- History → "Where every kWh went": pool kWh over a range of days (database only) ---------- */
/** One local day of a range: its 15-minute slices elapsed (96 for a past day) and its elapsed and full length (23, 24 or 25 h). */
export type DaySpan = { day: string; quarters: number; elapsedMs: number; lengthMs: number };
/**
 * Pool kWh for the History flows card, from the model behind the Pool card's "today": each day in 15-minute steps, the pump's measured
 * watts where a reading exists for the quarter-hour and the stored schedule × power curve otherwise, plus the UV lamp while the pump runs
 * and the other circuits (blower, lights) from readings, each holding until the next for at most 10 min. Database only: the programs come
 * from the last stored snapshot (or the applied plan while the snapshot is cleared), never from a ScreenLogic read.
 * `source`: 'readings' when readings cover at least 80% of the scheduled pump quarter-hours in the range, 'schedule' otherwise,
 * 'none' with neither a schedule nor readings. `rpm`/`watts` describe the longest program and `kwhPerDay` the schedule alone.
 */
export async function poolKwhBetween(siteId: string, spans: DaySpan[], settingsAll: Record<string, any>) {
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) };
  const snap = await kv.get<PoolSnapshot>(`${siteId}:pool:last`) ?? null;
  let { speeds, schedules }: { speeds: Map<number, number>; schedules: Sched[] } = pumpSchedules(snap);
  if (!snap?.pump) { // applyPlan clears the snapshot until the next read; the plan it wrote is the schedule meanwhile
    const planned: Array<Sched & { rpm: number }> = (await kv.get<any>(`${siteId}:pool:applied`))?.plan?.schedules ?? [];
    speeds = new Map(planned.map(s => [s.circuitId, s.rpm])); schedules = planned;
  }
  const W = powerModel(await measuredPoints(siteId)), prof = hourlyRpm(schedules, speeds), sched = scheduledQuarters(schedules), slices = prof.flatMap(h => h.slices);
  const rows = spans.length ? await q<{ ts: string; day: string; running: boolean; watts: number; circuits: number[] }>(`SELECT ts::text, day, running, watts::float8 watts, circuits
    FROM pool_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`, [siteId, spans[0].day, spans[spans.length - 1].day]) : [];
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) { const a = byDay.get(r.day); if (a) a.push(r); else byDay.set(r.day, [r]); }
  let wh = 0, scheduledQ = 0, coveredQ = 0;
  for (const s of spans) {
    const rd = byDay.get(s.day) ?? [], measured = meanByQuarter(rd.map(r => ({ ts: Number(r.ts), watts: r.running ? Number(r.watts) : 0 })));
    const runs = slices.slice(0, s.quarters).filter((r, i) => (measured[i] ?? r) > 0).length;
    wh += quarterWh(prof, W, measured).slice(0, s.quarters).reduce((a, v) => a + v, 0) + (settings.uv ? runs * UV_W / 4 : 0);
    for (let i = 1; i < rd.length; i++) wh += (rd[i - 1].circuits ?? []).reduce((a, c) => a + (settings.loads[String(c)] ?? 0), 0) * Math.min(600_000, Number(rd[i].ts) - Number(rd[i - 1].ts)) / 3600_000;
    sched.slice(0, s.quarters).forEach((on, i) => { if (on) { scheduledQ++; if (measured[i] != null) coveredQ++; } });
  }
  const coverage = scheduledQ ? coveredQ / scheduledQ : rows.length ? 1 : 0;
  const main = schedules.map(s => ({ rpm: speeds.get(s.circuitId) ?? 0, min: (s.stop - s.start + 1440) % 1440 || 1440 })).sort((a, b) => b.min - a.min)[0];
  return { kwh: Math.round(wh / 10) / 100, source: !schedules.length && !rows.length ? 'none' as const : coverage >= .8 ? 'readings' as const : 'schedule' as const,
    coverage: Math.round(coverage * 100) / 100, rpm: main?.rpm ?? null, watts: main ? Math.round(W(main.rpm)) : null,
    kwhPerDay: schedules.length ? Math.round((dayKwh(prof, W) + (settings.uv ? hoursOn(prof) * UV_W / 1000 : 0)) * 10) / 10 : null };
}

/* ---------- the appliance ---------- */
export async function poolDetail(siteId: string, settingsAll: Record<string, any>, rate: number | null, opts: { fresh?: boolean; act?: boolean } = {}) {
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) };
  let snap = await kv.get<PoolSnapshot>(`${siteId}:pool:last`) ?? null, error: string | null = null;
  if (configured() && (opts.fresh || !snap || Date.now() - snap.at > 60_000)) {
    try { snap = await readPool(); await recordReading(siteId, snap); } catch (e: any) { error = e.message; }
  }
  const W = powerModel(await measuredPoints(siteId)), solarKw = await solarProfile(siteId), month = Number(localDay().slice(5, 7)) - 1; // Chicago month, not the host's
  const names = new Map((snap?.circuits ?? []).map(c => [c.id, c.name]));
  const { speeds, schedules: pumpSched } = pumpSchedules(snap);
  const current = pumpSched.map(s => ({ ...s, rpm: speeds.get(s.circuitId) ?? 0, name: names.get(s.circuitId) ?? `Circuit ${s.circuitId}` }));
  const prof = hourlyRpm(current, speeds), kwh = dayKwh(prof, W) + (settings.uv ? hoursOn(prof) * UV_W / 1000 : 0);
  // the other circuits (blower, lights) and the UV lamp: integrated from readings taken while the app was open (gaps capped at 10 min)
  const rd = await q<{ ts: string; hour: number; running: boolean; circuits: number[] }>(`SELECT ts::text, hour::int, running, circuits FROM pool_readings WHERE site_id = $1 AND day = $2 ORDER BY ts`, [siteId, localDay()]);
  const extraHourly = Array(24).fill(0); let extraKwh = 0, readUvKwh = 0;
  for (let i = 1; i < rd.length; i++) { const dtH = Math.min(600_000, Number(rd[i].ts) - Number(rd[i - 1].ts)) / 3600_000, uvW = rd[i - 1].running && settings.uv ? UV_W : 0; const w = (rd[i - 1].circuits ?? []).reduce((a, c) => a + (settings.loads[String(c)] ?? 0), 0) + uvW; extraHourly[rd[i - 1].hour] += w * dtH / 1000; extraKwh += w * dtH / 1000; readUvKwh += uvW * dtH / 1000; }
  const extraNowW = snap ? snap.circuits.filter(c => c.on).reduce((a, c) => a + (settings.loads[String(c.id)] ?? 0), 0) + (snap.pump?.running && settings.uv ? UV_W : 0) : 0;
  const lightH = await q<{ h: number }>(`SELECT COUNT(*)::int h FROM pool_readings WHERE site_id = $1 AND day >= $2 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) c WHERE c = ANY(array['3','4']))`, [siteId, addDays(localDay(), -30)]);
  const waterTemp = snap?.bodies[0]?.temp ?? WATER_BY_MONTH[month];
  const plan = planFor({ waterTemp, solarKw, settings, W, rate, month, names });
  const seasons = [[11, 'Dec–Feb'], [2, 'Mar–May'], [5, 'Jun–Aug'], [8, 'Sep–Nov']].map(([m, label]) => {
    const months = [m as number, ((m as number) + 1) % 12, ((m as number) + 2) % 12], avg = Math.round(months.reduce((a, i) => a + WATER_BY_MONTH[i], 0) / 3);
    const p = planFor({ waterTemp: avg, solarKw, settings, W, rate, month: m as number, names });
    return { label, waterTemp: p.waterTemp, hours: p.hours, boostHours: p.boostHours, rpm: settings.filterRpm, kwhPerDay: p.kwhPerDay, costPerMonth: p.costPerMonth, current: seasonOf(month) === seasonOf(m as number) };
  });
  // today so far, in 15-minute steps up to the current quarter-hour: the pump's measured watts where a reading exists for the
  // quarter-hour, the schedule × curve otherwise; the UV lamp while the pump runs; plus the other circuits from readings
  // (extraKwh without its UV share, so the lamp is counted once)
  const nowQ = quarterOf(Date.now()), measured = await measuredQuarters(siteId, localDay());
  const pumpWh = quarterWh(prof, W, measured).slice(0, nowQ), runs = prof.flatMap(h => h.slices).slice(0, nowQ).map((r, i) => (measured[i] ?? r) > 0);
  const todayKwh = (pumpWh.reduce((a, v) => a + v, 0) + (settings.uv ? runs.filter(Boolean).length * UV_W / 4 : 0)) / 1000 + extraKwh - readUvKwh;
  const home = await q<{ kwh: number }>(`SELECT (SUM(home_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day = $2`, [siteId, localDay()]);
  const applied = await kv.get<any>(`${siteId}:pool:applied`) ?? null;
  const auto = await autopilot(siteId, { settings, mode: settings.autopilot, W, rate, names, snap, waterTemp, currentHours: hoursOn(prof), act: !!opts.act }).catch(e => ({ error: e.message as string }));
  const pending = await kv.get<any>(`${siteId}:pool:pending`) ?? null;
  // a spa session: heat from the spa's current temperature to its set point with the propane heater, pump at spa speed, blower on
  const spaTemp = snap?.bodies?.[1]?.temp ?? null, spaSet = snap?.bodies?.[1]?.setPoint ?? null, rise = spaTemp != null && spaSet != null ? Math.max(0, spaSet - spaTemp) : null;
  const btu = rise != null ? settings.spaGallons * 8.34 * rise : null, heatMin = btu != null ? Math.round(btu / (settings.heaterBtu * .82) * 60) : null, propaneGal = btu != null ? Math.round(btu / .82 / 91_500 * 100) / 100 : null;
  const spaRpm = speeds.get(1) ?? 3190, spaSession = { spaGallons: settings.spaGallons, spaTemp, spaSet, riseF: rise, heatMinutes: heatMin, propaneGal, propaneUsd: propaneGal != null ? Math.round(propaneGal * settings.propaneUsdPerGal * 100) / 100 : null,
    pumpWattsAtSpa: Math.round(W(spaRpm)), blowerWatts: settings.loads['2'] ?? 0, electricUsdPerHour: usd((W(spaRpm) + (settings.loads['2'] ?? 0) + (settings.loads['4'] ?? 0)) / 1000, rate, true) };
  return { id: 'pool', autopilot: auto, pending, extras: { hourlyToday: extraHourly.map(v => Math.round(v * 1000) / 1000), todayKwh: Math.round(extraKwh * 100) / 100, nowW: extraNowW, loads: settings.loads, uvW: settings.uv ? UV_W : 0, lightReadings30d: lightH[0]?.h ?? 0 }, spaSession, name: 'Pool pump', linked: configured() && !!snap, error, settings, snapshot: snap,
    live: snap?.pump ? { watts: snap.pump.watts, rpm: snap.pump.rpm, running: snap.pump.running, gpm: snap.pump.gpm, at: snap.at, waterTemp, airTemp: snap.airTemp, freezeMode: snap.freezeMode,
      on: snap.circuits.filter(c => c.on).map(c => c.name), activeRpm: Math.max(0, ...snap.circuits.filter(c => c.on).map(c => speeds.get(c.id) ?? 0)) } : null,
    model: { measured: await measuredPoints(siteId), curve: [1000, 1500, 1800, 2400, 3000, 3450].map(r => ({ rpm: r, watts: Math.round(W(r)) })) },
    current: { schedules: current, hours: Math.round(hoursOn(prof) * 10) / 10, kwhPerDay: Math.round(kwh * 10) / 10, costPerMonth: usd(kwh * 30.4, rate), onSolarPct: onSolarPct(prof, W, solarKw),
      turnoverPerDay: Math.round(prof.reduce((a, h) => a + h.slices.reduce((b, r) => b + gpmAt(r, settings.designGpm) * 15, 0), 0) / settings.gallons * 100) / 100, hourly: prof,
      byProgram: current.map(s => { const p = hourlyRpm([s], speeds); return { name: s.name, rpm: s.rpm, start: s.start, stop: s.stop, kwhPerDay: Math.round(dayKwh(p, W) * 10) / 10 }; }) },
    plan, seasons, solarKw, todayKwh: Math.round(todayKwh * 10) / 10, todayCost: usd(todayKwh, rate, true), shareOfHomePct: home[0]?.kwh ? Math.round(todayKwh / home[0].kwh * 100) : null,
    rate, applied, conf: { kwhPerDay: await confidenceFor(siteId, 'pool.kwhDay') } }; // learning layer: trust in every kWh/day figure above
}

/* ---------- writes: every one goes through the safety guard (guards.ts) inside writePoolPlan ---------- */
/**
 * The pump circuits Autopilot manages: Pool, High Speed, and the Waterfall whose schedules it replaces. Fixed here rather than read
 * from settings, so no setting can point a write at another circuit; the guard also refuses freeze, spa, spa-related, light and heater circuits.
 */
export const MANAGED_CIRCUITS: readonly number[] = [DEFAULTS.poolCircuit, DEFAULTS.boostCircuit, ...DEFAULTS.featureCircuits];
/** What the guard needs to know about the controller, from a snapshot the caller already read (circuits, pump slots, RPM limits). */
export const guardContext = (snap: PoolSnapshot): PoolGuardContext => ({ circuits: snap.circuits, pumpCircuits: (snap.pump?.circuits ?? []).map(c => c.circuitId),
  minRpm: snap.pump?.minRpm, maxRpm: snap.pump?.maxRpm, managed: [...MANAGED_CIRCUITS] });
/** The exact ScreenLogic write applyPlan sends for a plan, so Autopilot can check it with the guard first. The snapshot must have a pump. */
export const planWrite = (plan: Plan, snap: PoolSnapshot, settings: PoolSettings) => ({ pumpId: snap.pump!.id, speeds: plan.schedules.map(s => ({ circuitId: s.circuitId, rpm: s.rpm })),
  replaceCircuits: [settings.poolCircuit, settings.boostCircuit, ...settings.featureCircuits], schedules: plan.schedules.map(s => ({ circuitId: s.circuitId, start: s.start, stop: s.stop })), guard: guardContext(snap) });
/** Add a line to the pool activity log (the Autopilot log on the Pool card). */
async function logPool(siteId: string, text: string, delta?: string) {
  const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:pool:autolog`) ?? [];
  log.unshift({ at: Date.now(), day: localDay(), text, delta });
  await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30));
}
/** writePoolPlan, with a guard refusal recorded in the pool activity log before it is rethrown. */
async function guardedWrite(siteId: string, what: string, opts: Parameters<typeof writePoolPlan>[0]) {
  try { return await writePoolPlan(opts); }
  catch (e) { if (e instanceof GuardRefusal) await logPool(siteId, `Refused ${what}: ${e.reason}`, 'refused'); throw e; }
}

export async function applyPlan(siteId: string, plan: Plan, snap: PoolSnapshot, settings: PoolSettings) {
  if (!snap.pump) throw new Error('No pump found on the controller');
  const w = planWrite(plan, snap, settings), replace = w.replaceCircuits;
  const r = await guardedWrite(siteId, 'a pool schedule write', w);
  const record = { at: Date.now(), plan: { start: plan.start, stop: plan.stop, boostAt: plan.boostAt, schedules: plan.schedules }, removed: r.removed, added: r.added,
    previousSpeeds: snap.pump.circuits.filter(c => replace.includes(c.circuitId)) };
  await kv.set(`${siteId}:pool:applied`, record);
  await kv.set(`${siteId}:pool:last`, null as any);
  return record;
}

export async function restorePrevious(siteId: string, snap: PoolSnapshot) {
  const rec = await kv.get<any>(`${siteId}:pool:applied`); if (!rec || !snap.pump) throw new Error('Nothing to restore');
  const circuits = [...new Set([...rec.removed.map((x: any) => x.circuitId), ...rec.plan.schedules.map((x: any) => x.circuitId)])] as number[];
  await guardedWrite(siteId, 'the restore', { pumpId: snap.pump.id, speeds: rec.previousSpeeds.map((c: any) => ({ circuitId: c.circuitId, rpm: c.speed })), replaceCircuits: circuits,
    schedules: rec.removed.map((x: any) => ({ circuitId: x.circuitId, start: x.start, stop: x.stop, dayMask: x.dayMask })), guard: guardContext(snap) });
  await kv.set(`${siteId}:pool:applied`, null as any);
  await kv.set(`${siteId}:pool:last`, null as any);
}

export const poolAppliance: Appliance = {
  id: 'pool', name: 'Pool pump', source: 'Pentair ScreenLogic',
  available: () => configured(),
  summary: async (siteId, settings, rate): Promise<ApplianceSummary> => {
    const d = await poolDetail(siteId, settings, rate);
    return { id: 'pool', name: 'Pool pump', status: d.linked ? 'linked' : 'estimated', watts: d.live?.watts ?? null, kwhPerDay: d.current.kwhPerDay, savesPerMonth: d.current.costPerMonth != null && d.plan.costPerMonth != null ? Math.max(0, d.current.costPerMonth - d.plan.costPerMonth) : null };
  },
};
