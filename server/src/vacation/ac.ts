// The AC during a Vacation-mode trip (mockup ak frames 2, 3 and 5; owner's answers 2026-10-06). While the trip is under way the house
// holds 85 °F (cooling) or 55 °F (heating). If indoor humidity stays over 60% for 2 h the hold steps down 2° at a time, never below 80°,
// until it is under 55% (then back up, a step an hour). Before you're back the house cools to your day target (night target after 10 PM),
// starting early enough at the rate this house actually cools, on spare solar when the Powerwalls are full. Two hours past the arrival
// time with no sign of you, it goes back to the hold. Nest's Eco is turned off at the start (and again, at most every 6 h, if Home/Away
// Assist turns it back on) so Solstice's setpoint is the one that holds.
// Every write goes through guards.ts (2° a step, one per 30 min, 80–85 cooling / 50–60 heating while away; Autopilot Off writes nothing),
// and every change goes in the AC log and the trip's log. Pure pieces first, then the kv/database-backed step acTick calls.
import { q, kv } from '../db.js';
import { localDay, localAt, rfc3339 } from '../tesla/client.js';
import { TRIP_COOL, TRIP_HEAT, AC_MAX_STEP_F, guardCoolSetpoint, explainRefusal, GuardRefusal } from '../appliances/guards.js';
import { setCool, setHeat, tripEcoOff, lastSetpointWrite, type NestState } from '../appliances/nest.js';
import { spareNow, isSpare } from '../spare.js';
import { logTrip, patchTripData, tripPhase, type Trip, type TripPhase } from './trip.js';

export const HUMID_HIGH = 60, HUMID_OK = 55, HUMID_UP_MS = 2 * 3600_000, HUMID_DOWN_MS = 3600_000;
/** The readings must reach back to within one sample (15 minutes off-season, plus 5) of the window's start. */
const COVER_SLACK_MS = 20 * 60_000;
export const ECO_AGAIN_MS = 6 * 3600_000, WELCOME_BUFFER_H = .5, SOLAR_EARLY_H = 3, SOLAR_FROM_HOUR = 11, PULLDOWN_KEEP = 20;
export const TRIP_HEAT_F = 55;
/** What the AC remembers for a trip (trip.data.ac). */
export type TripAc = { humid: number; humidAt: number | null; heatF0: number | null; coolF0: number | null; ecoOffAt: number | null;
  welcome: { startAt: number; fromF: number | null; target: number; solar: boolean; reachedAt?: number } | null };
export const freshTripAc = (st: Pick<NestState, 'heatF' | 'coolF'> | null): TripAc => ({ humid: 0, humidAt: null, heatF0: st?.heatF ?? null, coolF0: st?.coolF ?? null, ecoOffAt: null, welcome: null });

/* ---------- pure ---------- */
/** The cooling hold: 85° less 2° per humidity step, never below 80°. */
export const holdF = (humid: number) => Math.max(TRIP_COOL.min, TRIP_COOL.max - AC_MAX_STEP_F * Math.max(0, humid));
/** The away heat: 55°, or lower if the thermostat already sat lower when the trip started (it is never raised), never below 50°. */
export const awayHeatF = (heatF0: number | null) => Math.max(TRIP_HEAT.min, Math.min(TRIP_HEAT_F, heatF0 ?? TRIP_HEAT_F));
/**
 * The humidity step after these readings (ts, rh), newest last. Up a step when every reading of the last 2 h is over 60% (and the
 * readings reach back to within a sample of 2 h ago) and the last change is 2 h old; down a step when every reading of the last hour is under 55% and the
 * last change is an hour old. Unchanged otherwise. `why` says what happened, for the logs.
 */
