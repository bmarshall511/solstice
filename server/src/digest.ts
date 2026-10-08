// The weekly digest (docs/audit-designs/enhancements.md D1c; owner's choice: in-app and push only, no email). Last week, Monday to
// Sunday in Chicago: solar, used, bought and sent (kWh), the sunshine share, the Powerwalls' full days and lowest charge, what the
// pool and AC Autopilots and the Powerwall rules did, the anomalies, and how far each learned figure can be trusted. kWh and counts only: no rate and no dollar
// figure, so the digest can be stored and pushed as it is.
//   Monday 07:00 Chicago   maybeWeeklyDigest (from the 5-minute and nightly crons; a kv marker makes it once per week) stores the
//                          week in `digests` and sends one `digest` alert
//   GET /api/digest?week=  a week ('2026-W39' or any date in it; default: the last complete week), stored or built on the fly
import { tripsBetween } from './vacation/trip.js';
import type { Express, Request, Response, NextFunction } from 'express';
import { q, one } from './db.js';
import { localDay, addDays, localMidnight } from './tesla/client.js';
import { confidenceMap, type Tier } from './learn/confidence.js';
import { MODEL_IDS, type ModelId } from './learn/models.js';
import { notify } from './notify.js';
import { changedFor, type Changed } from './learn/changed.js';

/* ---------- ISO weeks (Monday first; the week belongs to the year of its Thursday) ---------- */
const dayMs = 864e5;
const utc = (d: string) => Date.parse(d + 'T12:00:00Z');
export const mondayOf = (day: string) => addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));
export function isoWeek(day: string) {
  const thu = utc(mondayOf(day)) + 3 * dayMs, y = new Date(thu).getUTCFullYear();
  return `${y}-W${String(1 + Math.floor((thu - Date.UTC(y, 0, 1, 12)) / dayMs / 7)).padStart(2, '0')}`;
}
export function weekMonday(week: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week); if (!m) return null;
  const y = +m[1], w = +m[2]; if (w < 1 || w > 53) return null;
  const monday = new Date(utc(mondayOf(`${y}-01-04`)) + (w - 1) * 7 * dayMs).toISOString().slice(0, 10);
  return isoWeek(monday) === week ? monday : null;
}
/** A `week` query value: an ISO week or a date in the week; empty means the last complete week. Null when unreadable. */
export function parseWeek(v: string | undefined, today = localDay()): string | null {
  if (!v) return mondayOf(addDays(today, -7));
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(utc(v))) return mondayOf(v);
  return weekMonday(v);
}

