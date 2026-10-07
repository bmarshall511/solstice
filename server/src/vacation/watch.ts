// Vacation mode's watch (mockup ak frames 1b and 4; owner's answers 2026-10-06), every 5 minutes in the cron's watch. Read-only towards
// every device: Nest and the pool controller are only read from what the app already stored, Tesla's live status from `readings`.
//   no trip      "Looks like you're away": Nest has said Away (Home/Away Assist) for 12 h and the house shows no sign of anyone
//                (a load step that isn't the AC). One push per Away spell; "I'm just out" mutes it for 24 h. Never starts a trip.
//   during one   alerts (kind 'vacation', Settings › Alerts "Vacation alerts"): inside over 88° or under 50°, humidity over 65% for 6 h,
//                the thermostat offline over an hour, the pump off in two scheduled reads in a row, 2 kW or more for 15 minutes that
//                isn't the AC, the pool or a water-heater burst, somebody at the thermostat, and "Not back yet?" 2 h past the arrival
//                time. Near the arrival time (the due and late phases) a change at the thermostat or that kind of load is you: welcome
//                home, the trip ends.
//   at the end   the pushes held during the trip (water test, panels) arrive as one summary.
import { q, one, kv } from '../db.js';
import { localDay } from '../tesla/client.js';
import { notify } from '../notify.js';
import type { NestState } from '../appliances/nest.js';
import type { PoolSnapshot } from '../appliances/screenlogic.js';
import { pumpSchedules, scheduledQuarters, quarterOf } from '../appliances/pool.js';
import { liveTrip, tripPhase, patchTripData, logTrip, type Trip } from './trip.js';

export const HOT_F = 88, COLD_F = 50, DAMP_RH = 65, DAMP_MS = 6 * 3600_000, OFFLINE_MS = 3600_000, LOAD_KW = 2, LOAD_MS = 15 * 60_000;
export const WH_MIN_KW = 3.5, WH_MAX_KW = 5.5, WH_MAX_MS = 45 * 60_000, DETECT_MS = 12 * 3600_000, ACTIVITY_STEP_KW = 1.2, ACTIVITY_MAX = 2, SNOOZE_MS = 864e5;
export const BASE_KW_FALLBACK = .6;
type Watch = { tempAt?: number; dampAt?: number; offlineAt?: number; pumpDay?: string; loadSince?: number | null; loadAt?: number; wallAt?: number; lateAt?: number; allowedDay?: string };
const clock = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

/* ---------- pure ---------- */
/** Readings that cover `ms` (the first within 20 minutes of its start) and all satisfy `ok`. */
export function spell<T extends { ts: number }>(rows: T[], now: number, ms: number, ok: (r: T) => boolean) {
  const w = rows.filter(r => r.ts > now - ms);
  return w.length >= 2 && w[0].ts <= now - ms + 20 * 60_000 && w.every(ok);
}
/**
 * The load nobody planned over the last 15 minutes (kW): each live reading's home load less the always-on base, the AC while Nest
 * says it is cooling and the pump's last watts. Null when there are fewer than two readings. `wh`: whether it looks like the water
 * heater (3.5–5.5 kW) and has run less than 45 minutes so far, which is expected.
 */
export function unexplained(rows: Array<{ ts: number; loadKw: number }>, o: { now: number; baseKw: number; acKw: number; cooling: boolean; poolKw: number; since: number | null }) {
  const w = rows.filter(r => r.ts > o.now - LOAD_MS); if (w.length < 2) return null;
  const extra = w.map(r => r.loadKw - o.baseKw - (o.cooling ? o.acKw : 0) - o.poolKw), low = Math.min(...extra);
  const wh = low >= WH_MIN_KW && Math.max(...extra) <= WH_MAX_KW && (o.since == null || o.now - o.since < WH_MAX_MS);
  return { kw: Math.round(low * 10) / 10, over: low >= LOAD_KW, wh };
}
/** Signs of someone home in a stretch of live readings: steps up of 1.2 kW or more while the AC wasn't cooling. */
export function activity(rows: Array<{ ts: number; loadKw: number; cooling: boolean }>) {
  let n = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].loadKw - rows[i - 1].loadKw >= ACTIVITY_STEP_KW && !rows[i].cooling && !rows[i - 1].cooling) n++;
  return n;
}

