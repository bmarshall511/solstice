// S-07 and S-10: guest reads never reach a device or Tesla, and owner reads share one upstream call per window.
//   GR-1..3   Nest, ScreenLogic and Tesla live: 10 concurrent guest GETs on stale data → 0 upstream calls; 10 concurrent owner
//             GETs → exactly 1 (the kv single flight); the crons' fresh reads are not held back by it
//   GR-4      S-10: a guest's AC read with a changed reading and an expired hold writes no hold, hold history or AC log
//   GR-5..6   ?days caps on /api/profile and /api/overnight; the /api/whatif per-day cache
//   GR-7      the per-share-link token bucket answers 429 past its burst; the owner previewing is not limited
// In-process app on PGlite; Nest, ScreenLogic and Tesla are mocks that only count calls; every value is synthetic.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { nestState } from '../fixtures/nest.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';

vi.unmock('../../server/src/db.js');
const H = vi.hoisted(() => ({ liveStatus: null as any, overnightFrom: [] as string[] }));
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}),
}));
vi.mock('../../server/src/tesla/client.js', async orig => {
  const real = await orig<typeof import('../../server/src/tesla/client.js')>();
  return { ...real, teslaFor: () => ({ liveStatus: (...a: unknown[]) => H.liveStatus(...a) }) };
});
vi.mock('../../server/src/appliances/nest.js', async orig => {
  const real = await orig<typeof import('../../server/src/appliances/nest.js')>();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in guest-reads test`); });
  return { ...real, nestConfigured: () => true, nestLinked: vi.fn(async () => true),
    readNest: vi.fn(async () => { await new Promise(r => setTimeout(r, 30)); return nestState(Date.now(), { coolF: 74 }); }),
    nestExchangeCode: blocked('nestExchangeCode'), setCool: blocked('setCool'), ownerCommand: blocked('ownerCommand') };
});
vi.mock('../../server/src/appliances/screenlogic.js', () => ({
  configured: () => true,
  readPool: vi.fn(async () => { await new Promise(r => setTimeout(r, 30)); return poolSnapshot(Date.now()); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan in guest-reads test'); }),
  writeOwnerPool: vi.fn(async () => { throw new Error('writeOwnerPool in guest-reads test'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit in guest-reads test'); }),
}));
vi.mock('../../server/src/breakdown.js', async orig => ({
  ...(await orig<typeof import('../../server/src/breakdown.js')>()),
  overnightSplit: vi.fn(async (_id: string, from: string) => { H.overnightFrom.push(from); return []; }),
}));
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (/open-meteo\.com/.test(u)) return new Response('{}', { status: 500 });
  return guard(input as any, init);
});

const KEY = 'test-owner-key-synthetic-guestreads-abcdefgh';   // test-only
let server: Server, base = '', owner = '', guest = '', preview = '';
let db: typeof import('../../server/src/db.js');
let nest: typeof import('../../server/src/appliances/nest.js');
let screenlogic: typeof import('../../server/src/appliances/screenlogic.js');
let access: typeof import('../../server/src/access.js');
let client: typeof import('../../server/src/tesla/client.js');

type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie, json, ...rest } = init;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers as Record<string, string> ?? {}) };
  return fetch(base + path, { redirect: 'manual', ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const pair = (r: Response, name: string) => (r.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? '').split(';')[0];
const tenAt = async (path: string, cookie: string) => { const rs = await Promise.all(Array.from({ length: 10 }, () => call(path, { cookie }))); expect(rs.map(r => r.status)).toEqual(Array(10).fill(200)); };

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('guest-reads tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  nest = await import('../../server/src/appliances/nest.js');
  screenlogic = await import('../../server/src/appliances/screenlogic.js');
  access = await import('../../server/src/access.js');
  client = await import('../../server/src/tesla/client.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info) VALUES ('s', NULL, 1, 'Test home', $1)`, [JSON.stringify({ site_name: 'Test home', battery_count: 2, nameplate_energy: 27000 })]);
  await db.kv.set('settings:owner', { ac: { autopilot: 'suggest' }, pool: { autopilot: 'suggest' } });
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  owner = pair(await call('/api/auth/owner', { json: { key: KEY }, headers: { 'X-Real-IP': '198.18.1.1' } }), 'solstice_owner');
  const link = await (await call('/api/share', { cookie: owner, json: { label: 'Test guest' } })).json();
  guest = pair(await call('/api/auth/guest', { json: { token: link.token }, headers: { 'X-Real-IP': '198.18.1.2' } }), 'solstice_guest');
  preview = `${owner}; ${pair(await call('/api/auth/preview', { cookie: owner, json: { on: true } }), 'solstice_preview')}`;
  expect([owner, guest, preview].every(Boolean)).toBe(true);
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => {
  access.resetGuestRateLimits();
  vi.mocked(nest.readNest).mockClear(); vi.mocked(screenlogic.readPool).mockClear();
  for (const k of ['nest:readClaim', 's:pool:readClaim', 's:live:claim', 's:ac:hold', 's:ac:log', 's:ac:holdHistory']) await db.kv.set(k, null);
  await db.kv.set('pool:forecast', { at: Date.now(), days: [] });
});

