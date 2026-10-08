// Strip-heat watch, the pure part (server/src/stripheat.ts; I-15, approved mockup am frames 6 and 7). Synthetic days only.
//   STR-1  the heating type from the learned heating step: heat pump under 5 kW, straight AC at 5 or more, learning under 5 steps
//   STR-2  the stage size from the histogram of the excess while heating; heat pump and straight-AC levels
//   STR-3  a single spike is never strips; two consecutive buckets over the line are (scored by the lower of the pair)
//   STR-4  the kWh arithmetic: Σ(excess − compressor)/12, minutes, heat-pump minutes, the peak; the cap at the year's p99.5
//   STR-5  the cause: setback (heat_f rose 2° in the hour before), cold (below the balance point, no change), both
//   STR-6  energy only (no Nest): 04:00–10:00 under 50°F at 6 kW or more, badge "estimated"; learning badge with few heating steps
//   STR-7  a straight AC: every heating bucket is strips, stages stacked at 1.6×
//   STR-8  DST days: the fall-back and spring-forward mornings keep their local hours
//   STR-9  the push text: setback-heavy pushes, cold-heavy goes to the feed only, a light morning is nothing; metrics; the week; digest
//   STR-10 the back-test over a synthetic winter, and the heating ceiling for the vacation watch
//   STR-12 a guest gets no strip field: the AC guest view drops it, and the card's route has no guest view
//   STR-11 the 10:00 step: every other 5-minute tick of the day returns before touching the database (db throws here)
import { describe, it, expect } from 'vitest';
import { stripWatch } from '../../server/src/stripwatch.js';
import { q } from '../../server/src/db.js';
import { GUEST_GET } from '../../server/src/redact.js';
import { localAt, addDays } from '../../server/src/tesla/client.js';
import {
  heatingKind, levelsFor, stageSize, classifyDay, stripLine, heatingLabel, setbackBefore, alertFor, stripMetrics, weekSummary, digestLine,
  backtest, capOf, whyText, tipText, heatingCeilingKw, causeOf, HEAVY_STRIP_KWH, DEFAULT_STRIP_KW, type Levels, type NestRow, type Bucket,
} from '../../server/src/stripheat.js';

const MIN = 60_000, BASE = .6;
/** A day of 5-minute buckets: the base plus `extra(epoch)` kW, from local midnight to the next (23, 24 or 25 hours). */
const dayBuckets = (day: string, extra: (t: number) => number): Bucket[] => {
  const out: Bucket[] = []; for (let t = localAt(day, 0); t < localAt(addDays(day, 1), 0); t += 5 * MIN) out.push({ epoch: t, kw: BASE + extra(t) }); return out;
};
const at = (day: string, h: number) => localAt(day, h);
/** Nest every 15 minutes from 00:00 to noon: HEATING inside [from, to), the heat setpoint from `heatF(t)`. */
const nestRows = (day: string, from: number, to: number, heatF: (t: number) => number | null = () => 68): NestRow[] => {
  const out: NestRow[] = []; for (let t = at(day, 0) - 60 * MIN; t < at(day, 12); t += 15 * MIN) out.push({ ts: t, hvac: t >= at(day, from) && t < at(day, to) ? 'HEATING' : 'OFF', heatF: heatF(t) });
  return out;
};
const HP: Levels = { kind: 'heat-pump', heatKw: 3.4, compressorKw: 3.4, stageKw: 4.8, stages: 2, stageLearned: true, capKw: null };
const D = '2027-01-14';   // a Thursday in January (CST)

