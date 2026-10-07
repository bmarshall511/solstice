// Pool pump appliance: what the IntelliFlo is doing, what the current schedule costs, and a season-aware smarter schedule.
import { q, kv, hourWh } from '../db.js';
import { patchSettings } from '../settings.js';
import { readPool, writePoolPlan, writeOwnerPool, configured, type PoolSnapshot } from './screenlogic.js';
import { noteYouRun, endYouRun, poolChanges } from './poolLearn.js';
import { localDay, addDays, rfc3339 } from '../tesla/client.js';
import type { Appliance, ApplianceSummary } from './index.js';
import { autopilot, type Mode } from './autopilot.js';
import { GuardRefusal, type PoolGuardContext, type PoolOwnerCommand } from './guards.js';
import { usd } from '../tariff.js';
import { confidenceFor } from '../learn/confidence.js';
import { filterForecast } from './poolFilter.js';
import { PRESENCE_FIXED } from './presence.js';

export type PoolSettings = { gallons: number; spaGallons: number; designGpm: number; filterRpm: number; boostRpm: number; poolCircuit: number; boostCircuit: number; featureCircuits: number[]; autopilot: Mode; uv: boolean;
  heaterBtu: number; propaneUsdPerGal: number; loads: Record<string, number>; turnoverGoal: number; skimHours: number; skimAt: number | null };
// From the construction plan: 14,995 gal pool, ~1,000 gal spa, designed for 120 GPM; Ultra UV sanitizer; 400k BTU propane heater;
// other circuits' draws (W): 1.5 HP blower, 500 W pool light, 100 W spa light, ~60 W UV lamp while the pump runs.
const DEFAULTS: PoolSettings = { gallons: 14995, spaGallons: 1000, designGpm: 120, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5], autopilot: 'suggest', uv: true,
  heaterBtu: 400_000, propaneUsdPerGal: 3.0, loads: { '2': 1100, '3': 500, '4': 100 },
  turnoverGoal: 3, skimHours: 1, skimAt: null };   // skimAt: the skim hour you chose (mockup ae); null = the sunniest hour of the run   // mockup w frame 5: the owner's goal (about 3 turnovers a day, Option A of the October audit) and a daily skim hour
/** The planner's search space: whole pump hours up to PUMP_HOURS_MAX a day at a filter speed in 50 RPM steps between these. */
export const FILTER_RPM_MIN = 1200, FILTER_RPM_MAX = 2400, PUMP_HOURS_MAX = 12, PUMP_HOURS_MIN = 4;
export { DEFAULTS as POOL_DEFAULTS };
const UV_W = 60;
// Typical pool-water temperature by month for central Texas (°F): used only for the season table; the live plan uses the real reading.
const WATER_BY_MONTH = [55, 57, 62, 70, 78, 84, 88, 88, 84, 75, 65, 58];
/** Meteorological season of a 0-based month: 0 Dec–Feb, 1 Mar–May, 2 Jun–Aug, 3 Sep–Nov. */
const seasonOf = (m: number) => Math.floor((m + 1) % 12 / 3);
export const FREEZE_CIRCUIT = 132; // ScreenLogic's virtual "freeze protection" pump circuit
/** Whether a pump reading is a run: the IntelliFlo reports isRunning with 0 RPM and 0 W at night (seen 2026-10-07 00:05 and 02:05), which is not. pool_readings keeps the raw values. */
export const pumpRunning = (p: { running?: boolean | null; rpm?: number | null; watts?: number | null; status?: 'unknown' } | null | undefined) =>
  p?.status !== 'unknown' && !!p?.running && Number(p.rpm) > 0 && Number(p.watts) > 0;   // a failed status read is not a run (code review C-09)
/** pumpRunning as a pool_readings predicate (a NULL rpm or watts is not a run). */
export const PUMP_RUNNING_SQL = '(running AND rpm > 0 AND watts > 0)';

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
/**
 * The turnover planner (mockup w frame 5): the filter speed and whole pump hours that move `turnoverGoal` × the pool's gallons a day
 * for the least energy, within PUMP_HOURS_MAX hours, with `skimHours` of the run at the boost speed. Lower speeds move water for
 * less energy (power rises faster than flow), so the answer is the slowest speed that still fits. Flow is the model (gpmAt).
 */
