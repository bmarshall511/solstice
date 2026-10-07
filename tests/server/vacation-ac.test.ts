// Vacation mode, the AC's pure parts (server/src/vacation/ac.ts and guards.ts; mockup ak, owner's answers 2026-10-06). No database.
//   VA-1 the trip's heat guard: away heat 50–60 °F reached in 2 °F steps from above, your own setting restored in one write (50–80)
//   VA-2 Eco is turned off only for a trip under way, never with AC Autopilot Off
//   VA-3 the humidity steps (2 h over 60% up, 1 h under 55% down, floor 80°) and the away heat (55°, never raised)
//   VA-4 the welcome: the arrival hour's target, this house's measured rate, the lead, and up to 3 h early on spare solar from 11:00
//   VA-5 the target in each phase: away holds, the welcome and the 2 h after arrival aim at your target, late holds again
import { describe, it, expect } from 'vitest';
import { guardHeatSetpoint, guardTripEco, AC_WRITE_INTERVAL_MS } from '../../server/src/appliances/guards.js';
import { holdF, awayHeatF, humidStep, arrivalTarget, pulldownRate, welcomeLeadH, welcomeStart, tripTarget, freshTripAc } from '../../server/src/vacation/ac.js';

const NOW = Date.parse('2026-07-15T13:00:00-05:00'), H = 3600_000, MIN = 60_000;

describe('guards', () => {
  const g = (o: Partial<Parameters<typeof guardHeatSetpoint>[0]>) => guardHeatSetpoint({ mode: 'auto', targetF: 55, currentF: 68, lastWriteAt: null, now: NOW, ...o });
  it.each([
    ['a 2° step down toward 55', { valueF: 66 }, true, 66],
    ['the last step lands on 55', { valueF: 55, currentF: 56 }, true, 55],
    ['more than 2° at once is refused', { valueF: 64 }, false, null],
    ['a step away from the target is refused', { valueF: 70 }, false, null],
    ['an away target above 60 is refused', { targetF: 62, valueF: 66 }, false, null],
    ['an away target below 50 is refused', { targetF: 48, valueF: 66 }, false, null],
    ['restore your 68° in one write', { targetF: 68, valueF: 68, currentF: 55, restore: true }, true, 68],
    ['a restore above 80 is refused', { targetF: 82, valueF: 82, currentF: 55, restore: true }, false, null],
    ['Off writes nothing', { mode: 'off', valueF: 66 }, false, null],
    ['one write per 30 min', { valueF: 66, lastWriteAt: NOW - AC_WRITE_INTERVAL_MS + 1 }, false, null],
    ['unknown current setpoint', { valueF: 66, currentF: null }, false, null],
  ] as const)('VA-1 %s', (_c, o, ok, value) => { const v = g(o as any); expect(v.ok).toBe(ok); expect(v.value).toBe(value); });
  it('VA-2 Eco off only for a trip under way, never with Autopilot Off', () => {
    expect(guardTripEco({ mode: 'auto', tripAway: true }).ok).toBe(true);
    expect(guardTripEco({ mode: 'suggest', tripAway: true }).ok).toBe(true);
    expect(guardTripEco({ mode: 'auto', tripAway: false })).toMatchObject({ ok: false, reason: 'Eco is only turned off for Vacation mode, while a trip is under way' });
    expect(guardTripEco({ mode: 'off', tripAway: true })).toMatchObject({ ok: false, reason: 'autopilot_off' });
  });
});

