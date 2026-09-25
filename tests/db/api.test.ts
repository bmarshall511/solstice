// The Express app over a real socket on 127.0.0.1 with the real fetch (no supertest), on in-memory PGlite: design §8.
// Every /api route is owner-only, so the requests below carry the owner cookie, unlocked once with the synthetic
// OWNER_KEY that tests/setup.ts puts in the environment. The gate itself is tested in tests/server/auth.test.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../../server/src/app.js';
import { q, kv, migrate } from '../../server/src/db.js';
import { saveEnergyRows } from '../../server/src/sync.js';
import { writePoolPlan } from '../../server/src/appliances/screenlogic.js';
import { parsePecText } from '../../server/src/bills.js';
import { PEC_BILL } from '../fixtures/pec-bill.js';

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => false,
  readPool: vi.fn(async () => { throw new Error('readPool in api test'); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan in api test'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit in api test'); }),
}));
vi.mock(import('../../server/src/appliances/nest.js'), async importOriginal => {
  const real = await importOriginal();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in api test`); });
  return { ...real, nestConfigured: () => false, nestLinked: vi.fn(async () => false), readNest: blocked('readNest'),
    nestExchangeCode: blocked('nestExchangeCode'), setCool: blocked('setCool'), setHeat: blocked('setHeat'), setMode: blocked('setMode'), setEco: blocked('setEco') };
});

let server: Server, base = '', cookie = '';
const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { cookie, ...headers } });
const send = (method: string, path: string, body: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });

beforeAll(async () => {
  await migrate();
  const [acct] = await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'test-access', 'test-refresh', 0) RETURNING id`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, $1, 'Test Site')`, [acct.id]);
  const ts = '2026-09-24T13:05:00-05:00';
  await saveEnergyRows('s', [{ ts, epoch: Date.parse(ts), day: '2026-09-24', hour: 13, solar: 500, home: 370, imp: 25, exp: 100, chg: 105, dis: 50 }]);
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port); // the fetch guard in tests/setup.ts allows only registered in-process servers
  base = `http://127.0.0.1:${port}`;
  const unlock = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) });
  expect(unlock.status).toBe(200);
  cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0];
});
afterAll(async () => { await new Promise(r => server.close(r)); });

describe('single-owner mode', () => {
  it('/api/auth/me reports single mode and the connected site', async () => {
    const r = await get('/api/auth/me');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mode: 'single', owner: true, user: null, site: { id: 's', name: 'Test Site' } });
  });

  it('PUT /api/settings merges top-level keys into the owner settings', async () => {
    expect((await send('PUT', '/api/settings', { calm: { enabled: true } })).status).toBe(200);
    expect((await send('PUT', '/api/settings', { pool: { autopilot: 'suggest' } })).status).toBe(200);
    // GET adds the site location from SITE_LAT/SITE_LON, which tests never set
    expect(await (await get('/api/settings')).json()).toEqual({ calm: { enabled: true }, pool: { autopilot: 'suggest' }, location: null });
  });
});

describe('data routes', () => {
  it('/api/day turns a stored 5-minute bucket into kW and the day into kWh', async () => {
    const d = await (await get('/api/day?date=2026-09-24')).json();
    expect(d.date).toBe('2026-09-24');
    expect(d.buckets).toHaveLength(1);
    expect(d.buckets[0].t).toBeCloseTo(13.0833, 4);
    expect({ ...d.buckets[0], t: undefined }).toEqual({ t: undefined, solar: 6, home: 4.44, grid: -0.9, battery: -0.66 });
    expect(d.soe).toEqual([]);
    expect(d.totals).toEqual({ solar: .5, home: .37, import: .03, export: .1, charge: .11, discharge: .05 });
  });

  it('POST /api/events rejects a malformed day', async () => {
    const r = await send('POST', '/api/events', { type: 'cleaned', day: '2026-9-1' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'type and day required' });
  });
});