export function goalPlan(s: PoolSettings, W: (r: number) => number) {
  const skim = Math.max(0, Math.min(3, s.skimHours ?? 1)), need = s.gallons * (s.turnoverGoal ?? 3);
  const moved = (h: number, r: number) => ((h - skim) * gpmAt(r, s.designGpm) + skim * gpmAt(s.boostRpm, s.designGpm)) * 60;
  let best: { rpm: number; hours: number; kwh: number } | null = null;
  for (let r = FILTER_RPM_MIN; r <= FILTER_RPM_MAX; r += 50) for (let h = Math.max(PUMP_HOURS_MIN, skim + 1); h <= PUMP_HOURS_MAX; h++) {
    if (moved(h, r) < need) continue;
    const kwh = ((h - skim) * W(r) + skim * W(s.boostRpm)) / 1000;
    if (!best || kwh < best.kwh - 1e-9) best = { rpm: r, hours: h, kwh };
    break;   // more hours at this speed only cost more
  }
  return { rpm: best?.rpm ?? FILTER_RPM_MAX, hours: best?.hours ?? PUMP_HOURS_MAX, skim, reached: !!best };
}
export function planFor(o: { waterTemp: number; solarKw: number[]; settings: PoolSettings; W: (r: number) => number; rate: number | null; month: number; names: Map<number, string>; force?: { hours: number; boost: number } }) {
  const { waterTemp: t, settings: s, W } = o;
  const g = goalPlan(s, W), rpm = g.rpm;
  const hours = o.force?.hours ?? g.hours;
  const boostH = Math.min(o.force?.boost ?? g.skim, hours);
  // put the run where the sun is: the contiguous window with the most solar; with no solar data, the default 08:00 start
  let best = 8, bestSum = 0;
  for (let st = Math.min(5, 24 - hours); st + hours <= Math.max(20, hours); st++) { const sum = o.solarKw.slice(st, st + hours).reduce((a, v) => a + v, 0); if (sum > bestSum) { bestSum = sum; best = st; } }
  if (best + hours > 24) best = 24 - hours;
  const start = best, stop = best + hours;
  const sunniest = () => o.solarKw.slice(start, stop).reduce((bi, v, i, arr) => v > arr[bi] ? i : bi, 0) + start;
  const boostAt = boostH ? Math.max(start, Math.min(stop - boostH, s.skimAt ?? sunniest())) : null;
  const schedules: Array<Sched & { rpm: number; name: string; why: string }> = [
    { circuitId: s.poolCircuit, start: start * 60, stop: stop % 24 * 60, rpm, name: o.names.get(s.poolCircuit) ?? 'Pool', why: `${hours} h of filtration at ${rpm.toLocaleString()} RPM toward ${s.turnoverGoal ?? 3} turnovers of ${s.gallons.toLocaleString()} gal a day` }];
  if (boostAt != null) schedules.push({ circuitId: s.boostCircuit, start: boostAt * 60, stop: (boostAt + boostH) % 24 * 60, rpm: s.boostRpm, name: o.names.get(s.boostCircuit) ?? 'High Speed', why: `${boostH === 1 ? 'a one-hour' : `a ${boostH}-hour`} skim at ${s.boostRpm.toLocaleString()} RPM at the sunniest hour, for surface debris and mixing` });
  const speeds = new Map(schedules.map(x => [x.circuitId, x.rpm]));
  const prof = hourlyRpm(schedules, speeds), kwh = dayKwh(prof, W) + (s.uv ? hoursOn(prof) * UV_W / 1000 : 0);
  const turnoverPerDay = Math.round(prof.reduce((a, h) => a + h.slices.reduce((b, r) => b + gpmAt(r, s.designGpm) * 15, 0), 0) / s.gallons * 100) / 100;
  return { month: o.month, waterTemp: t, turnovers: turnoverPerDay, goal: s.turnoverGoal ?? 3, rpm, hours, boostHours: boostH, start, stop, boostAt, schedules, kwhPerDay: Math.round(kwh * 10) / 10,
    costPerMonth: usd(kwh * 30.4, o.rate), onSolarPct: onSolarPct(prof, W, o.solarKw), turnoverPerDay, hourly: prof, uvKwh: s.uv ? Math.round(hoursOn(prof) * UV_W) / 1000 : 0 };
}

