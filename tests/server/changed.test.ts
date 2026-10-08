// I-18 "What changed" (server/src/learn/changed.ts, approved mockup mockups/am-ideas.html frames 1–3 and 8): the attribution is
// pure, so it is pinned here on synthetic days. All data synthetic.
import { describe, it, expect } from 'vitest';
import { attribute, dayBaseline, weatherModel, dayHours, mondayOf, type Day, type Inputs, type Changed } from '../../server/src/learn/changed.js';
import { GUEST_GET } from '../../server/src/redact.js';
import { addDays } from '../../server/src/tesla/client.js';

const D = '2026-10-06';   // a Tuesday
const SLOPES = { b: 1.5, c: 0, tc: 70, th: 60 };
const day = (d: string, o: Partial<Day> = {}): Day => ({ day: d, home: 40, imp: 8, solar: 50, complete: true, hours: 24, pool: 3, ac: 12, heatMin: 0,
  alwaysOnKw: 0.5, high: 89, low: 70, trip: false, clearUp: false, ...o });
/** 40 days ending on `end`, every one a plain synthetic day, with `over` applied. */
function days(end: string, over: Record<string, Partial<Day>> = {}, base: Partial<Day> = {}) {
  const m = new Map<string, Day>();
  for (let i = 40; i >= 0; i--) { const d = addDays(end, -i); m.set(d, day(d, { ...base, ...(over[d] ?? {}) })); }
  return m;
}
const run = (m: Map<string, Day>, o: Partial<Inputs> = {}) => attribute({ scope: 'day', date: D, days: m, weather: { ...SLOPES, learning: false }, heatKw: null, acConf: 'measured', ...o });
const part = (c: Changed, id: string) => c.home!.parts.find(p => p.id === id);
const tenths = (v: number) => Math.round(v * 10);
const addsUp = (c: Changed) => {
  expect(tenths(c.home!.parts.reduce((a, p) => a + p.kwh, 0))).toBe(tenths(c.home!.delta));
  expect(tenths(c.import!.parts.reduce((a, p) => a + p.kwh, 0))).toBe(tenths(c.import!.delta));
};

describe('I-18: the baseline', () => {
  it('CHG-1 the same weekday of the last 4 weeks, trip and Clear-up days and short days left out', () => {
    const m = days(D, { [addDays(D, -7)]: { trip: true }, [addDays(D, -14)]: { clearUp: true } });
    expect(dayBaseline(m, D)).toEqual({ kind: 'weekday', days: [addDays(D, -21), addDays(D, -28)] });
    m.set(addDays(D, -21), day(addDays(D, -21), { complete: false }));
    // one same weekday left: the last 7 eligible days instead (the trip and Clear-up days skipped)
    const b = dayBaseline(m, D)!;
    expect(b.kind).toBe('prev7'); expect(b.days).toHaveLength(7);
    expect(b.days).not.toContain(addDays(D, -7)); expect(b.days[0]).toBe(addDays(D, -1));
    expect(run(m).baseline).toEqual({ kind: 'prev7', days: 7 });
    expect(run(m).notes).toContain('prev7');
    // a guest's baseline doesn't know about trips: the trip day counts
    expect(dayBaseline(m, D, true)).toEqual({ kind: 'weekday', days: [addDays(D, -7), addDays(D, -28)] });
  });
  it('CHG-2 a day with no complete data, or no baseline, has no parts', () => {
    expect(run(days(D, { [D]: { complete: false } }))).toMatchObject({ home: null, import: null, notes: ['incomplete'] });
    expect(run(new Map([[D, day(D)]]))).toMatchObject({ home: null, notes: ['no-baseline'] });
  });
  it('CHG-3 day lengths: 23 h in spring, 25 h in autumn (Chicago)', () => {
    expect(dayHours('2026-03-08')).toBe(23); expect(dayHours('2026-11-01')).toBe(25); expect(dayHours('2026-10-06')).toBe(24);
    expect(mondayOf('2026-10-04')).toBe('2026-09-28'); expect(mondayOf('2026-10-05')).toBe('2026-10-05');
  });
});