export function humidStep(level: number, readings: Array<{ ts: number; rh: number | null }>, now: number, changedAt: number | null): { level: number; why: string | null } {
  const rs = readings.filter(r => r.rh != null) as Array<{ ts: number; rh: number }>;
  const last2 = rs.filter(r => r.ts > now - HUMID_UP_MS), last1 = rs.filter(r => r.ts > now - HUMID_DOWN_MS);
  const since = (ms: number) => changedAt == null || now - changedAt >= ms;
  if (holdF(level) > TRIP_COOL.min && last2.length >= 2 && last2[0].ts <= now - HUMID_UP_MS + COVER_SLACK_MS && last2.every(r => r.rh > HUMID_HIGH) && since(HUMID_UP_MS))
    return { level: level + 1, why: `Humidity ${Math.round(Math.min(...last2.map(r => r.rh)))}–${Math.round(Math.max(...last2.map(r => r.rh)))}% for 2 h: holding ${holdF(level + 1)}° to dry the house` };
  if (level > 0 && last1.length >= 2 && last1[0].ts <= now - HUMID_DOWN_MS + COVER_SLACK_MS && last1.every(r => r.rh < HUMID_OK) && since(HUMID_DOWN_MS))
    return { level: level - 1, why: `Humidity under ${HUMID_OK}%: back up to ${holdF(level - 1)}°` };
  return { level, why: null };
}
/** The target for the arrival hour: your night target from nightFrom to nightTo, your day target otherwise. */
export function arrivalTarget(backAt: number, s: { dayF: number; nightF: number; nightFrom: number; nightTo: number }) {
  const h = +rfc3339(new Date(backAt)).slice(11, 13);
  return h >= s.nightFrom || h < s.nightTo ? s.nightF : s.dayF;
}
/** °F an hour this house cools at a day's high: the median of the measured welcomes within 5° of it, else 1.4 at 95°+, 1.6 at 88°+, 2 below. */
export function pulldownRate(samples: ReadonlyArray<{ high: number; rate: number }>, high: number | null) {
  const near = samples.filter(x => high == null || Math.abs(x.high - high) <= 5).map(x => x.rate).sort((a, b) => a - b);
  if (near.length >= 2) return Math.max(.5, Math.min(4, near[Math.floor(near.length / 2)]));
  return high != null && high >= 95 ? 1.4 : high != null && high >= 88 ? 1.6 : 2;
}
/** Hours ahead of arrival to start cooling from `indoorF` to `target` (half an hour of margin; at least that). */
export const welcomeLeadH = (indoorF: number | null, target: number, rate: number) => WELCOME_BUFFER_H + Math.max(0, ((indoorF ?? TRIP_COOL.max) - target) / rate);
/**
 * When the welcome starts: arrival − lead. Up to 3 h earlier when the Powerwalls are full and exporting (spare solar), from 11:00 on the
 * arrival day, so the pull-down runs on sunshine instead of the evening's battery or the grid.
 */
export function welcomeStart(o: { backAt: number; leadH: number; now: number; spare: boolean }): { startAt: number; solar: boolean } | null {
  const at = o.backAt - o.leadH * 3600_000;
  if (o.now >= at) return { startAt: o.now, solar: false };
  const day = localDay(new Date(o.backAt)), earliest = Math.max(at - SOLAR_EARLY_H * 3600_000, localAt(day, SOLAR_FROM_HOUR));
  if (o.spare && o.now >= earliest && localDay(new Date(o.now)) === day) return { startAt: o.now, solar: true };
  return null;
}
/**
 * What the thermostat should be set to now during a trip. `phase` from trip.ts; `welcome` once it has started. Cooling: the hold, or
 * the arrival target from the welcome's start through the 2 h after the arrival time; late: the hold again. Heating: away heat, or the
 * heat setpoint the trip started with from the welcome on.
 */
export function tripTarget(o: { phase: TripPhase; ac: TripAc; target: number }): { coolF: number; heatF: number; why: string; welcome: boolean } {
  const hold = holdF(o.ac.humid), heat = awayHeatF(o.ac.heatF0);
  const back = o.ac.heatF0 != null && o.ac.heatF0 >= TRIP_HEAT.min ? o.ac.heatF0 : heat;
  if (o.phase === 'late') return { coolF: hold, heatF: heat, why: 'not back yet: holding the trip setting', welcome: false };
  if (o.phase === 'due' || (o.phase === 'away' && o.ac.welcome)) return { coolF: o.target, heatF: back, why: o.ac.welcome?.solar ? 'welcome home, on spare solar' : 'welcome home', welcome: true };
  return { coolF: hold, heatF: heat, why: o.ac.humid ? 'vacation: drying the house' : 'vacation', welcome: false };
}

/* ---------- the step acTick runs during a trip ---------- */
type AcDetailLike = { settings: { autopilot: string; dayF: number; nightF: number; nightFrom: number; nightTo: number }; state: NestState | null; hold: unknown;
  log: Array<{ at: number; day: string; text: string; delta?: string }>; outdoorF: number | null };
export const pulldownKey = (siteId: string) => `${siteId}:vacation:pulldown`;
async function logAc(siteId: string, text: string, delta?: string, onceToday = false) {
  const log = await kv.get<AcDetailLike['log']>(`${siteId}:ac:log`) ?? [];
  if (onceToday && log.some(l => l.text === text && l.day === localDay())) return false;
  log.unshift({ at: Date.now(), day: localDay(), text, delta }); await kv.set(`${siteId}:ac:log`, log.slice(0, 40));
  return true;
}
/**
 * One 5-minute step of the AC during a trip under way (called by acTick with the fresh detail). Order: Autopilot Off → nothing; a hold
 * (someone changed it at the thermostat) → leave it; Eco on → turn it off (at most every 6 h); the humidity step; the welcome; then
 * one guarded write toward the target. Returns what it did.
 */
