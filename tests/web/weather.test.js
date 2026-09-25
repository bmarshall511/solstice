// Weather helpers (web/src/lib/weather.js): design §8, case 30. The fetch builders are never called.
import { describe, it, expect } from 'vitest';
import { WMO, WICON } from '../../web/src/lib/weather.js';

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
