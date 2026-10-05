// The alerts feed, Web Push and the watches that feed them (server/src/notify.ts, push.ts, watch.ts; enhancements N0/N1).
//   ALR-1..3  push crypto: the RFC 8291 worked example byte for byte, a VAPID JWT that verifies, subscription checks
//   ALR-4..8  notify(): stored + fanned out to a mocked push service (decrypted here), gone endpoints pruned, the owner's switches,
//             dedupe by key, the per-kind push limit, no VAPID keys
//   ALR-9..10 the routes: feed, read, key, subscribe/unsubscribe (owner cookie); anonymous is refused
//   ALR-11..14 the watches: bill due, NWS storm + Storm Watch edge, the ERCOT level edge, anomalies from the nightly rules
// In-process app on 127.0.0.1:0, PGlite in memory. The push service is a fake answering inside the fetch guard (tests/setup.ts);
// NWS and ERCOT are read from seeded kv caches, never fetched. Every key and value is synthetic, generated per run.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { PEC_BILL } from '../fixtures/pec-bill.js';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => false),
}));

const KEY = 'test-owner-key-synthetic-alerts-abcdefghij-kl';   // test-only
const PUSH = 'https://web.push.apple.com/';                     // the fake push service (allow-listed host, answered below)
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let N: typeof import('../../server/src/notify.js');
let P: typeof import('../../server/src/push.js');
let W: typeof import('../../server/src/watch.js');

/* ---------- a fake push service inside the fetch guard ---------- */
const pushed: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
let status: (url: string) => number = () => 201;
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.startsWith(PUSH)) {
    pushed.push({ url: u, headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: Buffer.from(init!.body as Uint8Array) });
    return new Response(null, { status: status(u) });
  }
  return guard(input as any, init);
});

/** A browser's subscription: its own ECDH key pair and auth secret, so the test can decrypt what it receives. */
function browser(path: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, sub: { endpoint: PUSH + path, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } } };
}
/** RFC 8291 receiver side. */
function decrypt(body: Buffer, b: ReturnType<typeof browser>) {
  const salt = body.subarray(0, 16), idlen = body[20], as = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  expect(body.readUInt32BE(16)).toBe(4096);
  const ikm = Buffer.from(hkdfSync('sha256', b.ecdh.computeSecret(as), b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), as]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  expect(pt.at(-1)).toBe(2);
  return JSON.parse(pt.subarray(0, -1).toString());
}
function setVapid() {
  const v = createECDH('prime256v1'); v.generateKeys();
  Object.assign(process.env, { VAPID_PUBLIC_KEY: v.getPublicKey('base64url'), VAPID_PRIVATE_KEY: v.getPrivateKey('base64url'), VAPID_SUBJECT: 'mailto:alerts@example.test' });
}

