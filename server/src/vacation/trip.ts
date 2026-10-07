// Vacation mode (mockup ak): one trip at a time, from your tap ("Leaving Thu 7 AM, back Sun about 6 PM") or a detected start you
// confirmed. This file is the trip itself: the record, the rules for its dates, its phase at a moment, and the lifecycle the 5-minute
// cron runs (a planned trip starts at its leave time; nothing else ends it but you, a sign of someone home, or the 60-day cap).
// What each system does during a trip lives with that system (AC, pool, Powerwalls, alerts); they ask `liveTrip` and `tripPhase`.
//   planned    saved, leave time still ahead: nothing changes yet
//   away       under way, before the arrival day's welcome-home window
//   due        the arrival time has come (up to 2 h past it): the house should be ready, the owner is on the way
//   late       more than 2 h past the arrival time with no sign of anyone: back to the trip settings, and "extend?" (owner, Q8)
// Table `trips` (CREATE TABLE IF NOT EXISTS in db.ts). Times are epoch ms. `data` holds the trip's log, the departure checklist and,
// once it ends, the report.
import { q, one } from '../db.js';
import { localDay, addDays, localAt } from '../tesla/client.js';

export type TripState = 'planned' | 'active' | 'ended' | 'cancelled';
export type TripPhase = 'planned' | 'away' | 'due' | 'late';
export type TripEndedBy = 'you' | 'home' | 'cap' | 'cancelled';
export type TripLog = { at: number; text: string; delta?: string };
export type TripData = { log?: TripLog[]; checklist?: Record<string, boolean>; macHome?: boolean | null; report?: unknown; [k: string]: unknown };
export type Trip = { id: number; siteId: string; leaveAt: number; backAt: number | null; state: TripState; startedAt: number | null; endedAt: number | null;
  endedBy: TripEndedBy | null; detected: boolean; data: TripData };

export const MAX_TRIP_MS = 60 * 864e5;        // the furthest a trip may reach, and its length (presence.ts allows 60 days too)
export const MIN_TRIP_MS = 3600_000;           // an hour at least
export const LEAVE_SLACK_MS = 10 * 60_000;     // "leaving now": a leave time up to 10 minutes ago is now
export const LATE_MS = 2 * 3600_000;           // owner, Q8: no sign of you 2 h after the arrival time → late
export const LOG_MAX = 80;

type Row = { id: number; site_id: string; leave_at: string; back_at: string | null; state: TripState; started_at: string | null; ended_at: string | null; ended_by: TripEndedBy | null; detected: boolean; data: TripData };
const num = (v: string | number | null) => v == null ? null : Number(v);
export const toTrip = (r: Row): Trip => ({ id: Number(r.id), siteId: r.site_id, leaveAt: Number(r.leave_at), backAt: num(r.back_at), state: r.state, startedAt: num(r.started_at),
  endedAt: num(r.ended_at), endedBy: r.ended_by, detected: !!r.detected, data: r.data ?? {} });

/* ---------- pure ---------- */
const time = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' ? (Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN) : v == null || v === '' ? null : NaN;
/**
 * Why a new trip's body is unusable, or the trip it asks for. `leaveAt` (epoch ms or ISO): now or later, at most 60 days ahead (a leave
 * time up to 10 minutes ago means now). `backAt`: optional (an open trip, as a detected start leaves it), at least an hour after leaving
 * and at most 60 days after it. `detected`: the trip came from the "Looks like you're away" push.
 */
