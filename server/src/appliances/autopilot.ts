// Pool Autopilot: re-plans tomorrow's pump schedule from live signals (water temperature, forecast, rain, heat, use, pollen),
// with guardrails. In "suggest" mode it stores the plan for the owner to approve; in "auto" it writes it to ScreenLogic itself.
import { q, kv } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { planFor, applyPlan, planWrite, setPoolAutopilot, programKey, rebaseline, writingKey, PUMP_HOURS_MAX, PUMP_HOURS_MIN, type Plan, type PoolSettings, type PoolWriting } from './pool.js';
import type { PoolSnapshot } from './screenlogic.js';
import { siteLocation } from '../site.js';
import { guardPoolWrite } from './guards.js';
import { logPoolPlan } from '../learn/hooks.js';
import { liveTrip } from '../vacation/trip.js';
import { poolTripDay, tripGoal, cloudyWater } from '../vacation/pool.js';

export type Mode = 'off' | 'suggest' | 'auto';
type Daily = { date: string; high: number; rainMm: number; rainPct: number; sunKwhM2: number; hourlySun: number[] };
export type Signals = { waterTemp: number; sunKwhM2: number; sunPct: number; high: number; heatDays: number; rainPct: number; rainMm: number; rainYesterdayMm: number; useDays: number; pollen: 'low' | 'medium' | 'high' };

/** A cached forecast this old is refetched; when Open-Meteo can't be reached it is still served up to FORECAST_STALE_MAX_MS (code review C-04). */
export const FORECAST_FRESH_MS = 3600_000;
export const FORECAST_STALE_MAX_MS = 12 * 3600_000;
export type ForecastAged = { days: Daily[]; stale: boolean; ageMs: number; error?: string };

/**
 * Open-Meteo: 3 past days + 7 forecast days, daily and hourly sun. Cached for an hour. When the fetch fails, the last cached
 * forecast is served while it is at most 12 hours old, marked `stale` with its age; older than that (or none, or no site
 * location) it throws.
 */
