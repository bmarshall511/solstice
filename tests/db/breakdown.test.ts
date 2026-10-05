// "Where your energy goes" (server/src/breakdown.ts, mockup y): the always-on base, big-load bursts, the AC mask, the nightly base SQL and
// the always-on push, on in-memory PGlite with synthetic 5-minute energy. All data synthetic.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { baseOf, burstsOf, acMask, nightBases, alwaysOnWatch, breakdownFor, overnightSplit } from '../../server/src/breakdown.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({ configured: () => false, readPool: vi.fn(), writePoolPlan: vi.fn(), withUnit: vi.fn() }));
const NOW = Date.parse('2026-10-05T18:00:00Z');   // 13:00 CDT
const B = 300_000;
/** One synthetic day: a `base` kW house, a 7 kW burst for `burstMin` from 17:00, and a 2.7 kW AC from 14:00 to 15:00. */
function day(d: string, base: number, burstMin = 30) {
  const start = localMidnight(d).getTime(), rows = [];
  for (let t = start; t < localMidnight(addDays(d, 1)).getTime(); t += B) {
    const h = Number(rfc3339(new Date(t)).slice(11, 13)), m = Number(rfc3339(new Date(t)).slice(14, 16)) + h * 60;
    const kw = base + (m >= 17 * 60 && m < 17 * 60 + burstMin ? 7 : 0) + (h === 14 ? 2.7 : 0) + (h >= 1 && h < 5 && m % 40 < 10 ? 0.3 : 0);
    rows.push({ epoch: t, day: d, hour: h, kw });
  }
  return rows;
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('bd', NULL, 1, 'Test')`);
  for (let i = 40; i >= 0; i--) {
    const d = addDays('2026-10-05', -i), base = i <= 3 && i >= 1 ? 1.7 : 1.1;   // the last three full nights run 0.6 kW high
    // one statement per day (arrays through unnest): row by row this setup ran past the 60 s hook limit under load
    const rows = day(d, base);
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh) SELECT 'bd', ts, epoch, $1, hour, wh FROM unnest($2::text[], $3::bigint[], $4::int[], $5::int[]) AS x(ts, epoch, hour, wh)`,
      [d, rows.map(r => rfc3339(new Date(r.epoch))), rows.map(r => r.epoch), rows.map(r => r.hour), rows.map(r => Math.round(r.kw * 1000 / 12))]);
    if (i > 10) continue;   // Nest readings every 15 min for the last ten days only: cooling 14:00–15:00
    const ts: number[] = [], hrs: number[] = [];
    for (let t = localMidnight(d).getTime(); t < localMidnight(addDays(d, 1)).getTime(); t += 3 * B) { ts.push(t); hrs.push(Number(rfc3339(new Date(t)).slice(11, 13))); }
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac) SELECT 'bd', ts, $1, hour, CASE WHEN hour = 14 THEN 'COOLING' ELSE 'OFF' END FROM unnest($2::bigint[], $3::int[]) AS x(ts, hour)`, [d, ts, hrs]);
  }
});

describe('pieces (pure)', () => {
  it('BD-1 the base is the quietest tenth of the 1–5 AM buckets with the AC off', () => {
    expect(baseOf(day('2026-09-10', 1.1))).toBeCloseTo(1.1, 2);   // the 0.3 kW blips don't lift it
    // a hot night: the AC (2.7 kW) cycles 10 of every 30 minutes all night, so no 30-minute window is free of it
    const hot = day('2026-09-10', 1.1).map(b => ({ ...b, kw: b.kw + (b.hour >= 1 && b.hour < 5 && (b.epoch / B) % 6 < 2 ? 2.7 : 0) }));
    const cycling = acMask(hot.filter(b => b.hour >= 1 && b.hour < 5).map(b => ({ ts: b.epoch, hvac: (b.epoch / B) % 6 < 2 ? 'COOLING' : 'OFF' })));
    expect(baseOf(hot, cycling)).toBeCloseTo(1.1, 2);
    expect(baseOf(day('2026-09-10', 1.1).filter(b => b.hour !== 1 || b.epoch % 3600e3 < 1800e3).filter(b => b.hour < 2 || b.hour > 4))).toBeNull();   // under 12 quiet buckets
  });
  it('BD-2 a burst is 15+ min at 3+ kW above the base with the AC off; only the energy above the base counts', () => {
    const d = day('2026-09-10', 1.1), noAc = () => false;
    const bs = burstsOf(d, 1.1, noAc);
    expect(bs.map(b => [b.minutes, b.kwh])).toEqual([[30, 3.5]]);                                     // the 2.7 kW AC hour is under 3 kW above base
    expect(burstsOf(day('2026-09-10', 1.1, 10), 1.1, noAc)).toEqual([]);                             // 10 minutes is too short
    const ac = acMask([{ ts: localMidnight('2026-09-10').getTime() + 17 * 3600e3, hvac: 'COOLING' }, { ts: localMidnight('2026-09-10').getTime() + 17.25 * 3600e3, hvac: 'COOLING' }, { ts: localMidnight('2026-09-10').getTime() + 17.5 * 3600e3, hvac: 'OFF' }]);
    expect(burstsOf(d, 1.1, ac, 7)).toEqual([]);                                                      // the AC's own draw explains it: not a burst
    const both = d.map(b => ({ ...b, kw: b.kw + (b.epoch >= localMidnight('2026-09-10').getTime() + 17 * 3600e3 && b.epoch < localMidnight('2026-09-10').getTime() + 17.5 * 3600e3 ? 2.7 : 0) }));
    expect(burstsOf(both, 1.1, ac, 2.7).map(b => [b.minutes, b.kwh])).toEqual([[30, 3.5]]);         // a dryer while the AC runs still counts
  });
});

describe('on PGlite', () => {
  it('BD-3 nightly bases from SQL match the pure rule', async () => {
    const n = await nightBases('bd', '2026-09-20');
    expect(n.find(x => x.day === '2026-09-25')!.kw).toBeCloseTo(1.1, 2);
    expect(n.find(x => x.day === '2026-10-03')!.kw).toBeCloseTo(1.7, 2);
  });
  it('BD-4 three high nights push once; it re-arms only after the base comes back down', async () => {
    const r1 = await alwaysOnWatch('bd') as any;
    expect(r1.stored).toBe(true);
    expect((await q(`SELECT title FROM alerts WHERE site_id = 'bd'`)).map((a: any) => a.title)).toEqual(['Always-on is up: 1.7 kW']);
    expect(await alwaysOnWatch('bd')).toMatchObject({ ok: true });                                     // still high: no second push
    expect(await kv.get('bd:alwaysOn:alerted')).toBe(true);
  });
  it('BD-5 the week breakdown: parts add up to the home total, always-on from the bases, one burst a day', async () => {
    const d = await breakdownFor('bd', 'week', {});
    const by = Object.fromEntries(d.parts.map(p => [p.id, p]));
    expect(d.days).toBe(7);
    expect(by.ac.hours).toBeCloseTo(1, 1);
    expect(by.alwaysOn.kw).toBeCloseTo(1.1 + 0.6 * 3 / 7, 1);
    expect(by.big.perDay).toBe(1);
    expect(by.big.kwh).toBeCloseTo(3.5, 0);
    expect([by.big.minutes, by.big.burstKw]).toEqual([[30, 30], 8.4]);   // 7 kW on a 1.1 kW base four days, a 1.7 kW base three
    expect(d.parts.reduce((a, p) => a + p.kwh, 0)).toBeCloseTo(d.homeKwh, 0);
    expect(d.trend.length).toBeGreaterThan(0);
  });
  it('BD-6 days without Nest readings are left out (the AC could not be told apart)', async () => {
    const d = await breakdownFor('bd', 'month', {});
    expect(d.spanDays).toBe(30);
    expect(d.days).toBe(10);
  });
  it('BD-7 overnight split (mockup z): Nest nights split into always-on, AC and pump; older nights carry only the base', async () => {
    // one hot Nest night: the AC (2.7 kW) on 10 of every 30 minutes from 1 to 5 AM, read every 5 minutes
    const d = '2026-10-02', t0 = localMidnight(d).getTime();
    for (let t = t0 + 3600e3; t < t0 + 5 * 3600e3; t += B) {
      const on = (t / B) % 6 < 2;
      await q(`UPDATE energy SET home_wh = home_wh + $1 WHERE site_id = 'bd' AND epoch = $2`, [on ? Math.round(2.7 * 1000 / 12) : 0, t]);
      await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac) VALUES ('bd', $1, $2, $3, $4) ON CONFLICT (site_id, ts) DO UPDATE SET hvac = EXCLUDED.hvac`, [t, d, Math.floor((t - t0) / 3600e3), on ? 'COOLING' : 'OFF']);
    }
    const n = await overnightSplit('bd', '2026-09-20'), hot = n.find(x => x.date === d)!, old = n.find(x => x.date === '2026-09-21')!;
    expect(hot.split).toBe(true);
    expect(hot.base).toBeCloseTo(1.7, 2);                                // that night's house runs 1.7 kW (one of the three high nights)
    expect(hot.ac!).toBeCloseTo(2.7 / 3, 1);                              // the meter's 2.7 kW above the quiet level, a third of the time
    expect(hot.base! + hot.ac! + hot.pump!).toBeLessThanOrEqual(hot.kw + 1e-6);
    expect(old).toMatchObject({ split: false, ac: null, pump: null });
    expect(old.base).toBeCloseTo(1.1, 2);
  });
  it('BD-8 a sparse night pump read masks only its own stretch: the base stays, the pump gets the meter\'s step', async () => {
    // 2026-10-01 (a 1.1 kW night): the pump runs 02:00–02:20 at 0.66 kW; one read at 02:05 says so, the next at 05:05 says off
    const d = '2026-10-01', t0 = localMidnight(d).getTime();
    for (let t = t0 + 2 * 3600e3; t < t0 + 2 * 3600e3 + 20 * 60_000; t += B) await q(`UPDATE energy SET home_wh = home_wh + 55 WHERE site_id = 'bd' AND epoch = $1`, [t]);
    for (const [t, running] of [[t0 + 2 * 3600e3 + 5 * 60_000, true], [t0 + 5 * 3600e3 + 5 * 60_000, false]] as const)
      await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ('bd', $1, $2, $3, $4, $5, $6)`, [t, d, Math.floor((t - t0) / 3600e3), running, running ? 660 : 0, running ? 2000 : 0]);
    const n = (await overnightSplit('bd', '2026-09-30')).find(x => x.date === d)!;
    expect(n.base).toBeCloseTo(1.1, 2);                                   // not 1.1 - 0.66
    expect(n.pump!).toBeGreaterThan(0);
    expect(n.pump!).toBeLessThan(0.1);                                    // ~20 of 240 minutes x 0.66 kW, not the whole night
  });
});
