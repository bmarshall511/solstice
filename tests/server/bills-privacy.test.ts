// Bills never store or return the PEC account number or the source file name (Phase 2 batch 1).
//   BILL-1  toStoredBill keeps only the allow-listed fields
//   BILL-2  saveBill → the stored row and listBills carry only those fields
//   BILL-3  POST /api/bills with extra keys (owner cookie) stores the projection; GET /api/bills returns it
//   BILL-4  the one-time migration in migrate() strips account/source from old rows exactly once
//
// Self-contained, following docs/audit-designs/tests.md: PGlite in memory, the in-process Express app on 127.0.0.1:0,
// no network, synthetic values only (no real account, meter or bill figures). Named bills-privacy so it does not
// collide with the harness's planned tests/server/bills.test.ts (the pure parsePecText specs). It needs the REAL db.ts,
// so run it in the harness's `db` project, or keep the vi.unmock below under tests/server with the pure-mocks setup.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Bill } from '../../server/src/bills.js';

vi.unmock('../../server/src/db.js');

const KEY = 'test-owner-key-synthetic-bills-abcdefghij-klm';
let server: Server, base = '';
let db: typeof import('../../server/src/db.js');
let bills: typeof import('../../server/src/bills.js');

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('bill tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  bills = await import('../../server/src/bills.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port); // the fetch guard in tests/setup.ts allows only registered in-process servers
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

/** A bill as an old import or a careless body might carry it: the allowed fields plus private and unknown extras. */
const leaky = (billDate: string) => ({
  utility: 'PEC', billDate, dueDate: '2026-08-20', account: 'ACCT-TEST-0001', source: 'test-bill-2026-08.pdf', serviceAddress: 'test only',
  period: { from: '2026-07-01', to: '2026-07-31', days: 30, meterNo: 'M-TEST-1' },
  deliveredKwh: 500, receivedKwh: 200, total: 60.5,
  charges: [{ label: 'Energy Charge', kwh: 500, rate: 0.072, amount: 36, note: 'x' }, { label: 'Service Availability Charge', kwh: null, rate: null, amount: 32.5 }],
  meters: [{ register: 'delivered', from: '2026-07-01', to: '2026-07-31', days: 30, previous: 1000, present: 1500, multiplier: 1, kwh: 500, meter: 'M-TEST-1' }],
  tariff: { importRate: 0.102346, importRateAllIn: 0.1064, exportCredit: 0.071921, fixedMonthly: 32.5, discounts: -2.5, franchisePct: 0.0396, accountClass: 'x' },
  comparison: { thisMonthKwh: 500, lastMonthKwh: 450, lastYearKwh: 520, avgDailyKwh: 16, lastYearCost: 70, avgTempF: 90, name: 'x' },
  checks: { lineItemsSumToTotal: true, registersConsistent: true, raw: 'x' },
});
const TOP = ['billDate', 'charges', 'checks', 'comparison', 'deliveredKwh', 'dueDate', 'meters', 'period', 'receivedKwh', 'tariff', 'total', 'utility'];
function expectClean(b: any) {
  expect(Object.keys(b).sort()).toEqual(TOP);
  expect(b.period).toEqual({ from: '2026-07-01', to: '2026-07-31', days: 30 });
  expect(b.meters).toEqual([{ register: 'delivered', from: '2026-07-01', to: '2026-07-31', previous: 1000, present: 1500, kwh: 500 }]);
  expect(b.charges[0]).toEqual({ label: 'Energy Charge', kwh: 500, rate: 0.072, amount: 36 });
  expect(Object.keys(b.tariff).sort()).toEqual(['discounts', 'exportCredit', 'fixedMonthly', 'franchisePct', 'importRate', 'importRateAllIn']);
  expect(b.comparison).not.toHaveProperty('name');
  expect(b.checks).toEqual({ lineItemsSumToTotal: true, registersConsistent: true });
  expect(JSON.stringify(b)).not.toMatch(/ACCT-TEST|test-bill-2026|M-TEST|serviceAddress/);
}

