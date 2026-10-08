// Load signatures (I-22, approved mockup am frames 4–5). Repeating bursts in the 5-minute home load once the AC (the learned draw
// while the Nest cools or heats), the pool pump (its ScreenLogic watts, all day) and that night's always-on base are taken out:
//   residual = home kW − AC − pump − nightBase, on days whose Nest readings cover 80% or more (the AC can't be told apart otherwise)
//   a 3-bucket median filter, so one inflated bucket never starts or shapes a burst
//   levels: a new level when the filtered residual moves at least max(1.2 kW, 25% of the level); a one-bucket level between its two
//   neighbours is the edge of a step (a load that switched mid-bucket) and joins the higher side
//   bursts: each step down pairs with the nearest earlier unpaired step up of similar size (±30%); a burst that starts while another
//   runs is an overlap and gets only the extra kW; kW = median of its own filtered buckets above the level it started from; kWh from the
//   raw residual, each bucket capped at 1.5 × that kW; at least 1.5 kW and 10 minutes; a burst that starts or ends within one bucket
//   of a Nest on/off switch with a kW within 20% of the AC's is the AC's mask edge, not a load
// Bursts are stored per day (load_bursts), clustered by kW × minutes bands (one cluster per band, at any time of day)
// and named by the owner (load_labels). This is whole-house inference: never "measured".
import express, { type Express, type Request } from 'express';
import { q, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';
import { daySpans } from './flows.js';
import { acMask, nightBase, nestCoverage, pumpMask, NEST_COVERAGE } from './breakdown.js';
import { pumpRunning } from './appliances/pool.js';
import { learnAcKw, acKwFor } from './appliances/ac.js';

/** v2 (2026-10-08): buckets with the AC running are no longer used (a variable-speed compressor isn't one learned kW, so subtracting it
 *  left 1.5–2 kW plateaus that read as a 200-minute "big load" and pushed the breakdown 15 kWh a day over the home total). Bursts
 *  stored by v1 are ignored and the nightly re-detects their days. */
export const LOADS_V = 2;
const B = 300_000;
export const MIN_KW = 1.5, MIN_MINUTES = 10, STEP_KW = 1.2, STEP_FRAC = .25, PAIR_TOL = .3, KWH_CAP = 1.5, AC_EDGE_TOL = .2, HOLD_MS = 20 * 60_000;
export const SUPPORT_N = 8, SUPPORT_DAYS = 4, WINDOW_DAYS = 30, RECLUSTER_DAYS = 60, BACKFILL_DAYS = 30, STOP_BEFORE_MS = 8_000, CHUNK_DAYS = 7;
export const MATCH_KW = .2, MATCH_MIN = 1.5, LEARNED_N = 20, STEADY_KW = .15, PART_KWH = 1;

export type LoadBucket = { epoch: number; day: string; hour: number; kw: number };
export type LoadBurst = { start: number; day: string; hour: number; minutes: number; kw: number; kwh: number; overlap: boolean };
/** kW to take out of a bucket; null when it can't be known (heating with no heating kW learned): the bucket breaks the run. */
export type Draw = (t: number) => number | null;
export type Switch = { ts: number; kw: number };

const med = (v: number[]) => { const x = [...v].sort((a, b) => a - b), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;

/* ======================= the draws taken out (pure) ======================= */
/** On-intervals of a reading list: each reading of a listed state holds until the next reading, at most 20 minutes. Sorted, disjoint. */
function onIntervals<T extends { ts: number }>(rows: T[], on: (r: T) => boolean) {
  const s = [...rows].sort((a, b) => a.ts - b.ts), out: Array<[number, number]> = [];
  for (let i = 0; i < s.length; i++) if (on(s[i])) out.push([s[i].ts, Math.min(s[i].ts + HOLD_MS, s[i + 1]?.ts ?? s[i].ts + HOLD_MS)]);
  return out;
}
/** Whether any interval overlaps the bucket [t, t+5 min): acMask's rule, by binary search (a month of buckets × readings was quadratic). */
function overlaps(iv: Array<[number, number]>) {
  return (t: number) => { let lo = 0, hi = iv.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (iv[m][0] < t + B) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 && iv[k][1] > t; };
}
/** The AC's draw for a bucket: the heating kW while the Nest heats (null with none learned), the cooling kW while it cools, else 0. */
export function acDraw(nest: Array<{ ts: number; hvac: string | null }>, coolKw: number, heatKw: number | null): Draw {
  const cool = overlaps(onIntervals(nest, r => r.hvac === 'COOLING')), heat = overlaps(onIntervals(nest, r => r.hvac === 'HEATING'));
  return t => heat(t) ? heatKw : cool(t) ? coolKw : 0;
}
/** The pump's draw for a bucket, all day: the reading in force at the bucket's middle (each holds until the next, at most 20 min). */
export function pumpDraw(pool: Array<{ ts: number; running: boolean; watts: number; rpm?: number | null }>) {
  const s = [...pool].sort((a, b) => a.ts - b.ts);
  return (t: number) => {
    const mid = t + B / 2; let lo = 0, hi = s.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].ts <= mid) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0 || mid - s[k].ts >= HOLD_MS || !pumpRunning({ running: s[k].running, rpm: s[k].rpm ?? 1, watts: s[k].watts })) return 0;
    return s[k].watts / 1000;
  };
}
/** When the Nest went on or off (the edges of the AC mask), with the draw that switched. */
export function acSwitches(nest: Array<{ ts: number; hvac: string | null }>, coolKw: number, heatKw: number | null): Switch[] {
  const s = [...nest].sort((a, b) => a.ts - b.ts), out: Switch[] = [], run = (h: string | null) => h === 'COOLING' || h === 'HEATING';
  const kwOf = (h: string | null) => h === 'HEATING' ? heatKw : coolKw;
  for (let i = 0; i < s.length; i++) {
    const prev = s[i - 1], cur = s[i];
    if (prev && run(prev.hvac) && cur.ts - prev.ts > HOLD_MS) { const kw = kwOf(prev.hvac); if (kw) out.push({ ts: prev.ts + HOLD_MS, kw }); }   // the hold ran out
    if (prev && run(prev.hvac) !== run(cur.hvac)) { const kw = kwOf(run(cur.hvac) ? cur.hvac : prev.hvac); if (kw) out.push({ ts: cur.ts, kw }); }
  }
  return out;
}

