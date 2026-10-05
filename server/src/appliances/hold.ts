// Manual holds on the thermostat (mockup v, owner decisions Q1–Q2 of docs/audit-2026-10.md).
// A change Solstice did not make — at the wall, in the Nest app, or the owner's own tap in Solstice — starts a hold: AC Autopilot
// skips its plan steps until the plan's next step, but never less than 2 h and never more than 8 h. "Resume now" ends it;
// "Hold until morning" runs it to the plan's morning step. Going Away (Nest Eco or Away until…) after the change ends it early.
// Detection: every value Solstice sends is recorded (kv `nest:lastSent:<device>`); a reading whose mode or setpoint moved from the
// previous reading, and does not match what Solstice last sent, is somebody else's change. Nest's own schedule is off (Q1), so
// such a change is a person at home. Pure helpers first, then the kv-backed ones.
import { kv } from '../db.js';
import { localDay, addDays, localAt } from '../tesla/client.js';
import type { NestState } from './nest.js';

export const HOLD_MIN_MS = 2 * 3600_000, HOLD_MAX_MS = 8 * 3600_000;
/** Two readings of a setpoint closer than this are the same value (Nest stores °C; °F round-trips to within 0.1). */
export const SAME_F = .6;
/** How long a value Solstice sent counts as "ours" when it shows up in a reading. */
export const SENT_FRESH_MS = 45 * 60_000;

export type HoldBy = 'app' | 'wall';
export type Hold = { at: number; by: HoldBy; mode: string; coolF: number | null; heatF: number | null; until: number; why: string; extended?: boolean };
export type Sent = { at: number; by: 'autopilot' | 'owner'; mode: string; coolF: number | null; heatF: number | null };
type Reading = Pick<NestState, 'mode' | 'coolF' | 'heatF' | 'eco'>;

export const holdKey = (siteId: string) => `${siteId}:ac:hold`;
export const sentKey = (deviceId: string) => `nest:lastSent:${deviceId}`;

const same = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? a == b : Math.abs(a - b) < SAME_F;
/** Whether the thermostat's mode or setpoints differ between two readings (Eco on either side never counts: presence handles Eco). */
export function changed(prev: Reading | null | undefined, next: Reading | null | undefined) {
  if (!prev || !next || prev.eco || next.eco) return false;
  return prev.mode !== next.mode || !same(prev.coolF, next.coolF) || !same(prev.heatF, next.heatF);
}
/** Whether a reading shows what Solstice itself last sent (recently enough to be that send). */
export function ours(next: Reading, sent: Sent | null | undefined, now: number) {
  if (!sent || now - sent.at > SENT_FRESH_MS) return false;
  if (sent.mode !== next.mode) return false;
  return (sent.coolF == null || same(sent.coolF, next.coolF)) && (sent.heatF == null || same(sent.heatF, next.heatF));
}

/** Epoch ms of a Chicago clock hour (may be fractional) on a day. */
export const atHour = (day: string, hour: number) => localAt(day, hour);
/**
 * When a hold that starts at `at` ends: the first plan step strictly after it (today's steps, then tomorrow's morning step),
 * at least 2 h and at most 8 h after `at`. Returns the end and a sentence for the banner.
 */
export function holdUntil(at: number, steps: Array<{ hour: number; why: string }>, morningHour: number, today = localDay(new Date(at))) {
  const times = [...steps.map(s => ({ t: atHour(today, s.hour), why: s.why })), { t: atHour(addDays(today, 1), morningHour), why: 'morning, comfort band' }]
    .filter(x => x.t > at).sort((a, b) => a.t - b.t);
  const next = times[0] ?? { t: at + HOLD_MAX_MS, why: '' };
  if (next.t - at < HOLD_MIN_MS) return { until: at + HOLD_MIN_MS, why: `the next step (${next.why}) is less than 2 h away, so the hold runs the 2-hour minimum` };
  if (next.t - at > HOLD_MAX_MS) return { until: at + HOLD_MAX_MS, why: 'holds run at most 8 hours' };
  return { until: next.t, why: `until the plan's next step (${next.why})` };
}
/** The plan's next morning step after `now` (today's if it is still ahead, otherwise tomorrow's). */
export function morningAfter(now: number, morningHour: number) {
  const today = localDay(new Date(now)), t = atHour(today, morningHour);
  return t > now ? t : atHour(addDays(today, 1), morningHour);
}
/** Whether a hold is over: past its end, or the house went Away after it began. */
export function holdOver(h: Hold, now: number, presence: { state: string; since: number | null }) {
  if (now >= h.until) return 'ended';
  if (presence.state === 'away' && (presence.since == null || presence.since > h.at)) return 'away';
  return null;
}

/* ---------- kv ---------- */
export const getHold = (siteId: string) => kv.get<Hold | null>(holdKey(siteId)).then(h => h ?? null);
export const setHold = (siteId: string, h: Hold | null) => kv.set(holdKey(siteId), h as any);
export const lastSent = (deviceId: string) => kv.get<Sent | null>(sentKey(deviceId)).then(s => s ?? null);
export const recordSent = (deviceId: string, s: Sent) => kv.set(sentKey(deviceId), s);
