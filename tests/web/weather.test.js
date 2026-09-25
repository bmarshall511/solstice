// Weather helpers (web/src/lib/weather.js): design §8, case 30. The fetch builders are never called.
import { describe, it, expect } from 'vitest';
import { WMO, WICON, hourlyIndex } from '../../web/src/lib/weather.js';

describe('weather codes', () => {
  it('30: WMO', () => {
    expect([0, 1, 3, 45, 61, 71, 80, 95].map(WMO)).toEqual(['Clear', 'Partly cloudy', 'Overcast', 'Fog', 'Rain', 'Snow', 'Showers', 'Storms']);
  });
  it('30: WICON, day and night', () => {
    expect(WICON(0)).toBe('☀︎');
    expect(WICON(0, false)).toBe('☾');
    expect(WICON(2)).toBe('⛅︎');
    expect(WICON(45)).toBe('☁︎');
    expect(WICON(61)).toBe('☂︎');
    expect(WICON(95)).toBe('⛈︎');
  });
});

describe('hourlyIndex', () => {
  it('indexes hourly rows by local date and hour', () => {
    const w = { hourly: { time: ['2026-09-25T00:00', '2026-09-25T01:00', '2026-09-25T23:00', '2026-09-26T00:00'] } };
    const idx = hourlyIndex(w);
    expect(Object.keys(idx)).toEqual(['2026-09-25', '2026-09-26']);
    expect(idx['2026-09-25'][0]).toBe(0);
    expect(idx['2026-09-25'][1]).toBe(1);
    expect(idx['2026-09-25'][23]).toBe(2);
    expect(idx['2026-09-26'][0]).toBe(3);
  });
});