describe('S-07 single flight', () => {
  it('GR-1 Nest: 10 concurrent guest reads of a stale reading call SDM 0 times; 10 concurrent owner reads call it once', async () => {
    await db.kv.set('nest:last', nestState(Date.now() - 10 * 60_000));
    await tenAt('/api/appliances/ac', guest);
    await tenAt('/api/appliances/ac', preview);                                   // the owner previewing is a guest read too
    expect(nest.readNest).toHaveBeenCalledTimes(0);
    await tenAt('/api/appliances/ac', owner);
    expect(nest.readNest).toHaveBeenCalledTimes(1);
    // a forced read (?fresh=1; the crons' acTick reads with fresh too) is never held back by the claim
    expect((await call('/api/appliances/ac?fresh=1', { cookie: owner })).status).toBe(200);
    expect(nest.readNest).toHaveBeenCalledTimes(2);
  });

  it('GR-2 ScreenLogic: 10 concurrent guest reads of a stale snapshot open 0 connections; 10 concurrent owner reads open one', async () => {
    await db.kv.set('s:pool:last', poolSnapshot(Date.now() - 10 * 60_000));
    await tenAt('/api/appliances/pool', guest);
    await tenAt('/api/appliances', guest);                                         // the appliance list's pool row too
    expect(screenlogic.readPool).toHaveBeenCalledTimes(0);
    await tenAt('/api/appliances/pool', owner);
    expect(screenlogic.readPool).toHaveBeenCalledTimes(1);
  });

  it('GR-3 Tesla live: guest /api/now never calls Tesla; 10 concurrent owner reads of a stale reading call it once', async () => {
    const calls: unknown[] = [];
    H.liveStatus = async (...a: unknown[]) => { calls.push(a); await new Promise(r => setTimeout(r, 30));
      return { timestamp: new Date().toISOString(), solar_power: 1000, battery_power: 0, grid_power: 0, load_power: 1000, percentage_charged: 50, grid_status: 'Active', island_status: 'on_grid' }; };
    await db.q(`DELETE FROM readings`);
    await db.q(`INSERT INTO readings (site_id, ts, solar_w, battery_w, grid_w, load_w, soc, grid_status, island_status, storm_mode_active) VALUES ('s', $1, 1, 0, 0, 1, 50, 'Active', 'on_grid', false)`, [Date.now() - 10 * 60_000]);
    await tenAt('/api/now', guest);
    expect(calls).toHaveLength(0);
    await tenAt('/api/now', owner);
    expect(calls).toHaveLength(1);
    expect(client.teslaFor).toBeTypeOf('function');
  });
});

describe('S-10 guest reads start no holds', () => {
  it('GR-4 a guest read with a changed, stale reading and an expired hold writes nothing under the AC hold and log keys', async () => {
    const t = Date.now();
    await db.kv.set('nest:last', nestState(t - 10 * 60_000, { coolF: 80 }));         // stale: the owner's read would fetch 74° and hold it
    await db.kv.set('s:ac:hold', { at: t - 5 * 3600e3, by: 'wall', mode: 'COOL', coolF: 76, heatF: null, until: t - 3600e3, why: 'test' });   // already over
    await db.kv.set('s:ac:log', [{ at: t - 3600e3, day: '2026-01-01', text: 'synthetic line' }]);
    // the hold, its history (the suggestion patterns), the AC log and the plan record a hold's end re-arms
    const keys = async () => JSON.stringify(await db.q(`SELECT key, value FROM kv WHERE key IN ('s:ac:hold', 's:ac:holdHistory', 's:ac:log', 's:ac:plan') ORDER BY key`));
    const before = await keys();
    const r = await (await call('/api/appliances/ac', { cookie: guest })).json();
    expect(r.hold ?? null).toBeNull();                                               // an expired hold shows as none
    expect(await keys()).toBe(before);
    expect(nest.readNest).not.toHaveBeenCalled();
    // the owner's read of the same state does end the hold and log it (what a guest read used to do too)
    await call('/api/appliances/ac', { cookie: owner });
    expect(await keys()).not.toBe(before);
  });
});

