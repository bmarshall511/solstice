// The Powerwall rules' words (approved mockup mockups/t-enhancements.html frame 5), shared by views/powerwall.js, the Now sheet and
// the timeline log (lib/timeline.js). Pure: no DOM.
export const RULE = {
  reserve: { title: 'Reserve for tonight', sub: 'how much to keep for an outage overnight', skip: 'Not tonight' },
  storm: { title: 'Storm Watch prep', sub: 'fill the Powerwalls before bad weather', skip: 'Skip' },
  export: { title: 'Export rule', sub: 'what the Powerwalls may send to PEC' },
};
export const EXPORT = { battery_ok: 'Everything', pv_only: 'Solar only', never: 'Never' };
export const MODE = { autonomous: 'Time-Based Control', self_consumption: 'Self-Powered', backup: 'Backup-only' };
export const val = (command, v) => v == null ? '—' : command === 'grid_import_export' ? (EXPORT[v] ?? String(v)) : `${v}%`;
export const limits = (id, floor) => ({
  reserve: ['10–100%', 'one change an hour', 'never below 20% in a storm', `not below your ${floor}% floor`],
  storm: ['100% for a Warning or active Storm Watch', '50% for a Watch', 'back to the old reserve after', 'one change an hour'],
  export: ['battery_ok ↔ pv_only only', 'never "never"', 'mode never changed', 'one change an hour'],
})[id];
/** One Powerwall log row as plain text ("set 50% at 4:10 PM", "suggested 50% · not applied"), `at` already formatted. */
export function pwResultText(l, at) {
  const v = val(l.command, l.value);
  return { sent: `set ${v} at ${at}`, suggested: `suggested ${v} · not applied`, refused: `${v} refused: ${l.reason ?? ''}`, scope_missing: `${v} not sent: energy_cmds missing`,
    unchanged: `no change: ${l.reason ?? ''}`, error: `${v} failed: ${l.reason ?? ''}`, no_account: 'not sent: no Tesla account' }[l.result] ?? `${l.result} ${v}`;
}
