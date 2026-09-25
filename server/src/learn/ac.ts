// AC learning (docs/audit-designs/learning-layer.md §5.6, §7; owner decisions 2026-09-25, audit questions 19, 21 and 22):
//  - savings: "kWh shifted onto solar" and "evening kWh avoided", estimated from the plan's setpoints until control days measure them;
//  - control days: 1 in 5 eligible hot, sunny days (every 5th, by a counter in kv) holds the plain comfort band so the pre-cool
//    days have something to be compared with;
//  - trims: learned from the indoor trajectory of the last three pre-cool days and applied automatically, bounded (at most 1 °F or
//    30 minutes, never outside the comfort band), recorded on the plan with the reason, undoable for the day. The trimmed setpoints
//    reach the thermostat only through acTick, so the safety guard (guards.ts) bounds every write exactly as before.
// Only types come from appliances/ac.ts, so there is no import cycle.
import type { AcPlan, AcSettings } from '../appliances/ac.js';
import { AC_MIN_F, AC_MAX_F } from '../appliances/guards.js';
import { kv } from '../db.js';
import { localDay } from '../tesla/client.js';
import { lq, logPrediction } from './store.js';
import { confidence, type Tier } from './confidence.js';
import { MODELS, mean, median, round } from './models.js';

/** The middle of the home band, as planFor computes it: the setpoint pre-cool and coast are measured from. */
export const bandMid = (s: AcSettings) => Math.min(s.band.homeHi, Math.max(s.band.homeLo, Math.round((s.band.homeLo + s.band.homeHi) / 2)));
const clock = (h: number) => { const H = Math.floor(h) % 24, M = Math.round((h % 1) * 60); return `${H % 12 || 12}${M ? ':' + String(M).padStart(2, '0') : ''} ${H < 12 ? 'AM' : 'PM'}`; };
const niceDay = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const and = (a: string[]) => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;

/* ---------- savings ---------- */
/**
 * The one setpoint-sensitivity constant until control days measure the real figure: the heat model's kWh per °F of daily high
 * (the `slope`) is spread over a hot day's 12 cooling hours, so holding the setpoint 1 °F lower for one hour costs slope / 12 kWh.
 */
export const COOLING_HOURS = 12;
/**
 * The plan's two savings figures, from its own setpoint steps against the middle of the home band:
 *   shiftedKwh        = Σ over the pre-cool hours (before coastFrom) of kPerDegH × °F below the middle × hours: cooling moved into solar hours;
 *   eveningAvoidedKwh = Σ over the coast hours (coastFrom → coastTo) of kPerDegH × °F above the middle × hours: cooling the evening skips.
 * Each is capped at what the AC can draw in its window (acKw × hours). A plan without pre-cool saves nothing.
 */
export function acSavings(p: Pick<AcPlan, 'steps' | 'precool' | 'coastFrom' | 'coastTo'>, s: AcSettings, slope: number, acKw: number | null) {
  const k = slope / COOLING_HOURS;
  if (!p.precool || !p.steps.length) return { shiftedKwh: 0, eveningAvoidedKwh: 0, kPerDegH: round(k, 3) };
  const mid = bandMid(s), steps = [...p.steps].sort((a, b) => a.hour - b.hour);
  const at = (h: number) => [...steps].reverse().find(x => x.hour <= h) ?? steps[steps.length - 1];
  const bounds = [...new Set([s.nightTo, p.coastFrom, p.coastTo, ...steps.map(x => x.hour)])].filter(h => h >= s.nightTo && h <= p.coastTo).sort((a, b) => a - b);
  let shifted = 0, evening = 0, preH = 0, coastH = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], dur = bounds[i + 1] - a, off = mid - at(a).coolF;
    if (a < p.coastFrom && off > 0) { shifted += k * off * dur; preH += dur; }
    else if (a >= p.coastFrom && off < 0) { evening += k * -off * dur; coastH += dur; }
  }
  if (acKw) { shifted = Math.min(shifted, acKw * preH); evening = Math.min(evening, acKw * coastH); }
  return { shiftedKwh: round(shifted), eveningAvoidedKwh: round(evening), kPerDegH: round(k, 3) };
}

/* ---------- control days ---------- */
export const CONTROL_EVERY = 5;
export type ControlState = { count: number; days: Record<string, boolean> };
/**
 * Whether `day` is a control day. The first time a day is seen eligible (the plan would pre-cool) the counter goes up by one and
 * every 5th eligible day is a control day; the decision is then kept for the whole day. Days that are not eligible don't count.
 */