export function parseTripBody(b: any, now = Date.now()): { leaveAt: number; backAt: number | null; detected: boolean; checklist: Record<string, boolean>; macHome: boolean | null } | { error: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'send leaveAt and backAt' };
  const leave = time(b.leaveAt ?? now), back = time(b.backAt);
  if (leave == null || Number.isNaN(leave)) return { error: 'leaveAt must be a time (epoch ms or ISO 8601)' };
  if (back !== null && Number.isNaN(back)) return { error: 'backAt must be a time (epoch ms or ISO 8601)' };
  if (leave < now - LEAVE_SLACK_MS) return { error: 'leaveAt must be now or later' };
  if (leave > now + MAX_TRIP_MS) return { error: 'leaveAt must be within 60 days' };
  const leaveAt = leave < now ? now : leave;   // "leaving now"
  const err = backError(leaveAt, back); if (err) return { error: err };
  const checklist = checklistOf(b.checklist); if (checklist === null) return { error: 'checklist must be an object of on/off ticks' };
  if (b.macHome != null && typeof b.macHome !== 'boolean') return { error: 'macHome must be true or false' };
  return { leaveAt, backAt: back, detected: b.detected === true, checklist, macHome: b.macHome ?? null };
}
/** Why an arrival time doesn't fit the leave time, or null. */
export function backError(leaveAt: number, backAt: number | null) {
  if (backAt == null) return null;
  if (backAt < leaveAt + MIN_TRIP_MS) return 'backAt must be at least an hour after leaveAt';
  if (backAt > leaveAt + MAX_TRIP_MS) return 'a trip is at most 60 days';
  return null;
}
const CHECK_KEYS = ['waterHeater', 'unplug', 'mac'];
function checklistOf(v: unknown): Record<string, boolean> | null {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const e = Object.entries(v as Record<string, unknown>);
  if (e.some(([k, x]) => !CHECK_KEYS.includes(k) || typeof x !== 'boolean')) return null;
  return Object.fromEntries(e) as Record<string, boolean>;
}
/** A date change ({leaveAt?, backAt?}) for a live trip: the leave time only while planned; the arrival time while planned or active. */
export function parsePatch(b: any, t: Pick<Trip, 'state' | 'leaveAt' | 'backAt'>, now = Date.now()): { leaveAt: number; backAt: number | null } | { error: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !('leaveAt' in b || 'backAt' in b)) return { error: 'send leaveAt and/or backAt' };
  let leaveAt = t.leaveAt;
  if ('leaveAt' in b) {
    if (t.state !== 'planned') return { error: 'the trip has started; only the arrival time can change' };
    const l = time(b.leaveAt); if (l == null || Number.isNaN(l)) return { error: 'leaveAt must be a time' };
    if (l < now - LEAVE_SLACK_MS || l > now + MAX_TRIP_MS) return { error: 'leaveAt must be between now and 60 days ahead' };
    leaveAt = l < now ? now : l;
  }
  const back = 'backAt' in b ? time(b.backAt) : t.backAt;
  if (back !== null && Number.isNaN(back)) return { error: 'backAt must be a time' };
  if (back != null && back <= now) return { error: 'backAt must be in the future' };
  const err = backError(leaveAt, back); if (err) return { error: err };
  return { leaveAt, backAt: back };
}
/** The trip's phase at `now` (null once it is over). A planned trip whose leave time has passed reads as away: the tick starts it. */
export function tripPhase(t: Pick<Trip, 'state' | 'leaveAt' | 'backAt'> | null | undefined, now = Date.now()): TripPhase | null {
  if (!t || t.state === 'ended' || t.state === 'cancelled') return null;
  if (now < t.leaveAt) return 'planned';
  if (t.backAt == null || now < t.backAt) return 'away';
  return now < t.backAt + LATE_MS ? 'due' : 'late';
}
/** Whether the house is meant to be empty now (the trip under way, arrival time not yet passed by more than the late window included). */
export const isAway = (t: Pick<Trip, 'state' | 'leaveAt' | 'backAt'> | null | undefined, now = Date.now()) => { const p = tripPhase(t, now); return p != null && p !== 'planned'; };
/** Each Chicago day a trip covered for at least `minHours` (default 4), from its start to its end (or `now`). Days are YYYY-MM-DD. */
export function tripDaysOf(trips: Array<Pick<Trip, 'startedAt' | 'endedAt' | 'state'>>, from: string, to: string, now = Date.now(), minHours = 4): Set<string> {
  const out = new Set<string>();
  for (const t of trips) {
    if (t.startedAt == null || t.state === 'cancelled') continue;
    const a = t.startedAt, b = t.endedAt ?? now;
    for (let d = localDay(new Date(a)); d <= localDay(new Date(b)) && d <= to; d = addDays(d, 1)) {
      if (d < from) continue;
      const s = Math.max(a, localAt(d, 0)), e = Math.min(b, localAt(addDays(d, 1), 0));
      if (e - s >= minHours * 3600_000) out.add(d);
    }
  }
  return out;
}

