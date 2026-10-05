// The November fall-back (2026-11-01): 01:00 happens twice, so a GROUP BY day, hour puts 24 five-minute buckets in hour 1. hourWh
// (server/src/db.ts) scales that hour back to one hour's worth, so hourly profiles and forecast scoring see one hour, while the day's
// total still counts all 25 hours. Synthetic data: a flat 1.2 kW house (100 Wh a bucket).
import { describe, it, expect, beforeAll } from 'vitest';
import { q, migrate, hourWh } from '../../server/src/db.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

const DAY = '2026-11-01';
beforeAll(async () => {
  await migrate();
  for (let t = localMidnight(DAY).getTime(); t < localMidnight(addDays(DAY, 1)).getTime(); t += 300_000) {
    const ts = rfc3339(new Date(t));
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh, solar_wh) VALUES ('dst', $1, $2, $3, $4, 100, 0)`, [ts, t, DAY, Number(ts.slice(11, 13))]);
  }
});

describe('fall-back day', () => {
  it('DST-1 the day has 25 hours (300 buckets) and hour 1 holds 24 of them', async () => {
    const r = await q<{ n: number; h1: number }>(`SELECT COUNT(*)::int n, (COUNT(*) FILTER (WHERE hour = 1))::int h1 FROM energy WHERE site_id = 'dst'`);
    expect(r[0]).toEqual({ n: 300, h1: 24 });
  });
  it('DST-2 hourWh gives every hour, the repeated 01:00 included, one hour of energy; the plain sum would double it', async () => {
    const rows = await q<{ hour: number; wh: number; raw: number }>(`SELECT hour::int, ${hourWh('home_wh')}::float8 wh, SUM(home_wh)::float8 raw FROM energy WHERE site_id = 'dst' GROUP BY day, hour ORDER BY hour`);
    expect(rows).toHaveLength(24);
    expect(rows.every(r => r.wh === 1200)).toBe(true);
    expect(rows.find(r => r.hour === 1)!.raw).toBe(2400);
  });
  it('DST-3 an hour with missing buckets is not scaled up (it stays the sum)', async () => {
    const r = await q<{ wh: number }>(`SELECT ${hourWh('home_wh')}::float8 wh FROM energy WHERE site_id = 'dst' AND hour = 5 AND epoch % 600000 = 0 GROUP BY day, hour`);
    expect(r[0].wh).toBe(600);   // 6 of 12 buckets: 600 Wh, not stretched to 1,200
  });
});

describe('database setup retries (October audit)', () => {
  it('DB-1 onceUntilOk keeps a success but forgets a failure, so the next call tries again', async () => {
    const { onceUntilOk } = await import('../../server/src/db.js');
    let calls = 0;
    const run = onceUntilOk(async () => { calls++; if (calls === 1) throw new Error('cold start blip'); return 'ok'; });
    await expect(run()).rejects.toThrow('cold start blip');
    expect(await run()).toBe('ok');     // retried
    expect(await run()).toBe('ok');     // kept
    expect(calls).toBe(2);
  });
});
