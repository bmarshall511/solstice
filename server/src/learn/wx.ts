// Open-Meteo on the panels' plane for the learning layer (docs/audit-designs/learning-layer.md §4, `wx:gti`): the last 31 days and the
// next 3 of hourly tilted irradiance and temperature, daily high and rain. The same source and tilt the browser learns its solar
// yield on (web/src/lib/weather.js). Shared kv cache for an hour; no key, no location in the code (site.ts reads the environment).
import { kv } from '../db.js';
import { siteLocation } from '../site.js';
import { learnStats } from './store.js';

export type Wx = {
  hourly: { time: string[]; global_tilted_irradiance: Array<number | null>; temperature_2m: Array<number | null> };
  daily: { time: string[]; temperature_2m_max: Array<number | null>; precipitation_sum: Array<number | null> };
};
export const WX_KEY = 'wx:gti';
const TILT = 'tilt=27&azimuth=64'; // Open-Meteo azimuth: 0 = south, +90 = west → the roof's 244° compass = 64

/** The cached payload (at most an hour old), a fresh fetch, or the stale cache when the fetch fails; null without a location. */
export async function wxGti(now = Date.now()): Promise<Wx | null> {
  learnStats.queries++;
  const c = await kv.get<{ at: number; w: Wx }>(WX_KEY);
  if (c && now - c.at < 3600e3) return c.w;
  const loc = siteLocation(); if (!loc) return c?.w ?? null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&${TILT}&past_days=31&forecast_days=3&temperature_unit=fahrenheit&timezone=America%2FChicago` +
      '&hourly=global_tilted_irradiance,temperature_2m&daily=temperature_2m_max,precipitation_sum';
    const j = await fetch(u).then(r => r.json()) as Partial<Wx>;
    if (!j.hourly?.time?.length || !j.daily?.time?.length) throw new Error('Open-Meteo returned no hours');
    const w: Wx = { hourly: j.hourly, daily: j.daily };
    learnStats.queries++;
    await kv.set(WX_KEY, { at: now, w });
    return w;
  } catch (e) { console.warn(`[learn] Open-Meteo: ${(e as Error).message}`); return c?.w ?? null; }
}

/** Daily sums of tilted irradiance (kWh/m²), keyed by local day. */
export const gtiByDay = (w: Wx) => {
  const out: Record<string, number> = {};
  w.hourly.time.forEach((t, i) => { const d = t.slice(0, 10); out[d] = (out[d] ?? 0) + (w.hourly.global_tilted_irradiance[i] ?? 0) / 1000; });
  return out;
};
