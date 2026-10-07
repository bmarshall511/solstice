// Now and its sheets (approved mockup mockups/al-ia.html v2, frames 1–8, 16, 17): the pure parts, so they are testable under node.
// The Status pill's aggregation, the banner slot's priority, the Today tiles' deltas and sparklines, the dials' geometry and
// snapping, the hub's 24-hour plan strips, and the staged-write labels the sheets' footers show. Times are the site's (Chicago).
import { dayOf, clock, weekday, chicagoEpoch } from './presence.js';

const addDay = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const r1 = v => Math.round(v * 10) / 10;
const fmtRpm = v => Math.round(v).toLocaleString('en-US');

/* ======================= Status pill (frame 0 item 8, frame 4) ======================= */
/** "1 h 12 m", "45 m", "2 d 3 h" for an elapsed time. */
export function spanText(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}
/** A National Weather Service alert that turns the pill red: a Warning, or anything NWS calls Extreme. */
export const nwsIsWarning = a => !!a && (/warning/i.test(a.event ?? '') || a.severity === 'Extreme');
export const STALE_MS = 3 * 60_000;
/**
 * The Status pill: green "All clear"; amber with the worst condition's short text; red for an outage or a warning-level alert.
 * Order (worst first): outage, NWS warning, can't reach Solstice, other NWS alert, ERCOT not normal, Storm Watch active, an old reading.
 * @returns {{level:'ok'|'warn'|'alert', text:string, small:string}}
 */
