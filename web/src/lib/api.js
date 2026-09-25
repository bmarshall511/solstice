/** Called on any 401: in single-owner mode main.js shows the locked card (no owner cookie on this device). */
export let onUnauthorized = () => {};
export const setUnauthorized = fn => { onUnauthorized = fn; };
async function call(path, opts) {
  // Same-origin requests carry the HttpOnly solstice_owner cookie, in the browser and in the installed PWA alike.
  const r = await fetch(`/api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...opts });
  if (r.status === 401) { onUnauthorized(); throw new Error('Sign in required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${path}: HTTP ${r.status}`);
  return j;
}
const get = path => call(path);
const send = (method, path, body) => call(path, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });

export const api = {
  now: () => get('now'),
  day: date => get(`day?date=${date}`),
  daily: days => get(`daily?days=${days}`),
  monthly: months => get(`monthly?months=${months}`),
  profile: days => get(`profile?days=${days}`),
  gridDays: days => get(`grid-days?days=${days}`),
  overnight: days => get(`overnight?days=${days}`),
  records: () => get('records'),
  outages: () => get('outages'),
  site: () => get('site'),
  bills: () => get('bills'),
  reconcile: () => get('reconcile'),
  ercot: () => get('ercot'),
  status: () => get('status'),
  whatif: q => get(`whatif?${new URLSearchParams(q)}`),
  parseBill: file => call('bills/parse', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file }),
  saveBill: bill => send('POST', 'bills', bill),
  deleteBill: date => call(`bills/${date}`, { method: 'DELETE' }),
  sync: () => send('POST', 'sync'),
  me: () => get('auth/me'),
  owner: key => send('POST', 'auth/owner', { key }),
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
  acApply: () => send('POST', 'appliances/ac/apply'),
  acSettings: patch => send('POST', 'appliances/ac/settings', patch),
  saveSettings: patch => send('PUT', 'settings', patch),
};

