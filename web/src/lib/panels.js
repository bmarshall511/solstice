/*
 * Per-panel helpers (approved mockup u-panels), shared by the Live roof's Per panel layer and the Panel health card.
 * Panels are named "Row r · c": Row 1 is the ridge row, Row 3 the eave row, c counts 1–10 from the north end (left in the default view).
 * The scene builds its 30 panels with r = 0 at the eave and c = 0 at the north end, so scene index k = (3 − row) × 10 + (col − 1).
 */
const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const COOL0 = hex('#9fb4d8'), COOL1 = hex('#2f5fd0'), WARM0 = hex('#e8d3a6'), WARM1 = hex('#ffc15e');
export const RED = hex('#ff5a4e');

/** The one diverging scale (roof and grid): the ratio to the median panel. No tint within ±5%, blue reaching full strength at −15%,
 *  gold at +10%. Returns { rgb (0–1), a (roof alpha), t (0–1 strength), side (−1, 0, 1) }; null for no ratio. */
export function tint(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const d = Math.round((ratio - 1) * 1e4) / 1e4;   // 0.95 − 1 is −0.0500…04 in floating point
  if (Math.abs(d) <= .05) return { rgb: [1, 1, 1], a: .05, t: 0, side: 0 };
  if (d < 0) { const t = clamp((-d - .05) / .10, 0, 1); return { rgb: mix(COOL0, COOL1, t), a: .38 + .4 * t, t, side: -1 }; }
  const t = clamp((d - .05) / .05, 0, 1); return { rgb: mix(WARM0, WARM1, t), a: .34 + .36 * t, t, side: 1 };
}
export const rgba = (rgb, a) => `rgba(${rgb.map(v => Math.round(v * 255)).join(',')},${Math.round(a * 100) / 100})`;
/** Scene index for a roof position, and back. */
export const kIndex = (row, col) => (3 - row) * 10 + (col - 1);
export const posOf = k => ({ row: 3 - Math.floor(k / 10), col: k % 10 + 1 });
export const posId = (row, col) => `r${row}c${col}`;
/** A tile's inline style for a ratio (grid: kWh today against the median panel). Empty within ±5%. */
export function tileStyle(ratio) {
  const t = tint(ratio); if (!t || t.side === 0) return '';
  return `background:${rgba(t.rgb, .16 + .5 * t.t)};border-color:${rgba(t.rgb, .55 + .3 * t.t)}`;
}
/** "−9%" / "+4%" against the median panel. */
export const deficit = pct => { const d = Math.round(100 - pct); return d >= 0 ? `−${d}%` : `+${-d}%`; };