/* ======================= detection (pure) ======================= */
type Seg = LoadBucket & { r: number };
/**
 * Bursts in 5-minute buckets (any span; a day's base by `base(day)`, null = that day's buckets can't be used). Bursts belong to the
 * day they start on. `switches` are the Nest's on/off times for the AC-edge rule.
 */
export function detectBursts(buckets: LoadBucket[], o: { base: (day: string) => number | null; ac?: Draw; pump?: (t: number) => number; switches?: Switch[] }): LoadBurst[] {
  const out: LoadBurst[] = []; let seg: Seg[] = [];
  const flush = () => { if (seg.length >= 2) out.push(...segmentBursts(seg, o.switches ?? [])); seg = []; };
  for (const b of [...buckets].sort((x, y) => x.epoch - y.epoch)) {
    const base = o.base(b.day), ac = o.ac ? o.ac(b.epoch) : 0;
    // with the AC running the residual isn't trustworthy (variable-speed compressor), so those buckets break the run like a gap
    if (base == null || ac == null || ac > 0) { flush(); continue; }
    if (seg.length && b.epoch - seg[seg.length - 1].epoch !== B) flush();
    seg.push({ ...b, r: b.kw - ac - (o.pump?.(b.epoch) ?? 0) - base });
  }
  flush();
  return out.sort((a, b) => a.start - b.start);
}

/** The 3-bucket median filter; an end bucket takes the lower of itself and its neighbour, so an inflated first or last bucket goes too. */
export function medianFilter(r: number[]) {
  const n = r.length;
  return r.map((v, i) => n < 2 ? v : i === 0 ? Math.min(v, r[1]) : i === n - 1 ? Math.min(v, r[n - 2]) : med([r[i - 1], v, r[i + 1]]));
}
type Level = { from: number; to: number; vals: number[]; level: number };
/** Piecewise-constant levels of the filtered series, with one-bucket step edges joined to the higher side. */
export function levelsOf(f: number[]): Level[] {
  const lv: Level[] = []; let cur: Level = { from: 0, to: 1, vals: [f[0]], level: f[0] };
  for (let i = 1; i < f.length; i++) {
    if (Math.abs(f[i] - cur.level) >= Math.max(STEP_KW, STEP_FRAC * Math.abs(cur.level))) { lv.push(cur); cur = { from: i, to: i + 1, vals: [f[i]], level: f[i] }; }
    else { cur.vals.push(f[i]); cur.to = i + 1; cur.level = med(cur.vals); }
  }
  lv.push(cur);
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k < lv.length - 1; k++) {
      const a = lv[k - 1], m = lv[k], c = lv[k + 1];
      if (m.vals.length !== 1 || !(Math.min(a.level, c.level) < m.level && m.level < Math.max(a.level, c.level))) continue;
      const into = a.level > c.level ? a : c;
      into.from = Math.min(into.from, m.from); into.to = Math.max(into.to, m.to); into.vals = [...into.vals, ...m.vals]; into.level = med(into.vals);
      lv.splice(k, 1); changed = true; break;
    }
  }
  return lv;
}
function segmentBursts(seg: Seg[], switches: Switch[]): LoadBurst[] {
  const r = seg.map(s => s.r), f = medianFilter(r), lv = levelsOf(f);
  // pair each step down with the nearest earlier unpaired step up of similar size
  const ups: Array<{ k: number; size: number; used: boolean }> = [], pairs: Array<{ s: number; e: number; floor: number; size: number }> = [];
  for (let k = 1; k < lv.length; k++) {
    const d = lv[k].level - lv[k - 1].level;
    if (d > 0) { ups.push({ k, size: d, used: false }); continue; }
    for (let j = ups.length - 1; j >= 0; j--) {
      const u = ups[j]; if (u.used || Math.abs(-d - u.size) > PAIR_TOL * u.size) continue;
      u.used = true; pairs.push({ s: lv[u.k].from, e: lv[k].from, floor: lv[u.k - 1].level, size: u.size }); break;
    }
  }
  const active = (i: number) => pairs.filter(p => p.s <= i && i < p.e);
  const out: LoadBurst[] = [];
  for (const p of pairs) {
    const at = active(p.s), same = (i: number) => { const a = active(i); return a.length === at.length && a.every(x => at.includes(x)); };
    const idx = Array.from({ length: p.e - p.s }, (_, j) => p.s + j), own = idx.filter(same);
    const kw = own.length ? med(own.map(i => f[i] - p.floor)) : p.size, minutes = (p.e - p.s) * 5;
    if (!(kw >= MIN_KW) || minutes < MIN_MINUTES) continue;
    const startT = seg[p.s].epoch, endT = seg[p.e - 1].epoch + B;
    if (switches.some(w => (Math.abs(w.ts - startT) <= B || Math.abs(w.ts - endT) <= B) && Math.abs(kw - w.kw) <= AC_EDGE_TOL * w.kw)) continue;   // the AC mask's edge
    const kwh = idx.reduce((a, i) => a + (own.includes(i) ? Math.min(Math.max(0, r[i] - p.floor), KWH_CAP * kw) : kw) / 12, 0);
    out.push({ start: startT, day: seg[p.s].day, hour: seg[p.s].hour, minutes, kw: r2(kw), kwh: r3(kwh), overlap: at.length > 1 });
  }
  return out;
}

