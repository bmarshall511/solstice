// Panel cleanliness (approved mockup ai, the Cleaning check card upgraded). Dust is measured on clear days only: the array's kWh divided
// by the sunlight on the panel plane, adjusted to 25 °C panels (hot panels make less, −0.35 %/°C). The clean level is the median of the
// first 3 clear days after the last rain of 5 mm or more (or after a logged cleaning); "now" is the median of the latest 3 clear days.
// Backtested on 13 months (Open-Meteo archive): about −2 %/week in hot dry spells, none in winter; 5 % below clean fired twice, both real.
// Reads Tesla history (energy), the logged cleanings (events) and Open-Meteo (fetched once a night into kv). Writes no device.
// B2-13 (audit L-29, owner Q14): a noise band. `lossSd` is the day-to-day spread of the clear-day yield (a robust SD from consecutive
// clear days, as % of clean); "getting dusty" and "dusty" need the loss to clear their threshold by one SD, and the card says "X% ± Y%".
import { q, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';
import { siteLocation } from './site.js';
import { notify } from './notify.js';
import { currentTariff } from './tariff.js';

export const CLEAR_CLOUD = 15, CLEAR_GTI = 4, RAIN_MM = 5, REF_DAYS = 3, NOW_DAYS = 3, DUSTY = 5, GETTING = 3, TEMP_COEF = .0035, SOON_DAYS = 5;
export type SoilWx = { hourly: { time: string[]; global_tilted_irradiance: Array<number | null>; cloud_cover: Array<number | null> };
  daily: { time: string[]; precipitation_sum: Array<number | null>; temperature_2m_max: Array<number | null> } };
export type ClearPoint = { day: string; y: number };
export type Soiling = {
  state: 'clean' | 'getting' | 'dusty' | 'measuring'; lossPct: number | null; lossSd: number | null; score: number | null; kwhPerDay: number | null; dollarsPerMonth: number | null;
  ref: { from: string; to: string; y: number; after: 'rain' | 'cleaning' | 'window' } | null; now: number | null; resetOn: string | null; resetBy: 'rain' | 'cleaning' | null;
  lastRain: { day: string; mm: number; daysAgo: number } | null; nextRain: { day: string; mm: number } | null; clearSince: number;
  points: ClearPoint[]; rains: Array<{ day: string; mm: number }>; at: number;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/** Each past day's clear-sky test and temperature-adjusted yield (kWh per kWh/m², at 25 °C panels); `solar` = the day's kWh by day. */
export function clearDays(wx: SoilWx, solar: Record<string, number>, today: string): ClearPoint[] {
  const gti: Record<string, number> = {}, cloud: Record<string, number[]> = {};
  wx.hourly.time.forEach((t, i) => { const d = t.slice(0, 10), h = +t.slice(11, 13); gti[d] = (gti[d] ?? 0) + (wx.hourly.global_tilted_irradiance[i] ?? 0) / 1000;
    if (h >= 10 && h <= 17 && wx.hourly.cloud_cover[i] != null) (cloud[d] ??= []).push(wx.hourly.cloud_cover[i]!); });
  const high = Object.fromEntries(wx.daily.time.map((d, i) => [d, wx.daily.temperature_2m_max[i]]));
  return Object.keys(gti).sort().filter(d => d < today && solar[d] != null && cloud[d]?.length && high[d] != null).flatMap(d => {
    const cc = cloud[d].reduce((a, v) => a + v, 0) / cloud[d].length; if (cc >= CLEAR_CLOUD || gti[d] < CLEAR_GTI) return [];
    const cellC = ((high[d] as number) - 32) / 1.8 + 20;   // a panel at noon runs about 20 °C over the air
    return [{ day: d, y: r2(solar[d] / gti[d] / (1 - TEMP_COEF * (cellC - 25))) }];
  });
}

/**
 * B2-13: the day-to-day noise of the clear-day yield, in % of `ref`: 1.4826 × the median |change| between consecutive clear days ÷ √2
 * (the spread of one day's figure; a median, so the dust step itself or one odd day doesn't count as noise). Consecutive days a rain or
 * a cleaning falls between are not compared. Null with fewer than 4 pairs.
 */
export function yieldSd(points: ClearPoint[], resets: string[], ref: number): number | null {
  const d: number[] = [];
  for (let i = 1; i < points.length; i++) if (!resets.some(r => r >= points[i - 1].day && r < points[i].day)) d.push(Math.abs(points[i].y - points[i - 1].y));
  if (d.length < 4 || !(ref > 0)) return null;
  return Math.round(1.4826 * median(d) / Math.SQRT2 / ref * 1000) / 10;
}

/** The card's figures from the clear days, the rains (past and forecast) and the logged cleanings. */
export function soiling(o: { points: ClearPoint[]; rains: Array<{ day: string; mm: number }>; cleanings: string[]; today: string; solarRecent: number | null; rate: number | null; now?: number }): Soiling {
  const past = o.rains.filter(r => r.day < o.today && r.mm >= RAIN_MM), lastRain = past.at(-1) ?? null;
  const nextRain = o.rains.find(r => r.day >= o.today && r.day < addDays(o.today, SOON_DAYS) && r.mm >= RAIN_MM) ?? null;
  const cleaned = o.cleanings.filter(d => d <= o.today).sort().at(-1) ?? null;
  // the reset: the later of the last 5 mm rain and the last logged cleaning; the clean level is the first 3 clear days after it
  const resetBy = cleaned && (!lastRain || cleaned >= lastRain.day) ? 'cleaning' as const : lastRain ? 'rain' as const : null;
  const resetOn = resetBy === 'cleaning' ? cleaned : lastRain?.day ?? null;
  const after = o.points.filter(p => !resetOn || p.day > resetOn), refPts = after.slice(0, REF_DAYS);
  const ref = refPts.length === REF_DAYS ? { from: refPts[0].day, to: refPts.at(-1)!.day, y: r2(median(refPts.map(p => p.y))), after: resetBy ?? 'window' as const } : null;
  const nowPts = after.slice(REF_DAYS).slice(-NOW_DAYS), now = ref && nowPts.length >= NOW_DAYS ? r2(median(nowPts.map(p => p.y))) : null;
  const lossPct = ref && now != null ? Math.max(0, Math.round((1 - now / ref.y) * 1000) / 10) : null;
  const lossSd = ref ? yieldSd(o.points, [...past.map(r => r.day), ...o.cleanings], ref.y) : null, band = lossSd ?? 0;   // B2-13
  const kwhPerDay = lossPct != null && o.solarRecent != null ? r2(o.solarRecent * lossPct / (100 - lossPct)) : null;
  return {
    state: lossPct == null ? 'measuring' : lossPct >= DUSTY + band ? 'dusty' : lossPct >= GETTING + band ? 'getting' : 'clean',
    lossPct, lossSd, score: lossPct == null ? null : Math.min(100, Math.round(lossPct * 10)), kwhPerDay, dollarsPerMonth: kwhPerDay != null && o.rate ? Math.round(kwhPerDay * 30 * o.rate) : null,
    ref, now, resetOn, resetBy, clearSince: after.length,
    lastRain: lastRain ? { ...lastRain, daysAgo: Math.round((Date.parse(o.today) - Date.parse(lastRain.day)) / 864e5) } : null, nextRain,
    points: o.points, rains: o.rains.filter(r => r.mm >= RAIN_MM), at: o.now ?? Date.now(),
  };
}

/* ---------- the app: weather once a night, the card on demand, the push nightly ---------- */
const WX_KEY = 'soiling:wx';
/**
 * Past rain from Open-Meteo's archive where it has the day, the forecast service's figure otherwise (the archive runs a few days
 * behind; future days are always the forecast's). The two disagree on some days (9/27/2026: 0.5 mm archive, 67 mm forecast service,
 * on a 37 kWh day), and the 13-month backtest behind the rules was on the archive. Returns the forecast payload with its rain merged.
 */
export function mergeRain(w: SoilWx, archive: { time: string[]; precipitation_sum: Array<number | null> } | null, today: string): SoilWx & { rainFrom: Array<'archive' | 'forecast'> } {
  const a = new Map((archive?.time ?? []).map((d, i) => [d, archive!.precipitation_sum[i]]));
  const from = w.daily.time.map(d => d < today && a.get(d) != null ? 'archive' as const : 'forecast' as const);
  return { ...w, daily: { ...w.daily, precipitation_sum: w.daily.time.map((d, i) => from[i] === 'archive' ? a.get(d)! : w.daily.precipitation_sum[i]) }, rainFrom: from };
}
/** 92 past days and 6 forecast days of panel-plane sun, midday cloud, rain and highs; fetched at most once a day (kv). */
export async function soilWx(now = Date.now(), fetchIt = true): Promise<SoilWx | null> {
  const c = await kv.get<{ day: string; w: SoilWx }>(WX_KEY);
  if (!fetchIt || c?.day === localDay(new Date(now))) return c?.w ?? null;   // requests read the cache only; the nightly step fetches
  const loc = siteLocation(); if (!loc) return c?.w ?? null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&tilt=27&azimuth=64&past_days=92&forecast_days=6&temperature_unit=fahrenheit&timezone=America%2FChicago` +
      '&hourly=global_tilted_irradiance,cloud_cover&daily=precipitation_sum,temperature_2m_max';   // azimuth 64 = the roof's 244° (Open-Meteo: 0 = south)
    const j = await fetch(u, { signal: AbortSignal.timeout(10_000) }).then(r => { if (!r.ok) throw new Error(`Open-Meteo: HTTP ${r.status}`); return r.json(); }) as SoilWx;
    if (!j.hourly?.time?.length || !j.daily?.time?.length) throw new Error('Open-Meteo returned no days');
    // the archive's daily rain for the same past days; a failure keeps the forecast service's (as before this fix)
    const today = localDay(new Date(now)), a = j.daily.time[0], b = addDays(today, -1);
    const arch = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${a}&end_date=${b}&timezone=America%2FChicago&daily=precipitation_sum`,
      { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).then((x: any) => x?.daily?.time ? x.daily : null).catch(() => null);
    const w = mergeRain({ hourly: j.hourly, daily: j.daily }, arch, today);
    await kv.set(WX_KEY, { day: today, w });
    return w;
  } catch (e) { console.warn(`[soiling] Open-Meteo: ${(e as Error).message}`); return c?.w ?? null; }
}

/** The card's figures now (GET /api/soiling): the cached weather, Tesla's daily kWh and the logged cleanings. */
export async function soilingFor(siteId: string, now = Date.now(), wx?: SoilWx | null) {
  const w = wx === undefined ? await soilWx(now, false) : wx, today = localDay(new Date(now));
  if (!w) return null;
  const from = w.daily.time[0] ?? addDays(today, -92);
  const [days, ev, rate] = await Promise.all([
    q<{ day: string; kwh: number; n: number }>(`SELECT day, (SUM(solar_wh) / 1000.0)::float8 kwh, COUNT(*)::int n FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day`, [siteId, from, today]),
    q<{ day: string }>(`SELECT day FROM events WHERE site_id = $1 AND type = 'cleaned' ORDER BY day`, [siteId]),
    currentTariff(siteId).then(t => t?.importRateAllIn ?? null).catch(() => null),
  ]);
  const full = days.filter(d => d.n >= 276);   // a day Tesla reported nearly every 5 minutes of (23–25 h days included)
  const solar = Object.fromEntries(full.map(d => [d.day, d.kwh])), recent = full.filter(d => d.day >= addDays(today, -14)).map(d => d.kwh);
  const rains = w.daily.time.map((day, i) => ({ day, mm: Math.round((w.daily.precipitation_sum[i] ?? 0) * 10) / 10 }));
  return soiling({ points: clearDays(w, solar, today), rains, cleanings: ev.map(e => e.day), today, solarRecent: recent.length ? recent.reduce((a, v) => a + v, 0) / recent.length : null, rate, now });
}

/** Nightly (watch.ts nightlySteps): refresh the weather, and one `panel` push per dusty spell while no 5 mm rain is forecast for 5 days. */
export async function soilingNightly(siteId: string, now = Date.now()) {
  const s = await soilingFor(siteId, now, await soilWx(now));
  if (!s) return { skipped: 'no weather' };
  if (s.state !== 'dusty' || s.nextRain) return { state: s.state, lossPct: s.lossPct, nextRain: s.nextRain?.day ?? null };
  const r = await notify(siteId, 'panel', 'Panels look dusty',
    `About ${s.lossPct}%${s.lossSd ? ` ± ${s.lossSd}%` : ''} below clean${s.kwhPerDay != null ? ` (≈ ${s.kwhPerDay.toFixed(1)} kWh a day)` : ''}${s.lastRain ? ` after ${s.lastRain.daysAgo} days without 5 mm of rain` : ''}, and none in the 5-day forecast. A rinse would bring it back.`,
    { lossPct: s.lossPct }, { key: `soiling:${s.resetOn ?? s.ref?.from ?? 'window'}`, windowH: 24 * 120, now, url: '/?go=v-roof' });   // once per dusty spell: the key changes when rain or a cleaning resets it
  return { state: s.state, lossPct: s.lossPct, pushed: r.pushed, skipped: r.skipped ?? null };
}
