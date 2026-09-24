const get = async path => { const r = await fetch(`/api/${path}`); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };

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
  parseBill: async file => { const r = await fetch('/api/bills/parse', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; },
  saveBill: async bill => { const r = await fetch('/api/bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bill) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; },
};

/** Live readings pushed by the server every ~30 s (Server-Sent Events), with automatic reconnect. */
export function onLive(cb) {
  let es;
  const connect = () => { es = new EventSource('/api/stream'); es.onmessage = e => cb(JSON.parse(e.data)); es.onerror = () => { es.close(); setTimeout(connect, 5000); }; };
  connect();
}