/* ======================= signatures, clusters and names (pure) ======================= */
export const KW_BANDS = [1.5, 2.5, 3.5, 4.5, 5.5, 7, Infinity], MIN_BANDS = [10, 20, 45, 90, Infinity];
export const DAYPARTS: ReadonlyArray<readonly [string, number, number]> = [['night', 0, 6], ['morning', 6, 12], ['afternoon', 12, 17], ['evening', 17, 21], ['late', 21, 24]];
export const partOf = (hour: number) => DAYPARTS.find(([, a, b]) => hour >= a && hour < b)![0];
/** The band key, e.g. "k2m1" (2.5–3.5 kW, 20–45 min); null below 1.5 kW or 10 minutes. */
export function bandOf(kw: number, minutes: number) {
  const k = KW_BANDS.findIndex((lo, i) => kw >= lo && kw < KW_BANDS[i + 1]), m = MIN_BANDS.findIndex((lo, i) => minutes >= lo && minutes < MIN_BANDS[i + 1]);
  return k < 0 || m < 0 ? null : `k${k}m${m}`;
}
export type Label = { id: number; sig: string; name: string | null; kw: number; minutes: number; daypart: string | null; dismissed: boolean };
export type StoredBurst = LoadBurst & { sig: string | null; labelId: number | null };
const named = (labels: Label[]) => labels.filter(l => l.name && !l.dismissed);
/** The nearest named centre within ±20% kW and 1.5× the minutes (part of day breaks a tie), or null. */
export function matchLabel(b: { kw: number; minutes: number; hour: number }, labels: Label[]): number | null {
  let best: { id: number; d: number } | null = null;
  for (const l of named(labels)) {
    if (Math.abs(b.kw - l.kw) > MATCH_KW * l.kw || b.minutes > l.minutes * MATCH_MIN || b.minutes < l.minutes / MATCH_MIN) continue;
    const d = Math.abs(b.kw - l.kw) / l.kw + Math.abs(Math.log(b.minutes / l.minutes)) + (l.daypart && l.daypart !== partOf(b.hour) ? .01 : 0);
    if (!best || d < best.d || (d === best.d && l.id < best.id)) best = { id: l.id, d };
  }
  return best?.id ?? null;
}

