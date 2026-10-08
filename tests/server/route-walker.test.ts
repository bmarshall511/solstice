// The guest-refusal walker (audit 10b, test batch 7 item 3). Every route the Express app serves is read from its router at runtime
// (tests/helpers/routes.ts: Express 5's router stack, routers mounted with app.use included), so a new route is covered the moment it
// is added, with no list to keep up to date. Every handler is swapped for a sentinel that records the hit and answers 599, so:
//   WALK-1  the walker sees the whole app: sub-router routes, every GUEST_GET view's route, a sane total
//   WALK-2  anonymous: only the pinned open routes reach a handler; everything else is 401 owner_required
//   WALK-3  guest: every non-GET (POST, PUT, PATCH, DELETE, and OPTIONS on any path) is 401 before its handler
//   WALK-4  guest and owner-preview: every GET (and HEAD) without a GUEST_GET view is 401 before its handler
//   WALK-5  owner-preview: writes still reach their handlers (access.ts: preview changes the owner's reads only, so it can be switched off)
//   WALK-6  cross-check with RED-10 (tests/server/redaction.test.ts): its pinned top-level list is exactly the walker's top-level
//           owner-only reads, and the walker adds the sub-router reads RED-10 cannot see
// PGlite in memory, no network; Tesla sync and Nest are mocked, ScreenLogic is stubbed by tests/server/pure-mocks.ts. Synthetic values.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mountedRoutes, concrete, type RouteEntry } from '../helpers/routes.js';   // before the app is imported

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}),
}));

const KEY = 'test-owner-key-synthetic-walker-abcdefghij-kl';   // test-only
let server: Server, base = '', owner = '', guest = '', preview = '';
let all: RouteEntry[] = [];
let GUEST_GET: ReadonlyMap<string, unknown>;
let resetLimits: () => void;   // one guest walks every route, well past the per-link rate limit (S-07; tested in guest-reads.test.ts)
const hits: string[] = [];

/** Pinned on purpose: the routes anyone may call (access.ts OPEN_ROUTES). Adding one must be a decision, so it is listed here too. */
const OPEN = ['GET /api/auth/me', 'GET /api/cron/nest', 'GET /api/cron/pool', 'GET /api/cron/sync', 'GET /auth/callback', 'GET /auth/google/callback',
  'POST /api/auth/guest', 'POST /api/auth/leave', 'POST /api/auth/owner', 'POST /api/nest/events'];
const isOpen = (r: RouteEntry) => OPEN.includes(`${r.method} ${r.path}`);

type Init = RequestInit & { cookie?: string };
const call = (path: string, { cookie, ...init }: Init = {}) => (resetLimits?.(), fetch)(base + path, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string> ?? {}) } });
const pair = (r: Response, name: string) => (r.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? '').split(';')[0];
const body = (method: string) => method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? {} : { headers: { 'Content-Type': 'application/json' }, body: '{"on":true,"mode":"auto"}' };

beforeAll(async () => {
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-walker-0000' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  const db = await import('../../server/src/db.js');
  GUEST_GET = (await import('../../server/src/redact.js')).GUEST_GET;
  resetLimits = (await import('../../server/src/access.js')).resetGuestRateLimits;
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test')`);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  // the three identities, made through the real handlers before they are swapped out
  owner = pair(await call('/api/auth/owner', { method: 'POST', body: JSON.stringify({ key: KEY }), headers: { 'X-Real-IP': '198.18.1.1' } }), 'solstice_owner');
  const link = await (await call('/api/share', { cookie: owner, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'walker' }) })).json();
  guest = pair(await call('/api/auth/guest', { method: 'POST', body: JSON.stringify({ token: link.token }), headers: { 'X-Real-IP': '198.18.1.2' } }), 'solstice_guest');
  preview = `${owner}; ${pair(await call('/api/auth/preview', { cookie: owner, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' }), 'solstice_preview')}`;
  expect([owner, guest, preview].every(Boolean)).toBe(true);
  // every route's own stack (body parsers included) becomes one sentinel: a refused request never gets here, an allowed one says so
  all = mountedRoutes(app);
  const seen = new Set<any>();
  for (const r of all) {
    if (seen.has(r.layer)) continue; seen.add(r.layer);
    for (const sub of r.layer.route.stack) sub.handle = (req: any, res: any) => { hits.push(`${req.method} ${req.baseUrl}${req.path}`); res.status(599).json({ reached: true }); };
  }
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(() => { hits.length = 0; });

const ownerOnlyGets = () => all.filter(r => r.method === 'GET' && !isOpen(r) && !GUEST_GET.has(r.path.toLowerCase()));
const writes = () => all.filter(r => r.method !== 'GET' && !isOpen(r));

