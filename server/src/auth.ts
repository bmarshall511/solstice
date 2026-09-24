// Solstice user accounts: email + password (scrypt), opaque session cookie (only its SHA-256 is stored).
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

function readCookie(req: Request, name: string) {
  return (req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).find(([k]) => k === name)?.[1];
}
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

/** API guard: 401 without a session. Also attaches the user's energy site (if connected). */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
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
export function signState(userId: number) {
  const body = `${userId}.${Date.now() + 10 * 60_000}.${randomBytes(8).toString('hex')}`;
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
export function verifyState(state: string): number | null {
  const i = state.lastIndexOf('.'), body = state.slice(0, i), sig = state.slice(i + 1);
  const good = createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const [uid, exp] = body.split('.').map(Number);
  return exp > Date.now() ? uid : null;
}