export type Suggestion = { name: string; text: string };
export type Badge = 'learned' | 'estimated' | 'learning';
export type Cluster = {
  sig: string; labelId: number | null; name: string | null; dismissed: boolean; hue: number | null;
  kw: number; minutes: number; daypart: string | null; count: number; days: number; kwhPerDay: number; perDay: number;
  hist: number[]; window: { from: number; to: number } | null; suggestion: Suggestion | null; badge: Badge; overlap: number; found: boolean;
};
/** The smallest run of hours (wrapping midnight) holding 80% of the starts; null when it is longer than 8 hours (day and night). */
export function windowOf(counts: number[]) {
  const total = counts.reduce((a, v) => a + v, 0); if (!total) return null;
  for (let len = 1; len <= 8; len++) {
    let best: { from: number; n: number } | null = null;
    for (let h = 0; h < 24; h++) { let n = 0; for (let j = 0; j < len; j++) n += counts[(h + j) % 24]; if (n >= .8 * total && (!best || n > best.n)) best = { from: h, n }; }
    if (best) return { from: best.from, to: (best.from + len) % 24 };
  }
  return null;
}
const shareIn = (counts: number[], from: number, to: number) => { const t = counts.reduce((a, v) => a + v, 0); let n = 0; for (let h = from; h < to; h++) n += counts[h]; return t ? n / t : 0; };
/** A common appliance when the shape fits; text only, the owner decides. */
export function suggest(kw: number, minutes: number, counts: number[]): Suggestion | null {
  const allDay = windowOf(counts) == null;
  if (kw >= 3.5 && kw <= 5.5 && minutes <= 45 && allDay) return { name: 'Water heater', text: 'Looks like the water heater.' };
  if (kw >= 4 && kw <= 6 && minutes >= 30 && minutes <= 75 && shareIn(counts, 17, 23) >= .6) return { name: 'Dryer', text: 'Looks like the dryer.' };
  if (kw >= 2 && kw <= 3.5 && minutes >= 30 && minutes <= 90 && shareIn(counts, 16, 20) >= .6) return { name: 'Oven', text: 'Looks like the oven.' };
  if (kw >= 1.5 && kw <= 2.5 && minutes >= 45 && minutes <= 120 && shareIn(counts, 21, 24) >= .6) return { name: 'Dishwasher', text: 'Could be the dishwasher.' };
  return null;
}
/**
 * Clusters from up to 60 days of bursts. Bursts that match a named centre form that name's cluster; the rest group by band (one cluster per band at any
 * time of day; support is 8 bursts on 4 days in the last 30). `days30`: days detected in the last 30.
 * Returned: every named cluster, every cluster with support, and smaller ones (3+ bursts) as "learning"; the remainder is `unsorted`.
 */
