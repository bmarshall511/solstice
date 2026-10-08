// Vacation mode's words and numbers (approved mockup mockups/ak-vacation.html). Pure helpers; views/vacation.js draws the sheet, the Now
// chip and banner, and the report. Times are the site's (America/Chicago), epoch ms like the server's (server/src/vacation/).
import { dayOf, clock, weekday, chicagoEpoch } from './presence.js';

const addDay = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** "6 PM", "6:30 PM" */
export const shortClock = ms => clock(ms).replace(':00', '');
/** "Thu Oct 15" */
export const dateLabel = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
/** The chip and banner: "back Sun 6 PM" (today: "back 6 PM"); "until you're back" for an open trip. */
export const backLabel = (backAt, now = Date.now()) => backAt == null ? 'until you’re back' : `back ${dayOf(backAt) === dayOf(now) ? '' : `${weekday(backAt)} `}${shortClock(backAt)}`;
/** The start button: "Thu → Sun"; the same day: "Thu"; open: "from Thu". */
export function spanLabel(leaveAt, backAt) {
  if (backAt == null) return `from ${weekday(leaveAt)}`;
  return dayOf(leaveAt) === dayOf(backAt) ? weekday(leaveAt) : `${weekday(leaveAt)} → ${weekday(backAt)}`;
}
/** "day 2 of 4" (calendar days of the trip, the leave day being day 1); open trips: "day 2". */
export function dayOfTrip(startedAt, backAt, now = Date.now()) {
  const d = n => Math.round((Date.parse(dayOf(n) + 'T12:00:00Z') - Date.parse(dayOf(startedAt) + 'T12:00:00Z')) / 864e5) + 1;
  return backAt == null ? `day ${d(now)}` : `day ${Math.max(1, d(now))} of ${d(backAt)}`;
}
/** How far through the trip (0–1) for the banner's bar. */
export const tripProgress = (startedAt, backAt, now = Date.now()) => backAt == null ? 0 : Math.max(0, Math.min(1, (now - startedAt) / (backAt - startedAt)));
/** The defaults on a new trip's sheet: leaving now (or tomorrow 7 AM after 9 PM), back three days later at 6 PM. */
export function defaultDates(now = Date.now()) {
  const today = dayOf(now), late = +new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }) >= 21;
  const leaveAt = late ? chicagoEpoch(addDay(today, 1), 7) : now;
  return { leaveAt, backAt: chicagoEpoch(addDay(dayOf(leaveAt), 3), 18) };
}
/** The evening pool run before the arrival day, when the normal plan is written (01:15 UTC on the arrival day: 8:15 PM the evening before). */
export function poolBackLabel(backAt) {
  if (backAt == null) return null;
  const t = Date.parse(`${dayOf(backAt)}T01:15:00Z`);
  return `${weekday(t)} ${clock(t)}`;
}
/**
 * The welcome's setpoint steps from `fromF` to `target`: 2° every 30 minutes from `startAt` (the safety guard's pace), then the arrival.
 * [{at, label}], at most 5, for the banner's row of times.
 * @returns {{ at: number, label: string, sub: string, done?: boolean, you?: boolean }[]}
 */
export function welcomeSteps(startAt, fromF, target, backAt) {
  const out = []; let f = Math.round(fromF ?? target), t = startAt;
  out.push({ at: t, f });
  while (f > target && out.length < 4) { f = Math.max(target, f - 2); t += 30 * 60_000; out.push({ at: t, f }); }
  return [...out.map(s => ({ at: s.at, label: `${clock(s.at).replace(/ [AP]M$/, '')}`, sub: `${s.f}°`, done: s.f === target })), ...(backAt ? [{ at: backAt, label: clock(backAt).replace(/ [AP]M$/, ''), sub: 'you', you: true }] : [])];
}
/** A kWh figure with a sign for savings: "−2.8". */
export const minus = v => v == null ? '—' : `−${Math.abs(Math.round(v * 10) / 10)}`;
/** A whole kWh: "71". */
export const k0 = v => v == null ? '—' : String(Math.round(v));
