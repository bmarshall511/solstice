// Panels → Live roof hour bars and HUD line (web/src/lib/roofhours.js, mockup p-roof-veil).
import { describe, it, expect } from 'vitest';
import { roofHours, sunSays, veilAlpha, HOURS } from '../../web/src/lib/roofhours.js';

const date = '2026-09-25';
const wx = { hourly: { time: Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`),
  global_tilted_irradiance: Array.from({ length: 24 }, (_, h) => h === 14 ? 700 : h === 15 ? 650 : h === 12 ? 1000 : 0) } };
const bucketsFor = (h, kw) => Array.from({ length: 12 }, (_, k) => ({ t: h + k / 12, solar: kw }));

describe('roofHours', () => {
  it('15 hours ending 6 AM … 8 PM: expected = GTI(hour ending) / 1000 × yield, produced = mean of the buckets in that hour', () => {
    const day = { date, buckets: [...bucketsFor(13, 5), ...bucketsFor(11, 9.3).map((b, i) => ({ ...b, solar: i % 2 ? 9.2 : 9.4 }))] };
    const H = roofHours(day, wx, 9, date);
    expect(H.exp).toHaveLength(HOURS); expect(H.act).toHaveLength(HOURS);
    expect(H.exp[14 - 6]).toBeCloseTo(6.3);            // hour ending 2 PM
    expect(H.exp[12 - 6]).toBeCloseTo(9);
    expect(H.act[14 - 6]).toBeCloseTo(5);              // buckets 13:00–13:55 belong to the hour ending 2 PM
    expect(H.act[12 - 6]).toBeCloseTo(9.3);
    expect(H.act[0]).toBeNull();
  });
  it('another day\'s buckets, or no model, give empty bars', () => {
    const H = roofHours({ date: '2026-09-24', buckets: bucketsFor(13, 5) }, wx, null, date);
    expect(H.act.every(a => a == null)).toBe(true);
    expect(H.exp.every(e => e === 0)).toBe(true);
  });
});

describe('sunSays', () => {
  const H = roofHours({ date, buckets: bucketsFor(13, 5.6) }, wx, 9, date);
  it('compares the hour in progress with the live reading', () => {
    expect(sunSays(H, 13.6, 5.6)).toEqual({ sunKw: expect.closeTo(6.3), panelKw: 5.6, pct: 89, flat: false });
  });
  it('switches to flat-topping on an hourly mean of 9.2 kW, never on single buckets', () => {
    const flat = roofHours({ date, buckets: bucketsFor(11, 9.25) }, wx, 9, date);
    expect(sunSays(flat, 11.5, 9.4).flat).toBe(true);
    const spike = roofHours({ date, buckets: [...bucketsFor(11, 8), { t: 11.95, solar: 12 }] }, wx, 9, date);
    expect(sunSays(spike, 11.5, 9.4).flat).toBe(false);
  });
  it('nothing to say at night', () => { expect(sunSays(H, 22, 0)).toBeNull(); expect(sunSays(H, 3, 0)).toBeNull(); });
});

describe('veilAlpha', () => {
  it('score/100 × .35, clamped', () => {
    expect(veilAlpha(55)).toBeCloseTo(.1925); expect(veilAlpha(0)).toBe(0); expect(veilAlpha(null)).toBe(0); expect(veilAlpha(150)).toBeCloseTo(.35);
  });
});
