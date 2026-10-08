// Solstice access. Single-owner mode (the default): the owner cookie below. MULTI_USER (off, rule 5): email + password
// accounts (scrypt), opaque session cookie (only its SHA-256 is stored). Also the signed OAuth `state`.
// The gate that decides owner / guest / anonymous for every /api and /auth request is in access.ts; guest links are in share.ts.
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { q, one } from './db.js';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = 'solstice_session', DAYS = 90;
export const secret = () => { const s = process.env.SESSION_SECRET; if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars)'); return s; };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw: string) { const salt = randomBytes(16); return `scrypt$${salt.toString('hex')}$${(await scrypt(pw, salt, 64)).toString('hex')}`; }
export async function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$'); if (!salt || !hash) return false;
  const a = await scrypt(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type User = { id: number; email: string; name: string | null; role: string; settings: Record<string, unknown> };
declare global { namespace Express { interface Request { user?: User; siteId?: string } } }

const cookieJar = (req: Request) => (req.headers.cookie ?? '').split(';').map(c => c.trim().split('='));
/** Production (and any Vercel deploy) is HTTPS: cookies there are Secure and carry the `__Host-` prefix. Local development over plain
 *  http keeps the bare names (a `__Host-` cookie needs Secure, which a browser drops over http). */
const secureContext = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
/** The name a cookie is written under: `__Host-<name>` in production (the browser then refuses it unless it is Secure, Path=/ and has
 *  no Domain, so a sibling host or a plain-http response can't plant or overwrite it), the bare name in local development. */
export const cookieName = (name: string) => secureContext() ? `__Host-${name}` : name;
/** A cookie's value. In production the `__Host-` cookie wins; a device that still holds the bare one from before the prefix
 *  (2026-10-08) is read too, so nobody is signed out, and `legacyCookie` tells the caller to re-issue it under the new name. */
export function readCookie(req: Request, name: string) {
  const jar = cookieJar(req), get = (n: string) => jar.find(([k]) => k === n)?.[1];
  return (secureContext() ? get(`__Host-${name}`) : undefined) ?? get(name);
}
/** Whether this request proves `name` only through the bare, pre-prefix cookie (production only). */
export const legacyCookie = (req: Request, name: string) => {
  if (!secureContext()) return false;
  const jar = cookieJar(req); return !jar.some(([k]) => k === `__Host-${name}`) && jar.some(([k]) => k === name);
};
const secure = (req: Request) => req.headers['x-forwarded-proto'] === 'https' || req.secure;

export async function startSession(req: Request, res: Response, userId: number) {
  const token = randomBytes(32).toString('base64url');
  await q('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + $3::interval, $4)', [sha(token), userId, `${DAYS} days`, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure(req) ? '; Secure' : ''}`);
}
export async function endSession(req: Request, res: Response) {
  const t = readCookie(req, COOKIE); if (t) await q('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function currentUser(req: Request): Promise<User | undefined> {
  const t = readCookie(req, COOKIE); if (!t) return;
  return one<User>(`SELECT u.id, u.email, u.name, u.role, u.settings FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha(t)]);
}

/** Accounts are off until MULTI_USER=true: the app serves the one connected energy site with no sign-in. */
export const multiUser = () => process.env.MULTI_USER === 'true';

/** API guard. Single-owner mode (default): attach the connected site. Multi-user mode: require a session. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    if (!multiUser()) {
      req.siteId = (await one<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL ORDER BY created_at LIMIT 1'))?.id;
      return next();
    }
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    req.user = user;
    req.siteId = (await one<{ id: string }>('SELECT id FROM sites WHERE user_id = $1 ORDER BY created_at LIMIT 1', [user.id]))?.id;
    next();
  } catch (e) { next(e); }
}
export const requireSite = (req: Request, res: Response, next: NextFunction) => req.siteId ? next() : res.status(409).json({ error: 'Connect your Tesla account first', connect: '/auth/login' });

/** Slow down password guessing: 8 failures per email per 15 minutes. */
export async function tooManyAttempts(email: string) {
  const r = await one<{ n: string }>(`SELECT COUNT(*) n FROM login_attempts WHERE email = $1 AND NOT ok AND at > now() - interval '15 minutes'`, [email]);
  return Number(r?.n ?? 0) >= 8;
}
export const recordAttempt = (email: string, ok: boolean) => q('INSERT INTO login_attempts (email, ok) VALUES ($1, $2)', [email, ok]);

