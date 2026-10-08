// Deep history back-fill (idea I-16): every missing day from the install date up to where syncSite's 400-day window starts.
// syncSite (opening the app, the nightly) keeps its 400-day window, so opening the app never asks Tesla for thousands of days.
// This step rides the 5-minute cron instead, at night only (01:30–06:00 Chicago), at most 3 days a tick, newest missing day first,
// going backwards from a cursor in kv. Days are fetched and stored by sync.ts's own fetchDay and markSynced, so the rows are the
// normal format (local RFC3339 ts, Chicago day/hour, the per-path columns, the DST-safe day window) and a day with no buckets is
// never marked synced. A day Tesla answers empty (before the system produced) is recorded in the state's `empty` list and passed,
// so it isn't asked for again every night.
// Idle ticks stay free: outside the window the step returns before any query; once the back-fill is done (kv
// `<site>:backfill:deep:done`) each instance remembers it, so later ticks return before any query too (one read per cold instance).
import { q, one, kv } from './db.js';
import { config } from './config.js';
import { fetchDay, markSynced } from './sync.js';
import { rfc3339, localDay, addDays } from './tesla/client.js';

/** The night window, minutes of the Chicago day, [from, to): 01:30–06:00. */
export const DEEP_WINDOW = { from: 90, to: 360 };
/** Days fetched from Tesla per tick at most (each is one energy and one soe call). */
export const DEEP_DAYS_PER_TICK = 3;
/** From the cron handler's start: nothing of this step runs past 40 s, which leaves 20 s of the function's 60. */
export const DEEP_STOP_MS = 40_000;
/** A day starts only with this much left before the stop: one Fleet call's 12 s deadline plus storing the day. */
export const DEEP_DAY_MS = 13_000;
/** After Tesla still answers 429 (the client has already backed off and retried), the back-fill rests this long. */
export const DEEP_BACKOFF_MS = 30 * 60_000;
/** A day that fails (not a 429) this many times is passed over and listed in `skipped`, so it can't block the rest. */
export const DEEP_TRIES = 3;

export type DeepState = {
  from?: string; through?: string; cursor?: string;   // cursor: the next day to look at, going backwards
  empty?: string[]; skipped?: string[]; tries?: Record<string, number>;
  backoffUntil?: number; at?: number; filled?: number; last?: string[];
};
export const deepKey = (siteId: string) => `${siteId}:backfill:deep`;
export const deepDoneKey = (siteId: string) => `${siteId}:backfill:deep:done`;
const claimKey = (siteId: string) => `${siteId}:backfill:deep:claim`;

/** Sites this instance has seen finished: their ticks return before any query. */
const doneHere = new Set<string>();
/** Set when a whole pass found every site done: the cron handler then skips the step (and its site list query) entirely. */
let allDone = false;
/** Tests: forget the per-instance cache (a cold instance). */
export const resetDeepCache = () => { doneHere.clear(); allDone = false; };
/** Record a pass's results (site → deepTick result): all done → later ticks on this instance skip the step. */
export const notePass = (results: Record<string, unknown>) => {
  const rs = Object.values(results) as Array<{ skipped?: string; done?: boolean } | null>;
  allDone = rs.length > 0 && rs.every(r => r?.skipped === 'done' || r?.done === true);
};

const minuteOf = (now: number) => { const t = rfc3339(new Date(now)); return +t.slice(11, 13) * 60 + +t.slice(14, 16); };
/** Whether `now` is inside the night window (no database, no Tesla). */
export const inDeepWindow = (now: number) => { const m = minuteOf(now); return m >= DEEP_WINDOW.from && m < DEEP_WINDOW.to; };
/** Whether the cron handler should run the step at all: inside the window and not known finished on this instance. No database. */
export const deepDue = (now: number) => inDeepWindow(now) && !allDone;

/** The deep range for a site: the install day through the day before syncSite's window starts (it covers today − backfillDays … yesterday). */
export function deepRange(today: string, installed: string | null | undefined) {
  if (!installed) return null;
  const through = addDays(today, -config.backfillDays - 1);
  return { from: installed, through, empty: installed > through };
}
const daysBetween = (from: string, through: string) => Math.max(0, Math.round((Date.parse(through) - Date.parse(from)) / 864e5) + 1);

/**
 * One tick of the deep back-fill for a site. `stopAt` is the epoch ms after which nothing new starts (the handler's start + 40 s).
 * Returns what it did, or `{ skipped }` (the cron ledger marks it so); `{ error }` only for a failure worth a look.
 */
