// Vacation mode's routes and its 5-minute step (mockup ak). The trip rules live in trip.ts; each system's part of a trip registers a
// start/end hook here (AC, pool, Powerwalls, alerts, guests, the report), so a trip that starts or ends — by your tap, at its leave time,
// or on a sign of someone home — runs every system's part once, in one place, and each outcome goes in the trip's log.
//   GET  /api/vacation                 the live trip (planned or under way) with its phase, and the last trip that ended
//   POST /api/vacation                 {leaveAt, backAt?, detected?, checklist?, macHome?}: plan a trip (or start it, leaving now)
//   PATCH /api/vacation                {leaveAt?, backAt?}: change the dates (the leave time only before it starts)
//   POST /api/vacation/end             end it ("I'm home"), or cancel one that hasn't started
//   GET  /api/vacation/check           "Before you go": the pool circuits left on, the water, a Clear-up, the thermostat (reads only)
//   POST /api/vacation/snooze          "I'm just out": no "Looks like you're away" push for 24 h
//   POST /api/vacation/answer          {answer: 'allowed' | 'unexpected'} to "Someone set the thermostat"
// Owner-only: none is in redact.ts GUEST_GET, so the gate answers 401 to a guest (a guest must never learn the house is empty).
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { kv } from '../db.js';
import { localDay } from '../tesla/client.js';
import { liveTrip, lastEnded, createTrip, updateTrip, endTrip, tripTick, tripPhase, logTrip, patchTripData, parseTripBody, parsePatch, TripConflict, type Trip, type TripEndedBy } from './trip.js';

export type TripHook = (siteId: string, trip: Trip, now: number) => Promise<unknown>;
/** Each system's part of a trip's start and end, registered at import (app.ts). Run in registration order; a failure is logged, never thrown. */
export const tripHooks: { start: Record<string, TripHook>; end: Record<string, TripHook> } = { start: {}, end: {} };

async function runHooks(kind: 'start' | 'end', siteId: string, trip: Trip, now: number) {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(tripHooks[kind])) {
    out[name] = await fn(siteId, trip, now).catch(async (e: unknown) => {
      const msg = (e as Error)?.message ?? String(e);
      console.error(`[solstice] vacation ${kind} ${name} failed for ${siteId}: ${msg}`);
      await logTrip(trip.id, { at: now, text: `${name}: ${msg}`, delta: 'error' }).catch(() => {});
      return { error: msg };
    });
  }
  return out;
}
/** Start a trip that leaves now, or end the live one, with every system's part. */
export async function startedNow(siteId: string, trip: Trip, now = Date.now()) { return runHooks('start', siteId, trip, now); }
export async function finishTrip(siteId: string, by: TripEndedBy, now = Date.now(), text?: string) {
  const t = await endTrip(siteId, by, now, text); if (!t) return null;
  if (t.state === 'ended') await runHooks('end', siteId, t, now);
  return t;
}

/** Every 5 minutes, before the thermostat sample: start a trip whose leave time has come; end one at the 60-day cap. */
export async function vacationTick(siteId: string, now = Date.now()) {
  const r = await tripTick(siteId, now);
  if (r.started && r.trip) return { started: r.trip.id, hooks: await runHooks('start', siteId, r.trip, now) };
  if (r.capped && r.trip) return { capped: r.trip.id, hooks: await runHooks('end', siteId, r.trip, now) };
  return { trip: r.trip?.id ?? null, phase: tripPhase(r.trip, now) };
}

/** The answer of every route: the live trip and its phase, and the last trip that ended (its report, once there is one). */
export async function vacationState(siteId: string, now = Date.now()) {
  const [trip, last] = await Promise.all([liveTrip(siteId), lastEnded(siteId)]);
  return { now, trip, phase: tripPhase(trip, now), last: last ? { id: last.id, leaveAt: last.leaveAt, backAt: last.backAt, startedAt: last.startedAt, endedAt: last.endedAt, endedBy: last.endedBy, report: last.data.report ?? null } : null };
}

/** Injected by app.ts: the departure check (vacation/pool.ts leftOn, the water and the thermostat), read-only. */
export const departure: { check: ((siteId: string) => Promise<unknown>) | null } = { check: null };

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
/** Mounted by app.ts after requireSite (owner-only through the gate). */
export function vacationRoutes(app: Express) {
  app.get('/api/vacation', wrap(async (req, res) => res.json(await vacationState(req.siteId!))));
  app.post('/api/vacation', express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const now = Date.now(), v = parseTripBody(req.body, now);
    if ('error' in v) return res.status(400).json({ error: v.error });
    let trip: Trip;
    try { trip = await createTrip(req.siteId!, v, now); }
    catch (e) { if (e instanceof TripConflict) return res.status(409).json({ error: e.message }); throw e; }
    if (trip.state === 'active') await runHooks('start', req.siteId!, trip, now);
    res.json(await vacationState(req.siteId!));
  }));
  app.patch('/api/vacation', express.json({ limit: '1kb' }), wrap(async (req, res) => {
    const now = Date.now(), t = await liveTrip(req.siteId!);
    if (!t) return res.status(409).json({ error: 'No trip is planned or under way' });
    const v = parsePatch(req.body, t, now);
    if ('error' in v) return res.status(400).json({ error: v.error });
    await updateTrip(t.id, v, now);
    res.json(await vacationState(req.siteId!));
  }));
  /** "I'm just out" on the "Looks like you're away" push: no more of those for 24 h. */
  app.post('/api/vacation/snooze', wrap(async (req, res) => { await kv.set(`${req.siteId}:vacation:snooze`, Date.now() + 864e5); res.json({ ok: true }); }));
  /** The answer to "Is someone home?" during a trip: {answer: 'allowed'} (no more asks today) or {answer: 'unexpected'}; "I'm home" is /end. */
  app.post('/api/vacation/answer', express.json({ limit: '1kb' }), wrap(async (req, res) => {
    const t = await liveTrip(req.siteId!), a = String(req.body?.answer ?? '');
    if (!t || t.state !== 'active') return res.status(409).json({ error: 'No trip is under way' });
    if (a !== 'allowed' && a !== 'unexpected') return res.status(400).json({ error: 'answer must be allowed or unexpected' });
    const now = Date.now();
    if (a === 'allowed') await patchTripData(t.id, { watch: { ...((t.data.watch as object) ?? {}), allowedDay: localDay(new Date(now)) } });
    await logTrip(t.id, { at: now, text: a === 'allowed' ? 'You said someone is allowed in today' : 'You said nobody was expected', delta: 'you' });
    res.json(await vacationState(req.siteId!));
  }));
  /** The sheet's "Before you go": what is left on at the pool, the water, a Clear-up, the thermostat (reads only). */
  app.get('/api/vacation/check', wrap(async (req, res) => res.json(departure.check ? await departure.check(req.siteId!) : {})));
  app.post('/api/vacation/end', wrap(async (req, res) => {
    if (!(await liveTrip(req.siteId!))) return res.status(409).json({ error: 'No trip is planned or under way' });
    await finishTrip(req.siteId!, 'you');
    res.json(await vacationState(req.siteId!));
  }));
}