describe('cron routes need CRON_SECRET, which tests never have', () => {
  it.each(['/api/cron/sync', '/api/cron/pool', '/api/cron/nest'])('%s returns 401 with no bearer and with any bearer', async path => {
    expect(process.env.CRON_SECRET).toBeUndefined();
    const variants: Array<Record<string, string>> = [{}, { authorization: 'Bearer anything' }, { authorization: 'Bearer undefined' }, { authorization: 'Bearer ' }];
    for (const headers of variants) {
      const r = await get(path, headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
  });
});

describe('pool Autopilot mode', () => {
  it('rejects an unknown mode', async () => {
    const r = await send('POST', '/api/appliances/pool/autopilot', { mode: 'x' });
    expect(r.status).toBe(400);
  });
  it('stores suggest in the owner settings and never writes to ScreenLogic', async () => {
    const r = await send('POST', '/api/appliances/pool/autopilot', { mode: 'suggest' });
    expect(await r.json()).toEqual({ ok: true, mode: 'suggest' });
    expect((await kv.get<Record<string, any>>('settings:owner'))?.pool?.autopilot).toBe('suggest');
    expect(writePoolPlan).not.toHaveBeenCalled();
  });
});

describe('/api/whatif replays stored hours with a different system', () => {
  // Locks today's replay (inside the route) ahead of the planner.ts extraction (design X15). Three hours on one day:
  // 12:00 and 13:00 make 5 kWh against 2 kWh of use, 18:00 uses 3 kWh with no sun. No site info, so the replay uses
  // 27 kWh / 10 kW / 20 % reserve. Rates come only from a parsed bill (server/src/tariff.ts): with none every cost is
  // null; after the synthetic fixture bill is saved they are 0.1064 in and 0.071921 out.
  const whatif = async (qs = '') => (await get(`/api/whatif${qs}`)).json();
  const day = '2026-09-20', row = (hour: number, solar: number, home: number) => {
    const ts = `${day}T${hour}:00:00-05:00`;
    return { ts, epoch: Date.parse(ts), day, hour, solar, home, imp: 0, exp: 0, chg: 0, dis: 0 };
  };
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-25T18:00:00Z') });
    await q(`DELETE FROM energy WHERE site_id = 's'`);
    await saveEnergyRows('s', [row(12, 5000, 2000), row(13, 5000, 2000), row(18, 0, 3000)]);
  });
  afterAll(() => { vi.useRealTimers(); });

  it('with no bill parsed the kWh replay stands, every cost is null and the reason says why', async () => {
    const w = await whatif();
    expect(w.baseline).toEqual({ importKwh: 0, exportKwh: 0, solarKwh: 10, homeKwh: 7, selfPowered: 100, batteryFullDays: 0, netCost: null });
    expect(w.noSystem).toEqual({ importKwh: 7, exportKwh: 0, solarKwh: 0, homeKwh: 7, selfPowered: 0, batteryFullDays: 0, netCost: null });
    expect([w.savesPerYear, w.paybackYears, w.assumptions.tariff, w.reason]).toEqual([null, null, null, 'no bill parsed']);
  });
  it('the fixture bill is saved through the API, which is where the rates come from', async () => {
    expect((await send('POST', '/api/bills', parsePecText(PEC_BILL))).status).toBe(200);
    const w = await whatif();
    expect(w.assumptions.tariff).toMatchObject({ importRateAllIn: .1064, exportCredit: .071921 });
    expect(w).not.toHaveProperty('reason');
  });
  it('the as-built system covers every hour; no system imports everything', async () => {
    const w = await whatif();
    expect(w.days).toBe(1);
    expect(w.baseline).toEqual({ importKwh: 0, exportKwh: 0, solarKwh: 10, homeKwh: 7, selfPowered: 100, batteryFullDays: 0, netCost: 0 });
    expect(w.noSystem).toEqual({ importKwh: 7, exportKwh: 0, solarKwh: 0, homeKwh: 7, selfPowered: 0, batteryFullDays: 0, netCost: 1 });
    expect(w.upgraded).toEqual(w.baseline);
    expect(w.system).toBeNull();
  });
  it('twice the panels fill the Powerwalls and export the rest', async () => {
    const w = await whatif('?panels=24'); // 24 × 400 W doubles the 9.6 kW array
    expect(w.upgraded).toMatchObject({ importKwh: 0, exportKwh: 2, solarKwh: 20, batteryFullDays: 1 });
  });
  it('an extra evening load lands in the 17:00–23:00 hours', async () => {
    expect((await whatif('?extra=6')).baseline.homeKwh).toBe(8);
  });
  it('system economics come from the owner settings (placeholder figures here)', async () => {
    await send('PUT', '/api/settings', { system: { priceUsd: 10000, taxCreditPct: 30, loanYears: 10, loanRatePct: 6 } });
    const w = await whatif();
    expect(w.system).toMatchObject({ priceUsd: 10000, taxCreditPct: 30, netUsd: 7000, monthlyPayment: 111, savesPerYear: 1, paybackYears: 7000 });
  });
});