describe('the walker', () => {
  it('WALK-1 sees every route, sub-routers included', () => {
    const keys = all.map(r => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);                                       // each method + path once
    for (const k of ['GET /api/models', 'POST /api/appliances/ac/untrim', 'POST /api/pvs/readings', 'POST /api/pvs/heartbeat', 'GET /api/pvs/day',
      'GET /api/pvs/latest', 'GET /api/pvs/layout', 'POST /api/pvs/layout', 'GET /api/pvs/panels', 'PATCH /api/vacation', 'DELETE /api/push/subscribe'])
      expect(keys, k).toContain(k);
    const gets = new Set(all.filter(r => r.method === 'GET').map(r => r.path.toLowerCase()));
    expect([...GUEST_GET.keys()].filter(p => !gets.has(p)), 'guest views for routes that do not exist').toEqual([]);
    for (const k of OPEN) expect(keys, `open route ${k} is still served`).toContain(k);
    expect(writes().length).toBeGreaterThan(45);
    expect(ownerOnlyGets().length).toBeGreaterThan(25);
  });
});

describe('refused before the handler', () => {
  it('WALK-2 anonymous: only the open routes reach a handler', async () => {
    const wrong: string[] = [];
    for (const r of all) {
      const res = await call(concrete(r.path), { method: r.method, ...body(r.method) });
      if (isOpen(r)) { if (res.status !== 599) wrong.push(`${r.method} ${r.path} (open) → ${res.status}`); continue; }
      if (res.status !== 401 || JSON.stringify(await res.json()) !== '{"error":"owner_required"}') wrong.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(hits.length).toBe(OPEN.length);
  });

  it('WALK-3 guest: every write answers 401 owner_required, and so does OPTIONS on any path', async () => {
    const wrong: string[] = [];
    for (const r of writes()) {
      const res = await call(concrete(r.path), { cookie: guest, method: r.method, ...body(r.method) });
      if (res.status !== 401 || JSON.stringify(await res.json()) !== '{"error":"owner_required"}') wrong.push(`${r.method} ${r.path} → ${res.status}`);
    }
    for (const p of new Set(all.filter(r => !isOpen(r)).map(r => concrete(r.path)))) {
      const res = await call(p, { cookie: guest, method: 'OPTIONS' }); if (res.status !== 401) wrong.push(`OPTIONS ${p} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('WALK-4 guest and owner-preview: every GET and HEAD without a guest view answers 401 owner_required', async () => {
    const wrong: string[] = [];
    for (const r of ownerOnlyGets()) for (const [who, cookie] of [['guest', guest], ['preview', preview]] as const) for (const method of ['GET', 'HEAD']) {
      const res = await call(concrete(r.path), { cookie, method });
      const ok = res.status === 401 && (method === 'HEAD' || JSON.stringify(await res.json()) === '{"error":"owner_required"}');
      if (!ok) wrong.push(`${method} ${r.path} as ${who} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('WALK-5 owner-preview changes reads only: a write still reaches its handler (so preview can be switched off)', async () => {
    const sample = writes().filter(r => r.path === '/api/auth/preview' || r.path === '/api/events');
    expect(sample.length).toBe(2);
    for (const r of sample) expect((await call(concrete(r.path), { cookie: preview, method: r.method, ...body(r.method) })).status, r.path).toBe(599);
    expect(hits.length).toBe(2);
  });
});

describe('RED-10 cross-check', () => {
  // the pinned list in tests/server/redaction.test.ts RED-10 (top-level app routes only; it cannot see app.use routers)
  const RED10 = ['/api/alerts', '/api/appliances/ac/strip', '/api/appliances/day', '/api/auth/devices', '/api/bills', '/api/breakdown', '/api/capacity', '/api/digest', '/api/export.csv', '/api/flows', '/api/loads', '/api/outage',
    '/api/pool/water', '/api/powerwall/rules', '/api/presence', '/api/push/key', '/api/share', '/api/site', '/api/spare', '/api/tesla/scopes', '/api/vacation', '/api/vacation/check', '/api/vacation/estimate', '/api/vacation/trips', '/auth/google', '/auth/login'];
  it('WALK-6 the walker\'s owner-only reads are RED-10\'s list plus the sub-router reads', () => {
    const subRouter = new Set(['/api/models', '/api/pvs/day', '/api/pvs/latest', '/api/pvs/layout']);
    const walked = ownerOnlyGets().map(r => r.path);
    expect(walked.filter(p => !subRouter.has(p)).sort()).toEqual(RED10);
    expect(walked.filter(p => subRouter.has(p)).sort()).toEqual([...subRouter].sort());
  });
});