describe('the heating type and its levels', () => {
  it('STR-1 heat pump under 5 kW, straight AC at 5 or more, learning until 5 heating steps', () => {
    expect(heatingKind({ heatKw: 3.4, heatSamples: 6 })).toBe('heat-pump');
    expect(heatingKind({ heatKw: 4.99, heatSamples: 5 })).toBe('heat-pump');
    expect(heatingKind({ heatKw: 5, heatSamples: 5 })).toBe('straight');
    expect(heatingKind({ heatKw: 9.6, heatSamples: 12 })).toBe('straight');
    expect(heatingKind({ heatKw: 3.4, heatSamples: 4 })).toBe('learning');
    expect(heatingKind({ heatKw: null, heatSamples: 0 })).toBe('learning');
    expect(heatingLabel({ kind: 'heat-pump', stages: 2 })).toBe('heat pump + 2 strip stages');
    expect(heatingLabel({ kind: 'straight', stages: null })).toBe('AC heating on strips');
    expect(heatingLabel({ kind: 'learning', stages: null }, 3)).toBe('learning (3 of 5 heating runs)');
  });
  it('STR-2 the stage size from the histogram peaks; heat-pump and straight-AC levels', () => {
    const noise = (i: number) => ((i * 37) % 11 - 5) / 25;   // ±0.2 kW, deterministic
    const ex = [...Array.from({ length: 40 }, (_, i) => 3.4 + 4.8 + noise(i)), ...Array.from({ length: 30 }, (_, i) => 3.4 + 9.6 + noise(i)), ...Array.from({ length: 60 }, (_, i) => 3.4 + noise(i))];
    const st = stageSize(ex, 3.4)!;
    expect(st.stages).toBe(2);
    expect(st.stageKw).toBeGreaterThan(4.4); expect(st.stageKw).toBeLessThan(5.2);
    expect(stageSize(ex.slice(0, 10), 3.4)).toBeNull();                       // too few values
    const hp = levelsFor({ heatKw: 3.4, heatSamples: 6 }, ex);
    expect(hp).toMatchObject({ kind: 'heat-pump', compressorKw: 3.4, stages: 2, stageLearned: true });
    expect(stripLine(hp)).toBeCloseTo(3.4 + .8 * hp.stageKw, 6);
    expect(levelsFor({ heatKw: 3.4, heatSamples: 6 })).toMatchObject({ stageLearned: false, stageKw: DEFAULT_STRIP_KW });
    expect(stripLine(levelsFor({ heatKw: 3.4, heatSamples: 6 }))).toBe(6);   // the default threshold until a stage is learned
    expect(levelsFor({ heatKw: 9.5, heatSamples: 8 })).toMatchObject({ kind: 'straight', compressorKw: 0, stageKw: 9.5, stageLearned: true });
    expect(levelsFor({ heatKw: null, heatSamples: 0 })).toMatchObject({ kind: 'learning', compressorKw: 0, stageLearned: false });
  });
});

