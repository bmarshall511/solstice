// Home use from the forecast high (mockup ah, server/src/learn/homeModel.ts) and the 48-hour twins that use it.
import { describe, it, expect } from 'vitest';
import { fitHome, homeKwh, homePoints, dayScales, highsOf, forecastDays } from '../../server/src/learn/homeModel.js';
import { forecast48 as serverFc } from '../../server/src/learn/forecast48.js';
// @ts-ignore: the browser module is plain JS without types; the twin must match it (as tests/server/learning.test.ts)
import { forecast48 as webFc } from '../../web/src/lib/model.js';

// the owner's last 14 days (real): day, high °F, home kWh
const REAL: Array<[string, number, number]> = [['09-21', 98, 86.6], ['09-22', 97, 101.5], ['09-23', 95, 89.2], ['09-24', 94, 86.1], ['09-25', 97, 90.1], ['09-26', 93, 72.6], ['09-27', 98, 64.8],
  ['09-28', 98, 92.8], ['09-29', 94, 82.1], ['09-30', 93, 79], ['10-01', 81, 59.9], ['10-02', 76, 49.5], ['10-03', 74, 61], ['10-04', 76, 53.4]];
const pts = REAL.map(([d, high, kwh]) => ({ day: `2026-${d}`, high, kwh }));

describe('home model', () => {
  it('HM-1 the line fitted to the real 14 days: about 46.5 kWh + 1.5 kWh per degree above 70°', () => {
    const f = fitHome(pts)!;
    expect([f.a, f.b, f.n]).toEqual([46.49, 1.47, 14]);                       // whole-degree highs here (46.8 with Open-Meteo's decimals)
    expect(Math.round(homeKwh(f, 82.5))).toBe(65);                              // tomorrow's 83° forecast
    expect(homeKwh(f, 65)).toBe(46.49);                                          // below 70°: the base
  });
  it('HM-2 no fit with fewer than 10 days or highs within 6°; a negative slope falls back to the average', () => {
    expect(fitHome(pts.slice(0, 9))).toBeNull();
    expect(fitHome(pts.slice(0, 10).map(p => ({ ...p, high: 94 + (p.kwh % 3) })))).toBeNull();
    const inverted = fitHome(pts.map(p => ({ ...p, high: 170 - p.high })))!;
    expect(inverted.b).toBe(0); expect(inverted.a).toBeCloseTo(pts.reduce((s, p) => s + p.kwh, 0) / 14, 1);
  });
  it('HM-3 complete days only, paired with their high; scales kept to 0.5–1.5 and only for days with a high', () => {
    const hourly = [...Array.from({ length: 24 }, (_, hour) => ({ day: '2026-10-03', hour, home: 2 })), ...Array.from({ length: 20 }, (_, hour) => ({ day: '2026-10-04', hour, home: 2 }))];
    expect(homePoints(hourly, { '2026-10-03': 74, '2026-10-04': 76 }, '2026-10-05')).toEqual([{ day: '2026-10-03', high: 74, kwh: 48 }]);   // 10/4 has 20 hours
    const f = fitHome(pts)!, profile = Array(24).fill(76.3 / 24);              // the 14-day average day
    expect(dayScales(f, profile, { '2026-10-05': 80.5, '2026-10-06': 82.5, '2026-10-07': 120 }, forecastDays('2026-10-05')))
      .toEqual({ '2026-10-05': .81, '2026-10-06': .85, '2026-10-07': 1.5 });   // (46.49 + 1.47 × 10.5) ÷ 76.3
    expect(dayScales(null, profile, { '2026-10-05': 80 }, ['2026-10-05'])).toEqual({});
    expect(highsOf({ daily: { time: ['2026-10-05'], temperature_2m_max: [80.5], precipitation_sum: [0] } } as any)).toEqual({ '2026-10-05': 80.5 });
  });
  it('HM-4 both 48-hour twins scale each hour by its day, and agree', () => {
    const time = Array.from({ length: 50 }, (_, i) => `2026-10-0${5 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`);
    const w = { hourly: { time, global_tilted_irradiance: time.map(() => 0) } };
    const o = { w, startDate: '2026-10-05', startHour: 0, soc0: 50, yieldK: 7, profile: Array(24).fill(2), capKwh: 27, maxKw: 10, reservePct: 20, dayScale: { '2026-10-05': .5, '2026-10-06': 1.5 } };
    const s = serverFc(o), b = webFc(o);
    expect([s.points[3].h, s.points[30].h]).toEqual([1, 3]);
    expect(b.points.map((p: any) => p.h)).toEqual(s.points.map(p => p.h));
    expect(serverFc({ ...o, dayScale: undefined }).points[3].h).toBe(2);          // no scale: the profile as before
  });
});