/* ---------- inputs ---------- */
async function liveRows(siteId: string, from: number) {
  return (await q<{ ts: string; load_w: number | null }>(`SELECT ts::text, load_w FROM readings WHERE site_id = $1 AND ts > $2 AND load_w IS NOT NULL ORDER BY ts`, [siteId, from]))
    .map(r => ({ ts: Number(r.ts), loadKw: Number(r.load_w) / 1000 }));
}
/** The trip's always-on: the lowest live load of the last 24 h, else 0.6 kW. */
async function baseKw(siteId: string, now: number) {
  const r = await one<{ kw: number | null }>(`SELECT (PERCENTILE_CONT(.05) WITHIN GROUP (ORDER BY load_w) / 1000.0)::float8 kw FROM readings WHERE site_id = $1 AND ts > $2 AND load_w IS NOT NULL`, [siteId, now - 864e5]);
  return r?.kw ?? BASE_KW_FALLBACK;
}
const coolingAt = (rows: Array<{ ts: number; hvac: string }>) => (t: number) => { let h = 'OFF'; for (const r of rows) { if (r.ts > t) break; h = r.hvac; } return h === 'COOLING'; };

/* ---------- the step ---------- */
/**
 * Every 5 minutes (registered in app.ts as fiveMinuteSteps.vacation). `end` ends the trip with every system's part (vacation/index.ts
 * finishTrip, injected to keep this module free of the routes).
 */
