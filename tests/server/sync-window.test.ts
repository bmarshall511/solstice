// Batch 2 sync fixes: DST-safe day windows, the zero-bucket rule, the nightly coverage check and Tesla's per-path energy split.
//
// Self-contained. It runs the real db.ts on its own in-memory PGlite and replaces only `teslaFor` with a fake client, so nothing
// reaches the network or Neon. The harness's `server` project mocks db.js to throw for pure tests; this file opts back into the
// real module on PGlite (it can move to tests/db/ when the harness lands). All data is synthetic.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { EnergyBucket } from '../../server/src/tesla/client.js';

const fake = vi.hoisted(() => {
  process.env.DATABASE_URL = 'pglite:memory://';           // never Neon, whatever the shell exports
  const state = {
    calls: [] as Array<{ kind: 'energy' | 'soe'; day: string; start: string; end: string }>,
    count: {} as Record<string, number>,                   // buckets Tesla returns for a day; default is the whole window
    noSplits: new Set<string>(),                           // days Tesla returns without the per-path fields
    fail: new Set<string>(),                               // days Tesla answers with an error
    installed: {} as Record<string, string>,               // site_info installation_date per site
  };
  /** A synthetic calendar_history bucket (Wh). With splits: home 40, import 17, export 10, charge 32, discharge 5. */
  const bucket = (timestamp: string, splits = true): EnergyBucket => ({
    timestamp, solar_energy_exported: 60, battery_energy_exported: 5,
    ...(splits && {
      consumer_energy_imported_from_solar: 20, battery_energy_imported_from_solar: 30, grid_energy_exported_from_solar: 10,
      consumer_energy_imported_from_battery: 5, grid_energy_exported_from_battery: 0,
      consumer_energy_imported_from_grid: 15, battery_energy_imported_from_grid: 2,
    }),
  });
  return { state, bucket };
});

vi.mock('../../server/src/db.js', async importOriginal => importOriginal());
vi.mock('../../server/src/tesla/client.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/tesla/client.js')>();
  // Every 5-minute bucket start of the local day that lies inside [start, end], like calendar_history period=day.
  const series = (start: string, end: string) => {
    const day = start.slice(0, 10), out: string[] = [], stop = Math.min(Date.parse(end), real.localMidnight(real.addDays(day, 1)).getTime() - 1);
    for (let t = real.localMidnight(day).getTime(); t <= stop; t += 300_000) if (t >= Date.parse(start)) out.push(real.rfc3339(new Date(t)));
    return out.slice(0, fake.state.count[day] ?? out.length);
  };
  const teslaFor = () => ({
    energy: async (_site: string, start: string, end: string) => {
      const day = start.slice(0, 10);
      fake.state.calls.push({ kind: 'energy', day, start, end });
      if (fake.state.fail.has(day)) throw new Error('Tesla calendar_history → HTTP 504');
      return { time_series: series(start, end).map(ts => fake.bucket(ts, !fake.state.noSplits.has(day))) };
    },
    soe: async (_site: string, start: string, end: string) => {
      fake.state.calls.push({ kind: 'soe', day: start.slice(0, 10), start, end });
      return { time_series: series(start, end).filter((_, i) => i % 3 === 0).map(timestamp => ({ timestamp, soe: 80 })) };
    },
    liveStatus: async () => ({ solar_power: 0, battery_power: 0, grid_power: 0, load_power: 0, percentage_charged: 80,
      grid_status: 'Active', island_status: 'on_grid', storm_mode_active: false, timestamp: new Date().toISOString() }),
    siteInfo: async (site: string) => ({ site_name: 'Test', installation_date: fake.state.installed[site] }),
    backups: async () => ({ events: [] }),
  });
  return { ...real, teslaFor };
});

import { q, one, kv, migrate } from '../../server/src/db.js';
import { dayWindow, rfc3339, localMidnight, addDays } from '../../server/src/tesla/client.js';
import { syncSite, saveEnergy, markSynced, SHORT_DAYS_SQL, SPLIT_TODO_SQL, SPLITS } from '../../server/src/sync.js';

