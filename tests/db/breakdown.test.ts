// "Where your energy goes" (server/src/breakdown.ts, mockup y): the always-on base, big-load bursts, the AC mask, the nightly base SQL and
// the always-on push, on in-memory PGlite with synthetic 5-minute energy. All data synthetic.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { baseOf, burstsOf, acMask, nightBases, alwaysOnWatch, breakdownFor } from '../../server/src/breakdown.js';
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
    for (const r of day(d, base)) await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh) VALUES ('bd', $1, $2, $3, $4, $5)`, [rfc3339(new Date(r.epoch)), r.epoch, r.day, r.hour, Math.round(r.kw * 1000 / 12)]);
  }
});

describe('pieces (pure)', () => {
  it('BD-1 the base is the lowest 30-minute mean between 1 and 5 AM', () => {
    expect(baseOf(day('2026-09-10', 1.1))).toBeCloseTo(1.1, 2);   // a quiet 30 minutes between the 0.3 kW blips
  });
  it('BD-2 a burst is 15+ min at 3+ kW above the base with the AC off; only the energy above the base counts', () => {
    const d = day('2026-09-10', 1.1), noAc = () => false;
    const bs = burstsOf(d, 1.1, noAc);
    expect(bs.map(b => [b.minutes, b.kwh])).toEqual([[30, 3.5]]);                                     // the 2.7 kW AC hour is under 3 kW above base
    expect(burstsOf(day('2026-09-10', 1.1, 10), 1.1, noAc)).toEqual([]);                             // 10 minutes is too short
    const ac = acMask([{ ts: localMidnight('2026-09-10').getTime() + 17 * 3600e3, hvac: 'COOLING' }, { ts: localMidnight('2026-09-10').getTime() + 17.5 * 3600e3, hvac: 'OFF' }]);
    expect(burstsOf(d, 1.1, ac)).toEqual([]);                                                         // the AC ran then: not a burst
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
    expect(by.big.perDay).toBe(1);
    expect(by.big.kwh).toBeCloseTo(3.5, 0);
    expect(d.parts.reduce((a, p) => a + p.kwh, 0)).toBeCloseTo(d.homeKwh, 0);
    expect(d.trend.length).toBeGreaterThan(0);
  });
});
