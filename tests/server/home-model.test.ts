// Home use from the forecast high (mockup ah, server/src/learn/homeModel.ts) and the 48-hour twins that use it.
import { describe, it, expect } from 'vitest';
import { fitHome, homeKwh, homePoints, dayScales, highsOf, forecastDays, fitYear, modelFor, yearPoints, clearUpDays, type HomeSlopes } from '../../server/src/learn/homeModel.js';
import { tempsOf } from '../../server/src/learn/wx.js';
import { fc48Inputs } from '../../server/src/learn/nightly.js';
import { burstsOf } from '../../server/src/breakdown.js';
import { heatDuty } from '../../server/src/outage.js';
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

/* ------------------------------------------------------------------ B2-8: the heating season */
// A synthetic year (2026): highs swing 60–96 °F, lows 20° below; the house uses 40 kWh + 3 per degree of high above 70 + 2 per degree
// of low below 60, with a small fixed wobble. Cold days rise in kWh, which the 14-day cooling line could never show.
const DAY0 = Date.parse('2026-01-01T12:00:00Z');
const YEAR = Array.from({ length: 365 }, (_, i) => {
  const day = new Date(DAY0 + i * 864e5).toISOString().slice(0, 10), high = 78 + 18 * Math.sin(2 * Math.PI * (i - 110) / 365), low = high - 20;
  return { day, high, low, kwh: 40 + 3 * Math.max(0, high - 70) + 2 * Math.max(0, 60 - low) + ((i * 37) % 11 - 5) * .3 };
});
describe('B2-8: the year fit (cooling and heating)', () => {
  it('HM-5 recovers both slopes and both change points from a year of synthetic days', () => {
    const f = fitYear(YEAR)!;
    expect([f.tc, f.th]).toEqual([70, 60]);
    expect(f.b).toBeGreaterThan(2.7); expect(f.b).toBeLessThan(3.3);                // within 10%
    expect(f.c).toBeGreaterThan(1.8); expect(f.c).toBeLessThan(2.2);
    expect(f.a).toBeCloseTo(40, 0);
    expect(f.heatDays).toBe(YEAR.filter(p => p.low < 60).length);
    expect([f.n, f.from, f.to]).toEqual([365, '2026-01-01', '2026-12-31']);
  });
  it('HM-6 cold days rise: a 14-day October level plus the year slopes puts a 25° night far above the 14-day line', () => {
    const slopes: HomeSlopes = { day: '2026-10-15', ...fitYear(YEAR)! };
    // a mild fortnight lived in a little more heavily than the year average (+6 kWh)
    const oct = Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, high: 70 + (i % 9), low: 58 + (i % 4), kwh: 0 }))
      .map(p => ({ ...p, kwh: 46 + 3 * Math.max(0, p.high - 70) + 2 * Math.max(0, 60 - p.low) }));
    const m = modelFor(slopes, oct)!;
    expect(m.a).toBeCloseTo(46, 0);                                                     // the level from the last 14 days
    expect([m.b, m.c, m.tc, m.th]).toEqual([slopes.b, slopes.c, 70, 60]);                // the weather response from the year
    expect(m.year).toMatchObject({ n: 365, heatDays: slopes.heatDays });
    const cold = homeKwh(m, 45, 25), mild = homeKwh(m, 72, 60);
    expect(cold).toBeGreaterThan(46 + 2 * 30);                                          // ≥ level + 2 × 35° below 60: strip heat
    expect(mild).toBeCloseTo(46 + 2 * slopes.b, 0);
    expect(homeKwh(fitHome(oct)!, 45, 25)).toBeLessThan(50);                             // the old line: a freezing day looks like a mild one
    expect(homeKwh(m, 45, null)).toBe(m.a);                                              // no low known: no heating term
    // with fewer than 5 recent days the year's own level stands; without a year fit it is the 14-day line
    expect(modelFor(slopes, oct.slice(0, 4))!.a).toBe(slopes.a);
    expect(modelFor(null, oct)).toEqual(fitHome(oct));
  });
  it('HM-7 a cold day may scale the profile to 2×; a day without a heating term stays within 1.5×', () => {
    const m = modelFor({ day: '2026-12-01', ...fitYear(YEAR)! }, YEAR.slice(-14))!, profile = Array(24).fill(50 / 24);
    const sc = dayScales(m, profile, { '2026-12-01': { high: 40, low: 15 }, '2026-12-02': { high: 99, low: 75 }, '2026-12-03': { high: 40, low: null } }, ['2026-12-01', '2026-12-02', '2026-12-03']);
    expect(sc['2026-12-01']).toBe(2);
    expect(sc['2026-12-02']).toBe(1.5);
    expect(sc['2026-12-03']).toBeLessThanOrEqual(1.5);
  });
  it('HM-8 too little or too narrow data gives no year fit; a year without cold nights has no heating term', () => {
    expect(fitYear(YEAR.slice(0, 29))).toBeNull();
    expect(fitYear(YEAR.slice(150, 200).map(p => ({ ...p, high: 90 + (p.kwh % 5) })))).toBeNull();      // highs within 10°
    const summer = YEAR.filter(p => p.low >= 62).map(p => ({ ...p, kwh: 40 + 3 * Math.max(0, p.high - 70) }));
    const f = fitYear(summer)!;
    expect(f.c).toBe(0); expect(f.heatDays).toBe(0); expect(f.b).toBeCloseTo(3, 1);
    expect(fitYear(YEAR.map(p => ({ ...p, low: null })))).toBeNull();                       // lows are needed
  });
  it('HM-9 the year points leave out incomplete, trip, Clear-up and pool-extra days, and days without a low', () => {
    const daily = [{ day: '2026-01-05', kwh: 70, complete: true }, { day: '2026-01-06', kwh: 40, complete: false }, { day: '2026-01-07', kwh: 20, complete: true },
      { day: '2026-01-08', kwh: 80, complete: true }, { day: '2026-01-09', kwh: 60, complete: true }];
    const temps = { '2026-01-05': { high: 50, low: 30 }, '2026-01-06': { high: 50, low: 30 }, '2026-01-07': { high: 50, low: 30 }, '2026-01-08': { high: 50, low: 30 }, '2026-01-09': { high: 50, low: null } };
    expect(yearPoints(daily, temps, new Set(['2026-01-07', '2026-01-08']))).toEqual([{ day: '2026-01-05', high: 50, low: 30, kwh: 70 }]);
    const t0 = Date.parse('2026-10-03T15:00:00Z');
    expect([...clearUpDays({ startedAt: t0, until: t0 + 3 * 864e5 }, t0 + 864e5)]).toEqual(['2026-10-03', '2026-10-04']);   // up to now
    expect(clearUpDays(null, t0).size).toBe(0);
  });
  it('HM-10 lows: the daily minimum when sent, else the lowest of 20+ hourly temperatures, else null', () => {
    const time = Array.from({ length: 48 }, (_, i) => `2026-12-0${1 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`);
    const hourly = { time, global_tilted_irradiance: time.map(() => 0), temperature_2m: time.map((_, i) => i < 24 ? 30 + i : (i < 34 ? 40 : null)) };
    expect(tempsOf({ hourly, daily: { time: ['2026-12-01', '2026-12-02'], temperature_2m_max: [55, 50], precipitation_sum: [0, 0] } } as any))
      .toEqual({ '2026-12-01': { high: 55, low: 30 }, '2026-12-02': { high: 50, low: null } });               // 12/2 has 10 hours
    expect(tempsOf({ hourly, daily: { time: ['2026-12-01'], temperature_2m_max: [55], temperature_2m_min: [28], precipitation_sum: [0] } } as any)).toEqual({ '2026-12-01': { high: 55, low: 28 } });
  });
  it('HM-11 the nightly 48-hour inputs use the year slopes: a cold forecast day scales up, a Clear-up day is not in the level', () => {
    const today = '2026-12-15', days = Array.from({ length: 14 }, (_, i) => new Date(Date.parse('2026-12-01T12:00:00Z') + i * 864e5).toISOString().slice(0, 10));
    const hourly = days.flatMap(day => Array.from({ length: 24 }, (_, hour) => ({ day, hour, home: day === '2026-12-05' ? 4 : 2 })));   // 48 kWh a day; 12/5 a Clear-up at 96
    const all = [...days, today, '2026-12-16', '2026-12-17'];
    const time = all.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
    const w = { hourly: { time, global_tilted_irradiance: time.map(() => 0), temperature_2m: time.map(() => 60) },
      daily: { time: all, temperature_2m_max: all.map(() => 65), temperature_2m_min: all.map(d => d === '2026-12-16' ? 25 : 60), precipitation_sum: all.map(() => 0) } } as any;
    const slopes: HomeSlopes = { day: today, a: 40, b: 3, c: 2, tc: 70, th: 60, n: 300, heatDays: 90, from: '2026-01-01', to: '2026-12-14', rmse: 5 };
    const soe = [{ day: '2026-12-14', hour: 23, last: 50, at: 1 }], daily = days.map(day => ({ day, solar: 20 }));
    // the GTI of 0 gives no yield: give the past days some sun so the inputs are ready
    w.hourly.global_tilted_irradiance = time.map(t => +t.slice(11, 13) === 12 ? 4000 : 0);
    const fc = fc48Inputs(w, daily, hourly, soe, today, new Set(), slopes, new Set(['2026-12-05'])) as any;
    expect(fc.ready).toBe(true);
    // level: 48 kWh a day on the 13 normal days (no weather terms: highs 65, lows 60) → a = 48; the profile averages the 14 days incl. 12/5
    expect(fc.dayScale['2026-12-15']).toBeCloseTo(48 / (48 + 48 / 14), 2);
    // a 25° night: 48 + 2 × 35 = 118 kWh, 2.3× the profile, kept to the 2× a heating day may reach (1.5 without one)
    expect(fc.dayScale['2026-12-16']).toBe(2);
    expect(fc48Inputs(w, daily, hourly, soe, today, new Set(), { ...slopes, c: 0 }, new Set(['2026-12-05'])) as any).toMatchObject({ dayScale: { '2026-12-16': fc.dayScale['2026-12-15'] } });
  });
});