export async function vacationWatch(siteId: string, now = Date.now(), end: (siteId: string, text: string) => Promise<unknown> = async () => null) {
  const trip = await liveTrip(siteId), phase = tripPhase(trip, now);
  if (!trip || !phase || phase === 'planned') return { detect: await detectAway(siteId, now) };
  const w: Watch = { ...((trip.data.watch as Watch | undefined) ?? {}) }, out: Record<string, unknown> = { phase };
  const save = () => patchTripData(trip.id, { watch: w });
  const alert = (title: string, body: string, key: string, data: Record<string, unknown> = {}) =>
    notify(siteId, 'vacation', title, body, { trip: trip.id, ...data }, { key, windowH: 24, now, url: '/?go=v-now' });
  const today = localDay(new Date(now)), st = await kv.get<NestState | null>('nest:last');

  // somebody at the thermostat (a hold started during the trip): near the arrival time it is you; otherwise ask
  const hold = await kv.get<{ at: number; by: string; coolF: number | null; heatF: number | null; mode: string } | null>(`${siteId}:ac:hold`);
  if (hold?.by === 'wall' && hold.at > (trip.startedAt ?? trip.leaveAt) && w.wallAt !== hold.at) {
    w.wallAt = hold.at; await save();
    const set = hold.mode === 'HEAT' ? `heat ${Math.round(hold.heatF ?? 0)}°` : `${Math.round(hold.coolF ?? 0)}°`;
    if (phase === 'due' || phase === 'late') { await end(siteId, `Welcome home: someone set the thermostat to ${set} at ${clock(hold.at)}`); return { ...out, ended: 'thermostat' }; }
    await logTrip(trip.id, { at: now, text: `Someone set the thermostat to ${set} at ${clock(hold.at)}`, delta: 'watch' });
    if (w.allowedDay !== today) out.wall = (await alert(`Someone set the thermostat to ${set}`, `At ${clock(hold.at)}, at the wall. Is someone home? Open Solstice to answer.`, `vac:wall:${hold.at}`, { ask: 'wall' })).stored;
  }
  // inside too hot or too cold
  if (st?.indoorF != null && (st.indoorF > HOT_F || st.indoorF < COLD_F) && (w.tempAt == null || now - w.tempAt > 6 * 3600_000)) {
    w.tempAt = now; await save();
    out.temp = (await alert(`Inside is ${Math.round(st.indoorF)}°`, st.indoorF > HOT_F ? `Above ${HOT_F}° with the AC ${st.hvac === 'COOLING' ? 'running' : 'not running'}. Check that the thermostat is in Cool and the AC is working.` : `Below ${COLD_F}°. Check that the thermostat is in Heat; pipes are at risk below freezing.`, `vac:temp:${trip.id}:${st.indoorF > HOT_F ? 'hot' : 'cold'}:${today}`)).stored;
  }
  // damp: humidity over 65% for 6 h
  const rh = (await q<{ ts: string; humidity: number | null }>(`SELECT ts::text, humidity FROM nest_readings WHERE site_id = $1 AND ts > $2 ORDER BY ts`, [siteId, now - DAMP_MS])).map(r => ({ ts: Number(r.ts), rh: r.humidity }));
  if (spell(rh, now, DAMP_MS, r => r.rh != null && r.rh > DAMP_RH) && (w.dampAt == null || now - w.dampAt > 864e5)) {
    w.dampAt = now; await save();
    out.damp = (await alert('The house is staying damp', `Humidity over ${DAMP_RH}% for 6 h${st?.indoorF != null ? ` at ${Math.round(st.indoorF)}°` : ''}. Solstice is holding a lower setting to dry it.`, `vac:damp:${trip.id}:${today}`)).stored;
  }
  // the thermostat offline for over an hour
  if (st && (st.online === false || now - st.at > OFFLINE_MS) && (await kv.get('nest:tokens')) && (w.offlineAt == null || now - w.offlineAt > 864e5)) {
    w.offlineAt = now; await save();
    out.offline = (await alert('The thermostat is offline', `No word from Nest since ${clock(st.at)}. Solstice can't hold the trip setting until it is back (a power cut, or the Wi-Fi).`, `vac:offline:${trip.id}:${today}`)).stored;
  }
  // the pump off in the last two reads, both inside its schedule
  const snap = await kv.get<PoolSnapshot | null>(`${siteId}:pool:last`), sched = snap?.pump ? scheduledQuarters(pumpSchedules(snap).schedules) : null;
  if (sched && w.pumpDay !== today) {
    const reads = await q<{ ts: string; running: boolean }>(`SELECT ts::text, running FROM pool_readings WHERE site_id = $1 AND day = $2 ORDER BY ts DESC LIMIT 2`, [siteId, today]);
    if (reads.length === 2 && reads.every(r => !r.running && sched[quarterOf(Number(r.ts))]) && !snap?.freezeMode) {
      w.pumpDay = today; await save();
      out.pump = (await alert('The pool pump didn’t run', `Scheduled now, but the ${reads.map(r => clock(Number(r.ts))).reverse().join(' and ')} reads found it off. The controller answered, with no error.`, `vac:pump:${trip.id}:${today}`)).stored;
    }
  }
  // power use nobody planned: 2 kW or more for 15 minutes that isn't the AC, the pool or a water-heater burst
  const rows = await liveRows(siteId, now - LOAD_MS), learned = await kv.get<{ learned?: { coolKw?: number | null } }>(`${siteId}:ac:learned:v2`);
  const u = unexplained(rows, { now, baseKw: await baseKw(siteId, now), acKw: learned?.learned?.coolKw ?? 2.6, cooling: st?.hvac === 'COOLING', poolKw: snap?.pump?.running ? (snap.pump.watts ?? 0) / 1000 : 0, since: w.loadSince ?? null });
  if (u?.over) {
    if (w.loadSince == null) { w.loadSince = now - LOAD_MS; await save(); }
    if (!u.wh && (w.loadAt == null || now - w.loadAt > 6 * 3600_000)) {
      w.loadAt = now; await save();
      if (phase === 'due' || phase === 'late') { await end(siteId, `Welcome home: power use at ${clock(now)} says you're back`); return { ...out, ended: 'load' }; }
      await logTrip(trip.id, { at: now, text: `${u.kw} kW of power use nobody planned at ${clock(now - LOAD_MS)}`, delta: 'watch' });
      out.load = (await alert('Power use nobody planned', `${u.kw} kW for 15 min at ${clock(now - LOAD_MS)}. Not the AC, pool or water heater.`, `vac:load:${trip.id}:${Math.floor(now / (6 * 3600_000))}`, { kw: u.kw })).stored;
    }
  } else if (u && w.loadSince != null) { w.loadSince = null; await save(); }
  // not back 2 h after the arrival time
  if (phase === 'late' && w.lateAt == null) {
    w.lateAt = now; await save();
    out.late = (await alert('Not back yet?', `Solstice expected you at ${clock(trip.backAt!)} and has gone back to the trip setting. Open Solstice to change the arrival time, or tap I'm home when you are.`, `vac:late:${trip.id}`, { ask: 'late' })).stored;
  }
  return out;
}

