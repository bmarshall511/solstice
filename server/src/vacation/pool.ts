// The pool during a Vacation-mode trip (mockup ak frames 1, 2 and 7; owner's answers 2026-10-06). Pool Autopilot plans each trip day
// for 1 turnover (1.5 when the water is 80 °F or warmer; +0.5 in a heat wave or 88 °F water) on the sunniest hours, with no daily skim
// (the rain rule still adds one after heavy rain). The day you come back gets the normal plan, written at the evening run before it.
// The trip plan waits while a Clear-up runs (Autopilot already holds) or while your last water test said hazy, cloudy or green. The
// spare-solar speed-ups pause. A pump run outside the plan during a trip (a pool service, the panel) goes in the trip's log instead of the
// pool's learning. Freeze protection is the controller's own and is never touched. The departure check lists what is left on.
import { one, kv } from '../db.js';
import { localAt, addDays } from '../tesla/client.js';
import { forbiddenCircuit } from '../appliances/guards.js';
import type { PoolSnapshot } from '../appliances/screenlogic.js';
import { logTrip, liveTrip, isAway, type Trip } from './trip.js';
import { notify } from '../notify.js';
import { localDay } from '../tesla/client.js';

export const TRIP_GOAL = 1, TRIP_GOAL_WARM = 1.5, WARM_WATER_F = 80, HOT_WATER_F = 88, HEAT_WAVE_DAYS = 3;

/* ---------- pure ---------- */
/** Whether `date` (YYYY-MM-DD) is planned as a trip day: the trip has left by noon and you are not back before the day ends. */
export function poolTripDay(t: Pick<Trip, 'state' | 'leaveAt' | 'backAt'> | null | undefined, date: string) {
  if (!t || (t.state !== 'planned' && t.state !== 'active')) return false;
  return t.leaveAt <= localAt(date, 12) && (t.backAt == null || t.backAt >= localAt(addDays(date, 1), 0));
}
/** The trip's turnover goal for a day, and why. */
export function tripGoal(waterF: number, heatDays: number): { goal: number; why: string[] } {
  const warm = waterF >= WARM_WATER_F, goal = warm ? TRIP_GOAL_WARM : TRIP_GOAL, why = [`Vacation: ${goal} turnover${goal === 1 ? '' : 's'} a day (water ${Math.round(waterF)}°F)`];
  if (heatDays >= HEAT_WAVE_DAYS || waterF >= HOT_WATER_F) return { goal: goal + .5, why: [...why, `+0.5 turnover: ${waterF >= HOT_WATER_F ? `water at ${Math.round(waterF)}°F` : `day ${heatDays} of a heat wave`}`] };
  return { goal, why };
}
/** What the departure check flags: a light, the spa, the blower or jets left on (with a day's kWh at their draw), and spa heat. */
export type LeftOn = { id: number; name: string; kind: 'light' | 'spa' | 'blower' | 'jets' | 'heat'; watts: number | null; kwhPerDay: number | null };
export function leftOn(snap: Pick<PoolSnapshot, 'circuits' | 'bodies' | 'pump'> | null, loads: Record<string, number>, W: (rpm: number) => number): LeftOn[] {
  if (!snap) return [];
  const out: LeftOn[] = [];
  for (const c of snap.circuits.filter(x => x.on)) {
    const why = forbiddenCircuit(c.id, c), name = c.name.replace(/[<>&"'`]/g, '').trim();
    const kind: LeftOn['kind'] | null = why === 'a light' ? 'light' : why === 'the spa' ? 'spa' : /jet/i.test(c.name) ? 'jets' : why?.startsWith('spa-related') ? 'blower' : null;
    if (!kind) continue;
    const rpm = snap.pump?.circuits.find(p => p.circuitId === c.id)?.speed ?? null, watts = loads[String(c.id)] ?? (rpm ? Math.round(W(rpm)) : null);
    out.push({ id: c.id, name, kind, watts, kwhPerDay: watts != null ? Math.round(watts * 24 / 100) / 10 : null });
  }
  if (snap.bodies?.[1]?.heatMode) out.push({ id: -1, name: 'Spa heat', kind: 'heat', watts: null, kwhPerDay: null });
  return out;
}

/* ---------- database ---------- */
/** The last water test's clarity when it wasn't clear ('hazy' | 'cloudy' | 'green'), else null. */
export async function cloudyWater(siteId: string): Promise<string | null> {
  const r = await one<{ clarity: string }>(`SELECT clarity FROM pool_tests WHERE site_id = $1 ORDER BY at DESC LIMIT 1`, [siteId]);
  return r && r.clarity !== 'clear' ? r.clarity : null;
}
/** Whether a trip is under way now (for the spare-solar pause and outside runs). */
export const awayNow = async (siteId: string, now = Date.now()) => { const t = await liveTrip(siteId); return isAway(t, now) ? t : null; };
/** A pump run outside the plan during a trip: one line in the trip's log per hour (it is not counted as your run). */
export async function tripOutsideRun(siteId: string, trip: Trip, now = Date.now(), o: { runOnce?: boolean } = {}) {
  const hourKey = `${siteId}:vacation:outsideRun`, h = Math.floor(now / 3600_000);
  if (await kv.get<number>(hourKey) === h) return;
  await kv.set(hourKey, h);
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(now));
  // a run-once (egg-timer) schedule on the controller is named as the cause; otherwise a pool service or the panel
  if (o.runOnce) {
    await logTrip(trip.id, { at: now, text: `A run-once schedule on the controller ran the pump at ${clock}`, delta: 'pool' });
    await notify(siteId, 'vacation', 'The pool pump ran on a controller schedule', `Seen running at ${clock} on a run-once schedule set on the panel, not Solstice's plan.`, { trip: trip.id },
      { key: `vac:poolpanel:${trip.id}:${localDay(new Date(now))}`, now, url: '/?go=v-sys&p=pool' });
    return;
  }
  await logTrip(trip.id, { at: now, text: `The pump ran outside the plan at ${clock} (a pool service, or the panel)`, delta: 'pool' });
  await notify(siteId, 'vacation', 'The pool pump was started outside the plan', `Seen running at ${clock}. A pool service visit, or someone at the panel.`, { trip: trip.id },
    { key: `vac:poolpanel:${trip.id}:${localDay(new Date(now))}`, now, url: '/?go=v-sys&p=pool' });
}