export function clusterLoads(bursts: StoredBurst[], labels: Label[], o: { today: string; days30: number }) {
  const from30 = addDays(o.today, -WINDOW_DAYS), from7 = addDays(o.today, -7), from14 = addDays(o.today, -14), days30 = Math.max(1, o.days30);
  const hueOf = new Map(named(labels).sort((a, b) => a.id - b.id).map((l, i) => [l.id, i]));
  const bySig = new Map(labels.map(l => [l.sig, l]));
  const groups = new Map<string, StoredBurst[]>(), add = (k: string, b: StoredBurst) => { const g = groups.get(k); if (g) g.push(b); else groups.set(k, [b]); };
  const sorted = [...bursts].sort((a, b) => a.start - b.start), loose = new Map<string, StoredBurst[]>();
  for (const b of sorted) {
    const id = matchLabel(b, labels), l = id != null ? labels.find(x => x.id === id)! : null;
    if (l) { add(l.sig, b); continue; }
    const sig = bandOf(b.kw, b.minutes); if (!sig) continue;
    const g = loose.get(sig); if (g) g.push(b); else loose.set(sig, [b]);
  }
  const supported = (bs: StoredBurst[]) => { const r = bs.filter(b => b.day >= from30); return r.length >= SUPPORT_N && new Set(r.map(b => b.day)).size >= SUPPORT_DAYS; };
  const unsorted: StoredBurst[] = [];
  // a band's bursts outside a named centre's tolerance never join that name's cluster: they stay unsorted
  const addLoose = (k: string, b: StoredBurst) => { const l = bySig.get(k); if (l?.name && !l.dismissed) unsorted.push(b); else add(k, b); };
  // one appliance can straddle a band edge (a 4.4 and a 4.7 kW water heater fall in two kW bands): join unnamed bands whose centres
  // are within 15% kW and 1.5× the minutes, into the band with more runs, so the list shows it once
  const centre = (bs: StoredBurst[]) => ({ kw: med(bs.map(b => b.kw)), minutes: med(bs.map(b => b.minutes)) });
  for (let joined = true; joined;) {
    joined = false;
    const keys = [...loose.keys()].sort();
    for (let i = 0; i < keys.length && !joined; i++) for (let j = i + 1; j < keys.length && !joined; j++) {
      const a = loose.get(keys[i])!, b = loose.get(keys[j])!, ca = centre(a), cb = centre(b);
      if (Math.abs(ca.kw - cb.kw) <= .15 * Math.min(ca.kw, cb.kw) && Math.max(ca.minutes, cb.minutes) <= 1.5 * Math.min(ca.minutes, cb.minutes)) {
        const [keep, drop] = a.length >= b.length ? [keys[i], keys[j]] : [keys[j], keys[i]];
        loose.set(keep, [...loose.get(keep)!, ...loose.get(drop)!].sort((x, y) => x.start - y.start)); loose.delete(drop); joined = true;
      }
    }
  }
  for (const [sig, bs] of [...loose].sort(([a], [b]) => a.localeCompare(b))) {
    // one cluster per band, whatever the time of day (mockup am frame 4: a water heater is one row, "5–7× a day, day and night");
    // when it runs is the row's 24-hour strip, not a reason to split it
    for (const b of bs) addLoose(sig, b);
  }
  const clusters: Cluster[] = [];
  for (const l of named(labels)) if (!groups.has(l.sig)) groups.set(l.sig, []);
  for (const [sig, bs] of groups) {
    const l = bySig.get(sig) ?? null, isNamed = !!(l?.name && !l.dismissed), r30 = bs.filter(b => b.day >= from30), use = r30.length ? r30 : bs;
    const counts = Array<number>(24).fill(0); for (const b of use) counts[b.hour]++;
    const top = Math.max(1, ...counts), found = supported(bs);
    if (!isNamed && !found && r30.length < 3) { unsorted.push(...bs); continue; }
    const kw = use.length ? r2(med(use.map(b => b.kw))) : l!.kw, minutes = use.length ? Math.round(med(use.map(b => b.minutes))) : l!.minutes;
    const overlap = use.length ? r2(use.filter(b => b.overlap).length / use.length) : 0;
    const wk1 = bs.filter(b => b.day >= from7), wk2 = bs.filter(b => b.day >= from14 && b.day < from7);
    const steady = !!wk1.length && !!wk2.length && Math.abs(med(wk1.map(b => b.kw)) - med(wk2.map(b => b.kw))) <= STEADY_KW * med(wk2.map(b => b.kw));
    const badge: Badge = !found ? 'learning' : isNamed && r30.length >= LEARNED_N && steady && overlap <= .5 ? 'learned' : 'estimated';
    const dash = sig.indexOf('-');
    clusters.push({ sig, labelId: isNamed ? l!.id : null, name: isNamed ? l!.name : null, dismissed: !!l?.dismissed, hue: isNamed ? hueOf.get(l!.id) ?? null : null,
      kw, minutes, daypart: l?.daypart ?? (dash > 0 ? sig.slice(dash + 1) : null), count: r30.length, days: new Set(r30.map(b => b.day)).size,
      kwhPerDay: r2(r30.reduce((a, b) => a + b.kwh, 0) / days30), perDay: r2(r30.length / days30),
      hist: counts.map(v => r2(v / top)), window: windowOf(counts), suggestion: isNamed || l?.dismissed ? null : suggest(kw, minutes, counts), badge, overlap, found });
  }
  // named first, then the ones with support, then the still-learning, each by kWh a day; "Not one appliance" last
  clusters.sort((a, b) => (+!!b.name - +!!a.name) || (+a.dismissed - +b.dismissed) || (+b.found - +a.found) || (b.kwhPerDay - a.kwhPerDay) || a.sig.localeCompare(b.sig));
  const u30 = unsorted.filter(b => b.day >= from30);
  return { clusters, unsorted: { count: u30.length, kwhPerDay: r2(u30.reduce((a, b) => a + b.kwh, 0) / days30) } };
}

/** A name from the sheet: trimmed, 1–24 printable characters; null when it isn't one. */
export function labelName(v: unknown) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length >= 1 && [...s].length <= 24 && /^[^\p{C}]+$/u.test(s) ? s : null;
}

/* ======================= database ======================= */
const clustersKey = (siteId: string) => `${siteId}:loads:clusters`, cursorKey = (siteId: string) => `${siteId}:loads:cursor`;
export async function labelsOf(siteId: string): Promise<Label[]> {
  return (await q<any>(`SELECT id::int id, sig, name, kw::float8 kw, minutes::int minutes, daypart, dismissed FROM load_labels WHERE site_id = $1 ORDER BY id`, [siteId]))
    .map(l => ({ id: l.id, sig: l.sig, name: l.name, kw: Number(l.kw), minutes: Number(l.minutes), daypart: l.daypart, dismissed: !!l.dismissed }));
}
type DayInputs = { buckets: LoadBucket[]; byDay: Map<string, LoadBucket[]>; nest: Array<{ ts: number; day: string; hvac: string }>; pool: Array<{ ts: number; day: string; hour: number; running: boolean; watts: number; rpm: number }> };
/** Energy, Nest and pool readings for [from, to], one range query each. */
export async function loadInputs(siteId: string, from: string, to: string): Promise<DayInputs> {
  const [rows, nest, pool] = await Promise.all([
    q<{ epoch: string; day: string; hour: number; wh: number }>(`SELECT epoch::text, day, hour::int, home_wh::float8 wh FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3 AND home_wh IS NOT NULL ORDER BY epoch`, [siteId, from, to]),
    q<{ ts: string; day: string; hvac: string }>(`SELECT ts::text, day, hvac FROM nest_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`, [siteId, addDays(from, -1), to]),
    q<{ ts: string; day: string; hour: number; running: boolean; watts: number; rpm: number }>(`SELECT ts::text, day, hour::int, running, watts::float8 watts, rpm::float8 rpm FROM pool_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`, [siteId, addDays(from, -1), to]),
  ]);
  const buckets = rows.map(r => ({ epoch: Number(r.epoch), day: r.day, hour: r.hour, kw: Number(r.wh) * 12 / 1000 })), byDay = new Map<string, LoadBucket[]>();
  for (const b of buckets) { const a = byDay.get(b.day); if (a) a.push(b); else byDay.set(b.day, [b]); }
  return { buckets, byDay, nest: nest.map(r => ({ ts: Number(r.ts), day: r.day, hvac: r.hvac })), pool: pool.map(p => ({ ts: Number(p.ts), day: p.day, hour: p.hour, running: p.running, watts: Number(p.watts) || 0, rpm: Number(p.rpm) || 0 })) };
}
/**
 * The bursts of [from, to] from its inputs (the same rule the breakdown uses): each day's base is breakdown.ts's nightBase (AC and
 * pump masked); only full days (90% of their buckets; any part of today) with Nest covering 80% count. Returns the counted days too.
 */