describe('a morning', () => {
  const nest = nestRows(D, 5, 10);
  const run = (extra: (t: number) => number, o: Partial<Parameters<typeof classifyDay>[0]> = {}) =>
    classifyDay({ day: D, buckets: dayBuckets(D, extra), baseKw: BASE, levels: HP, balanceF: 40, nest, outdoorF: () => 45, ...o });
  it('STR-3 a single spike is rejected; two consecutive buckets pass', () => {
    const hp = (t: number) => t >= at(D, 5) && t < at(D, 10) ? 3.4 : 0;
    const one = run(t => hp(t) + (t === at(D, 6) ? 9.6 : 0));
    expect(one.stripMin).toBe(0); expect(one.stripKwh).toBe(0); expect(one.runs).toEqual([]);
    const two = run(t => hp(t) + (t === at(D, 6) || t === at(D, 6) + 5 * MIN ? 9.6 : 0));
    expect(two.stripMin).toBe(10); expect(two.stripKwh).toBeCloseTo(2 * 9.6 / 12, 1); expect(two.runs).toHaveLength(1);
    // a pair is scored by its lower bucket: 13 then 6 kW over the base is under the line (3.4 + 0.8 × 4.8 = 7.24)
    expect(run(t => hp(t) + (t === at(D, 6) ? 9.6 : t === at(D, 6) + 5 * MIN ? 2.6 : 0)).stripMin).toBe(0);
    // the same pair while Nest says OFF is not strips (the oven, not the heating)
    expect(run(t => t === at(D, 11) || t === at(D, 11) + 5 * MIN ? 13 : 0).stripMin).toBe(0);
  });
  it('STR-4 the kWh arithmetic, the minutes, the peak and the cap', () => {
    // compressor 05:00–10:00 (3.4 kW); strips 06:00–07:35 on top (9.6 kW: two stages): 19 buckets
    const extra = (t: number) => (t >= at(D, 5) && t < at(D, 10) ? 3.4 : 0) + (t >= at(D, 6) && t < at(D, 7) + 35 * MIN ? 9.6 : 0);
    const d = run(extra);
    expect(d.mode).toBe('nest');
    expect(d.stripMin).toBe(95);                                  // "1 h 35 m"
    expect(d.stripKwh).toBeCloseTo(19 * 9.6 / 12, 1);             // 15.2 kWh: the strips' own draw, the compressor taken out
    expect(d.peakKw).toBe(9.6);
    expect(d.hpMin).toBe(5 * 60 - 95);                            // heating, not strips
    expect(d.hpKw).toBe(3.4);
    expect(d.quarters).toHaveLength(32);
    expect(d.quarters.filter(q => q.cls === 'st')).toHaveLength(7);   // 06:00–07:45
    expect(d.quarters[0]).toMatchObject({ at: at(D, 4), cls: '' });
    expect(d.quarters.find(q => q.at === at(D, 5))?.cls).toBe('hp');
    // the pool pump comes out of the excess before anything else
    expect(run(extra, { poolKw: t => t >= at(D, 6) && t < at(D, 8) ? 1.5 : 0 }).stripKwh).toBeCloseTo(19 * 8.1 / 12, 1);
    // a bucket over the year's p99.5 counts at the cap
    const capped = run(extra, { levels: { ...HP, capKw: BASE + 3.4 + 8 } });
    expect(capped.stripKwh).toBeCloseTo(19 * 8 / 12, 1); expect(capped.peakKw).toBe(8);
    expect(capOf(Array.from({ length: 1000 }, (_, i) => i / 100))).toBe(9.95);
    expect(capOf([1, 2, 3])).toBeNull();
    // today so far: only the buckets before `until`
    expect(run(extra, { until: at(D, 7) }).stripMin).toBe(60);
  });
  it('STR-5 setback, cold and both', () => {
    const extra = (t: number) => (t >= at(D, 5) && t < at(D, 10) ? 3.4 : 0) + (t >= at(D, 6) && t < at(D, 7) ? 9.6 : 0);
    const setbackNest = nestRows(D, 5, 10, t => t < at(D, 6) ? 62 : 68);
    const sb = run(extra, { nest: setbackNest, outdoorF: () => 38, balanceF: 34 });
    expect(sb.cause).toBe('setback'); expect(sb.setbackF).toBe(6);
    expect(sb.runs[0].setback).toEqual({ fromF: 62, toF: 68, at: at(D, 6) });
    expect(whyText(sb, 'heat-pump')).toBe('Catching up from the 62° night setback (heat to 68° at 6:00 AM). Outside was 38°, above the ~34° point where the heat pump needs help.');
    expect(tipText(sb, 'heat-pump', { day: '2027-01-07', kwh: 5.5 })).toBe('Keep overnight setbacks to 2° or less. The heat pump catches up without the strips. A 2° setback last Thursday used 4.1 kWh less.');
    const cold = run(extra, { outdoorF: () => 25, balanceF: 34 });
    expect(cold.cause).toBe('cold'); expect(cold.setbackF).toBeNull();
    expect(whyText(cold, 'heat-pump')).toBe('Genuine cold: 25° outside, below the ~34° point where the heat pump needs help, with no setpoint change.');
    expect(run(extra, { nest: setbackNest, outdoorF: () => 25, balanceF: 34 }).cause).toBe('both');
    // a 1° nudge is not a setback
    expect(setbackBefore(nestRows(D, 5, 10, t => t < at(D, 6) ? 67 : 68), at(D, 6))).toBeNull();
    // mild, no setpoint change: neither (defrost)
    expect(run(extra, { outdoorF: () => 45, balanceF: 34 }).cause).toBeNull();
  });
  it('STR-6 energy only: 04:00–10:00, under 50°F, 6 kW or more; estimated. Learning with few heating steps', () => {
    const extra = (t: number) => (t >= at(D, 5) && t < at(D, 6) + 30 * MIN ? 10 : 0) + (t >= at(D, 11) && t < at(D, 12) ? 10 : 0);
    const lv = levelsFor({ heatKw: null, heatSamples: 0 });
    const e = classifyDay({ day: D, buckets: dayBuckets(D, extra), baseKw: BASE, levels: lv, balanceF: 40, nest: null, outdoorF: () => 30 });
    expect(e).toMatchObject({ mode: 'energy', stripMin: 90, hpMin: null, cause: 'cold' });   // 11:00 is outside the window
    expect(e.stripKwh).toBeCloseTo(18 * 10 / 12, 1);
    expect(e.conf).toBe('learning');                            // no heating steps learned yet
    const est = classifyDay({ day: D, buckets: dayBuckets(D, extra), baseKw: BASE, levels: HP, balanceF: 40, nest: null, outdoorF: () => 30 });
    expect(est.conf).toBe('estimated');
    expect(est.stripKwh).toBeCloseTo(18 * (10 - 3.4) / 12, 1);   // a heat pump's compressor still comes out
    expect(classifyDay({ day: D, buckets: dayBuckets(D, extra), baseKw: BASE, levels: HP, balanceF: 40, nest: null, outdoorF: () => 52 }).stripMin).toBe(0);
    expect(classifyDay({ day: D, buckets: dayBuckets(D, t => extra(t) / 2), baseKw: BASE, levels: HP, balanceF: 40, nest: null, outdoorF: () => 30 }).stripMin).toBe(0);   // 5 kW < 6
    // mild energy-only morning with strips: most likely a recovery (a guess)
    expect(classifyDay({ day: D, buckets: dayBuckets(D, extra), baseKw: BASE, levels: HP, balanceF: 40, nest: null, outdoorF: () => 45 }).cause).toBe('setback');
    // Nest with heat_f and learned levels: measured
    expect(run(t => (t >= at(D, 6) && t < at(D, 7) ? 13 : 0)).conf).toBe('measured');
  });
  it('STR-7 a straight AC heats on the strips alone; stages stack at 1.6×', () => {
    const lv = levelsFor({ heatKw: 9.5, heatSamples: 8 });
    const extra = (t: number) => t >= at(D, 6) && t < at(D, 7) ? (t >= at(D, 6) + 30 * MIN ? 19 : 9.5) : 0;
    const d = classifyDay({ day: D, buckets: dayBuckets(D, extra), baseKw: BASE, levels: lv, balanceF: 40, nest: nestRows(D, 6, 7), outdoorF: () => 30 });
    expect(d.stripMin).toBe(60); expect(d.hpMin).toBe(0); expect(d.stackedMin).toBe(30);
    expect(d.stripKwh).toBe(14.3);   // (6 × 9.5 + 6 × 19) / 12 = 14.25, to one decimal
    expect(d.hpKw).toBeNull();
  });
  it('STR-8 DST days keep their local hours (fall back and spring forward)', () => {
    for (const day of ['2026-11-01', '2027-03-14']) {
      const extra = (t: number) => (t >= at(day, 5) && t < at(day, 9) ? 3.4 : 0) + (t >= at(day, 6) && t < at(day, 7) ? 9.6 : 0);
      const bs = dayBuckets(day, extra);
      expect(bs.length).toBe(day === '2026-11-01' ? 300 : 276);   // 25 and 23 hours
      const d = classifyDay({ day, buckets: bs, baseKw: BASE, levels: HP, balanceF: 40, nest: nestRows(day, 5, 9), outdoorF: () => 45 });
      expect(d.stripMin).toBe(60); expect(d.stripKwh).toBeCloseTo(12 * 9.6 / 12, 1);
      expect(d.quarters[0].at).toBe(at(day, 4));
      expect(d.quarters.filter(q => q.cls === 'st').map(q => q.at)).toEqual([0, 1, 2, 3].map(i => at(day, 6) + i * 900_000));
      // energy only on the same day: the 04:00–10:00 window in local hours
      const e = classifyDay({ day, buckets: dayBuckets(day, t => t >= at(day, 9) && t < at(day, 11) ? 10 : 0), baseKw: BASE, levels: HP, balanceF: 40, nest: null, outdoorF: () => 30 });
      expect(e.stripMin).toBe(60);   // 09:00–10:00 only
    }
  });
});