/** "Looks like you're away" (frame 1b): Nest Away for 12 h with no sign of anyone, one push per Away spell, unless muted. */
export async function detectAway(siteId: string, now = Date.now()) {
  const snooze = await kv.get<number>(`${siteId}:vacation:snooze`); if (snooze && snooze > now) return { snoozed: true };
  const st = await kv.get<NestState | null>('nest:last'); if (!st?.eco || now - st.at > 30 * 60_000) return { away: false };
  const r = await one<{ since: string | null }>(`SELECT MIN(ts)::text since FROM nest_readings WHERE site_id = $1 AND eco AND ts > COALESCE((SELECT MAX(ts) FROM nest_readings WHERE site_id = $1 AND eco IS NOT TRUE), 0)`, [siteId]);
  const since = r?.since != null ? Number(r.since) : null;
  if (since == null || now - since < DETECT_MS) return { away: true, since };
  const nest = (await q<{ ts: string; hvac: string }>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND ts > $2 ORDER BY ts`, [siteId, now - DETECT_MS - 3600_000])).map(x => ({ ts: Number(x.ts), hvac: x.hvac }));
  const cool = coolingAt(nest), rows = (await liveRows(siteId, now - DETECT_MS)).map(x => ({ ...x, cooling: cool(x.ts) }));
  if (rows.length < 24) return { away: true, since, readings: rows.length };   // too little live data to say
  const n = activity(rows); if (n > ACTIVITY_MAX) return { away: true, since, activity: n };
  const res = await notify(siteId, 'vacation', 'Looks like you’re away', `Nest has said Away since ${clock(since)} and nothing at home has been used since. Start Vacation mode?`,
    { ask: 'detect', since }, { key: `vac:detect:${since}`, windowH: 24 * 30, now, url: '/?go=v-now&vacation=detected' });
  return { away: true, since, activity: n, notified: res.stored };
}

/** The pushes held during the trip (water test, panels), as one summary when it ends. */
export async function heldSummary(siteId: string, trip: Trip, now = Date.now()) {
  const rows = await q<{ title: string }>(`SELECT title FROM alerts WHERE site_id = $1 AND (data->>'held') = 'true' AND created_at >= $2 ORDER BY created_at`,
    [siteId, new Date(trip.startedAt ?? trip.leaveAt).toISOString()]);
  if (!rows.length) return { held: 0 };
  const titles = [...new Set(rows.map(r => r.title))];
  const res = await notify(siteId, 'vacation', 'While you were away', `${titles.slice(0, 4).join('; ')}${titles.length > 4 ? `; and ${titles.length - 4} more` : ''}. Open Solstice for each one.`,
    { held: titles.length }, { key: `vac:held:${trip.id}`, windowH: 24 * 7, now, url: '/?go=v-now' });
  return { held: titles.length, notified: res.stored };
}
