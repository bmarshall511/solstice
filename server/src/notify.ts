// The server alerts feed and Web Push fan-out (docs/audit-designs/enhancements.md N0/N1; owner's choice: in-app + push, no email).
//   notify(siteId, kind, title, body, data)  one alert: honour the owner's switch for its kind (Settings → Alerts), skip a repeat of the
//                                            same `key` inside its window, store it in `alerts` (the in-app feed) and push it to every
//                                            subscribed device unless the kind's push rate limit is reached.
//   GET  /api/alerts?since=&limit=           the feed, newest first, with the unread count
//   POST /api/alerts/:id/read                mark one read (`all` marks every alert read)
//   GET  /api/push/key                       the VAPID public key (null until VAPID_* is set)
//   POST /api/push/subscribe                 store this browser's PushSubscription {endpoint, keys: {p256dh, auth}}
//   DELETE /api/push/subscribe               forget it ({endpoint})
// Every route is owner-only: none is in redact.ts GUEST_GET, so the gate (access.ts) answers 401 to a guest.
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { q, one, kv } from './db.js';
import { sendPush, subscriptionProblem, vapidPublicKey, type PushSubscriptionJson } from './push.js';
import { tripAway } from './vacation/trip.js';

export const ALERT_KINDS = ['approval', 'billDue', 'anomaly', 'storm', 'ercot', 'panel', 'digest', 'grid', 'gridLow', 'poolTest', 'vacation'] as const;
export type AlertKind = typeof ALERT_KINDS[number];

/** The Settings → Alerts switches that silence each kind (`alerts[key] === false`). The existing keys are reused where they
 *  already mean the same thing ('nws' → storm); an anomaly can name its own switch (solar, baseline) through `opts.toggle`. */
export const TOGGLES: Record<AlertKind, string[]> = {
  approval: ['approval'], billDue: ['billDue'], anomaly: ['anomaly'], storm: ['storm', 'nws'], ercot: ['ercot'], panel: ['panel'], digest: ['digest'],
  grid: ['outage'], gridLow: ['lowBatt'],   // mockup ab: the two switches that were already in Settings › Alerts
  poolTest: ['poolTest'],   // mockup aj: "Time to test the pool"
  vacation: ['vacation'],   // mockup ak: "Vacation alerts"
};
/** Pushes per kind per window (the feed always keeps the alert; only the phone buzz is limited). */
export const PUSH_LIMITS: Record<AlertKind, { max: number; hours: number }> = {
  approval: { max: 3, hours: 24 }, billDue: { max: 1, hours: 24 * 7 }, anomaly: { max: 3, hours: 24 }, storm: { max: 6, hours: 24 },
  ercot: { max: 3, hours: 24 }, panel: { max: 2, hours: 24 }, digest: { max: 1, hours: 24 * 6 }, grid: { max: 6, hours: 24 }, gridLow: { max: 2, hours: 24 },
  poolTest: { max: 1, hours: 24 }, vacation: { max: 6, hours: 24 },
};
/** Mockup ak: pushes you can't act on from a trip (the water test, the panels) wait until you're back; the feed keeps them, marked held. */
export const HELD_ON_TRIP: readonly AlertKind[] = ['poolTest', 'panel'];
/** How long the same `key` stays a duplicate when the caller doesn't say. */
export const DEDUPE_HOURS = 24;

export type NotifyOpts = { key?: string; windowH?: number; toggle?: string; url?: string; now?: number };
export type NotifyResult = { stored: boolean; id?: number; pushed: number; failed: number; pruned: number; skipped?: 'off' | 'duplicate'; limited?: boolean; push?: string; held?: boolean };

const settings = async () => (await kv.get<Record<string, any>>('settings:owner')) ?? {};
export const kindOff = (alerts: Record<string, unknown> | undefined, kind: AlertKind, toggle?: string) =>
  [...TOGGLES[kind], ...(toggle ? [toggle] : [])].some(k => alerts?.[k] === false);

