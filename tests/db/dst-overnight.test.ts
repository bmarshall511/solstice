// The overnight baselines on the two DST change days (audit 10b, test batch 7 item 4). Every night figure reads the 01:00–05:00 clock
// window (hour BETWEEN 1 AND 4): the always-on base (breakdown.ts nightBase via alwaysOnKw), the overnight split behind /api/overnight
// (overnightSplit), the 13-month trend (nightBases) and the nightly home.overnight_kw metric (learn/nightly.ts).
//   Fall back, Sun 2025-11-02 (25 h): 01:00 happens twice, so the window holds 5 real hours (60 five-minute buckets, 24 in hour 1).
//   Spring forward, Sun 2026-03-08 (23 h): 02:00 never happens, so the window holds 3 real hours (36 buckets, none in hour 2).
// A flat 1.2 kW house (100 Wh a bucket) with the repeated 01:00 hour at 2.4 kW on the fall-back night, so a kW figure that divides by
// clock hours instead of real time shows. Nest reads every 5 minutes all night, AC off. All values synthetic.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { q, migrate } from '../../server/src/db.js';
import { alwaysOnKw, overnightSplit, nightBases } from '../../server/src/breakdown.js';
import { runLearn } from '../../server/src/learn/nightly.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({ configured: () => false, readPool: vi.fn(), writePoolPlan: vi.fn(), withUnit: vi.fn() }));
const S = 'dst';
const FALL = '2025-11-02', SPRING = '2026-03-08';
const noon = (day: string) => localMidnight(day).getTime() + 12 * 3600e3;

/** Every 5-minute bucket of `day` as Tesla stores it (local RFC3339 ts, Chicago day/hour); `kw` per bucket. */
function buckets(day: string, kw: (hour: number, secondOne: boolean) => number) {
  const out: Array<{ ts: string; epoch: number; hour: number; wh: number }> = [];
  let seenOne = false, firstOneOffset = '';
  for (let t = localMidnight(day).getTime(); t < localMidnight(addDays(day, 1)).getTime(); t += 300_000) {
    const ts = rfc3339(new Date(t)), hour = +ts.slice(11, 13);
    if (hour === 1 && !seenOne) { seenOne = true; firstOneOffset = ts.slice(19); }
    out.push({ ts, epoch: t, hour, wh: Math.round(kw(hour, hour === 1 && ts.slice(19) !== firstOneOffset) * 1000 / 12) });
  }
  return out;
}
async function seed(day: string, kw: (hour: number, secondOne: boolean) => number) {
  const b = buckets(day, kw);
  await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh, solar_wh, import_wh, export_wh, charge_wh, discharge_wh)
    SELECT $1, ts, epoch, $2, hour, wh, 0, wh, 0, 0, 0 FROM unnest($3::text[], $4::bigint[], $5::int[], $6::int[]) AS x(ts, epoch, hour, wh)`,
    [S, day, b.map(x => x.ts), b.map(x => x.epoch), b.map(x => x.hour), b.map(x => x.wh)]);
  await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac) SELECT $1, ts, $2, hour, 'OFF' FROM unnest($3::bigint[], $4::int[]) AS x(ts, hour) WHERE hour BETWEEN 0 AND 5`,
    [S, day, b.map(x => x.epoch), b.map(x => x.hour)]);
}
const flat = () => 1.2;
const repeatedHourHigh = (_h: number, second: boolean) => second ? 2.4 : 1.2;

