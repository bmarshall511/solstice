// Home use from the weather (mockup ah; B2-8 heating season, audit L-09 / D4, idea I-01). The 48-hour forecast used the last 14
// days' average hour by hour, so a cool week was forecast like the hot week before it. Each day's total is now
//   kWh = a + b·max(0, high − Tc) + c·max(0, Th − low)
// The slopes b, c and the change points Tc, Th (a coarse grid, 55–75 °F, by least squares) are fitted nightly on up to 365 days of
// daily home totals with each day's archived high and low (Open-Meteo archive, one pull a day, kv `wx:hilo`), trip days and
// Clear-up days left out; the level `a` is refitted on the last 14 days, so recent days set how the house is lived in and the year
// sets how it answers the weather. Before a year fit exists (or without temperatures) it is the 14-day line of mockup ah,
// kWh = a + b·max(0, high − 70). The hours keep the 14-day shape, scaled to that total. Pure pieces here; homeForecast reads the
// database and the cached weather, the nightly job (learn/nightly.ts) fits the year and keeps it in kv `<site>:learn:home`.
import { q, kv, hourWh } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { WX_KEY, tempsOf, type Wx } from './wx.js';
import { tripDays } from '../vacation/trip.js';
import { siteLocation } from '../site.js';
import { learnStats } from './store.js';

export const BASE_F = 70, FIT_DAYS = 14, MIN_DAYS = 10, MIN_SPREAD = 6, SCALE_MIN = .5, SCALE_MAX = 1.5;
/** B2-8: a strip-heat day can double the profile, so a day with a heating term may scale to 2×. */
export const SCALE_MAX_HEAT = 2;
/** B2-8: the year fit: up to 365 days, at least 30 spanning 10 °F of highs; a term needs 5 days where it is non-zero; the level needs 5 of the last 14. */
export const YEAR_DAYS = 365, YEAR_MIN_DAYS = 30, YEAR_MIN_SPREAD = 10, TERM_MIN_DAYS = 5, LEVEL_MIN_DAYS = 5;
export const GRID_F = [55, 57.5, 60, 62.5, 65, 67.5, 70, 72.5, 75];
export type Temp = { high: number; low: number | null };
export type HomePoint = { day: string; high: number; low?: number | null; kwh: number };
/** The nightly year fit (kv `<site>:learn:home`): slopes, change points, the year's own level, and what it was fitted on. */
export type HomeSlopes = { day: string; a: number; b: number; c: number; tc: number; th: number; n: number; heatDays: number; from: string; to: string; rmse: number };
export type HomeFit = { a: number; b: number; c: number; tc: number; th: number; n: number; points: HomePoint[];
  /** B2-8: the year fit the slopes come from; absent for the 14-day line. */
  year?: { n: number; heatDays: number; from: string; to: string; rmse: number; a: number } };
const r2 = (v: number) => Math.round(v * 100) / 100;
const tempOf = (v: number | Temp | undefined): Temp | null => v == null ? null : typeof v === 'number' ? { high: v, low: null } : v;
export const homeSlopesKey = (siteId: string) => `${siteId}:learn:home`;

/** Each day's high (°F) in the weather payload: the past days Open-Meteo has, today and the forecast days. */
export const highsOf = (w: Pick<Wx, 'daily'> | null): Record<string, number> =>
  Object.fromEntries((w?.daily?.time ?? []).map((d, i) => [d, w!.daily.temperature_2m_max[i]]).filter(([, v]) => typeof v === 'number'));

/**
 * The last 14 complete days before `today` (23 hours or more) with their home kWh, high and low (B2-8: `temps` may give just a high).
 * `exclude`: days left out (a Clear-up; trip days are taken out of `hourly` by the callers).
 */
export function homePoints(hourly: ReadonlyArray<{ day: string; hour: number; home: number }>, temps: Record<string, number | Temp>, today: string, exclude?: ReadonlySet<string>): HomePoint[] {
  const lo = addDays(today, -FIT_DAYS), by = new Map<string, { kwh: number; n: number }>();
  for (const r of hourly) if (r.day >= lo && r.day < today && !exclude?.has(r.day)) { const x = by.get(r.day) ?? { kwh: 0, n: 0 }; x.kwh += r.home; x.n++; by.set(r.day, x); }
  return [...by].filter(([day, x]) => x.n >= 23 && temps[day] != null).map(([day, x]) => {
    const t = tempOf(temps[day])!;
    return t.low != null ? { day, high: t.high, low: t.low, kwh: r2(x.kwh) } : { day, high: t.high, kwh: r2(x.kwh) };
  }).sort((a, b) => a.day.localeCompare(b.day));
}

