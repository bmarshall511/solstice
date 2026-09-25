// Browser formatting and Chicago-time helpers (web/src/lib/util.js): design §8, case 30.
// sunAt is checked against physics (equinox and solstice noon heights) at a synthetic location passed to setSiteLocation,
// the way main.js passes the server's; it is not the site. It sits in the Central time zone, so the local-clock
// east/south/west assertions hold, and every angle is asserted relative to its latitude.
import { describe, it, expect, beforeAll } from 'vitest';
import { fmtDur, clock12, hourLabel, money, money2, kwh, addDays, localDate, localHour, niceDate, sunAt, clamp, setSiteLocation } from '../../web/src/lib/util.js';

const LAT = 35, LON = -90; // synthetic, round numbers

describe('formatting', () => {
  it('30: fmtDur', () => {
    expect(fmtDur(1.5)).toBe('1h 30m');
    expect(fmtDur(.25)).toBe('15m');
    expect(fmtDur(2)).toBe('2h 00m');
    expect(fmtDur(0)).toBe('—');
    expect(fmtDur(Infinity)).toBe('—');
  });
  it('30: clock12', () => {
    expect(clock12(13.5)).toBe('1:30 PM');
    expect(clock12(0)).toBe('12:00 AM');
    expect(clock12(12)).toBe('12:00 PM');
    expect(clock12(25)).toBe('1:00 AM');
    expect(clock12(-1)).toBe('11:00 PM');
  });
  it('30: hourLabel', () => {
    expect([0, 12, 23].map(hourLabel)).toEqual(['12a', '12p', '11p']);
  });
  it('30: money and money2 (a real minus sign, whole or cents)', () => {
    // amounts stay under 1,000 here: tests/hygiene.test.ts rejects larger dollar figures anywhere in tests/
    expect(money(-234.5)).toBe('−$235');
    expect(money(12)).toBe('$12');
    expect(money(null)).toBe('—');
    expect(money2(-3.456)).toBe('−$3.46');
    expect(money2(0)).toBe('$0.00');
  });
  it('30: kwh groups thousands and fixes the decimals', () => {
    expect(kwh(1234.5)).toBe('1,234.5<small>kWh</small>');
    expect(kwh(2, 0)).toBe('2<small>kWh</small>');
    expect(kwh(null)).toBe('—');
  });
  it('30: clamp', () => {
    expect([clamp(-1, 0, 1), clamp(.5, 0, 1), clamp(2, 0, 1)]).toEqual([0, .5, 1]);
  });
});

describe('Chicago time', () => {
  it('30: addDays across the fall-back day', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });
  it('30: localDate and localHour', () => {
    expect(localDate(new Date('2026-09-25T04:59:00Z'))).toBe('2026-09-24');
    expect(localHour(new Date('2026-09-25T04:30:00Z'))).toBe(23.5);
  });
  it('30: niceDate', () => {
    expect(niceDate('2026-09-25')).toBe('Sep 25');
  });
});

describe('sunAt', () => {
  beforeAll(() => { expect(setSiteLocation({ lat: LAT, lon: LON, zip: null })).toEqual({ lat: LAT, lon: LON, zip: null }); });
  it('30: before the location arrives it is a neutral placeholder sun (due south, 45° up)', () => {
    expect(sunAt(new Date('2026-09-25T18:00:00Z'), null)).toEqual({ el: 45, az: 180 });
  });
  const noonMax = day => {
    let best = -90;
    for (let m = 15 * 60; m <= 21 * 60; m++) best = Math.max(best, sunAt(new Date(Date.parse(`${day}T00:00:00Z`) + m * 60_000)).el);
    return best;
  };
  it('30: at the equinox the noon sun stands 90° − latitude high', () => {
    expect(Math.abs(noonMax('2026-03-20') - (90 - LAT))).toBeLessThan(.6);
  });
  it('30: at the solstices it is 23.44° higher and lower', () => {
    expect(Math.abs(noonMax('2026-06-21') - (90 - LAT + 23.44))).toBeLessThan(.3);
    expect(Math.abs(noonMax('2026-12-21') - (90 - LAT - 23.44))).toBeLessThan(.3);
  });
  it('30: east in the morning, south at midday, west in the evening, below the horizon at night', () => {
    const at = iso => sunAt(new Date(iso));
    expect(at('2026-09-25T13:00:00Z').az).toBeGreaterThan(90);
    expect(at('2026-09-25T13:00:00Z').az).toBeLessThan(135);
    expect(Math.abs(at('2026-12-21T18:30:00Z').az - 180)).toBeLessThan(15);
    expect(at('2026-09-25T23:00:00Z').az).toBeGreaterThan(225);
    expect(at('2026-09-25T08:00:00Z').el).toBeLessThan(0);
    for (const iso of ['2026-06-21T18:00:00Z', '2026-12-21T18:00:00Z', '2026-09-25T08:00:00Z']) {
      const s = at(iso);
      expect(s.az).toBeGreaterThanOrEqual(0);
      expect(s.az).toBeLessThan(360);
    }
  });
});
