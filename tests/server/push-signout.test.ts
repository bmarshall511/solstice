// S-04: Web Push subscriptions belong to the owner session (device) that made them. Signing a device out (this device, one other
// device, or every other device) deletes its subscriptions; fanOut skips and deletes any whose session is gone; a subscription
// stored before the column existed (NULL session) keeps receiving. Also POST /api/auth/signout itself: it ends this session and
// clears the solstice_owner cookie. In-process app on PGlite; sendPush is mocked (nothing leaves the process); values synthetic.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createECDH, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}),
}));
const sent: string[] = [];
vi.mock('../../server/src/push.js', async orig => ({
  ...(await orig<typeof import('../../server/src/push.js')>()),
  sendPush: vi.fn(async (sub: { endpoint: string }) => { sent.push(sub.endpoint); return { ok: true }; }),
}));

const KEY = 'test-owner-key-synthetic-pushsignout-abcdefgh';   // test-only
let server: Server, base = '';
let db: typeof import('../../server/src/db.js');
let N: typeof import('../../server/src/notify.js');
let ipN = 0;

type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie, json, ...rest } = init;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers as Record<string, string> ?? {}) };
  return fetch(base + path, { redirect: 'manual', ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const ownerSetCookie = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? null;
async function newDevice() {
  const r = await call('/api/auth/owner', { json: { key: KEY }, headers: { 'X-Real-IP': `198.51.100.${++ipN}` } });
  expect(r.status).toBe(200);
  return ownerSetCookie(r)!.split(';')[0];
}
const sub = (name: string) => ({ endpoint: `https://web.push.apple.com/test-${name}`, keys: { p256dh: (() => { const e = createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey('base64url'); })(), auth: randomBytes(16).toString('base64url') } });
const subscribe = async (cookie: string, name: string) => { const s = sub(name); expect((await call('/api/push/subscribe', { cookie, json: s })).status).toBe(200); return s.endpoint; };
const endpoints = async () => (await db.q<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions ORDER BY endpoint')).map(r => r.endpoint);
const shortId = (cookie: string) => cookie.split('=')[1].slice(0, 6);

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('push sign-out tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  N = await import('../../server/src/notify.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  await db.kv.set('settings:owner', {});
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => { sent.length = 0; await db.q('DELETE FROM push_subscriptions'); await db.q('DELETE FROM alerts'); });

let n = 0;
const alert = () => N.notify('s', 'anomaly', `Test alert ${++n}`, 'synthetic', {}, { key: `push-signout-${n}` });

describe('S-04 push subscriptions follow the owner session', () => {
  it('PS-1 subscribe stores the session; signing device A out from device B stops and deletes A’s subscription; a NULL-session row still receives', async () => {
    const a = await newDevice(), b = await newDevice();
    const epA = await subscribe(a, 'a'), epB = await subscribe(b, 'b');
    const stored = await db.one<{ owner_session_id: string }>('SELECT owner_session_id FROM push_subscriptions WHERE endpoint = $1', [epA]);
    expect(stored!.owner_session_id.slice(0, 6)).toBe(shortId(a));
    // a phone that subscribed before the column existed
    const legacy = sub('legacy');
    await db.q(`INSERT INTO push_subscriptions (endpoint, site_id, p256dh, auth) VALUES ($1, 's', $2, $3)`, [legacy.endpoint, legacy.keys.p256dh, legacy.keys.auth]);

    expect((await call(`/api/auth/devices/${shortId(a)}/signout`, { cookie: b, method: 'POST' })).status).toBe(200);
    expect(await endpoints()).toEqual([epB, legacy.endpoint].sort());
    const r = await alert();
    expect(r.pushed).toBe(2);
    expect(sent.sort()).toEqual([epB, legacy.endpoint].sort());
    expect(sent).not.toContain(epA);
  });

  it('PS-2 fanOut skips and deletes a subscription whose session row is gone', async () => {
    const a = await newDevice(), epA = await subscribe(a, 'orphan');
    await db.q('DELETE FROM owner_sessions WHERE left(id, 6) = $1', [shortId(a)]);   // the session went some other way
    const r = await alert();
    expect(sent).not.toContain(epA);
    expect(r.pruned).toBe(1);
    expect(await endpoints()).not.toContain(epA);
  });

  it('PS-3 POST /api/auth/signout ends this session, clears the owner cookie and removes this device’s subscriptions', async () => {
    const a = await newDevice(), b = await newDevice();
    const epA = await subscribe(a, 'self'), epB = await subscribe(b, 'other');
    const r = await call('/api/auth/signout', { cookie: a, method: 'POST' });
    expect(r.status).toBe(200);
    expect(ownerSetCookie(r)).toMatch(/^solstice_owner=;.*Max-Age=0/);
    expect(await db.one('SELECT 1 FROM owner_sessions WHERE left(id, 6) = $1', [shortId(a)])).toBeUndefined();
    expect((await call('/api/push/key', { cookie: a })).status).toBe(401);                 // the old cookie no longer opens anything
    expect(await endpoints()).toEqual([epB]);
    expect(epA).not.toBe(epB);
  });

  it('PS-4 "sign out every other device" removes their subscriptions and keeps this one’s', async () => {
    const a = await newDevice(), b = await newDevice(), c = await newDevice();
    const epA = await subscribe(a, 'keep'); await subscribe(b, 'b2'); await subscribe(c, 'c2');
    const r = await (await call('/api/auth/signout-others', { cookie: a, method: 'POST' })).json();
    expect(r.signedOut).toBeGreaterThanOrEqual(2);
    expect(await endpoints()).toEqual([epA]);
  });
});
