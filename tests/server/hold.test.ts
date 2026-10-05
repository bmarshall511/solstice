// Manual holds (server/src/appliances/hold.ts) and the owner's command guard (guards.ts guardManual): pure tables, no devices.
import { describe, it, expect } from 'vitest';
import { changed, ours, holdUntil, holdOver, morningAfter, HOLD_MIN_MS, HOLD_MAX_MS } from '../../server/src/appliances/hold.js';
import { guardManual } from '../../server/src/appliances/guards.js';

const at = (s: string) => new Date(`${s}-05:00`).getTime();   // Central daylight time
const STEPS = [{ hour: 7, why: 'morning' }, { hour: 21, why: 'evening' }, { hour: 22, why: 'night band' }];
const R = (mode: string, coolF: number | null, heatF: number | null = null, eco = false) => ({ mode, coolF, heatF, eco });

describe('hold timing', () => {
  it.each([
    ['13:05 runs to the 21:00 step (under 8 h)', '2026-07-15T13:05', '2026-07-15T21:00'],
    ['20:30 runs the 2-hour minimum, past 21:00 and 22:00', '2026-07-15T20:30', '2026-07-15T22:30'],
    ['07:30 is capped at 8 h', '2026-07-15T07:30', '2026-07-15T15:30'],
    ['23:00 runs to the 07:00 step tomorrow (exactly 8 h)', '2026-07-15T23:00', '2026-07-16T07:00'],
    ['03:00 runs to 07:00 today', '2026-07-15T03:00', '2026-07-15T07:00'],
  ])('%s', (_l, from, to) => {
    const u = holdUntil(at(from), STEPS, 7);
    expect(u.until).toBe(at(to));
    expect(u.until - at(from)).toBeGreaterThanOrEqual(HOLD_MIN_MS);
    expect(u.until - at(from)).toBeLessThanOrEqual(HOLD_MAX_MS);
  });
  it('Hold until morning: today\'s 07:00 before it, tomorrow\'s after', () => {
    expect(morningAfter(at('2026-07-15T03:00'), 7)).toBe(at('2026-07-15T07:00'));
    expect(morningAfter(at('2026-07-15T21:00'), 7)).toBe(at('2026-07-16T07:00'));
  });
  it('ends at its time, or when the house went Away after it began (not an Away from before)', () => {
    const h = { at: at('2026-07-15T13:00'), by: 'wall' as const, mode: 'COOL', coolF: 72, heatF: null, until: at('2026-07-15T21:00'), why: '' };
    expect(holdOver(h, at('2026-07-15T20:59'), { state: 'home', since: null })).toBeNull();
    expect(holdOver(h, at('2026-07-15T21:00'), { state: 'home', since: null })).toBe('ended');
    expect(holdOver(h, at('2026-07-15T14:00'), { state: 'away', since: at('2026-07-15T13:30') })).toBe('away');
    expect(holdOver(h, at('2026-07-15T14:00'), { state: 'away', since: at('2026-07-15T12:00') })).toBeNull();
  });
});

describe('change detection', () => {
  it('a setpoint or mode move is a change; rounding and Eco are not', () => {
    expect(changed(R('COOL', 76), R('COOL', 72))).toBe(true);
    expect(changed(R('COOL', 76), R('HEAT', null, 68))).toBe(true);
    expect(changed(R('COOL', 76), R('COOL', 76.3))).toBe(false);
    expect(changed(R('COOL', 76), R('COOL', null, null, true))).toBe(false);
    expect(changed(null, R('COOL', 72))).toBe(false);
  });
  it('a reading that shows what Solstice sent in the last 45 minutes is ours', () => {
    const now = at('2026-07-15T13:00'), sent = { at: now - 10 * 60_000, by: 'autopilot' as const, mode: 'COOL', coolF: 78, heatF: null };
    expect(ours(R('COOL', 78), sent, now)).toBe(true);
    expect(ours(R('COOL', 74), sent, now)).toBe(false);
    expect(ours(R('COOL', 78), { ...sent, at: now - 60 * 60_000 }, now)).toBe(false);
    expect(ours(R('COOL', 78), null, now)).toBe(false);
  });
});

