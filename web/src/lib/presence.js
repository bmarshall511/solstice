// "Away until…" (approved mockup mockups/t-enhancements.html frame 4). Times are the site's (America/Chicago); the server
// (server/src/appliances/presence.ts) takes `until` as epoch ms. Pure helpers; views/ac.js draws the sheet.
const TZ = 'America/Chicago';
const parts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
/** The Chicago calendar day of an instant. */
export const dayOf = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const addDay = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** Epoch ms of a Chicago wall-clock time (DST-aware: the offset is the one in force at that time). */
export function chicagoEpoch(day, h, m = 0) {
  const guess = Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const p = parts(guess), asUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`), off = asUtc - guess;   // Chicago − UTC
  const t = guess - off, p2 = parts(t), off2 = Date.parse(`${p2.year}-${p2.month}-${p2.day}T${p2.hour}:${p2.minute}:00Z`) - t;
  return guess - off2;
}
/** "6:00 PM" */
export const clock = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
/** "Tue", "Tuesday" */
export const weekday = (ms, style = 'short') => new Date(ms).toLocaleDateString('en-US', { timeZone: TZ, weekday: style });
/** "9:12 AM" today, else "Sat 9:12 AM". */
export const when = (ms, now = Date.now()) => dayOf(ms) === dayOf(now) ? clock(ms) : `${weekday(ms)} ${clock(ms)}`;

/** The two fixed presets: Tonight (6 PM today, while that is still ahead) and Tomorrow morning (7 AM). */
export function presets(now = Date.now()) {
  const today = dayOf(now), tonight = chicagoEpoch(today, 18), morning = chicagoEpoch(addDay(today, 1), 7);
  return [
    ...(tonight > now + 15 * 60_000 ? [{ id: 'tonight', at: tonight, title: 'Tonight', sub: `${clock(tonight)} today` }] : []),
    { id: 'morning', at: morning, title: 'Tomorrow morning', sub: `${clock(morning)} ${weekday(morning, 'long')}` },
  ];
}
/** A datetime-local value ("2026-09-30T15:30") read as Chicago time. */
export function pickedEpoch(v) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v ?? ''); return m ? chicagoEpoch(m[1], +m[2], +m[3]) : null;
}
/** A Chicago instant as a datetime-local value. */
export const localInput = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };

/** The confirm button's time: "6:00 PM" today, "7:00 AM Tue" tomorrow, "Wed 3:30 PM" later. */
export function untilLabel(at, now = Date.now()) {
  const d = dayOf(at), today = dayOf(now);
  return d === today ? clock(at) : d === addDay(today, 1) ? `${clock(at)} ${weekday(at)}` : `${weekday(at)} ${clock(at)}`;
}
/** The Away button once a return time is set: "Away until 6 PM", "Away until Tue 7 AM". */
export function awayButton(at, now = Date.now()) {
  const c = clock(at).replace(':00', '');
  return `Away until ${dayOf(at) === dayOf(now) ? c : `${weekday(at)} ${c}`}`;
}

/**
 * What each Autopilot does with a return time. `ac`: {mode, approved, awayF, band}; `pool`: {mode}. The server holds the away
 * setpoint until the return time and then goes back to the comfort band through the safety clamps (at most `maxStepF` per step).
 */
export function awayLines(at, now, ac, pool) {
  const d = dayOf(at), today = dayOf(now), b = ac.band ?? {}, band = `${b.homeLo}–${b.homeHi}°`, step = ac.maxStepF ?? 2;
  const writes = ac.mode === 'auto' || ac.approved, suggest = !writes && ac.mode === 'suggest';
  const hold = d === today ? `until ${clock(at)}` : d === addDay(today, 1) ? `tonight instead of the ${b.nightLo}–${b.nightHi}° night band, until ${clock(at)}` : `each day until ${weekday(at, 'long')} ${clock(at)}`;
  const acLine = ac.mode === 'off' ? 'Off: Solstice makes no Nest writes, so the thermostat stays as it is.'
    : writes ? `Will hold ${ac.awayF}° ${hold}, then go back to your ${band} comfort band, at most ${step}° per step.`
    : suggest ? `Suggests holding ${ac.awayF}° ${hold}, then going back to your ${band} comfort band. Nothing changes until you approve the plan.` : '—';
  const plan = pool.mode === 'auto' ? 'written' : 'suggested';
  const poolLine = pool.mode === 'off' || !pool.mode ? 'No change. Pool Autopilot is Off.'
    : d === today ? 'No change. The pump plan doesn’t depend on who is home.'
    : `No change${d === addDay(today, 1) ? ' tonight' : ''}. The pump plan doesn’t depend on who is home; ${d === addDay(today, 1) ? 'tomorrow’s plan is' : 'each evening’s plan is'} still ${plan} at 8:15 PM as usual.`;
  return { ac: acLine, pool: poolLine };
}