export async function tripAcTick(siteId: string, d: AcDetailLike, trip: Trip, now = Date.now()) {
  const s = d.settings, st = d.state, phase = tripPhase(trip, now);
  if (!st || !phase || phase === 'planned') return { trip: true, skipped: 'no thermostat reading' };
  if (s.autopilot === 'off') { await logAc(siteId, 'Vacation mode: AC Autopilot is Off, so the thermostat stays as it is', 'trip', true); return { trip: true, off: true }; }
  if (d.hold) return { trip: true, held: true };
  const ac: TripAc = { ...freshTripAc(null), ...((trip.data.ac as TripAc | undefined) ?? {}) };
  const save = (patch: Partial<TripAc>) => { Object.assign(ac, patch); return patchTripData(trip.id, { ac }); };
  if (st.eco) {
    if (ac.ecoOffAt != null && now - ac.ecoOffAt < ECO_AGAIN_MS) return { trip: true, eco: 'waiting' };
    try { await tripEcoOff(st.deviceId, s.autopilot, true); }
    catch (e) { if (e instanceof GuardRefusal) { await logAc(siteId, `Did not turn Eco off: ${explainRefusal(e.reason)}`, 'refused', true); return { trip: true, refused: e.reason }; } throw e; }
    await save({ ecoOffAt: now });
    await logAc(siteId, 'Vacation mode: turned Eco off so Solstice can hold the trip setting', 'trip');
    await logTrip(trip.id, { at: now, text: 'Turned Nest Eco off', delta: 'ac' });
    return { trip: true, ecoOff: true };   // the setpoint follows on the next tick, inside the 30-minute slot
  }
  // humidity: the last 2 h of readings
  const rows = await q<{ ts: string; humidity: number | null }>(`SELECT ts::text, humidity FROM nest_readings WHERE site_id = $1 AND ts > $2 ORDER BY ts`, [siteId, now - HUMID_UP_MS]);
  const hs = humidStep(ac.humid, rows.map(r => ({ ts: Number(r.ts), rh: r.humidity == null ? null : Number(r.humidity) })), now, ac.humidAt);
  if (hs.level !== ac.humid) { await save({ humid: hs.level, humidAt: now }); await logAc(siteId, hs.why!, 'humidity'); await logTrip(trip.id, { at: now, text: hs.why!, delta: 'ac' }); }
  // the welcome: when to start cooling for the arrival (once started it stays started)
  const target = trip.backAt != null ? arrivalTarget(trip.backAt, s) : s.dayF;
  if (phase === 'away' && trip.backAt != null && !ac.welcome && trip.backAt - now <= 12 * 3600_000) {
    const rate = pulldownRate(await kv.get<Array<{ high: number; rate: number }>>(pulldownKey(siteId)) ?? [], d.outdoorF);
    const w = welcomeStart({ backAt: trip.backAt, leadH: welcomeLeadH(st.indoorF, target, rate), now, spare: isSpare(await spareNow(siteId, now).catch(() => null)) });
    if (w) {
      await save({ welcome: { ...w, fromF: st.indoorF, target } });
      const text = `Welcome home: cooling from ${st.indoorF != null ? Math.round(st.indoorF) : '—'}° to ${target}° for ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(trip.backAt))}${w.solar ? ', on spare solar' : ''}`;
      await logAc(siteId, text, 'welcome'); await logTrip(trip.id, { at: now, text, delta: 'ac' });
    }
  }
  // the pull-down this house managed (for the next trip's start time)
  if (ac.welcome && !ac.welcome.reachedAt && st.indoorF != null && st.indoorF <= ac.welcome.target + .5) {
    const hours = (now - ac.welcome.startAt) / 3600_000, drop = (ac.welcome.fromF ?? st.indoorF) - st.indoorF;
    await save({ welcome: { ...ac.welcome, reachedAt: now } });
    if (hours >= .25 && drop >= 1 && d.outdoorF != null) {
      const list = await kv.get<Array<{ at: number; high: number; rate: number }>>(pulldownKey(siteId)) ?? [];
      list.unshift({ at: now, high: d.outdoorF, rate: Math.round(drop / hours * 100) / 100 }); await kv.set(pulldownKey(siteId), list.slice(0, PULLDOWN_KEEP));
    }
    await logTrip(trip.id, { at: now, text: `The house reached ${ac.welcome.target}°${hours >= .25 ? ` in ${Math.round(hours * 10) / 10} h` : ''}`, delta: 'ac' });
  }
  const t = tripTarget({ phase, ac, target });
  return { trip: true, phase, target: t, write: await writeToward(siteId, st, s.autopilot, t) };
}

