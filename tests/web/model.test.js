// Browser-side models (web/src/lib/model.js): design §8, cases 27–29. Runs in Chicago time, as the browser does.
import { describe, it, expect } from 'vitest';
import { learnYield, forecast48 } from '../../web/src/lib/model.js';
import { gtiPayload } from '../fixtures/forecast.ts';

const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
const BATTERY = { capKwh: 27, maxKw: 10, reservePct: 20 };
const flat = kw => Array(24).fill(kw);
const run = (start, gti, o) => {
  const w = gtiPayload(start, gti);
  return forecast48({ w, idx: {}, startDate: o.startDate ?? start.slice(0, 10), startHour: o.startHour ?? +start.slice(11, 13), soc0: o.soc0, yieldK: 8, profile: o.profile, ...BATTERY });
};

describe('learnYield', () => {
  it('27: the upper-middle ratio of solar kWh to tilted irradiance, ignoring dim days and near-zero output', () => {
    const daily = [50, 60, 70, 80, 90].map((solar, i) => ({ date: `2026-06-0${i + 1}`, solar }))
      .concat([{ date: '2026-06-06', solar: .5 }, { date: '2026-06-07', solar: 100 }]);
    const gti = { '2026-06-01': 10, '2026-06-02': 10, '2026-06-03': 10, '2026-06-04': 10, '2026-06-05': 10, '2026-06-06': 10, '2026-06-07': 2 };
    expect(learnYield(daily, gti)).toBe(8); // ratios 5..9, index floor(5 × .6) = 3
  });
  it('27: a second set', () => {
    const rows = [[42, 6], [40, 5], [36, 4], [30, 3], [10, 2], [.5, 5]];
    const daily = rows.map(([solar], i) => ({ date: `2026-07-0${i + 1}`, solar }));
    const gti = Object.fromEntries(rows.map(([, g], i) => [`2026-07-0${i + 1}`, g]));
    expect(learnYield(daily, gti)).toBe(9);
  });
  it('27: no usable days gives null', () => {
    expect(learnYield([], {})).toBeNull();
  });
});

describe('forecast48', () => {
  it('28: a sunny morning charges the Powerwalls and imports nothing', () => {
    const r = run('2026-09-25T10:00', [0, 500, 1000, 800], { soc0: 50, profile: flat(2) });
    expect(r.points.map(p => round(p.s))).toEqual([4, 8, 6.4, 0]);
    expect(r.points.map(p => round(p.soc))).toEqual([.57037, .78148, .9363, .85832]);
    expect(r.points.map(p => round(p.g))).toEqual([0, 0, 0, 0]);
    expect(r.points.map(p => p.t)).toEqual(['2026-09-25T10:00', '2026-09-25T11:00', '2026-09-25T12:00', '2026-09-25T13:00']);
    expect(r.importKwh).toBe(0);
    expect(r.full).toBeNull();
    expect({ soc: round(r.low.soc), t: r.low.t }).toEqual({ soc: .85832, t: '2026-09-25T13:00' });
  });
  it('28: a dawn start (rows from 06:00, irradiance for the hour ending at the next timestamp)', () => {
    const r = run('2026-07-15T05:00', [0, 100, 400, 800, 900], { startHour: 6, soc0: 40, profile: flat(2) });
    expect(r.points.map(p => round(p.s))).toEqual([3.2, 6.4, 7.2, 0]);
    expect(r.points.map(p => round(p.soc))).toEqual([.44222, .59704, .78, .70203]);
    expect(r.low.t).toBe('2026-07-15T09:00');
  });
  it('29: a heavy evening drains to the reserve and imports the rest', () => {
    const r = run('2026-09-25T10:00', [0, 500, 1000, 800], { soc0: 50, profile: flat(12) });
    expect(r.points.map(p => round(p.soc))).toEqual([.2, .2, .2, .2]);
    expect(r.points.map(p => round(p.g))).toEqual([.305, 4, 5.6, 12]);
    expect(round(r.importKwh)).toBe(21.905);
  });
  it('29: a full battery exports the surplus and reports when it filled', () => {
    const r = run('2026-09-25T10:00', [2000, 2000, 2000], { soc0: 95, profile: flat(0) });
    expect(r.points.map(p => round(p.soc))).toEqual([1, 1, 1]);
    expect(r.full).toBe('2026-09-25T10:00');
    expect(r.points.map(p => round(p.g, 3))).toEqual([-14.579, -16, 0]);
  });
  // BUG-10 · fixed: `low` started as { soc: 1, h: 0 } and only became { soc, t } after the third row, so a short
  // forecast returned an object with the wrong keys.
  it('BUG-10: with fewer than three rows, low is { soc: 1, t: null }', () => {
    const r = run('2026-09-25T10:00', [0, 500], { soc0: 50, profile: flat(2) });
    expect(r.low).toStrictEqual({ soc: 1, t: null });
  });
});
