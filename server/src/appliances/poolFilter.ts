// B2-6 (audit L-02, ideas I-07): when the D.E. filter will want cleaning. A loading filter makes the pump move less water at the
// same speed, so its watts at the filter RPM drift down; the nightly pump rule calls 88% of the clean-filter baseline "moving less
// water" (learn/rules.ts). This fits a straight line through the daily median watts at the filter RPM over the last 14 days (from
// the last "I cleaned the filter", if that is later) and projects the day the line crosses 88% of the baseline. Read-only.
import { q, kv } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { PUMP_RUNNING_SQL } from './pool.js';

export const FILTER_DAYS = 14, FILTER_MIN_POINTS = 7, FILTER_LOADED = .88, FILTER_R2_LEARNED = .6, FILTER_MIN_READS = 3, FILTER_HORIZON_DAYS = 365;
export type FilterForecast = { rpm: number | null; baselineW: number | null; thresholdW: number | null; points: number; slopeWPerDay: number | null; r2: number | null;
  forecastDay: string | null; conf: 'learned' | 'estimated' | 'learning'; cleanedOn: string | null };

const r = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const gap = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

/**
 * The fit, pure. `points`: one per day, the median watts at the filter RPM. forecastDay is null with fewer than 7 points, without a
 * baseline, or when the line isn't falling (or crosses more than a year out); today when the line is already at or below the threshold.
 * conf: 'learning' under 7 points, else 'learned' when the line explains 60% or more of the day-to-day spread (R²), else 'estimated'.
 */
export function filterFit(points: ReadonlyArray<{ day: string; w: number }>, baselineW: number | null, today: string) {
  const thresholdW = baselineW != null ? r(baselineW * FILTER_LOADED) : null;
  if (points.length < FILTER_MIN_POINTS) return { thresholdW, points: points.length, slopeWPerDay: null, r2: null, forecastDay: null, conf: 'learning' as const };
  const d0 = points[0].day, xs = points.map(p => gap(d0, p.day)), ys = points.map(p => p.w), n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const b = sxx ? sxy / sxx : 0, a = my - b * mx, r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  const conf = r2 >= FILTER_R2_LEARNED ? 'learned' as const : 'estimated' as const;
  let forecastDay: string | null = null;
  if (thresholdW != null && b < 0) {
    const xNow = gap(d0, today);
    if (a + b * xNow <= thresholdW) forecastDay = today;
    else { const x = Math.ceil((thresholdW - a) / b); if (x - xNow <= FILTER_HORIZON_DAYS) forecastDay = addDays(d0, x); }
  }
  return { thresholdW, points: n, slopeWPerDay: r(b, 2), r2: r(r2, 2), forecastDay, conf };
}

/**
 * The pool payload's `filter`: the filter RPM is the speed the pump ran most in the window (50 RPM steps, as the baseline keys them),
 * the baseline the nightly clean-filter baseline at that speed (kv `<site>:learn:pump`). Three reads.
 */
export async function filterForecast(siteId: string, today = localDay()): Promise<FilterForecast> {
  const [cleaned, pump] = await Promise.all([
    q<{ day: string | null }>(`SELECT MAX(day) AS day FROM events WHERE site_id = $1 AND type = 'filter_cleaned'`, [siteId]),
    kv.get<{ baseline?: Record<string, { watts: number }> }>(`${siteId}:learn:pump`),
  ]);
  const cleanedOn = cleaned[0]?.day ?? null, from = cleanedOn && cleanedOn > addDays(today, -FILTER_DAYS) ? cleanedOn : addDays(today, -FILTER_DAYS);
  const rows = await q<{ day: string; rpm: number; w: number; n: number }>(`SELECT day, (ROUND(rpm / 50.0) * 50)::int rpm, (PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY watts))::float8 w, COUNT(*)::int n
    FROM pool_readings WHERE site_id = $1 AND day >= $2 AND day <= $3 AND ${PUMP_RUNNING_SQL} GROUP BY day, ROUND(rpm / 50.0) ORDER BY day`, [siteId, from, today]);
  const reads = new Map<number, number>(); for (const x of rows) reads.set(x.rpm, (reads.get(x.rpm) ?? 0) + x.n);
  const rpm = [...reads].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const baselineW = rpm != null ? pump?.baseline?.[String(rpm)]?.watts ?? null : null;
  const points = rows.filter(x => x.rpm === rpm && x.n >= FILTER_MIN_READS).map(x => ({ day: x.day, w: x.w }));
  return { rpm, baselineW, cleanedOn, ...filterFit(points, baselineW, today) };
}