beforeAll(async () => {
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, NULL, 1, 'Test')`, [S]);
  for (const d of ['2025-10-31', '2025-11-01']) await seed(d, flat);
  await seed(FALL, repeatedHourHigh);
  await seed('2025-11-03', flat);
  for (const d of ['2026-03-06', '2026-03-07', SPRING, '2026-03-09']) await seed(d, flat);
});

describe('the fixtures', () => {
  it('DSTN-0 the windows hold 60, 48 and 36 buckets; the repeated 01:00 has 24, the missing 02:00 none', async () => {
    const r = await q<{ day: string; n: number; h1: number; h2: number }>(`SELECT day, COUNT(*)::int n, (COUNT(*) FILTER (WHERE hour = 1))::int h1, (COUNT(*) FILTER (WHERE hour = 2))::int h2
      FROM energy WHERE site_id = $1 AND hour BETWEEN 1 AND 4 AND day IN ($2, $3, '2025-11-01') GROUP BY day ORDER BY day`, [S, FALL, SPRING]);
    expect(r).toEqual([{ day: '2025-11-01', n: 48, h1: 12, h2: 12 }, { day: FALL, n: 60, h1: 24, h2: 12 }, { day: SPRING, n: 36, h1: 12, h2: 0 }]);
  });
});

describe('fall back (25-hour day)', () => {
  it('DSTN-1 overnightSplit (/api/overnight): the night\'s kW is energy over real time, the repeated hour included', async () => {
    const nights = await overnightSplit(S, '2025-11-01');
    const fall = nights.find(n => n.date === FALL)!;
    expect(fall.kw).toBeCloseTo((48 * 1.2 + 12 * 2.4) / 60, 3);              // 1.44 kW over 5 real hours, not 1.8 (the same energy over 4 clock hours)
    expect(fall.split).toBe(true);                                            // Nest covered the window
    expect(fall.base).toBeCloseTo(1.2, 3);                                    // the quietest tenth: the repeated hour's 2.4 kW does not lift it
    expect(nights.find(n => n.date === '2025-11-01')).toMatchObject({ kw: 1.2, base: 1.2, split: true });
  });
  it('DSTN-2 alwaysOnKw (nightBase): the fall-back night counts, at its quiet base', async () => {
    const r = await alwaysOnKw(S, 3, { now: noon('2025-11-03'), trips: new Set(), clearUp: null });
    expect(r.nights.map(n => [n.day, n.kw])).toEqual([['2025-10-31', 1.2], ['2025-11-01', 1.2], [FALL, 1.2]]);
    expect(r.kw).toBe(1.2);
  });
  it('DSTN-3 nightBases (the 13-month trend) keeps the fall-back night', async () => {
    const r = await nightBases(S, '2025-11-01');
    expect(r.filter(n => n.day <= '2025-11-03').map(n => n.day)).toEqual(['2025-11-01', FALL, '2025-11-03']);
    expect(r.find(n => n.day === FALL)!.kw).toBeCloseTo(1.2, 3);
  });
});

describe('spring forward (23-hour day)', () => {
  it('DSTN-4 overnightSplit: the 3-hour night is a whole night, split like any other', async () => {
    const spring = (await overnightSplit(S, '2026-03-07')).find(n => n.date === SPRING)!;
    expect(spring).toMatchObject({ kw: 1.2, base: 1.2, split: true });
  });
  it('DSTN-5 alwaysOnKw: the spring-forward night (36 of its 36 buckets) is not dropped as incomplete', async () => {
    const r = await alwaysOnKw(S, 3, { now: noon('2026-03-09'), trips: new Set(), clearUp: null });
    expect(r.nights.map(n => n.day)).toEqual(['2026-03-06', '2026-03-07', SPRING]);
    expect(r.nights.every(n => n.split && n.kw === 1.2)).toBe(true);
  });
  it('DSTN-6 nightBases keeps the spring-forward night', async () => {
    expect((await nightBases(S, '2026-03-07')).map(n => n.day)).toEqual(['2026-03-07', SPRING, '2026-03-09']);
  });
});

describe('the nightly overnight metric (learn/nightly.ts)', () => {
  it('DSTN-8 home.overnight_kw is the average over real time on both change days, and is written for the 3-hour night', async () => {
    for (const day of [FALL, SPRING]) {
      const r = await runLearn(S, { now: noon(addDays(day, 1)) });
      expect(r.errors.filter(e => e.startsWith('metrics')), day).toEqual([]);
    }
    const m = await q<{ day: string; value: number }>(`SELECT day, value FROM daily_metrics WHERE site_id = $1 AND metric = 'home.overnight_kw' AND day IN ($2, $3) ORDER BY day`, [S, FALL, SPRING]);
    expect(m.map(x => x.day)).toEqual([FALL, SPRING]);
    expect(m[0].value).toBeCloseTo(1.44, 3);
    expect(m[1].value).toBeCloseTo(1.2, 3);
  });
  // last: it deletes rows from the spring-forward night
  it('DSTN-7 a spring-forward night with real gaps is still dropped (30 of its 36 needed)', async () => {
    await q(`DELETE FROM energy WHERE site_id = $1 AND day = $2 AND hour = 3 AND epoch % 900000 <> 0`, [S, SPRING]);   // 4 of hour 3's 12 left: 28 of 36
    expect((await nightBases(S, SPRING)).map(n => n.day)).toEqual(['2026-03-09']);
    expect((await alwaysOnKw(S, 1, { now: noon('2026-03-09'), trips: new Set(), clearUp: null })).nights).toEqual([]);
  });
});
