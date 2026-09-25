// Pool power and flow model (design §8, cases 1–5). Pure: the db, ScreenLogic and Nest are globally mocked.
import { describe, it, expect } from 'vitest';
import { powerModel, gpmAt, hourlyRpm, dayKwh, quarterRpm, quarterWh, scheduledQuarters, quarterOf, meanByQuarter } from '../../server/src/appliances/pool.js';

const W0 = powerModel([]);
const W1 = powerModel([{ rpm: 1500, watts: 153 }, { rpm: 1800, watts: 287 }]);
const SPEEDS = new Map([[6, 1500], [8, 2400]]);
const hoursOn = (prof: ReturnType<typeof hourlyRpm>) => prof.reduce((a, h) => a + h.frac, 0);
const onHours = (prof: ReturnType<typeof hourlyRpm>) => prof.flatMap((h, i) => h.frac ? [i] : []);

describe('powerModel', () => {
  it('1: defaults only (1800 RPM measured point + 3450 RPM full-speed anchor)', () => {
    const rpm = [0, 200, 450, 1000, 1500, 1790, 1800, 2400, 3000, 3450, 4000, 5000];
    const want = [0, 20, 20, 49.211, 166.088, 287, 287, 798.118, 1764.427, 2900, 3200, 3200];
    rpm.forEach((r, i) => expect(W0(r), `W0(${r})`).toBeCloseTo(want[i], 2));
  });
  it('1: cube law below the lowest anchor, floored at 20 W; log-log between anchors (k ≈ 3.555); capped at 3200 W above', () => {
    expect(W0(1500)).toBeCloseTo(287 * (1500 / 1800) ** 3, 6);
    const k = Math.log(2900 / 287) / Math.log(3450 / 1800);
    expect(k).toBeCloseTo(3.555, 3);
    expect(W0(2400)).toBeCloseTo(287 * (2400 / 1800) ** k, 6);
    expect(W0(25_000)).toBe(3200);
  });
  it('2: measured medians become anchors', () => {
    expect(W1(1500)).toBe(153);
    expect(W1(1650)).toBeCloseTo(212.571, 2);
    expect(W1(1000)).toBeCloseTo(45.333, 2);
    expect(W1(2400)).toBeCloseTo(798.118, 2);
  });
  it('2: points under 450 RPM and 0 W are dropped; a 1700–1900 point suppresses the 1800 default', () => {
    const W = powerModel([{ rpm: 400, watts: 100 }, { rpm: 1500, watts: 0 }, { rpm: 1750, watts: 250 }]);
    expect(W(1750)).toBe(250);
    expect(W(1800)).toBeCloseTo(276.770, 2);
    expect(W(1500)).toBeCloseTo(157.434, 2);
  });
});

describe('gpmAt', () => {
  it('3: scales the 120 GPM design point linearly with RPM', () => {
    expect(gpmAt(3450)).toBe(120);
    expect(gpmAt(1500)).toBeCloseTo(52.174, 3);
    expect(gpmAt(1500, 100)).toBeCloseTo(43.478, 3);
    expect(gpmAt(0)).toBe(0);
    expect(gpmAt(1800)).toBeCloseTo(62.609, 3);
  });
});