describe('B2-8: heating in the breakdown bursts and the outage duty', () => {
  const B = 300_000, t0 = Date.parse('2026-12-01T06:00:00Z');
  // 30 minutes at 1 + 8 kW while the Nest heats
  const bs = Array.from({ length: 12 }, (_, i) => ({ epoch: t0 + i * B, day: '2026-12-01', hour: 0, kw: i < 6 ? 9 : 1 }));
  const heatOn = (s: number) => s < t0 + 6 * B, never = () => false;
  it('HM-12 strip heat is not a big load: subtracted at the learned heating kW, or skipped while none is learned', () => {
    expect(burstsOf(bs, 1, never).map(b => b.minutes)).toEqual([30]);                    // before B2-8: a "water heater" burst
    expect(burstsOf(bs, 1, never, 0, { on: heatOn, kw: null })).toEqual([]);               // heating, no kW learned: not a burst
    expect(burstsOf(bs, 1, never, 0, { on: heatOn, kw: 8 })).toEqual([]);                  // its own draw explains it
    expect(burstsOf(bs.map(b => b.epoch < t0 + 6 * B ? { ...b, kw: 13 } : b), 1, never, 0, { on: heatOn, kw: 8 }).map(b => [b.minutes, b.kwh])).toEqual([[30, 2]]);   // a 4 kW dryer during heating still counts
  });
  it('HM-13 heating duty: measured first, else the home model at today\'s low, else 50% on a freeze', () => {
    expect(heatDuty({ measuredPct: 40, low: 20, c: 2, th: 60, kw: 8 })).toEqual({ duty: .4, source: 'nest' });
    expect(heatDuty({ measuredPct: null, low: 30, c: 2, th: 60, kw: 8 }).duty).toBeCloseTo(30 * 2 / 24 / 8, 9);
    expect(heatDuty({ measuredPct: null, low: 65, c: 2, th: 60, kw: 8 }).duty).toBe(0);
    expect(heatDuty({ measuredPct: null, low: 28, c: 0, th: 65, kw: 8 })).toEqual({ duty: .5, source: 'estimated' });
    expect(heatDuty({ measuredPct: null, low: 45, c: 0, th: 65, kw: 8 }).duty).toBe(0);
  });
});
