// Guest share links. The owner creates a link with a private label and an expiry; opening it on any device trades the token
// (carried in the URL fragment, #s=<token>, so it never reaches request logs or link unfurlers) for the solstice_guest cookie.
// No accounts: a link is a capability. Only the SHA-256 of the token is stored, so the plaintext exists once, in the owner's
// create response. Revoking is a row update and takes effect on the guest's next request. Revoked and expired links stay in
// the owner's list for 30 days, then are pruned (row deletes only; the table is never dropped or rewritten, rule 6).
import { randomBytes, createHash } from 'node:crypto';
import type { Request } from 'express';
import { q, one } from './db.js';
import { readCookie, deviceLabel } from './auth.js';

export const GUEST_COOKIE = 'solstice_guest';
const DAY_MS = 864e5;
/** Expiry choices for a new link. 30 days is the default. */
export const EXPIRY: Readonly<Record<string, number | null>> = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '1yr': 365 * DAY_MS, never: null };
export const DEFAULT_EXPIRY = '30d';
/** Cookie lifetime for a link that never expires: 400 days, Chrome's cap. The server re-checks the row on every request anyway. */
export const NEVER_MAX_AGE_S = 400 * 86400;
export const LABEL_MAX = 40;
const KEEP_DAYS = 30;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** "iPhone Safari": the device family and browser only, never a version or the raw User-Agent. */
export const uaFamily = (ua = '') => deviceLabel(ua).replace(' · ', ' ');
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const STATE_SQL = `CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired' ELSE 'active' END`;

export type ShareState = 'active' | 'expired' | 'revoked';
export type ShareRow = { id: string; label: string; createdAt: string; expiresAt: string | null; revokedAt: string | null;
  openedCount: number; lastOpenedAt: string | null; lastUa: string | null; state: ShareState };

/** A new link: 24 random bytes (192 bits, 32 base64url characters). Returns the plaintext token; only its hash is stored. */
export async function createShare(label: string, expiresIn: string = DEFAULT_EXPIRY) {
  if (!Object.hasOwn(EXPIRY, expiresIn)) throw new RangeError(`expiresIn must be one of ${Object.keys(EXPIRY).join(', ')}`);
  const ttl = EXPIRY[expiresIn], id = randomBytes(6).toString('base64url'), token = randomBytes(24).toString('base64url');
  const row = await one<{ created_at: string; expires_at: string | null }>(
    `INSERT INTO access_tokens (id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() + $4::bigint * interval '1 millisecond' END)
     RETURNING created_at, expires_at`, [id, sha(token), label, ttl]);
  return { id, token, label, createdAt: iso(row!.created_at)!, expiresAt: iso(row!.expires_at) };
}

/** Drop revoked links 30 days after their revocation and expired links 30 days after their expiry. Returns how many went. */
export async function pruneShares() {
  return (await q(`DELETE FROM access_tokens WHERE revoked_at < now() - interval '${KEEP_DAYS} days' OR expires_at < now() - interval '${KEEP_DAYS} days' RETURNING id`)).length;
}

/** Every link for the owner's list, newest first, after pruning. Never the hash, never the token. */
export async function listShares(): Promise<ShareRow[]> {
  await pruneShares();
  const rows = await q(`SELECT id, label, created_at, expires_at, revoked_at, opened_count, last_opened_at, last_ua, ${STATE_SQL} AS state
    FROM access_tokens ORDER BY created_at DESC, id`);
  return rows.map(r => ({ id: r.id, label: r.label, createdAt: iso(r.created_at)!, expiresAt: iso(r.expires_at), revokedAt: iso(r.revoked_at),
    openedCount: Number(r.opened_count), lastOpenedAt: iso(r.last_opened_at), lastUa: r.last_ua ?? null, state: r.state }));
}

/** Revoke one link now. False when there is no such link or it was already revoked. */
export async function revokeShare(id: string) {
  return (await q(`UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [id])).length === 1;
}
/** Revoke every link not already revoked (live or merely expired). Returns how many. */
export async function revokeAllShares() {
  return (await q(`UPDATE access_tokens SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id`)).length;
}

export type ShareLookup = { id: string; state: ShareState; expiresAt: string | null };
/** The link a token belongs to, with its state, or null for a token that matches nothing (a hash lookup, so a guess learns nothing). */
export async function findShare(token: string): Promise<ShareLookup | null> {
  if (!token || token.length > 200) return null;
  const r = await one(`SELECT id, expires_at, ${STATE_SQL} AS state FROM access_tokens WHERE token_hash = $1`, [sha(token)]);
  return r ? { id: r.id, state: r.state, expiresAt: iso(r.expires_at) } : null;
}

/** Open a link. A live one bumps opened_count, last_opened_at and last_ua (the device family only). */
export async function redeemShare(token: string, userAgent = ''):
  Promise<{ ok: true; id: string; expiresAt: string | null } | { ok: false; reason: 'unknown' | 'revoked' | 'expired' }> {
  const s = await findShare(token);
  if (!s) return { ok: false, reason: 'unknown' };
  if (s.state !== 'active') return { ok: false, reason: s.state };
  await q(`UPDATE access_tokens SET opened_count = opened_count + 1, last_opened_at = now(), last_ua = $2 WHERE id = $1`, [s.id, uaFamily(userAgent)]);
  return { ok: true, id: s.id, expiresAt: s.expiresAt };
}

/** Seconds the guest cookie lives: until the link expires (at least 1), or 400 days for a link that never does. */
export const guestMaxAge = (expiresAt: string | null, now = Date.now()) =>
  expiresAt == null ? NEVER_MAX_AGE_S : Math.max(1, Math.min(NEVER_MAX_AGE_S, Math.floor((Date.parse(expiresAt) - now) / 1000)));

declare global { namespace Express { interface Request { guestShareLookup?: ShareLookup | null } } }
/** The link this request's guest cookie matches, in whatever state, or null. Cached on the request (one indexed SELECT). */
export async function guestShare(req: Request): Promise<ShareLookup | null> {
  if (req.guestShareLookup !== undefined) return req.guestShareLookup;
  const t = readCookie(req, GUEST_COOKIE);
  return (req.guestShareLookup = t ? await findShare(t) : null);
}