describe('the trip AC, pure', () => {
  it('VA-3 humidity steps and the away heat', () => {
    expect([0, 1, 2, 3, 9].map(holdF)).toEqual([85, 83, 81, 80, 80]);
    expect([null, 68, 55, 52, 45].map(awayHeatF)).toEqual([55, 55, 55, 52, 50]);
    const rh = (v: number, hours: number, every = 15) => Array.from({ length: Math.floor(hours * 60 / every) + 1 }, (_, i) => ({ ts: NOW - hours * H + i * every * MIN, rh: v }));
    expect(humidStep(0, rh(63, 2), NOW, null)).toEqual({ level: 1, why: 'Humidity 63–63% for 2 h: holding 83° to dry the house' });
    expect(humidStep(0, rh(63, 1.5), NOW, null).level).toBe(0);                                   // not 2 h yet
    expect(humidStep(0, [...rh(63, 2).slice(0, -1), { ts: NOW, rh: 59 }], NOW, null).level).toBe(0);   // one dry reading
    expect(humidStep(1, rh(63, 2), NOW, NOW - 90 * MIN).level).toBe(1);                         // the last step is under 2 h old
    expect(humidStep(3, rh(70, 2), NOW, null).level).toBe(3);                                    // 80° is the floor
    expect(humidStep(2, rh(50, 1), NOW, NOW - 2 * H)).toEqual({ level: 1, why: 'Humidity under 55%: back up to 83°' });
    expect(humidStep(0, rh(50, 1), NOW, null).level).toBe(0);
    expect(humidStep(1, rh(57, 1), NOW, null).level).toBe(1);                                    // 55–60%: stays
  });
  it('VA-4 the welcome: target, rate, lead and the spare-solar start', () => {
    const s = { dayF: 78, nightF: 77, nightFrom: 22, nightTo: 7 };
    expect(arrivalTarget(Date.parse('2026-07-15T18:00:00-05:00'), s)).toBe(78);
    expect(arrivalTarget(Date.parse('2026-07-15T23:30:00-05:00'), s)).toBe(77);
    expect(arrivalTarget(Date.parse('2026-07-16T06:00:00-05:00'), s)).toBe(77);
    expect([pulldownRate([], 97), pulldownRate([], 90), pulldownRate([], 80), pulldownRate([], null)]).toEqual([1.4, 1.6, 2, 2]);
    expect(pulldownRate([{ high: 95, rate: 1.8 }, { high: 96, rate: 2.2 }, { high: 80, rate: 3 }], 94)).toBe(2.2);
    expect(welcomeLeadH(85, 78, 1.4)).toBe(5.5);                                                 // 7° at 1.4°/h + half an hour
    expect(welcomeLeadH(76, 78, 2)).toBe(.5);
    const back = Date.parse('2026-07-15T18:00:00-05:00');
    expect(welcomeStart({ backAt: back, leadH: 4, now: back - 4.5 * H, spare: false })).toBeNull();
    expect(welcomeStart({ backAt: back, leadH: 4, now: back - 4 * H, spare: false })).toEqual({ startAt: back - 4 * H, solar: false });
    expect(welcomeStart({ backAt: back, leadH: 4, now: back - 6.5 * H, spare: true })).toEqual({ startAt: back - 6.5 * H, solar: true });   // 11:30, full Powerwalls
    expect(welcomeStart({ backAt: back, leadH: 4, now: back - 7.5 * H, spare: true })).toBeNull();                                     // 10:30: before 11:00
    expect(welcomeStart({ backAt: back, leadH: 1, now: back - 4.5 * H, spare: true })).toBeNull();                                     // more than 3 h early
  });
  it('VA-5 the target by phase', () => {
    const ac = { ...freshTripAc({ coolF: 78, heatF: 68 }), humid: 1 };
    expect(tripTarget({ phase: 'away', ac, target: 78 })).toEqual({ coolF: 83, heatF: 55, why: 'vacation: drying the house', welcome: false });
    expect(tripTarget({ phase: 'away', ac: { ...ac, welcome: { startAt: 1, fromF: 85, target: 78, solar: true } }, target: 78 }))
      .toEqual({ coolF: 78, heatF: 68, why: 'welcome home, on spare solar', welcome: true });
    expect(tripTarget({ phase: 'due', ac, target: 77 })).toMatchObject({ coolF: 77, heatF: 68, welcome: true });
    expect(tripTarget({ phase: 'late', ac, target: 78 })).toEqual({ coolF: 83, heatF: 55, why: 'not back yet: holding the trip setting', welcome: false });
  });
});
