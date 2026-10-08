// Cookie hardening (2026-10-08): __Host- names in production with a silent migration from the bare names, and an absolute
// 400-day owner-session lifetime. Same harness as auth.test.ts. Owner gate (Phase 2 batch 1, "lock the door"): OWNER_KEY → a per-device owner_sessions row + the solstice_owner cookie.
// Every /api and /auth route is owner-only, reads included, except POST /api/auth/owner, GET /api/auth/me, the
// bearer-protected crons and the state-verified OAuth callbacks. Also: /api/admin/import and SETUP_TOKEN are gone.
//
// Self-contained, following docs/audit-designs/tests.md: the in-process Express app on 127.0.0.1:0 driven with the real
// fetch, PGlite in memory, no network (Tesla, Google/Nest and the Tesla sync are mocked below). Synthetic values only.
// It needs the REAL db.ts on PGlite, so when the Vitest harness lands, run it in the `db` project; if it stays under
// tests/server with the pure-mocks setup file, the vi.unmock below restores the real database module.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}),
}));
vi.mock('../../server/src/tesla/auth.js', async orig => ({
  ...(await orig<typeof import('../../server/src/tesla/auth.js')>()),
  authorizeUrl: (state: string) => `https://tesla.invalid/authorize?state=${encodeURIComponent(state)}`,
  exchangeCode: vi.fn(async () => 1),
}));
vi.mock('../../server/src/tesla/client.js', async orig => ({
  ...(await orig<typeof import('../../server/src/tesla/client.js')>()),
  teslaFor: () => ({ products: async () => [] }),
}));
vi.mock('../../server/src/appliances/nest.js', async orig => ({
  ...(await orig<typeof import('../../server/src/appliances/nest.js')>()),
  nestConfigured: () => true, nestLinked: async () => false,
  nestAuthorizeUrl: (state: string) => `https://nest.invalid/auth?state=${encodeURIComponent(state)}`,
  nestExchangeCode: vi.fn(async () => {}), readNest: vi.fn(async () => null),
}));

const KEY = 'test-owner-key-synthetic-abcdefghij-klmnopqrst';   // test-only, 46 chars
const CRON = 'test-cron-secret-synthetic';
let server: Server, base = '';
let db: typeof import('../../server/src/db.js');
let auth: typeof import('../../server/src/auth.js');
let teslaAuth: typeof import('../../server/src/tesla/auth.js');

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('auth tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, CRON_SECRET: CRON, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  auth = await import('../../server/src/auth.js');
  teslaAuth = await import('../../server/src/tesla/auth.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port); // the fetch guard in tests/setup.ts allows only registered in-process servers
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init;
  return fetch(base + path, { redirect: 'manual', ...rest, headers: { ...(cookie ? { cookie } : {}), ...(rest.headers as Record<string, string> ?? {}) } });
};
let ipN = 0;
const freshIp = () => `198.51.100.${++ipN}`;   // TEST-NET-2: a fresh rate-limit bucket for each unlock
const unlock = (key: string, ip = freshIp()) => call('/api/auth/owner', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify({ key }) });
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
async function ownerCookie() { const r = await unlock(KEY); expect(r.status).toBe(200); return cookieOf(r); }
const json = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });


const prod = async <T>(fn: () => Promise<T>) => { process.env.VERCEL = '1'; try { return await fn(); } finally { delete process.env.VERCEL; } };
const setCookies = (r: Response) => r.headers.getSetCookie();
const sessionId = (cookieValue: string) => cookieValue.slice(0, cookieValue.lastIndexOf('.'));

describe('cookie hardening', () => {
  it('CK-1 local development (plain http) keeps the bare names and no Secure', async () => {
    const r = await unlock(KEY);
    const [c] = setCookies(r);
    expect(c).toMatch(/^solstice_owner=[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
    expect(setCookies(r)).toHaveLength(1);
  });
  it('CK-2 production: the owner cookie is __Host-, Secure, Path=/, no Domain; the bare one is cleared in the same response', async () => {
    const r = await prod(() => unlock(KEY));
    const cs = setCookies(r);
    expect(cs[0]).toMatch(/^__Host-solstice_owner=[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure$/);
    expect(cs[1]).toBe('solstice_owner=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    expect(cs.join('\n')).not.toMatch(/Domain=/i);
  });
  it('CK-3 production: a device still holding the bare cookie stays signed in and is re-issued the __Host- one; with that, nothing is re-sent', async () => {
    const legacy = await ownerCookie();                       // issued before the prefix (the bare name)
    const value = legacy.split('=')[1];
    const r = await prod(() => call('/api/auth/me', { cookie: legacy }));
    expect((await r.json()).owner).toBe(true);
    expect(setCookies(r)[0]).toMatch(new RegExp(`^__Host-solstice_owner=${value.replace(/[.\-]/g, '\\$&')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`));
    expect(setCookies(r)[1]).toMatch(/^solstice_owner=; .*Max-Age=0/);
    const again = await prod(() => call('/api/auth/me', { cookie: `__Host-solstice_owner=${value}` }));
    expect((await again.json()).owner).toBe(true);
    expect(setCookies(again)).toEqual([]);
    // both present: the __Host- one is the one read (a stale bare cookie can't shadow it)
    const both = await prod(() => call('/api/auth/me', { cookie: `solstice_owner=bogus.value; __Host-solstice_owner=${value}` }));
    expect((await both.json()).owner).toBe(true);
  });
  it('CK-4 absolute expiry: a session older than 400 days is refused however recently it was used; a younger one counts down', async () => {
    const c = await ownerCookie(), id = sessionId(c.split('=')[1]);
    await db.q(`UPDATE owner_sessions SET created_at = now() - interval '401 days', last_seen = now() WHERE id = $1`, [id]);
    expect((await (await call('/api/auth/me', { cookie: c })).json()).owner).toBe(false);
    await db.q(`UPDATE owner_sessions SET created_at = now() - interval '399 days', last_seen = now() - interval '2 hours' WHERE id = $1`, [id]);
    const r = await call('/api/auth/me', { cookie: c });
    expect((await r.json()).owner).toBe(true);
    const age = Number(/Max-Age=(\d+)/.exec(setCookies(r)[0] ?? '')?.[1]);
    expect(age).toBeGreaterThan(86400 - 120); expect(age).toBeLessThanOrEqual(86400);   // one day left, not a fresh 400
  });
  it('CK-5 the guest and preview cookies get the prefix too; a bare guest cookie from before still works', async () => {
    const owner = await ownerCookie();
    const share = await (await call('/api/share', { method: 'POST', cookie: owner, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ label: 'ck', expiresIn: '24h' }) })).json();
    const g = await prod(() => call('/api/auth/guest', { method: 'POST', headers: { 'X-Real-IP': freshIp() }, body: JSON.stringify({ token: share.token }) }));
    expect(setCookies(g)[0]).toMatch(/^__Host-solstice_guest=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    const bare = await prod(() => call('/api/auth/me', { cookie: `solstice_guest=${share.token}` }));
    expect((await bare.json()).guest).toBe(true);
    const pv = await prod(() => call('/api/auth/preview', { method: 'POST', cookie: owner, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ on: true }) }));
    expect(setCookies(pv).some(c => /^__Host-solstice_preview=1; /.test(c))).toBe(true);
    await call(`/api/share/${share.id}/revoke`, { method: 'POST', cookie: owner, headers: { Origin: base } });
  });
});
