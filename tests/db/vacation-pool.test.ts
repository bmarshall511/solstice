// Vacation mode, the pool (server/src/vacation/pool.ts and Pool Autopilot; mockup ak frames 1, 2 and 7) on PGlite. Nothing reaches the
// controller: Autopilot runs with act: false (plans only), and the departure check reads the stored snapshot.
//   VP-1 which days are trip days: the leave day once gone by noon, every day after, never the day you come back
//   VP-2 the trip goal: 1 turnover, 1.5 in 80 °F water, +0.5 in a heat wave or 88 °F water
//   VP-3 Autopilot plans trip days at the trip goal (no daily skim, the rain rule's skim kept), the arrival day normally, and waits on cloudy water
//   VP-4 an outside run during a trip goes in the trip's log once an hour, not in the pool's learning
//   VP-5 the departure check: lights, spa, blower and jets left on with a day's kWh, spa heat; nothing else
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { poolTripDay, tripGoal, leftOn } from '../../server/src/vacation/pool.js';
import { autopilot } from '../../server/src/appliances/autopilot.js';
import { POOL_DEFAULTS, powerModel } from '../../server/src/appliances/pool.js';
import { noteOutsideRun } from '../../server/src/appliances/poolLearn.js';
import { createTrip, liveTrip } from '../../server/src/vacation/trip.js';
import { localDay, addDays, localAt } from '../../server/src/tesla/client.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';

const BELL = [0, 0, 0, 0, 0, 0, 0, .1, .3, .5, .7, .8, .9, .9, .8, .7, .5, .3, .1, 0, 0, 0, 0, 0];
const W = powerModel([]);
beforeAll(async () => { await migrate(); });
beforeEach(async () => { await q('DELETE FROM trips'); await q('DELETE FROM pool_tests'); await q(`DELETE FROM kv`); });

describe('trip days and the goal', () => {
  it('VP-1 trip days: gone by noon, not the day you come back', () => {
    const t = { state: 'planned' as const, leaveAt: localAt('2026-10-15', 7), backAt: localAt('2026-10-18', 18) };
    expect(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].map(d => poolTripDay(t, d))).toEqual([false, true, true, true, false]);
    expect(poolTripDay({ ...t, leaveAt: localAt('2026-10-15', 14) }, '2026-10-15')).toBe(false);          // leaving after noon: today's plan stays
    expect(poolTripDay({ ...t, backAt: null }, '2026-11-30')).toBe(true);                                  // open-ended
    expect(poolTripDay({ ...t, state: 'cancelled' as any }, '2026-10-16')).toBe(false);
  });
  it('VP-2 the trip goal', () => {
    expect(tripGoal(77, 0)).toEqual({ goal: 1, why: ['Vacation: 1 turnover a day (water 77°F)'] });
    expect(tripGoal(82, 0).goal).toBe(1.5);
    expect(tripGoal(82, 3)).toEqual({ goal: 2, why: ['Vacation: 1.5 turnovers a day (water 82°F)', '+0.5 turnover: day 3 of a heat wave'] });
    expect(tripGoal(89, 0).why[1]).toBe('+0.5 turnover: water at 89°F');
  });
});

describe('Pool Autopilot during a trip', () => {
  const plan = async (waterTemp: number, rainTomorrow = 0) => {
    const today = localDay();
    await kv.set('pool:forecast', { at: Date.now(), days: [-1, 0, 1, 2, 3, 4].map(k => ({ date: addDays(today, k), high: 84, rainMm: k === 1 ? rainTomorrow : 0, rainPct: k === 1 && rainTomorrow ? 80 : 0, sunKwhM2: 5, hourlySun: BELL })) });
    return autopilot('s', { settings: { ...POOL_DEFAULTS, autopilot: 'auto' }, mode: 'auto', W, rate: null, names: new Map(), snap: null, waterTemp, currentHours: 12, act: false });
  };
  it('VP-3 trip days at the trip goal; the arrival day normal; cloudy water waits; rain keeps its skim', async () => {
    const normal = await plan(78);
    expect(normal.tomorrow.plan.turnovers).toBeGreaterThanOrEqual(3);
    const today = localDay();
    await createTrip('s', { leaveAt: Date.now(), backAt: localAt(addDays(today, 3), 18), detected: false });
    const a = await plan(78);
    expect(a.tomorrow.why).toEqual(['Vacation: 1 turnover a day (water 78°F)']);
    expect(a.tomorrow.plan.turnovers).toBeGreaterThanOrEqual(1);
    expect(a.tomorrow.plan.turnovers).toBeLessThan(1.3);
    expect(a.tomorrow.plan.boostHours).toBe(0);
    expect(a.tomorrow.plan.kwhPerDay).toBeLessThan(normal.tomorrow.plan.kwhPerDay / 3);
    expect(a.week.map(d => !!d.trip)).toEqual([true, true, false, false]);                       // back on day 3: the normal plan that day and after
    expect((await plan(78, 12)).tomorrow).toMatchObject({ why: ['Vacation: 1 turnover a day (water 78°F)', '+1 h and a skim boost: rain likely brings debris'], plan: { boostHours: 1 } });
    await q(`INSERT INTO pool_tests (site_id, at, day, fc, ph, clarity) VALUES ('s', $1, $2, 1.5, 7.6, 'hazy')`, [Date.now() - 3600e3, today]);
    const c = await plan(78);
    expect(c.tomorrow.why[0]).toBe('Vacation: the trip plan waits because your last water test said hazy');
    expect(c.tomorrow.plan.turnovers).toBeGreaterThanOrEqual(3);
  });
  it('VP-4 a run outside the plan during a trip: in the trip\'s log once an hour, never counted as yours', async () => {
    const now = Math.floor(Date.now() / 3600e3) * 3600e3 + 10 * 60_000;   // 10 minutes into an hour: the two runs below share it
    const t = await createTrip('s', { leaveAt: now - 3600e3, backAt: now + 2 * 864e5, detected: false }, now - 3600e3);
    expect(await noteOutsideRun('s', now)).toBe(false);
    expect(await noteOutsideRun('s', now + 60_000)).toBe(false);
    expect(await kv.get('s:pool:outsideRuns')).toBeUndefined();
    const log = (await liveTrip('s'))!.data.log!.map(l => l.text);
    expect(log.filter(x => x.startsWith('The pump ran outside the plan'))).toHaveLength(1);
    expect(t.id).toBeGreaterThan(0);
  });
  it('VP-5 the departure check', () => {
    const snap = poolSnapshot(Date.now(), { on: [6, 3, 1, 2] });
    snap.bodies[1] = { ...snap.bodies[1], heatMode: 3 } as any;
    const out = leftOn(snap, POOL_DEFAULTS.loads, W);
    expect(out.map(x => [x.kind, x.kwhPerDay])).toEqual(expect.arrayContaining([['light', 12], ['blower', 26.4], ['heat', null]]));
    expect(out.find(x => x.kind === 'spa')).toMatchObject({ kwhPerDay: expect.any(Number) });
    expect(out.some(x => x.id === 6)).toBe(false);                                              // the Pool circuit itself is not "left on"
    expect(leftOn(poolSnapshot(Date.now(), { on: [6] }), POOL_DEFAULTS.loads, W)).toEqual([]);
  });
});
