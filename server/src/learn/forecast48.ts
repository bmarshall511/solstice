// A server twin of the browser's solar-yield and 48-hour forecast models (web/src/lib/model.js), so the nightly job can log the
// same forecast the Now tab draws and score it. Same arithmetic line for line; tests/server/learning.test.ts locks the two together.

export type GtiPayload = { hourly: { time: string[]; global_tilted_irradiance: Array<number | null> } };

/** kWh the array makes per kWh/m² of tilted sunlight: the upper-middle (p60) ratio over days with GTI > 2.5 and some output. */
export function learnYield(daily: ReadonlyArray<{ date: string; solar: number }>, gtiByDate: Record<string, number>): number | null {
  const pts = daily.filter(d => gtiByDate[d.date] > 2.5 && d.solar > 1).map(d => d.solar / gtiByDate[d.date]);
  if (!pts.length) return null;
  pts.sort((a, b) => a - b);
  return pts[Math.floor(pts.length * .6)];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export type Fc48Point = { k: number; t: string; s: number; h: number; soc: number; g: number; rs?: number; rh?: number };
export type Fc48Correction = { solar?: Record<string, number>; home?: Record<string, number> };
const fcBand = (k: number) => k <= 6 ? 'h1-6' : k <= 24 ? 'h7-24' : 'h25-48';

/**
 * 48-hour forecast: forecast sunlight × learned yield vs the typical hourly usage, with the Powerwalls simulated.
 * `correction` (B2-2, learn/bias.ts): factors per horizon band for solar and home. A day's hours all take the factor of the band its
 * daily total is scored in (the horizon of that day's 23:00 in this forecast), the Powerwalls are simulated on the corrected
 * figures, and each point keeps the raw solar and home as rs / rh. Without it the forecast is the raw model (what the nightly logs).
 */
export function forecast48(o: { w: GtiPayload; startDate: string; startHour: number; soc0: number; yieldK: number; profile: number[]; capKwh: number; maxKw: number; reservePct: number; dayScale?: Record<string, number>; correction?: Fc48Correction | null }) {
  const { w, startDate, startHour, soc0, yieldK, profile, capKwh, maxKw, reservePct, dayScale, correction } = o;   // dayScale: mockup ah (learn/homeModel.ts)
  const out: Fc48Point[] = []; let soc = soc0 / 100, full: string | null = null, low: { soc: number; h?: number; t?: string } = { soc: 1, h: 0 };
  const rows = w.hourly.time.map((t, i) => ({ t, i })).filter(r => r.t >= `${startDate}T${String(Math.floor(startHour)).padStart(2, '0')}`).slice(0, 49);
  const lastK: Record<string, number> = {};   // each day's 23:00 as a horizon (extrapolated for the last, partial day)
  rows.forEach(({ t }, k) => { lastK[t.slice(0, 10)] = k + 23 - +t.slice(11, 13); });
  rows.forEach(({ t, i }, k) => {
    // radiation is the mean over the *preceding* hour, so hour i describes (i-1 → i)
    const next = w.hourly.global_tilted_irradiance[i + 1] ?? 0;
    const rs = Math.max(0, next) / 1000 * yieldK, rh = (profile[+t.slice(11, 13)] ?? 2) * (dayScale?.[t.slice(0, 10)] ?? 1);
    const band = fcBand(lastK[t.slice(0, 10)]), s = rs * (correction?.solar?.[band] ?? 1), h = rh * (correction?.home?.[band] ?? 1);
    let n = s - h, b;
    if (n > 0) b = -Math.min(n, maxKw, (1 - soc) * capKwh / .95); else b = Math.min(-n, maxKw, Math.max(0, soc - reservePct / 100) * capKwh * .95);
    soc = clamp(soc + (b < 0 ? -b * .95 : -b / .95) / capKwh, 0, 1);
    out.push(correction ? { k, t, s, h, soc, g: h - s - b, rs, rh } : { k, t, s, h, soc, g: h - s - b });
    if (full == null && soc > .995) full = t;
    if (k > 1 && soc < low.soc) low = { soc, t };
  });
  return { points: out, full, low, importKwh: out.reduce((a, p) => a + Math.max(0, p.g), 0) };
}
