// What each 5-minute tick of /api/cron/nest does (owner decisions Q17 and Q18, docs/audit-2026-09.md):
//  - Nest: a thermostat sample, with Autopilot's acTick, every 5 minutes from 10:00 to 22:00 Chicago time in cooling season
//    (May–October by calendar month; the app has no daily-high rule to reuse), every 15 minutes otherwise.
//  - Pool: a read-only ScreenLogic status read (pump RPM and watts, circuits, temperatures) every 15 minutes while the current pump
//    schedule has the pump on, plus checks at 02:05 and 05:05. With Pool 10a–7p and High Speed 2p–3p that is 36 + 2 = 38 reads a day.
//    Reads sit 5 minutes into each quarter-hour (:05, :20, :35, :50): schedules start and change speed on the quarter-hour, and a
//    read right then can catch the pump priming. Readings go to pool_readings. Only readPool is imported from screenlogic.ts:
//    nothing here can write to the controller.
// Sampling slots are aligned to the clock (Nest :00, :05, … or :00, :15, :30, :45; pool :05, :20, :35, :50) and claimed in kv, so
// overlapping invocations agree and a slot is sampled once. A tick with nothing due returns before touching the database, so Neon
// can suspend between samples.
import { q, kv } from '../db.js';
import { rfc3339 } from '../tesla/client.js';
import { configured as poolConfigured, readPool, type PoolSnapshot } from './screenlogic.js';
import { recordReading, pumpSchedules, scheduledQuarters } from './pool.js';
import { nestConfigured, nestLinked } from './nest.js';

const MIN = 60_000;
/** The cron fires every 5 minutes (vercel.json). */
export const TICK_MIN = 5;
/** Cooling season, by Chicago calendar month (1–12): May–October. */
export const COOLING_MONTHS: readonly number[] = [5, 6, 7, 8, 9, 10];
/** The daytime window of 5-minute Nest samples in cooling season, minutes of the Chicago day, [from, to). */
export const COOLING_WINDOW = { from: 10 * 60, to: 22 * 60 };
/** The overnight pool checks, minutes of the Chicago day: 02:05 and 05:05. */
export const POOL_CHECKS: readonly number[] = [2 * 60 + 5, 5 * 60 + 5];
export const POOL_READ_MIN = 15;
/** Pool read slots start this many minutes into each quarter-hour (:05, :20, :35, :50), clear of a schedule's start or speed change. */
export const POOL_READ_OFFSET_MIN = 5;

/** Chicago calendar month (1–12) and minute of the day. */
export function chicago(now: number) {
  const t = rfc3339(new Date(now));
  return { month: Number(t.slice(5, 7)), minute: Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) };
}
export const coolingSeason = (now: number) => COOLING_MONTHS.includes(chicago(now).month);
/** Minutes between Nest samples at this moment: 5 inside the cooling-season window, 15 otherwise. */
export function nestInterval(now: number): 5 | 15 {
  const { minute } = chicago(now);
  return coolingSeason(now) && minute >= COOLING_WINDOW.from && minute < COOLING_WINDOW.to ? 5 : 15;
}
/** Start of the slot `now` falls in. Slots are epoch-aligned; Chicago's UTC offset is whole hours, so they sit on the local :00/:15/… too. */
export const slotStart = (now: number, intervalMin: number) => Math.floor(now / (intervalMin * MIN)) * intervalMin * MIN;
/** Whether this is the slot's first cron tick (every tick for 5-minute slots; the :00/:15/:30/:45 tick for 15-minute slots). */
export const firstTick = (now: number, intervalMin: number) => now - slotStart(now, intervalMin) < TICK_MIN * MIN;
/** Start of the pool read slot `now` falls in: quarter-hours shifted by POOL_READ_OFFSET_MIN (…:05, :20, :35, :50). */
export const poolSlotStart = (now: number) => slotStart(now - POOL_READ_OFFSET_MIN * MIN, POOL_READ_MIN) + POOL_READ_OFFSET_MIN * MIN;
/** Whether this is the pool read slot's first cron tick (the :05/:20/:35/:50 tick). */
export const poolFirstTick = (now: number) => now - poolSlotStart(now) < TICK_MIN * MIN;

/** Whether a Nest sample is due at this tick, given the last sample time (null: none yet). */
export function nestDue(now: number, lastAt: number | null) {
  const i = nestInterval(now);
  return firstTick(now, i) && (lastAt == null || lastAt < slotStart(now, i));
}
/** Whether the quarter-hour holding `minute` gets a pool read: an overnight check, or the pump is scheduled on (`scheduled`: 96 quarter-hours). */
export function poolReadQuarter(minute: number, scheduled: readonly boolean[] | null) {
  const qi = Math.floor(minute / POOL_READ_MIN);
  return POOL_CHECKS.some(c => Math.floor(c / POOL_READ_MIN) === qi) || !!scheduled?.[qi];
}
/** Whether a pool read is due at this tick, given the pump's scheduled quarter-hours and the last read (null: none yet). */
export function poolDue(now: number, scheduled: readonly boolean[] | null, lastAt: number | null) {
  return poolFirstTick(now) && (lastAt == null || lastAt < poolSlotStart(now)) && poolReadQuarter(chicago(now).minute, scheduled);
}
/** The minutes of the day a pool read happens for a set of pump schedules, in order. */
export const poolReadMinutes = (schedules: Parameters<typeof scheduledQuarters>[0]) => {
  const sched = scheduledQuarters(schedules);
  return Array.from({ length: 96 }, (_, i) => i * POOL_READ_MIN + POOL_READ_OFFSET_MIN).filter(m => poolReadQuarter(m, sched));
};
/** False when no sample or read could be due at this tick; the caller then returns without touching the database or a device. */
export const tickMayBeDue = (now: number) => firstTick(now, nestInterval(now)) || poolFirstTick(now);