export type Totals = { days: number; solarKwh: number; homeKwh: number; importKwh: number; exportKwh: number; sunsharePct: number | null };
export type Digest = {
  week: string; from: string; to: string; partial: boolean; builtAt: number;
  totals: Totals; lastWeek: Totals | null;
  vsLastWeek: { solarKwh: number; homeKwh: number; importKwh: number; exportKwh: number; sunsharePts: number | null } | null;
  bestSolarDay: { date: string; kwh: number } | null;
  powerwall: { fullDays: number; daysWithData: number; lowestPct: number | null };
  autopilot: {
    pool: { applied: number; suggested: number; refused: number; lines: string[] };
    ac: { set: number; refused: number; lines: string[] };
    powerwall: { sent: number; refused: number; suggested: number; scopeMissing: number };
  };
  anomalies: { open: number; openedThisWeek: number; items: Array<{ kind: string; title: string; severity: string; day: string }> };
  confidence: Record<ModelId, Tier>;
  /** Mockup ak: trips that touched the week ("Away Thu–Sun · 71 kWh"); kWh once the trip's report is built. */
  trips?: Array<{ from: number; to: number | null; usedKwh: number | null }>;
  /** I-18 (mockup am frame 2): the week's use split against the week before; the digest's lead line is built from it. */
  changed?: Changed | null;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
/** Share of the house's use that sunshine covered, directly or through the Powerwalls (they charge only from solar here). */
export const sunshare = (home: number, imp: number) => home > 0 ? Math.max(0, Math.min(100, Math.round((1 - imp / home) * 100))) : null;
/** Log lines as they are, minus anything that looks like money (belt and braces: the digest carries no dollar figure). */
const clean = (t: string) => t.replace(/\$\s?[\d,.]+(\/\w+)?/g, '').replace(/\s{2,}/g, ' ').trim();
type LogLine = { at: number; day: string; text: string; delta?: string };

export async function buildDigest(siteId: string, monday: string, now = Date.now()): Promise<Digest> {
  const from = monday, to = addDays(monday, 6), prevFrom = addDays(monday, -7);
  const [energy, best, soe, anomalies, logs, confidence, pw] = await Promise.all([
    q<{ w: string; days: number; solar: number; home: number; imp: number; exp: number }>(`SELECT CASE WHEN day >= $3 THEN 'this' ELSE 'prev' END w, COUNT(DISTINCT day)::int days,
       COALESCE(SUM(solar_wh), 0)::float8 / 1000 solar, COALESCE(SUM(home_wh), 0)::float8 / 1000 home, COALESCE(SUM(import_wh), 0)::float8 / 1000 imp, COALESCE(SUM(export_wh), 0)::float8 / 1000 exp
       FROM energy WHERE site_id = $1 AND day >= $2 AND day <= $4 GROUP BY 1`, [siteId, prevFrom, from, to]),
    one<{ day: string; kwh: number }>(`SELECT day, (SUM(solar_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY kwh DESC, day LIMIT 1`, [siteId, from, to]),
    one<{ full: number; n: number; low: number | null }>(`SELECT COUNT(*) FILTER (WHERE mx >= 99)::int full, COUNT(*)::int n, MIN(mn)::float8 low
       FROM (SELECT day, MAX(soe) mx, MIN(soe) mn FROM soe WHERE site_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day) x`, [siteId, from, to]),
    q<{ kind: string; severity: string; day: string; detail: { title?: string }; opened_at: number; resolved_at: number | null }>(
      `SELECT kind, severity, day, detail, opened_at::float8 opened_at, resolved_at::float8 resolved_at FROM anomalies WHERE site_id = $1 AND (resolved_at IS NULL OR day BETWEEN $2 AND $3) ORDER BY opened_at DESC, id DESC`, [siteId, from, to]),
    q<{ key: string; value: LogLine[] }>(`SELECT key, value FROM kv WHERE key = ANY($1::text[])`, [[`${siteId}:pool:autolog`, `${siteId}:ac:log`]]),
    confidenceMap(siteId, MODEL_IDS, { today: addDays(to, 1) }),
    q<{ result: string; n: number }>(`SELECT result, COUNT(*)::int n FROM powerwall_log WHERE site_id = $1 AND at >= $2 AND at < $3 GROUP BY result`,
      [siteId, localMidnight(from).getTime(), localMidnight(addDays(to, 1)).getTime()]),
  ]);
  const pwN = (r: string) => pw.find(x => x.result === r)?.n ?? 0;
  const totals = (w: string): Totals | null => {
    const r = energy.find(x => x.w === w); if (!r) return null;
    return { days: r.days, solarKwh: r1(r.solar), homeKwh: r1(r.home), importKwh: r1(r.imp), exportKwh: r1(r.exp), sunsharePct: sunshare(r.home, r.imp) };
  };
  const cur = totals('this') ?? { days: 0, solarKwh: 0, homeKwh: 0, importKwh: 0, exportKwh: 0, sunsharePct: null }, prev = totals('prev');
  const inWeek = (key: string) => (logs.find(l => l.key === key)?.value ?? []).filter(l => l && l.day >= from && l.day <= to);
  const pool = inWeek(`${siteId}:pool:autolog`), ac = inWeek(`${siteId}:ac:log`);
  const open = anomalies.filter(a => a.resolved_at == null);
  return {
    week: isoWeek(from), from, to, partial: to >= localDay(new Date(now)), builtAt: now,
    totals: cur, lastWeek: prev,
    vsLastWeek: prev ? { solarKwh: r1(cur.solarKwh - prev.solarKwh), homeKwh: r1(cur.homeKwh - prev.homeKwh), importKwh: r1(cur.importKwh - prev.importKwh),
      exportKwh: r1(cur.exportKwh - prev.exportKwh), sunsharePts: cur.sunsharePct != null && prev.sunsharePct != null ? cur.sunsharePct - prev.sunsharePct : null } : null,
    bestSolarDay: best ? { date: best.day, kwh: r1(best.kwh) } : null,
    powerwall: { fullDays: soe?.full ?? 0, daysWithData: soe?.n ?? 0, lowestPct: soe?.low != null ? Math.round(soe.low) : null },
    autopilot: {
      pool: { applied: pool.filter(l => !l.delta || /kWh/.test(l.delta)).length, suggested: pool.filter(l => l.delta === 'waiting for you').length,
        refused: pool.filter(l => l.delta === 'refused').length, lines: pool.slice(0, 5).map(l => clean(l.text)) },
      ac: { set: ac.filter(l => l.delta !== 'refused').length, refused: ac.filter(l => l.delta === 'refused').length, lines: ac.slice(0, 5).map(l => clean(l.text)) },
      powerwall: { sent: pwN('sent'), refused: pwN('refused'), suggested: pwN('suggested'), scopeMissing: pwN('scope_missing') },
    },
    anomalies: { open: open.length, openedThisWeek: anomalies.filter(a => a.day >= from && a.day <= to).length,
      items: open.slice(0, 8).map(a => ({ kind: a.kind, title: String(a.detail?.title ?? a.kind), severity: a.severity, day: a.day })) },
    confidence,
    trips: (await tripsBetween(siteId, from, to)).map(t => ({ from: t.startedAt!, to: t.endedAt, usedKwh: (t.data.report as { usedKwh?: number } | undefined)?.usedKwh ?? null })),
    changed: await changedFor(siteId, 'week', from, { now }).catch(e => { console.warn(`[digest] what changed: ${(e as Error).message}`); return null; }),
  };
}

/** The alert's text: one line of numbers, one of what needs the owner. */
export function digestAlert(d: Digest) {
  const t = d.totals, parts = [`${t.solarKwh} kWh of solar`, `${t.homeKwh} kWh used`, `${t.importKwh} kWh bought`, `${t.exportKwh} kWh sent`];
  const todo = [d.anomalies.open ? `${d.anomalies.open} open ${d.anomalies.open === 1 ? 'anomaly' : 'anomalies'}` : null,
    d.autopilot.pool.suggested ? `${d.autopilot.pool.suggested} pool plan${d.autopilot.pool.suggested === 1 ? '' : 's'} suggested` : null].filter(Boolean);
  return { title: t.sunsharePct != null ? `Your week: ${t.sunsharePct}% from sunshine` : 'Your week in energy', body: `${parts.join(', ')}.${todo.length ? ` ${todo.join(' · ')}.` : ''}` };
}

/** Where a tapped digest push opens: Now, where the "Your week" card lives (approved mockup t-enhancements frame 1). */
export const DIGEST_URL = '/?go=v-now';

/** Store a week's digest (a rebuild replaces it). */
export const saveDigest = (siteId: string, d: Digest) =>
  q(`INSERT INTO digests (site_id, week, data) VALUES ($1, $2, $3) ON CONFLICT (site_id, week) DO UPDATE SET data = excluded.data, created_at = now()`, [siteId, d.week, JSON.stringify(d)]);

/**
 * Monday 07:00 Chicago, once per week: from then until 48 hours later the first cron tick builds last week's digest, stores it and
 * sends one `digest` alert. The kv marker is claimed atomically before the work, so overlapping ticks can't send two.
 */
export async function maybeWeeklyDigest(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), monday = mondayOf(today), start = localMidnight(monday).getTime() + 7 * 3600e3;
  if (now < start) return { skipped: 'before Monday 07:00' };
  if (now >= start + 48 * 3600e3) return { skipped: 'outside the Monday–Tuesday window' };
  const lastMonday = addDays(monday, -7), week = isoWeek(lastMonday), key = `${siteId}:digest:week`;
  const claimed = await q(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE kv.value <> excluded.value RETURNING key`, [key, JSON.stringify(week)]);
  if (!claimed.length) return { skipped: 'already sent', week };
  const d = await buildDigest(siteId, lastMonday, now);
  await saveDigest(siteId, d);
  const a = digestAlert(d);
  const r = await notify(siteId, 'digest', a.title, a.body, { week }, { key: `digest:${week}`, windowH: 24 * 8, now, url: DIGEST_URL });
  return { week, stored: true, notified: r.stored, pushed: r.pushed };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
/** GET /api/digest?week= (owner-only; mounted by app.ts after requireSite). */
export function digestRoutes(app: Express) {
  app.get('/api/digest', wrap(async (req, res) => {
    const monday = parseWeek(req.query.week == null ? undefined : String(req.query.week));
    if (!monday) return res.status(400).json({ error: 'week must be like 2026-W39 or a date (YYYY-MM-DD)' });
    const stored = await one<{ data: Digest }>(`SELECT data FROM digests WHERE site_id = $1 AND week = $2`, [req.siteId, isoWeek(monday)]);
    res.json(stored ? { ...stored.data, stored: true } : { ...await buildDigest(req.siteId!, monday), stored: false });
  }));
}