describe('bill projection', () => {
  it('BILL-1 toStoredBill keeps only the allow-listed fields and adds none', () => {
    expectClean(bills.toStoredBill(leaky('2026-08-01') as unknown as Bill));
    const minimal = bills.toStoredBill({ utility: 'PEC', billDate: '2026-08-01', dueDate: null, period: { from: '2026-07-01', to: '2026-07-31', days: 30 },
      deliveredKwh: 1, receivedKwh: 0, total: 1, charges: [], tariff: { importRate: 0.1, importRateAllIn: 0.1, exportCredit: null, fixedMonthly: null, discounts: 0, franchisePct: null } });
    expect(Object.keys(minimal).sort()).toEqual(['billDate', 'charges', 'deliveredKwh', 'dueDate', 'period', 'receivedKwh', 'tariff', 'total', 'utility']);
  });

  it('BILL-2 saveBill stores only the projection, and listBills returns only the projection', async () => {
    await bills.saveBill('s', leaky('2026-08-01') as unknown as Bill);
    const row = await db.one<{ raw: any }>(`SELECT raw FROM bills WHERE site_id = 's' AND bill_date = '2026-08-01'`);
    expectClean(row!.raw);
    // defence in depth: a row that still holds the extras (written before this change) is projected on the way out
    await db.q(`INSERT INTO bills (site_id, bill_date, period_from, period_to, delivered_kwh, received_kwh, total, raw) VALUES ('s', '2026-09-01', '2026-08-01', '2026-08-31', 500, 200, 60.5, $1)`,
      [JSON.stringify(leaky('2026-09-01'))]);
    const listed = await bills.listBills('s');
    expect(listed.map(b => b.billDate)).toEqual(['2026-08-01', '2026-09-01']);
    listed.forEach(expectClean);
    await db.q(`DELETE FROM bills WHERE site_id = 's' AND bill_date = '2026-09-01'`);
  });

  it('BILL-3 POST /api/bills with extra keys stores the projection; GET /api/bills returns it', async () => {
    const unlock = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.200' }, body: JSON.stringify({ key: KEY }) });
    const cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0];
    expect(unlock.status).toBe(200);
    const post = await fetch(`${base}/api/bills`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(leaky('2026-10-01')) });
    expect(await post.json()).toEqual({ saved: '2026-10-01' });
    expectClean((await db.one<{ raw: any }>(`SELECT raw FROM bills WHERE site_id = 's' AND bill_date = '2026-10-01'`))!.raw);
    const got = await (await fetch(`${base}/api/bills`, { headers: { cookie } })).json();
    got.forEach(expectClean);
    expect((await fetch(`${base}/api/bills`)).status).toBe(401);   // and bills are owner-only
  });
});

describe('one-time migration: strip account/source from stored bills', () => {
  const FLAG = 'migration:bills-strip-account:v1';
  // two rows written the way the old one-time import wrote them: everything, including the account and the file name
  const old = (billDate: string, extra: Record<string, unknown>) => ({ utility: 'PEC', billDate, dueDate: null, period: { from: '2026-05-01', to: '2026-05-31', days: 30 },
    deliveredKwh: 400, receivedKwh: 150, total: 55.25, charges: [{ label: 'Energy Charge', kwh: 400, rate: 0.072, amount: 28.8 }],
    tariff: { importRate: 0.102346, importRateAllIn: 0.1064, exportCredit: 0.071921, fixedMonthly: 32.5, discounts: -2.5, franchisePct: 0.0396 },
    account: 'ACCT-TEST-0002', source: `test-${billDate}.pdf`, ...extra });
  const rows = async () => (await db.q<{ bill_date: string; raw: any }>(`SELECT bill_date, raw FROM bills WHERE site_id = 'm' ORDER BY bill_date`)).map(r => r.raw);

  it('BILL-4 migrate() twice: both rows lose only account and source, and the second run changes nothing', async () => {
    // migrate() has already run once in beforeAll on the empty table (it set the flag after changing 0 rows). The tables
    // must exist before rows can be seeded, and migrate() is memoised per process, so the seeded replay clears the flag
    // (as on a database that predates the fix) and runs the same guarded step migrate() runs.
    expect(await db.kv.get(FLAG)).toMatch(/^\d{4}-\d\d-\d\dT/);
    await db.q('DELETE FROM kv WHERE key = $1', [FLAG]);
    const a = old('2026-06-01', {}), b = old('2026-07-01', { comparison: { thisMonthKwh: 400, lastYearCost: 60 }, meters: [{ register: 'delivered', kwh: 400 }] });
    for (const x of [a, b]) await db.q(`INSERT INTO bills (site_id, bill_date, period_from, period_to, delivered_kwh, received_kwh, total, raw) VALUES ('m', $1, $2, $3, $4, $5, $6, $7)`,
      [x.billDate, x.period.from, x.period.to, x.deliveredKwh, x.receivedKwh, x.total, JSON.stringify(x)]);
    const strip = ({ account: _a, source: _s, ...rest }: Record<string, unknown>) => rest;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await db.migrate(); await db.oneTimeMigrations();                  // first run
    expect(await rows()).toEqual([strip(a), strip(b)]);                 // only the two keys are gone; every other value is unchanged
    expect(log.mock.calls.filter(c => String(c[0]).includes(FLAG))).toEqual([[`[solstice] one-time migration ${FLAG}: removed account/source from 2 bill row(s)`]]);
    const flag = await db.kv.get<string>(FLAG);
    expect(flag).toMatch(/^\d{4}-\d\d-\d\dT/);

    await db.migrate(); await db.oneTimeMigrations();                  // second run: the flag stops it
    expect(await rows()).toEqual([strip(a), strip(b)]);
    expect(await db.kv.get(FLAG)).toBe(flag);
    expect(log.mock.calls.filter(c => String(c[0]).includes(FLAG))).toHaveLength(1);

    await db.q('DELETE FROM kv WHERE key = $1', [FLAG]);              // even without the flag the statement is idempotent
    await db.oneTimeMigrations();
    expect(await rows()).toEqual([strip(a), strip(b)]);
    expect(log.mock.calls.at(-1)).toEqual([`[solstice] one-time migration ${FLAG}: removed account/source from 0 bill row(s)`]);
    log.mockRestore();
  });
});
