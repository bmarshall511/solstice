// The real schema and SQL on in-memory PGlite (one fresh database for this file): design §8, cases 31–33.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { q, one, kv, migrate } from '../../server/src/db.js';
import { saveEnergyRows } from '../../server/src/sync.js';
import { recordReading, measuredPoints } from '../../server/src/appliances/pool.js';
import { useDays } from '../../server/src/appliances/autopilot.js';
import { saveBill, listBills, parsePecText } from '../../server/src/bills.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';
import { PEC_BILL } from '../fixtures/pec-bill.js';

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => false, readPool: vi.fn(), writePoolPlan: vi.fn(), withUnit: vi.fn(),
}));

const NOW = Date.parse('2026-09-25T18:00:00Z'); // 13:00 CDT
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await migrate();
});
afterAll(() => { vi.useRealTimers(); });

describe('schema and kv', () => {
  it('31: migrate() creates every table and is safe to call again', async () => {
    await expect(migrate()).resolves.toBeUndefined();
    const tables = (await q<{ t: string }>(`SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map(r => r.t);
    expect(tables).toEqual(['access_tokens', 'backup_events', 'bills', 'energy', 'events', 'kv', 'login_attempts', 'nest_readings', 'owner_sessions', 'pool_readings', 'pvs_readings', 'readings',
      'sessions', 'sites', 'soe', 'synced_days', 'tesla_accounts', 'users']);
  });
  it('31: kv round-trips JSON, stores null, and returns undefined for a missing key', async () => {
    await kv.set('test:obj', { x: 1 });
    expect(await kv.get('test:obj')).toEqual({ x: 1 });
    await kv.set('test:obj', null);
    expect(await kv.get('test:obj')).toBeNull();
    expect(await kv.get('test:missing')).toBeUndefined();
  });
  it('31: saveEnergyRows upserts by (site, ts)', async () => {
    const row = (ts: string, solar: number) => ({ ts, epoch: Date.parse(ts), day: '2026-09-24', hour: 13, solar, home: 370, imp: 25, exp: 100, chg: 105, dis: 50 });
    await saveEnergyRows('s', [row('2026-09-24T13:00:00-05:00', 500), row('2026-09-24T13:05:00-05:00', 510)]);
    await saveEnergyRows('s', [row('2026-09-24T13:05:00-05:00', 520)]);
    const rows = await q<{ ts: string; solar_wh: number }>(`SELECT ts, solar_wh FROM energy WHERE site_id = 's' ORDER BY epoch`);
    expect(rows).toEqual([{ ts: '2026-09-24T13:00:00-05:00', solar_wh: 500 }, { ts: '2026-09-24T13:05:00-05:00', solar_wh: 520 }]);
    expect(await one(`SELECT day, hour, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE ts = '2026-09-24T13:05:00-05:00'`))
      .toEqual({ day: '2026-09-24', hour: 13, home_wh: 370, import_wh: 25, export_wh: 100, charge_wh: 105, discharge_wh: 50 });
  });
  it('saveBill/listBills round-trip a parsed bill and upsert by bill date', async () => {
    const bill = parsePecText(PEC_BILL);
    await saveBill('s', bill);
    await saveBill('s', { ...bill, total: 140 });
    const bills = await listBills('s');
    expect(bills).toHaveLength(1);
    expect(bills[0]).toEqual({ ...bill, total: 140 });
  });
});

describe('pool readings', () => {
  const minute = 60_000;
  const read = (i: number, o: Parameters<typeof poolSnapshot>[1]) => recordReading('meas', poolSnapshot(NOW - (100 - i) * minute, o));

  it('recordReading stores the Chicago day and hour and the ids of the circuits that are on', async () => {
    await recordReading('rec', poolSnapshot(NOW, { on: [2, 3, 6] }));
    expect(await one(`SELECT day, hour, running, watts, rpm, water_temp, air_temp, circuits FROM pool_readings WHERE site_id = 'rec'`))
      .toEqual({ day: '2026-09-25', hour: 13, running: true, watts: 153, rpm: 1500, water_temp: 88, air_temp: 85, circuits: [2, 3, 6] });
    expect((await kv.get<{ at: number }>('rec:pool:last'))?.at).toBe(NOW);
  });

  it('32: measuredPoints is the median watts per RPM seen at least three times while running', async () => {
    let i = 0;
    for (const watts of [150, 153, 160]) await read(i++, { rpm: 1500, watts });
    for (const watts of [285, 287, 290]) await read(i++, { rpm: 1800, watts });
    for (const watts of [800, 810]) await read(i++, { rpm: 2400, watts });              // only two: dropped
    await read(i++, { rpm: 1500, watts: 999, running: false });                        // not running: ignored
    const pts = (await measuredPoints('meas')).sort((a, b) => a.rpm - b.rpm);
    expect(pts).toEqual([{ rpm: 1500, watts: 153 }, { rpm: 1800, watts: 287 }]);
  });
});

describe('BUG-1: jsonb ?| never matches numeric circuit ids', () => {
  // recordReading stores circuits as numbers ([2,3,6]); `?|` only matches string elements, so today the use-day,
  // used-yesterday and pool-light predicates count 0 rows.
  beforeAll(async () => { await recordReading('use', poolSnapshot(NOW - 3600e3, { on: [2, 3, 6] })); });

  it('the predicate as written matches nothing; the jsonb_array_elements_text form matches the row', async () => {
    const asWritten = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM pool_readings WHERE site_id = 'use' AND circuits ?| array['1','2','3','4','7']`);
    const fixed = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM pool_readings WHERE site_id = 'use'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(circuits) e WHERE e = ANY($1::text[]))`, [['1', '2', '3', '4', '7']]);
    expect([asWritten?.n, fixed?.n]).toEqual([0, 1]);
  });
  it.fails('BUG-1: useDays counts a day with the blower on', async () => {
    expect(await useDays('use')).toBe(1);
  });
  it('BUG-1 (today): useDays is 0', async () => {
    expect(await useDays('use')).toBe(0);
  });
});
