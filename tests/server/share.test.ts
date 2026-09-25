// Guest share links (Phase 2, share view, server side; docs/audit-designs/share-view.md §2): the access_tokens table,
// the owner's create / list / revoke / revoke-all routes, the #s=<token> → solstice_guest cookie exchange, expiry,
// pruning, "the owner cookie always wins", and the owner's preview-as-a-guest flag.
//
// Self-contained, following docs/audit-designs/tests.md and tests/server/auth.test.ts: the in-process Express app on
// 127.0.0.1:0 driven with the real fetch, PGlite in memory, no network (the Tesla sync is mocked). Synthetic values only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}),
}));

const KEY = 'test-owner-key-synthetic-share-abcdefghij-klm';   // test-only
const CRON = 'test-cron-secret-synthetic-share';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('share tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, CRON_SECRET: CRON, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  await db.kv.set('settings:owner', { calm: true, alerts: { solar: false } });
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port); // the fetch guard in tests/setup.ts allows only registered in-process servers
  base = `http://127.0.0.1:${port}`;
  owner = await ownerCookie();
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie, json, ...rest } = init;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers as Record<string, string> ?? {}) };
  return fetch(base + path, { redirect: 'manual', ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const setCookies = (r: Response) => r.headers.getSetCookie();
const cookieNamed = (r: Response, name: string) => setCookies(r).find(c => c.startsWith(`${name}=`)) ?? null;
const pair = (setCookie: string | null) => (setCookie ?? '').split(';')[0];
const both = (...cookies: string[]) => cookies.filter(Boolean).join('; ');
let ipN = 0;
const freshIp = () => `203.0.113.${++ipN}`;   // TEST-NET-3: a fresh rate-limit bucket for each exchange
async function ownerCookie() {
  const r = await call('/api/auth/owner', { json: { key: KEY }, headers: { 'X-Real-IP': freshIp() } });
  expect(r.status).toBe(200);
  return pair(cookieNamed(r, 'solstice_owner'));
}
async function createLink(body: Record<string, unknown> = { label: 'Dad' }) {
  const r = await call('/api/share', { cookie: owner, json: body });
  expect(r.status).toBe(200);
  return r.json() as Promise<{ id: string; token: string; label: string; createdAt: string; expiresAt: string | null; fragment: string; url: string }>;
}
const redeem = (token: unknown, o: { ip?: string; ua?: string; cookie?: string } = {}) =>
  call('/api/auth/guest', { json: { token }, cookie: o.cookie, headers: { 'X-Real-IP': o.ip ?? freshIp(), ...(o.ua ? { 'User-Agent': o.ua } : {}) } });
async function guestCookie(token: string) { const r = await redeem(token); expect(r.status).toBe(200); return pair(cookieNamed(r, 'solstice_guest')); }
const me = async (cookie?: string) => (await call('/api/auth/me', { cookie })).json();
const row = (id: string) => db.one('SELECT * FROM access_tokens WHERE id = $1', [id]);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY = 864e5;

describe('creating links', () => {
  it('SHARE-1 POST /api/share returns the token once; only its SHA-256 is stored', async () => {
    const t0 = Date.now(), s = await createLink({ label: '  Dad  ' });
    expect(Object.keys(s).sort()).toEqual(['createdAt', 'expiresAt', 'fragment', 'id', 'label', 'token', 'url']);
    expect(s.id).toMatch(/^[\w-]{8}$/);
    expect(s.token).toMatch(/^[\w-]{32}$/);                                  // 24 random bytes, base64url
    expect(s.label).toBe('Dad');                                             // trimmed
    expect(s.fragment).toBe(`#s=${s.token}`);
    expect(s.url).toBe(`${base}/#s=${s.token}`);
    expect(Date.parse(s.expiresAt!) - t0).toBeGreaterThan(30 * DAY - 60_000); // the default is 30 days
    expect(Date.parse(s.expiresAt!) - t0).toBeLessThan(30 * DAY + 60_000);
    const stored = await row(s.id);
    expect(stored!.token_hash).toBe(sha(s.token));
    expect(JSON.stringify(stored)).not.toContain(s.token);                  // the plaintext is nowhere in the row
    expect(stored).toMatchObject({ label: 'Dad', revoked_at: null, opened_count: 0, last_opened_at: null, last_ua: null });
  });

  it('SHARE-2 expiry choices 24h / 7d / 30d / 1yr / never; bad bodies are refused', async () => {
    for (const [expiresIn, days] of [['24h', 1], ['7d', 7], ['30d', 30], ['1yr', 365]] as const) {
      const t0 = Date.now(), s = await createLink({ label: `x ${expiresIn}`, expiresIn });
      expect(Math.abs(Date.parse(s.expiresAt!) - t0 - days * DAY), expiresIn).toBeLessThan(60_000);
    }
    expect((await createLink({ label: 'Forever', expiresIn: 'never' })).expiresAt).toBeNull();
    for (const body of [{ label: 'x', expiresIn: '2d' }, { label: 'x', expiresIn: 30 }, { label: 'x', expiresIn: 'toString' }, {}, { label: '' }, { label: '   ' },
      { label: 'x'.repeat(41) }, { label: 42 }]) {
      const r = await call('/api/share', { cookie: owner, json: body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('SHARE-3 GET /api/share lists every link for the owner, never a token or a hash', async () => {
    const s = await createLink({ label: 'Listed' });
    const list = await (await call('/api/share', { cookie: owner })).json();
    const mine = list.find((x: any) => x.id === s.id);
    expect(Object.keys(mine).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'label', 'lastOpenedAt', 'lastUa', 'openedCount', 'revokedAt', 'state']);
    expect(mine).toMatchObject({ label: 'Listed', state: 'active', openedCount: 0, revokedAt: null, lastOpenedAt: null, lastUa: null });
    const text = JSON.stringify(list);
    expect(text).not.toContain(s.token);
    expect(text).not.toMatch(/[0-9a-f]{64}/);                                // no SHA-256 hex anywhere
    expect(list.map((x: any) => x.createdAt)).toEqual([...list.map((x: any) => x.createdAt)].sort().reverse());   // newest first
  });
});

describe('opening a link', () => {
  it('SHARE-4 the token becomes an HttpOnly solstice_guest cookie that lives until the link expires; the open is counted', async () => {
    const s = await createLink({ label: 'Neighbor', expiresIn: '7d' });
    const r = await redeem(s.token, { ua: IPHONE });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, guest: true, expiresAt: s.expiresAt });
    const c = cookieNamed(r, 'solstice_guest')!;
    expect(c).toMatch(new RegExp(`^solstice_guest=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=(\\d+)$`));   // no Secure outside production
    expect(Math.abs(Number(/Max-Age=(\d+)/.exec(c)![1]) - 7 * 86400)).toBeLessThan(60);
    expect(await row(s.id)).toMatchObject({ opened_count: 1, last_ua: 'iPhone Safari' });   // the family only, never the raw User-Agent
    expect((await row(s.id))!.last_opened_at).not.toBeNull();
    await redeem(s.token, { ua: 'curl/8.0' });
    expect(await row(s.id)).toMatchObject({ opened_count: 2, last_ua: 'Device curl' });

    const guest = pair(c);
    const who = await call('/api/auth/me', { cookie: guest });
    expect(await who.json()).toEqual({ mode: 'single', owner: false, guest: true, label: null });   // never the label
    expect((await call('/api/now', { cookie: guest })).status).toBe(200);

    const never = await createLink({ label: 'Always', expiresIn: 'never' });
    expect(cookieNamed(await redeem(never.token), 'solstice_guest')).toMatch(/; Max-Age=34560000$/);   // 400 days
    process.env.NODE_ENV = 'production';
    try { expect(cookieNamed(await redeem(never.token), 'solstice_guest')).toMatch(/; Secure$/); } finally { process.env.NODE_ENV = 'test'; }
  });

  it('SHARE-5 unknown tokens and bodies: 401 with no cookie; five failures from one IP in a minute → 429', async () => {
    for (const token of ['', 'x', 'y'.repeat(32), 'z'.repeat(500), null, { a: 1 }]) {
      const r = await redeem(token);
      expect(r.status, JSON.stringify(token)).toBe(401);
      expect(await r.json()).toEqual({ error: 'invalid_share', reason: 'unknown' });
      expect(cookieNamed(r, 'solstice_guest')).toBeNull();
    }
    const bad = await call('/api/auth/guest', { method: 'POST', body: '{not json', headers: { 'X-Real-IP': freshIp() } });
    expect(bad.status).toBe(401);
    const s = await createLink({ label: 'Limited' }), ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await redeem('nope', { ip })).status).toBe(401);
    expect((await redeem(s.token, { ip })).status).toBe(429);                // even the right token, from that IP
    expect((await redeem(s.token)).status).toBe(200);                        // another IP is unaffected
  });
});

describe('revoking and expiry', () => {
  it('SHARE-6 revoke takes effect on the next request; the link stays listed as revoked', async () => {
    const s = await createLink({ label: 'Revoke me' }), guest = await guestCookie(s.token);
    expect((await call('/api/now', { cookie: guest })).status).toBe(200);
    const r = await call(`/api/share/${s.id}/revoke`, { cookie: owner, method: 'POST' });
    expect(await r.json()).toEqual({ ok: true, id: s.id });
    const next = await call('/api/now', { cookie: guest });
    expect(next.status).toBe(401);
    expect(await next.json()).toEqual({ error: 'owner_required' });
    expect(await me(guest)).toEqual({ mode: 'single', owner: false, reason: 'revoked' });
    const again = await redeem(s.token);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'invalid_share', reason: 'revoked' });
    expect((await call(`/api/share/${s.id}/revoke`, { cookie: owner, method: 'POST' })).status).toBe(404);   // already revoked
    expect((await call('/api/share/nope/revoke', { cookie: owner, method: 'POST' })).status).toBe(404);
    const listed = (await (await call('/api/share', { cookie: owner })).json()).find((x: any) => x.id === s.id);
    expect(listed.state).toBe('revoked');
    expect(listed.revokedAt).not.toBeNull();
  });

  it('SHARE-7 an expired link opens nothing, whatever the browser still holds', async () => {
    const s = await createLink({ label: 'Short', expiresIn: '24h' }), guest = await guestCookie(s.token);
    await db.q(`UPDATE access_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
    expect((await call('/api/now', { cookie: guest })).status).toBe(401);
    expect(await me(guest)).toEqual({ mode: 'single', owner: false, reason: 'expired' });
    const again = await redeem(s.token);
    expect(await again.json()).toEqual({ error: 'invalid_share', reason: 'expired' });
    expect((await (await call('/api/share', { cookie: owner })).json()).find((x: any) => x.id === s.id).state).toBe('expired');
  });

  it('SHARE-8 revoke-all turns every link off at once', async () => {
    const a = await createLink({ label: 'A' }), b = await createLink({ label: 'B', expiresIn: 'never' });
    const ga = await guestCookie(a.token), gb = await guestCookie(b.token);
    const live = Number((await db.one(`SELECT COUNT(*)::int n FROM access_tokens WHERE revoked_at IS NULL`))!.n);
    const r = await call('/api/share/revoke-all', { cookie: owner, method: 'POST' });
    expect(await r.json()).toEqual({ ok: true, revoked: live });
    for (const g of [ga, gb]) expect((await call('/api/now', { cookie: g })).status).toBe(401);
    expect((await (await call('/api/share', { cookie: owner })).json()).every((x: any) => x.state === 'revoked')).toBe(true);
    expect(await (await call('/api/share/revoke-all', { cookie: owner, method: 'POST' })).json()).toEqual({ ok: true, revoked: 0 });
  });

  it('SHARE-9 revoked and expired links leave the list after 30 days (on list and in the nightly cron)', async () => {
    const old = await createLink({ label: 'Old' }), recent = await createLink({ label: 'Recent' }), stale = await createLink({ label: 'Stale', expiresIn: '24h' });
    const cron = await createLink({ label: 'Cron' });
    await db.q(`UPDATE access_tokens SET revoked_at = now() - interval '31 days' WHERE id = $1`, [old.id]);
    await db.q(`UPDATE access_tokens SET revoked_at = now() - interval '29 days' WHERE id = $1`, [recent.id]);
    await db.q(`UPDATE access_tokens SET expires_at = now() - interval '31 days' WHERE id = $1`, [stale.id]);
    const ids = (await (await call('/api/share', { cookie: owner })).json()).map((x: any) => x.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(stale.id);
    expect(await row(old.id)).toBeUndefined();
    await db.q(`UPDATE access_tokens SET revoked_at = now() - interval '40 days' WHERE id = $1`, [cron.id]);
    const sync = await call('/api/cron/sync', { headers: { authorization: `Bearer ${CRON}` } });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ s: { mocked: true } });              // the cron's output is unchanged
    expect(await row(cron.id)).toBeUndefined();
  });
});

describe('the owner and the guest on one device', () => {
  it('SHARE-10 the owner cookie always wins over a guest cookie', async () => {
    const s = await createLink({ label: 'Mine' }), guest = await guestCookie(s.token), both2 = both(guest, owner);
    expect(await me(both2)).toMatchObject({ mode: 'single', owner: true });
    const settings = await (await call('/api/settings', { cookie: both2 })).json();
    expect(settings).toMatchObject({ calm: true, alerts: { solar: false } });   // the owner's settings, not the guest's view
    expect((await call('/api/share', { cookie: both2 })).status).toBe(200);
    expect(await (await call('/api/settings', { cookie: guest })).json()).toEqual({ location: null });   // the guest alone: the view
  });

  it('SHARE-11 guests cannot create, list or revoke links, or switch preview on', async () => {
    const s = await createLink({ label: 'Guesty' }), guest = await guestCookie(s.token);
    for (const [path, init] of [['/api/share', { json: { label: 'mine now' } }], ['/api/share', {}], [`/api/share/${s.id}/revoke`, { method: 'POST' }],
      ['/api/share/revoke-all', { method: 'POST' }], ['/api/auth/preview', { json: { on: true } }]] as const) {
      const r = await call(path, { ...(init as Init), cookie: guest });
      expect(r.status, `${(init as Init).method ?? ((init as Init).json ? 'POST' : 'GET')} ${path}`).toBe(401);
      expect(cookieNamed(r, 'solstice_preview')).toBeNull();
    }
    expect((await row(s.id))!.revoked_at).toBeNull();
    expect(Number((await db.one(`SELECT COUNT(*)::int n FROM access_tokens WHERE label = 'mine now'`))!.n)).toBe(0);
  });
});

describe('preview as a guest (owner only)', () => {
  it('SHARE-12 the flag: a short-lived HttpOnly cookie; reads are served as a guest\'s, writes stay the owner\'s', async () => {
    const on = await call('/api/auth/preview', { cookie: owner, json: { on: true } });
    expect(await on.json()).toEqual({ ok: true, preview: true });
    const c = cookieNamed(on, 'solstice_preview')!;
    expect(c).toBe('solstice_preview=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
    const previewing = both(owner, pair(c));
    expect(await me(previewing)).toEqual({ mode: 'single', owner: false, guest: true, label: null, preview: true });
    const s = await createLink({ label: 'Compare' }), guest = await guestCookie(s.token);
    for (const path of ['/api/settings', '/api/daily?days=30', '/api/reconcile', '/api/status'])
      expect(await (await call(path, { cookie: previewing })).json(), path).toEqual(await (await call(path, { cookie: guest })).json());
    for (const path of ['/api/share', '/api/bills', '/api/site', '/api/export.csv', '/api/auth/devices']) {
      const r = await call(path, { cookie: previewing });
      expect(r.status, path).toBe(401);                                       // owner-only reads are refused, as for a guest
    }
    expect((await call('/api/settings', { cookie: previewing, method: 'PUT', json: { calm: false } })).status).toBe(200);   // a write: still the owner
    expect(await (await call('/api/settings', { cookie: owner })).json()).toMatchObject({ calm: false });
    const off = await call('/api/auth/preview', { cookie: previewing, json: { on: false } });
    expect(await off.json()).toEqual({ ok: true, preview: false });
    expect(cookieNamed(off, 'solstice_preview')).toBe('solstice_preview=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect(await me(owner)).toMatchObject({ owner: true });
    for (const body of [{ on: 'yes' }, {}, { on: 1 }]) expect((await call('/api/auth/preview', { cookie: owner, json: body })).status).toBe(400);
  });

  it('SHARE-13 the flag never escalates: a guest or a stranger holding it is exactly what they were', async () => {
    const s = await createLink({ label: 'Forged' }), guest = await guestCookie(s.token), forged = 'solstice_preview=1';
    expect(await me(both(guest, forged))).toEqual({ mode: 'single', owner: false, guest: true, label: null });
    expect((await call('/api/share', { cookie: both(guest, forged) })).status).toBe(401);
    expect(await me(forged)).toEqual({ mode: 'single', owner: false });
    expect((await call('/api/now', { cookie: forged })).status).toBe(401);
  });

  it('SHARE-14 opening the owner link again clears a preview on that device', async () => {
    const on = await call('/api/auth/preview', { cookie: owner, json: { on: true } }), previewing = both(owner, pair(cookieNamed(on, 'solstice_preview')));
    const unlock = await call('/api/auth/owner', { cookie: previewing, json: { key: KEY }, headers: { 'X-Real-IP': freshIp() } });
    expect(unlock.status).toBe(200);
    expect(cookieNamed(unlock, 'solstice_preview')).toMatch(/^solstice_preview=; .*Max-Age=0/);
  });
});

describe('caching', () => {
  it('SHARE-15 every response is no-store and varies on Cookie, for the owner, a guest and a stranger', async () => {
    const s = await createLink({ label: 'Cache' }), guest = await guestCookie(s.token);
    for (const cookie of [owner, guest, '']) for (const path of ['/api/now', '/api/auth/me', '/api/bills', '/api/nope']) {
      const r = await call(path, { cookie });
      expect(r.headers.get('cache-control'), `${cookie.split('=')[0]} ${path}`).toBe('no-store');
      expect(r.headers.get('vary') ?? '', `${cookie.split('=')[0]} ${path}`).toMatch(/\bCookie\b/i);
    }
  });
});
