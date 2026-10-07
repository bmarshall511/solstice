// The four-tab layout (approved mockup mockups/al-ia.html v2, frames 9–15): Now · Systems · History · Settings, and the Systems
// segments Home · Solar · Powerwall · Pool · AC. Pure helpers (no DOM), so tests/web/sysui.test.js runs them under node.

/** The Systems segments, in the order of the segment row. */
export const SEGS = [
  { id: 'home', label: 'Home', icon: 'home', acc: 'c-acc-house' },
  { id: 'solar', label: 'Solar', icon: 'sun', acc: 'c-acc-solar' },
  { id: 'powerwall', label: 'Powerwall', icon: 'batt', acc: 'c-acc-batt' },
  { id: 'pool', label: 'Pool', icon: 'pool', acc: 'c-acc-pool' },
  { id: 'ac', label: 'AC', icon: 'ac', acc: 'c-acc-ac' },
];
export const SEG_IDS = SEGS.map(s => s.id);
/** The four tabs. */
export const VIEWS = ['v-now', 'v-sys', 'v-hist', 'v-set'];

/* The old Insights panels (Today · Appliances · Planner · Home) and the old Panels tab stay working as aliases for a release:
   a push, a bookmark or a call that still names them lands on the Systems segment that now holds the card. */
const INS_PANEL = { today: 'home', home: 'home', plan: 'home', appl: 'pool', pool: 'pool', ac: 'ac', powerwall: 'powerwall', solar: 'solar', panels: 'solar' };
/* Anchors the old links scrolled to (card ids that moved) → [segment, the id to scroll to now]. */
const ANCHOR = {
  outage: ['powerwall', 'sysOutage'], pwr: ['powerwall', 'sysRules'], applPool: ['pool', null], poolCtl: ['pool', 'sysPoolCtl'], applAc: ['ac', null],
  planner: ['home', null], landSect: [null, 'hjEnergy'], billSect: [null, 'hjBills'],
};

/**
 * Where a navigation lands: `route('v-ins', 'appl', 'poolCtl')` → { view: 'v-sys', seg: 'pool', anchor: 'sysPoolCtl' }.
 * `p` is a segment (or an old Insights panel); unknown views fall back to Now. `seg` is null outside Systems.
 */
export function route(view, p = null, anchor = null) {
  const a = anchor && ANCHOR[anchor];
  if (view === 'v-roof') return { view: 'v-sys', seg: 'solar', anchor: a ? a[1] : anchor };
  if (view === 'v-ins' || view === 'v-sys') {
    const seg = a?.[0] ?? (SEG_IDS.includes(p) ? p : INS_PANEL[p]) ?? 'home';   // a moved card's anchor knows its segment best
    return { view: 'v-sys', seg, anchor: a ? a[1] : anchor, planner: p === 'plan' || anchor === 'planner' };
  }
  if (!VIEWS.includes(view)) return { view: 'v-now', seg: null, anchor: null };
  return { view, seg: null, anchor: a ? a[1] : anchor };
}

/** The old `S.nav.insights(panel, anchor, appliance)` call, mapped onto Systems. */
export const fromInsights = (panel, anchor, appl) => route('v-ins', appl ?? panel, anchor);

/**
 * A push or bookmark's query (`/?go=v-ins&p=appl`, `/?go=v-sys&p=pool`, `/?go=v-roof&panel=r1c3`, `/?go=v-hist&bills=1`)
 * → a route, or null when the query names no view.
 */
export function fromQuery(params) {
  const go = params.get('go'); if (!go || !/^v-(now|sys|hist|set|ins|roof)$/.test(go)) return null;
  const r = route(go, params.get('p'));
  if (r.view === 'v-hist' && params.get('bills')) r.anchor = 'hjBills';
  return r;
}

/** The segment row's sliding pill: index and count for the `--i` / `--n` custom properties. */
export const segIndex = seg => Math.max(0, SEG_IDS.indexOf(seg));

/* ======================= History (frame 14) ======================= */
/** The jump chips and the section each one scrolls to. */
export const JUMPS = [['energy', 'Energy', 'hjEnergy'], ['battery', 'Battery', 'hjBattery'], ['outages', 'Outages', 'hjOutages'], ['bills', 'Bills', 'hjBills']];
export const jumpTarget = id => JUMPS.find(j => j[0] === id)?.[2] ?? null;
/** The scroll position that puts a section `offset` px under the top of the scrolling screen. */
export const scrollFor = (elTop, screenTop, scrollTop, offset = 12) => Math.max(0, Math.round(elTop - screenTop + scrollTop - offset));

/* ======================= small drawing helpers ======================= */
/** The 240° mini-gauge (component 13, `.c-gauge`): the arc path for a fraction 0–1 in a 64 × 52 box. */
export function gaugeArc(f, cx = 32, cy = 30, r = 24) {
  const k = Math.max(0, Math.min(1, f)), a0 = 210 * Math.PI / 180, a1 = (210 - 240 * k) * Math.PI / 180;
  const p = a => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy - r * Math.sin(a)).toFixed(1)}`;
  return `M${p(a0)} A${r} ${r} 0 ${240 * k > 180 ? 1 : 0} 1 ${p(a1)}`;
}
/** One mini-gauge: value, label, fraction and accent class. */
export const gauge = (v, label, f, acc) => `<div class="${acc}"><svg viewBox="0 0 64 52" aria-hidden="true"><path class="c-arc-track" style="stroke-width:6" d="${gaugeArc(1)}"/>${f > 0.001 ? `<path class="c-arc-val" style="stroke-width:6;filter:none" d="${gaugeArc(f)}"/>` : ''}</svg><b>${v}</b><small>${label}</small></div>`;

/** Charge and discharge (kWh) of a 5-minute day up to `hour` (battery > 0 is discharging; a bucket in progress counts in part). */
export function batteryUntil(day, hour) {
  if (!day?.buckets?.length) return null;
  const len = (day.bucketMinutes ?? 5) / 60, out = { charge: 0, discharge: 0 };
  for (const b of day.buckets) { const f = Math.max(0, Math.min(1, (hour - b.t) / len)); if (!f) continue; const v = (b.battery ?? 0) * len * f; if (v > 0) out.discharge += v; else out.charge -= v; }
  return out;
}
/** "1h 4m" from minutes. */
export const hm = min => min == null || !isFinite(min) ? '—' : `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
/** A one-decimal kWh figure ("14.8"), or "—". */
export const k1 = v => v == null || !isFinite(v) ? '—' : (Math.round(v * 10) / 10).toFixed(1);