export async function notify(siteId: string, kind: AlertKind, title: string, body: string, data: Record<string, unknown> = {}, opts: NotifyOpts = {}): Promise<NotifyResult> {
  const now = opts.now ?? Date.now(), none = { stored: false, pushed: 0, failed: 0, pruned: 0 };
  if (!ALERT_KINDS.includes(kind)) throw new Error(`unknown alert kind ${kind}`);
  if (kindOff((await settings()).alerts, kind, opts.toggle)) return { ...none, skipped: 'off' };
  const key = opts.key ?? null;
  if (key) {
    const dup = await one(`SELECT 1 FROM alerts WHERE site_id = $1 AND kind = $2 AND data->>'key' = $3 AND created_at > $4 LIMIT 1`,
      [siteId, kind, key, new Date(now - (opts.windowH ?? DEDUPE_HOURS) * 3600e3).toISOString()]);
    if (dup) return { ...none, skipped: 'duplicate' };
  }
  const held = HELD_ON_TRIP.includes(kind) && await tripAway(siteId, now);
  const row = (await one<{ id: number }>(`INSERT INTO alerts (site_id, kind, title, body, data, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::int id`,
    [siteId, kind, title.slice(0, 200), body.slice(0, 2000), JSON.stringify({ ...data, ...(key ? { key } : {}), ...(held ? { held: true } : {}) }), new Date(now).toISOString()]))!;
  if (held) return { stored: true, id: row.id, pushed: 0, failed: 0, pruned: 0, held: true };
  const lim = PUSH_LIMITS[kind];
  const recent = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM alerts WHERE site_id = $1 AND kind = $2 AND pushed > 0 AND created_at > $3`,
    [siteId, kind, new Date(now - lim.hours * 3600e3).toISOString()]);
  if ((recent?.n ?? 0) >= lim.max) return { stored: true, id: row.id, pushed: 0, failed: 0, pruned: 0, limited: true };
  const fan = await fanOut(siteId, { title, body, kind, id: row.id, url: opts.url });
  if (fan.pushed) await q(`UPDATE alerts SET pushed = $2 WHERE id = $1`, [row.id, fan.pushed]);
  return { stored: true, id: row.id, ...fan };
}

/** Push one message to every subscription of the site. A gone endpoint (404/410) is deleted; five failures in a row delete it too. */
export async function fanOut(siteId: string, msg: { title: string; body: string; kind: string; id?: number; url?: string }) {
  const subs = await q<{ endpoint: string; p256dh: string; auth: string }>(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE site_id = $1`, [siteId]);
  let pushed = 0, failed = 0, pruned = 0, push: string | undefined;
  for (const s of subs) {
    const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, { urgency: msg.kind === 'storm' ? 'high' : 'normal' });
    if (r.ok) { pushed++; await q(`UPDATE push_subscriptions SET last_ok = now(), fails = 0 WHERE endpoint = $1`, [s.endpoint]); continue; }
    failed++; push = r.error;
    if (r.error === 'vapid_not_configured') break;   // nothing can be sent; leave the subscriptions alone
    const gone = r.gone || ((await one<{ fails: number }>(`UPDATE push_subscriptions SET fails = fails + 1 WHERE endpoint = $1 RETURNING fails`, [s.endpoint]))?.fails ?? 0) >= 5;
    if (gone) { await q(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]); pruned++; }
  }
  return { pushed, failed, pruned, ...(push ? { push } : {}) };
}

/** Anomalies the nightly rules (learn/nightly.ts) opened in the last 36 hours, as alerts: warn and high only (info stays in the model
 *  report). Run by the nightly cron right after the learning job; the key (kind + day) keeps a rerun from repeating one.
 *  Solar anomalies obey the "Solar underperforming" switch and the always-on step the "Overnight usage drift" one. */
