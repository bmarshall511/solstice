// Pool plan (planFor) and the Autopilot day plan (planDay): design §8, cases 6–16.
import { describe, it, expect, afterEach } from 'vitest';
import { planFor, goalPlan, powerModel, POOL_DEFAULTS, type PoolSettings } from '../../server/src/appliances/pool.js';
import { planDay } from '../../server/src/appliances/autopilot.js';
import { BELL, SOL, BELL_SUN, ZERO24, type Daily } from '../fixtures/forecast.js';

const S: PoolSettings = POOL_DEFAULTS;
const W0 = powerModel([]);
const W1 = powerModel([{ rpm: 1500, watts: 153 }, { rpm: 1800, watts: 287 }]);
const RATE = .1064;
const plan = (waterTemp: number, solarKw = BELL, o: { settings?: PoolSettings; W?: (r: number) => number; force?: { hours: number; boost: number } } = {}) =>
  planFor({ waterTemp, solarKw, settings: o.settings ?? S, W: o.W ?? W0, rate: RATE, month: 8, names: new Map(), force: o.force });
const shape = (p: ReturnType<typeof plan>) => ({ hours: p.hours, boost: p.boostHours, start: p.start, stop: p.stop, boostAt: p.boostAt });
const money = (p: ReturnType<typeof plan>) => ({ kwh: p.kwhPerDay, usd: p.costPerMonth, onSolar: p.onSolarPct, turnover: p.turnoverPerDay, uv: p.uvKwh });