/* ---------- the database ---------- */
const COLS = 'id, site_id, leave_at::text leave_at, back_at::text back_at, state, started_at::text started_at, ended_at::text ended_at, ended_by, detected, data';
/** The trip that is planned or under way, or null. */
export async function liveTrip(siteId: string): Promise<Trip | null> {
  const r = await one<Row>(`SELECT ${COLS} FROM trips WHERE site_id = $1 AND state IN ('planned', 'active') ORDER BY id DESC LIMIT 1`, [siteId]);
  return r ? toTrip(r) : null;
}
/** The newest trip that ended (for the report), or null. */
export async function lastEnded(siteId: string): Promise<Trip | null> {
  const r = await one<Row>(`SELECT ${COLS} FROM trips WHERE site_id = $1 AND state = 'ended' ORDER BY ended_at DESC NULLS LAST, id DESC LIMIT 1`, [siteId]);
  return r ? toTrip(r) : null;
}
/** Trips that touched [from, to] (YYYY-MM-DD), for the learning layer and History. */
export async function tripsBetween(siteId: string, from: string, to: string): Promise<Trip[]> {
  const rows = await q<Row>(`SELECT ${COLS} FROM trips WHERE site_id = $1 AND state IN ('active', 'ended') AND started_at IS NOT NULL
    AND started_at < $3 AND COALESCE(ended_at, $4) >= $2 ORDER BY started_at`, [siteId, localAt(from, 0), localAt(addDays(to, 1), 0), Date.now()]);
  return rows.map(toTrip);
}
/** The Chicago days in [from, to] that were trip days (4 h or more away). One query. */
export const tripDays = async (siteId: string, from: string, to: string, now = Date.now()) => tripDaysOf(await tripsBetween(siteId, from, to), from, to, now);

