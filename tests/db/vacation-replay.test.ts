// Vacation mode, replayed on a real past trip (mockup ak frame 6b) and the report and revert around it, on PGlite. The trip's 5-minute
// home load is real (tests/fixtures/trip-replay.ts, placed on made-up days); the pool readings stand in for the old programs that ran then
// (the load above its base while those programs were scheduled), and Nest shows the AC off throughout, as the load says it was.
//   VR-1 the report splits the measured trip: ~112 kWh, no AC, the old pool ~22 kWh a day, an always-on of ~0.45 kW, water-heater bursts
//   VR-2 what Vacation mode would have saved on it: today's planner (4 kWh a day) and the trip plan (the real planner at 82 °F water)
//   VR-3 the report's other lines: "if you'd been home" from the home model, the counterfactual AC at Nest Eco's 82°, "next time"
//   VR-4 the revert on return: presence home, the trip over, tomorrow's pool plan normal, guests back after 24 h, the storm rule asks again
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { TRIP_WH } from '../fixtures/trip-replay.js';
import { tripReport, buildReport, type Report } from '../../server/src/vacation/report.js';
import { createTrip, endTrip, liveTrip, guestsPaused, tripAway } from '../../server/src/vacation/trip.js';
import { poolTripDay } from '../../server/src/vacation/pool.js';
import { tripPlanDay } from '../../server/src/appliances/autopilot.js';
import { POOL_DEFAULTS, powerModel } from '../../server/src/appliances/pool.js';
import { presenceFor } from '../../server/src/appliances/presence.js';
import { localAt, addDays, localDay } from '../../server/src/tesla/client.js';

const S = 's', DAY0 = '2027-06-01', T0 = localAt(DAY0, 0), END = localAt(addDays(DAY0, 3), 0), MIN = 60_000;
const BELL = [0, 0, 0, 0, 0, 0, 0, .1, .3, .5, .7, .8, .9, .9, .8, .7, .5, .3, .1, 0, 0, 0, 0, 0];
/** Old programs, by minute of the day: the Waterfall 22:40–04:40 and High Speed 10:40–16:40 (from the load's own steps). */
const oldProgram = (m: number) => m >= 22 * 60 + 40 || m < 4 * 60 + 40 || (m >= 10 * 60 + 40 && m < 16 * 60 + 40);
/** Late-May weather: 70 °F at dawn to 91 °F mid-afternoon. */
const temps = () => { const t: Record<string, number> = {};
  for (let d = -31; d < 4; d++) for (let h = 0; h < 24; h++) t[`${addDays(DAY0, d)}T${String(h).padStart(2, '0')}`] = 80.5 + 10.5 * Math.sin((h - 9) / 24 * 2 * Math.PI);
  return t; };
let report: Report;

beforeAll(async () => {
  await migrate();
  for (const t of ['trips', 'energy', 'pool_readings', 'nest_readings', 'alerts', 'daily_metrics']) await q(`DELETE FROM ${t}`);
  await q('DELETE FROM kv');
  const base = [...TRIP_WH].sort((a, b) => a - b)[Math.floor(TRIP_WH.length * .05)];
  for (let i = 0; i < TRIP_WH.length; i++) {
    const at = T0 + i * 5 * MIN, day = localDay(new Date(at)), m = (i % 288) * 5;
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh, solar_wh) VALUES ($1,$2,$3,$4,$5,$6,0)`, [S, new Date(at).toISOString(), at, day, Math.floor(m / 60), TRIP_WH[i]]);
    if (i % 3 === 0) {   // a pool read every 15 minutes: the old programs' draw above the base
      const on = oldProgram(m), w = on ? Math.max(0, (TRIP_WH[i] - base) * 12) : 0;
      await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [S, at, day, Math.floor(m / 60), on, w, on ? 3000 : 0]);
      await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, eco) VALUES ($1,$2,$3,$4,82,55,'COOL','OFF',null,true)`, [S, at, day, Math.floor(m / 60)]);
    }
  }
  await q(`INSERT INTO trips (site_id, leave_at, back_at, state, started_at, ended_at, ended_by) VALUES ($1, $2, $3, 'ended', $2, $3, 'you')`, [S, T0, END]);
  const trip = (await q<any>(`SELECT id FROM trips`))[0];
  const { toTrip } = await import('../../server/src/vacation/trip.js');
  const row = (await q<any>(`SELECT id, site_id, leave_at::text leave_at, back_at::text back_at, state, started_at::text started_at, ended_at::text ended_at, ended_by, detected, data FROM trips WHERE id = $1`, [trip.id]))[0];
  report = await tripReport(S, toTrip(row), { acKw: 2.6, poolNormalKwhDay: 4.0, uv: false, temps: temps() });
});