describe('pool planFor (mockup w frame 5: the turnover planner)', () => {
  it('uses the construction-plan defaults and the owner\'s goal: 3 turnovers a day with a 1 h skim', () => {
    expect(S).toMatchObject({ gallons: 14995, designGpm: 120, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5], uv: true, turnoverGoal: 3, skimHours: 1 });
  });

  // by hand: 3 × 14,995 = 44,985 gal. The skim hour at 2,400 RPM moves 83.48 GPM × 60 = 5,009 gal; the other 39,976 gal at 1,750 RPM
  // (60.87 GPM) take 10.95 h, so 11 h + the skim hour = 12 h, the cap. 1,700 RPM would need 11.27 h (13 h), so 1,750 is the slowest that fits.
  it('goalPlan: the slowest filter speed that reaches the goal within 12 pump hours', () => {
    expect(goalPlan(S, W0)).toEqual({ rpm: 1750, hours: 12, skim: 1, reached: true });
    expect(goalPlan({ ...S, turnoverGoal: 2 }, W0)).toEqual({ rpm: 1200, hours: 11, skim: 1, reached: true });   // 24,981 gal over 10 h needs 41.6 GPM
    expect(goalPlan({ ...S, turnoverGoal: 4 }, W0)).toEqual({ rpm: 2400, hours: 12, skim: 1, reached: true });
    expect(goalPlan({ ...S, turnoverGoal: 5 }, W0)).toMatchObject({ rpm: 2400, hours: 12, reached: false });     // not reachable: the most the cap allows
    expect(goalPlan({ ...S, skimHours: 0 }, W0)).toMatchObject({ skim: 0, hours: 12 });
  });

  it('BELL: 12 h at 1,750 RPM under the solar curve, the skim hour at the sunniest hour, about 3 turnovers', () => {
    const p = plan(80);
    expect(shape(p)).toEqual({ hours: 12, boost: 1, start: 7, stop: 19, boostAt: 12 });
    expect([p.rpm, p.goal]).toEqual([1750, 3]);
    expect(p.turnoverPerDay).toBeGreaterThanOrEqual(3);
    expect(p.turnovers).toBe(p.turnoverPerDay);
    expect(p.schedules.map(({ circuitId, start, stop, rpm, name }) => ({ circuitId, start, stop, rpm, name }))).toEqual([
      { circuitId: 6, start: 420, stop: 1140, rpm: 1750, name: 'Pool' },
      { circuitId: 8, start: 720, stop: 780, rpm: 2400, name: 'High Speed' },
    ]);
    expect(p.schedules[0].why).toBe('12 h of filtration at 1,750 RPM toward 3 turnovers of 14,995 gal a day');
    expect(p.schedules[1].why).toBe('a one-hour skim at 2,400 RPM at the sunniest hour, for surface debris and mixing');
    expect(Object.keys(p)).toEqual(['month', 'waterTemp', 'turnovers', 'goal', 'rpm', 'hours', 'boostHours', 'start', 'stop', 'boostAt', 'schedules',
      'kwhPerDay', 'costPerMonth', 'onSolarPct', 'turnoverPerDay', 'hourly', 'uvKwh']);
    expect(p.hourly).toHaveLength(24);
  });

  it('the water temperature no longer sets the hours (planDay adjusts); circuit names come from the controller', () => {
    expect(shape(plan(55))).toEqual(shape(plan(88)));
    const p = planFor({ waterTemp: 88, solarKw: BELL, settings: S, W: W0, rate: RATE, month: 8, names: new Map([[6, 'Filter'], [8, 'Skim']]) });
    expect(p.schedules.map(s => s.name)).toEqual(['Filter', 'Skim']);
  });

  it('SOL puts the skim hour at its own sunniest hour; measured watts (W1) keep the plan and cost no more (264 vs 261 W at 1,750)', () => {
    expect(shape(plan(80, SOL))).toEqual({ hours: 12, boost: 1, start: 7, stop: 19, boostAt: 13 });
    const w1 = plan(80, SOL, { W: W1 });
    expect(shape(w1)).toEqual(shape(plan(80, SOL)));
    expect(w1.kwhPerDay).toBeLessThanOrEqual(plan(80, SOL).kwhPerDay);
  });

  it('a forced plan (planDay\'s adjustments) keeps the goal\'s speed; no skim hour means no High Speed program', () => {
    const p = plan(80, BELL, { force: { hours: 4, boost: 0 } });
    expect([p.hours, p.boostHours, p.rpm, p.stop - p.start, p.boostAt]).toEqual([4, 0, 1750, 4, null]);
    expect(plan(80, BELL, { settings: { ...S, skimHours: 0 } }).schedules.map(s => s.circuitId)).toEqual([6]);
  });

  it('without UV there is no UV lamp energy', () => {
    expect(plan(75, BELL, { settings: { ...S, uv: false } }).uvKwh).toBe(0);
    expect(plan(75).uvKwh).toBeGreaterThan(0);
  });

  // BUG-2 · fixed: with all-zero solar the first window used to win (a 05:00 start in the dark). No window beats a zero sum, so
  // the run keeps the default 08:00 start.
  it('BUG-2 (fixed): with no solar data the run starts at 08:00', () => {
    expect(shape(plan(80, ZERO24))).toEqual({ hours: 12, boost: 1, start: 8, stop: 20, boostAt: 8 });
  });
  it('a run longer than the solar window still fits the day (16 h ends at midnight)', () => {
    const p = plan(80, BELL, { force: { hours: 16, boost: 1 } });
    expect([p.start, p.stop]).toEqual([8, 24]);
    expect(p.schedules[0]).toMatchObject({ start: 480, stop: 0 });   // 0 = midnight: the controller's wrap
  });
});