/** Least squares kWh = a + b·max(0, high − 70) over the points; null with fewer than 10 days or highs within 6° of each other. */
export function fitHome(points: HomePoint[]): HomeFit | null {
  if (points.length < MIN_DAYS) return null;
  const hs = points.map(p => p.high); if (Math.max(...hs) - Math.min(...hs) < MIN_SPREAD) return null;
  const xs = points.map(p => Math.max(0, p.high - BASE_F)), ys = points.map(p => p.kwh), n = points.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n, sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
  let b = sxx ? xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / sxx : 0;
  if (b < 0) b = 0;   // a hotter day never uses less: fall back to the average
  return { a: r2(my - b * mx), b: r2(b), c: 0, tc: BASE_F, th: BASE_F, n, points };
}
/** A day's kWh from the fit; the heating term only when the day's low is known. */
export const homeKwh = (f: Pick<HomeFit, 'a' | 'b'> & Partial<Pick<HomeFit, 'c' | 'tc' | 'th'>>, high: number, low?: number | null) =>
  f.a + f.b * Math.max(0, high - (f.tc ?? BASE_F)) + (f.c && low != null ? f.c * Math.max(0, (f.th ?? BASE_F) - low) : 0);

/** Least squares for y = X·β (normal equations, Gaussian elimination); null when singular. */
function ols(X: number[][], y: number[]): number[] | null {
  const k = X[0].length, A = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) => j < k ? X.reduce((s, r) => s + r[i] * r[j], 0) : X.reduce((s, r, n) => s + r[i] * y[n], 0)));
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r, i) => r[k] / r[i]);
}

/**
 * B2-8: the year fit. Every (Tc, Th) on the 55–75 °F grid, and for each the four nested lines (both terms, cooling only, heating only,
 * level only; a term needs 5 days where it is non-zero), solved by least squares; a line with b < 0 or c < 0 is not allowed (a hotter
 * day never uses less, nor a colder one). The smallest squared error wins; ties keep the first. Needs 30 days with a low whose highs
 * span 10 °F. c = 0 means the year shows no heating (Th is then meaningless).
 */
export function fitYear(points: ReadonlyArray<HomePoint>): Omit<HomeSlopes, 'day'> | null {
  const pts = points.filter((p): p is HomePoint & { low: number } => p.low != null && Number.isFinite(p.kwh));
  if (pts.length < YEAR_MIN_DAYS) return null;
  const hs = pts.map(p => p.high); if (Math.max(...hs) - Math.min(...hs) < YEAR_MIN_SPREAD) return null;
  const y = pts.map(p => p.kwh), n = pts.length;
  let best: { sse: number; a: number; b: number; c: number; tc: number; th: number } | null = null;
  for (const tc of GRID_F) for (const th of GRID_F) {
    const x1 = pts.map(p => Math.max(0, p.high - tc)), x2 = pts.map(p => Math.max(0, th - p.low));
    const use1 = x1.filter(v => v > 0).length >= TERM_MIN_DAYS, use2 = x2.filter(v => v > 0).length >= TERM_MIN_DAYS;
    for (const [u1, u2] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      if ((u1 && !use1) || (u2 && !use2)) continue;
      const X = pts.map((_, i) => [1, ...(u1 ? [x1[i]] : []), ...(u2 ? [x2[i]] : [])]), beta = ols(X, y); if (!beta) continue;
      const a = beta[0], b = u1 ? beta[1] : 0, c = u2 ? beta[u1 ? 2 : 1] : 0;
      if (b < 0 || c < 0) continue;
      const sse = y.reduce((s, v, i) => s + (v - a - b * x1[i] - c * x2[i]) ** 2, 0);
      if (!best || sse < best.sse - 1e-9) best = { sse, a, b, c, tc, th };
    }
  }
  if (!best) return null;
  const days = pts.map(p => p.day).sort();
  return { a: r2(best.a), b: r2(best.b), c: r2(best.c), tc: best.tc, th: best.th, n,
    heatDays: best.c > 0 ? pts.filter(p => p.low < best!.th).length : 0, from: days[0], to: days[days.length - 1], rmse: r2(Math.sqrt(best.sse / n)) };
}

