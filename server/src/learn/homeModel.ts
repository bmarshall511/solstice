// Home use from the forecast high (mockup ah). The 48-hour forecast used the last 14 days' average hour by hour, so a cool week was
// forecast like the hot week before it. Each day's total is now a line fitted to the last 14 days' use against each day's high
// (kWh = a + b × degrees above 70°F); the hours keep the 14-day shape, scaled to that total. Backtested on 197 days of Open-Meteo's
// archived day-ahead weather: ±11.8 → ±9.8 kWh a day. Pure pieces here; homeForecast reads the database and the cached weather.
import { q, kv, hourWh } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { WX_KEY, type Wx } from './wx.js';
import { tripDays } from '../vacation/trip.js';

export const BASE_F = 70, FIT_DAYS = 14, MIN_DAYS = 10, MIN_SPREAD = 6, SCALE_MIN = .5, SCALE_MAX = 1.5;
export type HomePoint = { day: string; high: number; kwh: number };
export type HomeFit = { a: number; b: number; n: number; points: HomePoint[] };
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Each day's high (°F) in the weather payload: the past days Open-Meteo has, today and the forecast days. */
export const highsOf = (w: Pick<Wx, 'daily'> | null): Record<string, number> =>
  Object.fromEntries((w?.daily?.time ?? []).map((d, i) => [d, w!.daily.temperature_2m_max[i]]).filter(([, v]) => typeof v === 'number'));

/** The last 14 complete days before `today` (23 hours or more) with their home kWh and high. */
export function homePoints(hourly: ReadonlyArray<{ day: string; hour: number; home: number }>, highs: Record<string, number>, today: string): HomePoint[] {
  const lo = addDays(today, -FIT_DAYS), by = new Map<string, { kwh: number; n: number }>();
  for (const r of hourly) if (r.day >= lo && r.day < today) { const x = by.get(r.day) ?? { kwh: 0, n: 0 }; x.kwh += r.home; x.n++; by.set(r.day, x); }
  return [...by].filter(([day, x]) => x.n >= 23 && highs[day] != null).map(([day, x]) => ({ day, high: highs[day], kwh: r2(x.kwh) })).sort((a, b) => a.day.localeCompare(b.day));
}

/** Least squares kWh = a + b·max(0, high − 70) over the points; null with fewer than 10 days or highs within 6° of each other. */
export function fitHome(points: HomePoint[]): HomeFit | null {
  if (points.length < MIN_DAYS) return null;
  const hs = points.map(p => p.high); if (Math.max(...hs) - Math.min(...hs) < MIN_SPREAD) return null;
  const xs = points.map(p => Math.max(0, p.high - BASE_F)), ys = points.map(p => p.kwh), n = points.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n, sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
  let b = sxx ? xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / sxx : 0;
  if (b < 0) b = 0;   // a hotter day never uses less: fall back to the average
  return { a: r2(my - b * mx), b: r2(b), n, points };
}
export const homeKwh = (f: Pick<HomeFit, 'a' | 'b'>, high: number) => f.a + f.b * Math.max(0, high - BASE_F);

/**
 * How much to scale the 14-day hourly profile on each day with a known high: the fitted total over the profile's total, kept to
 * 0.5–1.5. Days without a high (or no fit) are left out, so the forecast uses the profile as before.
 */
export function dayScales(fit: HomeFit | null, profile: number[], highs: Record<string, number>, days: string[]): Record<string, number> {
  const sum = profile.reduce((s, v) => s + v, 0); if (!fit || sum <= 0) return {};
  return Object.fromEntries(days.filter(d => highs[d] != null).map(d => [d, r2(Math.max(SCALE_MIN, Math.min(SCALE_MAX, homeKwh(fit, highs[d]) / sum)))]));
}
/** Today and the next three days, the window any 48-hour forecast started today can reach. */
export const forecastDays = (today: string) => [0, 1, 2, 3].map(i => addDays(today, i));

/**
 * For the app (GET /api/profile, the outage view, the model report): the fit, the per-day scales, tomorrow's estimate and a check of
 * the last 4 days (old = the 14-day average before each day, new = the fit on the 14 days before it at that day's high).
 */
export async function homeForecast(siteId: string, now = Date.now()) {
  // the weather the learning layer already cached (wx.ts, refreshed by the nightly job and the reserve rule): a request never fetches Open-Meteo
  const today = localDay(new Date(now)), w = (await kv.get<{ at: number; w: Wx }>(WX_KEY))?.w ?? null, highs = highsOf(w);
  const hourlyAll = await q<{ day: string; hour: number; home: number }>(`SELECT day, hour::int, (${hourWh('home_wh')} / 1000.0)::float8 home FROM energy
    WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour`, [siteId, addDays(today, -(FIT_DAYS + 5)), today]);
  // mockup ak: trip days are left out of the profile and the fit (an empty house says nothing about a day at home)
  const trips = await tripDays(siteId, addDays(today, -(FIT_DAYS + 5)), today, now), hourly = hourlyAll.filter(r => !trips.has(r.day));
  const sums = new Map<number, number>(), lo = addDays(today, -FIT_DAYS), n = Math.max(1, FIT_DAYS - [...trips].filter(d => d >= lo && d < today).length);
  for (const r of hourly) if (r.day >= lo) sums.set(r.hour, (sums.get(r.hour) ?? 0) + r.home);
  const profile = Array.from({ length: 24 }, (_, h) => sums.has(h) ? sums.get(h)! / n : 2);   // nightly.ts fc48Inputs: the same profile
  const fit = fitHome(homePoints(hourly, highs, today)), tomorrow = addDays(today, 1);
  const check = [4, 3, 2, 1].map(i => addDays(today, -i)).flatMap(day => {
    const pts = homePoints(hourly, highs, day), f = fitHome(pts), own = homePoints(hourly, highs, addDays(day, 1)).find(p => p.day === day);
    if (!own || !pts.length) return [];
    return [{ day, high: own.high, used: own.kwh, old: r2(pts.reduce((s, p) => s + p.kwh, 0) / pts.length), new: f ? r2(homeKwh(f, own.high)) : null }];
  });
  return { fit, scale: dayScales(fit, profile, highs, forecastDays(today)),
    tomorrow: fit && highs[tomorrow] != null ? { day: tomorrow, high: highs[tomorrow], kwh: r2(homeKwh(fit, highs[tomorrow])) } : null, check };
}
