// Pool Autopilot: re-plans tomorrow's pump schedule from live signals (water temperature, forecast, rain, heat, use, pollen),
// with guardrails. In "suggest" mode it stores the plan for the owner to approve; in "auto" it writes it to ScreenLogic itself.
import { q, kv } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { planFor, applyPlan, planWrite, type Plan, type PoolSettings } from './pool.js';
import type { PoolSnapshot } from './screenlogic.js';
import { siteLocation } from '../site.js';
import { guardPoolWrite } from './guards.js';

export type Mode = 'off' | 'suggest' | 'auto';
type Daily = { date: string; high: number; rainMm: number; rainPct: number; sunKwhM2: number; hourlySun: number[] };
export type Signals = { waterTemp: number; sunKwhM2: number; sunPct: number; high: number; heatDays: number; rainPct: number; rainMm: number; rainYesterdayMm: number; useDays: number; pollen: 'low' | 'medium' | 'high' };

/** Open-Meteo: 3 past days + 7 forecast days, daily and hourly sun. Cached for an hour. */
export async function forecast(): Promise<Daily[]> {
  const cached = await kv.get<{ at: number; days: Daily[] }>('pool:forecast');
  if (cached && Date.now() - cached.at < 3600_000) return cached.days;
  const loc = siteLocation(); if (!loc) throw new Error('SITE_LAT and SITE_LON are not set, so there is no forecast');
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=America%2FChicago&past_days=3&forecast_days=7&temperature_unit=fahrenheit` +
    `&daily=temperature_2m_max,precipitation_sum,precipitation_probability_max,shortwave_radiation_sum&hourly=shortwave_radiation`;
  const w = await fetch(u).then(r => r.json()) as any;
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
  if (o.heatDays >= 3) { hours += 2; why.push(`+2 h: day ${o.heatDays} of a heat wave (highs ≥ 95°F)`); }
  else if (o.day.high >= 95) { hours += 1; why.push('+1 h: high of ' + Math.round(o.day.high) + '°F'); }
  if (o.useYesterday) { hours += 1; why.push('+1 h: the pool was used yesterday'); }
  if (o.pollen === 'high') { boost = 1; why.push('skim boost: oak pollen season'); }
  if (o.waterTemp < 70 && hours > 4) { hours -= 1; why.push('−1 h: water below 70°F'); }
  if (o.day.sunKwhM2 < 3 && o.day.hourlySun.some(v => v > 0)) why.push('cloudy: the run follows the brightest hours');
  hours = Math.min(12, Math.max(4, hours));
  const plan = hours === base.hours && boost === base.boostHours ? base : planFor({ waterTemp: o.waterTemp, solarKw: o.day.hourlySun.map(v => v * 9.45 * .8), settings: o.settings, W: o.W, rate: o.rate, month: Number(o.day.date.slice(5, 7)) - 1, names: o.names, force: { hours, boost } });
  return { plan, why };
}

export type AutopilotState = { mode: Mode; nextRunAt: string; signals: Signals; tomorrow: { date: string; plan: Plan; why: string[] }; week: Array<{ date: string; hours: number; boost: number; sunKwhM2: number; rainPct: number; high: number }>; pending: boolean; log: Array<{ at: number; day: string; text: string; delta?: string }>; filterHours: number; filterCleanedOn: string | null };

export async function autopilot(siteId: string, o: { settings: PoolSettings; mode: Mode; W: (r: number) => number; rate: number | null; names: Map<number, string>; snap: PoolSnapshot | null; waterTemp: number; currentHours: number; act: boolean }): Promise<AutopilotState> {
  const days = await forecast(), today = localDay(), ti = days.findIndex(d => d.date === today);
  const use = await useDays(siteId), pollen = pollenFor(Number(today.slice(5, 7)) - 1); // Chicago month, not the host's
  const heatDaysAt = (i: number) => { let n = 0; for (let k = i; k >= 0 && days[k].high >= 95; k--) n++; return n; };
  const yesterdayUsed = !!(await q(`SELECT 1 FROM pool_readings WHERE site_id = $1 AND day = $2 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) c WHERE c = ANY(array['1','2','3','4','7'])) LIMIT 1`, [siteId, addDays(today, -1)])).length;
  const week = [], plans: Array<ReturnType<typeof planDay>> = [];
  for (let i = ti + 1; i < Math.min(days.length, ti + 8); i++) {
    const p = planDay({ day: days[i], prev: days[i - 1], heatDays: heatDaysAt(i), useYesterday: i === ti + 1 && yesterdayUsed, waterTemp: o.waterTemp, settings: o.settings, W: o.W, rate: o.rate, names: o.names, pollen });
    plans.push(p); week.push({ date: days[i].date, hours: p.plan.hours, boost: p.plan.boostHours, sunKwhM2: Math.round(days[i].sunKwhM2 * 10) / 10, rainPct: days[i].rainPct, high: Math.round(days[i].high) });
  }
  const tmr = days[ti + 1], tomorrow = { date: tmr.date, plan: plans[0].plan, why: plans[0].why };
  const signals: Signals = { waterTemp: o.waterTemp, sunKwhM2: Math.round(tmr.sunKwhM2 * 10) / 10, sunPct: Math.round(Math.min(1, tmr.sunKwhM2 / 8) * 100), high: Math.round(tmr.high), heatDays: heatDaysAt(ti + 1), rainPct: tmr.rainPct, rainMm: tmr.rainMm, rainYesterdayMm: days[ti - 1]?.rainMm ?? 0, useDays: use, pollen };
  const log = await kv.get<AutopilotState['log']>(`${siteId}:pool:autolog`) ?? [];
  const cleaned = await q<{ day: string }>(`SELECT day FROM events WHERE site_id = $1 AND type = 'filter_cleaned' ORDER BY day DESC LIMIT 1`, [siteId]);
  const since = cleaned[0]?.day ?? (log.at(-1)?.day ?? today), daysSince = Math.max(0, Math.round((Date.parse(today) - Date.parse(since)) / 864e5));
  let pending = false;
  if (o.act && o.mode !== 'off' && o.snap) {
    const applied = await kv.get<any>(`${siteId}:pool:applied`);
    const same = applied && applied.plan.start === tomorrow.plan.start && applied.plan.stop === tomorrow.plan.stop && applied.plan.boostAt === tomorrow.plan.boostAt;
    if (!same) {
      // the safety guard checks the exact write first (managed pump circuits only, never freeze/spa/lights/heater, RPM in range)
      const write = o.mode === 'auto' && o.snap.pump ? planWrite(tomorrow.plan, o.snap, o.settings) : null, g = write ? guardPoolWrite(write, write.guard) : null;
      if (g && !g.ok) log.unshift({ at: Date.now(), day: today, text: `Refused tomorrow's plan: ${g.reason}`, delta: 'refused' });
      else if (o.mode === 'auto') { await applyPlan(siteId, tomorrow.plan, o.snap, o.settings); log.unshift({ at: Date.now(), day: today, text: `Tomorrow: ${tomorrow.plan.hours} h at ${o.settings.filterRpm.toLocaleString()} RPM${tomorrow.plan.boostHours ? ' + skim boost' : ''}. ${tomorrow.why.join('; ') || 'season plan'}`, delta: `${tomorrow.plan.kwhPerDay} kWh` }); }
      else { pending = true; await kv.set(`${siteId}:pool:pending`, { date: tomorrow.date, plan: tomorrow.plan, why: tomorrow.why }); log.unshift({ at: Date.now(), day: today, text: `Suggested for tomorrow: ${tomorrow.plan.hours} h${tomorrow.plan.boostHours ? ' + boost' : ''}. ${tomorrow.why.join('; ') || 'season plan'}`, delta: 'waiting for you' }); }
      await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30));
    }
  } else pending = !!(await kv.get(`${siteId}:pool:pending`));
  const next = new Date(); next.setUTCHours(1, 15, 0, 0); if (next.getTime() < Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  return { mode: o.mode, nextRunAt: next.toISOString(), signals, tomorrow, week, pending, log, filterHours: Math.round(daysSince * o.currentHours), filterCleanedOn: cleaned[0]?.day ?? null };
}