describe('I-18: the parts', () => {
  it('CHG-4 the parts add up to the change exactly after rounding, every time', () => {
    let seed = 7; const M = 2 ** 31 - 1, rnd = () => (seed = (seed * 16807) % M) / M;
    for (let k = 0; k < 200; k++) {
      const m = days(D, {}, {});
      for (const [d, x] of m) m.set(d, { ...x, home: 30 + rnd() * 20, imp: rnd() * 15, solar: 40 + rnd() * 20, pool: rnd() * 5, ac: 5 + rnd() * 15, alwaysOnKw: .3 + rnd() * .5, high: 75 + rnd() * 25 });
      const c = run(m);
      addsUp(c);
      for (const p of c.home!.parts) expect(tenths(p.kwh)).toBeCloseTo(p.kwh * 10, 6);   // every part a whole tenth
    }
  });
  it('CHG-5 weather + AC beyond the weather = the AC change (no heating)', () => {
    const m = days(D, { [D]: { high: 96, ac: 17, home: 47, pool: 4.2, alwaysOnKw: 0.5, imp: 12 } });
    const c = run(m);
    expect(part(c, 'weather')).toEqual({ id: 'weather', kwh: 10.5, conf: 'estimated' });   // 1.5 × (96 − 70) − 1.5 × (89 − 70)
    expect(part(c, 'ac')).toEqual({ id: 'ac', kwh: -5.5, conf: 'measured' });              // 5 more AC kWh, 10.5 of them the weather's
    expect(tenths(part(c, 'weather')!.kwh + part(c, 'ac')!.kwh)).toBe(50);
    expect(part(c, 'pool')).toEqual({ id: 'pool', kwh: 1.2, conf: 'measured' });
    expect(part(c, 'alwaysOn')).toEqual({ id: 'alwaysOn', kwh: 0, conf: 'measured' });
    expect(part(c, 'unexplained')).toEqual({ id: 'unexplained', kwh: 0.8, conf: null });   // 7 − 10.5 + 5.5 − 1.2
    expect(c.home).toMatchObject({ obs: 47, base: 40, delta: 7 });
    expect(c.wx).toEqual({ high: 96, baseHigh: 89 });
    // bought: +4 = +7 used − 3 more covered by solar and the Powerwalls (S = used − bought: 35 against 32)
    expect(c.import).toMatchObject({ obs: 12, base: 8, delta: 4, parts: [{ id: 'home', kwh: 7, conf: null }, { id: 'solar', kwh: -3, conf: 'measured' }], solar: { obs: 50, base: 50 } });
    addsUp(c);
  });
  it('CHG-6 heating: no heating kW learned keeps the heat in weather; once learned, AC counts it and the weather share comes out', () => {
    const w = { b: 1.5, c: 2, tc: 70, th: 60, learning: false };
    const m = days(D, { [D]: { high: 50, low: 30, heatMin: 120, ac: 0, home: 70 } }, { high: 75, low: 62, heatMin: 0, ac: 4 });
    const no = run(m, { weather: w, heatKw: null });
    // weather: cooling 0 − 7.5, heating 2 × 30 − 0 = +60 → +52.5; AC: −4 − (−7.5) = +3.5 (the heating's kWh aren't in the AC figure)
    expect(part(no, 'weather')!.kwh).toBe(52.5); expect(part(no, 'ac')!.kwh).toBe(3.5);
    const yes = run(m, { weather: w, heatKw: 9 });
    // AC: 2 h × 9 kW of heating counted: ΔAC = 18 − 4 = 14; less the cooling share (−7.5) and the heating share (60) → −38.5
    expect(part(yes, 'weather')!.kwh).toBe(52.5); expect(part(yes, 'ac')!.kwh).toBe(-38.5);
    addsUp(no); addsUp(yes);
  });
  it('CHG-7 missing pool readings or Nest coverage: that part is left out and the rest still adds up', () => {
    const np = run(days(D, { [D]: { pool: null, home: 45 } }));
    expect(part(np, 'pool')).toBeUndefined(); expect(np.notes).toContain('pool-missing'); addsUp(np);
    const one = run(days(D, { [addDays(D, -7)]: { pool: null } }));
    expect(part(one, 'pool')).toMatchObject({ kwh: 0, conf: 'estimated' });   // a baseline day without readings: the others' mean, estimated
    const nn = run(days(D, { [D]: { ac: null, home: 45 } }));
    expect(part(nn, 'ac')).toBeUndefined(); expect(nn.notes).toContain('ac-uncovered'); addsUp(nn);
    expect(part(run(days(D, { [addDays(D, -14)]: { ac: null } })), 'ac')).toBeUndefined();   // the baseline must be covered too
    const na = run(days(D, { [D]: { alwaysOnKw: null } }));
    expect(part(na, 'alwaysOn')).toBeUndefined(); addsUp(na);
    const nw = run(days(D, { [D]: { high: null } }));
    expect(part(nw, 'weather')).toBeUndefined(); expect(nw.notes).toContain('weather-missing'); addsUp(nw);
    const nm = run(days(D), { weather: null });
    expect(part(nm, 'weather')).toBeUndefined(); expect(nm.notes).toContain('no-weather-model');
  });
  it('CHG-8 the 14-day line before a year fit: weather reads "learning"', () => {
    const m = days(D); let i = 0;
    for (const [d, x] of m) { const hi = 80 + (i++ % 8) * 2; m.set(d, { ...x, high: hi, home: 30 + 1.2 * (hi - 70) }); }
    const w = weatherModel(null, m, D)!;
    expect(w).toMatchObject({ c: 0, tc: 70, learning: true }); expect(w.b).toBeCloseTo(1.2, 2);
    expect(part(run(m, { weather: w }), 'weather')!.conf).toBe('learning');
    expect(weatherModel({ ...SLOPES }, m, D)).toEqual({ ...SLOPES, learning: false });
    expect(weatherModel(null, new Map(), D)).toBeNull();
  });
  it('CHG-9 always-on × the day length: a 25-hour day uses an hour more, a 23-hour day an hour less', () => {
    const fall = '2026-11-01', spring = '2026-03-08';
    const f = attribute({ scope: 'day', date: fall, days: days(fall, { [fall]: { hours: 25, alwaysOnKw: 1, home: 41 } }, { alwaysOnKw: 1 }), weather: null, heatKw: null, acConf: 'measured' });
    expect(part(f, 'alwaysOn')!.kwh).toBe(1); addsUp(f);
    const s = attribute({ scope: 'day', date: spring, days: days(spring, { [spring]: { hours: 23, alwaysOnKw: 1, home: 39 } }, { alwaysOnKw: 1 }), weather: null, heatKw: null, acConf: 'measured' });
    expect(part(s, 'alwaysOn')!.kwh).toBe(-1); addsUp(s);
  });
});

