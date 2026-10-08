// I-22 load signatures (server/src/loads.ts, approved mockup am frames 4–5), the pure parts: step pairing, the median filter, overlaps,
// the AC-edge rule, the pump taken out all day, DST days, clustering and its support, label matching, the suggestions, and agreement
// with the trip report's waterHeaterKwh on a like-for-like day. All data synthetic.
import { describe, it, expect } from 'vitest';
import { detectBursts, acDraw, pumpDraw, acSwitches, clusterLoads, matchLabel, bandOf, suggest, windowOf, labelName, medianFilter, type LoadBucket, type StoredBurst, type Label } from '../../server/src/loads.js';
import { waterHeaterKwh } from '../../server/src/vacation/report.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

const B = 300_000, D = '2026-10-01';
/** One local day of 5-minute buckets: `base` kW plus `extra(minuteOfDay, epoch)`. */
function day(d: string, base: number, extra: (m: number, t: number) => number = () => 0): LoadBucket[] {
  const out: LoadBucket[] = [];
  for (let t = localMidnight(d).getTime(); t < localMidnight(addDays(d, 1)).getTime(); t += B) {
    const s = rfc3339(new Date(t)), h = +s.slice(11, 13), m = h * 60 + +s.slice(14, 16);
    out.push({ epoch: t, day: d, hour: h, kw: base + extra(m, t) });
  }
  return out;
}
const at = (h: number, m = 0) => h * 60 + m;
const on = (m: number, from: number, mins: number, kw: number) => m >= from && m < from + mins ? kw : 0;
const base1 = { base: () => 1 };