describe('the alert, the metrics, the week, the back-test', () => {
  const day = (stripKwh: number, cause: 'setback' | 'cold' | 'both' | null, outdoorF = 30) => ({ day: D, mode: 'nest' as const, stripKwh, stripMin: 95, hpMin: 130, stackedMin: 0, peakKw: 9.6, hpKw: 3.4, cause, conf: 'measured' as const,
    runs: [{ start: at(D, 6), end: at(D, 7) + 35 * MIN, kwh: stripKwh, cause, setback: cause === 'setback' || cause === 'both' ? { fromF: 62, toF: 68, at: at(D, 6) } : null, outdoorF }], setbackF: cause === 'setback' ? 6 : null, balanceF: 34, quarters: [] });
  it('STR-9 setback-heavy pushes, cold-heavy is feed only, a light morning is nothing', () => {
    expect(HEAVY_STRIP_KWH).toBe(12);
    expect(alertFor(day(13.8, 'setback'))).toEqual({ push: true, title: 'Strip heat ran 1 h 35 m this morning', body: 'About 14 kWh, mostly catching up from the 62° setback. A shallower setback keeps the strips off.' });
    expect(alertFor(day(13.8, 'both'))?.push).toBe(true);
    expect(alertFor(day(13.8, 'cold', 22))).toMatchObject({ push: false, body: 'About 14 kWh on a 22° morning, below the ~34° point where the heat pump needs help. No setback to blame: the cold did it.' });
    expect(alertFor(day(11.9, 'setback'))).toBeNull();
    expect(Object.fromEntries(stripMetrics(day(13.8, 'setback')))).toEqual({ 'strip.kwh': 13.8, 'strip.min': 95, 'hp.min': 130, 'strip.peak_kw': 9.6, 'strip.cause': 2, 'strip.conf': 2, 'strip.setback_f': 6 });
    expect([1, 2, 3, 0].map(causeOf)).toEqual(['cold', 'setback', 'both', null]);
    const w = weekSummary({ a: { 'strip.kwh': 14, 'strip.cause': 2 }, b: { 'strip.kwh': 9.2, 'strip.cause': 1 }, c: { 'strip.kwh': 7.6, 'strip.cause': 3 }, d: { 'strip.kwh': .2, 'strip.cause': 2 }, e: { 'hp.min': 30 } });
    expect(w).toEqual({ mornings: 3, kwh: 31, setbacks: 2 });
    expect(digestLine(w)).toBe('Strip heat: 3 mornings · 31 kWh (2 after setbacks).');
    expect(digestLine({ mornings: 1, kwh: 6, setbacks: 0 })).toBe('Strip heat: 1 morning · 6 kWh.');
    expect(digestLine({ mornings: 0, kwh: 0, setbacks: 0 })).toBeNull();
  });
  it('STR-10 the back-test over a synthetic winter; the heating ceiling', () => {
    // Nov 1 – Mar 31: a cold front every ninth day (14–18 kWh of strips, half after a setback), a mild strip morning every third (3–6), else none
    const days: Array<{ stripKwh: number; cause: 'setback' | 'cold' | null }> = [];
    for (let i = 0; i < 151; i++) days.push(i % 9 === 0 ? { stripKwh: 14 + (i % 5), cause: i % 2 ? 'setback' : 'cold' } : i % 3 === 0 ? { stripKwh: 3 + (i % 4), cause: 'setback' } : { stripKwh: 0, cause: null });
    const b = backtest(days);
    expect(b).toMatchObject({ days: 151, stripDays: 51, heavyDays: 17, heavyKwh: 12 });
    expect(b.wouldPush).toBe(days.filter(d => d.stripKwh >= 12 && d.cause === 'setback').length);
    expect(b.p50).toBeLessThan(12); expect(b.p90).toBeGreaterThanOrEqual(12);
    expect(b.suggestedKwh).toBeGreaterThanOrEqual(12); expect(b.suggestedKwh).toBeLessThanOrEqual(18);   // ~12 kWh is in the heavy tail, as the constant says
    expect(backtest([]).suggestedKwh).toBeNull();
    expect(heatingCeilingKw(HP)).toBeCloseTo(3.4 + 2 * 4.8 + .5, 1);
    expect(heatingCeilingKw(null, 3.4)).toBe(18.4);
    expect(heatingCeilingKw(null, null)).toBe(19);
  });
});

