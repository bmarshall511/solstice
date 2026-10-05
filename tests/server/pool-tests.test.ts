// The pool water log (mockup aj, server/src/appliances/poolTests.ts): validation, the ranges (free chlorine's floor rises with CYA),
// the two findings and the reminder interval. Pure; the database side is tests/db/pool-water.test.ts.
import { describe, it, expect } from 'vitest';
import { testError, status, fcMin, findings, remindAfterDays, type PoolTest } from '../../server/src/appliances/poolTests.js';

const T = (day: string, fc: number, o: Partial<PoolTest> = {}): PoolTest => ({ id: 0, at: Date.parse(`${day}T18:00:00-05:00`), day, fc, ph: 7.6, cc: null, ta: null, cya: null, ch: null,
  clarity: 'clear', added: ['tablets'], source: 'kit', waterF: 80, ...o });

describe('pool water log', () => {
  it('PT-1 free chlorine and pH required; each value on its step and inside its limits; known words only', () => {
    expect(testError({ fc: 3, ph: 7.6, clarity: 'clear' })).toBeNull();
    expect(testError({ ph: 7.6, clarity: 'clear' })).toBe('free chlorine is required');
    expect(testError({ fc: 3.3, ph: 7.6, clarity: 'clear' })).toBe('fc must be 0–20 in steps of 0.5');
    expect(testError({ fc: 3, ph: 7.65, clarity: 'clear' })).toBe('ph must be 6.4–8.6 in steps of 0.1');
    expect(testError({ fc: 3, ph: 7.6, cya: 45, clarity: 'clear' })).toBe('cya must be 0–200 in steps of 10');
    expect(testError({ fc: 3, ph: 7.6, clarity: 'murky' })).toBe('clarity must be clear, hazy, cloudy or green');
    expect(testError({ fc: 3, ph: 7.6, clarity: 'clear', added: ['bleach'] })).toBe('added must be a list of liquid, tablets, shock, acid, other');
    expect(testError({ fc: 3, ph: 7.6, clarity: 'clear', source: 'store', ta: 90, ch: 325, cc: .5 })).toBeNull();
  });
  it('PT-2 ranges color only; with tablets raising CYA, free chlorine needs ~7.5% of it', () => {
    expect([fcMin(null), fcMin(40), fcMin(60), fcMin(80)]).toEqual([1, 3, 4.5, 6]);
    expect(status({ fc: 3, ph: 7.6, cc: null, ta: 100, cya: 20, ch: null }, 20)).toEqual({ fc: 'ok', ph: 'ok', cc: null, ta: 'ok', cya: 'lo', ch: null });
    expect(status({ fc: 3, ph: 8, cc: 1, ta: 70, cya: 70, ch: 450 }, 70)).toEqual({ fc: 'lo', ph: 'hi', cc: 'hi', ta: 'lo', cya: 'hi', ch: 'hi' });
  });
  it('PT-3 findings after 6 tests over 14 days: chlorine use between tablet-only tests, and pump hours before hazy vs clear tests', () => {
    const tests = [T('2026-09-05', 4), T('2026-09-08', 2.5), T('2026-09-12', 4, { added: ['liquid'] }), T('2026-09-14', 1, { clarity: 'hazy' }),
      T('2026-09-18', 3), T('2026-09-21', 1.5)];
    const hours = Object.fromEntries(Array.from({ length: 25 }, (_, i) => { const d = new Date(Date.UTC(2026, 7, 29 + i)).toISOString().slice(0, 10); return [d, d < '2026-09-10' ? 12 : 8]; }));
    const f = findings(tests, hours)!;
    expect(f.use).toEqual({ ppmPerDay: .5, n: 2, waterF: [80, 80] });          // 9/5→9/8 0.5/day, 9/18→9/21 0.5/day; 9/12 (liquid added) skipped
    expect(f.hazy).toEqual({ hazyHours: 9.7, clearHours: 10.2, hazyTests: 1 });  // before 9/14: (3 × 12 + 4 × 8) ÷ 7; clear: 12, 12, 10.9, 8, 8
    expect(findings(tests.slice(0, 5), hours)).toBeNull();
  });
  it('PT-4 the reminder: 4 days at 80°F and warmer, 7 when cooler or unknown', () => {
    expect([remindAfterDays(84), remindAfterDays(80), remindAfterDays(77), remindAfterDays(null)]).toEqual([4, 4, 7, 7]);
  });
});
