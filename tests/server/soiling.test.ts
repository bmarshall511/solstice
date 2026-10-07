// Panel cleanliness (approved mockup ai, server/src/soiling.ts): clear days, the clean level after rain or a logged cleaning, the loss,
// the states and the push. The 8/26/2026 replay uses the real temperature-adjusted clear days from the mockup.
import { describe, it, expect } from 'vitest';
import { clearDays, soiling, mergeRain, yieldSd, type SoilWx } from '../../server/src/soiling.js';

// real (mockup ai): clear days since July and rains of 5 mm or more
const C: Array<[string, number]> = [['07-03', 8.8], ['07-09', 8.4], ['07-20', 8.3], ['07-23', 8.65], ['07-26', 8.29], ['07-27', 8.37], ['07-28', 8.12], ['08-02', 8.1], ['08-04', 8.25], ['08-08', 8.15],
  ['08-11', 8.42], ['08-12', 8.72], ['08-13', 8.54], ['08-16', 8.19], ['08-17', 8.17], ['08-23', 8.11], ['08-25', 7.84], ['08-26', 7.45], ['08-29', 8.67], ['08-30', 8.88]];
const pts = C.map(([d, y]) => ({ day: `2026-${d}`, y }));
const RAINS = [['07-11', 10], ['07-13', 10], ['07-14', 7], ['07-15', 17], ['07-16', 19], ['08-27', 12]].map(([d, mm]) => ({ day: `2026-${d}`, mm: mm as number }));
const at = (today: string, o: Partial<Parameters<typeof soiling>[0]> = {}) =>
  soiling({ points: pts.filter(p => p.day < today), rains: RAINS, cleanings: [], today, solarRecent: 43.8, rate: null, ...o });

describe('soiling', () => {
  it('SO-1 the 8/26 replay: 5.5% ± 3.3% below the clean level of the 3 clear days after the 7/16 rain, about 2.5 kWh a day', () => {
    const s = at('2026-08-27');
    expect(s.ref).toEqual({ from: '2026-07-20', to: '2026-07-26', y: 8.3, after: 'rain' });
    // B2-13 (deliberate update, was 'dusty'): these clear days move about 3.3% from one to the next, so 5.5% is inside 3% + one SD
    // (and 5% + one SD): no longer reported as dust
    expect([s.now, s.lossPct, s.lossSd, s.state, s.score, s.kwhPerDay]).toEqual([7.84, 5.5, 3.3, 'clean', 55, 2.55]);
    expect(s.lastRain).toEqual({ day: '2026-07-16', mm: 19, daysAgo: 42 });
  });
  it('SO-2 a rain of 5 mm or more resets: the next 3 clear days set the new level; a forecast rain within 5 days is reported', () => {
    expect(at('2026-08-28')).toMatchObject({ state: 'measuring', ref: null, resetOn: '2026-08-27', resetBy: 'rain', clearSince: 0, lossPct: null });
    expect(at('2026-08-26', { points: pts.filter(p => p.day < '2026-08-26') }).nextRain).toEqual({ day: '2026-08-27', mm: 12 });   // as the forecast showed it
    expect(at('2026-08-21').nextRain).toBeNull();
  });
  it('SO-3 a logged cleaning after the last rain resets the same way; states at 3% and 5%', () => {
    expect(at('2026-08-27', { cleanings: ['2026-08-18'] })).toMatchObject({ resetBy: 'cleaning', resetOn: '2026-08-18', clearSince: 3, state: 'measuring',
      ref: { from: '2026-08-23', to: '2026-08-26', y: 7.84, after: 'cleaning' } });   // 8/23, 8/25, 8/26 set the level; "now" needs 3 more
    const mk = (now: number) => soiling({ points: [8, 8, 8, 8, now, now, now].map((y, i) => ({ day: `2026-09-0${i + 1}`, y })), rains: [], cleanings: [], today: '2026-09-10', solarRecent: 40, rate: .12 });
    expect([mk(7.8).state, mk(7.7).state, mk(7.6).state, mk(8.1).lossPct]).toEqual(['clean', 'getting', 'dusty', 0]);
    expect(mk(7.6)).toMatchObject({ lossPct: 5, kwhPerDay: 2.11, dollarsPerMonth: 8, ref: { after: 'window' } });   // no rain in the window: the first 3 clear days
  });
  it('SO-4 clear days: midday cloud under 15% and 4+ kWh/m² of sun, adjusted to 25 °C panels', () => {
    const hours = (d: string, w: number, cc: number) => Array.from({ length: 24 }, (_, h) => ({ t: `${d}T${String(h).padStart(2, '0')}:00`, g: h >= 8 && h <= 17 ? w : 0, cc }));
    const hs = [...hours('2026-09-01', 700, 5), ...hours('2026-09-02', 700, 40), ...hours('2026-09-03', 300, 0)];
    const wx: SoilWx = { hourly: { time: hs.map(h => h.t), global_tilted_irradiance: hs.map(h => h.g), cloud_cover: hs.map(h => h.cc) },
      daily: { time: ['2026-09-01', '2026-09-02', '2026-09-03'], precipitation_sum: [0, 0, 0], temperature_2m_max: [77, 77, 77] } };
    // 7 kWh/m², 49 kWh made; 77 °F = 25 °C air, panels ~45 °C → ÷ (1 − 0.0035 × 20)
    expect(clearDays(wx, { '2026-09-01': 49, '2026-09-02': 49, '2026-09-03': 20 }, '2026-09-10')).toEqual([{ day: '2026-09-01', y: 7.53 }]);
  });
});