/**
 * B2-8: the model a forecast uses. With a year fit: its slopes and change points, the level refitted on the recent points (the mean of
 * kWh − the weather terms; the year's own level with fewer than 5). Without one: the 14-day line (fitHome).
 */
export function modelFor(slopes: HomeSlopes | null | undefined, recent: HomePoint[]): HomeFit | null {
  if (!slopes) return fitHome(recent);
  const pts = recent.filter(p => slopes.c === 0 || p.low != null);
  const a = pts.length >= LEVEL_MIN_DAYS ? pts.reduce((s, p) => s + p.kwh - homeKwh({ ...slopes, a: 0 }, p.high, p.low), 0) / pts.length : slopes.a;
  return { a: r2(a), b: slopes.b, c: slopes.c, tc: slopes.tc, th: slopes.th, n: pts.length >= LEVEL_MIN_DAYS ? pts.length : 0, points: recent,
    year: { n: slopes.n, heatDays: slopes.heatDays, from: slopes.from, to: slopes.to, rmse: slopes.rmse, a: slopes.a } };
}

/**
 * How much to scale the 14-day hourly profile on each day with a known high: the modelled total over the profile's total, kept to
 * 0.5–1.5 (2 on a day with a heating term, B2-8). Days without a high (or no fit) are left out, so the forecast uses the profile as before.
 */
export function dayScales(fit: HomeFit | null, profile: number[], temps: Record<string, number | Temp>, days: string[]): Record<string, number> {
  const sum = profile.reduce((s, v) => s + v, 0); if (!fit || sum <= 0) return {};
  return Object.fromEntries(days.filter(d => temps[d] != null).map(d => {
    const t = tempOf(temps[d])!, heat = !!fit.c && t.low != null && t.low < fit.th;
    return [d, r2(Math.max(SCALE_MIN, Math.min(heat ? SCALE_MAX_HEAT : SCALE_MAX, homeKwh(fit, t.high, t.low) / sum)))];
  }));
}
/** Today and the next three days, the window any 48-hour forecast started today can reach. */
export const forecastDays = (today: string) => [0, 1, 2, 3].map(i => addDays(today, i));

/** The days of the current or last Clear-up (kv `<site>:pool:clearup`, the pump on all day) up to today: left out of the home fits. */
export function clearUpDays(cu: { startedAt: number; until: number } | null | undefined, now: number): Set<string> {
  const out = new Set<string>(); if (!cu?.startedAt) return out;
  for (let x = localDay(new Date(cu.startedAt)), end = localDay(new Date(Math.min(cu.until, now))); x <= end; x = addDays(x, 1)) out.add(x);
  return out;
}

/** The year fit's points: complete days with a high and a low, trip days, Clear-up days and days the pool ran beyond its plan left out. */
export function yearPoints(daily: ReadonlyArray<{ day: string; kwh: number; complete: boolean }>, temps: Record<string, Temp>, exclude: ReadonlySet<string>): HomePoint[] {
  return daily.filter(r => r.complete && !exclude.has(r.day) && temps[r.day]?.low != null)
    .map(r => ({ day: r.day, high: temps[r.day].high, low: temps[r.day].low, kwh: r2(r.kwh) })).sort((a, b) => a.day.localeCompare(b.day));
}

/* ---------- the archived highs and lows (one Open-Meteo archive pull a day, kv `wx:hilo`) ---------- */
export const HILO_KEY = 'wx:hilo';
type HiLo = { day: string; at: number; byDay: Record<string, [number, number]> };
const unpack = (byDay: Record<string, [number, number]>): Record<string, Temp> => Object.fromEntries(Object.entries(byDay).map(([d, [high, low]]) => [d, { high, low }]));
/**
 * B2-8: each day's high and low (°F) for the last 370 days from the Open-Meteo archive, pulled once per local day and cached in kv
 * (no location in the cache: dates and temperatures only). The archive lags a few days; the nightly fills those from the forecast
 * payload's past days. Without a location, or when the pull fails, the last cache (or nothing).
 */
