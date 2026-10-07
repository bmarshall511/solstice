// Clear-up (mockup w frame 6) on PGlite with ScreenLogic replaced by recorders: the all-day program through the guarded write, the end
// at the evening pool run, Autopilot holding off while it runs (whatever the mode), Add a day, and End now handing back to the planner.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { kv, migrate } from '../../server/src/db.js';
import { autopilot } from '../../server/src/appliances/autopilot.js';
import { startClearUp, extendClearUp, endClearUp, finishClearUpIfDue, activeClearUp, clearUpError, poolRunAfter, powerModel, POOL_DEFAULTS, scheduleError, saveSchedule, rebaseline, applyPlan, writingKey } from '../../server/src/appliances/pool.js';
import { readPool, writePoolPlan } from '../../server/src/appliances/screenlogic.js';
import { forecastDays } from '../fixtures/forecast.js';
import { poolSnapshot, CIRCUITS } from '../fixtures/screenlogic.js';
import { localDay } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => true, readPool: vi.fn(), writePoolPlan: vi.fn(async () => ({ removed: [], added: [21] })),
  withUnit: vi.fn(async () => { throw new Error('withUnit in clear-up test'); }), writeOwnerPool: vi.fn(),
}));
const MON_9AM = Date.parse('2026-10-05T14:00:00Z');   // Monday 09:00 CDT
const NAMES = new Map(CIRCUITS.map(c => [c.id, c.name]));

beforeAll(async () => { vi.useFakeTimers({ toFake: ['Date'], now: MON_9AM }); await migrate(); });
beforeEach(async () => {
  vi.setSystemTime(MON_9AM);
  vi.mocked(readPool).mockImplementation(async () => poolSnapshot(Date.now()));
  vi.mocked(writePoolPlan).mockClear();
  await kv.set('pool:forecast', { at: Date.now(), days: forecastDays(localDay()) });
});

describe('Clear-up', () => {
  it('CU-1 requests: 1–3 days at 1,500–3,000 RPM in 50s; it ends at the evening pool run after the last full day', () => {
    expect(clearUpError({ days: 2, rpm: 2000 })).toBeNull();
    for (const b of [{ days: 0, rpm: 2000 }, { days: 4, rpm: 2000 }, { days: 2, rpm: 1450 }, { days: 2, rpm: 3050 }, { days: 2, rpm: 2025 }]) expect(clearUpError(b), JSON.stringify(b)).not.toBeNull();
    // Monday 09:00 + 2 days = Wednesday 09:00; the next 01:15 UTC run is Wednesday 20:15 CDT (the mockup's "ends Wed 8:15 PM")
    expect(new Date(poolRunAfter(MON_9AM + 2 * 864e5)).toISOString()).toBe('2026-10-08T01:15:00.000Z');
  });
  it('CU-2 start: one all-day Pool program at the chosen speed replaces the Pool and skim programs, through the guarded write', async () => {
    const c = await startClearUp('cu', { days: 2, rpm: 2000 }, {});
    expect(writePoolPlan).toHaveBeenCalledWith(expect.objectContaining({ pumpId: 1, speeds: [{ circuitId: 6, rpm: 2000 }], replaceCircuits: [6, 8], schedules: [{ circuitId: 6, start: 0, stop: 1439 }] }));
    expect(c).toEqual({ startedAt: MON_9AM, until: Date.parse('2026-10-08T01:15:00Z'), days: 2, rpm: 2000 });
    expect((await kv.get<any[]>('cu:pool:autolog'))![0].text).toBe('You started a 2-day Clear-up at 2,000 RPM');
  });
  it('CU-3 while it runs Autopilot neither writes (Auto) nor suggests (Suggest)', async () => {
    vi.mocked(writePoolPlan).mockClear();
    for (const mode of ['auto', 'suggest'] as const) {
      const a = await autopilot('cu', { settings: { ...POOL_DEFAULTS, autopilot: mode }, mode, W: powerModel([]), rate: null, names: NAMES, snap: poolSnapshot(Date.now()), waterTemp: 80, currentHours: 24, act: true });
      expect(a.pending).toBe(false);
    }
    expect(writePoolPlan).not.toHaveBeenCalled();
    expect(await kv.get('cu:pool:pending')).toBeFalsy();
  });
  it('CU-4 Add a day moves the end to the next evening run; the evening run ends it only once it is due', async () => {
    const c = await extendClearUp('cu');
    expect([c.days, new Date(c.until).toISOString()]).toEqual([3, '2026-10-09T01:15:00.000Z']);
    vi.setSystemTime(Date.parse('2026-10-08T01:15:00Z')); vi.mocked(writePoolPlan).mockClear();
    expect(await finishClearUpIfDue('cu', {}, null)).toBeNull();                        // Wednesday evening: not yet
    expect(writePoolPlan).not.toHaveBeenCalled();
    vi.setSystemTime(Date.parse('2026-10-09T01:15:00Z'));
    const plan = await finishClearUpIfDue('cu', {}, null);                               // Thursday evening: done
    expect(plan).toMatchObject({ hours: 12, rpm: 1750 });
    expect(writePoolPlan).toHaveBeenCalledWith(expect.objectContaining({ speeds: [{ circuitId: 6, rpm: 1750 }, { circuitId: 8, rpm: 2400 }] }));
    expect(await activeClearUp('cu')).toBeNull();
    expect((await kv.get<any[]>('cu:pool:autolog'))![0].text).toBe('Clear-up done: back to the planner, 12 h at 1,750 RPM');
  });
  it('CU-5 End now writes the planner\'s plan back whatever the Autopilot mode, and logs it as yours', async () => {
    await startClearUp('cu2', { days: 1, rpm: 2500 }, { pool: { autopilot: 'suggest' } });
    vi.mocked(writePoolPlan).mockClear();
    await endClearUp('cu2', { pool: { autopilot: 'suggest' } }, null, 'you');
    expect(writePoolPlan).toHaveBeenCalledTimes(1);
    expect(await activeClearUp('cu2')).toBeNull();
    expect((await kv.get<any[]>('cu2:pool:autolog'))![0]).toMatchObject({ text: 'You ended the Clear-up: back to the planner, 12 h at 1,750 RPM', delta: 'you' });
  });
});