describe('a real trip, replayed', () => {
  it('VR-1 the report splits the measured trip', () => {
    expect(report.usedKwh).toBeCloseTo(111.9, 1);                                     // the fixture's own sum
    expect(report.days).toBe(3);
    const part = (id: string) => report.parts.find(p => p.id === id)!;
    expect(part('ac').used).toBe(0);                                                   // no AC on that trip
    expect(part('pool').used).toBeGreaterThan(55); expect(part('pool').used).toBeLessThan(72);   // the old programs, ~22 kWh a day
    expect(report.awayBaseKw).toBeGreaterThan(.4); expect(report.awayBaseKw).toBeLessThan(.55);
    expect(part('waterHeater').used).toBeGreaterThan(0);
    expect(report.parts.reduce((a, p) => a + p.used, 0)).toBeCloseTo(report.usedKwh, 0);
  });

  it('VR-2 what Vacation mode would have saved on it', () => {
    const pool = report.parts.find(p => p.id === 'pool')!.used;
    const W = powerModel([]), trip = tripPlanDay({ day: { date: '2027-06-02', high: 91, rainMm: 0, rainPct: 0, sunKwhM2: 7, hourlySun: BELL }, heatDays: 0, waterTemp: 82, settings: POOL_DEFAULTS, W, rate: null, names: new Map() });
    const todayNoVacation = report.usedKwh - pool + 4.0 * 3, withVacation = report.usedKwh - pool + trip.plan.kwhPerDay * 3;
    expect(trip.why[0]).toBe('Vacation: 1.5 turnovers a day (water 82°F)');
    expect(todayNoVacation).toBeGreaterThan(53); expect(todayNoVacation).toBeLessThan(63);   // mockup: ~58
    expect(withVacation).toBeGreaterThan(45); expect(withVacation).toBeLessThan(55);         // mockup: ~51
    expect(todayNoVacation - withVacation).toBeCloseTo((4.0 - trip.plan.kwhPerDay) * 3, 5);
    console.info(`[replay] used ${report.usedKwh} kWh; today without Vacation mode ${todayNoVacation.toFixed(1)}; with it ${withVacation.toFixed(1)} (trip plan ${trip.plan.kwhPerDay} kWh/day: ${trip.plan.hours} h at ${trip.plan.rpm} RPM)`);
  });

  it('VR-3 the counterfactual AC at 82°, the home model, next time', () => {
    const ac = report.parts.find(p => p.id === 'ac')!;
    expect(ac.empty).toBeGreaterThan(0);                                               // an empty house at Eco 82° would have cooled some
    expect(report.model).toEqual({ k: .095, delta: 9, days: 0 });                      // no Nest days before the trip: the default model
    expect(report.homeKwh).toBeNull();                                                 // no days before the trip for the home model
    expect(report.next.at(-1)).toBe('Log a pool test so the next trip’s pool plan can learn from it');
    expect(report.conf).toEqual({ ac: 'measured', empty: 'estimated', home: null });
    // the home model, when there are days to fit
    const r = buildReport({ from: T0, to: END, energy: [], nest: [], pool: [], acKw: 2.6, uv: false, temps: {}, model: report.model, poolNormalKwhDay: 4, homeFit: { a: 45, b: 1.5 }, highs: { [DAY0]: 90, [addDays(DAY0, 1)]: 92, [addDays(DAY0, 2)]: 88 }, homeBaseKw: .86, trip: { backAt: END, data: {} }, alerts: 2 });
    expect(r.homeKwh).toBe(3 * 45 + 1.5 * (20 + 22 + 18));
    expect(r.alerts).toBe(2);
  });
});

describe('the revert on return', () => {
  it('VR-4 presence home, the trip over, tomorrow\'s pool normal, guests back after 24 h, the storm rule asks again', async () => {
    await q('DELETE FROM trips');
    const now = Date.now(), t = await createTrip(S, { leaveAt: now - 2 * 864e5, backAt: now + 3 * 864e5, detected: false }, now - 2 * 864e5);
    const tomorrow = addDays(localDay(new Date(now)), 1);
    expect([(await presenceFor(S, {}, now)).source, await tripAway(S, now), poolTripDay(t, tomorrow), await guestsPaused(now)]).toEqual(['vacation', true, true, true]);
    await endTrip(S, 'you', now);                                                      // "I'm home", a day early
    expect(await liveTrip(S)).toBeNull();
    expect((await presenceFor(S, {}, now + 1000)).state).toBe('home');
    expect(await tripAway(S, now + 1000)).toBe(false);                                // the storm rule is back to Suggest; the reserve rule plans again
    expect(poolTripDay(await liveTrip(S), tomorrow)).toBe(false);                     // tomorrow's plan is the normal one
    expect(await guestsPaused(now + 23 * 3600e3)).toBe(true);
    expect(await guestsPaused(now + 25 * 3600e3)).toBe(false);
    expect(await kv.get('s:vacation:snooze')).toBeUndefined();
  });
});