export async function deepTick(siteId: string, now: number, o: { stopAt: number }) {
  if (!inDeepWindow(now)) return { skipped: 'outside 01:30–06:00' };
  if (doneHere.has(siteId)) return { skipped: 'done' };
  if (await kv.get(deepDoneKey(siteId))) { doneHere.add(siteId); return { skipped: 'done' }; }
  const st = (await kv.get<DeepState>(deepKey(siteId))) ?? {};
  if (st.backoffUntil && now < st.backoffUntil) return { skipped: 'tesla back-off', until: st.backoffUntil };
  // single flight: an overlapping tick (a slow one and the next) leaves the work to the first
  if (!(await kv.claim(claimKey(siteId), 4 * 60_000, now))) return { skipped: 'already running' };

  const site = await one<{ acct: number | null; installed: string | null }>(
    `SELECT tesla_account_id acct, substr(info->>'installation_date', 1, 10) installed FROM sites WHERE id = $1`, [siteId]);
  if (!site?.acct) return { skipped: 'no Tesla account' };
  const range = deepRange(localDay(new Date(now)), site.installed);
  if (!range) return { skipped: 'install date not known yet' };   // site info comes with the first sync
  const { from, through } = range;
  const finish = async (extra: Record<string, unknown> = {}) => {
    await kv.set(deepKey(siteId), { ...st, from, through, cursor: addDays(from, -1), at: now, tries: {} });
    await kv.set(deepDoneKey(siteId), { at: now, from, through });
    doneHere.add(siteId);
    console.log(`[backfill] deep back-fill complete for ${siteId}: ${from} … ${through}`);
    return { done: true, from, through, ...extra };
  };
  if (range.empty) return finish();

  const have = new Set((await q<{ day: string }>(`SELECT day FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day >= $2 AND day <= $3`,
    [siteId, from, through])).map(r => r.day));
  const empty = new Set(st.empty ?? []), skipped = new Set(st.skipped ?? []), tries = { ...(st.tries ?? {}) };
  const filled: string[] = [], newlyEmpty: string[] = [], errors: string[] = [];
  let d = st.cursor && st.cursor <= through ? st.cursor : through, fetched = 0, backoffUntil: number | undefined;
  while (d >= from && fetched < DEEP_DAYS_PER_TICK) {
    if (have.has(d) || empty.has(d) || skipped.has(d)) { d = addDays(d, -1); continue; }
    if (Date.now() + DEEP_DAY_MS > o.stopAt) break;
    fetched++;
    try {
      await fetchDay(siteId, site.acct, d);
      if (await markSynced(siteId, d)) filled.push(d); else { empty.add(d); newlyEmpty.push(d); }
      delete tries[d];
      d = addDays(d, -1);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/HTTP 429/.test(msg)) { backoffUntil = now + DEEP_BACKOFF_MS; errors.push(`${d}: Tesla rate limit, resting 30 min`); break; }
      tries[d] = (tries[d] ?? 0) + 1;
      errors.push(`${d}: ${msg}`);
      if (tries[d] >= DEEP_TRIES) { skipped.add(d); delete tries[d]; d = addDays(d, -1); }
      break;
    }
  }
  // past the install day with nothing left over: done
  if (d < from && !backoffUntil) {
    st.empty = [...empty].sort(); st.skipped = [...skipped].sort();
    return finish({ filled, empty: newlyEmpty });
  }
  const next: DeepState = { from, through, cursor: d, empty: [...empty].sort(), skipped: [...skipped].sort(), tries, at: now,
    filled: (st.filled ?? 0) + filled.length, last: filled, ...(backoffUntil ? { backoffUntil } : {}) };
  await kv.set(deepKey(siteId), next);
  if (filled.length || newlyEmpty.length) console.log(`[backfill] deep: ${filled.length} day(s) stored${newlyEmpty.length ? `, ${newlyEmpty.length} empty` : ''}, next ${d}`);
  const out = { filled, empty: newlyEmpty, cursor: d, ...(backoffUntil ? { backoffUntil } : {}) };
  // a 429 is Tesla asking to slow down, not a fault: reported, not an error mark on the cron ledger
  return errors.length && !backoffUntil ? { ...out, error: errors[0] } : errors.length ? { ...out, note: errors[0] } : out;
}

/**
 * Progress for GET /api/status (owner only: the guest view's allow-list leaves it out). `daysDone` counts the deep range's stored
 * days plus the days Tesla had nothing for (and any passed over), so it reaches `daysTotal` when the back-fill is done. Null until
 * the install date is known.
 */
export async function deepStatus(siteId: string, now = Date.now()) {
  const site = await one<{ installed: string | null }>(`SELECT substr(info->>'installation_date', 1, 10) installed FROM sites WHERE id = $1`, [siteId]);
  const range = deepRange(localDay(new Date(now)), site?.installed);
  if (!range) return null;
  const { from, through } = range;
  const [st, done, stored] = await Promise.all([kv.get<DeepState>(deepKey(siteId)), kv.get(deepDoneKey(siteId)),
    range.empty ? Promise.resolve({ n: 0 }) : one<{ n: number }>(`SELECT COUNT(*)::int n FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day >= $2 AND day <= $3`, [siteId, from, through])]);
  const inRange = (xs?: string[]) => (xs ?? []).filter(x => x >= from && x <= through).length;
  const daysTotal = range.empty ? 0 : daysBetween(from, through);
  return { from, through, daysDone: Math.min(daysTotal, (stored?.n ?? 0) + inRange(st?.empty) + inRange(st?.skipped)), daysTotal, done: !!done };
}