describe('B2-13: the noise band', () => {
  it('SO-9 the day-to-day SD: robust to the dust step itself, skipping pairs a rain or a cleaning falls between; null under 4 pairs', () => {
    const p = (ys: number[]) => ys.map((y, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, y }));
    expect(yieldSd(p([8, 8.2, 8, 8.2, 8, 8.2]), [], 8)).toBe(2.6);                        // 1.4826 × 0.2 ÷ √2 ÷ 8 = 2.6%
    expect(yieldSd(p([8, 8.2, 8, 8.2, 7.2, 7.4, 7.2, 7.4]), [], 8)).toBe(2.6);              // one 1.0 step among 0.2 moves: still 2.6
    expect(yieldSd(p([8, 9, 8, 9, 8]), ['2026-09-02', '2026-09-03'], 8)).toBeNull();         // two pairs span a reset: 2 left
    expect(yieldSd(p([8, 8.2, 8]), [], 8)).toBeNull();
  });
  it('SO-10 getting dusty and dusty need the loss to clear the threshold plus one SD; the payload carries lossSd', () => {
    // a reset-free window: 3 clean days at 8.0 ±0.2, a noisy middle, then the latest 3
    const mk = (now: number) => soiling({ points: [8, 8.2, 8, 8.2, 8, 8.2, now, now, now].map((y, i) => ({ day: `2026-09-0${i + 1}`, y })), rains: [], cleanings: [], today: '2026-09-12', solarRecent: 40, rate: null });
    expect(mk(7.6)).toMatchObject({ lossPct: 5, lossSd: 2.6, state: 'clean' });              // 5 < 3 + 2.6: inside the noise (it was "dusty")
    expect(mk(7.4)).toMatchObject({ lossPct: 7.5, state: 'getting' });                       // ≥ 5.6, < 7.6
    expect(mk(7.3)).toMatchObject({ lossPct: 8.8, state: 'dusty' });                         // ≥ 7.6
  });
});

describe('soiling: rain from the archive', () => {
  it('SO-8 past days use the archive where it has them; recent and future days keep the forecast service', () => {
    const w: SoilWx = { hourly: { time: [], global_tilted_irradiance: [], cloud_cover: [] },
      daily: { time: ['2026-09-27', '2026-10-02', '2026-10-04', '2026-10-06'], precipitation_sum: [67, 36.3, 1.5, 0], temperature_2m_max: [98, 77, 76, 82] } };
    const m = mergeRain(w, { time: ['2026-09-27', '2026-10-02', '2026-10-03', '2026-10-04'], precipitation_sum: [0.5, 57.1, 10.2, null] }, '2026-10-05');
    expect(m.daily.precipitation_sum).toEqual([0.5, 57.1, 1.5, 0]);   // 10/4: the archive hasn't got it yet; 10/6: forecast
    expect(m.rainFrom).toEqual(['archive', 'archive', 'forecast', 'forecast']);
    expect(mergeRain(w, null, '2026-10-05').daily.precipitation_sum).toEqual([67, 36.3, 1.5, 0]);   // archive down: as before
  });
});
