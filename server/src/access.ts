// Who is asking, and what they may do. Mounted on /api and /auth before every route.
//   owner      a valid solstice_owner cookie (auth.ts). Everything.
//   guest      a valid solstice_guest cookie (share.ts): a live, unrevoked, unexpired share link. GET only, and only the routes
//              in redact.ts GUEST_GET, each response through its allow-list view. Every write and every other route: 401.
//   anonymous  neither. Only OPEN_ROUTES; everything else is 401.
// The owner cookie always wins over a guest cookie on the same device. With the solstice_preview cookie the owner's reads
// are served exactly as a guest's (same allow-list, same 401s); the owner's writes are unaffected, so preview can be
// switched off again.
import type { Request, Response, NextFunction } from 'express';
import { ownerSession, readCookie, setCookie, safeEqual } from './auth.js';
import { guestShare } from './share.js';
import { GUEST_GET, serveThrough } from './redact.js';
import { PRESENCE_FIXED } from './appliances/presence.js';

export type Role = 'owner' | 'guest' | 'anonymous';
declare global { namespace Express { interface Request { role?: Role; guestView?: boolean; preview?: boolean } } }

export const PREVIEW_COOKIE = 'solstice_preview';
export const PREVIEW_MAX_AGE_S = 3600;   // short-lived: an hour, then the owner's own view comes back by itself
export const setPreview = (res: Response, on: boolean) => setCookie(res, PREVIEW_COOKIE, on ? '1' : '', on ? PREVIEW_MAX_AGE_S : 0);

/* Routes anyone may call. Paths are compared lower-cased and without a trailing slash, because Express matches routes
 * case-insensitively and ignores a trailing slash. */
const OPEN_ROUTES = new Set([
  'POST /api/auth/owner',                                           // trades OWNER_KEY for the owner cookie (rate-limited)
  'POST /api/auth/guest',                                           // trades a share token for the guest cookie (rate-limited)
  'POST /api/auth/leave',                                           // clears the guest cookie on this device ("Leave"); changes nothing else
  'GET /api/auth/me',                                               // the role, and nothing about the site for a non-owner
  'GET /api/cron/sync', 'GET /api/cron/pool', 'GET /api/cron/nest', // Vercel Cron: keep their Authorization: Bearer CRON_SECRET check
  'GET /auth/callback', 'GET /auth/google/callback',                // OAuth redirects: signed, single-use state from an owner-only route
]);
const denied = (res: Response) => res.status(401).json({ error: 'owner_required' });
/* The PVS relay's own credential (scripts/pvs-relay.mjs): `Authorization: Bearer <PVS_INGEST_TOKEN>` opens these two routes and
 * nothing else, so the Mac running the relay no longer needs the owner key (security review M3). The owner cookie still works. */
const INGEST_ROUTES = new Set(['POST /api/pvs/readings', 'POST /api/pvs/heartbeat']);
export const ingestOk = (req: Request) => { const t = process.env.PVS_INGEST_TOKEN ?? '', h = String(req.headers.authorization ?? '');
  return t.length >= 32 && h.startsWith('Bearer ') && safeEqual(h.slice(7), t); };

/** Resolve the role for this request (req.role, req.guestView, req.preview), then allow, serve through a guest view, or refuse. */
export async function gate(req: Request, res: Response, next: NextFunction) {
  try {
    res.set('Cache-Control', 'no-store');   // no response sits in a browser, proxy or CDN cache
    res.vary('Cookie');                     // and none is ever reused for a request with other cookies
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const path = (req.baseUrl + req.path).toLowerCase().replace(/\/+$/, '');
    const owner = !!(await ownerSession(req, res));
    const share = owner ? null : await guestShare(req);                           // the owner cookie wins
    req.role = owner ? 'owner' : share?.state === 'active' ? 'guest' : 'anonymous';
    req.preview = owner && readCookie(req, PREVIEW_COOKIE) === '1';
    req.guestView = req.role === 'guest' || (req.preview && method === 'GET');
    if (OPEN_ROUTES.has(`${method} ${path}`)) return next();
    if (!owner && INGEST_ROUTES.has(`${method} ${path}`) && ingestOk(req)) return next();
    if (req.guestView) {
      const view = method === 'GET' ? GUEST_GET.get(path) : undefined;
      if (!view) return denied(res);                                               // fail closed: no view, no access
      serveThrough(res, view);
      return next();
    }
    if (req.role !== 'owner') return denied(res);
    // Belt and braces beyond SameSite=Lax: owner writes must come from the app's own pages (curl sends no Sec-Fetch-Site).
    const site = req.headers['sec-fetch-site'];
    if (method !== 'GET' && method !== 'OPTIONS' && site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_site' });
    next();
  } catch (e) { next(e); }
}

/** Settings as a guest's request should see them: the AC plan is computed as if the owner were home, so no plan, step,
 *  reason or log line can reveal that the house is empty. */
export const presenceHidden = (req: Request, settings: Record<string, any>) =>
  req.guestView ? { ...settings, ac: { ...(settings.ac ?? {}), presence: 'home' }, [PRESENCE_FIXED]: true } : settings;   // presence.ts: never the manual mark or Nest