/** Stateless, signed OAuth `state` (serverless-safe): user id + expiry + nonce, HMAC'd with SESSION_SECRET. */
export function signState(userId: number, ttlMs = 10 * 60_000) {
  const body = `${userId}.${Date.now() + ttlMs}.${randomBytes(8).toString('hex')}`;
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
export function verifyState(state: string): number | null {
  const i = state.lastIndexOf('.'), body = state.slice(0, i), sig = state.slice(i + 1);
  const good = createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const [uid, exp] = body.split('.').map(Number);
  return exp > Date.now() ? uid : null;
}

/* ======================= owner identity (single-owner mode) =======================
 * One OWNER_KEY secret (Vercel env, local .env). The owner opens https://<app>/#owner=<OWNER_KEY> once per device; the web
 * app posts the key to POST /api/auth/owner, which records an owner_sessions row and sets the solstice_owner cookie.
 * No account, no password, no user table. The cookie is `<session id>.<HMAC-SHA256(OWNER_KEY, id)>`: deleting a row signs
 * one device out, rotating OWNER_KEY signs every device out. Without a usable OWNER_KEY nobody is the owner (fail closed). */
export const OWNER_COOKIE = 'solstice_owner';
const OWNER_MAX_AGE_S = 400 * 86400;   // Chrome's cap on cookie lifetime
/** Absolute expiry: an owner session lives at most 400 days from when the device was unlocked, however often it is used (it used to
 *  slide forward with last_seen for ever). The cookie's Max-Age counts down to that moment. */
const OWNER_LIFETIME = "interval '400 days'";

/** OWNER_KEY, or null when it is unset or shorter than 32 characters (then every owner check fails). */
export function ownerKey(): string | null {
  const k = process.env.OWNER_KEY?.trim();
  return k && k.length >= 32 ? k : null;
}
const digest = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time string compare: both sides are hashed first, so neither the content nor the length leaks through timing. */
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
export const checkOwnerKey = (key: string) => { const k = ownerKey(); return !!k && safeEqual(key.trim(), k); };

const sessionMac = (id: string, key: string) => createHmac('sha256', key).update(`owner-session.${id}`).digest('base64url');
/** Set (or, with maxAge 0, clear) one of Solstice's cookies: HttpOnly, SameSite=Lax, whole site. Secure everywhere except local
 *  development over plain http (NODE_ENV not production and not on Vercel). */
export function setCookie(res: Response, name: string, value: string, maxAge: number) {
  const sec = secureContext() ? '; Secure' : '';
  res.append('Set-Cookie', `${cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${sec}`);
  // in production every write also clears the bare, pre-prefix cookie, so a device ends up holding only the __Host- one
  if (secureContext()) res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${sec}`);
}
const setOwnerCookie = (res: Response, value: string, maxAge: number) => setCookie(res, OWNER_COOKIE, value, maxAge);

/** A short, non-identifying device label for the devices list ("iPhone · Safari"). */
export function deviceLabel(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : '';
  return br ? `${os} · ${br}` : os;
}

declare global { namespace Express { interface Request { ownerSessionId?: string | null; ownerSessionLeftS?: number } } }

/** The owner session this request's cookie proves, or null. Cached on the request. Touches last_seen (and slides the
 *  cookie) at most once an hour, so a normal request costs one indexed SELECT and no write. */
export async function ownerSession(req: Request, res?: Response): Promise<string | null> {
  if (req.ownerSessionId !== undefined) return req.ownerSessionId;
  req.ownerSessionId = null;
  const key = ownerKey(), raw = readCookie(req, OWNER_COOKIE);
  if (!key || !raw) return null;
  const i = raw.lastIndexOf('.'), id = raw.slice(0, i), mac = raw.slice(i + 1);
  if (i < 1 || !safeEqual(mac, sessionMac(id, key))) return null;
  const row = await one<{ stale: boolean; left: number }>(`SELECT last_seen < now() - interval '1 hour' AS stale,
      EXTRACT(EPOCH FROM (created_at + ${OWNER_LIFETIME} - now()))::int AS left
    FROM owner_sessions WHERE id = $1 AND last_seen > now() - ${OWNER_LIFETIME} AND created_at > now() - ${OWNER_LIFETIME}`, [id]);
  if (!row) return null;
  req.ownerSessionLeftS = Math.min(OWNER_MAX_AGE_S, Math.max(0, Number(row.left)));
  if (row.stale) await q('UPDATE owner_sessions SET last_seen = now() WHERE id = $1', [id]);
  // re-issue the cookie when its hour is up (the countdown to the absolute expiry) or when it came under the bare, pre-prefix name
  if (res && (row.stale || legacyCookie(req, OWNER_COOKIE))) setOwnerCookie(res, raw, req.ownerSessionLeftS);
  return (req.ownerSessionId = id);
}

/** After a good key: keep this device's session if its cookie is still valid, otherwise record a new one; (re)set the cookie. */
export async function startOwnerSession(req: Request, res: Response) {
  const key = ownerKey()!;
  let id = await ownerSession(req);
  if (!id) {
    id = randomBytes(24).toString('base64url');
    await q('INSERT INTO owner_sessions (id, label) VALUES ($1, $2)', [id, deviceLabel(String(req.headers['user-agent'] ?? ''))]);
  }
  setOwnerCookie(res, `${id}.${sessionMac(id, key)}`, req.ownerSessionLeftS ?? OWNER_MAX_AGE_S);
}
/** S-04: a signed-out device stops getting pushes. Its Web Push subscriptions (push_subscriptions.owner_session_id) go with its
 *  session. Rows with no session id (subscribed before the column existed) are never matched here; notify.ts keeps sending to them. */
const dropSubscriptions = async (ids: string[]) => { if (ids.length) await q('DELETE FROM push_subscriptions WHERE owner_session_id = ANY($1::text[])', [ids]); };
export async function endOwnerSession(req: Request, res: Response) {
  const id = await ownerSession(req);
  if (id) { await q('DELETE FROM owner_sessions WHERE id = $1', [id]); await dropSubscriptions([id]); }
  setOwnerCookie(res, '', 0);
}
export async function endOtherOwnerSessions(req: Request) {
  const id = await ownerSession(req);
  const gone = (await q<{ id: string }>('DELETE FROM owner_sessions WHERE id <> $1 RETURNING id', [id ?? ''])).map(r => r.id);
  await dropSubscriptions(gone);
  return gone.length;
}
/** Sign one other device out by the short id listOwnerSessions shows. 'current' when that is this device, false when none matches. */
export async function endOwnerSessionById(req: Request, shortId: string): Promise<boolean | 'current'> {
  const cur = await ownerSession(req);
  if (!/^[\w-]{6}$/.test(shortId)) return false;
  if (cur?.slice(0, 6) === shortId) return 'current';
  const gone = (await q<{ id: string }>('DELETE FROM owner_sessions WHERE left(id, 6) = $1 AND id <> $2 RETURNING id', [shortId, cur ?? ''])).map(r => r.id);
  await dropSubscriptions(gone);
  return gone.length > 0;
}
export async function listOwnerSessions(req: Request) {
  const cur = await ownerSession(req);
  return (await q<{ id: string; label: string | null; created_at: string; last_seen: string }>('SELECT id, label, created_at, last_seen FROM owner_sessions ORDER BY last_seen DESC'))
    .map(r => ({ id: r.id.slice(0, 6), label: r.label, createdAt: r.created_at, lastSeen: r.last_seen, current: r.id === cur }));
}

/** POST /api/auth/owner: at most 5 attempts per minute per client IP (in memory, so per function instance; the key's
 *  length is the real defence, this is hygiene). */
const attempts = new Map<string, number[]>();
export function ownerAttemptLimited(ip: string, now = Date.now()) {
  if (attempts.size > 5000) for (const [k, v] of attempts) if (now - v[v.length - 1] > 60_000) attempts.delete(k);
  const recent = (attempts.get(ip) ?? []).filter(t => now - t < 60_000);
  recent.push(now); attempts.set(ip, recent);
  return recent.length > 5;
}
/** POST /api/auth/guest: after 5 failed share links in a minute from one client IP, refuse (429) until the minute passes.
 *  Only failures count, so a guest re-opening a good link is never limited. Tokens are 192-bit; this is hygiene too. */
const guestFailures = new Map<string, number[]>();
export const guestAttempts = {
  limited(ip: string, now = Date.now()) { return (guestFailures.get(ip) ?? []).filter(t => now - t < 60_000).length >= 5; },
  failed(ip: string, now = Date.now()) {
    if (guestFailures.size > 5000) for (const [k, v] of guestFailures) if (now - v[v.length - 1] > 60_000) guestFailures.delete(k);
    guestFailures.set(ip, [...(guestFailures.get(ip) ?? []).filter(t => now - t < 60_000), now]);
  },
};
export const clientIp = (req: Request) => String(req.headers['x-real-ip'] ?? req.ip ?? 'unknown');

/** OAuth `state` for the single-owner Tesla and Nest links: minted only by owner-only routes (/auth/login, /auth/google),
 *  bound to its flow, short-lived, HMAC'd with SESSION_SECRET, and single-use (the callback claims the nonce in kv). */
/** The cookie that ties an owner OAuth flow to the browser that started it (2026-10-08): it holds the state's nonce. */
const oauthCookie = (flow: 'tesla' | 'nest') => `solstice_oauth_${flow}`;
/**
 * A signed, single-use owner OAuth `state`. With `res`, the flow is also bound to this browser: the state's nonce goes into a
 * short-lived cookie (`__Host-` in production, SameSite=Lax so it rides the provider's top-level redirect back), and the callback
 * must present it. A state started in one browser can't be finished in another (a planted or leaked link does nothing).
 */
export function signOwnerState(flow: 'tesla' | 'nest', ttlMs: number, res?: Response) {
  const nonce = randomBytes(16).toString('hex'), body = `owner.${flow}.${Date.now() + ttlMs}.${nonce}`;
  if (res) setCookie(res, oauthCookie(flow), nonce, Math.ceil(ttlMs / 1000));
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
/**
 * Check and use up an owner OAuth state: 'ok'; 'expired' (forged, expired, another flow's, already used); 'browser' (good state, but
 * not this browser's: its cookie is missing or holds another nonce; the nonce isn't used up, so the right browser can still finish).
 * With `req` the browser binding is enforced; `res` clears the cookie once used.
 */
export async function consumeOwnerState(state: string, flow: 'tesla' | 'nest', req?: Request, res?: Response): Promise<'ok' | 'expired' | 'browser'> {
  const i = state.lastIndexOf('.'); if (i < 1) return 'expired';
  const body = state.slice(0, i), sig = state.slice(i + 1);
  if (!safeEqual(sig, createHmac('sha256', secret()).update(body).digest('base64url'))) return 'expired';
  const [tag, f, exp, nonce] = body.split('.');
  if (tag !== 'owner' || f !== flow || !(Number(exp) > Date.now()) || !nonce) return 'expired';
  if (req) { const held = readCookie(req, oauthCookie(flow)); if (!held || !safeEqual(held, nonce)) return 'browser'; }
  const claimed = await one('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [`oauth:used:${nonce}`, JSON.stringify({ exp: Number(exp) })]);
  await q(`DELETE FROM kv WHERE key LIKE 'oauth:used:%' AND (value->>'exp')::bigint < $1`, [Date.now()]);
  if (claimed && res) setCookie(res, oauthCookie(flow), '', 0);
  return claimed ? 'ok' : 'expired';
}