describe('learning layer routes (owner-only)', () => {
  it('GET /api/models and POST /api/appliances/ac/untrim answer 401 without the owner cookie', async () => {
    expect((await fetch(base + '/api/models')).status).toBe(401);
    expect((await fetch(base + '/api/appliances/ac/untrim', { method: 'POST' })).status).toBe(401);
  });

  it('GET /api/models: every model with its tier, badge and scores, open anomalies, the log and the AC trim state', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    await q(`INSERT INTO model_scores (site_id, model, "window", mae, mape, bias, n, last_day, updated_at) VALUES ('s', 'fc48.solar', '30d', 1.1, .04, -.01, 20, $1, 0)`, [day]);
    await q(`INSERT INTO anomalies (site_id, day, kind, severity, detail, opened_at) VALUES ('s', $1, 'data.gap.energy', 'warn', $2, 1)`,
      [day, JSON.stringify({ title: 'Energy history has a gap', body: 'b', expected: 288, measured: 200 })]);
    const r = await get('/api/models');
    expect(r.status).toBe(200);
    const m = await r.json();
    expect(Object.keys(m)).toEqual(['summary', 'lastRun', 'models', 'anomalies', 'log', 'ac']);
    expect(m.models.map((x: any) => x.id)).toEqual(['fc48.solar', 'fc48.home', 'fc48.soc', 'pool.kwhDay', 'ac.shifted', 'ac.eveningAvoided', 'bill.cycleImport', 'home.alwaysOn']);
    // the r-learning mockup's row fields
    expect(Object.keys(m.models[0])).toEqual(['id', 'label', 'unit', 'abs', 'dot', 't', 'v', 'tier', 'confidence', 'n', 'need', 'mape', 'mae', 'mad', 'bias', 'base', 'spark',
      'improvement', 'bands', 'note', 'help', 'scores', 'days']);
    expect(m.models[0]).toMatchObject({ label: 'Next 48 h solar', dot: 'learned', t: 'l', v: '±4%', tier: 'learned', n: 20, need: 14, mape: 4, bias: -1, note: '20 days scored', help: null });
    expect(m.models[3]).toMatchObject({ id: 'pool.kwhDay', dot: 'unscored', t: 'u', v: 'unscored', help: 'needs pool readings through at least 80% of the pump’s scheduled hours' });
    expect(m.models[4]).toMatchObject({ id: 'ac.shifted', dot: 'estimated', v: 'estimated' });
    expect(m.summary).toEqual({ learned: 1, measured: 0, total: 8, improvement: null, headline: null });
    expect(m.anomalies).toEqual([{ id: expect.any(Number), kind: 'data.gap.energy', day, severity: 'warn', openedAt: 1, title: 'Energy history has a gap', body: 'b',
      detail: { title: 'Energy history has a gap', body: 'b', expected: 288, measured: 200 } }]);
    expect(m.ac).toEqual({ trim: null, measured: null, warmupFPerH: null, control: { every: 5, eligibleDays: 0, nextIn: 5, today: null } });
    expect(JSON.stringify(m)).not.toMatch(/usd|price|loan|rate"|cost/i);
  });

  it('POST /api/appliances/ac/untrim: 409 with no trim today; with one it is undone and returned', async () => {
    expect((await send('POST', '/api/appliances/ac/untrim', {})).status).toBe(409);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    await kv.set('s:learn:ac', { at: 0, day, trim: { what: 'coast', amount: -30, unit: 'min', reason: 'r', day }, measured: null, warmupFPerH: null, coolKw: null });
    const r = await send('POST', '/api/appliances/ac/untrim', {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, trim: { what: 'coast', amount: -30, day, undone: true } });
    expect((await (await get('/api/models')).json()).ac.trim).toMatchObject({ undone: true });
  });

  it('/api/profile carries the 48-hour forecast’s confidence next to the profile it is built on', async () => {
    const p = await (await get('/api/profile')).json();
    expect(p.conf).toEqual({ 'fc48.solar': 'learned', 'fc48.home': 'unscored', 'fc48.soc': 'unscored' });
  });
});
