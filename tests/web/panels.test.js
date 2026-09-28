// web/src/lib/panels.js (approved mockup u-panels): the one diverging scale the Live roof and the Panel health grid share, and the
// mapping between "Row r · c" and the scene's panel order.
import { describe, it, expect } from 'vitest';
import { tint, kIndex, posOf, tileStyle, deficit } from '../../web/src/lib/panels.js';

describe('tint: no tint within ±5%, blue to full at −15%, gold to full at +10%', () => {
  it('the neutral band', () => {
    for (const r of [.95, 1, 1.05]) expect(tint(r)).toMatchObject({ side: 0, t: 0 });
    expect(tileStyle(1.02)).toBe('');
    expect(tint(null)).toBeNull();
  });
  it('blue below, reaching full strength at 85% and staying there', () => {
    expect(tint(.94).side).toBe(-1);
    expect(tint(.9).t).toBeCloseTo(.5, 6);
    expect(tint(.85).t).toBeCloseTo(1, 9);
    expect(tint(.6)).toMatchObject({ t: 1, rgb: [47 / 255, 95 / 255, 208 / 255] });
  });
  it('gold above, reaching full strength at 110%', () => {
    expect(tint(1.075)).toMatchObject({ side: 1 });
    expect(tint(1.075).t).toBeCloseTo(.5, 6);
    expect(tint(1.1).t).toBeCloseTo(1, 9);
    expect(tileStyle(1.2)).toBe('background:rgba(255,193,94,0.66);border-color:rgba(255,193,94,0.85)');
  });
});

describe('positions', () => {
  it('Row 1 is the ridge (scene r = 2), Row 3 the eave (r = 0); columns count from the north end (c = 0)', () => {
    expect(kIndex(3, 1)).toBe(0);
    expect(kIndex(3, 10)).toBe(9);
    expect(kIndex(1, 1)).toBe(20);
    expect(kIndex(2, 7)).toBe(16);
    for (let k = 0; k < 30; k++) { const p = posOf(k); expect(kIndex(p.row, p.col)).toBe(k); }
  });
  it('deficits read as the lowest-three column does', () => {
    expect(deficit(91)).toBe('−9%');
    expect(deficit(62.4)).toBe('−38%');
    expect(deficit(104)).toBe('+4%');
  });
});
