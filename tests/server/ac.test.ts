// AC comfort plan (planFor) and stepAt: design §8, cases 17–21.
import { describe, it, expect } from 'vitest';
import { planFor, stepAt, AC_DEFAULTS, type AcSettings } from '../../server/src/appliances/ac.js';
import { sunPeak } from '../fixtures/forecast.js';

const AC: AcSettings = AC_DEFAULTS;
const sun13 = sunPeak(13), sun14 = sunPeak(14);
const plan = (o: { high?: number; sunKwhM2?: number; hourlySun?: number[]; settings?: Partial<AcSettings>; slope?: number; humidity?: number | null } = {}) =>
  planFor({ date: '2026-07-15', high: o.high ?? 96, sunKwhM2: o.sunKwhM2 ?? 6, hourlySun: o.hourlySun ?? sun13, settings: { ...AC, ...o.settings },
    acKw: 2.016, slope: o.slope ?? 2.5, rate: .1064, humidity: o.humidity ?? null });
const steps = (p: ReturnType<typeof plan>) => p.steps.map(s => [s.hour, s.coolF]);

describe('AC planFor', () => {
  it('uses the default comfort band', () => {
    expect(AC).toEqual({ band: { homeLo: 74, homeHi: 78, nightLo: 74, nightHi: 76 }, awayF: 80, nightFrom: 22, nightTo: 7, precoolDepth: 2, coastF: 78,
      maxStepF: 2, humidityCap: 60, autopilot: 'suggest', presence: 'home' });
  });

  it('17: a hot, sunny day pre-cools 11–16 and coasts to 20:00', () => {
    const p = plan();
    expect(steps(p)).toEqual([[7, 76], [11, 74], [16, 78], [20, 76], [22, 76]]);
    expect([p.precool, p.precoolFrom, p.precoolTo, p.coastFrom, p.coastTo]).toEqual([true, 11, 16, 16, 20]);
    // the learning layer's two figures (owner question 22; learn/ac.ts acSavings): slope 2.5 kWh/°F over 12 cooling hours is
    // 0.208 kWh per °F-hour; 2° below the 76° middle for 11–16 is 2.1 kWh shifted onto solar, 2° above it for 16–20 is 1.7 kWh avoided
    expect([p.shiftedKwh, p.eveningAvoidedKwh, p.control]).toEqual([2.1, 1.7, false]);
    expect(p.why).toEqual([
      'Pre-cool to 74° from 11:00 to 16:00 while the panels peak (6 kWh/m² of sun, high 96°)',
      'Coast to 78° until 20:00 so the batteries carry a lighter evening',
    ]);
    expect(p.steps.map(s => s.why)).toEqual(['morning, comfort band', 'pre-cool on solar surplus', 'coast on the Powerwalls', 'evening, comfort band', 'night band']);
  });

  it('17: the plan keeps the shape web/src/views/ac.js reads', () => {
    expect(Object.keys(plan())).toEqual(['date', 'steps', 'precool', 'precoolFrom', 'precoolTo', 'coastFrom', 'coastTo', 'high', 'sunKwhM2', 'shiftedKwh', 'eveningAvoidedKwh', 'control', 'why']);
  });

  it('18: a heat wave (high 101, peak at 14:00) starts the pre-cool step at 11:00', () => {
    const p = plan({ high: 101, hourlySun: sun14 });
    expect(steps(p)).toEqual([[7, 76], [11, 74], [17, 78], [21, 76], [22, 76]]);
    expect(p.coastTo).toBe(21);
    expect(p.why[2]).toBe('Heat wave: pre-cool starts at 11:00 so the system never falls behind');
  });
  // BUG-8 · fixed: the step moved to 11:00 but precoolFrom stayed 12 and the text said "from 12:00 to 17:00". The pre-cool
  // window now starts at 11:00 on a heat-wave day, so the step, precoolFrom, the text and the savings use the same hours.
  it('BUG-8: in a heat wave precoolFrom and the text agree with the 11:00 step', () => {
    const p = plan({ high: 101, hourlySun: sun14 });
    expect(p.precoolFrom).toBe(11);
    expect(p.why[0]).toContain('from 11:00');
    expect([p.kwhSaved, p.costSavedMonth]).toEqual([.3, 1]);   // six pre-cool hours, not five: was [.6, 2]
  });

  it('19: no pre-cool on a mild day, a cloudy day or a humid day', () => {
    const mild = plan({ high: 85 });
    expect(steps(mild)).toEqual([[7, 76], [21, 76], [22, 76]]);
    expect(mild.why).toEqual(['Mild day (high 85°): no pre-cool needed']);
    expect(plan({ sunKwhM2: 4 }).why).toEqual(['Cloudy: no solar surplus to pre-cool with']);
    const humid = plan({ humidity: 65 });
    expect(humid.why).toEqual(['Humidity 65%: no coast, holding 76°']);
    expect([mild.precool, humid.precool, mild.shiftedKwh, mild.eveningAvoidedKwh]).toEqual([false, false, 0, 0]);
  });
  it('19: the boundary (high 88, sun 4.5 kWh/m²) pre-cools', () => {
    expect(plan({ high: 88, sunKwhM2: 4.5 }).precool).toBe(true);
  });

  it('20: marked away holds the away setpoint all day', () => {
    const p = plan({ settings: { presence: 'away' } });
    expect(p.steps).toEqual([{ hour: 0, coolF: 80, why: 'marked away' }]);
    expect([p.precool, p.coastTo, p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([false, 21, 0, 0]);
    expect(p.why).toEqual(['Away: holding 80° until you mark Home']);
    expect(stepAt(p, 5).coolF).toBe(80);
  });
  it('20: a narrow band (72–73, night 70–72) stays inside the band and never claims negative savings', () => {
    const p = plan({ settings: { band: { homeLo: 72, homeHi: 73, nightLo: 70, nightHi: 72 } } });
    expect(steps(p)).toEqual([[7, 73], [11, 72], [16, 73], [20, 73], [22, 72]]);
    expect([p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([1, 0]); // 1° of pre-cool for 5 h; the coast can't rise above 73°
  });
  it('20: savings scale with the heat-model slope', () => {
    const p = plan({ slope: 4 });
    expect([p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([3.3, 2.7]);
  });
  it('a control day (learning layer) plans the plain comfort band on a pre-cool day and says why', () => {
    const p = planFor({ date: '2026-07-15', high: 96, sunKwhM2: 6, hourlySun: sun13, settings: AC, acKw: 2.016, slope: 2.5, rate: .1064, humidity: null, control: true });
    expect(steps(p)).toEqual([[7, 76], [21, 76], [22, 76]]);
    expect([p.precool, p.control, p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([false, true, 0, 0]);
    expect(p.why).toEqual(['Control day: holding the comfort band (1 in 5 hot, sunny days) so Solstice can measure what pre-cooling saves']);
  });
});

describe('stepAt', () => {
  it('21: returns the last step at or before the hour, wrapping to the night step before the first one', () => {
    const p = plan();
    const hours = [0, 3, 6, 7, 10, 11, 15, 16, 19, 20, 21, 22, 23];
    expect(hours.map(h => stepAt(p, h).hour)).toEqual([22, 22, 22, 7, 7, 11, 11, 16, 16, 20, 20, 22, 22]);
    expect(hours.map(h => stepAt(p, h).coolF)).toEqual([76, 76, 76, 76, 76, 74, 74, 78, 78, 76, 76, 76, 76]);
  });
});
