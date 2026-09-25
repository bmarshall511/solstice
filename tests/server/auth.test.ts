// Owner gate (Phase 2 batch 1, "lock the door"): OWNER_KEY → a per-device owner_sessions row + the solstice_owner cookie.
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

describe('owner gate', () => {
  it('AUTH-1 no cookie: reads and writes answer 401 owner_required, and the write never runs', async () => {
    for (const [path, init] of [['/api/settings', {}], ['/API/Settings/', {}], ['/api/bills', {}], ['/api/export.csv', {}], ['/api/now', {}], ['/api/auth/devices', {}],
      ['/api/settings', json({ calm: true })], ['/api/appliances/pool/apply', { method: 'POST' }], ['/api/appliances/ac/settings', { ...json({ presence: 'away' }), method: 'POST' }],
      ['/api/bills/2026-08-01', { method: 'DELETE' }], ['/api/auth/signout', { method: 'POST' }], ['/auth/login', {}], ['/auth/google', {}]] as const) {
      const r = await call(path, init as RequestInit);
      expect(r.status, `${(init as RequestInit).method ?? 'GET'} ${path}`).toBe(401);
      expect(await r.json()).toEqual({ error: 'owner_required' });
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(await db.kv.get('settings:owner')).toBeUndefined();
  });

  it('AUTH-2 /api/auth/me tells a non-owner the mode and nothing else', async () => {
    const r = await call('/api/auth/me');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mode: 'single', owner: false });
  });

  it('AUTH-3 wrong keys: 401, no cookie, and every failure takes the same fixed time', async () => {
    const took: number[] = [];
    for (const key of ['', 'x', KEY.slice(0, -1), KEY + 'x', 'y'.repeat(KEY.length), KEY.toUpperCase()]) {
      const t0 = performance.now(), r = await unlock(key);
      took.push(performance.now() - t0);
      expect(r.status).toBe(401);
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(await r.json()).toEqual({ error: 'invalid_owner_key' });
    }
    expect(Math.min(...took)).toBeGreaterThanOrEqual(480);          // FAIL_MS = 500 in app.ts
    expect(Math.max(...took) - Math.min(...took)).toBeLessThan(150);
    const bad = await call('/api/auth/owner', { method: 'POST', headers: { 'X-Real-IP': freshIp() }, body: '{not json' });
    expect(bad.status).toBe(401);
  });

  it('AUTH-4 rate limit: the sixth attempt in a minute from one IP gets 429, even with the right key', async () => {
    const ip = freshIp();
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => unlock('nope', ip)))).map(r => r.status);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    const sixth = await unlock(KEY, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('set-cookie')).toBeNull();
    expect((await unlock(KEY)).status).toBe(200);                    // another IP is unaffected
  });

  it('AUTH-5 right key → HttpOnly cookie → reads and writes work; a tampered cookie does not', async () => {
    const r = await unlock(KEY);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const setCookie = r.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^solstice_owner=[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/);   // no Secure outside production
    const cookie = cookieOf(r);
    expect((await call('/api/settings', { cookie })).status).toBe(200);
    expect((await call('/api/settings', { cookie, ...json({ calm: true }) })).status).toBe(200);
    expect(await (await call('/api/settings', { cookie })).json()).toEqual({ calm: true, location: null });   // GET adds the site location (none in tests)
    expect(await (await call('/api/auth/me', { cookie })).json()).toEqual({ mode: 'single', owner: true, user: null, site: { id: 's', name: 'Test home' } });
    const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
    expect((await call('/api/settings', { cookie: tampered })).status).toBe(401);
    expect((await call('/api/settings', { cookie: 'solstice_owner=' + cookie.split('=')[1].split('.')[0] })).status).toBe(401);  // id without its HMAC

    process.env.NODE_ENV = 'production';
    try { expect((await unlock(KEY)).headers.get('set-cookie')).toMatch(/; Secure$/); } finally { process.env.NODE_ENV = 'test'; }
  });

  it('AUTH-6 an owner write from another site is refused even with the cookie', async () => {
    const cookie = await ownerCookie();
    const r = await call('/api/settings', { cookie, ...json({ calm: false }), headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } });
    expect(r.status).toBe(403);
    expect(await (await call('/api/settings', { cookie })).json()).toMatchObject({ calm: true });
  });

  it('AUTH-7 devices: list, sign out the others, sign out this one', async () => {
    await db.q('DELETE FROM owner_sessions');
    const a = await ownerCookie(), b = await ownerCookie();
    const list = await (await call('/api/auth/devices', { cookie: a })).json();
    expect(list).toHaveLength(2);
    expect(list.filter((d: any) => d.current)).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'current', 'id', 'label', 'lastSeen']);
    expect(list[0].id).toHaveLength(6);                                  // a prefix, never the whole session id
    expect(await (await call('/api/auth/signout-others', { cookie: a, method: 'POST' })).json()).toEqual({ ok: true, signedOut: 1 });
    expect((await call('/api/settings', { cookie: b })).status).toBe(401);
    const out = await call('/api/auth/signout', { cookie: a, method: 'POST' });
    expect(out.headers.get('set-cookie')).toMatch(/^solstice_owner=; .*Max-Age=0/);
    expect((await call('/api/settings', { cookie: a })).status).toBe(401);
  });

  it('AUTH-8 last_seen (and the cookie) move at most once an hour', async () => {
    const cookie = await ownerCookie(), id = cookie.split('=')[1].split('.')[0];
    await db.q(`UPDATE owner_sessions SET last_seen = now() - interval '2 hours' WHERE id = $1`, [id]);
    const slid = await call('/api/settings', { cookie });
    expect(slid.headers.get('set-cookie')).toMatch(/Max-Age=34560000/);
    expect((await db.one(`SELECT last_seen > now() - interval '1 minute' AS fresh FROM owner_sessions WHERE id = $1`, [id]))!.fresh).toBe(true);
    expect((await call('/api/settings', { cookie })).headers.get('set-cookie')).toBeNull();
    await db.q(`UPDATE owner_sessions SET last_seen = now() - interval '401 days' WHERE id = $1`, [id]);
    expect((await call('/api/settings', { cookie })).status).toBe(401);  // server-side expiry, whatever the browser keeps
  });
});