export function burstsFrom(inp: DayInputs, from: string, to: string, o: { coolKw: number; heatKw: number | null; clearUp?: { startedAt: number; until: number } | null; now?: number }) {
  const now = o.now ?? Date.now(), spans = daySpans(addDays(from, -1), addDays(to, 1), now);
  const acOn = acMask(inp.nest), covered = nestCoverage(inp.nest);
  const night = inp.pool.filter(p => p.hour <= 4).map(p => ({ ts: p.ts, day: p.day, running: pumpRunning(p), kw: p.watts / 1000 })), pumpOn = pumpMask(night, o.clearUp ?? null);
  const pumpKw = new Map<string, number>(); for (const r of night) if (r.running) pumpKw.set(r.day, Math.max(pumpKw.get(r.day) ?? 0, r.kw));
  const bases = new Map<string, number | null>(), counted: string[] = [];
  for (const s of spans) {
    const bs = inp.byDay.get(s.day) ?? [];
    bases.set(s.day, bs.length ? nightBase(bs, acOn, pumpOn, pumpKw.get(s.day) ?? 0) : null);
    if (s.day < from || s.day > to || !s.elapsedMs) continue;
    const full = s.elapsedMs < s.lengthMs || bs.length >= .9 * (s.lengthMs / B);
    if (full && (covered.get(s.day) ?? 0) >= NEST_COVERAGE * s.elapsedMs / 60_000 && bases.get(s.day) != null) counted.push(s.day);
  }
  const days = new Set(counted);
  const bursts = detectBursts(inp.buckets, { base: d => bases.get(d) ?? null, ac: acDraw(inp.nest, o.coolKw, o.heatKw), pump: pumpDraw(inp.pool), switches: acSwitches(inp.nest, o.coolKw, o.heatKw) })
    .filter(b => days.has(b.day));
  return { bursts, days: counted };
}
const acKws = async (siteId: string) => {
  const slope = (await kv.get<{ slope: number }>(`${siteId}:ac:slope`))?.slope ?? 2.5, learned = await learnAcKw(siteId);
  return { coolKw: acKwFor(learned.coolKw, slope), heatKw: learned.heatKw ?? null };
};
/** Detect and store the bursts of [from, to] (each day's rows replaced, so a re-run changes nothing), then its daily totals. */
export async function storeDays(siteId: string, from: string, to: string, now = Date.now(), ctx?: { kws?: { coolKw: number; heatKw: number | null }; labels?: Label[] }) {
  const kws = ctx?.kws ?? await acKws(siteId), labels = ctx?.labels ?? await labelsOf(siteId);
  const inp = await loadInputs(siteId, addDays(from, -1), addDays(to, 1));
  const { bursts, days } = burstsFrom(inp, from, to, { ...kws, clearUp: await kv.get<{ startedAt: number; until: number } | null>(`${siteId}:pool:clearup`) ?? null, now });
  const all: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) all.push(d);
  await q(`DELETE FROM load_bursts WHERE site_id = $1 AND day = ANY($2::text[])`, [siteId, all]);
  if (bursts.length) {
    const seq = new Map<number, number>(), rows = bursts.map(b => { const n = seq.get(b.start) ?? 0; seq.set(b.start, n + 1); return { ...b, seq: n, sig: bandOf(b.kw, b.minutes), labelId: matchLabel(b, labels) }; });
    await q(`INSERT INTO load_bursts (site_id, start, seq, day, hour, minutes, kw, kwh, overlap, sig, label_id, v)
      SELECT $1, * FROM unnest($2::bigint[], $3::smallint[], $4::text[], $5::smallint[], $6::smallint[], $7::real[], $8::real[], $9::bool[], $10::text[], $11::int[], $12::smallint[])`,
      [siteId, rows.map(r => r.start), rows.map(r => r.seq), rows.map(r => r.day), rows.map(r => r.hour), rows.map(r => r.minutes), rows.map(r => r.kw), rows.map(r => r.kwh),
        rows.map(r => r.overlap), rows.map(r => r.sig), rows.map(r => r.labelId), rows.map(() => LOADS_V)]);
  }
  await refreshTotals(siteId, all, days);
  return { days: all.length, counted: days.length, bursts: bursts.length };
}
/** daily_metrics `load:<labelId>` / `load:unnamed` (kWh) and `load:count` for `days` (only `counted` days get rows: the detected days). */
export async function refreshTotals(siteId: string, days: string[], counted: string[] = days) {
  await q(`DELETE FROM daily_metrics WHERE site_id = $1 AND day = ANY($2::text[]) AND metric LIKE 'load:%'`, [siteId, days]);
  if (!counted.length) return;
  await q(`INSERT INTO daily_metrics (site_id, day, metric, value)
    SELECT $1, d, 'load:count', (SELECT COUNT(*) FROM load_bursts b WHERE b.site_id = $1 AND b.day = d)::float8 FROM unnest($2::text[]) d
    UNION ALL SELECT $1, day, 'load:' || COALESCE(label_id::text, 'unnamed'), SUM(kwh)::float8 FROM load_bursts WHERE site_id = $1 AND day = ANY($2::text[]) GROUP BY day, label_id`, [siteId, counted]);
}
async function storedBursts(siteId: string, from: string): Promise<StoredBurst[]> {
  return (await q<any>(`SELECT start::text AS start, day, hour::int AS hour, minutes::int AS minutes, kw::float8 AS kw, kwh::float8 AS kwh, overlap, sig, label_id FROM load_bursts WHERE site_id = $1 AND day >= $2 AND v >= $3 ORDER BY start, seq`, [siteId, from, LOADS_V]))
    .map(r => ({ start: Number(r.start), day: r.day, hour: r.hour, minutes: r.minutes, kw: Number(r.kw), kwh: Number(r.kwh), overlap: !!r.overlap, sig: r.sig, labelId: r.label_id ?? null }));
}
/** Recluster from 60 days of stored bursts; cached in kv `<site>:loads:clusters`. */
export async function recluster(siteId: string, now = Date.now(), labels?: Label[]) {
  const today = localDay(new Date(now)), ls = labels ?? await labelsOf(siteId);
  const [bursts, [n]] = await Promise.all([storedBursts(siteId, addDays(today, -RECLUSTER_DAYS)),
    q<{ n: number; since: string | null }>(`SELECT COUNT(*) FILTER (WHERE day >= $2)::int n, MIN(day) since FROM daily_metrics WHERE site_id = $1 AND metric = 'load:count'`, [siteId, addDays(today, -WINDOW_DAYS)])]);
  const out = { v: LOADS_V, at: now, day: today, days: n?.n ?? 0, since: n?.since ?? null, ...clusterLoads(bursts, ls, { today, days30: n?.n ?? 0 }) };
  await kv.set(clustersKey(siteId), out);
  return out;
}
export type LoadsView = Awaited<ReturnType<typeof recluster>>;
/** The cached clusters (rebuilt when missing or from an older day). */
export async function loadClusters(siteId: string, now = Date.now()): Promise<LoadsView> {
  const hit = await kv.get<LoadsView>(clustersKey(siteId));
  return hit && hit.day === localDay(new Date(now)) && hit.v === LOADS_V ? hit : recluster(siteId, now);
}

