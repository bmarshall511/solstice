// Batch 7 performance items on in-memory PGlite (synthetic data only): each cheaper path gives the answer the old full computation
// gave, and is held to a query budget (every round trip to PGlite is counted, as in integration.test.ts).
//  1. GET /api/status daysDone from the synced-day marks (sync.ts storedDays) = COUNT(DISTINCT day) over energy
//  2. GET /api/records from the nightly kv aggregate plus the days after it (records.ts) = the old five full aggregations
//  3. GET /api/appliances rows from the stored snapshots (poolSummary, acSummary) = the rows the full Pool and AC cards gave
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { q, one, kv, migrate } from '../../server/src/db.js';
import { saveEnergyRows, saveSoe, markSynced, storedDays } from '../../server/src/sync.js';
import { recordsFor, refreshRecords, recordsKey } from '../../server/src/records.js';
import { poolDetail, poolSummary } from '../../server/src/appliances/pool.js';
import { acDetail, acSummary } from '../../server/src/appliances/ac.js';
import { PRESENCE_FIXED } from '../../server/src/appliances/presence.js';
import { readPool } from '../../server/src/appliances/screenlogic.js';
import { readNest } from '../../server/src/appliances/nest.js';
import { localDay, addDays } from '../../server/src/tesla/client.js';
import { forecastDays } from '../fixtures/forecast.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';
import { nestState } from '../fixtures/nest.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => true,
  readPool: vi.fn(async () => { throw new Error('readPool in perf test'); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan in perf test'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit in perf test'); }),
}));
vi.mock(import('../../server/src/appliances/nest.js'), async importOriginal => {
  const real = await importOriginal();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in perf test`); });
  return { ...real, nestConfigured: () => true, nestLinked: vi.fn(async () => true), readNest: blocked('readNest'), setCool: blocked('setCool'),
    nestExchangeCode: blocked('nestExchangeCode'), ownerCommand: blocked('ownerCommand') };
});
vi.mock(import('../../server/src/tesla/client.js'), async importOriginal => ({ ...(await importOriginal()), teslaFor: vi.fn() }));
vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
const pg = vi.hoisted(() => ({ queries: 0 }));
vi.mock('@electric-sql/pglite', async importOriginal => {
  const real = await importOriginal<typeof import('@electric-sql/pglite')>();
  function PGlite(this: unknown, ...args: unknown[]) {
    const db = new (real.PGlite as any)(...args), query = db.query.bind(db);
    db.query = (...a: unknown[]) => { pg.queries++; return query(...a); };
    return db;
  }
  return { ...real, PGlite: PGlite as unknown as typeof real.PGlite };
});
/** Round trips made by `fn`. */
async function counted<T>(fn: () => Promise<T>) { const n0 = pg.queries; const v = await fn(); return { v, n: pg.queries - n0 }; }

const NOW = Date.parse('2026-09-25T18:00:00Z');   // Friday 13:00 CDT; today is 2026-09-25
const pad = (n: number) => String(n).padStart(2, '0'), ts = (day: string, h: number, m = 0) => `${day}T${pad(h)}:${pad(m)}:00-05:00`;
type Wh = { solar: number; home: number; imp: number; exp: number; chg: number; dis: number };
/** `n` five-minute buckets from `h`:00 with the same Wh each (whole Wh, so every sum is exact in float4 and float8 alike). */
const fives = (day: string, h: number, n: number, wh: Wh) => Array.from({ length: n }, (_, i) => {
  const t = ts(day, h + Math.floor(i / 12), (i % 12) * 5); return { ts: t, epoch: Date.parse(t), day, hour: h + Math.floor(i / 12), ...wh }; });
const soeDay = (site: string, day: string, levels: number[]) => saveSoe(site, levels.map((soe, i) => ({ timestamp: ts(day, 8 + i), soe })));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await migrate();
  await kv.set('pool:forecast', { at: NOW, days: forecastDays(localDay()) });   // acDetail's forecast, so nothing is fetched
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => { vi.setSystemTime(NOW); });

/* ---------------------------------------------------------------- 1. /api/status daysDone */
describe('Batch 7 item 1: storedDays', () => {
  const S = 'st', distinct = async () => (await one<{ n: number }>(`SELECT COUNT(DISTINCT day)::int n FROM energy WHERE site_id = $1`, [S]))!.n;
  const store = async (day: string, mark = true) => { await saveEnergyRows(S, fives(day, 10, 3, { solar: 100, home: 50, imp: 0, exp: 10, chg: 40, dis: 0 })); if (mark) await markSynced(S, day); };
  const same = async () => { const r = await counted(() => storedDays(S)); expect(r.v).toBe(await distinct()); expect(r.n).toBe(1); return r.v; };

  it('counts what COUNT(DISTINCT day) counts: none, today only, synced past days, unmarked recent days, deep back-filled days', async () => {
    expect(await same()).toBe(0);
    await store('2026-09-25', false);                       // today: fetched every few minutes, never marked
    expect(await same()).toBe(1);
    for (const d of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) await store(d);   // syncSite's window
    expect(await same()).toBe(5);
    await store('2026-09-24', false);                       // yesterday after midnight, before the next sync marks it
    expect(await same()).toBe(6);
    await markSynced(S, '2026-09-24');
    expect(await same()).toBe(6);
    for (const d of ['2025-08-01', '2025-07-31']) await store(d);   // the deep back-fill (fetchDay + markSynced), far below the window
    expect(await same()).toBe(8);
    // the coverage check's refetch: the day's rows and its mark go together, then both come back
    await q(`WITH e AS (DELETE FROM energy WHERE site_id = $1 AND day = $2), m AS (DELETE FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day = $2) SELECT 1`, [S, '2026-09-21']);
    expect(await same()).toBe(7);
    await store('2026-09-21');
    expect(await same()).toBe(8);
  });

  it('a stalled sync: unmarked days since the newest mark still count (the look-back reaches the newest marked day)', async () => {
    vi.setSystemTime(Date.parse('2026-10-02T18:00:00Z'));   // a week on with no sync marking anything; the last "today" fetched was 2026-09-25
    expect(await same()).toBe(8);
    await store('2026-10-02', false);
    expect(await same()).toBe(9);
  });
});

/* ---------------------------------------------------------------- 2. /api/records */
// The old route, verbatim (app.ts before Batch 7): five full-table aggregations and two outage reads.
const K = (col: string) => `ROUND((SUM(${col}) / 1000.0)::numeric, 2)::float8`;
const kwhCols = `${K('solar_wh')} solar, ${K('home_wh')} home, ${K('import_wh')} import, ${K('export_wh')} export, ${K('charge_wh')} charge, ${K('discharge_wh')} discharge`;
async function oldRecords(id: string) {
  const day = (order: string, col: string) => one(`SELECT day date, ROUND((SUM(${col}) / 1000.0)::numeric, 1)::float8 kwh FROM energy WHERE site_id = $1 GROUP BY day ORDER BY kwh ${order} LIMIT 1`, [id]);
  const [best, big, low, totals, full, soeDays, longest, outages] = await Promise.all([day('DESC', 'solar_wh'), day('DESC', 'home_wh'), day('ASC', 'import_wh'),
    one(`SELECT MIN(day) since, ${kwhCols} FROM energy WHERE site_id = $1`, [id]),
    one<{ n: number }>(`SELECT COUNT(*)::int n FROM (SELECT day FROM soe WHERE site_id = $1 GROUP BY day HAVING MAX(soe) >= 99) x`, [id]),
    one<{ n: number }>(`SELECT COUNT(DISTINCT day)::int n FROM soe WHERE site_id = $1`, [id]),
    one('SELECT ts, duration_s FROM backup_events WHERE site_id = $1 ORDER BY duration_s DESC LIMIT 1', [id]),
    one<{ n: number }>('SELECT COUNT(*)::int n FROM backup_events WHERE site_id = $1', [id])]);
  // as res.json sends it (an undefined record is left out)
  return JSON.parse(JSON.stringify({ bestSolarDay: best, biggestUsageDay: big, lowestImportDay: low, totals, batteryFullDays: { days: full?.n ?? 0, of: soeDays?.n ?? 0 }, longestOutage: longest ?? null, outages: outages?.n ?? 0 }));
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('Batch 7 item 2: records from the nightly aggregate plus the days after it', () => {
  const S = 'rec';
  const day = async (d: string, wh: Wh, n = 24, mark = true) => { await saveEnergyRows(S, fives(d, 9, n, wh)); if (mark) await markSynced(S, d); };
  const check = async () => { const r = await counted(() => recordsFor(S)); expect(json(r.v)).toEqual(await oldRecords(S)); return r; };

  beforeAll(async () => {
    // five synced days with no ties in any record column, and today so far (unmarked)
    await day('2026-09-20', { solar: 400, home: 300, imp: 20, exp: 90, chg: 30, dis: 10 });
    await day('2026-09-21', { solar: 520, home: 260, imp: 12, exp: 200, chg: 40, dis: 6 });
    await day('2026-09-22', { solar: 310, home: 410, imp: 55, exp: 20, chg: 25, dis: 30 });
    await day('2026-09-23', { solar: 450, home: 280, imp: 7, exp: 150, chg: 35, dis: 4 });
    await day('2026-09-24', { solar: 380, home: 330, imp: 31, exp: 60, chg: 28, dis: 12 });
    await day('2026-09-25', { solar: 200, home: 150, imp: 3, exp: 20, chg: 15, dis: 2 }, 12, false);
    for (const [d, lv] of [['2026-09-20', [80, 99]], ['2026-09-21', [90, 100]], ['2026-09-22', [70, 95]], ['2026-09-23', [60, 98]], ['2026-09-24', [85, 99.5]], ['2026-09-25', [88, 92]]] as const) await soeDay(S, d, [...lv]);
    for (const [t, s] of [['2026-05-01T14:37:00-05:00', 1800], ['2026-07-04T19:02:00-05:00', 5400], ['2026-08-15T03:10:00-05:00', 300]] as const)
      await q(`INSERT INTO backup_events (site_id, ts, epoch, duration_s) VALUES ($1, $2, $3, $4)`, [S, t, Date.parse(t), s]);
  });

  it('with no aggregate yet the first read builds it (through yesterday) and answers the old way', async () => {
    expect(await kv.get(recordsKey(S))).toBeUndefined();
    await check();
    expect(await kv.get<any>(recordsKey(S))).toMatchObject({ v: 1, through: '2026-09-24', mark: { n: 5, b: 120 } });
  });

  it('the nightly aggregate: the route then makes 3 round trips (was 8, five of them full-table) and still matches', async () => {
    await refreshRecords(S, NOW);
    const r = await check();
    expect(r.n).toBe(3);
    console.info(`[records] cached read: ${r.n} PGlite round trips (the old route: 8, five over every energy/soe row)`);
  });

  it('today can take a record live (best solar day, lowest import) without the aggregate being rebuilt', async () => {
    await day('2026-09-25', { solar: 900, home: 100, imp: 0, exp: 600, chg: 50, dis: 0 }, 24, false);   // today's 09:00–10:55 buckets, re-fetched sunnier
    const r = await check();
    expect(r.n).toBe(3);
    expect(r.v.bestSolarDay).toEqual({ date: '2026-09-25', kwh: 21.6 });
    expect(r.v.lowestImportDay).toEqual({ date: '2026-09-25', kwh: 0 });
  });

  it('after a new day is synced: the old aggregate plus the two days after it, then the next nightly', async () => {
    vi.setSystemTime(NOW + 864e5);                                   // 2026-09-26; 09-25 now synced and marked, a new today
    await markSynced(S, '2026-09-25');
    await day('2026-09-26', { solar: 150, home: 500, imp: 90, exp: 0, chg: 0, dis: 60 }, 6, false);
    await soeDay(S, '2026-09-26', [60]);
    expect((await check()).n).toBe(3);                              // the 09-24 aggregate still holds: 09-25 and 09-26 are added live
    await refreshRecords(S);
    expect(await kv.get<any>(recordsKey(S))).toMatchObject({ through: '2026-09-25', mark: { n: 6 } });
    expect((await check()).n).toBe(3);
  });

  it('after deep back-filled old days arrive (marked after the nightly ran), the next read rebuilds the aggregate and matches', async () => {
    vi.setSystemTime(NOW + 864e5);
    // the install summer: a far bigger usage day and a battery-full day, stored and marked by the deep back-fill (fetchDay + markSynced)
    await day('2026-06-02', { solar: 300, home: 900, imp: 400, exp: 0, chg: 0, dis: 100 });
    await soeDay(S, '2026-06-02', [50, 100]);
    const r = await check();
    expect(r.n).toBeGreaterThan(3);                                  // rebuilt once
    expect(r.v.biggestUsageDay).toEqual({ date: '2026-06-02', kwh: 21.6 });
    expect(r.v.totals.since).toBe('2026-06-02');
    expect((await check()).n).toBe(3);                              // and cached again
  });

  it('after the coverage check re-fetches a short day (more buckets, same mark count), the next read rebuilds and matches', async () => {
    vi.setSystemTime(NOW + 864e5);
    await q(`WITH e AS (DELETE FROM energy WHERE site_id = $1 AND day = $2), m AS (DELETE FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day = $2) SELECT 1`, [S, '2026-09-22']);
    await day('2026-09-22', { solar: 310, home: 410, imp: 55, exp: 20, chg: 25, dis: 30 }, 36);
    const r = await check();
    expect(r.n).toBeGreaterThan(3);
    expect((await check()).n).toBe(3);
  });

  it('a site with no history answers as the old route did (no record days, null totals, no outages)', async () => {
    const r = await recordsFor('empty');
    expect(json(r)).toEqual(await oldRecords('empty'));
    expect(json(r)).toEqual({ totals: { since: null, solar: null, home: null, import: null, export: null, charge: null, discharge: null }, batteryFullDays: { days: 0, of: 0 }, longestOutage: null, outages: 0 });
  });
});

/* ---------------------------------------------------------------- 3. /api/appliances rows */
describe('Batch 7 item 3: the appliance list from stored snapshots', () => {
  const S = 'ap', RATE = .1064, SLOPE = 2.5;
  // the rows as app.ts built them before Batch 7: the whole Pool card and the whole AC card
  const oldPool = async (settings: Record<string | symbol, any>, rate: number | null = RATE) => { const d = await poolDetail(S, settings, rate, { readOnly: !!settings[PRESENCE_FIXED as any] });
    return { id: 'pool', name: 'Pool pump', status: d.linked ? 'linked' : 'estimated', watts: d.live?.watts ?? null, kwhPerDay: d.current.kwhPerDay,
      savesPerMonth: d.current.costPerMonth != null && d.plan.costPerMonth != null ? Math.max(0, d.current.costPerMonth - d.plan.costPerMonth) : null }; };
  const oldAc = async (settings: Record<string | symbol, any>, guest: boolean) => { const d = await acDetail(S, settings, RATE, SLOPE, { readOnly: guest });
    return { id: 'ac', name: 'AC', status: d.linked ? 'linked' : 'estimated', watts: d.state?.hvac === 'COOLING' ? Math.round(d.learned.acKw * 1000) : 0, kwhPerDay: d.todayKwh, savesPerMonth: null }; };
  const owner = {}, guest = { ac: { presence: 'home' }, [PRESENCE_FIXED]: true };

  beforeAll(async () => {
    const today = localDay();
    // 14 days of solar for the planner's sun profile, pump readings at 1,500 and 2,400 RPM, and today's thermostat cooling 11:00–12:30
    for (let i = 1; i <= 14; i++) await saveEnergyRows(S, fives(addDays(today, -i), 9, 96, { solar: 300 + i, home: 200, imp: 0, exp: 50, chg: 20, dis: 0 }));
    await saveEnergyRows(S, fives(today, 9, 36, { solar: 320, home: 210, imp: 0, exp: 40, chg: 20, dis: 0 }));
    const pr = [1, 2, 3].flatMap(i => [0, 15, 30, 45].map(m => ({ t: Date.parse(ts(addDays(today, -i), 10, m)), d: addDays(today, -i), rpm: m === 45 ? 2400 : 1500, w: m === 45 ? 700 : 140 })));
    await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) SELECT $1, t, d, 10, true, w, r FROM unnest($2::bigint[], $3::text[], $4::real[], $5::real[]) u(t, d, w, r)`,
      [S, pr.map(p => p.t), pr.map(p => p.d), pr.map(p => p.w), pr.map(p => p.rpm)]);
    const nr = Array.from({ length: 19 }, (_, i) => ({ t: Date.parse(ts(today, 11)) + i * 5 * 60_000, hvac: i < 18 ? 'COOLING' : 'OFF' }));
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco) SELECT $1, t, $2, 11, 77, 45, 'COOL', h, 78, NULL, false FROM unnest($3::bigint[], $4::text[]) u(t, h)`,
      [S, today, nr.map(r => r.t), nr.map(r => r.hvac)]);
  });
  beforeEach(async () => {
    await kv.set(`${S}:pool:last`, poolSnapshot(Date.now()));                // fresh: the old path reads no device either
    await kv.set('nest:last', nestState(Date.now(), { hvac: 'COOLING' }));
    vi.mocked(readPool).mockClear(); vi.mocked(readNest).mockClear();
  });

  it('the pool row: the same figures as the full Pool card, owner and guest, in 3 round trips', async () => {
    for (const s of [owner, guest]) {
      const before = await counted(() => oldPool(s)), after = await counted(() => poolSummary(S, s, RATE));
      expect(after.v).toEqual(before.v);
      expect(after.v).toMatchObject({ status: 'linked', watts: 153, kwhPerDay: expect.any(Number), savesPerMonth: expect.any(Number) });
      expect(after.n).toBe(3);                                                  // pool:last, the power curve, the solar profile
      expect(after.n).toBeLessThan(before.n);
      console.info(`[appliances] pool row: ${before.n} → ${after.n} PGlite round trips`);
    }
    // no bill parsed: the costs are null, as before
    expect(await poolSummary(S, owner, null)).toEqual(await oldPool(owner, null));
    expect(await poolSummary(S, owner, null)).toMatchObject({ savesPerMonth: null });
  });

  it('the AC row: the same figures as the full AC card, owner and guest, in 3 round trips', async () => {
    await acSummary(S, SLOPE);                                                   // the learned kW is cached for an hour (both paths read it)
    for (const [s, g] of [[owner, false], [guest, true]] as const) {
      const before = await counted(() => oldAc(s, g)), after = await counted(() => acSummary(S, SLOPE));
      expect(after.v).toEqual(before.v);
      expect(after.v).toMatchObject({ status: 'linked', watts: expect.any(Number), kwhPerDay: expect.any(Number) });
      expect(after.v.watts).toBeGreaterThan(0);
      expect(after.n).toBe(3);                                                  // nest:last, the learned kW, today's readings
      expect(after.n).toBeLessThan(before.n);
      console.info(`[appliances] AC row: ${before.n} → ${after.n} PGlite round trips`);
    }
  });

  it('stale snapshots: the rows never read the controller or Nest, for the owner either (the Pool and AC routes do that)', async () => {
    await kv.set(`${S}:pool:last`, poolSnapshot(Date.now() - 10 * 60_000));
    await kv.set('nest:last', nestState(Date.now() - 10 * 60_000));
    const p = await poolSummary(S, owner, RATE), a = await acSummary(S, SLOPE);
    expect(readPool).not.toHaveBeenCalled();
    expect(readNest).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'linked', watts: 153 });
    expect(a).toMatchObject({ status: 'linked', watts: 0 });
  });

  it('no snapshot: the pool row is "estimated" with no live watts, as the full card made it', async () => {
    await kv.set(`${S}:pool:last`, null);
    expect(await poolSummary(S, guest, RATE)).toEqual(await oldPool(guest));
    expect(await poolSummary(S, guest, RATE)).toMatchObject({ status: 'estimated', watts: null });
  });
});