describe('crons keep their bearer check and need no cookie', () => {
  it('AUTH-9 right bearer → the cron runs; wrong or missing bearer → the route\'s own 401', async () => {
    const auth = { authorization: `Bearer ${CRON}` };
    const sync = await call('/api/cron/sync', { headers: auth });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ s: { mocked: true } });
    // the 5-minute cron decides by the clock what is due (sampling.ts): pin it to a due tick, 10:00 CDT in cooling season
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-07-15T15:00:00Z') });
    const nest = await call('/api/cron/nest', { headers: auth }).finally(() => vi.useRealTimers());
    expect(nest.status).toBe(200);
    expect(await nest.json()).toEqual({ s: { nest: { skipped: 'nest not linked' }, pool: { skipped: 'pool not configured' } } });
    for (const headers of [{ authorization: 'Bearer wrong' }, {}] as Array<Record<string, string>>) {
      const r = await call('/api/cron/sync', { headers });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });   // the cron's own message: the owner gate let it through
    }
  });
});

describe('OAuth links: minted only by the owner, callbacks verify a signed single-use state', () => {
  const stateOf = (r: Response) => new URL(r.headers.get('location')!).searchParams.get('state')!;

  it('AUTH-10 Tesla: owner starts, the callback works without a cookie once, and refuses replays and forgeries', async () => {
    const cookie = await ownerCookie();
    const start = await call('/auth/login', { cookie });
    expect(start.status).toBe(302);
    const state = stateOf(start);
    const cb = await call(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/');
    expect(teslaAuth.exchangeCode).toHaveBeenCalledWith('test-code', null);
    const replay = await call(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`);
    expect(replay.headers.get('location')).toBe('/?tesla_error=Sign-in+expired.+Try+again.');
    const body = state.slice(0, state.lastIndexOf('.'));
    for (const forged of [`${body}.AAAA`, `owner.tesla.${Date.now() + 60_000}.00.x`, auth.signState(0), auth.signOwnerState('tesla', -1000), auth.signOwnerState('nest', 60_000), '']) {
      const r = await call(`/auth/callback?code=test-code&state=${encodeURIComponent(forged)}`);
      expect(r.headers.get('location'), forged).toBe('/?tesla_error=Sign-in+expired.+Try+again.');
    }
    expect(teslaAuth.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('AUTH-11 Nest: the same rules on /auth/google', async () => {
    const cookie = await ownerCookie();
    const start = await call('/auth/google', { cookie });
    expect(start.status).toBe(302);
    const state = stateOf(start);
    const cb = await call(`/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`);
    expect(cb.headers.get('location')).toBe('/?nest=linked');
    expect((await call(`/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`)).headers.get('location')).toBe('/?nest_error=bad+state');
    const tesla = stateOf(await call('/auth/login', { cookie }));   // a Tesla state is not a Nest state
    for (const forged of [tesla, `owner.nest.${Date.now() + 60_000}.00.x`, auth.signState(0, 60_000), auth.signOwnerState('nest', -1000)]) {
      expect((await call(`/auth/google/callback?code=test-code&state=${encodeURIComponent(forged)}`)).headers.get('location'), forged).toBe('/?nest_error=bad+state');
    }
  });
});

describe('fail closed', () => {
  it('AUTH-12 OWNER_KEY unset or short → the unlock is 503 and every cookie is refused; a new key signs every device out', async () => {
    const cookie = await ownerCookie();
    try {
      for (const value of [undefined, 'short-key']) {
        if (value === undefined) delete process.env.OWNER_KEY; else process.env.OWNER_KEY = value;
        const r = await unlock(KEY);
        expect(r.status).toBe(503);
        expect(r.headers.get('set-cookie')).toBeNull();
        expect((await call('/api/settings', { cookie })).status).toBe(401);
        expect((await call('/api/settings', { cookie, ...json({ calm: false }) })).status).toBe(401);
        expect(await (await call('/api/auth/me', { cookie })).json()).toEqual({ mode: 'single', owner: false });
        expect((await call('/auth/login', { cookie })).status).toBe(401);
      }
      process.env.OWNER_KEY = KEY.replace('owner', 'other');          // rotation
      expect((await call('/api/settings', { cookie })).status).toBe(401);
    } finally { process.env.OWNER_KEY = KEY; }
    expect((await call('/api/settings', { cookie })).status).toBe(200);
  });
});

describe('the one-time import route and SETUP_TOKEN are gone', () => {
  it('AUTH-13 /api/admin/import and /api/auth/setup: 401 without the cookie, 404 with it', async () => {
    const cookie = await ownerCookie();
    for (const path of ['/api/admin/import', '/api/auth/setup']) {
      expect((await call(path, { method: 'POST', headers: { authorization: 'Bearer anything' } })).status).toBe(401);
      expect((await call(path, { method: 'POST', cookie })).status).toBe(404);
    }
  });

  it('AUTH-14 no server code reads SETUP_TOKEN or serves /api/admin/import', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = `${dir}/${f}`; return statSync(p).isDirectory() ? files(p) : [p]; });
    const root = fileURLToPath(new URL('../../', import.meta.url));
    for (const f of [...files(root + 'server/src'), ...files(root + 'api'), ...files(root + 'web/src')]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/SETUP_TOKEN|admin\/import/);
    }
  });
});