describe('schedule editor (frame 7)', () => {
  const S = { poolCircuit: 6, boostCircuit: 8 };
  it('SE-1 a save: up to six Pool or High Speed runs on the quarter hour, each with a length', () => {
    expect(scheduleError({ schedules: [{ circuitId: 6, start: 600, stop: 1260 }, { circuitId: 8, start: 780, stop: 840 }], speeds: [{ circuitId: 6, rpm: 1800 }] }, S)).toBeNull();
    expect(scheduleError({ schedules: [{ circuitId: 6, start: 0, stop: 1439 }] }, S)).toBeNull();                       // all day
    for (const b of [{ schedules: [{ circuitId: 5, start: 600, stop: 700 }] }, { schedules: [{ circuitId: 6, start: 610, stop: 700 }] }, { schedules: [{ circuitId: 6, start: 600, stop: 600 }] },
      { schedules: Array(7).fill({ circuitId: 6, start: 0, stop: 60 }) }, { schedules: [], speeds: [{ circuitId: 1, rpm: 2000 }] }, {}]) expect(scheduleError(b, S), JSON.stringify(b)).not.toBeNull();
  });
  it('SE-2 saving writes the runs through the guarded write, keeps them as the baseline and moves Auto to Suggest', async () => {
    await kv.set('settings:owner', { pool: { autopilot: 'auto' } }); vi.mocked(writePoolPlan).mockClear();
    await saveSchedule('se', { schedules: [{ circuitId: 6, start: 600, stop: 1260 }], speeds: [{ circuitId: 6, rpm: 1800 }] }, { pool: { autopilot: 'auto' } });
    expect(writePoolPlan).toHaveBeenCalledWith(expect.objectContaining({ speeds: [{ circuitId: 6, rpm: 1800 }], replaceCircuits: [6, 8], schedules: [{ circuitId: 6, start: 600, stop: 1260 }] }));
    expect((await kv.get<any>('settings:owner')).pool.autopilot).toBe('suggest');
    expect((await kv.get<any>('se:pool:applied')).plan.schedules).toEqual([{ circuitId: 6, start: 600, stop: 1260, rpm: 1800 }]);
    expect((await kv.get<any[]>('se:pool:autolog'))![0].text).toBe('You saved the pump schedule (1 run); Autopilot moved to Suggest');
  });
  it('SE-3 in Auto, programs changed outside Solstice (the Pentair app) stay: Autopilot moves to Suggest and writes nothing', async () => {
    await kv.set('settings:owner', { pool: { autopilot: 'auto' } });
    await kv.set('pe:pool:applied', { at: 0, plan: { schedules: [{ circuitId: 6, start: 420, stop: 1140, rpm: 1750 }] }, removed: [], added: [] });
    vi.mocked(writePoolPlan).mockClear();
    const a = await autopilot('pe', { settings: { ...POOL_DEFAULTS, autopilot: 'auto' }, mode: 'auto', W: powerModel([]), rate: null, names: NAMES, snap: poolSnapshot(Date.now()), waterTemp: 80, currentHours: 9, act: true });
    expect(writePoolPlan).not.toHaveBeenCalled();
    expect(a.mode).toBe('suggest');
    expect(a.pending).toBe(true);                                                                  // it offers its plan instead
    expect((await kv.get<any>('settings:owner')).pool.autopilot).toBe('suggest');
    expect(a.log.some(l => l.text.startsWith('The pump schedule was changed outside Solstice'))).toBe(true);
  });
  it('SE-4 a speed change alone (a boost, a circuit sheet) is not an outside edit', async () => {
    const snap = poolSnapshot(Date.now()), managed = [6, 8];
    await kv.set('ps:pool:applied', { at: 0, plan: { schedules: snap.schedules.filter(x => managed.includes(x.circuitId)).map(x => ({ ...x, rpm: 9999 })) }, removed: [], added: [] });
    const a = await autopilot('ps', { settings: { ...POOL_DEFAULTS, autopilot: 'auto' }, mode: 'auto', W: powerModel([]), rate: null, names: NAMES, snap, waterTemp: 80, currentHours: 9, act: true });
    expect(a.mode).toBe('auto');
  });
  it('SE-5 choosing Auto again makes the current programs the baseline, so the next evening run plans instead of flipping back', async () => {
    const snap = poolSnapshot(Date.now());
    await kv.set('pa:pool:applied', { at: 0, plan: { schedules: [{ circuitId: 6, start: 0, stop: 1439, rpm: 2000 }] }, removed: [], added: [] });
    await rebaseline('pa', snap, POOL_DEFAULTS, 'auto');
    vi.mocked(writePoolPlan).mockClear();
    const a = await autopilot('pa', { settings: { ...POOL_DEFAULTS, autopilot: 'auto' }, mode: 'auto', W: powerModel([]), rate: null, names: NAMES, snap, waterTemp: 80, currentHours: 9, act: true });
    expect(a.mode).toBe('auto');
    expect(writePoolPlan).toHaveBeenCalledTimes(1);                                              // the planner's plan goes on
  });
});