describe('detection', () => {
  it('LD-1 a step up paired with a like step down is one burst: kW above the base, minutes, kWh', () => {
    const bs = detectBursts(day(D, 1, m => on(m, at(17), 30, 4.4)), base1);
    expect(bs.map(b => [b.hour, b.minutes, b.kw, b.kwh, b.overlap])).toEqual([[17, 30, 4.4, 2.2, false]]);
    // a step down of another size (here a load that stays on at 1.4 kW, 4.4 → 1.4 is 68% of the step) is no pair
    expect(detectBursts(day(D, 1, m => on(m, at(17), 30, 4.4) + on(m, at(17, 30), 60, 1.4)), base1)).toEqual([]);
  });
  it('LD-2 one inflated bucket never starts, shapes or inflates a burst; under 10 minutes or 1.5 kW is no burst', () => {
    expect(detectBursts(day(D, 1, m => m === at(9) ? 9 : 0), base1)).toEqual([]);                        // a lone 9 kW bucket
    const spiked = detectBursts(day(D, 1, m => on(m, at(17), 30, 4.4) + (m === at(17, 10) ? 10 : 0)), base1);
    expect(spiked.map(b => [b.minutes, b.kw])).toEqual([[30, 4.4]]);
    expect(spiked[0].kwh).toBeLessThanOrEqual(2.2 + (1.5 * 4.4 - 4.4) / 12 + 1e-9);                       // capped at 1.5 × the burst's kW
    expect(medianFilter([0, 0, 9, 0, 0])).toEqual([0, 0, 0, 0, 0]);
    expect(detectBursts(day(D, 1, m => on(m, at(12), 5, 4)), base1)).toEqual([]);                          // 5 minutes
    expect(detectBursts(day(D, 1, m => on(m, at(12), 60, 1.3)), base1)).toEqual([]);                       // 1.3 kW
    expect(detectBursts(day(D, 1, m => on(m, at(12), 10, 1.6)), base1).map(b => [b.minutes, b.kw])).toEqual([[10, 1.6]]);
  });
  it('LD-3 a step that lands mid-bucket (one in-between bucket each side) is still one burst', () => {
    const bs = detectBursts(day(D, 1, m => m === at(8) || m === at(8, 35) ? 2.2 : on(m, at(8, 5), 30, 4.4)), base1);
    expect(bs.map(b => [b.minutes, b.kw])).toEqual([[40, 4.4]]);
    expect(bs[0].kwh).toBeCloseTo(4.4 * 30 / 60 + 2 * 2.2 / 12, 2);
  });
  it('LD-4 a water heater inside a dryer run is two bursts: the inner one gets only its own kW and is an overlap', () => {
    const bs = detectBursts(day(D, 1, m => on(m, at(17), 45, 5) + on(m, at(17, 10), 20, 4.4)), base1);
    expect(bs.map(b => [b.minutes, b.kw, b.overlap])).toEqual([[45, 5, false], [20, 4.4, true]]);
    expect(bs.reduce((a, b) => a + b.kwh, 0)).toBeCloseTo(5 * .75 + 4.4 / 3, 2);                           // the energy is split, not counted twice
  });
  it('LD-5 (v2) buckets with the AC running are not used: the AC\'s edge leaves no load, a variable-speed plateau leaves none, a load outside AC time counts', () => {
    // the AC (3 kW) starts at 14:00 but the Nest reports cooling from 14:15: the run breaks at 14:15, so the 15-minute edge pairs with nothing
    const t0 = localMidnight(D).getTime(), nest = [{ ts: t0 + at(13, 45) * 60_000, hvac: 'OFF' }, ...Array.from({ length: 4 }, (_, i) => ({ ts: t0 + (at(14, 15) + 15 * i) * 60_000, hvac: 'COOLING' })), { ts: t0 + at(15, 15) * 60_000, hvac: 'OFF' }];
    const bs = day(D, 1, m => on(m, at(14), 75, 3)), ac = acDraw(nest, 3, null);
    expect(detectBursts(bs, { ...base1, ac })).toEqual([]);
    expect(detectBursts(bs, { ...base1, ac, switches: acSwitches(nest, 3, null) })).toEqual([]);
    // a variable-speed compressor running at 1.7 kW against a learned 3 kW: no "load" from the difference
    const vs = day(D, 1, m => on(m, at(14, 15), 60, 1.7));
    expect(detectBursts(vs, { ...base1, ac })).toEqual([]);
    // a dryer while the AC runs is not counted (the residual there can't be trusted); the same dryer at 17:00 is
    const during = day(D, 1, m => on(m, at(14), 75, 3) + on(m, at(14, 30), 30, 5)), after = day(D, 1, m => on(m, at(17), 30, 5));
    expect(detectBursts(during, { ...base1, ac, switches: acSwitches(nest, 3, null) })).toEqual([]);
    expect(detectBursts(after, { ...base1, ac }).map(b => [b.minutes, b.kw])).toEqual([[30, 5]]);
    // heating with no heating kW learned: those buckets can't be used either
    const heat = nest.map(r => ({ ...r, hvac: r.hvac === 'COOLING' ? 'HEATING' : r.hvac }));
    expect(detectBursts(during, { ...base1, ac: acDraw(heat, 3, null) }).filter(b => b.hour === 14)).toEqual([]);
  });
  it('LD-6 the pump\'s daytime draw comes out (readings carried at most 20 minutes)', () => {
    const t0 = localMidnight(D).getTime(), reads: Array<{ ts: number; running: boolean; watts: number; rpm: number }> = [];
    for (let m = at(10, 5); m < at(19); m += 15) reads.push({ ts: t0 + m * 60_000, running: true, watts: 2000, rpm: 2400 });
    reads.push({ ts: t0 + at(19, 5) * 60_000, running: false, watts: 0, rpm: 0 });
    const bs = day(D, 1, m => on(m, at(10), 9 * 60, 2));
    expect(detectBursts(bs, base1).map(b => [b.minutes, b.kw])).toEqual([[540, 2]]);                       // without it: a 9-hour "load"
    expect(detectBursts(bs, { ...base1, pump: pumpDraw(reads) })).toEqual([]);
    expect(pumpDraw(reads)(t0 + at(21) * 60_000)).toBe(0);                                                 // nothing carried past 20 minutes
  });
  it('LD-7 DST: the 23-hour and 25-hour days keep real minutes across the jump', () => {
    const spring = day('2026-03-08', 1, m => m >= at(1, 30) && m < at(3, 30) ? 3 : 0);                     // 01:30–03:30 local is one real hour
    expect(spring).toHaveLength(276);
    expect(detectBursts(spring, base1).map(b => [b.hour, b.minutes, b.kw])).toEqual([[1, 60, 3]]);
    // fall back: 00:30 to 02:00 local holds the repeated 1 AM hour, two and a half real hours
    const t0 = localMidnight('2026-11-01').getTime(), fall = day('2026-11-01', 1, (_m, t) => t >= t0 + 30 * 60_000 && t < t0 + 180 * 60_000 ? 3 : 0);
    expect(fall).toHaveLength(300);
    expect(detectBursts(fall, base1).map(b => [b.hour, b.minutes])).toEqual([[0, 150]]);
  });
  it('LD-8 agrees with the trip report\'s waterHeaterKwh on a water-heater-only day', () => {
    const runs = [at(5), at(7, 30), at(12), at(16), at(19), at(22)];
    const bs = day(D, .8, m => runs.reduce((a, r) => a + on(m, r, 20, 4.5), 0));
    const ours = detectBursts(bs, { base: () => .8 }).reduce((a, b) => a + b.kwh, 0);
    const theirs = waterHeaterKwh(bs.map(b => ({ epoch: b.epoch, homeWh: b.kw * 1000 / 12 })), .8);
    expect(ours).toBeCloseTo(9, 1);
    expect(Math.abs(ours - theirs) / theirs).toBeLessThan(.05);
  });
});