type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie, json, ...rest } = init;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers as Record<string, string> ?? {}) };
  return fetch(base + path, { redirect: 'manual', ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('alerts tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  N = await import('../../server/src/notify.js'); P = await import('../../server/src/push.js'); W = await import('../../server/src/watch.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info) VALUES ('s', NULL, 1, 'Test home', $1)`, [JSON.stringify({ backup_reserve_percent: 20, user_settings: { storm_mode_enabled: true } })]);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const r = await call('/api/auth/owner', { json: { key: KEY }, headers: { 'X-Real-IP': '203.0.113.40' } });
  owner = (r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? '').split(';')[0];
  expect(owner).toBeTruthy();
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => {
  pushed.length = 0; status = () => 201; setVapid();
  await db.q('DELETE FROM alerts'); await db.q('DELETE FROM push_subscriptions');
  await db.kv.set('settings:owner', {});
});
const subscribe = async (b: ReturnType<typeof browser>) => { const r = await call('/api/push/subscribe', { cookie: owner, json: b.sub }); expect(r.status).toBe(200); };

describe('push crypto (push.ts)', () => {
  it('ALR-1 encrypts the RFC 8291 worked example byte for byte', () => {
    const as = createECDH('prime256v1'); as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const out = P.encryptPayload({ endpoint: PUSH + 'x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
      Buffer.from('When I grow up, I want to be a watermelon'), { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), ephemeral: as });
    expect(out.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('ALR-2 signs a VAPID ES256 JWT for the push service origin that verifies with the public key', () => {
    const v = P.vapid()!, now = Date.parse('2026-09-27T12:00:00Z');
    const h = P.vapidHeader(PUSH + 'abc', v, now), m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(process.env.VAPID_PUBLIC_KEY);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:alerts@example.test' });
    const p = Buffer.from(m[4], 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: p.subarray(1, 33).toString('base64url'), y: p.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))).toBe(true);
    expect(P.vapid({ VAPID_PUBLIC_KEY: 'short', VAPID_PRIVATE_KEY: 'x', VAPID_SUBJECT: 'mailto:a@example.test' })).toBeNull();
    expect(P.vapid({ ...process.env, VAPID_SUBJECT: 'nobody' })).toBeNull();
    // a private key with its leading zero byte dropped (31 bytes) is still the same key: CI hit one (2026-10-04)
    for (let i = 0; i < 2000; i++) {
      const v = createECDH('prime256v1'); v.generateKeys(); const d = v.getPrivateKey();
      if (d.length === 32 && d[0] === 0) { expect(P.vapid({ VAPID_PUBLIC_KEY: v.getPublicKey('base64url'), VAPID_PRIVATE_KEY: d.subarray(1).toString('base64url'), VAPID_SUBJECT: 'mailto:a@example.test' })).not.toBeNull(); break; }
    }
  });

  it('ALR-3 accepts only a real push service endpoint with a P-256 key and a 16-byte secret', () => {
    const b = browser('ok');
    expect(P.subscriptionProblem(b.sub)).toBeNull();
    expect(P.subscriptionProblem({ ...b.sub, endpoint: 'https://example.test/push' })).toMatch(/known push service/);
    expect(P.subscriptionProblem({ ...b.sub, endpoint: 'http://web.push.apple.com/x' })).toMatch(/known push service/);
    expect(P.subscriptionProblem({ ...b.sub, endpoint: 'https://web.push.apple.com.example.test/x' })).toMatch(/known push service/);
    expect(P.subscriptionProblem({ ...b.sub, keys: { ...b.sub.keys, auth: 'AAAA' } })).toMatch(/16 bytes/);
    expect(P.subscriptionProblem({ ...b.sub, keys: { ...b.sub.keys, p256dh: 'AAAA' } })).toMatch(/P-256/);
    expect(P.subscriptionProblem(null)).toMatch(/endpoint/);
  });
});

describe('notify()', () => {
  it('ALR-4 stores the alert and pushes it to every device; the payload decrypts to the alert', async () => {
    const a = browser('phone'), b = browser('tablet');
    await subscribe(a); await subscribe(b);
    const r = await N.notify('s', 'billDue', 'Your October PEC bill should be ready', 'Add it in History.', { nextClose: '2026-10-12' });
    expect(r).toMatchObject({ stored: true, pushed: 2, failed: 0, pruned: 0 });
    expect(pushed.map(p => p.url).sort()).toEqual([PUSH + 'phone', PUSH + 'tablet']);
    const got = pushed.find(p => p.url.endsWith('phone'))!;
    expect(got.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600', Urgency: 'normal' });
    expect(got.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(decrypt(got.body, a)).toEqual({ title: 'Your October PEC bill should be ready', body: 'Add it in History.', kind: 'billDue', id: r.id, url: '/' });
    const row = await db.one(`SELECT kind, title, data, pushed, read_at FROM alerts WHERE id = $1`, [r.id]);
    expect(row).toMatchObject({ kind: 'billDue', data: { nextClose: '2026-10-12' }, pushed: 2, read_at: null });
  });

  it('ALR-5 a gone endpoint (410) is deleted at once; a failing one after five failures in a row', async () => {
    const gone = browser('gone'), flaky = browser('flaky'), fine = browser('fine');
    for (const b of [gone, flaky, fine]) await subscribe(b);
    status = u => u.endsWith('gone') ? 410 : u.endsWith('flaky') ? 500 : 201;
    const r = await N.notify('s', 'panel', 'Panel check', 'One panel is low.');
    expect(r).toMatchObject({ stored: true, pushed: 1, failed: 2, pruned: 1 });
    const left = async () => (await db.q<{ endpoint: string; fails: number }>(`SELECT endpoint, fails FROM push_subscriptions ORDER BY endpoint`)).map(x => `${x.endpoint.slice(PUSH.length)}:${x.fails}`);
    expect(await left()).toEqual(['fine:0', 'flaky:1']);
    for (let i = 0; i < 4; i++) await N.fanOut('s', { title: 't', body: 'b', kind: 'panel' });
    expect(await left()).toEqual(['fine:0']);
  });

  it('ALR-6 the owner\'s switches silence a kind (the existing "nws" switch covers storms); a switched-off anomaly names its own', async () => {
    await subscribe(browser('p'));
    await db.kv.set('settings:owner', { alerts: { nws: false, solar: false } });
    expect(await N.notify('s', 'storm', 'Tornado Warning', 'Take cover.')).toMatchObject({ stored: false, skipped: 'off' });
    expect(await N.notify('s', 'anomaly', 'Solar dropped', 'x', {}, { toggle: 'solar' })).toMatchObject({ stored: false, skipped: 'off' });
    expect(await N.notify('s', 'anomaly', 'Pump drew less', 'x')).toMatchObject({ stored: true, pushed: 1 });
    expect(N.kindOff({ approval: false }, 'approval')).toBe(true);
    expect(N.kindOff({ approval: true }, 'approval')).toBe(false);
    expect(Number((await db.one(`SELECT COUNT(*) n FROM alerts`))!.n)).toBe(1);
  });

  it('ALR-7 the same key is a duplicate inside its window; past the per-kind push limit the feed still gets the alert, the phone does not', async () => {
    await subscribe(browser('p'));
    const t0 = Date.parse('2026-09-27T12:00:00Z');
    expect(await N.notify('s', 'ercot', 'Conserve', 'x', {}, { key: 'k1', now: t0 })).toMatchObject({ stored: true, pushed: 1 });
    expect(await N.notify('s', 'ercot', 'Conserve', 'x', {}, { key: 'k1', now: t0 + 23 * 3600e3 })).toMatchObject({ stored: false, skipped: 'duplicate' });
    expect(await N.notify('s', 'ercot', 'Conserve', 'x', {}, { key: 'k1', windowH: 2, now: t0 + 3 * 3600e3 })).toMatchObject({ stored: true, pushed: 1 });
    // ercot: 3 pushes a day. The third push goes out, the fourth is stored without a push, and 25 h later pushes resume
    expect(N.PUSH_LIMITS.ercot).toEqual({ max: 3, hours: 24 });
    expect(await N.notify('s', 'ercot', 'EEA 1', 'x', {}, { now: t0 + 4 * 3600e3 })).toMatchObject({ stored: true, pushed: 1 });
    const limited = await N.notify('s', 'ercot', 'EEA 2', 'x', {}, { now: t0 + 5 * 3600e3 });
    expect(limited).toMatchObject({ stored: true, pushed: 0, limited: true });
    expect(pushed).toHaveLength(3);
    expect(await N.notify('s', 'ercot', 'Normal', 'x', {}, { now: t0 + 29 * 3600e3 })).toMatchObject({ pushed: 1 });
  });

  it('ALR-8 without VAPID keys the alert is stored, nothing is sent and the subscriptions stay', async () => {
    await subscribe(browser('p'));
    delete process.env.VAPID_PRIVATE_KEY;
    const r = await N.notify('s', 'digest', 'Your week', 'x');
    expect(r).toMatchObject({ stored: true, pushed: 0, pruned: 0, push: 'vapid_not_configured' });
    expect(pushed).toHaveLength(0);
    expect((await db.q(`SELECT 1 FROM push_subscriptions`)).length).toBe(1);
    expect(await (await call('/api/push/key', { cookie: owner })).json()).toEqual({ key: null, configured: false });
  });
});

describe('routes (owner only)', () => {
  it('ALR-9 the feed, marking read, the public key, subscribe and unsubscribe', async () => {
    const t0 = Date.parse('2026-09-20T12:00:00Z');
    const a = await N.notify('s', 'anomaly', 'First', 'b1', {}, { now: t0 }), b = await N.notify('s', 'storm', 'Second', 'b2', { event: 'Tornado Warning' }, { now: t0 + 60_000 });
    let feed = await (await call('/api/alerts', { cookie: owner })).json();
    expect(feed.unread).toBe(2);
    expect(feed.alerts.map((x: any) => x.title)).toEqual(['Second', 'First']);
    expect(feed.alerts[0]).toEqual({ id: b.id, kind: 'storm', title: 'Second', body: 'b2', data: { event: 'Tornado Warning' }, createdAt: '2026-09-20T12:01:00.000Z', readAt: null });
    expect((await (await call(`/api/alerts?since=2026-09-20T12:00:30Z`, { cookie: owner })).json()).alerts.map((x: any) => x.id)).toEqual([b.id]);
    expect((await (await call(`/api/alerts?limit=1`, { cookie: owner })).json()).alerts).toHaveLength(1);
    expect((await call(`/api/alerts/${a.id}/read`, { cookie: owner, method: 'POST' })).status).toBe(200);
    feed = await (await call('/api/alerts', { cookie: owner })).json();
    expect(feed.unread).toBe(1);
    expect(feed.alerts.find((x: any) => x.id === a.id).readAt).toEqual(expect.any(String));
    expect((await call('/api/alerts/999999/read', { cookie: owner, method: 'POST' })).status).toBe(404);
    expect((await call('/api/alerts/abc/read', { cookie: owner, method: 'POST' })).status).toBe(400);
    expect(await (await call('/api/alerts/all/read', { cookie: owner, method: 'POST' })).json()).toEqual({ ok: true, read: 1 });

    expect(await (await call('/api/push/key', { cookie: owner })).json()).toEqual({ key: process.env.VAPID_PUBLIC_KEY, configured: true });
    const br = browser('route');
    expect((await call('/api/push/subscribe', { cookie: owner, json: { ...br.sub, endpoint: 'https://evil.example.test/x' } })).status).toBe(400);
    expect(await (await call('/api/push/subscribe', { cookie: owner, json: br.sub })).json()).toEqual({ ok: true, push: true });
    expect(await (await call('/api/push/subscribe', { cookie: owner, json: br.sub })).json()).toEqual({ ok: true, push: true });   // idempotent
    expect((await db.q(`SELECT site_id FROM push_subscriptions`))).toEqual([{ site_id: 's' }]);
    expect((await call('/api/push/subscribe', { cookie: owner, method: 'DELETE', json: {} })).status).toBe(400);
    expect(await (await call('/api/push/subscribe', { cookie: owner, method: 'DELETE', json: { endpoint: br.sub.endpoint } })).json()).toEqual({ ok: true, removed: 1 });
  });

  it('ALR-10 without the owner cookie every route answers 401 and nothing is stored', async () => {
    for (const [method, path] of [['GET', '/api/alerts'], ['POST', '/api/alerts/1/read'], ['GET', '/api/push/key'], ['POST', '/api/push/subscribe'], ['DELETE', '/api/push/subscribe']]) {
      const r = await call(path, { method, ...(method === 'GET' ? {} : { json: browser('anon').sub }) });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect((await db.q(`SELECT 1 FROM push_subscriptions`)).length).toBe(0);
  });
});

describe('the watches (watch.ts)', () => {
  it('ALR-11 the bill-due check fires once per cycle, two days after the next close, and not before', async () => {
    const { saveBill, parsePecText } = await import('../../server/src/bills.js');
    expect(await W.billDueCheck('s')).toEqual({ due: false, reason: 'no bill yet' });
    await saveBill('s', parsePecText(PEC_BILL));   // period to 2026-09-11 → next close 2026-10-12, ready 2026-10-14
    expect(await W.billDueCheck('s', Date.parse('2026-10-13T17:00:00Z'))).toEqual({ due: false, ready: '2026-10-14' });
    expect(await W.billDueCheck('s', Date.parse('2026-10-14T17:00:00Z'))).toEqual({ due: true, ready: '2026-10-14', notified: true });
    expect(await W.billDueCheck('s', Date.parse('2026-10-20T17:00:00Z'))).toEqual({ due: true, ready: '2026-10-14', notified: false });
    const rows = await db.q(`SELECT kind, title, data FROM alerts`);
    expect(rows).toEqual([{ kind: 'billDue', title: 'Your October PEC bill should be ready', data: { key: 'billDue:2026-10-12', nextClose: '2026-10-12', periodFrom: '2026-09-11' } }]);
    await db.q(`DELETE FROM bills`);
  });

  it('ALR-12 NWS storm alerts and the Storm Watch edge each notify once; the second tick adds nothing', async () => {
    const now = Date.now();
    await db.kv.set('nws', { at: now, alerts: [
      { event: 'Tornado Warning', headline: 'Tornado Warning until 6:00 PM', severity: 'Extreme', ends: '2026-09-27T18:00:00-05:00' },
      { event: 'Air Quality Alert', headline: 'Ozone', severity: 'Minor', ends: null }] });
    await db.q(`INSERT INTO readings (site_id, ts, soc, grid_status, island_status, storm_mode_active) VALUES ('s', $1, 64, 'Active', 'on_grid', true)`, [now]);
    await db.kv.set('s:storm:active', false);
    expect(await W.stormWatch('s', now)).toEqual({ alerts: 1, stormWatchActive: true, notified: 2 });
    expect(await W.stormWatch('s', now + 5 * 60_000)).toEqual({ alerts: 1, stormWatchActive: true, notified: 0 });
    const rows = await db.q<{ title: string; body: string }>(`SELECT title, body FROM alerts ORDER BY id`);
    expect(rows.map(r => r.title)).toEqual(['Tornado Warning', 'Storm Watch is charging the Powerwalls']);
    expect(rows[0].body).toBe('Tornado Warning until 6:00 PM. Powerwalls 64% · Storm Watch charging.');
    const st = await W.stormNow('s', { now });
    expect(st).toMatchObject({ warning: true, watch: false, stormWatchEnabled: true, stormWatchActive: true, active: true, soc: 64 });
    expect(W.isStormAlert({ event: 'Winter Storm Watch', severity: 'Moderate' })).toBe(true);
    expect(W.isStormAlert({ event: 'Heat Advisory', severity: 'Moderate' })).toBe(false);
    await db.q(`DELETE FROM readings`); await db.kv.set('nws', { at: now, alerts: [] });
  });

  it('ALR-13 ERCOT: one informational alert when the grid leaves normal, none while it stays there, none on return', async () => {
    const now = Date.now(), set = (condition: string, eea: number) => db.kv.set('ercot', { at: now, data: { condition, title: condition === 'normal' ? 'Normal Conditions' : 'Conservation Appeal', note: 'Conserve 4–7 PM.', eea, demandMw: 1, capacityMw: 2, at: 'x' } });
    await db.kv.set('s:ercot:level', 'normal');
    await set('normal', 0); expect(await W.ercotWatch('s', now)).toEqual({ level: 'normal' });
    await set('watch', 0); expect(await W.ercotWatch('s', now)).toEqual({ level: 'conservation', from: 'normal', notified: true });
    expect(await W.ercotWatch('s', now)).toEqual({ level: 'conservation' });
    await set('normal', 0); expect(await W.ercotWatch('s', now)).toEqual({ level: 'normal', from: 'conservation' });
    const [a] = await db.q(`SELECT kind, title, body FROM alerts`);
    expect(a).toEqual({ kind: 'ercot', title: 'Conservation Appeal', body: 'Conserve 4–7 PM. PEC bills a flat rate, so this is about grid stress, not your bill.' });
    expect(W.ercotLevel({ condition: 'normal', eea: 2 })).toBe('eea2');
  });

  it('ALR-14 anomalies the nightly rules just opened: warn and high notify once (with their switch), info and old ones do not', async () => {
    const now = Date.parse('2026-09-27T10:20:00Z'), open = (kind: string, severity: string, title: string, openedAt = now - 60_000) =>
      db.q(`INSERT INTO anomalies (site_id, day, kind, severity, detail, opened_at) VALUES ('s', '2026-09-26', $1, $2, $3, $4)`, [kind, severity, JSON.stringify({ title, body: `${title} body` }), openedAt]);
    await open('pump.below_baseline@1500', 'warn', 'Pump low'); await open('data.gap.nest', 'info', 'Nest gap'); await open('solar.step_down', 'high', 'Solar down');
    await open('ac.overrun', 'warn', 'Old one', now - 40 * 3600e3);
    expect(await N.notifyAnomalies('s', now)).toEqual({ opened: 2, notified: 2 });
    expect(await N.notifyAnomalies('s', now + 60_000)).toEqual({ opened: 2, notified: 0 });   // a rerun repeats nothing
    expect((await db.q<{ title: string; data: any }>(`SELECT title, data FROM alerts ORDER BY id`)).map(r => [r.title, r.data.anomaly, r.data.key])).toEqual([
      ['Pump low', 'pump.below_baseline@1500', 'anomaly:pump.below_baseline@1500:2026-09-26'], ['Solar down', 'solar.step_down', 'anomaly:solar.step_down:2026-09-26']]);
    await db.q(`DELETE FROM alerts`);
    await db.kv.set('settings:owner', { alerts: { solar: false } });
    expect(await N.notifyAnomalies('s', now)).toEqual({ opened: 2, notified: 1 });
    await db.q(`DELETE FROM anomalies`);
  });
});
