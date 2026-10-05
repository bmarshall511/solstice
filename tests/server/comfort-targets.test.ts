// Comfort targets (mockup ag, server/src/appliances/ac.ts withTargets / patchedAc / planFor): settings saved as a band carry over to the
// same plan; targets drive the plan once set; pre-cool Off skips the pre-cool and the coast.
import { describe, it, expect } from 'vitest';
import { planFor, withTargets, patchedAc, targetsOf, acSettingsOf, AC_DEFAULTS, type AcSettings } from '../../server/src/appliances/ac.js';
import { sunPeak } from '../fixtures/forecast.js';

const hot = (settings: AcSettings) => planFor({ date: '2026-07-15', high: 96, sunKwhM2: 6, hourlySun: sunPeak(13), settings, acKw: 2.016, slope: 2.5, rate: null, humidity: null });
const steps = (s: AcSettings) => hot(s).steps.map(x => [x.hour, x.coolF]);
const OWNER = { band: { homeLo: 76, homeHi: 80, nightLo: 76, nightHi: 77 } };   // the band set on 2026-10-05

describe('comfort targets', () => {
  it('CT-1 a saved band carries over to targets that give the same plan', () => {
    expect(targetsOf({})).toEqual({ dayF: 76, nightF: 76, driftF: 2, precoolDepth: 2 });           // the defaults: 74–78, night 74–76, coast 78
    expect(targetsOf(OWNER)).toEqual({ dayF: 78, nightF: 77, driftF: 0, precoolDepth: 2 });         // coastF 78 = the middle: no drift before ag
    expect(steps(acSettingsOf({ ac: OWNER }))).toEqual([[7, 78], [11, 76], [16, 78], [20, 78], [22, 77]]);
    expect(steps(AC_DEFAULTS)).toEqual([[7, 76], [11, 74], [16, 78], [20, 76], [22, 76]]);          // unchanged from tests/server/ac.test.ts
  });
  it('CT-2 targets drive the plan: day, night, pre-cool depth and the evening drift', () => {
    const s = { ...AC_DEFAULTS, dayF: 78, nightF: 77, driftF: 1, precoolDepth: 2 };
    expect(steps(s)).toEqual([[7, 78], [11, 76], [16, 79], [20, 78], [22, 77]]);
    expect(withTargets(s).band).toEqual({ homeLo: 76, homeHi: 79, nightLo: 77, nightHi: 77 });   // what the guards and trims read
    expect(steps({ ...s, precoolDepth: 0 })).toEqual([[7, 78], [21, 78], [22, 77]]);               // pre-cool Off: no pre-cool, no coast
    expect(hot({ ...s, precoolDepth: 0 }).precool).toBe(false);
  });
  it('CT-3 a target patch stores all four targets and the band they stand for', () => {
    const next = patchedAc({ ...OWNER, autopilot: 'auto' }, { driftF: 1 });
    expect(next).toMatchObject({ autopilot: 'auto', dayF: 78, nightF: 77, driftF: 1, precoolDepth: 2, coastF: 79, band: { homeLo: 76, homeHi: 79, nightLo: 77, nightHi: 77 } });
    expect(patchedAc(next, { dayF: 79 })).toMatchObject({ dayF: 79, nightF: 77, band: { homeLo: 77, homeHi: 80 } });
    expect(patchedAc(OWNER, { awayF: 82 })).toEqual({ ...OWNER, awayF: 82 });                       // other settings: no targets written
  });
});