export async function wxHiLo(now = Date.now()): Promise<Record<string, Temp>> {
  learnStats.queries++;
  const today = localDay(new Date(now)), c = await kv.get<HiLo>(HILO_KEY);
  if (c?.day === today) return unpack(c.byDay);
  const loc = siteLocation(); if (!loc) return unpack(c?.byDay ?? {});
  try {
    const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${addDays(today, -(YEAR_DAYS + 5))}&end_date=${addDays(today, -1)}` +
      '&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=America%2FChicago';
    const j = await fetch(u, { signal: AbortSignal.timeout(10_000) }).then(r => { if (!r.ok) throw new Error(`Open-Meteo archive: HTTP ${r.status}`); return r.json(); }) as
      { daily?: { time?: string[]; temperature_2m_max?: Array<number | null>; temperature_2m_min?: Array<number | null> } };
    const byDay: Record<string, [number, number]> = {};
    (j.daily?.time ?? []).forEach((d, i) => { const hi = j.daily?.temperature_2m_max?.[i], lo = j.daily?.temperature_2m_min?.[i]; if (typeof hi === 'number' && typeof lo === 'number') byDay[d] = [hi, lo]; });
    if (!Object.keys(byDay).length) throw new Error('Open-Meteo archive returned no days');
    learnStats.queries++;
    await kv.set(HILO_KEY, { day: today, at: now, byDay } satisfies HiLo);
    return unpack(byDay);
  } catch (e) { console.warn(`[learn] ${(e as Error).message}`); return unpack(c?.byDay ?? {}); }
}

/**
 * For the app (GET /api/profile, the outage view, the model report): the fit, the per-day scales, tomorrow's estimate and a check of
 * the last 4 days (old = the 14-day average before each day, new = the model on the 14 days before it at that day's weather).
 */
export async function homeForecast(siteId: string, now = Date.now()) {
  // the weather the learning layer already cached (wx.ts, refreshed by the nightly job and the reserve rule) and the nightly's year
  // fit: a request never fetches Open-Meteo
  const today = localDay(new Date(now));
  const [wc, slopes, cu] = await Promise.all([kv.get<{ at: number; w: Wx }>(WX_KEY), kv.get<HomeSlopes>(homeSlopesKey(siteId)), kv.get<{ startedAt: number; until: number } | null>(`${siteId}:pool:clearup`)]);
  const temps = tempsOf(wc?.w ?? null), exclude = clearUpDays(cu, now);
  const hourlyAll = await q<{ day: string; hour: number; home: number }>(`SELECT day, hour::int, (${hourWh('home_wh')} / 1000.0)::float8 home FROM energy
    WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour`, [siteId, addDays(today, -(FIT_DAYS + 5)), today]);
  // mockup ak: trip days are left out of the profile and the fit (an empty house says nothing about a day at home)
  const trips = await tripDays(siteId, addDays(today, -(FIT_DAYS + 5)), today, now), hourly = hourlyAll.filter(r => !trips.has(r.day));
  const sums = new Map<number, number>(), lo = addDays(today, -FIT_DAYS), n = Math.max(1, FIT_DAYS - [...trips].filter(d => d >= lo && d < today).length);
  for (const r of hourly) if (r.day >= lo) sums.set(r.hour, (sums.get(r.hour) ?? 0) + r.home);
  const profile = Array.from({ length: 24 }, (_, h) => sums.has(h) ? sums.get(h)! / n : 2);   // nightly.ts fc48Inputs: the same profile
  const fit = modelFor(slopes, homePoints(hourly, temps, today, exclude)), tomorrow = addDays(today, 1), tt = temps[tomorrow];
  const check = [4, 3, 2, 1].map(i => addDays(today, -i)).flatMap(day => {
    const pts = homePoints(hourly, temps, day, exclude), f = modelFor(slopes, pts), own = homePoints(hourly, temps, addDays(day, 1), exclude).find(p => p.day === day);
    if (!own || !pts.length) return [];
    return [{ day, high: own.high, used: own.kwh, old: r2(pts.reduce((s, p) => s + p.kwh, 0) / pts.length), new: f ? r2(homeKwh(f, own.high, own.low)) : null }];
  });
  return { fit, scale: dayScales(fit, profile, temps, forecastDays(today)), today: temps[today] ?? null,
    tomorrow: fit && tt ? { day: tomorrow, high: tt.high, low: tt.low, kwh: r2(homeKwh(fit, tt.high, tt.low)) } : null, check };
}