describe('the 5-minute cron step', () => {
  it('STR-11 only the 10:00–10:15 ticks do anything; every other tick returns before the database', async () => {
    const ticks: number[] = []; for (let t = at(D, 0); t < localAt(addDays(D, 1), 0); t += 5 * MIN) ticks.push(t + 20_000);
    const due: number[] = [];
    for (const t of ticks) {
      const r = await stripWatch('s', t).catch((e: Error) => { due.push(t); return e.message; });
      if (!due.includes(t)) expect(r).toEqual({ skipped: 'not 10:00' });
    }
    expect(due).toEqual([at(D, 10), at(D, 10) + 5 * MIN, at(D, 10) + 10 * MIN].map(t => t + 20_000));   // these reached the (mocked, throwing) database
    expect(q).toHaveBeenCalled();   // …through q, as the claim
  });
});

describe('guests', () => {
  it('STR-12 the AC guest view keeps no strip field; the Strip heat card has no guest view at all', () => {
    const view = GUEST_GET.get('/api/appliances/ac')!;
    const out = view({ id: 'ac', name: 'AC', strip: { kwh: 13.8 }, stripHeat: { today: {} }, today: { stripKwh: 13.8 }, heating: { kind: 'heat-pump' }, week: [], learned: { heatKw: 3.4, heatSamples: 6, stripKw: 9.6 } });
    expect(JSON.stringify(out)).not.toMatch(/strip|heating/i);
    expect(GUEST_GET.has('/api/appliances/ac/strip')).toBe(false);
  });
});
