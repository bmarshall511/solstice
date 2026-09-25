/*
 * Panels → Live roof (mockup p-roof-veil): produced vs expected, hour by hour.
 * Bars cover the 15 hours ending 6 AM … 8 PM (index i = the hour ending at 6 + i o'clock, Chicago time).
 *   expected = Open-Meteo global_tilted_irradiance for the hour ending at that timestamp (W/m²) ÷ 1000 × the learned yield (S.yieldK);
 *   produced = the mean of today's Tesla buckets (/api/day, kW) that start inside that hour; null for an hour with no data yet.
 * Flat-topping is judged on hourly means only (single 5-minute buckets read high): a mean of 9.2 kW or more.
 */
export const HOURS = 15, FIRST = 6, FLAT_KW = 9.2, CAP_KW = 9.45;
const pad = n => String(n).padStart(2, '0');

/** { exp: number[15], act: (number|null)[15] } for `date` (YYYY-MM-DD). */
export function roofHours(day, wx, yieldK, date) {
  const exp = Array(HOURS).fill(0), act = Array(HOURS).fill(null);
  const idx = wx?.hourly?.time ? new Map(wx.hourly.time.map((t, i) => [t, i])) : null;
  const sum = Array(HOURS).fill(0), n = Array(HOURS).fill(0);
  for (const b of day?.date === date ? day.buckets ?? [] : []) { const i = Math.floor(b.t) + 1 - FIRST; if (i >= 0 && i < HOURS) { sum[i] += b.solar; n[i]++; } }
  for (let i = 0; i < HOURS; i++) {
    const h = FIRST + i, j = idx?.get(`${date}T${pad(h)}:00`);
    exp[i] = j != null && yieldK ? Math.max(0, (wx.hourly.global_tilted_irradiance[j] ?? 0) / 1000 * yieldK) : 0;
    if (n[i]) act[i] = sum[i] / n[i];
  }
  return { exp, act };
}

/** The HUD's comparison for local hour `hour` (0–24, fractional): the hour in progress ends at floor(hour) + 1.
 *  Returns null when there is nothing to compare, else { sunKw, panelKw, pct, flat }. `liveKw` is the live solar reading. */
export function sunSays(H, hour, liveKw) {
  const i = Math.floor(hour) + 1 - FIRST; if (i < 0 || i >= HOURS) return null;
  const sunKw = H.exp[i], mean = H.act[i] ?? (i > 0 ? H.act[i - 1] : null), panelKw = liveKw ?? H.act[i];
  const flat = mean != null && mean >= FLAT_KW;
  if (!flat && (!sunKw || sunKw < .05 || panelKw == null)) return null;
  return { sunKw, panelKw, pct: sunKw ? Math.round(panelKw / sunKw * 100) : null, flat };
}

/** Veil strength 0–1 from the Cleaning check's dust score (0–100): alpha = score/100 × .35, as the mockup paints it. */
export const veilAlpha = score => Math.max(0, Math.min(100, score ?? 0)) / 100 * .35;
