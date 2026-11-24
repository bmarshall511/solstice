// The nightly database-size check (server/src/dbSize.ts) on PGlite: it stores the size, stays quiet under 80% of the limit,
// and from 80% stores one alert a week.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { dbSizeWatch, limitMb, SIZE_KEY, DEFAULT_LIMIT_MB } from '../../server/src/dbSize.js';
import { nightlySteps } from '../../server/src/watch.js';
import '../../server/src/app.js';   // registers the nightly steps

beforeAll(migrate);
afterEach(() => { delete process.env.DB_SIZE_LIMIT_MB; });
const NOW = Date.parse('2026-12-02T05:15:00-06:00');
const sizeAlerts = () => q(`SELECT title, data FROM alerts WHERE site_id = 'z' AND data->>'key' = $1`, [SIZE_KEY]);

describe('dbSizeWatch', () => {
  it('defaults to the 500 MB free-plan limit, and DB_SIZE_LIMIT_MB overrides it', () => {
    expect(limitMb()).toBe(DEFAULT_LIMIT_MB);
    process.env.DB_SIZE_LIMIT_MB = '8192';
    expect(limitMb()).toBe(8192);
    process.env.DB_SIZE_LIMIT_MB = 'nonsense';
    expect(limitMb()).toBe(DEFAULT_LIMIT_MB);
  });
  it('under 80% it stores the size and alerts nobody', async () => {
    process.env.DB_SIZE_LIMIT_MB = '100000';
    const r = await dbSizeWatch('z', NOW);
    expect(r).toMatchObject({ limitMb: 100000 });
    expect(await kv.get(SIZE_KEY)).toEqual({ mb: expect.any(Number), limitMb: 100000, at: NOW });
    expect(await sizeAlerts()).toEqual([]);
  });
  it('from 80% it stores one alert, and not again the same week', async () => {
    process.env.DB_SIZE_LIMIT_MB = '1';   // any database is over 80% of 1 MB
    expect(await dbSizeWatch('z', NOW)).toMatchObject({ stored: true });
    expect(await dbSizeWatch('z', NOW + 3 * 864e5)).toMatchObject({ skipped: 'duplicate' });
    const rows = await sizeAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'The database is filling up', data: { limitMb: 1 } });
  });
  it('runs as a nightly step', () => {
    expect(nightlySteps.dbSize).toBeTypeOf('function');
  });
});
