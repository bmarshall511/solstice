// B2-10 (idea I-06, code review C-14): the owner's settings are patched at a path in one SQL statement, so concurrent writers never
// lose each other's keys, and every change of pool.autopilot / ac.autopilot lands in a 50-entry ring (kv settings:changes). PGlite.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { kv, migrate } from '../../server/src/db.js';
import { patchSettings, changesBetween, changedKeys, SETTINGS_KEY, CHANGES_KEY, type SettingsChange } from '../../server/src/settings.js';
import { setPoolAutopilot } from '../../server/src/appliances/pool.js';

beforeAll(migrate);
beforeEach(async () => { await kv.set(SETTINGS_KEY, { pool: { autopilot: 'auto', turnoverGoal: 2 }, ac: { autopilot: 'auto', presence: 'home', dayF: 78 } }); await kv.set(CHANGES_KEY, []); });
const settings = () => kv.get<Record<string, any>>(SETTINGS_KEY);

describe('patchSettings', () => {
  it('ST-1 two interleaved writers keep both keys (the old whole-object write lost the first)', async () => {
    // writer A reads the settings, writer B changes presence, then A saves its own change: with the old read-modify-write A's
    // stale copy put presence back to home; a path patch leaves it alone
    const stale = await settings();
    await patchSettings(['ac', 'presence'], 'away', { by: 'presence' });
    await patchSettings(['ac'], changedKeys(stale!.ac, { ...stale!.ac, dayF: 77 }), { merge: true, by: 'you' });
    expect((await settings())!.ac).toEqual({ autopilot: 'auto', presence: 'away', dayF: 77 });
    // and at the same moment
    await Promise.all([patchSettings(['pool', 'turnoverGoal'], 3, { by: 'you' }), patchSettings(['ac', 'presence'], 'home', { by: 'presence' }), patchSettings(['powerwall', 'rules', 'export'], 'suggest', { by: 'you' })]);
    expect(await settings()).toEqual({ pool: { autopilot: 'auto', turnoverGoal: 3 }, ac: { autopilot: 'auto', presence: 'home', dayF: 77 }, powerwall: { rules: { export: 'suggest' } } });
  });
  it('ST-2 missing parents are created; merge keeps the other keys at the path; an empty path merges at the top', async () => {
    await kv.set(SETTINGS_KEY, null);
    await patchSettings(['powerwall', 'rules', 'reserve'], 'auto');
    expect(await settings()).toEqual({ powerwall: { rules: { reserve: 'auto' } } });
    await patchSettings(['powerwall'], { floorPct: 30 }, { merge: true });
    await patchSettings([], { theme: 'aurora' });
    expect(await settings()).toEqual({ powerwall: { rules: { reserve: 'auto' }, floorPct: 30 }, theme: 'aurora' });
    const r = await patchSettings(['powerwall', 'rules', 'reserve'], 'off');
    expect([r.before.powerwall.rules.reserve, r.after.powerwall.rules.reserve]).toEqual(['auto', 'off']);
    await expect(patchSettings(['a b'], 1)).rejects.toThrow('bad settings path');
    await expect(patchSettings([], 5)).rejects.toThrow('a merge needs an object');
  });
});

describe('the Autopilot change log (kv settings:changes)', () => {
  it('ST-3 a change of either Autopilot is recorded with when, from, to and who; other changes and no-ops are not', async () => {
    await setPoolAutopilot('suggest', 'outside edit');
    await patchSettings(['ac', 'dayF'], 76, { by: 'you' });                                  // not watched
    await patchSettings(['pool', 'autopilot'], 'suggest', { by: 'you' });                     // no change
    await patchSettings(['ac'], { autopilot: 'off', presence: 'away' }, { merge: true, by: 'you', now: 5 });
    const log = await kv.get<SettingsChange[]>(CHANGES_KEY);
    expect(log!.map(c => [c.path, c.from, c.to, c.by])).toEqual([['ac.autopilot', 'auto', 'off', 'you'], ['pool.autopilot', 'auto', 'suggest', 'outside edit']]);
    expect(log![0].at).toBe(5); expect(log![1].at).toEqual(expect.any(Number));
    expect(changesBetween({}, { pool: { autopilot: 'auto' } }, 'you', 1)).toEqual([{ at: 1, path: 'pool.autopilot', from: null, to: 'auto', by: 'you' }]);
  });
  it('ST-4 the ring keeps the newest 50, even when writers append at once', async () => {
    for (let i = 0; i < 26; i++) await patchSettings(['pool', 'autopilot'], i % 2 ? 'auto' : 'suggest', { by: `w${i}` });
    await Promise.all(Array.from({ length: 30 }, (_, i) => patchSettings(['ac', 'autopilot'], `m${i}`, { by: `c${i}` })));
    const log = await kv.get<SettingsChange[]>(CHANGES_KEY);
    expect(log).toHaveLength(50);
    expect(log!.filter(c => c.path === 'ac.autopilot')).toHaveLength(30);                     // none of the concurrent entries lost
    expect(log!.at(-1)!.by).toBe('w6');                                                        // the oldest six dropped
  });
});
