// The learning layer's pure parts (server/src/learn/, docs/audit-designs/learning-layer.md): prediction logging, the scoring
// arithmetic, the confidence formula at its boundaries, the 1-in-5 control-day counter, trims and their bounds (and how the safety
// guard treats a trimmed plan), the AC savings on the worked example, measured savings from control days, every anomaly rule
// firing and resolving, and the server twin of the browser's 48-hour forecast. Synthetic numbers only. The database parts are in
// tests/db/integration.test.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { q } from '../../server/src/db.js';
import { planFor, AC_DEFAULTS, type AcPlan, type AcSettings } from '../../server/src/appliances/ac.js';
import { guardCoolSetpoint, AUTOPILOT_OFF } from '../../server/src/appliances/guards.js';
import { MODELS, MODEL_IDS, FORBIDDEN_KEY, type ModelDef } from '../../server/src/learn/models.js';
import { pickInputs, logPrediction, forgetWritten } from '../../server/src/learn/store.js';
import { confidence, badge } from '../../server/src/learn/confidence.js';
import { acSavings, controlDecision, CONTROL_EVERY, trimFor, applyTrim, precoolOutcome, measuredSavings, windowKwh, COOLING_HOURS,
  type ControlState, type PrecoolDay, type AcDay } from '../../server/src/learn/ac.js';
import { pumpRules, acOverrunRule, solarStepRule, alwaysOnRule, dataGapRules, type MetricsByDay, type RuleCtx, type OpenAnomaly } from '../../server/src/learn/rules.js';
import { scoreDay, scoreMetrics, poolActual } from '../../server/src/learn/nightly.js';
import { forecast48, learnYield } from '../../server/src/learn/forecast48.js';
// @ts-ignore: the browser module is plain JS without types; the twin must match it
import * as web from '../../web/src/lib/model.js';
import { sunPeak } from '../fixtures/forecast.js';

const AC: AcSettings = AC_DEFAULTS;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const plan = (o: Partial<Parameters<typeof planFor>[0]> = {}): AcPlan => planFor({ date: '2026-07-15', high: 96, sunKwhM2: 6, hourlySun: sunPeak(13), settings: AC,
  acKw: 2.016, slope: 2.5, rate: null, humidity: null, ...o });
const steps = (p: AcPlan) => p.steps.map(s => [s.hour, s.coolF]);

