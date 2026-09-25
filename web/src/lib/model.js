import { clamp } from './util.js';

/**
 * The array's output per unit of sunlight on its plane: kWh produced per kWh/m² of global tilted irradiance.
 * Learned from real data (clear-ish days only), so it captures size, orientation, shading and inverter losses at once.
 */
export function learnYield(daily, gtiByDate) {
  const pts = daily.filter(d => gtiByDate[d.date] > 2.5 && d.solar > 1).map(d => d.solar / gtiByDate[d.date]);
  if (!pts.length) return null;
  pts.sort((a, b) => a - b);
  return pts[Math.floor(pts.length * .6)]; // upper-middle: clear days define "healthy"
}

/** 48-hour forecast: forecast sunlight × learned yield vs your typical hourly usage, with the Powerwalls simulated. */
export function forecast48({ w, startDate, startHour, soc0, yieldK, profile, capKwh, maxKw, reservePct }) {
  const out = []; let soc = soc0 / 100, full = null, low = { soc: 1, h: 0 };
  const rows = w.hourly.time.map((t, i) => ({ t, i })).filter(r => r.t >= `${startDate}T${String(Math.floor(startHour)).padStart(2, '0')}`).slice(0, 49);
  rows.forEach(({ t, i }, k) => {
    // radiation is the mean over the *preceding* hour, so hour i describes (i-1 → i)
    const next = w.hourly.global_tilted_irradiance[i + 1] ?? 0;
    const s = Math.max(0, next) / 1000 * yieldK, h = profile[+t.slice(11, 13)] ?? 2;
    let n = s - h, b;
    if (n > 0) b = -Math.min(n, maxKw, (1 - soc) * capKwh / .95); else b = Math.min(-n, maxKw, Math.max(0, soc - reservePct / 100) * capKwh * .95);
    soc = clamp(soc + (b < 0 ? -b * .95 : -b / .95) / capKwh, 0, 1);
    out.push({ k, t, s, h, soc, g: h - s - b });
    if (full == null && soc > .995) full = t;
    if (k > 1 && soc < low.soc) low = { soc, t };
  });
  return { points: out, full, low, importKwh: out.reduce((a, p) => a + Math.max(0, p.g), 0) };
}