export function controlDecision(st: ControlState | null | undefined, day: string, eligible: boolean): { state: ControlState; control: boolean; changed: boolean } {
  const cur: ControlState = st ?? { count: 0, days: {} };
  if (day in cur.days) return { state: cur, control: cur.days[day], changed: false };
  if (!eligible) return { state: cur, control: false, changed: false };
  const count = cur.count + 1, control = count % CONTROL_EVERY === 0;
  const days = Object.fromEntries(Object.entries({ ...cur.days, [day]: control }).sort(([a], [b]) => a.localeCompare(b)).slice(-60));
  return { state: { count, days }, control, changed: true };
}
export const controlKey = (siteId: string) => `${siteId}:ac:control`;
/** controlDecision against kv, taken atomically: if two invocations decide the same day at once, the first write wins and both use it. */
export async function claimControlDay(siteId: string, day: string, eligible: boolean): Promise<boolean> {
  const key = controlKey(siteId), d = controlDecision(await kv.get<ControlState>(key), day, eligible);
  if (!d.changed) return d.control;
  const won = await lq(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE NOT (kv.value->'days' ? $3) RETURNING key`, [key, JSON.stringify(d.state), day]);
  return won.length ? d.control : !!(await kv.get<ControlState>(key))?.days?.[day];
}

/* ---------- trims ---------- */
export const TRIM_MAX_F = 1, TRIM_MAX_MIN = 30;
export type AcTrim = { what: 'coast' | 'depth'; amount: number; unit: 'min' | '°F'; reason: string; warmupFPerH?: number | null };
export type TrimRecord = AcTrim & { day: string; undone?: boolean; undoneAt?: number };
export type AppliedTrim = AcTrim & { from: number; to: number };

/** One pre-cool day as the trims see it: the plan's windows (hours, fractional after a coast trim) and that day's Nest readings. */
export type PrecoolDay = { day: string; coastF: number; deep: number; from: number; to: number; coastFrom: number; coastTo: number;
  readings: Array<{ h: number; indoorF: number | null; hvac: string }> };
/** What happened on a pre-cool day: when the house reached coastF, its temperature when the coast ended, AC minutes per hour of the
 *  pre-cool window, whether it got down to the pre-cool setpoint, and the house's warm-up rate (°F/h) while the AC was off. */
export function precoolOutcome(d: PrecoolDay) {
  const r = [...d.readings].sort((a, b) => a.h - b.h);
  const reached = r.find(x => x.h >= d.to && x.h < d.coastTo + 1 && x.indoorF != null && x.indoorF >= d.coastF - .25);
  const end = r.filter(x => x.indoorF != null && Math.abs(x.h - d.coastTo) <= 1 / 3).sort((a, b) => Math.abs(a.h - d.coastTo) - Math.abs(b.h - d.coastTo))[0];
  let cool = 0;
  for (let i = 0; i + 1 < r.length; i++) {
    const a = Math.max(r[i].h, d.from), b = Math.min(r[i + 1].h, r[i].h + 1 / 3, d.to);
    if (b > a && r[i].hvac === 'COOLING') cool += b - a;
  }
  const warm = r.filter(x => x.h >= d.to && x.h <= (reached?.h ?? d.coastTo) && x.hvac === 'OFF' && x.indoorF != null);
  let warmup: number | null = null;
  if (warm.length >= 3 && warm.at(-1)!.h - warm[0].h >= .5) {
    const mh = mean(warm.map(x => x.h)), mf = mean(warm.map(x => x.indoorF!));
    warmup = round(warm.reduce((a, x) => a + (x.h - mh) * (x.indoorF! - mf), 0) / warm.reduce((a, x) => a + (x.h - mh) ** 2, 0), 2);
  }
  return { reachedAt: reached?.h ?? null, atCoastEnd: end?.indoorF ?? null, runMinPerH: d.to > d.from ? cool / (d.to - d.from) * 60 : 0,
    reachedDeep: r.some(x => x.h >= d.from && x.h < d.to + .5 && x.indoorF != null && x.indoorF <= d.deep + .5), warmup };
}
/**
 * The trim for the next plan, from the last three pre-cool days (the design's estimators, with the owner's 30-minute bound):
 *   depth −1 °F  when the AC ran ≥ 50 min an hour through the pre-cool and never reached the pre-cool setpoint on 2 of 3 days;
 *   coast −30 min when the house reached coastF more than an hour before the coast ended on 2 of 3 days;
 *   coast +30 min when the house was still ≤ coastF − 1 when the coast ended on all 3 days.
 * At most one trim, in that order. Fewer than three pre-cool days: none.
 */
export function trimFor(days: PrecoolDay[]): AcTrim | null {
  const last = [...days].sort((a, b) => a.day.localeCompare(b.day)).slice(-3);
  if (last.length < 3) return null;
  const o = last.map(d => ({ d, ...precoolOutcome(d) }));
  const w = o.map(x => x.warmup).filter((v): v is number => v != null), warmupFPerH = w.length ? round(median(w), 1) : null;
  const rate = warmupFPerH != null ? ` (warming about ${warmupFPerH} °F an hour)` : '';
  const flat = o.filter(x => x.runMinPerH >= 50 && !x.reachedDeep);
  if (flat.length >= 2) return { what: 'depth', amount: 1, unit: '°F', warmupFPerH,
    reason: `the AC ran 50+ minutes an hour through the pre-cool and never got the house down to ${flat[0].d.deep}° on ${and(flat.map(x => niceDay(x.d.day)))}` };
  const early = o.filter(x => x.reachedAt != null && x.reachedAt <= x.d.coastTo - 1);
  if (early.length >= 2) return { what: 'coast', amount: -TRIM_MAX_MIN, unit: 'min', warmupFPerH,
    reason: `the house reached ${early[0].d.coastF}° by ${and(early.map(x => `${clock(x.reachedAt!)} on ${niceDay(x.d.day)}`))}, over an hour before the coast ended${rate}` };
  if (o.every(x => x.atCoastEnd != null && x.atCoastEnd <= x.d.coastF - 1)) return { what: 'coast', amount: TRIM_MAX_MIN, unit: 'min', warmupFPerH,
    reason: `the house was still at or below ${o[0].d.coastF - 1}° when the coast ended on each of the last 3 pre-cool days${rate}` };
  return null;
}
/**
 * The plan with a trim applied, or null when the trim is out of bounds: more than 1 °F or 30 minutes, a coast shorter than 2 hours
 * or past 21:00, less than 1 °F of pre-cool, or any setpoint outside the comfort band or the guard's 65–85 °F range.
 */
export function applyTrim(plan: AcPlan, trim: AcTrim, s: AcSettings): AcPlan | null {
  if (!plan.precool || plan.control || !trim.amount) return null;
  const mid = bandMid(s), steps = plan.steps.map(x => ({ ...x }));
  let coastTo = plan.coastTo, from: number, to: number, text: string;
  if (trim.what === 'depth') {
    if (trim.unit !== '°F' || Math.abs(trim.amount) > TRIM_MAX_F) return null;
    const pre = steps.filter(x => x.hour >= s.nightTo && x.hour < plan.coastFrom && x.coolF < mid);
    if (!pre.length) return null;
    from = Math.min(...pre.map(x => x.coolF));
    for (const x of pre) x.coolF += trim.amount;
    to = Math.min(...pre.map(x => x.coolF));
    if (mid - to < 1) return null;
    text = `pre-cool to ${to}° instead of ${from}°`;
  } else {
    if (trim.unit !== 'min' || Math.abs(trim.amount) > TRIM_MAX_MIN) return null;
    const ev = steps.find(x => x.hour === plan.coastTo); if (!ev) return null;
    from = plan.coastTo; to = plan.coastTo + trim.amount / 60;
    if (to < plan.coastFrom + 2 || to > 21) return null;
    ev.hour = coastTo = to;
    text = `coast ends at ${clock(to)} instead of ${clock(from)}`;
  }
  const lo = Math.max(AC_MIN_F, Math.min(s.band.homeLo, s.band.nightLo)), hi = Math.min(AC_MAX_F, Math.max(s.band.homeHi, s.band.nightHi));
  if (steps.some(x => x.coolF < lo || x.coolF > hi)) return null;
  steps.sort((a, b) => a.hour - b.hour);
  const applied: AppliedTrim = { what: trim.what, amount: trim.amount, unit: trim.unit, reason: trim.reason, warmupFPerH: trim.warmupFPerH ?? null, from, to };
  return { ...plan, steps, coastTo, trim: applied, why: [...plan.why, `Trimmed: ${text}, because ${trim.reason}`] };
}

/* ---------- measured savings from control days ---------- */
export const MATCH = { days: 45, highF: 3, sunKwhM2: 1.5, minControls: 2 }, MEASURED_MIN_DAYS = 5;
/** One eligible day (pre-cool or control) with its plan windows and the Nest hours: cooling minutes and mean cooling setpoint per local hour. */
export type AcDay = { day: string; control: boolean; precool: boolean; high: number; sunKwhM2: number; mid: number; from: number; to: number; coastFrom: number; coastTo: number;
  hours: Record<number, { coolMin: number; coolF: number | null }> };
const span = (a: number, b: number) => { const out: Array<[number, number]> = []; for (let h = Math.floor(a); h < b; h++) { const w = Math.min(h + 1, b) - Math.max(h, a); if (w > 0) out.push([h, w]); } return out; };
/** Cooling kWh in [a, b) (partial hours weighted), or null when an hour of the window has no Nest readings. */
export function windowKwh(d: AcDay, a: number, b: number, kw: number): number | null {
  let min = 0;
  for (const [h, w] of span(a, b)) { const x = d.hours[h]; if (!x) return null; min += x.coolMin * w; }
  return min / 60 * kw;
}
const windowSetpoint = (d: AcDay, a: number, b: number) => { const v = span(a, b).map(([h]) => d.hours[h]?.coolF).filter((x): x is number => x != null); return v.length ? mean(v) : null; };
/** Whether the thermostat really followed the day's plan: a pre-cool day ran at least 1 °F under the middle, a control day held it. */
export const ranPrecool = (d: AcDay) => d.precool && !d.control && (windowSetpoint(d, d.from, d.to) ?? Infinity) <= d.mid - 1;
export const ranControl = (d: AcDay) => d.control && (windowSetpoint(d, d.from, d.to) ?? -Infinity) >= d.mid - .5;
/**
 * Measured savings: for each pre-cool day that ran, the matched control days (within 45 days, high within 3 °F, sun within
 * 1.5 kWh/m²; at least 2) give the baseline, over the pre-cool day's own windows:
 *   shifted = its cooling kWh in the pre-cool window − the controls' mean in the same window
 *   evening = the controls' mean cooling kWh in the coast window − its own.
 * `measured` once 5 pre-cool days have a comparison.
 */
export function measuredSavings(days: AcDay[], kw: number) {
  const controls = days.filter(ranControl), used = new Set<string>();
  const perDay: Array<{ day: string; shiftedKwh: number; eveningAvoidedKwh: number; controls: number }> = [];
  const gap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  for (const d of days.filter(ranPrecool)) {
    const m = controls.filter(c => gap(c.day, d.day) <= MATCH.days && Math.abs(c.high - d.high) <= MATCH.highF && Math.abs(c.sunKwhM2 - d.sunKwhM2) <= MATCH.sunKwhM2);
    const pre = windowKwh(d, d.from, d.to, kw), coast = windowKwh(d, d.coastFrom, d.coastTo, kw);
    const cPre = m.map(c => windowKwh(c, d.from, d.to, kw)).filter((v): v is number => v != null);
    const cCoast = m.map(c => windowKwh(c, d.coastFrom, d.coastTo, kw)).filter((v): v is number => v != null);
    if (pre == null || coast == null || cPre.length < MATCH.minControls || cCoast.length < MATCH.minControls) continue;
    m.forEach(c => used.add(c.day));
    perDay.push({ day: d.day, shiftedKwh: round(pre - mean(cPre), 2), eveningAvoidedKwh: round(mean(cCoast) - coast, 2), controls: cPre.length });
  }
  return { perDay, shiftedKwh: perDay.length ? round(mean(perDay.map(x => x.shiftedKwh))) : null, eveningAvoidedKwh: perDay.length ? round(mean(perDay.map(x => x.eveningAvoidedKwh))) : null,
    precoolDays: perDay.length, controlDays: used.size, measured: perDay.length >= MEASURED_MIN_DAYS && used.size >= MATCH.minControls };
}

/* ---------- the plan hook (acDetail) ---------- */
/** What the nightly job leaves for the AC plan in kv `<site>:learn:ac`. */
export type LearnAc = { at: number; day: string; trim: TrimRecord | null; warmupFPerH: number | null; coolKw: number | null;
  measured: { measured: boolean; shiftedKwh: number | null; eveningAvoidedKwh: number | null; precoolDays: number; controlDays: number } | null };
export const learnAcKey = (siteId: string) => `${siteId}:learn:ac`;
type PlanInput = { date: string; high: number; sunKwhM2: number; humidity: number | null; settings: AcSettings; slope: number; acKw: number | null };

/**
 * Today's plan with the learning layer on top: a control day plans the plain comfort band; otherwise the nightly trim is applied
 * (unless undone); the savings figures carry `conf` (estimated until control days measure them, then measured). Eligible days
 * (pre-cool or control) log both figures as predictions, once per instance. Two kv reads, plus one write on a new eligible day.
 */
export async function learnedPlan<I extends PlanInput>(siteId: string, input: I, plan: (o: I & { control?: boolean }) => AcPlan, acKw: number): Promise<AcPlan> {
  const s = input.settings, base = plan(input);
  const control = base.precool && input.date === localDay() && await claimControlDay(siteId, input.date, true);
  let p = control ? plan({ ...input, control: true }) : base;
  const learn = await kv.get<LearnAc>(learnAcKey(siteId)) ?? null, t = learn?.trim?.day === input.date ? learn.trim : null;
  if (t && !t.undone) p = applyTrim(p, t, s) ?? p;
  else if (t?.undone && p.precool) p = { ...p, why: [...p.why, 'Today’s learned trim was undone, so the plan runs untrimmed'] };
  const est = acSavings(p, s, input.slope, input.acKw ?? acKw), m = learn?.measured?.measured ? learn.measured : null;
  const tier: Tier = confidence(MODELS['ac.shifted'], null, input.date, !!m && p.precool).tier;
  const out: AcPlan = { ...p, trim: p.trim ?? null, shiftedKwh: m && p.precool ? m.shiftedKwh ?? est.shiftedKwh : est.shiftedKwh,
    eveningAvoidedKwh: m && p.precool ? m.eveningAvoidedKwh ?? est.eveningAvoidedKwh : est.eveningAvoidedKwh,
    conf: { shiftedKwh: tier, eveningAvoidedKwh: tier } };
  if (base.precool) {
    // the windows that ran (after a trim), or on a control day the pre-cool plan it held back from, which the scoring compares against
    const ran = out.precool ? out : base, mid = bandMid(s), pre = ran.steps.filter(x => x.hour >= s.nightTo && x.hour < ran.coastFrom && x.coolF < mid);
    const inputs = { high: input.high, sunKwhM2: input.sunKwhM2, humidity: input.humidity, precool: out.precool, control, mid, depth: pre.length ? mid - Math.min(...pre.map(x => x.coolF)) : 0,
      from: pre.length ? Math.min(...pre.map(x => x.hour)) : ran.precoolFrom, to: ran.coastFrom, coastFrom: ran.coastFrom, coastTo: ran.coastTo,
      coastF: s.coastF, acKw: input.acKw ?? acKw, slope: input.slope, kPerDegH: est.kPerDegH, trim: out.trim ? { what: out.trim.what, amount: out.trim.amount } : null };
    await logPrediction(siteId, [{ model: 'ac.shifted', day: input.date, value: est.shiftedKwh, inputs }, { model: 'ac.eveningAvoided', day: input.date, value: est.eveningAvoidedKwh, inputs }], { once: true })
      .catch(e => console.warn(`[learn] AC prediction not logged: ${e?.message ?? e}`));
  }
  return out;
}

/** Undo today's trim (POST /api/appliances/ac/untrim). Returns the trim, or null when there is none today. Logged in the AC log. */
export async function untrim(siteId: string, day = localDay()): Promise<TrimRecord | null> {
  const key = learnAcKey(siteId), learn = await kv.get<LearnAc>(key);
  if (!learn?.trim || learn.trim.day !== day) return null;
  if (!learn.trim.undone) {
    learn.trim = { ...learn.trim, undone: true, undoneAt: Date.now() };
    await kv.set(key, learn);
    const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:ac:log`) ?? [];
    log.unshift({ at: Date.now(), day, text: `Undid today’s learned trim (${learn.trim.what === 'depth' ? `pre-cool ${learn.trim.amount > 0 ? '+' : ''}${learn.trim.amount} °F` : `coast ${learn.trim.amount > 0 ? '+' : ''}${learn.trim.amount} min`})`, delta: 'undone' });
    await kv.set(`${siteId}:ac:log`, log.slice(0, 40));
  }
  return learn.trim;
}