/* ---------- storage ---------- */
/** Kept for Data health and debugging: when a pump-status read last failed (the reading was not stored). */
export const statusUnknownKey = (siteId: string) => `${siteId}:pool:statusUnknownAt`;
export async function recordReading(siteId: string, snap: PoolSnapshot) {
  if (!snap.pump) return;
  // a failed pump-status read stores no row: running/watts/rpm are NOT NULL, and "off" would cut the day's water and kWh, pump hours,
  // and count toward Vacation mode's "the pump didn't run" (code review C-09); the snapshot still updates pool:last
  if (snap.pump.status === 'unknown' || snap.pump.running == null || snap.pump.watts == null || snap.pump.rpm == null) {
    await kv.set(statusUnknownKey(siteId), snap.at); await kv.set(`${siteId}:pool:last`, snap); return;
  }
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
/**
 * A past day's quarter-hours from its readings: measured where read; a gap of up to an hour between two running reads (a missed read)
 * takes their average; any other unread quarter was outside the schedule, so 0. With `today`, the last two elapsed quarters stay null
 * (the schedule fills them) because their read may simply not have happened yet.
 */
export function filledQuarters(measured: Array<number | null>, quarters: number, today: boolean): Array<number | null> {
  const out = measured.slice(), read = out.map((v, i) => v != null ? i : -1).filter(i => i >= 0 && i < quarters);
  for (let i = 0; i < quarters; i++) {
    if (out[i] != null) continue;
    if (today && i >= quarters - 2) continue;
    const l = [...read].reverse().find(j => j < i), r = read.find(j => j > i);
    out[i] = l != null && r != null && r - l <= 5 && measured[l]! > 0 && measured[r]! > 0 ? (measured[l]! + measured[r]!) / 2 : 0;
  }
  return out;
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
/** Days of readings measuredPoints uses (code review C-12: it read every reading ever, on every pool read). */
export const MEASURED_POINTS_DAYS = 30;
/** The pump's measured watts at each RPM: the median of the last 30 days of running readings, for RPMs read at least 3 times. */
export const measuredPoints = (siteId: string, now = Date.now()) => q<{ rpm: number; watts: number }>(`SELECT rpm::int rpm, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY watts)::float8 watts
  FROM pool_readings WHERE site_id = $1 AND day >= $2 AND running AND rpm > 0 AND watts > 0 GROUP BY rpm HAVING COUNT(*) >= 3`, [siteId, addDays(localDay(new Date(now)), -MEASURED_POINTS_DAYS)]);
const solarProfile = async (siteId: string) => {
  const rows = await q<{ hour: number; kw: number }>(`SELECT hour::int, (SUM(s) / 1000.0 / 14)::float8 kw FROM (SELECT day, hour, ${hourWh('solar_wh')} s FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour) x GROUP BY hour`, [siteId, addDays(localDay(), -14), localDay()]);
  const out = Array(24).fill(0); rows.forEach(r => out[r.hour] = r.kw); return out;
};

/**
 * B2-14 (audit L-33): how long a reading's circuits (lights, blower) and UV state hold: until the next reading, at most 60 minutes. The
 * cron reads every 15 minutes in pump hours and hourly otherwise (sampling.ts), so the old 10-minute cap counted lights on 20:00–23:00
 * outside pump hours as 30 minutes of 3 hours.
 */
export const CIRCUIT_HOLD_MS = 60 * 60_000;
/* ---------- History → "Where every kWh went": pool kWh over a range of days (database only) ---------- */
/** One local day of a range: its 15-minute slices elapsed (96 for a past day) and its elapsed and full length (23, 24 or 25 h). */
export type DaySpan = { day: string; quarters: number; elapsedMs: number; lengthMs: number };
/**
 * Pool kWh for the History flows card, from the model behind the Pool card's "today": each day in 15-minute steps, the pump's measured
 * watts where a reading exists for the quarter-hour and the stored schedule × power curve otherwise, plus the UV lamp while the pump runs
 * and the other circuits (blower, lights) from readings, each holding until the next for at most 60 min (B2-14). Database only: the programs come
 * from the last stored snapshot (or the applied plan while the snapshot is cleared), never from a ScreenLogic read.
 * Past quarter-hours come from that day's own readings (filledQuarters); days with no read at all take the read days' average.
 * `source`: 'readings' when days with readings make up at least 80% of the range, 'schedule' otherwise,
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
  const W = powerModel(await measuredPoints(siteId)), prof = hourlyRpm(schedules, speeds), slices = prof.flatMap(h => h.slices);
  const rows = spans.length ? await q<{ ts: string; day: string; running: boolean; watts: number; circuits: number[] }>(`SELECT ts::text, day, running, watts::float8 watts, circuits
    FROM pool_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`, [siteId, spans[0].day, spans[spans.length - 1].day]) : [];
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) { const a = byDay.get(r.day); if (a) a.push(r); else byDay.set(r.day, [r]); }
  // A day's own readings say which schedule ran that day (reads happen only in scheduled quarter-hours plus 02:05 and 05:05), so the
  // schedule stored now (which may be a temporary all-day one) only fills today's last half hour and ranges with no readings at all.
  let wh = 0, readMs = 0, unreadMs = 0; const dayWh: number[] = [];
  spans.forEach((s, k) => {
    const rd = byDay.get(s.day) ?? [];
    if (!rd.length && rows.length) { unreadMs += s.elapsedMs; return; }   // filled below from the days that have readings
    const measured = rd.length ? filledQuarters(meanByQuarter(rd.map(r => ({ ts: Number(r.ts), watts: r.running ? Number(r.watts) : 0 }))), s.quarters, k === spans.length - 1 && s.quarters < 96) : Array(96).fill(null);
    const runs = slices.slice(0, s.quarters).filter((r, i) => (measured[i] ?? r) > 0).length;
    let d = quarterWh(prof, W, measured).slice(0, s.quarters).reduce((a, v) => a + v, 0) + (settings.uv ? runs * UV_W / 4 : 0);
    for (let i = 1; i < rd.length; i++) d += (rd[i - 1].circuits ?? []).reduce((a, c) => a + (settings.loads[String(c)] ?? 0), 0) * Math.min(CIRCUIT_HOLD_MS, Number(rd[i].ts) - Number(rd[i - 1].ts)) / 3600_000;
    wh += d; if (rd.length) { readMs += s.elapsedMs; dayWh.push(d); }
  });
  if (unreadMs && readMs) wh += dayWh.reduce((a, v) => a + v, 0) / readMs * unreadMs;   // days without a single read: the read days' average rate
  const coverage = readMs + unreadMs ? readMs / (readMs + unreadMs) : 0;
  const main = schedules.map(s => ({ rpm: speeds.get(s.circuitId) ?? 0, min: (s.stop - s.start + 1440) % 1440 || 1440 })).sort((a, b) => b.min - a.min)[0];
  return { kwh: Math.round(wh / 10) / 100, source: !schedules.length && !rows.length ? 'none' as const : coverage >= .8 ? 'readings' as const : 'schedule' as const,
    coverage: Math.round(coverage * 100) / 100, rpm: main?.rpm ?? null, watts: main ? Math.round(W(main.rpm)) : null,
    kwhPerDay: schedules.length ? Math.round((dayKwh(prof, W) + (settings.uv ? hoursOn(prof) * UV_W / 1000 : 0)) * 10) / 10 : null };
}

/* ---------- the appliance ---------- */
/** How long a stored controller snapshot serves a read before ScreenLogic is asked again (one ask per window: S-07's single flight). */
export const POOL_READ_MS = 60_000;
/**
 * The Pool card. `fresh` (the crons, apply, the departure check, ?fresh=1) always reads the controller. Otherwise it is read only when
 * the stored snapshot is over a minute old AND this caller wins the `<site>:pool:readClaim` single flight, so N concurrent stale
 * requests open one ScreenLogic connection and the rest serve the stored snapshot. `readOnly` (a guest, or the owner previewing as
 * one; S-07) never contacts the controller.
 */
export async function poolDetail(siteId: string, settingsAll: Record<string, any>, rate: number | null, opts: { fresh?: boolean; act?: boolean; readOnly?: boolean } = {}) {
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) };
  let snap = await kv.get<PoolSnapshot>(`${siteId}:pool:last`) ?? null, error: string | null = null;
  const due = !opts.readOnly && configured() && (opts.fresh || !snap || Date.now() - snap.at > POOL_READ_MS);
  if (due && (opts.fresh || await kv.claim(`${siteId}:pool:readClaim`, POOL_READ_MS))) {
    try { snap = await readPool(); await recordReading(siteId, snap); } catch (e: any) { error = e.message; }
  }
  const points = await measuredPoints(siteId);   // once per poolDetail: the power model and the card's measured points
  const W = powerModel(points), solarKw = await solarProfile(siteId), month = Number(localDay().slice(5, 7)) - 1; // Chicago month, not the host's
  const names = new Map((snap?.circuits ?? []).map(c => [c.id, c.name]));
  const { speeds, schedules: pumpSched } = pumpSchedules(snap);
  const current = pumpSched.map(s => ({ ...s, rpm: speeds.get(s.circuitId) ?? 0, name: names.get(s.circuitId) ?? `Circuit ${s.circuitId}` }));
  const prof = hourlyRpm(current, speeds), kwh = dayKwh(prof, W) + (settings.uv ? hoursOn(prof) * UV_W / 1000 : 0);
  // the other circuits (blower, lights) and the UV lamp: integrated from the readings, each holding until the next (gaps capped at 60 min, B2-14)
  const rd = await q<{ ts: string; hour: number; running: boolean; circuits: number[] }>(`SELECT ts::text, hour::int, running, circuits FROM pool_readings WHERE site_id = $1 AND day = $2 ORDER BY ts`, [siteId, localDay()]);
  const extraHourly = Array(24).fill(0); let extraKwh = 0, readUvKwh = 0;
  for (let i = 1; i < rd.length; i++) { const dtH = Math.min(CIRCUIT_HOLD_MS, Number(rd[i].ts) - Number(rd[i - 1].ts)) / 3600_000, uvW = rd[i - 1].running && settings.uv ? UV_W : 0; const w = (rd[i - 1].circuits ?? []).reduce((a, c) => a + (settings.loads[String(c)] ?? 0), 0) + uvW; extraHourly[rd[i - 1].hour] += w * dtH / 1000; extraKwh += w * dtH / 1000; readUvKwh += uvW * dtH / 1000; }
  const extraNowW = snap ? snap.circuits.filter(c => c.on).reduce((a, c) => a + (settings.loads[String(c.id)] ?? 0), 0) + (snap.pump?.running && settings.uv ? UV_W : 0) : 0;
  const lightH = await q<{ h: number }>(`SELECT COUNT(*)::int h FROM pool_readings WHERE site_id = $1 AND day >= $2 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) c WHERE c = ANY(array['3','4']))`, [siteId, addDays(localDay(), -30)]);
  const waterTemp = snap?.bodies[0]?.temp ?? WATER_BY_MONTH[month];
  const plan = planFor({ waterTemp, solarKw, settings, W, rate, month, names });
  const seasons = [[11, 'Dec–Feb'], [2, 'Mar–May'], [5, 'Jun–Aug'], [8, 'Sep–Nov']].map(([m, label]) => {
    const months = [m as number, ((m as number) + 1) % 12, ((m as number) + 2) % 12], avg = Math.round(months.reduce((a, i) => a + WATER_BY_MONTH[i], 0) / 3);
    const p = planFor({ waterTemp: avg, solarKw, settings, W, rate, month: m as number, names });
    return { label, waterTemp: p.waterTemp, hours: p.hours, boostHours: p.boostHours, rpm: p.rpm, kwhPerDay: p.kwhPerDay, costPerMonth: p.costPerMonth, current: seasonOf(month) === seasonOf(m as number) };
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
  // frame 5's ring: water moved today from the pump's own readings (quarter-hours read, short gaps in a run filled, unread ones off),
  // and what the rest of today's controller schedule adds
  const rpmRows = await q<{ ts: string; running: boolean; rpm: number }>(`SELECT ts::text, running, rpm::float8 rpm FROM pool_readings WHERE site_id = $1 AND day = $2`, [siteId, localDay()]);
  const readRpm = rpmRows.length ? filledQuarters(meanByQuarter(rpmRows.map(r => ({ ts: Number(r.ts), watts: r.running ? Number(r.rpm) : 0 }))), nowQ, true) : Array(96).fill(null);
  const qRpm = prof.flatMap(h => h.slices), gal = (r: number) => gpmAt(r, settings.designGpm) * 15;
  const movedGal = qRpm.slice(0, nowQ).reduce((a, r, i) => a + gal(readRpm[i] ?? r), 0), restGal = qRpm.slice(nowQ).reduce((a, r) => a + gal(r), 0);
  const water = { goal: settings.turnoverGoal, skimHours: settings.skimHours, movedTurnovers: Math.round(movedGal / settings.gallons * 100) / 100,
    projectedTurnovers: Math.round((movedGal + restGal) / settings.gallons * 100) / 100, gallons: settings.gallons };
  const untilAll = await kv.get<Record<string, number>>(`${siteId}:pool:until`) ?? {}, nowMs = Date.now();
  const until = Object.fromEntries(Object.entries(untilAll).filter(([id, t]) => t > nowMs && snap?.circuits.find(c => c.id === Number(id))?.on));   // only runs still going
  const cu = await activeClearUp(siteId), clearUp = cu ? { ...cu, day: Math.min(cu.days, Math.floor((Date.now() - cu.startedAt) / 864e5) + 1) } : null;
  const clearUpRates = Array.from({ length: (CLEARUP_RPM_MAX - CLEARUP_RPM_MIN) / 50 + 1 }, (_, i) => CLEARUP_RPM_MIN + i * 50)
    .map(r => ({ rpm: r, kwhPerDay: Math.round((W(r) * 24 + (settings.uv ? UV_W * 24 : 0)) / 100) / 10, turnovers: Math.round(gpmAt(r, settings.designGpm) * 1440 / settings.gallons * 10) / 10 }));
  const changes = await poolChanges(siteId, { goal: settings.turnoverGoal, skimAt: settings.skimAt });
  return { id: 'pool', water, clearUp, clearUpRates, changes, runFor: await kv.get<Record<string, number>>(`${siteId}:pool:runFor`) ?? {}, until, autopilot: auto, pending, extras: { hourlyToday: extraHourly.map(v => Math.round(v * 1000) / 1000), todayKwh: Math.round(extraKwh * 100) / 100, nowW: extraNowW, loads: settings.loads, uvW: settings.uv ? UV_W : 0, lightReadings30d: lightH[0]?.h ?? 0 }, spaSession, name: 'Pool pump', linked: configured() && !!snap, error, settings, snapshot: snap,
    live: snap?.pump ? { watts: snap.pump.watts, rpm: snap.pump.rpm, running: snap.pump.running, gpm: snap.pump.gpm, at: snap.at, waterTemp, airTemp: snap.airTemp, freezeMode: snap.freezeMode,
      on: snap.circuits.filter(c => c.on).map(c => c.name), activeRpm: Math.max(0, ...snap.circuits.filter(c => c.on).map(c => speeds.get(c.id) ?? 0)) } : null,
    model: { measured: points, curve: [1000, 1500, 1800, 2400, 3000, 3450].map(r => ({ rpm: r, watts: Math.round(W(r)) })) },
    current: { schedules: current, hours: Math.round(hoursOn(prof) * 10) / 10, kwhPerDay: Math.round(kwh * 10) / 10, costPerMonth: usd(kwh * 30.4, rate), onSolarPct: onSolarPct(prof, W, solarKw),
      turnoverPerDay: Math.round(prof.reduce((a, h) => a + h.slices.reduce((b, r) => b + gpmAt(r, settings.designGpm) * 15, 0), 0) / settings.gallons * 100) / 100, hourly: prof,
      byProgram: current.map(s => { const p = hourlyRpm([s], speeds); return { name: s.name, rpm: s.rpm, start: s.start, stop: s.stop, kwhPerDay: Math.round(dayKwh(p, W) * 10) / 10 }; }) },
    plan, seasons, solarKw, todayKwh: Math.round(todayKwh * 10) / 10, todayCost: usd(todayKwh, rate, true), shareOfHomePct: home[0]?.kwh ? Math.round(todayKwh / home[0].kwh * 100) : null,
    rate, applied, conf: { kwhPerDay: await confidenceFor(siteId, 'pool.kwhDay') },   // learning layer: trust in every kWh/day figure above
    filter: await filterForecast(siteId).catch(() => null) };   // B2-6: when the D.E. filter reaches 88% of its clean-filter watts (poolFilter.ts)
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
  // Pool and High Speed only: the Waterfall is a switch, never a schedule Autopilot writes or removes (October audit, Q6)
  replaceCircuits: [settings.poolCircuit, settings.boostCircuit], schedules: plan.schedules.map(s => ({ circuitId: s.circuitId, start: s.start, stop: s.stop })), guard: guardContext(snap) });
/** Add a line to the pool activity log (the Autopilot log on the Pool card). */
async function logPool(siteId: string, text: string, delta?: string) {
  const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:pool:autolog`) ?? [];
  log.unshift({ at: Date.now(), day: localDay(), text, delta });
  await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30));
}
/* ---------- mockup w frame 6: Clear-up (the Pool circuit all day for 1–3 days, then back to the planner by itself) ---------- */
export type ClearUp = { startedAt: number; until: number; days: number; rpm: number };
export const CLEARUP_RPM_MIN = 1500, CLEARUP_RPM_MAX = 3000, CLEARUP_DAYS_MAX = 3;
const clearUpKey = (siteId: string) => `${siteId}:pool:clearup`;
/** The evening pool run (01:15 UTC, the pool cron) at or after `t`: a Clear-up ends there, so the planner takes over in the same run. */
export const poolRunAfter = (t: number) => { const d = new Date(t); d.setUTCHours(1, 15, 0, 0); if (d.getTime() < t) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); };
/** The Clear-up in force, or null (one past its end counts as over; the evening run ends it properly). */
export async function activeClearUp(siteId: string, now = Date.now()) { const c = await kv.get<ClearUp | null>(clearUpKey(siteId)); return c && c.until > now ? c : null; }
/** Why a Clear-up request is unusable, or null: 1–3 whole days at 1,500–3,000 RPM in 50 RPM steps. */
export function clearUpError(b: any): string | null {
  if (!Number.isInteger(b?.days) || b.days < 1 || b.days > CLEARUP_DAYS_MAX) return `a Clear-up runs 1–${CLEARUP_DAYS_MAX} days`;
  if (!Number.isInteger(b?.rpm) || b.rpm < CLEARUP_RPM_MIN || b.rpm > CLEARUP_RPM_MAX || b.rpm % 50) return `a Clear-up runs at ${CLEARUP_RPM_MIN.toLocaleString()}–${CLEARUP_RPM_MAX.toLocaleString()} RPM`;
  return null;
}
/** Start a Clear-up: the Pool circuit's programs (and the skim's) replaced by one all-day program at `rpm`, through the guarded write. */
export async function startClearUp(siteId: string, o: { days: number; rpm: number }, settingsAll: Record<string, any>, now = Date.now()) {
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) }, snap = await readPool();
  if (!snap.pump) throw new Error('No pump found on the controller');
  await guardedWrite(siteId, 'the Clear-up', { pumpId: snap.pump.id, speeds: [{ circuitId: settings.poolCircuit, rpm: o.rpm }], replaceCircuits: [settings.poolCircuit, settings.boostCircuit],
    schedules: [{ circuitId: settings.poolCircuit, start: 0, stop: 1439 }], guard: guardContext(snap) });
  const c: ClearUp = { startedAt: now, until: poolRunAfter(now + o.days * 864e5), days: o.days, rpm: o.rpm };
  await kv.set(clearUpKey(siteId), c); await kv.set(`${siteId}:pool:last`, null as any); await kv.set(`${siteId}:pool:pending`, null as any);
  await logPool(siteId, `You started a ${o.days}-day Clear-up at ${o.rpm.toLocaleString()} RPM`, 'you');
  return c;
}
/** One more day (the end moves to the next evening run). */
export async function extendClearUp(siteId: string) {
  const c = await activeClearUp(siteId); if (!c) throw new Error('No Clear-up is running');
  const next = { ...c, days: c.days + 1, until: poolRunAfter(c.until + 864e5 - 3600e3) };
  await kv.set(clearUpKey(siteId), next); await logPool(siteId, `You added a day to the Clear-up`, 'you');
  return next;
}
/**
 * End a Clear-up (End now, or the evening run once it is due): the planner's plan for the day goes back on the controller, whatever
 * Autopilot's mode (starting a Clear-up was the owner's choice to come back to the planner), then Autopilot carries on as before.
 */
export async function endClearUp(siteId: string, settingsAll: Record<string, any>, rate: number | null, why: 'you' | 'done') {
  const c = await kv.get<ClearUp | null>(clearUpKey(siteId)); if (!c) return null;
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) }, snap = await readPool();
  const W = powerModel(await measuredPoints(siteId)), month = Number(localDay().slice(5, 7)) - 1, names = new Map(snap.circuits.map(x => [x.id, x.name]));
  const plan = planFor({ waterTemp: snap.bodies[0]?.temp ?? WATER_BY_MONTH[month], solarKw: await solarProfile(siteId), settings, W, rate, month, names });
  await applyPlan(siteId, plan, snap, settings);
  await kv.set(clearUpKey(siteId), null as any);
  await logPool(siteId, `${why === 'you' ? 'You ended the Clear-up' : 'Clear-up done'}: back to the planner, ${plan.hours} h at ${plan.rpm.toLocaleString()} RPM`, why === 'you' ? 'you' : undefined);
  return plan;
}
/** The evening run: a Clear-up whose end has come (within 10 minutes of it) is ended before Autopilot plans. */
export async function finishClearUpIfDue(siteId: string, settingsAll: Record<string, any>, rate: number | null, now = Date.now()) {
  const c = await kv.get<ClearUp | null>(clearUpKey(siteId));
  return c && c.until - 10 * 60_000 <= now ? endClearUp(siteId, settingsAll, rate, 'done') : null;
}

/* ---------- mockup w frame 7: the schedule editor ---------- */
export const EDIT_RUNS_MAX = 6;
/** The owner's Pool Autopilot mode, written where the routes keep it (single-owner kv settings; B2-10: atomically, and logged). */
export async function setPoolAutopilot(mode: 'off' | 'suggest' | 'auto', by = 'autopilot') {
  await patchSettings(['pool', 'autopilot'], mode, { by });
}
/** Programs compared by what they run when: circuit, start and stop (speeds can change from the circuit sheets or a boost). */
export const programKey = (xs: Array<{ circuitId: number; start: number; stop: number }>, circuits: number[]) =>
  JSON.stringify(xs.filter(x => circuits.includes(x.circuitId)).map(x => [x.circuitId, x.start, x.stop]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
type EditRun = { circuitId: number; start: number; stop: number };
/** Make what the controller runs now the baseline Autopilot compares against (an outside edit kept, or the owner choosing Auto again). */
export async function rebaseline(siteId: string, snap: PoolSnapshot, settings: Pick<PoolSettings, 'poolCircuit' | 'boostCircuit'>, by: 'controller' | 'auto') {
  const managed = [settings.poolCircuit, settings.boostCircuit], speeds = new Map((snap.pump?.circuits ?? []).map(c => [c.circuitId, c.speed]));
  const prev = await kv.get<any>(`${siteId}:pool:applied`) ?? { removed: [], added: [], previousSpeeds: [] };
  await kv.set(`${siteId}:pool:applied`, { ...prev, at: Date.now(), by, plan: { schedules: snap.schedules.filter(x => managed.includes(x.circuitId)).map(x => ({ circuitId: x.circuitId, start: x.start, stop: x.stop, rpm: speeds.get(x.circuitId) ?? 0 })) } });
}
/** Why an editor save is unusable, or null: up to six Pool or High Speed runs on 15-minute times (23:59 allowed as a stop), each with a length. */
export function scheduleError(b: any, s: Pick<PoolSettings, 'poolCircuit' | 'boostCircuit'>): string | null {
  const ok = [s.poolCircuit, s.boostCircuit], t = (m: unknown) => Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 1439;
  if (!Array.isArray(b?.schedules) || b.schedules.length > EDIT_RUNS_MAX) return `send up to ${EDIT_RUNS_MAX} runs`;
  for (const r of b.schedules) {
    if (!ok.includes(r?.circuitId)) return 'only the Pool and High Speed runs can be edited here';
    if (!t(r.start) || !t(r.stop) || r.start % 15 || (r.stop % 15 && r.stop !== 1439)) return 'run times are on the quarter hour';
    if (r.start === r.stop) return 'a run needs a start and a different stop';
  }
  if (b.speeds != null && (!Array.isArray(b.speeds) || b.speeds.some((x: any) => !ok.includes(x?.circuitId) || !Number.isInteger(x.rpm)))) return 'speeds are whole RPM for Pool or High Speed';
  return null;
}
/**
 * Save the owner's schedule (frame 7): Pool and High Speed programs replaced by `runs` (added before the old ones are removed, through
 * the guarded write), their speeds set, the result kept as the baseline Autopilot compares against, and Autopilot moved from Auto to
 * Suggest so the evening run offers its plan instead of writing over this one.
 */
export async function saveSchedule(siteId: string, b: { schedules: EditRun[]; speeds?: Array<{ circuitId: number; rpm: number }> }, settingsAll: Record<string, any>) {
  const settings: PoolSettings = { ...DEFAULTS, ...(settingsAll.pool ?? {}) }, snap = await readPool();
  if (!snap.pump) throw new Error('No pump found on the controller');
  const speeds = new Map(snap.pump.circuits.map(c => [c.circuitId, c.speed])); for (const x of b.speeds ?? []) speeds.set(x.circuitId, x.rpm);
  const managed = [settings.poolCircuit, settings.boostCircuit];
  const r = await guardedWrite(siteId, 'your schedule', { pumpId: snap.pump.id, speeds: (b.speeds ?? []).map(x => ({ circuitId: x.circuitId, rpm: x.rpm })), replaceCircuits: managed,
    schedules: b.schedules.map(x => ({ circuitId: x.circuitId, start: x.start, stop: x.stop })), guard: guardContext(snap) });
  const schedules = b.schedules.map(x => ({ ...x, rpm: speeds.get(x.circuitId) ?? 0 }));
  await kv.set(`${siteId}:pool:applied`, { at: Date.now(), by: 'you', plan: { schedules }, removed: r.removed, added: r.added, previousSpeeds: snap.pump.circuits.filter(c => managed.includes(c.circuitId)) });
  await kv.set(`${siteId}:pool:last`, null as any); await kv.set(`${siteId}:pool:pending`, null as any);
  const toSuggest = settings.autopilot === 'auto'; if (toSuggest) await setPoolAutopilot('suggest', 'your schedule');
  await logPool(siteId, `You saved the pump schedule (${b.schedules.length} run${b.schedules.length === 1 ? '' : 's'})${toSuggest ? '; Autopilot moved to Suggest' : ''}`, 'you');
  return schedules;
}

/** Why a turnover goal patch (frame 5's steppers) is unusable, or null: 1–4 turnovers a day in half steps, 0–3 whole skim hours. */
export function goalPatchError(b: any): string | null {
  if (!b || typeof b !== 'object') return 'send turnoverGoal and/or skimHours';
  if ('turnoverGoal' in b && !(typeof b.turnoverGoal === 'number' && b.turnoverGoal >= 1 && b.turnoverGoal <= 4 && Number.isInteger(b.turnoverGoal * 2))) return 'turnovers a day are 1–4, in half steps';
  if ('skimHours' in b && !(Number.isInteger(b.skimHours) && b.skimHours >= 0 && b.skimHours <= 3)) return 'the skim is 0–3 hours';
  if (!('turnoverGoal' in b) && !('skimHours' in b)) return 'send turnoverGoal and/or skimHours';
  return null;
}
/** A pool command that cannot reach the controller at all (no ScreenLogic credentials on this server): 503, not a hang. */
export class PoolUnavailable extends Error {}
/**
 * The owner's own pool command (mockup w): written and read back in one ScreenLogic session (writeOwnerPool), the confirmed reading
 * stored like any other (it counts toward the day's water), the run time remembered per circuit for the next tap in the grid
 * (kv `<site>:pool:runFor`), and a line in the pool activity log. A refusal is logged too, then rethrown.
 */
export async function poolCommand(siteId: string, cmd: PoolOwnerCommand, run?: Parameters<typeof writeOwnerPool>[1]) {
  if (!run && !configured()) throw new PoolUnavailable('The pool controller is not set up on this server');
  let snap: PoolSnapshot;
  try { snap = await writeOwnerPool(cmd, run); }
  catch (e) { if (e instanceof GuardRefusal) await logPool(siteId, `Refused your change: ${e.reason}`, 'refused'); throw e; }
  await recordReading(siteId, snap);
  if (cmd.kind === 'spaHeat') { await logPool(siteId, cmd.on ? `You set spa heat to ${cmd.setF}°` : 'You turned spa heat off', 'you'); return snap; }
  const name = snap.circuits.find(c => c.id === cmd.id)?.name.replace(/[<>&"'`]/g, '') ?? `Circuit ${cmd.id}`;
  if (cmd.kind === 'circuit') {
    // mockup ae: your Pool and High Speed runs feed the pool's learning (boosts by time of day, extra pump time)
    const ps: PoolSettings = { ...DEFAULTS, ...((await kv.get<Record<string, any>>('settings:owner'))?.pool ?? {}) };
    if (cmd.id === ps.poolCircuit || cmd.id === ps.boostCircuit) { if (cmd.on) await noteYouRun(siteId, { id: cmd.id, minutes: cmd.minutes!, boost: cmd.id === ps.boostCircuit }); else await endYouRun(siteId, cmd.id); }
    if (cmd.on) await kv.set(`${siteId}:pool:runFor`, { ...(await kv.get<Record<string, number>>(`${siteId}:pool:runFor`) ?? {}), [cmd.id]: cmd.minutes! });
    // when each circuit started from the app turns itself off (the Boost button's "time left"); gone once it is off
    const until = { ...(await kv.get<Record<string, number>>(`${siteId}:pool:until`) ?? {}) };
    if (cmd.on) until[cmd.id] = Date.now() + cmd.minutes! * 60_000; else delete until[cmd.id];
    await kv.set(`${siteId}:pool:until`, until);
  }
  const dur = (m: number) => m % 60 ? `${m} min` : `${m / 60} h`;
  await logPool(siteId, cmd.kind === 'speed' ? `You set ${name} to ${cmd.rpm.toLocaleString()} RPM` : cmd.on ? `You turned ${name} on for ${dur(cmd.minutes!)}` : `You turned ${name} off`, 'you');
  return snap;
}
/** writePoolPlan, with a guard refusal recorded in the pool activity log before it is rethrown. */
async function guardedWrite(siteId: string, what: string, opts: Parameters<typeof writePoolPlan>[0]) {
  try { return await writePoolPlan(opts); }
  catch (e) { if (e instanceof GuardRefusal) await logPool(siteId, `Refused ${what}: ${e.reason}`, 'refused'); throw e; }
}

