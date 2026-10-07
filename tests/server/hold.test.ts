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
    // Vacation mode turned Eco off: the setpoint comes back in the same mode (not a person), while a mode change still counts
    expect(changed(R('COOL', null), R('COOL', 78))).toBe(false);
    expect(changed(R('OFF', null), R('COOL', 78))).toBe(true);
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

import { acPatchError, bandSuggestion, suggestionPatch, withTargets, precoolDecision, AC_DEFAULTS, type HoldRecord } from '../../server/src/appliances/ac.js';
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
    [{ precoolDepth: 9 }, 'pre-cool must be 0–3°'], [{ precoolDepth: 3 }, null],
    // mockup ag: the comfort targets
    [{ dayF: 78, nightF: 77 }, null], [{ dayF: 90 }, 'day target must be a whole degree 65–85°'], [{ nightF: 76.5 }, 'night target must be a whole degree 65–85°'],
    [{ driftF: 3 }, 'evening drift must be 0–2°'], [{ dayF: 84, driftF: 2 }, 'pre-cool and drift must stay inside 65–85°'], [{ dayF: 66, precoolDepth: 2 }, 'pre-cool and drift must stay inside 65–85°'],
  ])('%j → %s', (patch, err) => { expect(acPatchError(patch as any, {})).toBe(err); });
});

describe('target suggestion from repeated holds (frame 7; grouped by part of the day and direction since mockup ag)', () => {
  const S = { ...AC_DEFAULTS, band: { ...AC_DEFAULTS.band } };
  const H = (day: string, hour: number, coolF: number, planF = 76): HoldRecord => ({ at: 0, day, hour, coolF, planF });
  it('4 of the last 7 nights cooler than the 76° night target suggest 75° (one degree that way)', () => {
    const sg = bandSuggestion([H('2026-10-04', 22.1, 74), H('2026-10-03', 23.6, 74), H('2026-10-01', 22.5, 73), H('2026-09-29', 0.9, 74), H('2026-10-02', 15, 78)], S, '2026-10-04');
    expect(sg).toMatchObject({ key: 'night:75', window: 'night', f: 75, days: 4, from: 76 });
  });
  it('3 days, mixed directions, or older than a week: nothing', () => {
    expect(bandSuggestion([H('2026-10-04', 22, 74), H('2026-10-03', 22, 74), H('2026-10-01', 22, 74)], S, '2026-10-04')).toBeNull();
    expect(bandSuggestion([H('2026-10-04', 22, 74), H('2026-10-03', 22, 74), H('2026-10-01', 22, 78, 76), H('2026-09-30', 22, 79)], S, '2026-10-04')).toBeNull();
    expect(bandSuggestion([H('2026-10-04', 22, 74), H('2026-10-03', 22, 74), H('2026-10-01', 22, 74), H('2026-09-20', 22, 74)], S, '2026-10-04')).toBeNull();
  });
  it('the target it sets is exactly what the plan uses', () => {
    for (const f of [70, 74, 75, 76, 78, 80]) expect(withTargets({ ...S, ...suggestionPatch({ window: 'night', f }) }).nightF).toBe(f);
    for (const f of [72, 75, 77, 80]) expect(bandMid(withTargets({ ...S, ...suggestionPatch({ window: 'day', f }) }))).toBe(f);
  });
});

describe('pre-cool on spare solar: start at a full AC, keep at half', () => {
  it.each([[null, false, false], [1800, false, true], [1000, false, false], [1000, true, true], [800, true, false]] as const)
  ('spare %s W, already on %s → %s', (spareW, on, want) => { expect(precoolDecision({ spareW, acKw: 1.8, on })).toBe(want); });
});

import { acStepsFrom } from '../../server/src/appliances/ac.js';
describe('AC draw from clean on/off switches (v2)', () => {
  // a synthetic afternoon: 1.5 kW base, a 4.3 kW AC that cycles 40 min on / 30 min off; switches land between 5-minute samples
  const B = 300_000, t0 = Date.UTC(2026, 6, 15, 18), BASE = 1.5, AC = 4.3;
  const onAt = (t: number) => { const c = (t - t0 - 7 * 60_000) % (70 * 60_000); return c >= 0 && c < 40 * 60_000; };
  const kwAt = (start: number) => { let wh = 0; for (let s = 0; s < 300; s++) wh += (BASE + (onAt(start + s * 1000) ? AC : 0)) / 3600; return wh * 12; };   // bucket mean kW
  const rows = Array.from({ length: 96 }, (_, i) => ({ ts: t0 + i * B + 60_000, hvac: onAt(t0 + i * B + 60_000) ? 'COOLING' : 'OFF' }));
  it('recovers the full draw (4.3 kW), not the diluted half the v1 buckets gave', () => {
    const r = acStepsFrom(rows, kwAt);
    expect(r.samples).toBeGreaterThanOrEqual(5);
    expect(r.coolKw!).toBeCloseTo(AC, 1);
  });
  it('ignores short cycling (a state that did not hold for a reading on each side)', () => {
    const blip = [{ ts: 0, hvac: 'OFF' }, { ts: B, hvac: 'OFF' }, { ts: 2 * B, hvac: 'COOLING' }, { ts: 3 * B, hvac: 'OFF' }, { ts: 4 * B, hvac: 'OFF' }];
    expect(acStepsFrom(blip, () => 3).samples).toBe(0);
  });
});
