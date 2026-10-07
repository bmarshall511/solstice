// Is anyone home? (docs/audit-designs/enhancements.md A1; owner's choice: Nest Home/Away Assist plus a manual "Away until…").
// Resolved in this order:
//   1. manual   POST /api/presence {state:'away', until?} or {state:'home'}, kept in kv `<site>:presence`. Away holds until `until`
//               (no `until`: until the owner marks Home). Home holds until Nest's Eco state changes from what it was when marked.
//               (a new spell of Eco that began after the mark counts as a change).
//               The AC card's existing Home/Away switch (settings.ac.presence) is the same manual mark; a site that has only that
//               setting (no kv record yet) keeps its behaviour exactly.
//   2. nest     Home/Away Assist puts the thermostat in Eco when everyone has left. SDM exposes that only as the ThermostatEco trait,
//               which nest.ts already reads (kv 'nest:last'); nothing new is asked of Google. Eco on → away, off → home. A reading older
//               than 30 minutes, or `settings.ac.nestPresence === false`, is ignored.
//   3. default  home.
// A Vacation-mode trip under way (vacation/trip.ts) comes before all three: the house is away, source 'vacation', until the trip ends.
// Read-only towards Nest. The only effect of "away" is the away setpoint in the AC plan, which acTick still applies only when the
// plan is approved or AC Autopilot is Auto, through the safety guard (guards.ts).
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { one, kv } from '../db.js';
import type { NestState } from './nest.js';
import { liveTrip, isAway } from '../vacation/trip.js';
import { finishTrip } from '../vacation/index.js';

export type PresenceState = 'home' | 'away';
export type PresenceSource = 'manual' | 'nest' | 'default' | 'vacation';
export type Presence = { state: PresenceState; source: PresenceSource; since: number | null; until: number | null };
export type ManualPresence = { state: PresenceState; at: number; until: number | null; nestEco: boolean | null };

/** Settings marked with this symbol (access.ts presenceHidden, for guests) are planned as if home, whatever is stored. */
export const PRESENCE_FIXED = Symbol('presenceFixed');
export const NEST_MAX_AGE_MS = 30 * 60_000;
export const MAX_AWAY_MS = 60 * 864e5;   // "Away until" at most 60 days ahead
export const presenceKey = (siteId: string) => `${siteId}:presence`;

/** The pure resolution (see the header). `nestSince`: when the current Nest Eco state began, if known. */
export function resolvePresence(o: { manual: ManualPresence | null; legacy?: string | null; nest: Pick<NestState, 'at' | 'eco'> | null; useNest: boolean; now: number; nestSince?: number | null }): Presence {
  const nestFresh = o.useNest && o.nest && o.now - o.nest.at <= NEST_MAX_AGE_MS ? o.nest : null;
  const m = o.manual;
  if (m?.state === 'away' && (m.until == null || o.now < m.until)) return { state: 'away', source: 'manual', since: m.at, until: m.until };
  // Home holds while the Eco state is the one it overrode: same state, and (when known) not a new spell of it begun after the mark
  if (m?.state === 'home' && (m.until == null || o.now < m.until) && (!nestFresh || (nestFresh.eco === m.nestEco && !(o.nestSince != null && o.nestSince > m.at))))
    return { state: 'home', source: 'manual', since: m.at, until: m.until };
  if (!m && o.legacy === 'away') return { state: 'away', source: 'manual', since: null, until: null };
  if (nestFresh) return { state: nestFresh.eco ? 'away' : 'home', source: 'nest', since: o.nestSince ?? null, until: null };
  return { state: 'home', source: 'default', since: null, until: null };
}

/** When the thermostat's current Eco state began, from the stored Nest readings (null when unknown). */
async function nestSince(siteId: string, eco: boolean) {
  const r = await one<{ ts: string | null }>(`SELECT MIN(ts)::text ts FROM nest_readings WHERE site_id = $1 AND eco = $2
    AND ts > COALESCE((SELECT MAX(ts) FROM nest_readings WHERE site_id = $1 AND eco IS DISTINCT FROM $2), 0)`, [siteId, eco]);
  return r?.ts != null ? Number(r.ts) : null;
}

