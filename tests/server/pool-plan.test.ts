// Pool plan (planFor) and the Autopilot day plan (planDay): design §8, cases 6–16.
import { describe, it, expect, afterEach } from 'vitest';
import { planFor, powerModel, POOL_DEFAULTS, type PoolSettings } from '../../server/src/appliances/pool.js';
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

describe('pool planFor', () => {
  it('uses the construction-plan defaults', () => {
    expect(S).toMatchObject({ gallons: 14995, designGpm: 120, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5], uv: true });
  });

  it.each([
    [50, { hours: 5, boost: 0, start: 10, stop: 15, boostAt: null }, .6, { kwh: 1.1, usd: 4, onSolar: 100, turnover: 1.04, uv: .3 }],
    [65, { hours: 7, boost: 0, start: 9, stop: 16, boostAt: null }, .75, { kwh: 1.6, usd: 5, onSolar: 100, turnover: 1.46, uv: .42 }],
    [75, { hours: 8, boost: 0, start: 9, stop: 17, boostAt: null }, 1, { kwh: 1.8, usd: 6, onSolar: 100, turnover: 1.67, uv: .48 }],
  ])('6: BELL at %i °F', (t, want, turnovers, figures) => {
    const p = plan(t);
    expect(shape(p)).toEqual(want);
    expect(p.turnovers).toBe(turnovers);
    expect(money(p)).toEqual(figures);
  });

  it.each([
    [88, { hours: 9, boost: 1, start: 8, stop: 17, boostAt: 12 }, { kwh: 2.7, usd: 9, onSolar: 100, turnover: 1.88, uv: .54 }],
    [100, { hours: 10, boost: 1, start: 8, stop: 18, boostAt: 12 }, { kwh: 2.9, usd: 9, onSolar: 100, turnover: 2.09, uv: .6 }],
    [130, { hours: 12, boost: 1, start: 7, stop: 19, boostAt: 12 }, { kwh: 3.3, usd: 11, onSolar: 100, turnover: 2.51, uv: .72 }], // 12 h clamp
  ])('7: BELL at %i °F', (t, want, figures) => {
    const p = plan(t);
    expect(shape(p)).toEqual(want);
    expect(money(p)).toEqual(figures);
  });

  it('8: BELL at 88 °F writes two schedules and explains them; the plan keeps its view-facing shape', () => {
    const p = plan(88);
    expect(p.schedules.map(({ circuitId, start, stop, rpm, name }) => ({ circuitId, start, stop, rpm, name }))).toEqual([
      { circuitId: 6, start: 480, stop: 1020, rpm: 1500, name: 'Pool' },
      { circuitId: 8, start: 720, stop: 780, rpm: 2400, name: 'High Speed' },
    ]);
    expect(p.schedules[0].why).toBe('9 h of filtration at 1,500 RPM, 1.25× turnover of 14,995 gal, while the panels are producing');
    expect(p.schedules[1].why).toBe('a one-hour skim boost at 2,400 RPM at the sunniest hour, for surface debris and pollen');
    expect(Object.keys(p)).toEqual(['month', 'waterTemp', 'turnovers', 'hours', 'boostHours', 'start', 'stop', 'boostAt', 'schedules',
      'kwhPerDay', 'costPerMonth', 'onSolarPct', 'turnoverPerDay', 'hourly', 'uvKwh']);
    expect(p.hourly).toHaveLength(24);
  });

  it('8: circuit names come from the controller when known', () => {
    const p = planFor({ waterTemp: 88, solarKw: BELL, settings: S, W: W0, rate: RATE, month: 8, names: new Map([[6, 'Filter'], [8, 'Skim']]) });
    expect(p.schedules.map(s => s.name)).toEqual(['Filter', 'Skim']);
  });

  it.each([
    [88, { hours: 9, boost: 1, start: 9, stop: 18, boostAt: 13 }, 2.7, 9],
    [55, { hours: 6, boost: 0, start: 10, stop: 16, boostAt: null }, 1.4, 4],
    [30, { hours: 4, boost: 0, start: 11, stop: 15, boostAt: null }, .9, 3],
    [120, { hours: 12, boost: 1, start: 7, stop: 19, boostAt: 13 }, 3.3, 11],
  ])('9: SOL at %i °F', (t, want, kwh, usd) => {
    const p = plan(t, SOL);
    expect(shape(p)).toEqual(want);
    expect([p.kwhPerDay, p.costPerMonth]).toEqual([kwh, usd]);
  });

  it('9: SOL at 88 °F with measured watts (W1) keeps the shape and costs less', () => {
    const p = plan(88, SOL, { W: W1 });
    expect(shape(p)).toEqual({ hours: 9, boost: 1, start: 9, stop: 18, boostAt: 13 });
    expect([p.kwhPerDay, p.costPerMonth]).toEqual([2.6, 8]);
  });

  it('10: a forced plan (4 h, no boost) at 88 °F', () => {
    const p = plan(88, BELL, { force: { hours: 4, boost: 0 } });
    expect(shape(p)).toEqual({ hours: 4, boost: 0, start: 11, stop: 15, boostAt: null });
    expect(p.kwhPerDay).toBe(.9);
  });

  it('10: without UV the boost rule is t ≥ 70 and there is no UV lamp energy', () => {
    const p = plan(75, BELL, { settings: { ...S, uv: false } });
    expect(p.boostHours).toBe(1);
    expect(p.kwhPerDay).toBe(2);
    expect(p.uvKwh).toBe(0);
  });

  // BUG-2 · fixed: with all-zero solar, bestSum = −1 made the first window win and the run started at 05:00 in the dark (5–13;
  // 88 °F gave 5–14 with boostAt 5). No window beats a zero sum now, so the run keeps the default 08:00 start.
  it('BUG-2: with no solar data the run starts at 08:00 (8–16)', () => {
    const p = plan(75, ZERO24);
    expect([p.start, p.stop]).toEqual([8, 16]);
  });
  it('BUG-2 (fixed): with no solar data the run starts at 08:00', () => {
    expect([plan(75, ZERO24).start, plan(75, ZERO24).stop]).toEqual([8, 16]);
    expect(shape(plan(88, ZERO24))).toEqual({ hours: 9, boost: 1, start: 8, stop: 17, boostAt: 8 });
  });
});