export async function forecastAged(): Promise<ForecastAged> {
  const cached = await kv.get<{ at: number; days: Daily[] }>('pool:forecast'), age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < FORECAST_FRESH_MS) return { days: cached.days, stale: false, ageMs: age };
  try { return { days: await fetchForecast(), stale: false, ageMs: 0 }; }
  catch (e: any) {
    if (cached && age <= FORECAST_STALE_MAX_MS) return { days: cached.days, stale: true, ageMs: age, error: String(e?.message ?? e) };
    throw e;
  }
}
/** The forecast days (forecastAged without the age). */
export async function forecast(): Promise<Daily[]> { return (await forecastAged()).days; }
async function fetchForecast(): Promise<Daily[]> {
  const loc = siteLocation(); if (!loc) throw new Error('SITE_LAT and SITE_LON are not set, so there is no forecast');
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=America%2FChicago&past_days=3&forecast_days=7&temperature_unit=fahrenheit` +
    `&daily=temperature_2m_max,precipitation_sum,precipitation_probability_max,shortwave_radiation_sum&hourly=shortwave_radiation`;
  const w = await fetch(u, { signal: AbortSignal.timeout(10_000) }).then(r => { if (!r.ok) throw new Error(`Open-Meteo: HTTP ${r.status}`); return r.json(); }) as any;
  const byDay: Record<string, number[]> = {};
  w.hourly.time.forEach((t: string, i: number) => { (byDay[t.slice(0, 10)] ??= Array(24).fill(0))[+t.slice(11, 13)] = (w.hourly.shortwave_radiation[i] ?? 0) / 1000; });
  const days: Daily[] = w.daily.time.map((d: string, i: number) => ({ date: d, high: w.daily.temperature_2m_max[i], rainMm: w.daily.precipitation_sum[i] ?? 0, rainPct: w.daily.precipitation_probability_max[i] ?? 0,
    sunKwhM2: (w.daily.shortwave_radiation_sum[i] ?? 0) / 3.6, hourlySun: byDay[d] ?? Array(24).fill(0) })); // MJ/m² → kWh/m²
  await kv.set('pool:forecast', { at: Date.now(), days });
  return days;
}

/** Days in the last week with the spa, jets, blower or lights seen on (a proxy for swimming). `circuits` holds numbers, so match on their text (`?|` only matches string elements). */
export async function useDays(siteId: string) {
  const r = await q<{ n: number }>(`SELECT COUNT(DISTINCT day)::int n FROM pool_readings WHERE site_id = $1 AND day >= $2 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) c WHERE c = ANY(array['1','2','3','4','7']))`, [siteId, addDays(localDay(), -7)]);
  return r[0]?.n ?? 0;
}
const pollenFor = (month: number): Signals['pollen'] => [2, 3].includes(month) ? 'high' : [1, 4, 11].includes(month) ? 'medium' : 'low';

/** One day's plan: the season plan, then the day's adjustments. Returns the plan and why. */
export function planDay(o: { day: Daily; prev?: Daily; heatDays: number; useYesterday: boolean; waterTemp: number; settings: PoolSettings; W: (r: number) => number; rate: number | null; names: Map<number, string>; pollen: Signals['pollen'] }) {
  const why: string[] = [];
  const base = planFor({ waterTemp: o.waterTemp, solarKw: o.day.hourlySun.map(v => v * 9.45 * .8), settings: o.settings, W: o.W, rate: o.rate, month: Number(o.day.date.slice(5, 7)) - 1, names: o.names });
  let hours = base.hours, boost = base.boostHours;
  const rainy = (o.prev?.rainMm ?? 0) >= 5 || (o.day.rainMm >= 5 && o.day.rainPct >= 60);
  if (rainy) { hours += 1; boost = 1; why.push(`+1 h and a skim boost: ${(o.prev?.rainMm ?? 0) >= 5 ? 'rain yesterday' : 'rain likely'} brings debris`); }
  if (o.waterTemp >= 85) { hours += 1; why.push(`+1 h: water at ${Math.round(o.waterTemp)}°F`); }
  if (o.heatDays >= 3) { hours += 2; why.push(`+2 h: day ${o.heatDays} of a heat wave (highs ≥ 95°F)`); }
  else if (o.day.high >= 95) { hours += 1; why.push('+1 h: high of ' + Math.round(o.day.high) + '°F'); }
  if (o.useYesterday) { hours += 1; why.push('+1 h: the pool was used yesterday'); }
  if (o.pollen === 'high') { boost = 1; why.push('skim boost: oak pollen season'); }
  if (o.waterTemp < 70 && hours > 4) { hours -= 1; why.push('−1 h: water below 70°F'); }
  if (o.day.sunKwhM2 < 3 && o.day.hourlySun.some(v => v > 0)) why.push('cloudy: the run follows the brightest hours');
  hours = Math.min(PUMP_HOURS_MAX + 4, Math.max(PUMP_HOURS_MIN, hours));   // the goal fills up to 12 h; heat, rain and use may add up to 4 more
  const plan = hours === base.hours && boost === base.boostHours ? base : planFor({ waterTemp: o.waterTemp, solarKw: o.day.hourlySun.map(v => v * 9.45 * .8), settings: o.settings, W: o.W, rate: o.rate, month: Number(o.day.date.slice(5, 7)) - 1, names: o.names, force: { hours, boost } });
  return { plan, why };
}

/**
 * A Vacation-mode trip day (mockup ak; vacation/pool.ts): the trip's turnover goal on the sunniest hours, no daily skim, and the rain
 * rule's extra hour and skim after heavy rain. Nobody swims and nobody's home, so the use, pollen and hot-water hours don't apply.
 */
export function tripPlanDay(o: { day: Daily; prev?: Daily; heatDays: number; waterTemp: number; settings: PoolSettings; W: (r: number) => number; rate: number | null; names: Map<number, string> }) {
  const g = tripGoal(o.waterTemp, o.heatDays), why = [...g.why], settings = { ...o.settings, turnoverGoal: g.goal, skimHours: 0 };
  const args = { waterTemp: o.waterTemp, solarKw: o.day.hourlySun.map(v => v * 9.45 * .8), settings, W: o.W, rate: o.rate, month: Number(o.day.date.slice(5, 7)) - 1, names: o.names };
  const base = planFor(args), rainy = (o.prev?.rainMm ?? 0) >= 5 || (o.day.rainMm >= 5 && o.day.rainPct >= 60);
  if (!rainy) return { plan: base, why };
  why.push(`+1 h and a skim boost: ${(o.prev?.rainMm ?? 0) >= 5 ? 'rain yesterday' : 'rain likely'} brings debris`);
  return { plan: planFor({ ...args, force: { hours: Math.min(PUMP_HOURS_MAX, base.hours + 1), boost: 1 } }), why };
}

export type AutopilotState = { mode: Mode; nextRunAt: string; signals: Signals; tomorrow: { date: string; plan: Plan; why: string[] };
  /** Guests never learn about a trip: a trip day also carries the plan as if the owner were home (`ifHome`, and `tomorrowIfHome` when tomorrow is one); redact.ts shows those instead. */
  tomorrowIfHome: { date: string; plan: Plan; why: string[] } | null;
  week: Array<{ date: string; hours: number; boost: number; sunKwhM2: number; rainPct: number; high: number; trip?: boolean; ifHome?: { hours: number; boost: number } }>;
  pending: boolean; log: Array<{ at: number; day: string; text: string; delta?: string }>; filterHours: number; filterCleanedOn: string | null };

export async function autopilot(siteId: string, o: { settings: PoolSettings; mode: Mode; W: (r: number) => number; rate: number | null; names: Map<number, string>; snap: PoolSnapshot | null; waterTemp: number; currentHours: number; act: boolean }): Promise<AutopilotState> {
  const days = await forecast(), today = localDay(), ti = days.findIndex(d => d.date === today);
  const use = await useDays(siteId), pollen = pollenFor(Number(today.slice(5, 7)) - 1); // Chicago month, not the host's
  const heatDaysAt = (i: number) => { let n = 0; for (let k = i; k >= 0 && days[k].high >= 95; k--) n++; return n; };
  const yesterdayUsed = !!(await q(`SELECT 1 FROM pool_readings WHERE site_id = $1 AND day = $2 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) c WHERE c = ANY(array['1','2','3','4','7'])) LIMIT 1`, [siteId, addDays(today, -1)])).length;
  const week: AutopilotState['week'] = [], plans: Array<ReturnType<typeof planDay>> = [], homes: Array<ReturnType<typeof planDay> | null> = [];
  // Vacation mode: trip days get the trip plan, unless the last water test wasn't clear (then the normal plan, and why)
  const trip = await liveTrip(siteId), cloudy = trip ? await cloudyWater(siteId) : null;
  for (let i = ti + 1; i < Math.min(days.length, ti + 8); i++) {
    const tripDay = poolTripDay(trip, days[i].date), args = { day: days[i], prev: days[i - 1], heatDays: heatDaysAt(i), waterTemp: o.waterTemp, settings: o.settings, W: o.W, rate: o.rate, names: o.names };
    const p = tripDay && !cloudy ? tripPlanDay(args) : planDay({ ...args, useYesterday: i === ti + 1 && yesterdayUsed && !tripDay, pollen });
    if (tripDay && cloudy) p.why.unshift(`Vacation: the trip plan waits because your last water test said ${cloudy}`);
    // the plan as if nobody were travelling, for the guest view (a trip must never show; audit 10b S-01)
    const home = tripDay ? planDay({ ...args, useYesterday: false, pollen }) : null;
    plans.push(p); homes.push(home);
    week.push({ date: days[i].date, hours: p.plan.hours, boost: p.plan.boostHours, sunKwhM2: Math.round(days[i].sunKwhM2 * 10) / 10, rainPct: days[i].rainPct, high: Math.round(days[i].high),
      ...(tripDay ? { trip: true, ifHome: { hours: home!.plan.hours, boost: home!.plan.boostHours } } : {}) });
  }
  const tmr = days[ti + 1], tomorrow = { date: tmr.date, plan: plans[0].plan, why: plans[0].why };
  const tomorrowIfHome = homes[0] ? { date: tmr.date, plan: homes[0].plan, why: homes[0].why } : null;
  const signals: Signals = { waterTemp: o.waterTemp, sunKwhM2: Math.round(tmr.sunKwhM2 * 10) / 10, sunPct: Math.round(Math.min(1, tmr.sunKwhM2 / 8) * 100), high: Math.round(tmr.high), heatDays: heatDaysAt(ti + 1), rainPct: tmr.rainPct, rainMm: tmr.rainMm, rainYesterdayMm: days[ti - 1]?.rainMm ?? 0, useDays: use, pollen };
  if (o.act) await logPoolPlan(siteId, { mode: o.mode, date: tomorrow.date, plan: tomorrow.plan, signals, settings: o.settings }); // learning layer: tomorrow's kWh
  const log = await kv.get<AutopilotState['log']>(`${siteId}:pool:autolog`) ?? [];
  const cleaned = await q<{ day: string }>(`SELECT day FROM events WHERE site_id = $1 AND type = 'filter_cleaned' ORDER BY day DESC LIMIT 1`, [siteId]);
  const since = cleaned[0]?.day ?? (log.at(-1)?.day ?? today), daysSince = Math.max(0, Math.round((Date.parse(today) - Date.parse(since)) / 864e5));
  let pending = false;
  // a Clear-up holds the controller's programs until it ends (frame 6): no write and no suggestion while it runs, whatever the mode
  const clearUp = await kv.get<{ until: number } | null>(`${siteId}:pool:clearup`), held = !!clearUp && clearUp.until > Date.now();
  // frame 7: an edit made outside Solstice (the Pentair app) is kept. In Auto, programs on the controller that differ in time from the
  // last write mean someone changed them: Autopilot moves to Suggest, makes that schedule the baseline, and offers its plan instead
  let mode = o.mode;
  // a Solstice write that was cut off (pool.ts writingKey) left old and new programs on the controller: that is unfinished work to redo,
  // not an outside edit, so the mode stays and the plan is written again below (audit 10b, C-02/C-03)
  const writing = o.act ? await kv.get<PoolWriting | null>(writingKey(siteId)) : null;
  if (writing && o.act && o.snap && !held) { log.unshift({ at: Date.now(), day: today, text: 'The last schedule write didn’t finish, so Solstice writes the plan again', delta: 'retry' }); await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30)); }
  if (o.act && mode === 'auto' && o.snap && !held && !writing) {
    const applied = await kv.get<any>(`${siteId}:pool:applied`), managed = [o.settings.poolCircuit, o.settings.boostCircuit];
    if (applied?.plan?.schedules && programKey(o.snap.schedules, managed) !== programKey(applied.plan.schedules, managed)) {
      mode = 'suggest'; await setPoolAutopilot('suggest', 'outside edit'); await rebaseline(siteId, o.snap, o.settings, 'controller');
      log.unshift({ at: Date.now(), day: today, text: 'The pump schedule was changed outside Solstice, so it stays; Autopilot moved to Suggest', delta: 'kept' });
      await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30));
    }
  }
  if (o.act && mode !== 'off' && o.snap && !held) {
    const applied = await kv.get<any>(`${siteId}:pool:applied`);
    // the same programs (circuit, start, stop and speed) as the last write: nothing to send (records from before the planner carry them too)
    const key = (xs: Array<{ circuitId: number; start: number; stop: number; rpm: number }> = []) => JSON.stringify(xs.map(x => [x.circuitId, x.start, x.stop, x.rpm]));
    const same = !writing && !!applied && key(applied.plan.schedules) === key(tomorrow.plan.schedules);   // an unfinished write is never "the same"
    if (!same) {
      // the safety guard checks the exact write first (managed pump circuits only, never freeze/spa/lights/heater, RPM in range)
      const write = mode === 'auto' && o.snap.pump ? planWrite(tomorrow.plan, o.snap, o.settings) : null, g = write ? guardPoolWrite(write, write.guard) : null;
      if (g && !g.ok) log.unshift({ at: Date.now(), day: today, text: `Refused tomorrow's plan: ${g.reason}`, delta: 'refused' });
      else if (mode === 'auto') { await applyPlan(siteId, tomorrow.plan, o.snap, o.settings); log.unshift({ at: Date.now(), day: today, text: `Tomorrow: ${tomorrow.plan.hours} h at ${tomorrow.plan.rpm.toLocaleString()} RPM${tomorrow.plan.boostHours ? ` + ${tomorrow.plan.boostHours} h skim` : ''}, ${tomorrow.plan.turnovers}× turnover. ${tomorrow.why.join('; ') || 'season plan'}`, delta: `${tomorrow.plan.kwhPerDay} kWh` }); }
      else { pending = true; await kv.set(`${siteId}:pool:pending`, { date: tomorrow.date, plan: tomorrow.plan, why: tomorrow.why }); log.unshift({ at: Date.now(), day: today, text: `Suggested for tomorrow: ${tomorrow.plan.hours} h${tomorrow.plan.boostHours ? ' + boost' : ''}. ${tomorrow.why.join('; ') || 'season plan'}`, delta: 'waiting for you' }); }
      await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30));
    }
  } else pending = !!(await kv.get(`${siteId}:pool:pending`));
  const next = new Date(); next.setUTCHours(1, 15, 0, 0); if (next.getTime() < Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  return { mode, nextRunAt: next.toISOString(), signals, tomorrow, tomorrowIfHome, week, pending, log, filterHours: Math.round(daysSince * o.currentHours), filterCleanedOn: cleaned[0]?.day ?? null };
}