const debug = (now: number, what: string) => console.debug(`[solstice] cron ${new Date(now).toISOString()}: ${what}`);
/** Take the slot starting at `from` for `key`: true only when no claim at or after `from` is recorded. Atomic, so two overlapping invocations can't both win. */
async function claimSlot(key: string, now: number, from: number) {
  const rows = await q(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE COALESCE((kv.value->>'at')::float8, 0) < $3 RETURNING key`, [key, JSON.stringify({ at: now }), from]);
  return rows.length === 1;
}
export const nestSampleKey = (siteId: string) => `${siteId}:nest:sampledAt`;
export const poolReadKey = (siteId: string) => `${siteId}:pool:readAt`;

/** Sample Nest and run acTick (`sample`) when due. acTick reads the thermostat, stores the reading and applies a due plan step. */
export async function nestTick(siteId: string, now: number, sample: () => Promise<unknown>) {
  if (!nestConfigured()) return { skipped: 'nest not configured' };
  const every = nestInterval(now);
  if (!firstTick(now, every)) { debug(now, `nest skipped (every ${every} min)`); return { skipped: 'not due', every }; }
  if (!(await nestLinked())) return { skipped: 'nest not linked' };
  if (!(await claimSlot(nestSampleKey(siteId), now, slotStart(now, every)))) { debug(now, 'nest already sampled in this slot'); return { skipped: 'already sampled', every }; }
  try { return { every, tick: await sample() }; }
  catch (e: any) { console.error(`[solstice] cron nest sample failed for ${siteId}: ${e?.message ?? e}`); return { every, error: String(e?.message ?? e) }; }
}

/**
 * Read the pool read-only when due. The schedule comes from the last snapshot (kv `pool:last`), or right after Autopilot applied
 * a plan (which clears it) from `pool:applied`; with neither, only the overnight checks read. A read in this slot (the app's or an
 * earlier tick's) counts. A failed read is logged and skipped until the next due quarter-hour: the slot is claimed first.
 */
export async function poolTick(siteId: string, now: number) {
  if (!poolConfigured()) return { skipped: 'pool not configured' };
  if (!poolFirstTick(now)) { debug(now, 'pool skipped (reads at :05, :20, :35 and :50)'); return { skipped: 'not due' }; }
  const last = await kv.get<PoolSnapshot | null>(`${siteId}:pool:last`) ?? null;
  const sched = last?.pump ? pumpSchedules(last).schedules : (await kv.get<{ plan?: { schedules?: Array<{ circuitId: number; start: number; stop: number }> } } | null>(`${siteId}:pool:applied`))?.plan?.schedules ?? null;
  const from = poolSlotStart(now);
  if (!poolReadQuarter(chicago(now).minute, sched ? scheduledQuarters(sched) : null)) { debug(now, 'pool skipped (pump not scheduled)'); return { skipped: 'pump not scheduled' }; }
  if (last && last.at >= from) { debug(now, 'pool already read this quarter-hour'); return { skipped: 'already read' }; }
  if (!(await claimSlot(poolReadKey(siteId), now, from))) { debug(now, 'pool already tried this quarter-hour'); return { skipped: 'already tried' }; }
  try {
    const snap = await readPool();
    await recordReading(siteId, snap);
    return { read: true, at: snap.at, running: snap.pump?.running ?? null, rpm: snap.pump?.rpm ?? null, watts: snap.pump?.watts ?? null };
  } catch (e: any) {
    console.warn(`[solstice] cron pool read failed for ${siteId}, skipped until the next due quarter-hour: ${e?.message ?? e}`);
    return { read: false, error: String(e?.message ?? e) };
  }
}

/**
 * One cron tick for every site: the Nest sample (with acTick) and the pool read run side by side, each only when due.
 * `sites` and `acTick` come from app.ts (the site list and acTick with the owner's settings, rate and heat slope).
 */
export async function cronTick(now: number, o: { sites: () => Promise<string[]>; acTick: (siteId: string) => Promise<unknown> }) {
  if (!nestConfigured() && !poolConfigured()) return { skipped: 'nest and pool not configured' };
  if (!tickMayBeDue(now)) { debug(now, 'nothing due'); return { skipped: 'not due' }; }
  const out: Record<string, unknown> = {};
  for (const id of await o.sites()) {
    const [nest, pool] = await Promise.all([nestTick(id, now, () => o.acTick(id)), poolTick(id, now)]);
    out[id] = { nest, pool };
  }
  return out;
}