describe('guardManual: the owner\'s own commands', () => {
  const COOL = { mode: 'COOL', availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] };
  it.each([
    [{ kind: 'cool', f: 65 }, COOL, true], [{ kind: 'cool', f: 85 }, COOL, true], [{ kind: 'cool', f: 64 }, COOL, false], [{ kind: 'cool', f: 86 }, COOL, false],
    [{ kind: 'cool', f: 72.3 }, COOL, false], [{ kind: 'cool', f: 72.5 }, COOL, true], [{ kind: 'heat', f: 68 }, COOL, false],
    [{ kind: 'heat', f: 55 }, { ...COOL, mode: 'HEAT' }, true], [{ kind: 'heat', f: 81 }, { ...COOL, mode: 'HEAT' }, false],
    [{ kind: 'range', heatF: 68, coolF: 76 }, { ...COOL, mode: 'HEATCOOL' }, true], [{ kind: 'range', heatF: 74, coolF: 76 }, { ...COOL, mode: 'HEATCOOL' }, false],
    [{ kind: 'cool', f: 76 }, { ...COOL, eco: true }, false],
    [{ kind: 'mode', mode: 'OFF' }, COOL, true], [{ kind: 'mode', mode: 'ECO' }, COOL, false], [{ kind: 'mode', mode: 'HEATCOOL' }, { mode: 'COOL', availableModes: ['COOL', 'OFF'] }, false],
    [{ kind: 'eco', on: true }, COOL, true], [{ kind: 'fan', seconds: 3600 }, COOL, true], [{ kind: 'fan', seconds: 0 }, COOL, true], [{ kind: 'fan', seconds: 50_000 }, COOL, false],
    [{ kind: 'nope' }, COOL, false],
  ] as const)('%j in %j → %s', (cmd, st, ok) => {
    expect(guardManual(cmd as any, st as any).ok).toBe(ok);
  });
});

import { acPatchError, bandSuggestion, bandFor, precoolDecision, AC_DEFAULTS, type HoldRecord } from '../../server/src/appliances/ac.js';
import { bandMid } from '../../server/src/learn/ac.js';

describe('AC settings patches (the band sheet)', () => {
  it.each([
    [{ band: { homeLo: 73, homeHi: 77 } }, null],
    [{ band: { homeLo: 79 } }, 'each low must be at or below its high'],
    [{ band: { nightHi: 90 } }, 'band temperatures must be whole degrees 65–85°'],
    [{ band: { homeLo: 74.5 } }, 'band temperatures must be whole degrees 65–85°'],
    [{ band: { extra: 1 } }, 'band has unknown keys'],
    [{ awayF: 82, nightFrom: 22, nightTo: 7 }, null],
    [{ awayF: 90 }, 'away must be a whole degree 65–85°'],
    [{ nightFrom: 12 }, 'night starts between 18:00 and 23:00'],
    [{ nightTo: 13 }, 'night ends between 4:00 and 11:00'],
    [{ autopilot: 'auto' }, null], [{ autopilot: 'yes' }, 'bad mode'],
    [{ precoolDepth: 9 }, 'unknown setting precoolDepth'],
  ])('%j → %s', (patch, err) => { expect(acPatchError(patch as any, {})).toBe(err); });
});

describe('band suggestion from repeated holds (frame 7)', () => {
  const S = { ...AC_DEFAULTS, band: { ...AC_DEFAULTS.band } };
  const H = (day: string, hour: number, coolF: number, planF = 76): HoldRecord => ({ at: 0, day, hour, coolF, planF });
  it('4 of the last 7 nights at 74° around 10 PM suggest a 74° night setpoint', () => {
    const sg = bandSuggestion([H('2026-10-04', 22.1, 74), H('2026-10-03', 21.6, 74), H('2026-10-01', 22.5, 73), H('2026-09-29', 21.9, 74), H('2026-10-02', 15, 78)], S, '2026-10-04');
    expect(sg).toMatchObject({ key: 'night:74', window: 'night', f: 74, days: 4, from: 76 });
  });
  it('3 days, mixed directions, or older than a week: nothing', () => {
    expect(bandSuggestion([H('2026-10-04', 22, 74), H('2026-10-03', 22, 74), H('2026-10-01', 22, 74)], S, '2026-10-04')).toBeNull();
    expect(bandSuggestion([H('2026-10-04', 22, 74), H('2026-10-03', 22, 74), H('2026-10-01', 22, 78, 76), H('2026-09-30', 22, 79)], S, '2026-10-04')).toBeNull();
    expect(bandSuggestion([H('2026-10-04', 22, 74), H('2026-10-03', 22, 74), H('2026-10-01', 22, 74), H('2026-09-20', 22, 74)], S, '2026-10-04')).toBeNull();
  });
  it('the band it sets makes the plan use exactly that value', () => {
    const night = (b: typeof S.band) => Math.max(b.nightLo, Math.min(b.nightHi, bandMid({ ...S, band: b })));
    for (const f of [70, 74, 75, 76, 78, 80]) expect(night(bandFor({ window: 'night', f }, S.band))).toBe(f);
    for (const f of [72, 75, 77, 80]) expect(bandMid({ ...S, band: bandFor({ window: 'day', f }, S.band) })).toBe(f);
  });
});

describe('pre-cool on spare solar: start at a full AC, keep at half', () => {
  it.each([[null, false, false], [1800, false, true], [1000, false, false], [1000, true, true], [800, true, false]] as const)
  ('spare %s W, already on %s → %s', (spareW, on, want) => { expect(precoolDecision({ spareW, acKw: 1.8, on })).toBe(want); });
});