const TODAY = '2026-09-25', NOW = new Date('2026-09-25T18:00:00Z');   // 13:00 CDT
const stamps = (day: string) => {
  const out: string[] = [];
  for (let t = localMidnight(day).getTime(); t < localMidnight(addDays(day, 1)).getTime(); t += 300_000) out.push(rfc3339(new Date(t)));
  return out;
};
/** Store `n` real buckets of `day` (the first n of the local day) and optionally mark the day synced the old way (no count). */
async function seed(site: string, day: string, n: number, o: { mark?: boolean; splits?: boolean } = {}) {
  await saveEnergy(site, stamps(day).slice(0, n).map(ts => fake.bucket(ts, o.splits ?? true)));
  if (o.mark ?? true) await q(`INSERT INTO synced_days VALUES ($1, 'day', $2) ON CONFLICT DO NOTHING`, [site, day]);
}
const counts = async (site: string) => Object.fromEntries((await q<{ day: string; n: number }>(
  `SELECT day, COUNT(*)::int n FROM energy WHERE site_id = $1 GROUP BY day ORDER BY day`, [site])).map(r => [r.day, r.n]));
const marker = async (site: string, day: string) => one<{ buckets: number | null }>(`SELECT buckets FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day = $2`, [site, day]);
async function addSite(id: string, installed: string) {
  fake.state.installed[id] = installed;
  const a = await one<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'x', 'x', 0) RETURNING id`);
  await q(`INSERT INTO sites (id, tesla_account_id, name, info, info_at) VALUES ($1, $2, 'Test', $3, now())`, [id, a!.id, JSON.stringify({ installation_date: installed })]);
}
const energyCalls = (day?: string) => fake.state.calls.filter(c => c.kind === 'energy' && (!day || c.day === day));

beforeAll(async () => {
  await migrate();
  vi.stubGlobal('fetch', () => { throw new Error('network in test'); });   // belt and braces: the fake client never fetches
});
beforeEach(() => {
  fake.state.calls.length = 0; fake.state.count = {}; fake.state.noSplits.clear(); fake.state.fail.clear();
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dayWindow: next local midnight minus one second', () => {
  const span = (w: { start: Date; end: Date }) => (w.end.getTime() + 1000 - w.start.getTime()) / 3600e3;
  for (const tz of ['UTC', 'America/Chicago']) {
    it(`gives 24, 23 and 25 hour windows (process TZ ${tz})`, () => {
      const saved = process.env.TZ;
      process.env.TZ = tz;
      try {
        const normal = dayWindow('2026-09-24', Infinity), spring = dayWindow('2026-03-08', Infinity), fall = dayWindow('2025-11-02', Infinity);
        expect([rfc3339(normal.start), rfc3339(normal.end), span(normal)]).toEqual(['2026-09-24T00:00:00-05:00', '2026-09-24T23:59:59-05:00', 24]);
        expect([rfc3339(spring.start), rfc3339(spring.end), span(spring)]).toEqual(['2026-03-08T00:00:00-06:00', '2026-03-08T23:59:59-05:00', 23]);
        expect([rfc3339(fall.start), rfc3339(fall.end), span(fall)]).toEqual(['2025-11-02T00:00:00-05:00', '2025-11-02T23:59:59-06:00', 25]);
      } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
    });
  }
  it('ends today at now', () => {
    expect(rfc3339(dayWindow(TODAY, NOW.getTime()).end)).toBe('2026-09-25T13:00:00-05:00');
    expect(dayWindow(TODAY).end.getTime()).toBe(NOW.getTime());          // default `now` is the (faked) clock
  });
});

describe('zero-bucket rule', () => {
  it('markSynced records the stored count and never marks an empty day', async () => {
    await seed('zb', '2026-09-10', 288, { mark: false });
    expect(await markSynced('zb', '2026-09-11')).toBe(0);
    expect(await marker('zb', '2026-09-11')).toBeUndefined();
    expect(await markSynced('zb', '2026-09-10')).toBe(288);
    expect(await marker('zb', '2026-09-10')).toEqual({ buckets: 288 });
  });

  it('syncSite leaves an empty day unmarked, lets the app stop polling, and retries it after 20 h', async () => {
    await addSite('zs', '2026-09-20');
    fake.state.count['2026-09-22'] = 0;
    const r = await syncSite('zs');
    expect(r.errors).toEqual([]);
    expect(r.filled).toBe(4);
    expect(r.remaining).toBe(0);                                          // the resting empty day doesn't keep the client re-syncing
    const marked = await q(`SELECT day, buckets FROM synced_days WHERE site_id = 'zs' ORDER BY day`);
    expect(marked).toEqual(['2026-09-20', '2026-09-21', '2026-09-23', '2026-09-24'].map(day => ({ day, buckets: 288 })));

    fake.state.calls.length = 0;
    await syncSite('zs');
    expect(energyCalls('2026-09-22')).toEqual([]);                       // resting

    vi.setSystemTime(new Date(NOW.getTime() + 21 * 3600e3));
    fake.state.calls.length = 0;
    await syncSite('zs');
    expect(energyCalls('2026-09-22')).toHaveLength(1);                    // tried again, still empty, still unmarked
    expect(await marker('zs', '2026-09-22')).toBeUndefined();
  });
});

describe('coverage check query (PGlite)', () => {
  const short = (site: string, skip: string[] = [], limit = 3) =>
    q<{ day: string; buckets: number; expected: number }>(SHORT_DAYS_SQL, [site, 'America/Chicago', addDays(TODAY, -1), skip, limit]);

  it('picks only the short days out of 0, 264, 276, 288 and 300 buckets', async () => {
    // Each of 276 / 288 / 300 sits on the day it completes: the 23-hour DST-start day, a normal day, the 25-hour fall-back day.
    await seed('cq', '2026-06-01', 0);
    await seed('cq', '2026-06-02', 264);
    await seed('cq', '2026-03-08', 276);
    await seed('cq', '2026-06-03', 288);
    await seed('cq', '2025-11-02', 300);
    expect(await short('cq')).toEqual([
      { day: '2026-06-01', buckets: 0, expected: 288 },
      { day: '2026-06-02', buckets: 264, expected: 288 },
    ]);
  });

  it('finds both known holes on its own: 2026-03-08 (0 rows) and 2025-11-02 (288 of 300), oldest first', async () => {
    await seed('ch', '2026-03-08', 0);
    await seed('ch', '2025-11-02', 288);                                  // the old window stopped at 22:59:59 CST
    await seed('ch', '2026-01-15', 288);
    expect(await short('ch')).toEqual([
      { day: '2025-11-02', buckets: 288, expected: 300 },
      { day: '2026-03-08', buckets: 0, expected: 276 },
    ]);
  });

  it('counts against the day\'s own length, so 276 on a 24-hour day is an hour short', async () => {
    await seed('c276', '2026-06-10', 276);
    expect(await short('c276')).toEqual([{ day: '2026-06-10', buckets: 276, expected: 288 }]);
  });

  it('skips today, yesterday, unmarked days and the leave-alone list, and honours the limit', async () => {
    for (const d of ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']) await seed('cx', d, 10);
    await seed('cx', '2026-05-05', 10, { mark: false });                  // unmarked: the backfill loop's job
    await seed('cx', addDays(TODAY, -1), 10);
    await seed('cx', TODAY, 10);
    expect((await short('cx')).map(r => r.day)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    expect((await short('cx', ['2026-05-01', '2026-05-03'])).map(r => r.day)).toEqual(['2026-05-02', '2026-05-04']);
  });
});

describe('nightly coverage refetch (syncSite with nightly)', () => {
  it('repairs 2025-11-02 and 2026-03-08 with the corrected windows and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await addSite('n1', '2026-09-24');
    await seed('n1', '2026-03-08', 0);
    await seed('n1', '2025-11-02', 288);
    await seed('n1', '2026-01-15', 288);
    const r = await syncSite('n1', 50_000, { nightly: true });
    expect(r.errors).toEqual([]);
    expect(r.coverage).toEqual(['2025-11-02 288→300/300', '2026-03-08 0→276/276']);
    expect(energyCalls('2026-03-08').map(c => [c.start, c.end])).toEqual([['2026-03-08T00:00:00-06:00', '2026-03-08T23:59:59-05:00']]);
    expect(energyCalls('2025-11-02').map(c => [c.start, c.end])).toEqual([['2025-11-02T00:00:00-05:00', '2025-11-02T23:59:59-06:00']]);
    expect(energyCalls('2026-01-15')).toEqual([]);
    expect(await counts('n1')).toMatchObject({ '2025-11-02': 300, '2026-03-08': 276, '2026-01-15': 288 });
    expect(await marker('n1', '2025-11-02')).toEqual({ buckets: 300 });
    expect(await marker('n1', '2026-03-08')).toEqual({ buckets: 276 });
    expect(log.mock.calls.flat().join('\n')).toContain('coverage check refetched 2 short day(s): 2025-11-02 288→300/300, 2026-03-08 0→276/276');

    fake.state.calls.length = 0;
    expect((await syncSite('n1', 50_000, { nightly: true })).coverage).toEqual([]);   // nothing short any more
    log.mockRestore();
  });

  it('does at most 3 days per run', async () => {
    await addSite('n2', '2026-09-24');
    for (const d of ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05']) await seed('n2', d, 100);
    expect((await syncSite('n2', 50_000, { nightly: true })).coverage).toEqual(['2026-04-01 100→288/288', '2026-04-02 100→288/288', '2026-04-03 100→288/288']);
    expect((await syncSite('n2', 50_000, { nightly: true })).coverage).toEqual(['2026-04-04 100→288/288', '2026-04-05 100→288/288']);
  });

  it('never makes a day worse: fewer buckets from Tesla or an error leaves the rows alone, and a day gets 3 tries', async () => {
    await addSite('n3', '2026-09-24');
    await seed('n3', '2026-04-10', 100);
    await seed('n3', '2026-04-11', 100);
    fake.state.count['2026-04-10'] = 50;
    fake.state.fail.add('2026-04-11');
    const r = await syncSite('n3', 50_000, { nightly: true });
    expect(r.coverage).toEqual(['2026-04-10 100→100/288']);
    expect(r.errors).toEqual(['coverage 2026-04-11: Tesla calendar_history → HTTP 504']);
    expect(await counts('n3')).toMatchObject({ '2026-04-10': 100, '2026-04-11': 100 });
    expect(await marker('n3', '2026-04-11')).toEqual({ buckets: null });  // still marked; nothing was deleted
    fake.state.fail.clear();
    await syncSite('n3', 50_000, { nightly: true });                      // try 2 for 04-10; 04-11 repaired
    await syncSite('n3', 50_000, { nightly: true });                      // try 3 for 04-10
    fake.state.calls.length = 0;
    expect((await syncSite('n3', 50_000, { nightly: true })).coverage).toEqual([]);
    expect(energyCalls('2026-04-10')).toEqual([]);                       // left alone after 3 tries
    expect(await counts('n3')).toMatchObject({ '2026-04-10': 100, '2026-04-11': 288 });
  });
});

describe('per-path energy split', () => {
  const cols = Object.keys(SPLITS).join(', ');

  it('stores the seven fields when present and NULL when the API omits them', async () => {
    const [a, b] = stamps('2026-07-01');
    await saveEnergy('sp', [fake.bucket(a, true), fake.bucket(b, false)]);
    const rows = await q(`SELECT ts, home_wh, import_wh, export_wh, charge_wh, discharge_wh, ${cols} FROM energy WHERE site_id = 'sp' ORDER BY epoch`);
    expect(rows[0]).toEqual({ ts: a, home_wh: 40, import_wh: 17, export_wh: 10, charge_wh: 32, discharge_wh: 5,
      solar_home_wh: 20, solar_battery_wh: 30, solar_grid_wh: 10, battery_home_wh: 5, battery_grid_wh: 0, grid_home_wh: 15, grid_battery_wh: 2 });
    expect(rows[1]).toEqual({ ts: b, home_wh: 0, import_wh: 0, export_wh: 0, charge_wh: 0, discharge_wh: 5,
      solar_home_wh: null, solar_battery_wh: null, solar_grid_wh: null, battery_home_wh: null, battery_grid_wh: null, grid_home_wh: null, grid_battery_wh: null });
  });

  it('an upsert without splits keeps the splits already stored', async () => {
    const [a] = stamps('2026-07-02');
    await saveEnergy('sp2', [fake.bucket(a, true)]);
    await saveEnergy('sp2', [fake.bucket(a, false)]);
    expect(await one(`SELECT ${cols} FROM energy WHERE site_id = 'sp2'`)).toEqual({
      solar_home_wh: 20, solar_battery_wh: 30, solar_grid_wh: 10, battery_home_wh: 5, battery_grid_wh: 0, grid_home_wh: 15, grid_battery_wh: 2 });
  });

  it('the back-fill query picks only days with NULL splits, oldest first, after the cursor and before today', async () => {
    await seed('st', '2026-01-03', 5, { splits: false });
    await seed('st', '2026-01-01', 5, { splits: false });
    await seed('st', '2026-01-02', 5);                                    // already split
    await saveEnergy('st', [fake.bucket(stamps('2026-01-04')[0], true), fake.bucket(stamps('2026-01-04')[1], false)]);   // one row missing
    await seed('st', TODAY, 5, { splits: false });                         // today is refreshed by the normal sync
    const todo = (cursor: string, limit = 30) => q(SPLIT_TODO_SQL, ['st', cursor, TODAY, limit]);
    expect(await todo('')).toEqual([
      { day: '2026-01-01', remaining: 3 }, { day: '2026-01-03', remaining: 3 }, { day: '2026-01-04', remaining: 3 }]);
    expect(await todo('2026-01-01', 1)).toEqual([{ day: '2026-01-03', remaining: 2 }]);
  });

  it('the nightly back-fill re-pulls up to 30 days with one energy call each, then continues from its cursor', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await addSite('bf', '2026-09-24');
    const days = Array.from({ length: 32 }, (_, i) => addDays('2026-02-20', i));   // crosses 2026-03-08
    for (const d of days) await seed('bf', d, 2, { splits: false, mark: false });   // unmarked, so the coverage check leaves them to this
    fake.state.noSplits.add('2026-02-21');
    const r = await syncSite('bf', 50_000, { nightly: true });
    expect(r.errors).toEqual([]);
    expect(r.splits).toEqual({ filled: 29, withoutSplits: 1, remaining: 2 });
    expect(days.slice(0, 30).every(d => energyCalls(d).length === 1)).toBe(true);
    expect(fake.state.calls.filter(c => c.kind === 'soe' && days.includes(c.day))).toEqual([]);   // energy only
    expect(energyCalls('2026-03-08')[0]).toMatchObject({ start: '2026-03-08T00:00:00-06:00', end: '2026-03-08T23:59:59-05:00' });
    expect(await kv.get('bf:splits')).toMatchObject({ through: days[29], filled: 29, withoutSplits: 1, remaining: 2 });
    expect(log.mock.calls.flat().join('\n')).toContain('split back-fill: 29 day(s) back-filled, 1 without split data from Tesla, 2 remain');

    const r2 = await syncSite('bf', 50_000, { nightly: true });
    expect(r2.splits).toEqual({ filled: 2, withoutSplits: 0, remaining: 0 });
    expect(energyCalls('2026-02-21')).toHaveLength(1);                    // passed by the cursor, not retried
    const nulls = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM energy WHERE site_id = 'bf' AND solar_home_wh IS NULL`);
    expect(nulls!.n).toBe(stamps('2026-02-21').length);                   // only the day Tesla had no split for
    log.mockRestore();
  });
});