/** One guarded write toward the trip target in the thermostat's own mode (Cool: the cooling setpoint; Heat: the heating one). */
async function writeToward(siteId: string, st: NestState, mode: string, t: ReturnType<typeof tripTarget>) {
  const lastAt = (await lastSetpointWrite(st.deviceId))?.at ?? null, now = Date.now();
  if (st.mode === 'COOL') {
    if (st.coolF != null && Math.abs(st.coolF - t.coolF) < .6) return 'at target';
    const g = guardCoolSetpoint({ mode, targetF: t.coolF, currentF: st.coolF, lastWriteAt: lastAt, now });
    if (!g.ok) return logRefusal(siteId, t.coolF, t.why, g.reason);
    try { await setCool(st.deviceId, g.value, mode); } catch (e) { if (e instanceof GuardRefusal) return logRefusal(siteId, t.coolF, t.why, e.reason); throw e; }
    await logAc(siteId, `Set ${g.value}° (${t.why})${g.stepped ? `; safety ${g.reason}` : ''}`, g.value === t.coolF ? 'trip' : 'stepping');
    return `cool ${g.value}`;
  }
  if (st.mode === 'HEAT') {
    if (st.heatF != null && Math.abs(st.heatF - t.heatF) < .6) return 'at target';
    // stepping down for the trip is Autopilot's own write (2° a step); putting your own setting back is one write (restore)
    const restore = t.welcome, step = !restore && st.heatF != null && Math.abs(st.heatF - t.heatF) > AC_MAX_STEP_F ? Math.round((st.heatF + Math.sign(t.heatF - st.heatF) * AC_MAX_STEP_F) * 10) / 10 : t.heatF;
    try { await setHeat(st.deviceId, step, mode, { targetF: t.heatF, restore }); } catch (e) { if (e instanceof GuardRefusal) return logRefusal(siteId, t.heatF, t.why, e.reason, 'heat '); throw e; }
    await logAc(siteId, `Set heat ${step}° (${t.why})`, step === t.heatF ? 'trip' : 'stepping');
    return `heat ${step}`;
  }
  await logAc(siteId, `Vacation mode holds nothing while the thermostat is in ${st.mode === 'HEATCOOL' ? 'Heat · Cool' : 'Off'}`, 'trip', true);
  return 'mode';
}
async function logRefusal(siteId: string, f: number, why: string, reason: string, what = '') {
  await logAc(siteId, `Did not set ${what}${f}° (${why}): ${explainRefusal(reason)}`, 'refused', true);
  return `refused: ${reason}`;
}

/**
 * The trip's end (any way it ends): a heat setpoint the trip lowered goes back in one write (the owner's own setting), and the AC plan's
 * step is re-applied by the next acTick. Cooling needs nothing here: the normal plan takes over through the guard.
 */
export async function tripAcEnd(siteId: string, trip: Trip, mode: string) {
  const ac = trip.data.ac as TripAc | undefined, st = await kv.get<NestState>('nest:last');
  const rec = await kv.get<any>(`${siteId}:ac:plan`); if (rec) { rec.lastStepHour = null; await kv.set(`${siteId}:ac:plan`, rec); }
  if (!st || st.mode !== 'HEAT' || ac?.heatF0 == null || st.heatF == null || Math.abs(st.heatF - ac.heatF0) < .6 || mode === 'off') return { restored: false };
  try { await setHeat(st.deviceId, ac.heatF0, mode, { restore: true }); }
  catch (e) { if (e instanceof GuardRefusal) { await logAc(siteId, `Did not put heat back to ${ac.heatF0}°: ${explainRefusal(e.reason)}`, 'refused'); return { restored: false, refused: e.reason }; } throw e; }
  await logAc(siteId, `Vacation over: heat back to ${ac.heatF0}°`, 'trip');
  return { restored: true };
}

/** What the AC card and the trip banner show during a trip (no writes): the phase, the hold, the target now and the welcome. */
export function tripAcView(trip: Trip, s: { dayF: number; nightF: number; nightFrom: number; nightTo: number }, now = Date.now()) {
  const phase = tripPhase(trip, now); if (!phase || phase === 'planned') return null;
  const ac: TripAc = { ...freshTripAc(null), ...((trip.data.ac as TripAc | undefined) ?? {}) }, target = trip.backAt != null ? arrivalTarget(trip.backAt, s) : s.dayF;
  return { phase, holdF: holdF(ac.humid), humid: ac.humid, heatF: awayHeatF(ac.heatF0), arrivalF: target, welcome: ac.welcome, now: tripTarget({ phase, ac, target }) };
}