/* ---------- clusters ---------- */
const TODAY = '2026-10-07';
let n = 0;
const sb = (d: string, hour: number, kw: number, minutes: number, overlap = false): StoredBurst =>
  ({ start: localMidnight(d).getTime() + hour * 3600e3 + (n++ % 5) * 60_000, day: d, hour, minutes, kw, kwh: kw * minutes / 60, overlap, sig: bandOf(kw, minutes), labelId: null });
/** `per` bursts on each of `days` days ending yesterday. */
const many = (days: number, per: number, hour: (i: number) => number, kw: number, minutes: number) =>
  Array.from({ length: days }, (_, i) => Array.from({ length: per }, (_, j) => sb(addDays(TODAY, -1 - i), hour(i * per + j), kw + (j % 2 ? .1 : -.1), minutes))).flat();

describe('clusters', () => {
  it('LD-9 bands, support (8 on 4 days in the last 30) and a deterministic result', () => {
    expect([bandOf(1.4, 60), bandOf(2.6, 50), bandOf(4.4, 22), bandOf(7.2, 95), bandOf(3, 9)]).toEqual([null, 'k1m2', 'k2m1', 'k5m3', null]);
    const oven = many(10, 1, () => 17, 2.6, 50), dryer = many(3, 2, () => 19, 5.1, 45), stray = [sb(addDays(TODAY, -2), 3, 6.5, 100)];
    const a = clusterLoads([...oven, ...dryer, ...stray], [], { today: TODAY, days30: 20 });
    expect(a.clusters.map(c => [c.sig, c.found, c.badge, c.count])).toEqual([['k1m2', true, 'estimated', 10], ['k3m2', false, 'learning', 6]]);
    expect(a.unsorted.count).toBe(1);
    expect(a.clusters[0]).toMatchObject({ kw: 2.5, minutes: 50, perDay: .5, window: { from: 17, to: 18 }, suggestion: { name: 'Oven' } });
    const b = clusterLoads([...stray, ...dryer, ...oven].reverse(), [], { today: TODAY, days30: 20 });
    expect(b).toEqual(a);
  });
  it('LD-10 a band is one cluster at any time of day (mockup am frame 4: the water heater is one row, "day and night")', () => {
    const morning = many(5, 2, () => 7, 2.2, 60), late = many(5, 2, () => 22, 2.2, 60);
    const both = clusterLoads([...morning, ...late], [], { today: TODAY, days30: 30 }).clusters;
    expect(both.map(c => c.sig)).toEqual(['k0m2']);
    expect(both[0].hist[7]).toBeGreaterThan(0); expect(both[0].hist[22]).toBeGreaterThan(0);   // when it runs is the strip
    expect(clusterLoads(late, [], { today: TODAY, days30: 30 }).clusters[0].suggestion).toEqual({ name: 'Dishwasher', text: 'Could be the dishwasher.' });
  });
  it('LD-10b one appliance straddling a band edge (4.4 and 4.7 kW, 25 min) is one cluster; a clearly different load stays apart', () => {
    const a = many(6, 2, () => 9, 4.4, 25), b = many(6, 1, () => 13, 4.7, 25), oven = many(6, 1, () => 17, 2.6, 50);
    const c = clusterLoads([...a, ...b, ...oven], [], { today: TODAY, days30: 30 }).clusters;
    expect(c).toHaveLength(2);
    expect(c.map(x => x.count).sort((p, q) => q - p)).toEqual([18, 6]);
    const wh = c.find(x => x.count === 18)!; expect(wh.kw).toBeGreaterThanOrEqual(4.3); expect(wh.kw).toBeLessThanOrEqual(4.8); expect(wh.minutes).toBe(25);
  });
  it('LD-11 a name catches bursts within ±20% kW and 1.5× the minutes; the nearest centre wins', () => {
    const L = (id: number, kw: number, minutes: number, extra: Partial<Label> = {}): Label => ({ id, sig: `s${id}`, name: `n${id}`, kw, minutes, daypart: null, dismissed: false, ...extra });
    const wh = L(1, 4.4, 22);
    expect([[5.2, 30], [5.3, 22], [4.4, 33], [4.4, 34], [4.4, 15], [4.4, 14], [3.6, 22]].map(([kw, minutes]) => matchLabel({ kw, minutes, hour: 9 }, [wh])))
      .toEqual([1, null, 1, null, 1, null, 1]);
    expect(matchLabel({ kw: 4.9, minutes: 40, hour: 9 }, [wh, L(2, 5.1, 45)])).toBe(2);
    expect(matchLabel({ kw: 4.4, minutes: 22, hour: 9 }, [L(1, 4.4, 22, { name: null, dismissed: true })])).toBeNull();   // "Not one appliance" catches nothing
  });
  it('LD-12 badges: never measured; learned = named, 20+ runs, steady two weeks; overlap-heavy stays estimated', () => {
    const wh = many(14, 2, i => i % 24, 4.4, 22), lab: Label = { id: 7, sig: 'k2m1', name: 'Water heater', kw: 4.4, minutes: 22, daypart: null, dismissed: false };
    const named = clusterLoads(wh, [lab], { today: TODAY, days30: 14 }).clusters[0];
    expect(named).toMatchObject({ labelId: 7, name: 'Water heater', badge: 'learned', hue: 0, suggestion: null });
    expect(clusterLoads(wh, [], { today: TODAY, days30: 14 }).clusters[0]).toMatchObject({ badge: 'estimated', suggestion: { name: 'Water heater' } });
    expect(clusterLoads(wh.map(b => ({ ...b, overlap: true })), [lab], { today: TODAY, days30: 14 }).clusters[0].badge).toBe('estimated');
    expect(clusterLoads(wh.slice(0, 6), [lab], { today: TODAY, days30: 14 }).clusters[0].badge).toBe('learning');
    expect(windowOf(named.hist.map(v => v * 10))).toBeNull();                                                   // day and night
  });
  it('LD-13 suggestions and names', () => {
    const at17 = Array(24).fill(0).map((_, h) => h === 17 ? 5 : 0), at19 = at17.map((_, h) => h === 19 ? 5 : 0), spread = Array(24).fill(1);
    expect([suggest(4.4, 22, spread)?.name, suggest(5, 45, at19)?.name, suggest(2.6, 50, at17)?.name, suggest(9, 60, at17)]).toEqual(['Water heater', 'Dryer', 'Oven', null]);
    expect([labelName('  Oven '), labelName('EV / tool charger'), labelName(''), labelName('   '), labelName('x'.repeat(25)), labelName('a\u0007b'), labelName(4)]).toEqual(['Oven', 'EV / tool charger', null, null, null, null, null]);
  });
});

// v2 (2026-10-08): production showed AC 15.4 + always-on 20.3 + big 32.8 + pool 4.2 = 72.7 kWh a day against a 57.5 kWh home.
import { capInferred } from '../../server/src/breakdown.js';
describe('capInferred', () => {
  it('takes the excess off big loads first, then off named loads in proportion; measured parts untouched', () => {
    expect(capInferred({ home: 57.5, fixed: 15.4 + 20.3 + 4.2, big: 32.8, named: [] })).toEqual({ big: 17.6, named: [], over: 15.2 });
    expect(capInferred({ home: 40, fixed: 30, big: 4, named: [6, 4] })).toEqual({ big: 0, named: [6, 4], over: 4 });   // big absorbs it all
    expect(capInferred({ home: 36, fixed: 30, big: 4, named: [6, 4] })).toEqual({ big: 0, named: [3.6, 2.4], over: 8 });   // then named, in proportion
    expect(capInferred({ home: 50, fixed: 30, big: 5, named: [5] })).toEqual({ big: 5, named: [5], over: 0 });
    expect(capInferred({ home: 20, fixed: 30, big: 5, named: [5] })).toEqual({ big: 0, named: [0], over: 20 });
  });
});