describe('hourlyRpm', () => {
  it('4: Pool 10:00–19:00 at 1500 is nine whole hours', () => {
    const prof = hourlyRpm([{ circuitId: 6, start: 600, stop: 1140 }], SPEEDS);
    expect(onHours(prof)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    for (const h of onHours(prof)) expect(prof[h]).toEqual({ rpm: 1500, frac: 1, slices: [1500, 1500, 1500, 1500] });
    expect(hoursOn(prof)).toBe(9);
  });
  it('4: the highest active pump circuit wins (High Speed 14:00–15:00 on top of Pool)', () => {
    const prof = hourlyRpm([{ circuitId: 6, start: 600, stop: 1140 }, { circuitId: 8, start: 840, stop: 900 }], SPEEDS);
    expect(prof[14]).toEqual({ rpm: 2400, frac: 1, slices: [2400, 2400, 2400, 2400] });
    expect(prof[13]).toEqual({ rpm: 1500, frac: 1, slices: [1500, 1500, 1500, 1500] });
    expect(prof[15]).toEqual({ rpm: 1500, frac: 1, slices: [1500, 1500, 1500, 1500] });
    expect(hoursOn(prof)).toBe(9);
  });
  it('4: a start at 10:15 weights hour 10 by three quarters', () => {
    const prof = hourlyRpm([{ circuitId: 6, start: 615, stop: 1140 }], SPEEDS);
    expect(prof[10]).toEqual({ rpm: 1500, frac: .75, slices: [0, 1500, 1500, 1500] });
  });
  it('4: a schedule that wraps midnight (23:00 → 05:00)', () => {
    const prof = hourlyRpm([{ circuitId: 6, start: 1380, stop: 300 }], SPEEDS);
    expect(onHours(prof)).toEqual([0, 1, 2, 3, 4, 23]);
  });
  it('4: a circuit with no pump speed contributes nothing', () => {
    const prof = hourlyRpm([{ circuitId: 99, start: 600, stop: 1140 }], SPEEDS);
    expect(hoursOn(prof)).toBe(0);
    expect(prof.every(h => h.rpm === 0)).toBe(true);
  });

  // Q1 · today a zero-length schedule (start === stop) runs all day: 24 hours on.
  it.fails('Q1: a zero-length schedule (10:00–10:00) means off', () => {
    const prof = hourlyRpm([{ circuitId: 6, start: 600, stop: 600 }], SPEEDS);
    expect(hoursOn(prof)).toBe(0);
  });
  it('Q1 (today): a zero-length schedule is counted as 24 hours on', () => {
    expect(hoursOn(hourlyRpm([{ circuitId: 6, start: 600, stop: 600 }], SPEEDS))).toBe(24);
  });

  // BUG-3 (fixed, owner question 23) · a speed change mid-hour used to bill the whole hour at the higher speed:
  // 10:00–10:30 @1500 + 10:30–11:00 @2400 was { rpm 2400, frac 1 } = 0.798 kWh. 15-minute integration gives 0.482 kWh.
  const split = [{ circuitId: 6, start: 600, stop: 630 }, { circuitId: 8, start: 630, stop: 660 }];
  it('BUG-3: a mid-hour speed change is integrated per slice (hour 10 = 0.482 kWh)', () => {
    expect(dayKwh(hourlyRpm(split, SPEEDS), W0)).toBeCloseTo(0.482, 3);
  });
  it('BUG-3: the split hour still shows its top speed, and keeps each quarter-hour’s speed for the energy', () => {
    expect(hourlyRpm(split, SPEEDS)[10]).toEqual({ rpm: 2400, frac: 1, slices: [1500, 1500, 2400, 2400] });
    expect(dayKwh(hourlyRpm(split, SPEEDS), W0)).toBeCloseTo((2 * W0(1500) + 2 * W0(2400)) / 4 / 1000, 9);
  });
});

describe('15-minute integration (owner question 23)', () => {
  // the audit's example: a half-hour 2,400 RPM boost inside an otherwise 1,500 RPM hour
  const boost = [{ circuitId: 6, start: 600, stop: 660 }, { circuitId: 8, start: 615, stop: 645 }];
  it('23: a half-hour 2,400 RPM boost inside a 1,500 RPM hour is about 0.482 kWh, not 0.798', () => {
    const prof = hourlyRpm(boost, SPEEDS);
    expect(prof[10].slices).toEqual([1500, 2400, 2400, 1500]);
    const kwh = dayKwh(prof, W0);
    expect(kwh).toBeCloseTo(0.482, 3);
    expect(Math.round(kwh * 1000)).toBe(482);
    expect(kwh).not.toBeCloseTo(0.798, 2);
    // the old hourly model, for the record: the whole hour at the top speed
    expect(W0(prof[10].rpm) * prof[10].frac / 1000).toBeCloseTo(0.798, 3);
  });
  it('23: whole-hour programs integrate exactly as before (Pool 10–19 @1500 + High Speed 14–15 @2400)', () => {
    const prof = hourlyRpm([{ circuitId: 6, start: 600, stop: 1140 }, { circuitId: 8, start: 840, stop: 900 }], SPEEDS);
    expect(dayKwh(prof, W0)).toBeCloseTo((8 * W0(1500) + W0(2400)) / 1000, 9);
    expect(dayKwh(prof, W0)).toBeCloseTo(2.127, 3);
  });
  it('23: quarterRpm has 96 slices from midnight; scheduledQuarters marks the pump’s scheduled quarter-hours whatever the speed', () => {
    const qr = quarterRpm(boost, SPEEDS);
    expect(qr).toHaveLength(96);
    expect(qr.slice(39, 45)).toEqual([0, 1500, 2400, 2400, 1500, 0]);
    const sq = scheduledQuarters([{ circuitId: 99, start: 600, stop: 630 }]);  // a circuit with no RPM still counts as scheduled
    expect(sq.flatMap((on, i) => on ? [i] : [])).toEqual([40, 41]);
  });
  it('23: measured watts replace the model for the quarter-hours that have a reading (0 W when the pump was off)', () => {
    const prof = hourlyRpm(boost, SPEEDS), measured: Array<number | null> = Array(96).fill(null);
    measured[41] = 700; measured[42] = 720;                // the 2,400 RPM quarter-hours, as measured
    measured[43] = 0;                                      // a reading with the pump off
    measured[3] = 900;                                     // an unscheduled run at 00:45 (e.g. the spa) counts too
    const wh = quarterWh(prof, W0, measured);
    expect(wh.slice(40, 44)).toEqual([W0(1500) / 4, 175, 180, 0]);
    expect(wh[3]).toBe(225);
    expect(dayKwh(prof, W0, measured)).toBeCloseTo((W0(1500) / 4 + 175 + 180 + 0 + 225) / 1000, 9);
  });
  it('23: readings average into their Chicago quarter-hour', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(quarterOf(at('2026-07-15T15:00:00Z'))).toBe(40);   // 10:00 CDT
    expect(quarterOf(at('2026-07-15T15:14:59Z'))).toBe(40);
    expect(quarterOf(at('2026-07-15T15:15:00Z'))).toBe(41);
    expect(quarterOf(at('2026-01-15T16:00:00Z'))).toBe(40);   // 10:00 CST
    expect(quarterOf(at('2026-07-16T04:59:00Z'))).toBe(95);   // 23:59 CDT
    const m = meanByQuarter([{ ts: at('2026-07-15T15:01:00Z'), watts: 150 }, { ts: at('2026-07-15T15:09:00Z'), watts: 160 }, { ts: at('2026-07-15T15:20:00Z'), watts: 0 }]);
    expect(m).toHaveLength(96);
    expect([m[39], m[40], m[41], m[42]]).toEqual([null, 155, 0, null]);
  });
});
