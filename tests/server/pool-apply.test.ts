// S-14: the pool apply routes. /api/appliances/pool/apply-tomorrow applies only the plan made for tomorrow (Chicago), and both
// /apply and /apply-tomorrow answer 409 during an active Clear-up, as /schedule does, before the controller is read or written.
// In-process app on PGlite; ScreenLogic is a mock that records writes; every value is synthetic.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { poolSnapshot } from '../fixtures/screenlogic.js';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}),
}));
vi.mock('../../server/src/appliances/screenlogic.js', () => ({
  configured: () => true,
  readPool: vi.fn(async () => poolSnapshot(Date.now())),
  writePoolPlan: vi.fn(async () => ({ removed: [], added: [] })),
  writeOwnerPool: vi.fn(async () => { throw new Error('writeOwnerPool in pool-apply test'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit in pool-apply test'); }),
}));
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (/open-meteo\.com/.test(u)) return new Response('{}', { status: 500 });
  return guard(input as any, init);
});

const KEY = 'test-owner-key-synthetic-poolapply-abcdefghi';   // test-only
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let screenlogic: typeof import('../../server/src/appliances/screenlogic.js');
let client: typeof import('../../server/src/tesla/client.js');
let plan: unknown;

const post = (path: string) => fetch(base + path, { method: 'POST', headers: { cookie: owner } });

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('pool-apply tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  screenlogic = await import('../../server/src/appliances/screenlogic.js');
  client = await import('../../server/src/tesla/client.js');
  const { planFor, powerModel, POOL_DEFAULTS } = await import('../../server/src/appliances/pool.js');
  plan = planFor({ waterTemp: 85, solarKw: Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 18 ? 5 : 0)), settings: POOL_DEFAULTS, W: powerModel([]), rate: null, month: 8, names: new Map() });
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  await db.kv.set('settings:owner', { pool: { autopilot: 'suggest' } });
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const r = await fetch(`${base}/api/auth/owner`, { method: 'POST', body: JSON.stringify({ key: KEY }), headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.18.2.1' } });
  owner = (r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? '').split(';')[0];
  expect(owner).toBeTruthy();
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => {
  vi.mocked(screenlogic.writePoolPlan).mockClear(); vi.mocked(screenlogic.readPool).mockClear();
  await db.kv.set('s:pool:clearup', null); await db.kv.set('s:pool:pending', null);
  await db.kv.set('pool:forecast', { at: Date.now(), days: [] });
});
const tomorrow = () => client.addDays(client.localDay(), 1);

describe('S-14 pool apply routes', () => {
  it('PA-1 apply-tomorrow refuses (409) a pending plan dated yesterday or today, and writes nothing', async () => {
    for (const date of [client.addDays(client.localDay(), -1), client.localDay()]) {
      await db.kv.set('s:pool:pending', { date, plan, why: [] });
      const r = await post('/api/appliances/pool/apply-tomorrow');
      expect(r.status, date).toBe(409);
    }
    expect(screenlogic.writePoolPlan).not.toHaveBeenCalled();
    expect(await db.kv.get('s:pool:pending')).toMatchObject({ date: client.localDay() });   // left for tonight's run to replace
  });

  it('PA-2 apply-tomorrow with tomorrow’s plan writes it once and clears it', async () => {
    await db.kv.set('s:pool:pending', { date: tomorrow(), plan, why: [] });
    const r = await post('/api/appliances/pool/apply-tomorrow');
    expect(r.status).toBe(200);
    expect(screenlogic.writePoolPlan).toHaveBeenCalledTimes(1);
    expect(await db.kv.get('s:pool:pending')).toBeNull();
    expect((await post('/api/appliances/pool/apply-tomorrow')).status).toBe(409);       // nothing waiting any more
  });

  it('PA-3 during an active Clear-up /apply and /apply-tomorrow answer 409, read nothing and write nothing', async () => {
    const now = Date.now();
    await db.kv.set('s:pool:clearup', { startedAt: now - 3600e3, until: now + 864e5, days: 2, rpm: 2000 });
    await db.kv.set('s:pool:pending', { date: tomorrow(), plan, why: [] });
    for (const path of ['/api/appliances/pool/apply', '/api/appliances/pool/apply-tomorrow']) {
      const r = await post(path);
      expect(r.status, path).toBe(409);
      expect(await r.json()).toEqual({ error: 'A Clear-up is running; end it first' });
    }
    expect(screenlogic.writePoolPlan).not.toHaveBeenCalled();
    expect(screenlogic.readPool).not.toHaveBeenCalled();
    expect(await db.kv.get('s:pool:pending')).toMatchObject({ date: tomorrow() });
    // a Clear-up that has ended no longer blocks
    await db.kv.set('s:pool:clearup', { startedAt: now - 3 * 864e5, until: now - 1000, days: 2, rpm: 2000 });
    expect((await post('/api/appliances/pool/apply')).status).toBe(200);
    expect(screenlogic.writePoolPlan).toHaveBeenCalledTimes(1);
  });
});