/** A Solstice write that did not finish (kv `pool:writing`): set before the controller is touched, cleared when the write succeeded. */
export const writingKey = (siteId: string) => `${siteId}:pool:writing`;
export type PoolWriting = { at: number; what: string; schedules: Array<{ circuitId: number; start: number; stop: number; rpm: number }> };
export async function applyPlan(siteId: string, plan: Plan, snap: PoolSnapshot, settings: PoolSettings) {
  if (!snap.pump) throw new Error('No pump found on the controller');
  const w = planWrite(plan, snap, settings), replace = w.replaceCircuits;
  // the intent first: a write cut off part-way (a timeout, Vercel's limit) leaves old and new programs on the controller, which the
  // evening run must read as its own unfinished work and write again, never as an edit made outside Solstice (audit 10b, C-03)
  await kv.set(writingKey(siteId), { at: Date.now(), what: 'plan', schedules: plan.schedules.map(s => ({ circuitId: s.circuitId, start: s.start, stop: s.stop, rpm: s.rpm })) } satisfies PoolWriting);
  const r = await guardedWrite(siteId, 'a pool schedule write', w);
  const record = { at: Date.now(), plan: { start: plan.start, stop: plan.stop, boostAt: plan.boostAt, rpm: plan.rpm, boostHours: plan.boostHours, schedules: plan.schedules }, removed: r.removed, added: r.added,
    previousSpeeds: snap.pump.circuits.filter(c => replace.includes(c.circuitId)) };
  await kv.set(`${siteId}:pool:applied`, record);
  await kv.set(writingKey(siteId), null as any);
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
    // a guest's list (app.ts passes presenceHidden settings, which carry PRESENCE_FIXED for a guest view) never reads the controller
    const d = await poolDetail(siteId, settings, rate, { readOnly: !!settings[PRESENCE_FIXED as any] });
    return { id: 'pool', name: 'Pool pump', status: d.linked ? 'linked' : 'estimated', watts: d.live?.watts ?? null, kwhPerDay: d.current.kwhPerDay, savesPerMonth: d.current.costPerMonth != null && d.plan.costPerMonth != null ? Math.max(0, d.current.costPerMonth - d.plan.costPerMonth) : null };
  },
};
