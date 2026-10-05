// Clear-up (mockup w frame 6) on PGlite with ScreenLogic replaced by recorders: the all-day program through the guarded write, the end
// at the evening pool run, Autopilot holding off while it runs (whatever the mode), Add a day, and End now handing back to the planner.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { kv, migrate } from '../../server/src/db.js';
import { autopilot } from '../../server/src/appliances/autopilot.js';
import { startClearUp, extendClearUp, endClearUp, finishClearUpIfDue, activeClearUp, clearUpError, poolRunAfter, powerModel, POOL_DEFAULTS } from '../../server/src/appliances/pool.js';
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