/**
 * Nightly step (after the learning layer): yesterday, then the back-fill from kv `<site>:loads:cursor` (the newest day stored in order;
 * at most 30 days back), a week of range queries at a time, stopping 8 s before the deadline; then a recluster from 60 days.
 */
export async function loadsNightly(siteId: string, now = Date.now(), o: { deadline?: number; clock?: () => number } = {}) {
  const today = localDay(new Date(now)), yesterday = addDays(today, -1), floor = addDays(today, -BACKFILL_DAYS);
  // bursts stored by an older detector (LOADS_V): their days are detected again from the floor
  const stale = (await q(`SELECT 1 FROM load_bursts WHERE site_id = $1 AND day >= $2 AND v < $3 LIMIT 1`, [siteId, floor, LOADS_V])).length > 0;
  const cursor = stale ? null : await kv.get<string>(cursorKey(siteId)), first = cursor && cursor >= floor ? addDays(cursor, 1) : floor;
  const clock = o.clock ?? Date.now, late = () => o.deadline != null && o.deadline - clock() < STOP_BEFORE_MS;   // `clock`: tests only
  const chunks: Array<[string, string]> = [[yesterday, yesterday]];
  for (let d = first; d < yesterday; d = addDays(d, CHUNK_DAYS)) { const e = addDays(d, CHUNK_DAYS - 1); chunks.push([d, e < yesterday ? e : addDays(yesterday, -1)]); }
  const ctx = { kws: await acKws(siteId), labels: await labelsOf(siteId) }, done: Array<[string, string]> = [];
  let stopped: string | null = null;
  for (const [a, b] of chunks) {
    if (late()) { stopped = a; break; }
    await storeDays(siteId, a, b, now, ctx); done.push([a, b]);
    if (b < yesterday) await kv.set(cursorKey(siteId), b);   // a back-fill week is in
  }
  if (!stopped) await kv.set(cursorKey(siteId), yesterday);
  if (late()) return { done, stopped: stopped ?? 'recluster', skipped: 'out of time; tomorrow night' };
  const c = await recluster(siteId, now, ctx.labels);
  return stopped ? { done, stopped, skipped: 'out of time; tomorrow night', clusters: c.clusters.length } : { done, clusters: c.clusters.length };
}

