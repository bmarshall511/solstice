// Learning from your changes (mockup ae): the pool's records and suggestions (server/src/appliances/poolLearn.ts), the planner's chosen
// skim hour, and the AC's pattern progress (changePatterns). Synthetic data on PGlite; nothing touches a device.
import { describe, it, expect, beforeAll } from 'vitest';
import { kv, migrate } from '../../server/src/db.js';
import { noteYouRun, endYouRun, noteOutsideRun, poolChanges, dismissPoolSuggestion } from '../../server/src/appliances/poolLearn.js';
import { planFor, powerModel, POOL_DEFAULTS } from '../../server/src/appliances/pool.js';
import { changePatterns, bandSuggestion, wholeF, setting, type HoldRecord } from '../../server/src/appliances/ac.js';
import { BELL } from '../fixtures/forecast.js';

const T = (d: string, hm: string) => Date.parse(`2026-10-${d}T${hm}:00-05:00`), NOW = T('05', '18:00');
beforeAll(async () => { await migrate(); });

describe('pool learning', () => {
  it('PL-1 an outside run is not counted during a Clear-up, a spare-solar speed-up or a run you started in the app', async () => {
    await kv.set('o:pool:clearup', { until: NOW + 3600e3 }); expect(await noteOutsideRun('o', NOW)).toBe(false);
    await kv.set('o:pool:clearup', null); await kv.set('o:pool:spare', { until: NOW + 600e3 }); expect(await noteOutsideRun('o', NOW)).toBe(false);
    await kv.set('o:pool:spare', { until: 0 }); await kv.set('o:pool:until', { 8: NOW + 600e3 }); expect(await noteOutsideRun('o', NOW)).toBe(false);
    await kv.set('o:pool:until', {}); expect(await noteOutsideRun('o', NOW)).toBe(true);
    // a run covered by a run-once schedule on the controller is kept apart from a person's run (shown as "Run-once schedule on the controller")
    expect(await noteOutsideRun('o', NOW + 3600e3, { runOnce: true })).toBe(true);
    const kinds = (await poolChanges('o', { goal: 3, skimAt: null }, NOW + 3600e3)).recent.map(r => r.kind);
    expect(kinds).toEqual(['runOnce', 'outside']);
  });
  it('PL-2 boosts around 4 PM on 4 of 7 days suggest moving the skim hour; not once it is there; "Not now" hides it 14 days', async () => {
    for (const d of ['01', '02', '04', '05']) await noteYouRun('s', { id: 8, minutes: 60, boost: true }, T(d, d === '02' ? '15:30' : '16:10'));
    const c = await poolChanges('s', { goal: 3, skimAt: null }, NOW);
    expect(c.patterns.skim).toEqual({ hour: 16, days: 4, need: 4 });
    expect(c.suggestions.find(x => x.kind === 'skim')).toEqual({ key: 'skim:16', kind: 'skim', days: 4, of: 7, hour: 16, from: null });
    expect(c.suggestions.map(x => x.kind)).toEqual(['skim', 'goal']);                              // four 1 h boosts are also an hour of extra pump time a day
    expect((await poolChanges('s', { goal: 3, skimAt: 16 }, NOW)).suggestions.map(x => x.kind)).toEqual(['goal']);
    await dismissPoolSuggestion('s', 'skim:16', NOW);
    expect((await poolChanges('s', { goal: 3, skimAt: null }, NOW + 864e5)).suggestions.map(x => x.kind)).toEqual(['goal']);
    expect((await poolChanges('s', { goal: 3, skimAt: null }, NOW + 15 * 864e5)).suggestions).toEqual([]);   // and the boosts are now too old
  });
  it('PL-3 an hour or more of extra pump time on 4 of 7 days suggests half a turnover more (never past 4)', async () => {
    for (const d of ['01', '02', '03']) await noteYouRun('g', { id: 6, minutes: 90, boost: false }, T(d, '20:00'));
    await noteOutsideRun('g', T('04', '22:05'));                                                  // a run started in the Pentair app: 1 h
    const c = await poolChanges('g', { goal: 3, skimAt: null }, NOW);
    expect(c.patterns.goal).toEqual({ days: 4, need: 4, extraMin: 83 });                           // (90 × 3 + 60) / 4
    expect(c.suggestions.map(s => [s.key, s.to])).toEqual([['goal:3.5', 3.5]]);
    expect((await poolChanges('g', { goal: 4, skimAt: null }, NOW)).suggestions).toEqual([]);
    expect(c.recent.map(r => r.kind)).toEqual(['outside', 'run', 'run', 'run']);
  });
  it('PL-4 a run you turn off early counts only the minutes it ran', async () => {
    await noteYouRun('e', { id: 8, minutes: 120, boost: true }, T('05', '10:00'));
    await endYouRun('e', 8, T('05', '10:25'));
    expect((await poolChanges('e', { goal: 3, skimAt: null }, NOW)).recent[0]).toMatchObject({ kind: 'boost', minutes: 25 });
  });
  it('PL-5 the planner puts the skim at the hour you chose (inside the run), else the sunniest hour', () => {
    const p = (skimAt: number | null) => planFor({ waterTemp: 80, solarKw: BELL, settings: { ...POOL_DEFAULTS, skimAt }, W: powerModel([]), rate: null, month: 9, names: new Map() });
    expect(p(null).boostAt).toBe(12);
    expect(p(16).boostAt).toBe(16);
    expect(p(22).boostAt).toBe(18);                                                               // the run ends at 19: the last hour inside it
  });
});

describe('AC: the patterns behind a suggestion (mockup ae)', () => {
  const S = { band: { homeLo: 74, homeHi: 78, nightLo: 74, nightHi: 76 }, nightFrom: 22, nightTo: 7 } as any;
  const h = (day: string, hour: number, coolF: number, planF = 76): HoldRecord => ({ at: T(day, '07:00'), day: `2026-10-${day}`, hour, coolF, planF });
  it('AC-L1 two mornings warmer than the plan make a pattern at 2 of 4; no suggestion until 4 (then the day target + 1°)', () => {
    const two = [h('04', 7, 77.9), h('05', 8.1, 77.2)];   // mockup ag: 7:00 and 8:06 now count together (same part of the day, same direction)
    expect(changePatterns(two, S, '2026-10-05')).toMatchObject([{ f: 77, from: 76, planF: 76, dir: 1, days: 2, window: 'day', set: [78, 77] }]);
    expect(bandSuggestion(two, S, '2026-10-05')).toBeNull();
    const four = [...two, h('02', 7, 78), h('03', 7.5, 78)];
    expect(bandSuggestion(four, S, '2026-10-05')).toMatchObject({ f: 77, days: 4, window: 'day' });
    expect(changePatterns(four, { ...S, dayF: 78, nightF: 77, driftF: 1 }, '2026-10-05')).toEqual([]);   // once the target is 78°, those changes are not warmer than it
  });
  it('AC-L2 setpoints read back from Celsius show as whole degrees, as on the thermostat', () => {
    expect([wholeF(77.9), wholeF(76.8), wholeF(null)]).toEqual([78, 77, null]);
    expect(setting({ mode: 'COOL', coolF: 77.9, heatF: null })).toBe('78°');
  });
});
