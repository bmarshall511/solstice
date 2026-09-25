// Synthetic weather: hourly solar profiles, the server's Open-Meteo `Daily[]` (what `forecast()` caches in kv
// 'pool:forecast') and the browser's hourly global-tilted-irradiance payload. Hand-written shapes, no real forecast.

/** A clear-day bell of array output, kW by local hour. */
export const BELL = [0, 0, 0, 0, 0, 0, 0, .5, 1.5, 3, 4.5, 5.5, 6, 6, 5.5, 4.5, 3, 1.5, .5, 0, 0, 0, 0, 0];
/** A longer summer day, kW by local hour. */
export const SOL = [0, 0, 0, 0, 0, 0, .2, 1, 2.5, 4, 5.5, 6.5, 7, 7.2, 6.5, 5.5, 4, 2.6, 1, .2, 0, 0, 0, 0];
/** Relative sun by hour peaking at `peak` (1 at the peak, 0 seven hours away). */
export const sunPeak = (peak: number) => Array.from({ length: 24 }, (_, h) => Math.max(0, 1 - Math.abs(h - peak) / 7));
export const ZERO24 = Array(24).fill(0);

/** The server's daily forecast row (the `Daily` type in server/src/appliances/autopilot.ts). */
export type Daily = { date: string; high: number; rainMm: number; rainPct: number; sunKwhM2: number; hourlySun: number[] };

/** `planDay` turns hourlySun (kW/m²) into array kW with × 9.45 × 0.8, so this gives back BELL exactly. */
export const BELL_SUN = BELL.map(v => v / 7.56);

const shift = (day: string, n: number) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/**
 * Ten days like Open-Meteo's past_days=3 + forecast_days=7: today − 3 … today + 6. A mild, sunny, dry default;
 * `over` patches individual days by offset from today (e.g. { 1: { high: 96 } } for tomorrow).
 */
export function forecastDays(today: string, over: Record<number, Partial<Daily>> = {}): Daily[] {
  return Array.from({ length: 10 }, (_, i) => {
    const k = i - 3;
    return { date: shift(today, k), high: 90, rainMm: 0, rainPct: 0, sunKwhM2: 6, hourlySun: BELL_SUN, ...(over[k] ?? {}) };
  });
}

/** The browser's Open-Meteo payload: hourly times from `start` (local 'YYYY-MM-DDTHH:00') with one GTI (W/m²) per hour. */
export function gtiPayload(start: string, gti: number[]) {
  const t0 = Date.parse(start + ':00Z');
  const time = gti.map((_, i) => new Date(t0 + i * 3600e3).toISOString().slice(0, 16));
  return { hourly: { time, global_tilted_irradiance: gti } };
}