export function statusPill({ outage = false, outageSince = null, offline = false, readingAt = null, nws = [], ercot = null, stormActive = false, now = Date.now() } = {}) {
  if (outage) return { level: 'alert', text: 'Outage', small: outageSince ? `· ${spanText(now - outageSince)}` : '' };
  const warn = (nws ?? []).find(nwsIsWarning);
  if (warn) return { level: 'alert', text: warn.event, small: '' };
  if (offline) return { level: 'warn', text: 'Can’t reach Solstice', small: '' };
  const other = (nws ?? [])[0];
  if (other) return { level: 'warn', text: other.event, small: '' };
  if (ercot && ercot.condition && ercot.condition !== 'normal') return { level: 'warn', text: 'ERCOT', small: `· ${ercot.title || ercot.condition}` };
  if (stormActive) return { level: 'warn', text: 'Storm Watch active', small: '' };
  if (readingAt != null && now - readingAt >= STALE_MS) return { level: 'warn', text: 'Last reading', small: `· ${ageWords(now - readingAt)}` };
  return { level: 'ok', text: 'All clear', small: '' };
}
/** "just now", "5 min ago", "2 h ago" */
export const ageWords = ms => ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3600_000)} h ago`;

/* ======================= Vacation pill ======================= */
/**
 * idle "Plan a trip"; planned "Fri Oct 9 · 10:25 AM"; away "Away · back Mon" (a trip) or "Away · until 6 PM" (Away until…).
 * @returns {{state:'idle'|'planned'|'away', text:string, small:string}}
 */
export function vacationPill({ trip = null, phase = null, presence = null, now = Date.now() } = {}) {
  if (trip && phase === 'planned') return { state: 'planned', text: dateShort(trip.leaveAt), small: `· ${clock(trip.leaveAt)}` };
  if (trip) return { state: 'away', text: 'Away', small: trip.backAt == null ? '· until you’re back' : `· back ${dayOf(trip.backAt) === dayOf(now) ? clock(trip.backAt) : weekday(trip.backAt)}` };
  if (presence?.state === 'away' && presence.source === 'manual' && presence.until) return { state: 'away', text: 'Away', small: `· until ${dayOf(presence.until) === dayOf(now) ? clock(presence.until) : weekday(presence.until)}` };
  return { state: 'idle', text: 'Plan a trip', small: '' };
}
/** "Fri Oct 9" */
export const dateShort = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');

/* ======================= Banner slot (frame 16) ======================= */
/** One banner at a time, the first of these that has something to say. */
export const BANNER_ORDER = ['outage', 'vacation', 'hold', 'pool', 'powerwall', 'bill', 'digest'];
/** The banner to show from the candidates ({kind, …}; null/undefined entries are skipped), or null. */
export function pickBanner(cands) {
  const by = new Map((cands ?? []).filter(Boolean).map(c => [c.kind, c]));
  for (const k of BANNER_ORDER) if (by.has(k)) return by.get(k);
  return null;
}
/** A hold's progress (0–100, at least 2 so the ring shows) and whether it is still in force. */
export function holdProgress(hold, now = Date.now()) {
  if (!hold || hold.until <= now) return null;
  return { pct: Math.round(Math.max(2, Math.min(100, (now - hold.at) / Math.max(1, hold.until - hold.at) * 100))), until: hold.until };
}

/* ======================= Today tiles (frame 2) ======================= */
/**
 * kWh so far from a /api/day payload's buckets (kW per bucket), up to `hour` (the bucket holding it counts in part).
 * Import and export come from each bucket's net grid flow.
 */
export function sumUntil(day, hour) {
  const out = { solar: 0, home: 0, import: 0, export: 0 };
  if (!day?.buckets?.length) return null;
  const len = (day.bucketMinutes ?? 5) / 60;
  for (const b of day.buckets) {
    const f = Math.max(0, Math.min(1, (hour - b.t) / len)); if (!f) continue;
    const k = len * f;
    out.solar += (b.solar ?? 0) * k; out.home += (b.home ?? 0) * k;
    if ((b.grid ?? 0) > 0) out.import += b.grid * k; else out.export += -(b.grid ?? 0) * k;
  }
  return out;
}
/**
 * The tile's delta against the same time yesterday. `better` says which way is good ('up' for solar and export, 'down' for home and
 * import). Under 0.05 kWh apart reads "— same". Null when yesterday is unknown.
 * @returns {{t:'good'|'bad'|'flat', text:string}|null}
 */
export function tileDelta(today, yesterday, better = 'up') {
  if (today == null || yesterday == null) return null;
  const d = r1(today - yesterday);
  if (Math.abs(today - yesterday) < .05 || d === 0) return { t: 'flat', text: '— same' };
  const up = d > 0, good = better === 'up' ? up : !up;
  return { t: good ? 'good' : 'bad', text: `${up ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} kWh` };
}
/**
 * The 7-day sparkline's paths in a 100 × 30 box (the mockup's horizontal-tangent curve): `line` and the closed `area` under it.
 * Fewer than two values: null.
 */
export function sparkPaths(values, w = 100, h = 30, pad = 5) {
  const v = (values ?? []).filter(x => x != null && isFinite(x));
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo;
  const pts = v.map((x, i) => [i / (v.length - 1) * w, span ? h - pad - (x - lo) / span * (h - 2 * pad) : h / 2]);
  const f = n => n.toFixed(1);
  let line = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2; line += ` C${f(mx)} ${f(y0)} ${f(mx)} ${f(y1)} ${f(x1)} ${f(y1)}`; }
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}

/* ======================= Dials (frames 5 and 6): a 240° arc ======================= */
export const DIAL = { cx: 130, cy: 122, r: 100 };
const deg = Math.PI / 180;
/** Fraction (0–1) along the arc → the point at radius r (the arc starts bottom-left, 210°, and runs clockwise over the top). */
export function dialPoint(f, r = DIAL.r) { const a = (210 - 240 * Math.max(0, Math.min(1, f))) * deg; return [DIAL.cx + r * Math.cos(a), DIAL.cy - r * Math.sin(a)]; }
/** The SVG path of the arc from fraction f0 to f1 (either order). */
export function arcPath(f0, f1, r = DIAL.r) {
  const a = Math.min(f0, f1), b = Math.max(f0, f1), [x0, y0] = dialPoint(a, r), [x1, y1] = dialPoint(b, r);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${(b - a) * 240 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
/** A pointer at (x, y) in the dial's 260 × 196 box → the fraction; the gap at the bottom snaps to the nearer end. */
export function dialFrac(x, y) {
  let a = Math.atan2(DIAL.cy - y, x - DIAL.cx) / deg;   // −180…180, 0 = right, 90 = up
  if (a < -90) a += 360;                                // −180…−90 (lower left) → 180…270
  if (a > 210) return 0;                                // the gap, left half
  if (a < -30) return 1;                                // the gap, right half
  return (210 - a) / 240;
}
export const toFrac = (v, min, max) => Math.max(0, Math.min(1, (v - min) / Math.max(1e-9, max - min)));
export const fromFrac = (f, min, max) => min + Math.max(0, Math.min(1, f)) * (max - min);
/** The pump dial: snap to a preset within 75 rpm, else to 50 rpm, inside the controller's limits. */
export function snapRpm(rpm, presets = [], lim = { min: 450, max: 3450 }) {
  const near = presets.map(p => p.rpm).filter(r => Math.abs(r - rpm) <= 75).sort((a, b) => Math.abs(a - rpm) - Math.abs(b - rpm))[0];
  const v = near ?? Math.round(rpm / 50) * 50;
  return Math.max(lim.min, Math.min(lim.max, v));
}
/** The thermostat dial: whole degrees inside the range. */
export const snapDeg = (f, lo = 65, hi = 85) => Math.max(lo, Math.min(hi, Math.round(f)));
/** The arc colour: green within 2° of the setpoint, orange more than 4° away, blue in between. */
export const thermoTone = (indoor, set) => indoor == null || set == null ? 'c-near' : Math.abs(indoor - set) <= 2 ? 'c-near' : Math.abs(indoor - set) > 4 ? 'c-hot' : 'c-far';

/** The four pump presets. Filter and Skim are the controller's saved Pool and High Speed speeds when the pool payload has them;
 *  Quiet and Max are Solstice's defaults. `src` says which. */
export function pumpPresets(pool) {
  const s = pool?.settings ?? {}, sp = new Map((pool?.snapshot?.pump?.circuits ?? []).map(c => [c.circuitId, c.speed]));
  const filter = sp.get(s.poolCircuit ?? 6), skim = sp.get(s.boostCircuit ?? 8);
  return [
    { id: 'quiet', name: 'Quiet', rpm: 1500, src: 'default' },
    { id: 'filter', name: 'Filter', rpm: filter ?? s.filterRpm ?? 1750, src: filter != null ? 'controller' : 'default' },
    { id: 'skim', name: 'Skim', rpm: skim ?? s.boostRpm ?? 2400, src: skim != null ? 'controller' : 'default' },
    { id: 'max', name: 'Max', rpm: 3000, src: 'default' },
  ];
}

/* ======================= Hub plan strips (frame 1) ======================= */
const pct = v => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
/** Where "now" sits on a 12a–12a strip. */
export const nowPct = hour => pct(hour / 24 * 100);
/** Pump schedules (minutes of the day; a stop before the start wraps midnight) → blocks: the boost circuit `alt`, the rest `lo`. */
export function scheduleBlocks(schedules, boostId = 8) {
  const out = [], put = (a, b, cls) => { if (b > a) out.push({ left: pct(a / 14.4), width: pct((b - a) / 14.4), cls }); };
  for (const s of [...(schedules ?? [])].sort((a, b) => (a.circuitId === boostId) - (b.circuitId === boostId))) {
    const cls = s.circuitId === boostId ? 'alt' : 'lo';
    if (s.stop > s.start) put(s.start, s.stop, cls); else { put(s.start, 1440, cls); put(0, s.stop || 1440, cls); }
  }
  return out;
}
/** The AC plan: night hours `lo`, the day full, and a write tick at each step's hour. */
export function acBlocks(steps, nightFrom = 22, nightTo = 7) {
  const night = h => h >= nightFrom || h < nightTo, blocks = [];
  for (let h = 0; h < 24; h++) { const cls = night(h) ? 'lo' : ''; const last = blocks.at(-1); if (last && last.cls === cls && last.to === h) last.to = h + 1; else blocks.push({ from: h, to: h + 1, cls }); }
  return { blocks: blocks.map(b => ({ left: pct(b.from / 24 * 100), width: pct((b.to - b.from) / 24 * 100), cls: b.cls })),
    ticks: [...new Set((steps ?? []).map(s => s.hour))].filter(h => h > 0 && h < 24).map(h => pct(h / 24 * 100)) };
}
/** 24 booleans (one per hour) → contiguous blocks of `cls`. */
export function hourBlocks(hours, cls = '') {
  const out = []; let from = null;
  for (let h = 0; h <= 24; h++) { const on = h < 24 && !!hours[h];
    if (on && from == null) from = h; else if (!on && from != null) { out.push({ left: pct(from / 24 * 100), width: pct((h - from) / 24 * 100), cls }); from = null; } }
  return out;
}
/** The Powerwalls' charging hours today: measured (solid) for the hours so far from /api/day, forecast (dashed `est`) after. */
export function chargeBlocks(day, forecastPoints, hourNow, today) {
  const past = Array(24).fill(false), fut = Array(24).fill(false), sums = Array(24).fill(0);
  for (const b of day?.buckets ?? []) { const h = Math.floor(b.t); if (h < 24 && h < Math.floor(hourNow)) sums[h] += -(b.battery ?? 0); }
  sums.forEach((v, h) => { past[h] = v / Math.max(1, 60 / (day?.bucketMinutes ?? 5)) > .2; });
  const pts = (forecastPoints ?? []).filter(p => p.t?.startsWith(today));
  for (let i = 1; i < pts.length; i++) { const h = +pts[i].t.slice(11, 13); if (h >= Math.floor(hourNow) && pts[i].soc > pts[i - 1].soc + .002) fut[h] = true; }
  return [...hourBlocks(past, ''), ...hourBlocks(fut, 'est')];
}
/** The Away row's six days from today: the trip as one block, "now" and the day names. */
export function tripStrip(leaveAt, backAt, now = Date.now()) {
  const d0 = dayOf(now), start = chicagoEpoch(d0, 0), end = chicagoEpoch(addDay(d0, 6), 0), span = end - start, at = t => (t - start) / span * 100;
  const labels = Array.from({ length: 6 }, (_, i) => weekday(chicagoEpoch(addDay(d0, i), 12)));
  if (leaveAt == null) return { now: pct(at(now)), block: null, labels };
  const a = Math.max(0, at(leaveAt)), b = backAt == null ? 100 : Math.min(100, at(backAt));
  return { now: pct(at(now)), block: b > a ? { left: pct(a), width: pct(b - a) } : null, labels };
}
/** "in 2 d", "in 5 h", "back in 3 d" for the Away row's figure. */
export function tripIn(trip, phase, now = Date.now()) {
  if (!trip) return '';
  const left = (phase === 'planned' ? trip.leaveAt : trip.backAt) - now;
  if (trip.backAt == null && phase !== 'planned') return 'open';
  const h = Math.max(0, left / 3600_000), w = h >= 24 ? `${Math.round(h / 24)} d` : `${Math.max(1, Math.round(h))} h`;
  return phase === 'planned' ? `in ${w}` : `back in ${w}`;
}
/** The hub card's figure: "2 Auto · 1 Suggest". */
export function hubFigure(modes) {
  const n = m => (modes ?? []).filter(x => x === m).length, parts = [];
  if (n('auto')) parts.push(`${n('auto')} Auto`); if (n('suggest')) parts.push(`${n('suggest')} Suggest`); if (n('off')) parts.push(`${n('off')} Off`);
  return parts.join(' · ');
}
/** The Powerwall rules as one mode word for a mode pill: all the same → that mode; any Auto → auto; else suggest. */
export function rulesPill(rules) {
  const m = (rules ?? []).map(r => r.mode); if (!m.length) return null;
  return m.every(x => x === m[0]) ? m[0] : m.includes('auto') ? 'auto' : 'suggest';
}

/* ======================= Staged writes: what the sheet footer's primary says ======================= */
export const runLabel = m => m % 60 ? `${m} min` : `${m / 60} h`;
/**
 * The pump dial's staged speed → the exact pool commands and the footer label. The Skim speed runs the boost circuit (High Speed)
 * on its own timer; the Filter speed runs the Pool circuit; any other speed is saved as the Pool circuit's speed first (it then
 * applies whenever Pool runs, schedules included), so the label says "Set Pool …".
 */
export function poolSpeedStage({ rpm, poolId = 6, boostId = 8, poolSpeed = null, boostSpeed = null, poolOn = false, boostOn = false, minutes = 60 }) {
  if (rpm == null) return null;
  if (boostSpeed != null && rpm === boostSpeed) return boostOn ? null : { label: `Run ${fmtRpm(rpm)} rpm · ${runLabel(minutes)}`, cmds: [{ kind: 'circuit', id: boostId, on: true, minutes }] };
  if (poolSpeed != null && rpm === poolSpeed) return poolOn && !boostOn ? null : { label: `Run ${fmtRpm(rpm)} rpm · ${runLabel(minutes)}`, cmds: [{ kind: 'circuit', id: poolId, on: true, minutes }] };
  const set = { kind: 'speed', id: poolId, rpm };
  return poolOn ? { label: `Set Pool ${fmtRpm(rpm)} rpm`, cmds: [set] } : { label: `Set Pool ${fmtRpm(rpm)} rpm · run ${runLabel(minutes)}`, cmds: [set, { kind: 'circuit', id: poolId, on: true, minutes }] };
}
/** A round toggle's staged change. */
export function circuitStage(name, id, on, minutes = 60) {
  return on ? { label: `${name} off`, cmds: [{ kind: 'circuit', id, on: false }] } : { label: `${name} on · ${runLabel(minutes)}`, cmds: [{ kind: 'circuit', id, on: true, minutes }] };
}
const MODE_WORD = { off: 'Off', suggest: 'Suggest', auto: 'Auto' };
/** "Set Autopilot to Auto" (in a system's sheet), "Set Pool Autopilot to Auto" elsewhere. */
export const autopilotStage = (system, mode) => `Set ${system ? `${system} ` : ''}Autopilot to ${MODE_WORD[mode] ?? mode}`;
const NEST_WORD = { COOL: 'Cool', HEAT: 'Heat', HEATCOOL: 'Auto', OFF: 'Off' };
/** The thermostat's staged change → the acCommand body and the label. */
export function acStage(change) {
  if (!change) return null;
  switch (change.kind) {
    case 'cool': case 'heat': return { label: `Set ${change.f}°`, cmd: { kind: change.kind, f: change.f } };
    case 'range': return { label: `Set ${change.heatF}–${change.coolF}°`, cmd: { kind: 'range', heatF: change.heatF, coolF: change.coolF } };
    case 'mode': return { label: `Switch to ${NEST_WORD[change.mode] ?? change.mode}`, cmd: { kind: 'mode', mode: change.mode } };
    case 'eco': return { label: `Eco ${change.on ? 'on' : 'off'}`, cmd: { kind: 'eco', on: change.on } };
    case 'fan': return { label: change.seconds ? `Run the fan ${runLabel(change.seconds / 60)}` : 'Stop the fan', cmd: { kind: 'fan', seconds: change.seconds } };
    default: return null;
  }
}
export { NEST_WORD };

/* ======================= Ahead (frame 2) ======================= */
/** The 12-hour strip's bar heights (px): 4 px at zero, 84 px at the strip's (or 4 kW's) peak. */
export function barHeights(kws, top = 84) {
  const mx = Math.max(4, ...kws.map(v => v ?? 0));
  return kws.map(v => Math.round(4 + Math.max(0, v ?? 0) / mx * (top - 4)));
}
/** The Powerwall card's forecast: the highest charge later today (fraction 0–1) and its hour, when above the present charge. */
export function peakToday(points, today, soc0) {
  const pts = (points ?? []).filter(p => p.t?.startsWith(today)); if (!pts.length) return null;
  const pk = pts.reduce((a, p) => p.soc > a.soc ? p : a, pts[0]);
  return pk.soc * 100 > (soc0 ?? 0) + 1 ? { pct: Math.round(pk.soc * 100), hour: +pk.t.slice(11, 13) } : null;
}