export async function notifyAnomalies(siteId: string, now = Date.now()) {
  const rows = await q<{ kind: string; severity: string; day: string; detail: { title: string; body: string; action?: string } }>(
    `SELECT kind, severity, day, detail FROM anomalies WHERE site_id = $1 AND resolved_at IS NULL AND opened_at > $2 AND severity <> 'info' ORDER BY opened_at, id`,
    [siteId, now - 36 * 3600e3]);
  const out: NotifyResult[] = [];
  for (const v of rows) {
    if (v.kind.startsWith('panel.low@')) {   // mockup u-panels: a panel that stays low is the `panel` kind (Settings › Alerts › Panel fault)
      const d = v.detail as { title: string; nLow?: number; window?: number };
      out.push(await notify(siteId, 'panel', `Panel ${d.title}`, `Under 85% of the median panel on ${d.nLow ?? 5} of the last ${d.window ?? 7} days. Tap to see it on the roof.`,
        { anomaly: v.kind, severity: v.severity, action: 'open_panels' }, { key: `anomaly:${v.kind}:${v.day}`, windowH: 48, url: `/?go=v-sys&p=solar&panel=${v.kind.slice('panel.low@'.length)}`, now }));
      continue;
    }
    const toggle = v.kind.startsWith('solar.') ? 'solar' : v.kind === 'home.always_on_step' ? 'baseline' : undefined;
    out.push(await notify(siteId, 'anomaly', v.detail.title, v.detail.body, { anomaly: v.kind, severity: v.severity, action: v.detail.action ?? null },
      { key: `anomaly:${v.kind}:${v.day}`, windowH: 48, toggle, url: '/?go=v-sys&p=home', now }));
  }
  return { opened: rows.length, notified: out.filter(r => r.stored).length };
}

/* ---------- the feed ---------- */
export async function listAlerts(siteId: string, o: { since?: string; limit?: number } = {}) {
  const limit = Number.isFinite(o.limit) ? Math.max(1, Math.min(200, Math.floor(o.limit!))) : 50;
  const since = o.since && !Number.isNaN(Date.parse(o.since)) ? new Date(o.since).toISOString() : null;
  const rows = await q<{ id: number; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: string; read_at: string | null }>(
    `SELECT id::int id, kind, title, body, data, created_at, read_at FROM alerts WHERE site_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2)
     ORDER BY created_at DESC, id DESC LIMIT $3`, [siteId, since, limit]);
  const unread = (await one<{ n: number }>(`SELECT COUNT(*)::int n FROM alerts WHERE site_id = $1 AND read_at IS NULL`, [siteId]))?.n ?? 0;
  return { unread, alerts: rows.map(r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, data: r.data, createdAt: new Date(r.created_at).toISOString(), readAt: r.read_at ? new Date(r.read_at).toISOString() : null })) };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
/** Mounted by app.ts after requireSite, so req.siteId is set and the owner gate has already run. */
export function alertRoutes(app: Express) {
  app.get('/api/alerts', wrap(async (req, res) => res.json(await listAlerts(req.siteId!, { since: req.query.since ? String(req.query.since) : undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }))));
  app.post('/api/alerts/:id/read', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (id === 'all') return res.json({ ok: true, read: (await q(`UPDATE alerts SET read_at = now() WHERE site_id = $1 AND read_at IS NULL RETURNING id`, [req.siteId])).length });
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: 'id must be a number or "all"' });
    const r = await one(`UPDATE alerts SET read_at = COALESCE(read_at, now()) WHERE site_id = $1 AND id = $2 RETURNING id`, [req.siteId, Number(id)]);
    if (!r) return res.status(404).json({ error: 'no such alert' });
    res.json({ ok: true, id: Number(id) });
  }));
  app.get('/api/push/key', (_req, res) => { const key = vapidPublicKey(); res.json({ key, configured: !!key }); });
  app.post('/api/push/subscribe', express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const s = req.body as PushSubscriptionJson, bad = subscriptionProblem(s);
    if (bad) return res.status(400).json({ error: bad });
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200) || null;
    await q(`INSERT INTO push_subscriptions (endpoint, site_id, p256dh, auth, ua) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint) DO UPDATE SET site_id = excluded.site_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, fails = 0`,
      [s.endpoint, req.siteId, s.keys.p256dh, s.keys.auth, ua]);
    res.json({ ok: true, push: !!vapidPublicKey() });
  }));
  app.delete('/api/push/subscribe', express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    res.json({ ok: true, removed: (await q(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND site_id = $2 RETURNING endpoint`, [endpoint, req.siteId])).length });
  }));
}