describe('Autopilot planDay', () => {
  const BASE: Daily = { date: '2026-07-15', high: 85, rainMm: 0, rainPct: 0, sunKwhM2: 6, hourlySun: BELL_SUN };
  const day = (o: { day?: Partial<Daily>; prev?: Partial<Daily>; heatDays?: number; useYesterday?: boolean; waterTemp?: number; pollen?: 'low' | 'medium' | 'high' } = {}) =>
    planDay({ day: { ...BASE, ...o.day }, prev: o.prev ? { ...BASE, date: '2026-07-14', ...o.prev } : undefined, heatDays: o.heatDays ?? 0,
      useYesterday: o.useYesterday ?? false, waterTemp: o.waterTemp ?? 80, settings: S, W: W0, rate: RATE, names: new Map(), pollen: o.pollen ?? 'low' });
  const hrs = (r: ReturnType<typeof day>) => ({ hours: r.plan.hours, boost: r.plan.boostHours, start: r.plan.start, stop: r.plan.stop });

  it('12: no adjustments keep the season plan itself (no re-plan)', () => {
    const r = day();
    expect(hrs(r)).toEqual({ hours: 12, boost: 1, start: 7, stop: 19 });
    expect(r.why).toEqual([]);
    expect(r.plan).toStrictEqual(planFor({ waterTemp: 80, solarKw: BELL_SUN.map(v => v * 9.45 * .8), settings: S, W: W0, rate: RATE, month: 6, names: new Map() }));
  });

  it('13: rain yesterday adds an hour and a skim boost', () => {
    const r = day({ prev: { rainMm: 5 } });
    expect(hrs(r)).toEqual({ hours: 13, boost: 1, start: 6, stop: 19 });
    expect(r.why).toEqual(['+1 h and a skim boost: rain yesterday brings debris']);
  });
  it('13: rain likely (5 mm at 60 %) does the same; 59 % is not rainy', () => {
    expect(day({ day: { rainMm: 5, rainPct: 60 } }).why).toEqual(['+1 h and a skim boost: rain likely brings debris']);
    expect(hrs(day({ day: { rainMm: 5, rainPct: 60 } })).hours).toBe(13);
    const dry = day({ day: { rainMm: 5, rainPct: 59 } });
    expect(hrs(dry)).toEqual({ hours: 12, boost: 1, start: 7, stop: 19 });
    expect(dry.why).toEqual([]);
  });

  it('14: day 3 of a heat wave adds two hours', () => {
    const r = day({ heatDays: 3 });
    expect(hrs(r).hours).toBe(14);
    expect(r.why).toEqual(['+2 h: day 3 of a heat wave (highs ≥ 95°F)']);
  });
  it('14: a single hot day adds one hour; a heat wave wins over a hot day', () => {
    const hot = day({ day: { high: 96.4 } });
    expect(hot.plan.hours).toBe(13);
    expect(hot.why).toEqual(['+1 h: high of 96°F']);
    expect(day({ day: { high: 96.4 }, heatDays: 3 }).why).toEqual(['+2 h: day 3 of a heat wave (highs ≥ 95°F)']);
  });

  it('15: pool used yesterday adds an hour', () => {
    const r = day({ useYesterday: true });
    expect(r.plan.hours).toBe(13);
    expect(r.why).toEqual(['+1 h: the pool was used yesterday']);
  });
  it('15: oak pollen season forces a boost; cold water takes an hour off', () => {
    const r = day({ pollen: 'high', waterTemp: 65 });
    expect([r.plan.hours, r.plan.boostHours]).toEqual([11, 1]);
    expect(r.why).toEqual(['skim boost: oak pollen season', '−1 h: water below 70°F']);
  });
  it('15: cold water takes one hour off the goal\'s hours (no more since the goal sets them)', () => {
    expect(day({ waterTemp: 50 }).plan.hours).toBe(11);
  });
  it('15: water at 85 °F or warmer adds an hour (frame 5)', () => {
    const r = day({ waterTemp: 86 });
    expect(r.plan.hours).toBe(13);
    expect(r.why).toEqual(['+1 h: water at 86°F']);
  });
  it('15: a cloudy day keeps the hours and says why', () => {
    const r = day({ day: { sunKwhM2: 2 } });
    expect(r.plan.hours).toBe(12);
    expect(r.why).toEqual(['cloudy: the run follows the brightest hours']);
  });
  it('15: rain + warm water + heat wave + use clamp at sixteen hours with four reasons', () => {
    const r = day({ prev: { rainMm: 5 }, heatDays: 3, useYesterday: true, waterTemp: 88 });
    expect(hrs(r)).toEqual({ hours: 16, boost: 1, start: 8, stop: 24 });
    expect(r.why).toHaveLength(4);
  });

  describe('month of the plan date', () => {
    const tz = process.env.TZ;
    afterEach(() => { process.env.TZ = tz; });

    it('16: under UTC (production) 2026-10-01 is October', () => {
      process.env.TZ = 'UTC';
      expect(day({ day: { date: '2026-10-01' } }).plan.month).toBe(9);
    });
    // BUG-6 · fixed: planDay read the month with new Date('2026-10-01').getMonth(), which is 8 (September) under Chicago time.
    // It now reads the month from the date string.
    it('BUG-6: 2026-10-01 is October in any time zone', () => {
      process.env.TZ = 'America/Chicago';
      expect(day({ day: { date: '2026-10-01' } }).plan.month).toBe(9);
    });
  });
});
