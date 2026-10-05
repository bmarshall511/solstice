/** Called on any 401: in single-owner mode main.js shows the locked card (no owner cookie on this device). */
export let onUnauthorized = () => {};
export const setUnauthorized = fn => { onUnauthorized = fn; };
async function call(path, opts) {
  // Same-origin requests carry the HttpOnly solstice_owner or solstice_guest cookie, in the browser and in the installed PWA alike.
  const r = await fetch(`/api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...opts });
  if (r.status === 401) { onUnauthorized(); throw new Error('Sign in required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${path}: HTTP ${r.status}`);
  return j;
}
const get = path => call(path);
/** The two unlocks answer 401 for a wrong key or link, which is not "this device lost its cookie": no onUnauthorized here.
 *  Rejects with `status` (and the server's `reason`, for links). */
async function unlock(path, body) {
  const r = await fetch(`/api/${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `${path}: HTTP ${r.status}`), { status: r.status, reason: j.reason ?? null });
  return j;
}
const send = (method, path, body) => call(path, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });

export const api = {
  now: () => get('now'),
  day: date => get(`day?date=${date}`),
  flows: (range, date) => get(`flows?range=${range}&date=${date}`),
  daily: days => get(`daily?days=${days}`),
  monthly: months => get(`monthly?months=${months}`),
  profile: days => get(`profile?days=${days}`),
  gridDays: days => get(`grid-days?days=${days}`),
  overnight: days => get(`overnight?days=${days}`),
  records: () => get('records'),
  outages: () => get('outages'),
  outage: () => get('outage'),
  site: () => get('site'),
  reconcile: () => get('reconcile'),
  ercot: () => get('ercot'),
  status: () => get('status'),
  whatif: q => get(`whatif?${new URLSearchParams(q)}`),
  parseBill: file => call('bills/parse', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file }),
  saveBill: bill => send('POST', 'bills', bill),
  deleteBill: date => call(`bills/${date}`, { method: 'DELETE' }),
  sync: () => send('POST', 'sync'),
  me: () => get('auth/me'),
  owner: key => unlock('auth/owner', { key }),
  /** Trade a share-link token for the guest cookie. Rejects with `reason` ('unknown' | 'revoked' | 'expired') on a bad link. */
  guest: token => unlock('auth/guest', { token }),
  /** Forget the share link on this device (clears the guest cookie). */
  leave: () => unlock('auth/leave', {}),
  devices: () => get('auth/devices'),
  signOutDevice: id => send('POST', `auth/devices/${encodeURIComponent(id)}/signout`),
  signOutOthers: () => send('POST', 'auth/signout-others'),
  preview: on => send('POST', 'auth/preview', { on }),
  shares: () => get('share'),
  createShare: (label, expiresIn) => send('POST', 'share', { label, expiresIn }),
  revokeShare: id => send('POST', `share/${encodeURIComponent(id)}/revoke`),
  revokeAllShares: () => send('POST', 'share/revoke-all'),
  login: (email, password) => send('POST', 'auth/login', { email, password }),
  setup: (token, email, password, name) => send('POST', 'auth/setup', { token, email, password, name }),
  logout: () => send('POST', 'auth/logout'),
  events: () => get('events'),
  addEvent: (type, day, note) => send('POST', 'events', { type, day, note }),
  deleteEvent: id => call(`events/${id}`, { method: 'DELETE' }),
  settings: () => get('settings'),
  appliances: () => get('appliances'),
  pool: () => get('appliances/pool'),
  poolApply: () => send('POST', 'appliances/pool/apply'),
  poolRestore: () => send('POST', 'appliances/pool/restore'),
  poolApplyTomorrow: () => send('POST', 'appliances/pool/apply-tomorrow'),
  poolAutopilot: mode => send('POST', 'appliances/pool/autopilot', { mode }),
  ac: () => get('appliances/ac'),
  applDay: date => get(`appliances/day?date=${date}`),
  pvsPanels: () => get('pvs/panels'),   // mockup u-panels: per-panel health by roof position (guests too)
  acApply: () => send('POST', 'appliances/ac/apply'),
  acSettings: patch => send('POST', 'appliances/ac/settings', patch),
  acUntrim: () => send('POST', 'appliances/ac/untrim'),
  // v-ac-control: the owner's own thermostat commands and the hold banner
  acCommand: cmd => send('POST', 'appliances/ac/command', cmd),
  poolCommand: cmd => send('POST', 'appliances/pool/command', cmd),
  poolGoal: patch => send('POST', 'appliances/pool/goal', patch),
  poolClearUp: body => send('POST', 'appliances/pool/clearup', body),
  poolSchedule: body => send('POST', 'appliances/pool/schedule', body),
  acHold: action => send('POST', 'appliances/ac/hold', { action }),
  spare: () => get('spare'),
  breakdown: range => get(`breakdown?range=${encodeURIComponent(range)}`),   // mockup y
  acSuggestion: (action, key) => send('POST', 'appliances/ac/suggestion', { action, key }),
  models: () => get('models'),
  saveSettings: patch => send('PUT', 'settings', patch),
  // t-enhancements: alerts feed, web push, weekly digest, presence, Powerwall rules (all owner-only)
  alerts: (limit = 50) => get(`alerts?limit=${limit}`),
  readAlert: id => send('POST', `alerts/${encodeURIComponent(id)}/read`),
  pushKey: () => get('push/key'),
  pushSubscribe: sub => send('POST', 'push/subscribe', sub),
  pushUnsubscribe: endpoint => send('DELETE', 'push/subscribe', { endpoint }),
  digest: week => get(`digest${week ? `?week=${encodeURIComponent(week)}` : ''}`),
  presence: () => get('presence'),
  setPresence: (state, until) => send('POST', 'presence', until == null ? { state } : { state, until }),
  teslaScopes: () => get('tesla/scopes'),
  pwRules: () => get('powerwall/rules'),
  pwRuleMode: (id, mode) => send('POST', `powerwall/rules/${encodeURIComponent(id)}`, { mode }),
  pwApply: id => send('POST', `powerwall/rules/${encodeURIComponent(id)}/apply`),
};