export class TripConflict extends Error {}
/** Save a new trip. Only one may be planned or under way: a second is refused (TripConflict). One that leaves now starts at once. */
export async function createTrip(siteId: string, v: { leaveAt: number; backAt: number | null; detected: boolean; checklist?: Record<string, boolean>; macHome?: boolean | null }, now = Date.now()): Promise<Trip> {
  if (await liveTrip(siteId)) throw new TripConflict('A trip is already planned or under way');
  const starts = v.leaveAt <= now, log: TripLog[] = [{ at: now, text: starts ? 'Vacation mode started' : 'Trip planned', delta: v.detected ? 'detected' : 'you' }];
  const r = (await one<Row>(`INSERT INTO trips (site_id, leave_at, back_at, state, started_at, detected, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
    [siteId, v.leaveAt, v.backAt, starts ? 'active' : 'planned', starts ? now : null, v.detected, JSON.stringify({ log, checklist: v.checklist ?? {}, macHome: v.macHome ?? null })]))!;
  return toTrip(r);
}
/** New dates for the live trip. */
export async function updateTrip(id: number, v: { leaveAt: number; backAt: number | null }, now = Date.now()) {
  const r = await one<Row>(`UPDATE trips SET leave_at = $2, back_at = $3, data = jsonb_set(data, '{log}', COALESCE(data->'log', '[]'::jsonb) || $4::jsonb)
    WHERE id = $1 AND state IN ('planned', 'active') RETURNING ${COLS}`, [id, v.leaveAt, v.backAt, JSON.stringify([{ at: now, text: 'Dates changed', delta: 'you' }])]);
  return r ? toTrip(r) : null;
}
/** Add lines to a trip's log (newest last; the oldest go past LOG_MAX). */
export async function logTrip(id: number, ...lines: TripLog[]) {
  await q(`UPDATE trips SET data = jsonb_set(data, '{log}', (SELECT COALESCE(jsonb_agg(x ORDER BY o), '[]'::jsonb) FROM (
      SELECT x, o FROM jsonb_array_elements(COALESCE(data->'log', '[]'::jsonb) || $2::jsonb) WITH ORDINALITY AS e(x, o) ORDER BY o DESC LIMIT ${LOG_MAX}) y)) WHERE id = $1`,
    [id, JSON.stringify(lines)]);
}
/** Merge keys into a trip's data (AC, pool and alert state the systems keep for the trip). */
export async function patchTripData(id: number, patch: Record<string, unknown>) {
  await q(`UPDATE trips SET data = data || $2::jsonb WHERE id = $1`, [id, JSON.stringify(patch)]);
}
/** End the live trip: a planned one is cancelled, one under way ends. Returns the trip as it was ended, or null when there was none. */
export async function endTrip(siteId: string, by: TripEndedBy, now = Date.now(), text?: string): Promise<Trip | null> {
  const t = await liveTrip(siteId); if (!t) return null;
  const state: TripState = t.state === 'planned' ? 'cancelled' : 'ended', endedBy: TripEndedBy = t.state === 'planned' ? 'cancelled' : by;
  const line = { at: now, text: text ?? (state === 'cancelled' ? 'Trip cancelled' : by === 'you' ? 'You ended Vacation mode' : by === 'home' ? 'Welcome home: Vacation mode ended' : 'Vacation mode ended after 60 days'), delta: endedBy };
  const r = await one<Row>(`UPDATE trips SET state = $2, ended_at = $3, ended_by = $4, data = jsonb_set(data, '{log}', COALESCE(data->'log', '[]'::jsonb) || $5::jsonb)
    WHERE id = $1 AND state IN ('planned', 'active') RETURNING ${COLS}`, [t.id, state, now, endedBy, JSON.stringify([line])]);
  return r ? toTrip(r) : null;
}

/**
 * The 5-minute lifecycle: a planned trip whose leave time has come starts (`started`); a trip under way for 60 days ends (`capped`).
 * Atomic per transition, so two overlapping cron invocations act once. Returns what changed (the caller runs each system's start/end).
 */
export async function tripTick(siteId: string, now = Date.now()): Promise<{ trip: Trip | null; started?: boolean; capped?: boolean }> {
  const t = await liveTrip(siteId); if (!t) return { trip: null };
  if (t.state === 'planned' && now >= t.leaveAt) {
    const r = await one<Row>(`UPDATE trips SET state = 'active', started_at = $2, data = jsonb_set(data, '{log}', COALESCE(data->'log', '[]'::jsonb) || $3::jsonb)
      WHERE id = $1 AND state = 'planned' RETURNING ${COLS}`, [t.id, now, JSON.stringify([{ at: now, text: 'Vacation mode started', delta: 'trip' }])]);
    return r ? { trip: toTrip(r), started: true } : { trip: await liveTrip(siteId) };
  }
  if (t.state === 'active' && t.startedAt != null && now - t.startedAt >= MAX_TRIP_MS) return { trip: await endTrip(siteId, 'cap', now), capped: true };
  return { trip: t };
}

/** Guest links rest while a trip is under way (a planned one whose leave time has come counts) and for 24 h after it ends (owner, Q14). */
export const GUEST_RESUME_MS = 864e5;
export async function guestsPaused(now = Date.now()) {
  return !!(await one(`SELECT 1 FROM trips WHERE (state IN ('planned', 'active') AND leave_at <= $1) OR (state = 'ended' AND ended_at > $2) LIMIT 1`, [now, now - GUEST_RESUME_MS]));
}
/** Whether this site has a trip under way now (one query). */
export const tripAway = async (siteId: string, now = Date.now()) => isAway(await liveTrip(siteId), now);