/* ------------------------------------------------------------------ prediction logging and privacy */
describe('prediction logging', () => {
  beforeEach(() => { vi.mocked(q).mockReset(); forgetWritten(); });
  afterAll(() => { vi.mocked(q).mockReset().mockImplementation(() => { throw new Error('db in pure test (q)'); }); }); // the rail again for the pure tests below

  it('pickInputs keeps only the model’s whitelisted keys, never a rate, a dollar figure or the system, and rounds numbers', () => {
    const got = pickInputs('pool.kwhDay', { hours: 9, sched: [[600, 1140, 1500]], waterTemp: 88.123456, rate: .1064, costPerMonth: 20, system: { priceUsd: 1 }, name: 'x', extra: 1 });
    expect(got).toEqual({ hours: 9, sched: [[600, 1140, 1500]], waterTemp: 88.1235 });
    expect(pickInputs('ac.shifted', { trim: { what: 'coast', amount: -30, rate: 1 }, high: 96 })).toEqual({ trim: { what: 'coast', amount: -30 }, high: 96 });
  });
  it('no model’s whitelist holds a key that looks like money, a rate, the system or a name', () => {
    for (const id of MODEL_IDS) expect(MODELS[id].inputs.filter(k => FORBIDDEN_KEY.test(k)), id).toEqual([]);
  });
  it('logs many predictions in one INSERT … ON CONFLICT DO NOTHING, skipping non-finite values', async () => {
    vi.mocked(q).mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const n = await logPrediction('s', [
      { model: 'fc48.solar', day: '2026-09-25', hour: 13, horizon: 8, value: 4.2, inputs: { k: 8, rate: 1 } },
      { model: 'home.alwaysOn', day: '2026-09-26', value: .52 },
      { model: 'fc48.home', day: '2026-09-25', hour: 13, horizon: 8, value: NaN },
    ], { now: 1000 });
    expect(n).toBe(2);
    expect(q).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(q).mock.calls[0];
    expect(sql).toContain('ON CONFLICT (site_id, model, target_day, target_hour, horizon) DO NOTHING');
    expect(params).toEqual(['s', ['fc48.solar', 'home.alwaysOn'], ['2026-09-25', '2026-09-26'], [13, -1], [8, 0], [4.2, .52], ['kWh', 'kW'], [1000, 1000], ['{"k":8}', '{}']]);
  });
  it('`once` writes a key at most once per instance (the AC plan is recomputed on every read)', async () => {
    vi.mocked(q).mockResolvedValue([{ id: 1 }]);
    const p = { model: 'ac.shifted' as const, day: '2026-09-25', value: 2.1 };
    await logPrediction('s', p, { once: true });
    await logPrediction('s', p, { once: true });
    expect(q).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ scoring arithmetic */
describe('scoring arithmetic', () => {
  it('a kWh-per-hour model: sums the day, relative error on a floored denominator, and per-band error', () => {
    const s = scoreDay(MODELS['fc48.solar'], [{ predicted: 2, actual: 1.5, band: 'h1-6' }, { predicted: .1, actual: 0, band: 'h1-6' }, { predicted: 4, actual: 5, band: 'h7-24' }])!;
    // e = +.5, +.1, −1; den = 1.5, .3 (the floor), 5; |rel| = 1/3, 1/3, .2
    expect(s.pred).toBeCloseTo(6.1, 10); expect(s.actual).toBeCloseTo(6.5, 10);
    expect(s.err).toBeCloseTo(-.4 / 3, 10); expect(s.abs).toBeCloseTo(1.6 / 3, 10); expect(s.ape).toBeCloseTo((2 / 3 + .2) / 3, 10); expect(s.den).toBeCloseTo(6.8 / 3, 10);
    expect(s.n).toBe(3);
    expect(s.bands['h1-6']).toBeCloseTo(.3, 10); expect(s.bands['h7-24']).toBeCloseTo(1, 10);
    expect(scoreMetrics('fc48.solar', s).map(m => m[0])).toEqual(['score:fc48.solar:pred', 'score:fc48.solar:actual', 'score:fc48.solar:err', 'score:fc48.solar:abs',
      'score:fc48.solar:den', 'score:fc48.solar:n', 'score:fc48.solar:ape', 'score:fc48.solar:abs@h1-6', 'score:fc48.solar:abs@h7-24']);
  });
  it('an absolute-unit model (battery %) averages the day and has no percent error', () => {
    const s = scoreDay(MODELS['fc48.soc'], [{ predicted: 80, actual: 75 }, { predicted: 60, actual: 70 }])!;
    expect(s).toEqual({ pred: 70, actual: 72.5, err: -2.5, abs: 7.5, ape: null, den: 1, n: 2, bands: {} });
    expect(scoreDay(MODELS['fc48.soc'], [])).toBeNull();
  });
  it('pool kWh from readings: the scheduled quarter-hours measured, the rest of the schedule filled with their mean, plus UV', () => {
    const t = (hm: string) => Date.parse(`2026-09-24T${hm}:00-05:00`);
    const rows = [{ ts: t('10:05'), running: true, watts: 150 }, { ts: t('10:20'), running: true, watts: 160 }, { ts: t('10:35'), running: true, watts: 170 },
      { ts: t('02:00'), running: false, watts: 0 }];
    expect(poolActual(rows, [[600, 660, 1500]], .06)).toEqual({ kwh: .16 + .06, coverage: .75 });
    expect(poolActual([], [[600, 660, 1500]])).toEqual({ kwh: null, coverage: 0 });
    expect(poolActual(rows, [])).toBeNull();
  });
});

/* ------------------------------------------------------------------ confidence */
describe('confidence formula and tiers', () => {
  const today = '2026-09-25', m = MODELS['fc48.solar']; // N 14, ceiling 40%
  const st = (o: Partial<{ n: number; mape: number; mae: number; bias: number; age: number }>) => ({ n: o.n ?? 14, mape: o.mape ?? .1, mae: o.mae ?? 1, bias: o.bias ?? 0, lastDay: addDays(today, -(o.age ?? 1)) });

  it('unscored with no scores, no scored day, or none within 14 days; scored at exactly 14', () => {
    expect(confidence(m, null, today).tier).toBe('unscored');
    expect(confidence(m, { ...st({}), n: 0 }, today).tier).toBe('unscored');
    expect(confidence(m, st({ age: 15 }), today).tier).toBe('unscored');
    expect(confidence(m, st({ age: 14 }), today).tier).not.toBe('unscored');
  });
  it('learning under N/2 scored days (6 of 14), not at 7', () => {
    expect(confidence(m, st({ n: 6, mape: 0 }), today).tier).toBe('learning');
    expect(confidence(m, st({ n: 7, mape: 0 }), today).tier).not.toBe('learning');
  });
  it('learned at exactly 0.70, estimated at 0.69', () => {
    // c = 1, fresh = 1, bias 0 → s = 1: confidence = .75 × (1 − MAPE/.4) + .25
    expect(confidence(m, st({ mape: .16 }), today)).toEqual({ tier: 'learned', confidence: .7 });
    expect(confidence(m, st({ mape: .1653 }), today)).toEqual({ tier: 'estimated', confidence: .69 });
  });
  it('coverage and steadiness: fewer days and a bias lower it', () => {
    expect(confidence(m, st({ n: 7, mape: 0 }), today).confidence).toBe(.5);            // c = .5
    expect(confidence(m, st({ mape: .1, bias: .1 }), today).confidence).toBe(.59);      // s = 1 − .1/.11 = .09
    expect(confidence(m, st({ mape: .1, bias: 0 }), today).confidence).toBe(.81);
  });
  it('fresh is 1 up to 3 days, then fades to 0 over 27 more', () => {
    expect(confidence(m, st({ mape: 0, age: 3 }), today).confidence).toBe(1);
    expect(confidence(m, st({ mape: 0, age: 14 }), today)).toEqual({ tier: 'estimated', confidence: .59 }); // 1 − 11/27
    const long: ModelDef = { ...m, staleDays: 60 };
    expect(confidence(long, st({ mape: 0, age: 30 }), today).confidence).toBe(0);
  });
  it('absolute-unit models read MAE against their ceiling (battery %: 20 pts)', () => {
    const soc = MODELS['fc48.soc'];
    expect(confidence(soc, st({ mae: 5, bias: 0 }), today)).toEqual({ tier: 'learned', confidence: .81 });
    expect(confidence(soc, st({ mae: 10, bias: 0 }), today)).toEqual({ tier: 'estimated', confidence: .63 });
  });
  it('the AC savings are estimated until control days measure them, then measured', () => {
    expect(confidence(MODELS['ac.shifted'], st({}), today).tier).toBe('estimated');
    expect(confidence(MODELS['ac.eveningAvoided'], null, today, true).tier).toBe('measured');
  });
  it('badge text as the model report shows it', () => {
    expect(badge(m, 'learning', st({ n: 3 }))).toBe('learning · 3 of 14');
    expect(badge(m, 'learned', st({ mape: .04 }))).toBe('±4%');
    expect(badge(MODELS['fc48.soc'], 'learned', st({ mae: 5 }))).toBe('±5 pts');
    expect(badge(MODELS['home.alwaysOn'], 'estimated', { ...st({}), mape: .34 })).toBe('±34%');
    expect(badge(MODELS['ac.shifted'], 'estimated', null)).toBe('estimated');
    expect([badge(m, 'unscored', null), badge(m, 'measured', null)]).toEqual(['unscored', 'measured']);
  });
});

/* ------------------------------------------------------------------ control days */
describe('the 1-in-5 control-day counter', () => {
  it('every 5th eligible day is a control day; ineligible days don’t count; a day’s decision never changes', () => {
    let st: ControlState | null = null;
    const seen: Array<[string, boolean]> = [];
    for (let i = 0; i < 16; i++) {
      const day = addDays('2026-07-01', i), eligible = i % 4 !== 3; // every 4th day is mild, cloudy or humid
      const d = controlDecision(st, day, eligible); st = d.state;
      if (eligible) seen.push([day, d.control]);
      expect(controlDecision(st, day, eligible)).toMatchObject({ control: d.control, changed: false });
      if (!eligible) expect([d.changed, d.control]).toEqual([false, false]);
    }
    expect(st!.count).toBe(12);
    expect(seen.filter(x => x[1]).map(x => x[0])).toEqual([seen[4][0], seen[9][0]]);
    expect(CONTROL_EVERY).toBe(5);
  });
  it('keeps the last 60 decisions', () => {
    let st: ControlState | null = null;
    for (let i = 0; i < 70; i++) st = controlDecision(st, addDays('2026-01-01', i), true).state;
    expect(Object.keys(st!.days)).toHaveLength(60);
    expect(st!.count).toBe(70);
  });
});

/* ------------------------------------------------------------------ savings */
describe('AC savings: kWh shifted onto solar and evening kWh avoided', () => {
  it('the worked example (high 96°, 6 kWh/m², band 74–78°, 2° pre-cool 11–16, coast to 78° until 20:00, slope 2.5)', () => {
    const p = plan();
    expect(steps(p)).toEqual([[7, 76], [11, 74], [16, 78], [20, 76], [22, 76]]);
    const k = 2.5 / COOLING_HOURS; // 0.208 kWh per °F-hour
    expect(acSavings(p, AC, 2.5, 2.016)).toEqual({ shiftedKwh: Math.round(k * 2 * 5 * 10) / 10, eveningAvoidedKwh: Math.round(k * 2 * 4 * 10) / 10, kPerDegH: .208 });
    expect([p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([2.1, 1.7]);
  });
  it('capped at what the AC can draw in each window', () => {
    expect(acSavings(plan(), AC, 2.5, .3)).toMatchObject({ shiftedKwh: 1.5, eveningAvoidedKwh: 1.2 });
  });
  it('a heat wave starts the pre-cool at 11:00, so six hours shift', () => {
    const p = plan({ high: 101, hourlySun: sunPeak(14) });
    expect([p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([2.5, 1.7]);
  });
  it('no pre-cool, no savings: mild, away, control day', () => {
    for (const p of [plan({ high: 85 }), plan({ settings: { ...AC, presence: 'away' } }), plan({ control: true })]) expect([p.shiftedKwh, p.eveningAvoidedKwh]).toEqual([0, 0]);
  });
});

/* ------------------------------------------------------------------ trims */
const precoolDay = (day: string, o: { rate?: number; flat?: boolean } = {}): PrecoolDay => {
  const readings: PrecoolDay['readings'] = [];
  for (let i = 0; i <= 66; i++) {
    const h = 10 + i / 6; // every 10 minutes, 10:00–21:00
    if (h < 11) readings.push({ h, indoorF: 76, hvac: 'OFF' });
    else if (h < 16) readings.push(o.flat ? { h, indoorF: 76, hvac: 'COOLING' } : { h, indoorF: Math.max(74, 76 - (h - 11)), hvac: i % 2 ? 'COOLING' : 'OFF' });
    else { const f = Math.min(78, (o.flat ? 76 : 74) + (o.rate ?? 1) * (h - 16)); readings.push({ h, indoorF: Math.round(f * 100) / 100, hvac: f >= 78 ? 'COOLING' : 'OFF' }); }
  }
  return { day, coastF: 78, deep: 74, from: 11, to: 16, coastFrom: 16, coastTo: 20, readings };
};
describe('trims from the indoor trajectory', () => {
  it('what a pre-cool day shows: when 78° came, the temperature at the coast’s end, AC minutes per hour and the warm-up rate', () => {
    expect(precoolOutcome(precoolDay('2026-09-20', { rate: 2 }))).toEqual({ reachedAt: 18, atCoastEnd: 78, runMinPerH: 30, reachedDeep: true, warmup: 2 });
    expect(precoolOutcome(precoolDay('2026-09-20', { rate: .5 }))).toMatchObject({ reachedAt: null, atCoastEnd: 76, warmup: .5 });
    expect(precoolOutcome(precoolDay('2026-09-20', { flat: true }))).toMatchObject({ runMinPerH: 60, reachedDeep: false });
  });
  it('coast −30 min when the house reached 78° over an hour early on 2 of the last 3 pre-cool days', () => {
    expect(trimFor([precoolDay('2026-09-20', { rate: 2 }), precoolDay('2026-09-21', { rate: 2 }), precoolDay('2026-09-22')])).toEqual({ what: 'coast', amount: -30, unit: 'min', warmupFPerH: 2,
      reason: 'the house reached 78° by 6 PM on Sep 20 and 6 PM on Sep 21, over an hour before the coast ended (warming about 2 °F an hour)' });
  });
  it('coast +30 min when the house was still ≤ 77° at the coast’s end on all 3', () => {
    const days = ['2026-09-20', '2026-09-21', '2026-09-22'].map(d => precoolDay(d, { rate: .5 }));
    expect(trimFor(days)).toMatchObject({ what: 'coast', amount: 30, unit: 'min', reason: 'the house was still at or below 77° when the coast ended on each of the last 3 pre-cool days (warming about 0.5 °F an hour)' });
    expect(trimFor([...days.slice(0, 2), precoolDay('2026-09-22')])).toBeNull(); // 2 of 3 is not enough
  });
  it('depth 1 °F shallower when the AC ran flat out and never reached the pre-cool setpoint on 2 of 3; it wins over a coast trim', () => {
    expect(trimFor([precoolDay('2026-09-20', { flat: true }), precoolDay('2026-09-21', { flat: true, rate: 2 }), precoolDay('2026-09-22', { rate: 2 })]))
      .toMatchObject({ what: 'depth', amount: 1, unit: '°F', reason: 'the AC ran 50+ minutes an hour through the pre-cool and never got the house down to 74° on Sep 20 and Sep 21' });
  });
  it('fewer than three pre-cool days: no trim; only the last three count', () => {
    expect(trimFor([precoolDay('2026-09-20', { rate: 2 }), precoolDay('2026-09-21', { rate: 2 })])).toBeNull();
    expect(trimFor([precoolDay('2026-09-18', { rate: 2 }), precoolDay('2026-09-19', { rate: 2 }), precoolDay('2026-09-20'), precoolDay('2026-09-21'), precoolDay('2026-09-22')])).toBeNull();
  });

  const reason = 'test';
  it('applies a coast trim by moving the end of the coast, and records what, how much and why', () => {
    const t = applyTrim(plan(), { what: 'coast', amount: -30, unit: 'min', reason }, AC)!;
    expect(steps(t)).toEqual([[7, 76], [11, 74], [16, 78], [19.5, 76], [22, 76]]);
    expect([t.coastTo, t.trim]).toEqual([19.5, { what: 'coast', amount: -30, unit: 'min', reason, warmupFPerH: null, from: 20, to: 19.5 }]);
    expect(t.why.at(-1)).toBe('Trimmed: coast ends at 7:30 PM instead of 8 PM, because test');
    expect(acSavings(t, AC, 2.5, 2.016)).toMatchObject({ shiftedKwh: 2.1, eveningAvoidedKwh: 1.5 });
  });
  it('applies a depth trim to the pre-cool setpoint only', () => {
    const t = applyTrim(plan(), { what: 'depth', amount: 1, unit: '°F', reason }, AC)!;
    expect(steps(t)).toEqual([[7, 76], [11, 75], [16, 78], [20, 76], [22, 76]]);
    expect(t.why.at(-1)).toBe('Trimmed: pre-cool to 75° instead of 74°, because test');
    expect(t.trim).toMatchObject({ from: 74, to: 75 });
  });
  it('bounds: at most 1 °F or 30 minutes, a coast of 2 h or more ending by 21:00, 1° of pre-cool, inside the comfort band', () => {
    const p = plan();
    expect(applyTrim(p, { what: 'coast', amount: -60, unit: 'min', reason }, AC)).toBeNull();
    expect(applyTrim(p, { what: 'depth', amount: 2, unit: '°F', reason }, AC)).toBeNull();
    expect(applyTrim(p, { what: 'depth', amount: -1, unit: '°F', reason }, AC)).toBeNull();                 // 73° is below the 74° floor of the band
    expect(applyTrim(p, { what: 'coast', amount: 30, unit: '°F', reason }, AC)).toBeNull();                 // units must match
    expect(applyTrim({ ...p, coastTo: 18, steps: p.steps.map(s => s.hour === 20 ? { ...s, hour: 18 } : s) }, { what: 'coast', amount: -30, unit: 'min', reason }, AC)).toBeNull();
    expect(applyTrim(plan({ high: 101, hourlySun: sunPeak(14) }), { what: 'coast', amount: 30, unit: 'min', reason }, AC)).toBeNull(); // past 21:00
    expect(applyTrim(plan({ settings: { ...AC, precoolDepth: 1 } }), { what: 'depth', amount: 1, unit: '°F', reason }, AC)).toBeNull(); // no pre-cool left
    expect(applyTrim(plan({ control: true }), { what: 'coast', amount: -30, unit: 'min', reason }, AC)).toBeNull();
    expect(applyTrim(plan({ high: 85 }), { what: 'depth', amount: 1, unit: '°F', reason }, AC)).toBeNull();
  });
  it('the safety guard treats a trimmed plan like any other: every step is in range, a big move is stepped, Off writes nothing', () => {
    const t = applyTrim(plan(), { what: 'depth', amount: 1, unit: '°F', reason }, AC)!, now = Date.parse('2026-07-15T17:00:00Z');
    for (const s of t.steps) expect(guardCoolSetpoint({ mode: 'auto', targetF: s.coolF, currentF: s.coolF, lastWriteAt: null, now }).ok).toBe(true);
    expect(guardCoolSetpoint({ mode: 'auto', targetF: 75, currentF: 78, lastWriteAt: null, now })).toMatchObject({ ok: true, value: 76, stepped: true });
    expect(guardCoolSetpoint({ mode: 'auto', targetF: 75, currentF: 76, lastWriteAt: now - 10 * 60_000, now })).toMatchObject({ ok: false });
    expect(guardCoolSetpoint({ mode: 'off', targetF: 75, currentF: 76, lastWriteAt: null, now })).toMatchObject({ ok: false, reason: AUTOPILOT_OFF });
  });
});

/* ------------------------------------------------------------------ measured savings from control days */
describe('measured savings: pre-cool days against matched control days', () => {
  const hours = (pre: number, coast: number, sp: number) => Object.fromEntries(Array.from({ length: 24 }, (_, h) =>
    [h, { coolMin: h >= 11 && h < 16 ? pre : h >= 16 && h < 20 ? coast : 0, coolF: h >= 11 && h < 16 ? sp : 76 }]));
  const day = (d: string, o: Partial<AcDay> & { pre?: number; coast?: number; sp?: number } = {}): AcDay => ({ day: d, control: false, precool: true, high: 95, sunKwhM2: 6, mid: 76,
    from: 11, to: 16, coastFrom: 16, coastTo: 20, hours: hours(o.pre ?? 40, o.coast ?? 10, o.sp ?? 74), ...o });
  const pre = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-15'].map(d => day(d));
  const ctl = [day('2026-09-14', { control: true, precool: false, high: 94, sunKwhM2: 6.2, pre: 25, coast: 30, sp: 76 }),
    day('2026-09-19', { control: true, precool: false, pre: 25, coast: 30, sp: 76 })];

  it('shifted = its pre-cool-window kWh − the controls’; evening avoided = the controls’ coast kWh − its own', () => {
    // 3 kW: pre-cool days 5 h × 40 min = 10 kWh then 4 h × 10 min = 2 kWh; control days 6.25 kWh then 6 kWh
    expect(windowKwh(pre[0], 11, 16, 3)).toBe(10);
    expect(windowKwh(pre[0], 16, 19.5, 3)).toBeCloseTo(1.75, 10);
    const m = measuredSavings([...pre, ...ctl], 3);
    expect(m.perDay).toHaveLength(5);
    expect(m.perDay[0]).toEqual({ day: '2026-09-10', shiftedKwh: 3.75, eveningAvoidedKwh: 4, controls: 2 });
    expect([m.shiftedKwh, m.eveningAvoidedKwh, m.precoolDays, m.controlDays, m.measured]).toEqual([3.8, 4, 5, 2, true]);
  });
  it('needs 5 compared pre-cool days and 2 matched controls; a day that didn’t follow its plan is left out', () => {
    expect(measuredSavings([...pre.slice(0, 4), ...ctl], 3)).toMatchObject({ precoolDays: 4, measured: false });
    expect(measuredSavings([...pre, ctl[0]], 3)).toMatchObject({ precoolDays: 0, measured: false });
    const drifted = day('2026-09-16', { control: true, precool: false, sp: 74 });                    // a "control" day that pre-cooled anyway
    const hotter = day('2026-09-17', { control: true, precool: false, high: 99, pre: 25, coast: 30, sp: 76 }); // 4° hotter: no match
    expect(measuredSavings([...pre, ctl[0], drifted, hotter], 3)).toMatchObject({ precoolDays: 0, controlDays: 0 });
    const flat = day('2026-09-18', { sp: 76 });                                                        // "pre-cool" that never went below 76°
    expect(measuredSavings([flat, ...ctl], 3).perDay).toEqual([]);
    const gap = day('2026-09-18'); delete gap.hours[13];                                               // no readings for an hour of the window
    expect(measuredSavings([gap, ...ctl], 3).perDay).toEqual([]);
  });
});

/* ------------------------------------------------------------------ anomaly rules */
const DAYS = Array.from({ length: 60 }, (_, i) => addDays('2026-07-27', i)); // … 2026-09-24 (yesterday)
const ctx = (f: (d: string, i: number) => Record<string, number | undefined>, o: Partial<RuleCtx> = {}): RuleCtx => {
  const m: MetricsByDay = new Map(DAYS.map((d, i) => [d, Object.fromEntries(Object.entries(f(d, i)).filter(([, v]) => v != null)) as Record<string, number>]));
  return { days: DAYS, m, open: new Map(), pumpBaseline: {}, expectedBuckets: () => 288, ...o };
};
const opened = (kind: string, detail: Record<string, unknown>): Map<string, OpenAnomaly> => new Map([[kind, { id: 1, kind, day: '2026-09-20', severity: 'warn', detail: { title: 't', body: 'b', ...detail } }]]);

describe('anomaly rules fire and resolve', () => {
  const base = { '1500': { watts: 150, n: 40 } };
  const pump = (tail: number[]) => ctx((_, i) => { const w = i >= 60 - tail.length ? tail[i - (60 - tail.length)] : 150; return { 'pool.w@1500': w, 'pool.w@1500.n': 10 }; }, { pumpBaseline: base });

  it('pump: 88% or less of the clean-filter baseline on 3 of the last 5 covered days fires "moving less water" (restriction)', () => {
    const [below, above] = pumpRules(pump([130, 130, 130, 130, 130]));
    expect(below).toMatchObject({ kind: 'pump.below_baseline@1500', state: 'fire', severity: 'warn',
      detail: { expected: 150, measured: 130, persisted: '5 of the last 5 covered days', action: 'filter_cleaned',
        body: 'Pump drawing 13% less than its clean-filter baseline at 1,500 RPM: it is moving less water. A loaded D.E. filter, a full basket or a partly closed valve does this.' } });
    expect(above.state).toBe('hold');
    expect(pumpRules(pump([150, 150, 132, 132, 150]))[0].state).toBe('hold');           // 2 of 5, and not settled
    expect(pumpRules(pump([133, 133, 150, 149, 151]))[0].state).toBe('clear');          // back within 5% for 3 covered days
  });
  it('pump: 112% or more fires "moving more water or dragging" (info); fewer than 3 covered days waits', () => {
    const [, above] = pumpRules(pump([170, 170, 170, 150, 150]));
    expect(above).toMatchObject({ kind: 'pump.above_baseline@1500', state: 'fire', severity: 'info' });
    expect(above.detail.body).toContain('13% more at 1,500 RPM: it is moving more water than usual');
    const sparse = ctx((_, i) => i >= 58 ? { 'pool.w@1500': 120, 'pool.w@1500.n': 5 } : {}, { pumpBaseline: base });
    expect(pumpRules(sparse).map(v => v.state)).toEqual(['wait', 'wait']);
  });

  const ac = (last3: number, sp: (i: number) => number = () => 76) => ctx((_, i) => {
    const dh = 100 + 10 * (i % 7), rt = i >= 57 ? last3 : 60 + 2 * dh;
    return { 'ac.runtime_min': rt, 'ac.degree_hours': i >= 57 ? 150 : dh, 'ac.cool_f': sp(i), 'wx.high_f': 97 };
  });
  it('AC overrun: > 1.3× the degree-hour model and 60+ min over on 2 of the last 3 days fires; a setpoint drop explains it', () => {
    const v = acOverrunRule(ac(520));
    expect(v).toMatchObject({ kind: 'ac.overrun', state: 'fire', severity: 'warn', detail: { expected: 360, measured: 520, persisted: '3 of the last 3 days', confound: 'setpoint steady this week' } });
    expect(v.detail.body).toBe('AC ran 2 h 40 m longer than your model expects for a 97° day. Filter, refrigerant charge or a door left open.');
    const dropped = acOverrunRule(ac(520, i => i >= 53 ? 73 : 76));
    expect(dropped.state).toBe('hold');
    expect(dropped.detail.confound).toBe('setpoint lowered 3° this week, so the extra run time is expected');
  });
  it('AC overrun clears when the last 3 days are within 15%, and waits for 21 days of history', () => {
    expect(acOverrunRule(ac(370)).state).toBe('clear');
    expect(acOverrunRule(ctx((_, i) => i >= 45 ? { 'ac.runtime_min': 300, 'ac.degree_hours': 120 } : {})).state).toBe('wait');
  });

  const solar = (last: number[]) => ctx((_, i) => { const k = i - (60 - last.length); return { 'solar.kwh': k >= 0 ? last[k] : 48, 'wx.gti': 6, 'wx.rain_mm': i % 5 === 0 ? 8 : 0 }; });
  it('solar: the last 3 clear days at 85% or less of the prior 14 fires (high); it closes on 2 clear days back at 95% of that reference', () => {
    const v = solarStepRule(solar([39, 39, 39]));
    expect(v).toMatchObject({ kind: 'solar.step_down', state: 'fire', severity: 'high', detail: { expected: 8, measured: 6.5, action: 'open_panels' } });
    expect(v.detail.body).toBe('Output dropped 19% in a step since Sep 22: a section of the array may be out (a microinverter or a breaker).');
    expect(solarStepRule(solar([45, 45, 45])).state).toBe('hold');
    const open = opened('solar.step_down', { expected: 8 });
    expect(solarStepRule({ ...solar([39, 39, 47]), open }).state).toBe('hold');
    expect(solarStepRule({ ...solar([39, 47, 47]), open }).state).toBe('clear');
    expect(solarStepRule(ctx(() => ({ 'solar.kwh': 20, 'wx.gti': 3 }))).state).toBe('wait');   // no clear days
  });

  const nights = (tail: number[]) => ctx((_, i) => { const k = i - (60 - tail.length); return { 'home.alwaysOn_kw': k >= 0 ? tail[k] : .5 }; });
  it('always-on: a 7-night mean 15% and 150 W above the 30-night median, three nights running, fires; back within 8% clears', () => {
    const v = alwaysOnRule(nights(Array(9).fill(.7)));
    expect(v).toMatchObject({ kind: 'home.always_on_step', state: 'fire', detail: { expected: 500, measured: 700, persisted: '3 of the last 3 nights' } });
    expect(alwaysOnRule(nights(Array(7).fill(.7))).state).toBe('hold');     // the third night back is still only +143 W
    expect(alwaysOnRule(nights(Array(9).fill(.6))).state).toBe('hold');     // +100 W is under the 150 W floor
    const open = opened('home.always_on_step', { expected: 500 });
    expect(alwaysOnRule({ ...nights(Array(7).fill(.52)), open }).state).toBe('clear');
    expect(alwaysOnRule({ ...nights(Array(7).fill(.7)), open }).state).toBe('hold');
    expect(alwaysOnRule(ctx((_, i) => i > 50 ? { 'home.alwaysOn_kw': .5 } : {})).state).toBe('wait');
  });

  it('data gaps: a short energy day fires, a complete one clears; a source that stops reporting fires, and clears when it’s back', () => {
    const gaps = (y: Record<string, number>) => dataGapRules(ctx((_, i) => i === 59 ? y : { 'energy.buckets': 288, 'nest.n': 150, 'soe.n': 96 }));
    const short = gaps({ 'energy.buckets': 200, 'nest.n': 40, 'soe.n': 96 });
    expect(short.map(v => [v.kind, v.state])).toEqual([['data.gap.energy', 'fire'], ['data.gap.soe', 'clear'], ['data.gap.nest', 'fire'], ['data.gap.pool', 'wait']]);
    expect(short[0].detail.body).toBe("Tesla's 5-minute history for Sep 24 has 200 of 288 buckets: about 7.3 h missing. The nightly sync re-fetches short days.");
    expect(gaps({ 'energy.buckets': 288, 'nest.n': 140, 'soe.n': 96 }).map(v => v.state)).toEqual(['clear', 'clear', 'clear', 'wait']);
    expect(gaps({ 'energy.buckets': 280, 'nest.n': 100, 'soe.n': 96 }).map(v => v.state)).toEqual(['hold', 'clear', 'hold', 'wait']);
  });
});

/* ------------------------------------------------------------------ the 48-hour forecast twin */
describe('forecast48.ts is the browser’s model, line for line', () => {
  const time = Array.from({ length: 72 }, (_, i) => `${addDays('2026-09-25', Math.floor(i / 24))}T${String(i % 24).padStart(2, '0')}:00`);
  const gti = time.map(t => { const h = +t.slice(11, 13); return h >= 7 && h <= 19 ? Math.round(900 * Math.sin((h - 6) / 14 * Math.PI)) : 0; });
  const w = { hourly: { time, global_tilted_irradiance: gti } };
  const profile = Array.from({ length: 24 }, (_, h) => h >= 17 && h <= 22 ? 3.5 : 1.8);
  it.each([[5, 62], [13, 35], [20, 90]])('from %i:00 at %i%%', (startHour, soc0) => {
    const o = { w, startDate: '2026-09-25', startHour, soc0, yieldK: 8.2, profile, capKwh: 27, maxKw: 10, reservePct: 20 };
    expect(forecast48(o)).toEqual(web.forecast48(o));
  });
  it('learnYield matches too', () => {
    const daily = [50, 60, 70, 80, 90, 1, 30].map((solar, i) => ({ date: addDays('2026-09-01', i), solar }));
    const g = Object.fromEntries(daily.map((d, i) => [d.date, [10, 10, 9, 11, 10, 10, 2][i]]));
    expect(learnYield(daily, g)).toBe(web.learnYield(daily, g));
    expect(learnYield([], {})).toBe(web.learnYield([], {}));
  });
});