describe('I-18: trips', () => {
  it('CHG-10 an observed trip day: the trip part is the use less the day at home (its weather and pool run kept)', () => {
    // away: 20 kWh used on a 92° day (4.5 kWh more weather than a typical 89°), the pool ran its usual 3 kWh; at home: 40 + 4.5 = 44.5
    const m = days(D, { [D]: { trip: true, home: 20, high: 92, ac: 2, alwaysOnKw: 0.3 } });
    const c = run(m);
    expect(part(c, 'trip')).toEqual({ id: 'trip', kwh: -24.5, conf: 'estimated' });
    expect(part(c, 'weather')!.kwh).toBe(4.5);
    expect(part(c, 'ac')!.kwh).toBe(0);         // the AC "as at home": the baseline's AC moved by the weather
    expect(part(c, 'alwaysOn')!.kwh).toBe(0);   // the at-home always-on
    expect(part(c, 'unexplained')!.kwh).toBe(0);
    expect(c.notes).toContain('trip'); addsUp(c);
  });
  it('CHG-11 a trip in the week before: last week was low because nobody was home, so this week shows a positive trip part', () => {
    const mon = '2026-09-28', prev = Array.from({ length: 7 }, (_, i) => addDays(mon, i - 7));
    const m = days(addDays(mon, 6), Object.fromEntries(prev.slice(2, 5).map(d => [d, { trip: true, home: 15, ac: 1 }])));
    const c = attribute({ scope: 'week', date: addDays(mon, 3), days: m, weather: { ...SLOPES, learning: false }, heatKw: null, acConf: 'measured' });
    expect(c).toMatchObject({ scope: 'week', date: mon, to: '2026-10-04', baseline: { kind: 'week', days: 7 } });
    expect(c.home).toMatchObject({ obs: 280, base: 205, delta: 75 });
    expect(part(c, 'trip')!.kwh).toBe(75);   // 3 days × (40 at home − 15 away)
    expect(part(c, 'ac')!.kwh).toBe(0); expect(part(c, 'unexplained')!.kwh).toBe(0);
    addsUp(c);
  });
});

describe('I-18: guests', () => {
  const m = () => days(D, { [D]: { trip: true, home: 20, high: 92 }, [addDays(D, -7)]: { trip: true, home: 18 } });
  it('CHG-12 a guest gets weather, pool and everything else, computed without trips, and the parts still add up', () => {
    const g = run(m(), { guest: true });
    expect(g.home!.parts.map(p => p.id)).toEqual(['weather', 'pool', 'other']);
    expect(g.import!.parts.map(p => p.id)).toEqual(['home', 'solar']);
    expect(g.notes).toEqual([]);
    expect(g.baseline).toEqual({ kind: 'weekday', days: 4 });   // the trip day in the baseline is not left out for a guest
    addsUp(g);
    const owner = run(m());
    expect(owner.baseline).toEqual({ kind: 'weekday', days: 3 });
    expect(owner.home!.parts.map(p => p.id)).toContain('trip');
  });
  it('CHG-13 the guest view lets no trip, AC, always-on or unexplained part, and no note, through', () => {
    const view = GUEST_GET.get('/api/changed')!;
    const fromOwner = view(JSON.parse(JSON.stringify(run(m())))) as any;
    expect(JSON.stringify(fromOwner)).not.toMatch(/trip|alwaysOn|"ac"|unexplained|notes/);
    expect(fromOwner.home.parts.map((p: any) => p.id)).toEqual(['weather', 'pool']);
    const g = run(m(), { guest: true }), served = view(JSON.parse(JSON.stringify(g))) as any;
    expect(served).toEqual(JSON.parse(JSON.stringify({ ...g, notes: undefined })));   // everything else of a guest's answer passes
    expect(tenths(served.home.parts.reduce((a: number, p: any) => a + p.kwh, 0))).toBe(tenths(served.home.delta));
  });
});