describe('Autopilot planDay', () => {
  const BASE: Daily = { date: '2026-07-15', high: 85, rainMm: 0, rainPct: 0, sunKwhM2: 6, hourlySun: BELL_SUN };
  const day = (o: { day?: Partial<Daily>; prev?: Partial<Daily>; heatDays?: number; useYesterday?: boolean; waterTemp?: number; pollen?: 'low' | 'medium' | 'high' } = {}) =>
    planDay({ day: { ...BASE, ...o.day }, prev: o.prev ? { ...BASE, date: '2026-07-14', ...o.prev } : undefined, heatDays: o.heatDays ?? 0,
      useYesterday: o.useYesterday ?? false, waterTemp: o.waterTemp ?? 88, settings: S, W: W0, rate: RATE, names: new Map(), pollen: o.pollen ?? 'low' });
  const hrs = (r: ReturnType<typeof day>) => ({ hours: r.plan.hours, boost: r.plan.boostHours, start: r.plan.start, stop: r.plan.stop });

  it('12: no adjustments keep the season plan itself (no re-plan)', () => {
    const r = day();
    expect(hrs(r)).toEqual({ hours: 9, boost: 1, start: 8, stop: 17 });
    expect(r.why).toEqual([]);
    expect(r.plan).toStrictEqual(planFor({ waterTemp: 88, solarKw: BELL_SUN.map(v => v * 9.45 * .8), settings: S, W: W0, rate: RATE, month: 6, names: new Map() }));
  });

  it('13: rain yesterday adds an hour and a skim boost', () => {
    const r = day({ prev: { rainMm: 5 } });
    expect(hrs(r)).toEqual({ hours: 10, boost: 1, start: 8, stop: 18 });
    expect(r.why).toEqual(['+1 h and a skim boost: rain yesterday brings debris']);
  });
  it('13: rain likely (5 mm at 60 %) does the same; 59 % is not rainy', () => {
    expect(day({ day: { rainMm: 5, rainPct: 60 } }).why).toEqual(['+1 h and a skim boost: rain likely brings debris']);
    expect(hrs(day({ day: { rainMm: 5, rainPct: 60 } }))).toEqual({ hours: 10, boost: 1, start: 8, stop: 18 });
    const dry = day({ day: { rainMm: 5, rainPct: 59 } });
    expect(hrs(dry)).toEqual({ hours: 9, boost: 1, start: 8, stop: 17 });
    expect(dry.why).toEqual([]);
  });

  it('14: day 3 of a heat wave adds two hours', () => {
    const r = day({ heatDays: 3 });
    expect(hrs(r)).toEqual({ hours: 11, boost: 1, start: 7, stop: 18 });
    expect(r.why).toEqual(['+2 h: day 3 of a heat wave (highs ≥ 95°F)']);
  });
  it('14: a single hot day adds one hour; a heat wave wins over a hot day', () => {
    const hot = day({ day: { high: 96.4 } });
    expect(hot.plan.hours).toBe(10);
    expect(hot.why).toEqual(['+1 h: high of 96°F']);
    expect(day({ day: { high: 96.4 }, heatDays: 3 }).why).toEqual(['+2 h: day 3 of a heat wave (highs ≥ 95°F)']);
  });

  it('15: pool used yesterday adds an hour', () => {
    const r = day({ useYesterday: true });
    expect(r.plan.hours).toBe(10);
    expect(r.why).toEqual(['+1 h: the pool was used yesterday']);
  });
  it('15: oak pollen season forces a boost; cold water takes an hour off', () => {
    const r = day({ pollen: 'high', waterTemp: 65 });
    expect([r.plan.hours, r.plan.boostHours]).toEqual([6, 1]);
    expect(r.why).toEqual(['skim boost: oak pollen season', '−1 h: water below 70°F']);
  });
  it('15: 50 °F water bottoms out at four hours', () => {
    expect(day({ waterTemp: 50 }).plan.hours).toBe(4);
  });
  it('15: a cloudy day keeps the hours and says why', () => {
    const r = day({ day: { sunKwhM2: 2 } });
    expect(r.plan.hours).toBe(9);
    expect(r.why).toEqual(['cloudy: the run follows the brightest hours']);
  });
  it('15: rain + heat wave + use clamp at twelve hours with three reasons', () => {
    const r = day({ prev: { rainMm: 5 }, heatDays: 3, useYesterday: true });
    expect(hrs(r)).toEqual({ hours: 12, boost: 1, start: 7, stop: 19 });
    expect(r.why).toHaveLength(3);
  });

  describe('month of the plan date', () => {
    const tz = process.env.TZ;
    afterEach(() => { process.env.TZ = tz; });

    it('16: under UTC (production) 2026-10-01 is October', () => {
      process.env.TZ = 'UTC';
      expect(day({ day: { date: '2026-10-01' } }).plan.month).toBe(9);
    });
    // BUG-6 · today planDay reads the month with new Date('2026-10-01').getMonth(), which is 8 (September) under Chicago time.
    it.fails('BUG-6: 2026-10-01 is October in any time zone', () => {
      process.env.TZ = 'America/Chicago';
      expect(day({ day: { date: '2026-10-01' } }).plan.month).toBe(9);
    });
  });
});