describe('an unfinished Solstice write (audit 10b, C-02/C-03)', () => {
  const run = (id: string, snap = poolSnapshot(Date.now())) => autopilot(id, { settings: { ...POOL_DEFAULTS, autopilot: 'auto' }, mode: 'auto', W: powerModel([]), rate: null, names: NAMES, snap, waterTemp: 80, currentHours: 9, act: true });
  it('UW-1 applyPlan records its intent before the controller is touched and clears it once the write succeeded', async () => {
    const plan = (await autopilot('uw', { settings: POOL_DEFAULTS, mode: 'auto', W: powerModel([]), rate: null, names: NAMES, snap: null, waterTemp: 80, currentHours: 9, act: false })).tomorrow.plan;
    vi.mocked(writePoolPlan).mockImplementationOnce(async () => { throw new Error('ScreenLogic: timed out after the add'); });
    await expect(applyPlan('uw', plan, poolSnapshot(Date.now()), POOL_DEFAULTS)).rejects.toThrow('timed out');
    expect(await kv.get<any>(writingKey('uw'))).toMatchObject({ what: 'plan', schedules: plan.schedules.map(s => ({ circuitId: s.circuitId, start: s.start, stop: s.stop, rpm: s.rpm })) });
    expect(await kv.get('uw:pool:applied')).toBeFalsy();                                           // nothing recorded as applied
    await applyPlan('uw', plan, poolSnapshot(Date.now()), POOL_DEFAULTS);
    expect(await kv.get(writingKey('uw'))).toBeFalsy();
    expect(await kv.get('uw:pool:applied')).toBeTruthy();
  });
  it('UW-2 the evening run after a cut-off write keeps Auto, says so, and writes the plan again instead of calling it an outside edit', async () => {
    await kv.set('settings:owner', { pool: { autopilot: 'auto' } });
    // the controller shows the half-written mix (old programs still there), and pool:applied is the old plan: without the intent this flips to Suggest (SE-3)
    await kv.set('uw2:pool:applied', { at: 0, plan: { schedules: [{ circuitId: 6, start: 420, stop: 1140, rpm: 1750 }] }, removed: [], added: [] });
    await kv.set(writingKey('uw2'), { at: Date.now() - 864e5, what: 'plan', schedules: [{ circuitId: 6, start: 480, stop: 1200, rpm: 1750 }] });
    vi.mocked(writePoolPlan).mockClear();
    const a = await run('uw2');
    expect(a.mode).toBe('auto');
    expect((await kv.get<any>('settings:owner')).pool.autopilot).toBe('auto');
    expect(a.log.some(l => l.delta === 'retry' && l.text.startsWith('The last schedule write didn’t finish'))).toBe(true);
    expect(a.log.some(l => l.text.startsWith('The pump schedule was changed outside Solstice'))).toBe(false);
    expect(writePoolPlan).toHaveBeenCalledTimes(1);                                              // the plan goes on again
    expect(await kv.get(writingKey('uw2'))).toBeFalsy();                                         // and the intent is cleared by the successful write
  });
  it('UW-3 with no unfinished write, an outside edit still moves Autopilot to Suggest (SE-3 unchanged)', async () => {
    await kv.set('settings:owner', { pool: { autopilot: 'auto' } });
    await kv.set('uw3:pool:applied', { at: 0, plan: { schedules: [{ circuitId: 6, start: 420, stop: 1140, rpm: 1750 }] }, removed: [], added: [] });
    const a = await run('uw3');
    expect(a.mode).toBe('suggest');
  });
});
