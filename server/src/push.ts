// Web Push without a dependency: VAPID (RFC 8292) and the aes128gcm message encryption (RFC 8291 over RFC 8188), on node:crypto,
// sent with fetch. Keys come from the environment only (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); nothing is generated
// into the repo. Generate a pair once with:
//   node -e "const c=require('crypto').createECDH('prime256v1');c.generateKeys();console.log('VAPID_PUBLIC_KEY='+c.getPublicKey('base64url')+'\nVAPID_PRIVATE_KEY='+c.getPrivateKey('base64url'))"
import { createECDH, createPrivateKey, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';

export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushResult = { ok: boolean; status: number; gone: boolean; error?: string };

const b64u = (s: string) => Buffer.from(s, 'base64url');
/** Push services a browser hands out (Apple, Google, Mozilla, Microsoft). Anything else is refused, so a subscription can't point
 *  the server at an arbitrary URL. */
export const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

/** Why a subscription body is unusable, or null. p256dh must be an uncompressed P-256 point (65 bytes), auth 16 bytes. */
export function subscriptionProblem(s: any): string | null {
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1024) return 'endpoint is required';
  let u: URL; try { u = new URL(s.endpoint); } catch { return 'endpoint is not a URL'; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return 'endpoint is not a known push service';
  const p = typeof s.keys?.p256dh === 'string' ? b64u(s.keys.p256dh) : null, a = typeof s.keys?.auth === 'string' ? b64u(s.keys.auth) : null;
  if (!p || p.length !== 65 || p[0] !== 4) return 'keys.p256dh must be an uncompressed P-256 public key';
  if (!a || a.length !== 16) return 'keys.auth must be 16 bytes';
  return null;
}

type Vapid = { publicKey: string; key: KeyObject; subject: string };
/** The VAPID key pair from the environment, or null when it is not set (or malformed). */
export function vapid(env: NodeJS.ProcessEnv = process.env): Vapid | null {
  const pub = env.VAPID_PUBLIC_KEY ?? '', priv = env.VAPID_PRIVATE_KEY ?? '', subject = env.VAPID_SUBJECT ?? '';
  if (!pub || !priv || !/^(mailto:|https:)/.test(subject)) return null;
  try {
    const p = b64u(pub), raw = b64u(priv);
    // a P-256 private key is 32 bytes, but encoders (Node's ECDH included) drop leading zero bytes: about 1 key in 256 is 31 long
    const d = raw.length >= 30 && raw.length < 32 ? Buffer.concat([Buffer.alloc(32 - raw.length), raw]) : raw;
    if (p.length !== 65 || p[0] !== 4 || d.length !== 32) return null;
    const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: p.subarray(1, 33).toString('base64url'), y: p.subarray(33).toString('base64url') }, format: 'jwk' });
    return { publicKey: pub, key, subject };
  } catch { return null; }
}
export const vapidPublicKey = () => vapid()?.publicKey ?? null;

/** The VAPID Authorization header for one push service origin: an ES256 JWT (12 h) plus the public key. */
export function vapidHeader(endpoint: string, v: Vapid, now = Date.now()) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })}`;
  const sig = sign('sha256', Buffer.from(body), { key: v.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${body}.${sig}, k=${v.publicKey}`;
}

/** RFC 8291: encrypt one message for a subscription (a single aes128gcm record). `salt` and `ephemeral` are injectable for tests. */
export function encryptPayload(sub: PushSubscriptionJson, plaintext: Buffer, o: { salt?: Buffer; ephemeral?: ReturnType<typeof createECDH> } = {}) {
  const ua = b64u(sub.keys.p256dh), auth = b64u(sub.keys.auth);
  const ecdh = o.ephemeral ?? createECDH('prime256v1'); if (!o.ephemeral) ecdh.generateKeys();
  const as = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua), salt = o.salt ?? randomBytes(16);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]); // 0x02: last record, no padding
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([as.length]), as, body]);
}

/** Send one notification. 404/410 mean the subscription is gone (the caller deletes it). Never throws. */
export async function sendPush(sub: PushSubscriptionJson, message: { title: string; body: string; kind: string; id?: number; url?: string }, o: { ttl?: number; urgency?: 'normal' | 'high' } = {}): Promise<PushResult> {
  const v = vapid(); if (!v) return { ok: false, status: 0, gone: false, error: 'vapid_not_configured' };
  if (subscriptionProblem(sub)) return { ok: false, status: 0, gone: true, error: 'bad_subscription' };
  // keep the message well under one 4096-byte record
  const json = JSON.stringify({ title: message.title.slice(0, 120), body: message.body.slice(0, 600), kind: message.kind, id: message.id ?? null, url: message.url ?? '/' });
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', body: encryptPayload(sub, Buffer.from(json)), signal: AbortSignal.timeout(10_000),
      headers: { Authorization: vapidHeader(sub.endpoint, v), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(o.ttl ?? 3600), Urgency: o.urgency ?? 'normal' } });
    return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) };
  } catch (e) { return { ok: false, status: 0, gone: false, error: (e as Error).message }; }
}