/** Presence for a site now. `settingsAll` is the owner's settings (settings.ac.presence, settings.ac.nestPresence). */
export async function presenceFor(siteId: string, settingsAll: Record<string | symbol, any> = {}, now = Date.now()): Promise<Presence> {
  if (settingsAll[PRESENCE_FIXED]) return { state: 'home', source: 'default', since: null, until: null };
  const trip = await liveTrip(siteId);
  if (trip && isAway(trip, now)) return { state: 'away', source: 'vacation', since: trip.startedAt ?? trip.leaveAt, until: trip.backAt };
  const [manual, nest] = await Promise.all([kv.get<ManualPresence | null>(presenceKey(siteId)), kv.get<NestState | null>('nest:last')]);
  const useNest = settingsAll.ac?.nestPresence !== false, fresh = useNest && nest && now - nest.at <= NEST_MAX_AGE_MS;
  const since = fresh ? await nestSince(siteId, !!nest!.eco).catch(() => null) : null;
  return resolvePresence({ manual: manual ?? null, legacy: settingsAll.ac?.presence ?? null, nest: nest ?? null, useNest, now, nestSince: since });
}

/** Why a POST /api/presence body is unusable, or null. `until`: epoch ms or an ISO time, in the future, at most 60 days ahead. */
export function parsePresenceBody(b: any, now = Date.now()): { state: PresenceState; until: number | null } | { error: string } {
  const state = b?.state;
  if (state !== 'home' && state !== 'away') return { error: 'state must be home or away' };
  if (b.until == null || b.until === '') return { state, until: null };
  if (state === 'home') return { error: 'until applies to away only' };
  const until = typeof b.until === 'number' ? b.until : typeof b.until === 'string' ? Date.parse(b.until) : NaN;
  if (!Number.isFinite(until)) return { error: 'until must be a time (epoch ms or ISO 8601)' };
  if (until <= now) return { error: 'until must be in the future' };
  if (until - now > MAX_AWAY_MS) return { error: 'until must be within 60 days' };
  return { state, until };
}

/** Mark the house home or away by hand. Also mirrors the state into settings.ac.presence, so the AC card's switch reads the same. */
export async function setPresence(siteId: string, v: { state: PresenceState; until: number | null }, now = Date.now()) {
  const nest = await kv.get<NestState | null>('nest:last');
  const rec: ManualPresence = { state: v.state, at: now, until: v.until, nestEco: nest && now - nest.at <= NEST_MAX_AGE_MS ? !!nest.eco : null };
  await kv.set(presenceKey(siteId), rec);
  const s = await kv.get<Record<string, any>>('settings:owner') ?? {};
  if (s.ac?.presence !== v.state) await kv.set('settings:owner', { ...s, ac: { ...(s.ac ?? {}), presence: v.state } });
  return rec;
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
/**
 * GET /api/presence → {state, source, since, until}; POST /api/presence {state, until?}. Owner-only (mounted after requireSite).
 * `onChange` re-runs the AC tick so a mark takes effect at once when the plan is approved or Autopilot is Auto (app.ts supplies it).
 */
export function presenceRoutes(app: Express, onChange: (siteId: string) => Promise<unknown>) {
  app.get('/api/presence', wrap(async (req, res) => res.json(await presenceFor(req.siteId!, await kv.get<Record<string, any>>('settings:owner') ?? {}))));
  app.post('/api/presence', express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const v = parsePresenceBody(req.body);
    if ('error' in v) return res.status(400).json({ error: v.error });
    // Home during a trip is "I'm home": it ends Vacation mode (every system's part) before the mark
    const trip = v.state === 'home' ? await liveTrip(req.siteId!) : null;
    if (trip?.state === 'active') await finishTrip(req.siteId!, 'you');
    await setPresence(req.siteId!, v);
    await onChange(req.siteId!).catch(() => {});
    res.json(await presenceFor(req.siteId!, await kv.get<Record<string, any>>('settings:owner') ?? {}));
  }));
}