/** After a name changes: every stored burst of the last 60 days re-matched, their daily totals rebuilt, and a recluster. */
async function relabel(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), from = addDays(today, -RECLUSTER_DAYS), labels = await labelsOf(siteId), bursts = await storedBursts(siteId, from);
  const changed = bursts.map(b => ({ b, id: matchLabel(b, labels) })).filter(x => x.id !== x.b.labelId);
  if (changed.length) await q(`UPDATE load_bursts l SET label_id = x.id FROM unnest($2::bigint[], $3::int[]) AS x(start, id) WHERE l.site_id = $1 AND l.start = x.start`,
    [siteId, changed.map(x => x.b.start), changed.map(x => x.id)]);
  const days = (await q<{ day: string }>(`SELECT day FROM daily_metrics WHERE site_id = $1 AND metric = 'load:count' AND day >= $2`, [siteId, from])).map(r => r.day);
  if (days.length) await refreshTotals(siteId, days);
  return recluster(siteId, now, labels);
}

/** POST /api/loads/label: {sig, name} names a cluster (from its current centre), {sig, dismissed: true} is "Not one appliance", {id, name: null} unnames. */
export async function setLabel(siteId: string, body: any, now = Date.now()): Promise<{ error: string; status: number } | LoadsView> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected an object', status: 400 };
  if (body.id != null) {
    if (!Number.isInteger(body.id) || body.name !== null || Object.keys(body).some(k => k !== 'id' && k !== 'name')) return { error: 'to unname, send {id, name: null}', status: 400 };
    const r = await q(`UPDATE load_labels SET name = NULL, dismissed = false WHERE site_id = $1 AND id = $2 RETURNING id`, [siteId, body.id]);
    if (!r.length) return { error: 'no such name', status: 404 };
    return relabel(siteId, now);
  }
  if (typeof body.sig !== 'string' || !/^k\d+m\d+(-[a-z]+)?$/.test(body.sig)) return { error: 'sig must be a load signature', status: 400 };
  const dismiss = body.dismissed === true, name = dismiss ? null : labelName(body.name);
  if (Object.keys(body).some(k => k !== 'sig' && k !== (dismiss ? 'dismissed' : 'name'))) return { error: 'send {sig, name} or {sig, dismissed: true}', status: 400 };
  if (!dismiss && name == null) return { error: 'name must be 1–24 printable characters', status: 400 };
  const c = (await loadClusters(siteId, now)).clusters.find(x => x.sig === body.sig) ?? null;
  const old = (await labelsOf(siteId)).find(l => l.sig === body.sig) ?? null;
  if (!c && !old) return { error: 'no such load', status: 404 };
  const kw = c?.kw ?? old!.kw, minutes = c?.minutes ?? old!.minutes, daypart = c?.daypart ?? old?.daypart ?? null;
  await q(`INSERT INTO load_labels (site_id, sig, name, kw, minutes, daypart, dismissed) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (site_id, sig) DO UPDATE SET name = excluded.name, dismissed = excluded.dismissed,
      kw = CASE WHEN load_labels.name IS NULL THEN excluded.kw ELSE load_labels.kw END, minutes = CASE WHEN load_labels.name IS NULL THEN excluded.minutes ELSE load_labels.minutes END,
      daypart = CASE WHEN load_labels.name IS NULL THEN excluded.daypart ELSE load_labels.daypart END`, [siteId, body.sig, name, kw, minutes, daypart, dismiss]);
  return relabel(siteId, now);
}

/** GET /api/loads and POST /api/loads/label. Owner-only: redact.ts has no guest view for either, so a guest is refused. */
export function loadsRoutes(app: Express, site: (req: Request) => string, wrap: (fn: (req: Request, res: any) => Promise<unknown>) => any) {
  app.get('/api/loads', wrap(async (req, res) => res.json(await loadClusters(site(req)))));
  app.post('/api/loads/label', express.json(), wrap(async (req, res) => {
    const r = await setLabel(site(req), req.body);
    if ('error' in r) return res.status(r.status).json({ error: r.error });
    res.json(r);
  }));
}
