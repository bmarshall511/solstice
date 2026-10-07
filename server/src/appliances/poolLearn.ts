// The pool learns from your changes (mockup ae). Two records in kv, both kept short:
//   <site>:pool:youRuns     Pool and High Speed runs you start from the app (boosts included), with their real length
//   <site>:pool:outsideRuns the pump seen running by an hourly read outside the schedule (the Pentair app, the panel), one hour each
// and two suggestions, each after 4 of the last 7 days and never applied by themselves:
//   skim  boosts you start within an hour of the same time of day → move the planner's daily skim hour there
//   goal  an hour or more of extra pump time a day → raise the turnover goal by half a turnover
// Clear-up days, Autopilot's spare-solar speed-ups and your own app runs are never counted as "outside".
import { awayNow, tripOutsideRun } from '../vacation/pool.js';
import { kv } from '../db.js';
import { localDay, addDays, rfc3339 } from '../tesla/client.js';

export type YouRun = { at: number; day: string; hour: number; id: number; minutes: number; boost: boolean };
export type OutsideRun = { at: number; day: string; hour: number };
export type PoolSuggestion = { key: string; kind: 'skim' | 'goal'; days: number; of: 7; hour?: number; from?: number | null; to?: number; extraMin?: number };
const youKey = (s: string) => `${s}:pool:youRuns`, outKey = (s: string) => `${s}:pool:outsideRuns`, dismissKey = (s: string) => `${s}:pool:suggestDismissed`;
export const NEED_DAYS = 4, EXTRA_MIN = 60, GOAL_STEP = .5, GOAL_MAX = 4;
const at = (ms: number) => { const t = rfc3339(new Date(ms)); return { day: t.slice(0, 10), hour: Number(t.slice(11, 13)) + Number(t.slice(14, 16)) / 60 }; };
const hourGap = (a: number, b: number) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

/** An app run of Pool or High Speed started (poolCommand). */
export async function noteYouRun(siteId: string, o: { id: number; minutes: number; boost: boolean }, now = Date.now()) {
  const runs = await kv.get<YouRun[]>(youKey(siteId)) ?? [];
  runs.unshift({ at: now, ...at(now), ...o }); await kv.set(youKey(siteId), runs.slice(0, 60));
}
/** Turned off early: the run counts only the minutes it ran. */
export async function endYouRun(siteId: string, id: number, now = Date.now()) {
  const runs = await kv.get<YouRun[]>(youKey(siteId)) ?? [], r = runs.find(x => x.id === id && x.at + x.minutes * 60_000 > now);
  if (!r) return; r.minutes = Math.max(1, Math.round((now - r.at) / 60_000)); await kv.set(youKey(siteId), runs);
}
/** An hourly read outside the schedule found the pump running (sampling.ts), unless Solstice itself explains it. */
export async function noteOutsideRun(siteId: string, now = Date.now()) {
  const [cu, spare, until] = await Promise.all([kv.get<{ until: number } | null>(`${siteId}:pool:clearup`), kv.get<{ until: number } | null>(`${siteId}:pool:spare`), kv.get<Record<string, number>>(`${siteId}:pool:until`)]);
  if ((cu && cu.until > now) || (spare && spare.until > now) || Object.values(until ?? {}).some(t => t > now)) return false;
  // Vacation mode: during a trip it was a pool service or the panel, not you; it goes in the trip's log, not the learning
  const trip = await awayNow(siteId, now); if (trip) { await tripOutsideRun(siteId, trip, now); return false; }
  const runs = await kv.get<OutsideRun[]>(outKey(siteId)) ?? [];
  runs.unshift({ at: now, ...at(now) }); await kv.set(outKey(siteId), runs.slice(0, 200));
  return true;
}

/** The last 7 days: your runs, the outside runs, the two patterns' progress, and any suggestion due (not dismissed in 14 days). */
export async function poolChanges(siteId: string, o: { goal: number; skimAt: number | null }, now = Date.now()) {
  const today = localDay(new Date(now)), since = addDays(today, -6);
  const you = (await kv.get<YouRun[]>(youKey(siteId)) ?? []).filter(r => r.day >= since), out = (await kv.get<OutsideRun[]>(outKey(siteId)) ?? []).filter(r => r.day >= since);
  // skim: boosts grouped by time of day (±1 h); the group with the most days
  const boosts = you.filter(r => r.boost);
  let skim: { hour: number; days: number } | null = null;
  for (const b of boosts) { const g = boosts.filter(x => hourGap(x.hour, b.hour) <= 1), days = new Set(g.map(x => x.day)).size;
    if (!skim || days > skim.days) skim = { hour: Math.round(median(g.map(x => x.hour))) % 24, days }; }
  // goal: days with an hour or more of extra pump time (app runs + outside runs)
  const extra = new Map<string, number>();
  for (const r of you) extra.set(r.day, (extra.get(r.day) ?? 0) + r.minutes);
  for (const r of out) extra.set(r.day, (extra.get(r.day) ?? 0) + 60);
  const goalDays = [...extra.values()].filter(m => m >= EXTRA_MIN).length, extraMin = goalDays ? Math.round([...extra.values()].filter(m => m >= EXTRA_MIN).reduce((a, m) => a + m, 0) / goalDays) : 0;
  const dismissed = await kv.get<Record<string, number>>(dismissKey(siteId)) ?? {}, fresh = (k: string) => !(dismissed[k] && now - dismissed[k] < 14 * 864e5);
  const suggestions: PoolSuggestion[] = [];
  if (skim && skim.days >= NEED_DAYS && skim.hour !== o.skimAt && fresh(`skim:${skim.hour}`)) suggestions.push({ key: `skim:${skim.hour}`, kind: 'skim', days: skim.days, of: 7, hour: skim.hour, from: o.skimAt });
  const to = Math.min(GOAL_MAX, o.goal + GOAL_STEP);
  if (goalDays >= NEED_DAYS && to > o.goal && fresh(`goal:${to}`)) suggestions.push({ key: `goal:${to}`, kind: 'goal', days: goalDays, of: 7, to, extraMin });
  const recent = [...you.map(r => ({ at: r.at, kind: r.boost ? 'boost' as const : 'run' as const, minutes: r.minutes })), ...out.map(r => ({ at: r.at, kind: 'outside' as const, minutes: 60 }))].sort((a, b) => b.at - a.at);
  return { recent, patterns: { skim: skim ? { ...skim, need: NEED_DAYS } : null, goal: { days: goalDays, need: NEED_DAYS, extraMin } }, suggestions };
}
export async function dismissPoolSuggestion(siteId: string, key: string, now = Date.now()) {
  const d = await kv.get<Record<string, number>>(dismissKey(siteId)) ?? {}; d[key] = now; await kv.set(dismissKey(siteId), d);
}