describe('S-07 bounded reads', () => {
  it('GR-5 /api/profile caps days at 60 and /api/overnight at 120; junk falls back to the default', async () => {
    expect((await (await call('/api/profile?days=100000', { cookie: guest })).json()).days).toBe(60);
    expect((await (await call('/api/profile?days=abc', { cookie: owner })).json()).days).toBe(14);
    expect((await (await call('/api/profile?days=7', { cookie: owner })).json()).days).toBe(7);
    H.overnightFrom.length = 0;
    await call('/api/overnight?days=99999', { cookie: guest });
    await call('/api/overnight?days=-5', { cookie: owner });
    const today = client.localDay();
    expect(H.overnightFrom).toEqual([client.addDays(today, -120), client.addDays(today, -60)]);
  });

  it('GR-6 /api/whatif is replayed once per day per normalized query', async () => {
    await db.kv.set('s:whatif:cache', null);
    const a = await (await call('/api/whatif?panels=8', { cookie: owner })).json();
    const cache = await db.kv.get<{ day: string; entries: Array<{ k: string; v: any }> }>('s:whatif:cache');
    expect(cache!.day).toBe(client.localDay());
    expect(cache!.entries).toHaveLength(1);
    const b = await (await call('/api/whatif?panels=08&powerwalls=0', { cookie: owner })).json();   // the same query, written differently
    expect(b).toEqual(a);
    expect((await db.kv.get<any>('s:whatif:cache')).entries).toHaveLength(1);
    await call('/api/whatif?panels=4', { cookie: guest });
    expect((await db.kv.get<any>('s:whatif:cache')).entries).toHaveLength(2);
    // a hit serves the stored replay: plant a marker in it and see it come back
    const c = await db.kv.get<any>('s:whatif:cache');
    c.entries[0].v.baseline.importKwh = 4242; await db.kv.set('s:whatif:cache', c);   // the first entry is panels=8
    expect((await (await call('/api/whatif?panels=8', { cookie: owner })).json()).baseline.importKwh).toBe(4242);
    // yesterday's cache is not used
    c.day = '2000-01-01'; await db.kv.set('s:whatif:cache', c);
    expect((await (await call('/api/whatif?panels=8', { cookie: owner })).json()).baseline.importKwh).not.toBe(4242);
  });
});

describe('S-07 per-link rate limit', () => {
  it('GR-7 a share link gets its burst, then 429 with Retry-After; the owner previewing is not limited', async () => {
    const t = 1_000_000;
    for (let i = 0; i < access.GUEST_BURST; i++) expect(access.guestRateLimited('unit-link', t)).toBe(false);
    expect(access.guestRateLimited('unit-link', t)).toBe(true);
    expect(access.guestRateLimited('unit-link', t + 1_000)).toBe(false);            // a second refills one read
    expect(access.guestRateLimited('other-link', t)).toBe(false);                  // buckets are per link
    const rs = await Promise.all(Array.from({ length: access.GUEST_BURST + 10 }, () => call('/api/status', { cookie: guest })));
    const limited = rs.filter(r => r.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(5);
    expect(rs.filter(r => r.status === 200).length).toBeGreaterThanOrEqual(access.GUEST_BURST);
    expect(limited[0].headers.get('retry-after')).toBe('5');
    expect(await limited[0].json()).toEqual({ error: 'too_many_requests' });
    const p = await Promise.all(Array.from({ length: access.GUEST_BURST + 10 }, () => call('/api/status', { cookie: preview })));
    expect(p.every(r => r.status === 200)).toBe(true);
  });
});
