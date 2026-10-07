// Settings › Alerts (approved mockup mockups/al-ia.html v2, frame 15): the sixteen alert switches the server knows
// (server/src/notify.ts TOGGLES) in five groups, each with a group switch and "N of M on", and the NEW badges, which go away
// 14 days after the feature shipped. Pure helpers: views/settings.js draws the rows.

/** Every alert switch: key → [title, sub]. A switch is on unless the saved prefs say `false`. */
export const ALERTS = {
  outage: ['Grid outage started or ended'], lowBatt: ['Battery low during an outage', 'Below 30%'], storm: ['Storm preparation', 'Watch or Warning ahead, with the Powerwall step'],
  ercot: ['Grid stress (ERCOT)', 'Conservation call or EEA'], nws: ['Severe weather (NWS)'],
  solar: ['Solar underperforming', '≥ 8% below baseline'], panel: ['Panel fault', 'From the PVS relay · a panel well below its neighbours'], stale: ['Tesla stopped reporting', 'After 3 minutes'],
  approval: ['AC and pool approvals', 'Pool plan, AC pre-cool, Powerwall rule'], poolTest: ['Time to test the pool', '4 days in warm water, 7 when cooler'], anomaly: ['Unusual usage', 'A day well above what its weather explains'],
  vacation: ['Vacation alerts', 'While you’re away: too hot or cold, damp, offline, pump, power use, someone home'],
  digest: ['Weekly digest', 'Monday 7 AM'], bill: ['Bill doesn’t match Tesla', 'Gap over 5%'], billDue: ['PEC bill due', '3 days before'], baseline: ['Overnight usage drift'],
};
/** The five groups, in order. */
export const ALERT_GROUPS = [
  { id: 'power', title: 'Power & grid', acc: 'c-acc-out', ic: 'bolt', keys: ['outage', 'lowBatt', 'storm', 'ercot', 'nws'] },
  { id: 'solar', title: 'Solar & panels', acc: 'c-acc-solar', ic: 'sun', keys: ['solar', 'panel', 'stale'] },
  { id: 'comfort', title: 'Comfort & pool', acc: 'c-acc-ac', ic: 'ac', keys: ['approval', 'poolTest', 'anomaly'] },
  { id: 'away', title: 'Away', acc: 'c-acc-vac', ic: 'plane', keys: ['vacation'] },
  { id: 'reports', title: 'Reports', acc: 'c-acc-grid', ic: 'bill', keys: ['digest', 'bill', 'billDue', 'baseline'] },
];
/** When each alert (and Push to this device) shipped: its NEW badge shows for 14 days from then. */
export const NEW_SINCE = {
  push: '2026-09-27', approval: '2026-09-27', billDue: '2026-09-27', anomaly: '2026-09-27', storm: '2026-09-27', ercot: '2026-09-27', panel: '2026-09-27', digest: '2026-09-27',
  poolTest: '2026-10-05', vacation: '2026-10-06',
};
export const NEW_DAYS = 14;
const addDay = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** Is the key's NEW badge still showing on `today` (a "YYYY-MM-DD" Chicago day)? Days 0–13 after it shipped. */
export const isNew = (key, today) => !!NEW_SINCE[key] && today >= NEW_SINCE[key] && today < addDay(NEW_SINCE[key], NEW_DAYS);
/** A group shows NEW while any of its alerts does. */
export const groupIsNew = (group, today) => group.keys.some(k => isNew(k, today));

export const isOn = (prefs, key) => prefs?.[key] !== false;
/** { on, total, any, line } for a group: "2 of 3 on". */
export function groupState(group, prefs) {
  const on = group.keys.filter(k => isOn(prefs, k)).length, total = group.keys.length;
  return { on, total, any: on > 0, line: `${on} of ${total} on` };
}
/** The group switch: on (any alert in it on) turns them all off, off turns them all on. Returns the new prefs. */
export function toggleGroup(prefs, group) {
  const to = !groupState(group, prefs).any, next = { ...(prefs ?? {}) };
  for (const k of group.keys) next[k] = to;
  return next;
}
/** Every key belongs to exactly one group (tests pin it). */
export const groupOf = key => ALERT_GROUPS.find(g => g.keys.includes(key)) ?? null;
