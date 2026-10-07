// AC appliance: Nest state, AC power learned from Tesla's load steps, today's comfort plan (pre-cool on solar surplus, coast on the
// Powerwalls) inside the owner's comfort band, and an Autopilot that suggests or applies the plan's setpoint steps through the day.
import { q, kv } from '../db.js';
import { localDay, addDays, rfc3339 } from '../tesla/client.js';
import { readNest, nestConfigured, nestLinked, setCool, type NestState } from './nest.js';
import { forecastAged } from './autopilot.js';
import type { Mode } from './autopilot.js';
import { lastSetpointWrite } from './nest.js';
import { guardCoolSetpoint, explainRefusal, GuardRefusal } from './guards.js';
import { acSavings, learnedPlan, bandMid, type AppliedTrim } from '../learn/ac.js';
import { median } from '../learn/models.js';
import type { Tier } from '../learn/confidence.js';
import { presenceFor, PRESENCE_FIXED } from './presence.js';
import { changed, ours, holdUntil, holdOver, morningAfter, getHold, setHold, lastSent, SAME_F, type Hold, type HoldBy } from './hold.js';
import { SPARE_SOC } from '../spare.js';
import { liveTrip } from '../vacation/trip.js';
import { tripAcTick, tripAcView } from '../vacation/ac.js';

export type AcSettings = { band: { homeLo: number; homeHi: number; nightLo: number; nightHi: number }; awayF: number; nightFrom: number; nightTo: number; precoolDepth: number; coastF: number; maxStepF: number; humidityCap: number; autopilot: Mode; presence: 'home' | 'away';
  /** mockup ag: the comfort targets (°F); the band is derived from them (withTargets). Missing on settings saved before ag. */
  dayF?: number; nightF?: number; driftF?: number };
export type AcTargets = { dayF: number; nightF: number; driftF: number };
const DEFAULTS: AcSettings = { band: { homeLo: 74, homeHi: 78, nightLo: 74, nightHi: 76 }, awayF: 80, nightFrom: 22, nightTo: 7, precoolDepth: 2, coastF: 78, maxStepF: 2, humidityCap: 60, autopilot: 'suggest', presence: 'home' };
export { DEFAULTS as AC_DEFAULTS };
/**
 * Mockup ag: the comfort targets and the band they stand for. Autopilot aims for dayF (nightTo → nightFrom) and nightF overnight, pre-cools
 * to dayF − precoolDepth and drifts to dayF + driftF; the band is that range (homeLo–homeHi) and the night target (nightLo = nightHi), so the
 * guards, trims and limits that read the band keep working. Settings saved before ag carry over exactly: dayF = the band's middle,
 * nightF = the night setpoint the plan used, precoolDepth = how far the pre-cool really went, driftF = how far the coast really went.
 */
export function withTargets(s: AcSettings): AcSettings & AcTargets {
  const b = s.band, mid = Math.min(b.homeHi, Math.max(b.homeLo, Math.round((b.homeLo + b.homeHi) / 2)));   // the plan's middle before ag
  const legacy = s.dayF == null, dayF = s.dayF ?? mid;
  const nightF = s.nightF ?? Math.max(b.nightLo, Math.min(b.nightHi, mid));
  const precoolDepth = Math.max(0, Math.min(3, legacy ? Math.min(s.precoolDepth, mid - b.homeLo) : s.precoolDepth));
  const driftF = Math.max(0, Math.min(2, s.driftF ?? Math.min(s.coastF, b.homeHi) - mid));
  const lo = clampF(dayF - precoolDepth), hi = clampF(dayF + driftF);
  return { ...s, dayF, nightF, driftF, precoolDepth, coastF: hi, band: { homeLo: lo, homeHi: hi, nightLo: nightF, nightHi: nightF } };
}
const clampF = (v: number) => Math.max(65, Math.min(85, v));   // guards.ts AC_MIN_F / AC_MAX_F
/** The owner's AC settings, merged over the defaults, with the targets filled in. */
export const acSettingsOf = (all: Record<string, any>): AcSettings & AcTargets => withTargets({ ...DEFAULTS, ...(all.ac ?? {}), band: { ...DEFAULTS.band, ...(all.ac?.band ?? {}) } });
/** The Chicago hour with minutes as a fraction (19.5 = 19:30), so a step at a half hour (a learned coast trim) applies on time. */
const hourNow = () => { const t = rfc3339(new Date()); return Number(t.slice(11, 13)) + Number(t.slice(14, 16)) / 60; };

/* ---------- readings and learning ---------- */
export async function recordNest(siteId: string, st: NestState) {
  const d = new Date(st.at);
  await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [siteId, st.at, localDay(d), Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d)) % 24, st.indoorF, st.humidity, st.mode, st.hvac, st.coolF, st.heatF, st.eco]);
}
type AcLearned = { coolKw: number | null; heatKw: number | null; samples: number; heatSamples: number; diag?: { lateKw: number | null; lateSamples: number; regressionKw: number | null; regressionHours: number } };
const LEARN_TTL_MS = 3600e3;
/** v2: the clean-switch method; a new key so the old cached figure is never reused. */
export const acLearnedKey = (siteId: string) => `${siteId}:ac:learned:v2`;
/**
 * AC power learned from load steps: for each pair of consecutive readings where HVAC switched between COOLING and OFF within 10 min,
 * the difference in Tesla's 5-minute home power across the switch. Median over the last 14 days; null until 5 samples exist.
 * Cached in kv (`<site>:ac:learned:v2`) for an hour, so app reads and the 5-minute cron share one computation; new transitions show up
 * on the first call after the entry expires.
 */
export async function learnAcKw(siteId: string): Promise<AcLearned> {
  const key = acLearnedKey(siteId), hit = await kv.get<{ at: number; learned: AcLearned }>(key), age = hit ? Date.now() - hit.at : -1;
  if (hit && age >= 0 && age < LEARN_TTL_MS && hit.learned.diag) return hit.learned;   // an entry without the checks is from before them
  const learned = await computeAcKw(siteId);
  await kv.set(key, { at: Date.now(), learned });
  return learned;
}
/**
 * The AC's draw from Tesla's home load at clean on/off switches (v2, 2026-10). A switch counts only when the thermostat held the old
 * state for the reading before and the new state for the reading after (no short cycling), and the step is taken between the 5-minute
 * bucket that ends before the switch window and the one that starts after it. (v1 used the buckets containing the readings; those
 * straddle the switch, so the step came out about half the real draw: 1.7 kW against ~4.3 kW for this 3.5-ton system.)
 * Buckets are labelled by their start. Median over the last 14 days; null until 5 samples exist.
 */
export function acStepsFrom(rows: Array<{ ts: number; hvac: string }>, kwAt: (start: number) => number | null) {
  const steps: number[] = [], heat: number[] = [], B = 300_000, near = (a: number, b: number) => b - a <= 10 * 60_000;
  for (let i = 2; i < rows.length - 1; i++) {
    const p2 = rows[i - 2], p1 = rows[i - 1], n0 = rows[i], n1 = rows[i + 1];
    if (p1.hvac === n0.hvac || !(p1.hvac === 'OFF' || n0.hvac === 'OFF')) continue;                  // a switch between OFF and a running state
    if (p2.hvac !== p1.hvac || n1.hvac !== n0.hvac || !near(p2.ts, p1.ts) || !near(p1.ts, n0.ts) || !near(n0.ts, n1.ts)) continue;   // steady on both sides
    const before = kwAt(Math.floor(p1.ts / B) * B - B), after = kwAt(Math.ceil(n0.ts / B) * B);          // whole buckets outside the switch window
    if (before == null || after == null) continue;
    const on = n0.hvac !== 'OFF', d = on ? after - before : before - after, running = on ? n0.hvac : p1.hvac;
    if (d > .5 && d < 15) (running === 'HEATING' ? heat : steps).push(d);
  }
  const med = (a: number[]) => a.length >= 5 ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  return { coolKw: med(steps), heatKw: med(heat), samples: steps.length, heatSamples: heat.length };
}
async function computeAcKw(siteId: string): Promise<AcLearned> {
  const since = addDays(localDay(), -14);
  const rows = (await q<{ ts: string; hvac: string }>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND day >= $2 ORDER BY ts`, [siteId, since])).map(r => ({ ts: Number(r.ts), hvac: r.hvac }));
  if (rows.length < 4) return { coolKw: null, heatKw: null, samples: 0, heatSamples: 0 };
  const buckets = await q<{ epoch: string; kw: number | null }>(`SELECT epoch::text, (home_wh * 12 / 1000.0)::float8 kw FROM energy WHERE site_id = $1 AND epoch BETWEEN $2 AND $3`,
    [siteId, rows[0].ts - 600_000, rows[rows.length - 1].ts + 600_000]);
  const byStart = new Map(buckets.map(b => [Number(b.epoch), b.kw]));
  return { ...acStepsFrom(rows, start => byStart.get(start) ?? null), diag: acDiagnostics(rows, byStart) };
}
/** Two independent checks of the step (for verifying v2 on real data): the step 10–15 min after a start once a variable-speed unit has
 *  ramped, and an hourly fixed-effects regression of home kWh on AC-on hours (each clock hour compared only with the same hour on other days). */
export function acDiagnostics(rows: Array<{ ts: number; hvac: string }>, byStart: Map<number, number | null>) {
  const B = 300_000, late: number[] = [];
  for (let i = 2; i < rows.length - 3; i++) {
    const p2 = rows[i - 2], p1 = rows[i - 1], n0 = rows[i], n3 = rows[i + 3];
    if (p1.hvac !== 'OFF' || n0.hvac !== 'COOLING' || p2.hvac !== 'OFF' || rows[i + 1].hvac !== 'COOLING' || rows[i + 2].hvac !== 'COOLING' || n3.hvac !== 'COOLING' || n3.ts - n0.ts > 20 * 60_000) continue;
    const before = byStart.get(Math.floor(p1.ts / B) * B - B), after = byStart.get(Math.ceil(n0.ts / B) * B + 2 * B);
    if (before != null && after != null && after - before > .5 && after - before < 15) late.push(after - before);
  }
  const hours = new Map<number, { on: number; hod: number }>();
  for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], dt = Math.min(20 * 60_000, rows[i].ts - a.ts); if (a.hvac !== 'COOLING') continue;
    for (let t = a.ts; t < a.ts + dt; t += 60_000) { const h = Math.floor(t / 3600_000) * 3600_000, e = hours.get(h) ?? { on: 0, hod: Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date(h))) % 24 }; e.on += 1 / 60; hours.set(h, e); } }
  const pts: Array<{ hod: number; x: number; y: number }> = [];
  const first = Math.floor(rows[0].ts / 3600_000) * 3600_000, last = rows[rows.length - 1].ts;
  for (let h = first; h < last - 3600_000; h += 3600_000) { let kwh = 0, n = 0; for (let k = 0; k < 12; k++) { const v = byStart.get(h + k * B); if (v != null) { kwh += v / 12; n++; } }
    if (n === 12) pts.push({ hod: Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date(h))) % 24, x: hours.get(h)?.on ?? 0, y: kwh }); }
  const byHod = new Map<number, typeof pts>(); pts.forEach(p => { const a = byHod.get(p.hod); if (a) a.push(p); else byHod.set(p.hod, [p]); });
  let sxy = 0, sxx = 0; for (const g of byHod.values()) { const mx = g.reduce((s, p) => s + p.x, 0) / g.length, my = g.reduce((s, p) => s + p.y, 0) / g.length; g.forEach(p => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }); }
  const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  return { lateKw: med(late), lateSamples: late.length, regressionKw: sxx ? Math.round(sxy / sxx * 100) / 100 : null, regressionHours: pts.length };
}
/** Today's run time and duty from readings. Each reading holds until the next, at most 20 min: the cron samples every 5 minutes
 *  in cooling-season daytime and every 15 minutes otherwise (sampling.ts), so a 15-minute gap counts in full. */
export async function runtimeToday(siteId: string) {
  const rows = await q<{ ts: string; hvac: string }>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND day = $2 ORDER BY ts`, [siteId, localDay()]);
  let on = 0, all = 0; for (let i = 1; i < rows.length; i++) { const dt = Math.min(20 * 60_000, Number(rows[i].ts) - Number(rows[i - 1].ts)); all += dt; if (rows[i - 1].hvac === 'COOLING') on += dt; }
  return { minutes: Math.round(on / 60_000), duty: all ? Math.round(on / all * 100) : null };
}
/** AC kW for energy figures: the learned cooling step, or an estimate from the heat model's slope until one is learned. */
export const acKwFor = (coolKw: number | null, slope: number) => coolKw ?? (slope ? Math.max(2, Math.min(5, slope * 1.3)) : 3.4);

/**
 * AC kWh for the History flows card (database only). A day whose Nest readings cover at least 80% of it (of the part elapsed, for
 * today), each reading holding until the next for at most 20 min as runtimeToday counts them, uses its COOLING time × the AC kW.
 * Any other day uses the heat model, `slope` kWh per °F of daily high above 80 (pro rata for a day in progress), when that day's high
 * is cached (the Open-Meteo archive `wx:highs`, else the forecast `pool:forecast`); a day with neither adds nothing.
 * `source`: 'readings' when every day used readings, 'heat-model' when any day used the model, else 'none'.
 */
export async function acKwhBetween(siteId: string, spans: Array<{ day: string; elapsedMs: number; lengthMs: number }>, slope: number) {
  const learned = await learnAcKw(siteId), acKw = acKwFor(learned.coolKw, slope);
  const rows = spans.length ? await q<{ ts: string; day: string; hvac: string }>(`SELECT ts::text, day, hvac FROM nest_readings WHERE site_id = $1 AND day BETWEEN $2 AND $3 ORDER BY ts`,
    [siteId, spans[0].day, spans[spans.length - 1].day]) : [];
  const covered = new Map<string, number>(), cooling = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], dt = Math.min(20 * 60_000, Number(rows[i].ts) - Number(a.ts));
    covered.set(a.day, (covered.get(a.day) ?? 0) + dt); if (a.hvac === 'COOLING') cooling.set(a.day, (cooling.get(a.day) ?? 0) + dt);
  }
  const archive = (await kv.get<{ byDay: Record<string, number> }>('wx:highs'))?.byDay ?? {}, fc = (await kv.get<{ days: Array<{ date: string; high: number }> }>('pool:forecast'))?.days ?? [];
  let kwh = 0, days = 0, readingDays = 0, modelDays = 0;
  for (const s of spans) {
    if (s.elapsedMs <= 0) continue;
    days++;
    const high = archive[s.day] ?? fc.find(d => d.date === s.day)?.high;
    if ((covered.get(s.day) ?? 0) >= .8 * s.elapsedMs) { kwh += (cooling.get(s.day) ?? 0) / 3600e3 * acKw; readingDays++; }
    else if (high != null) { kwh += slope * Math.max(0, high - 80) * s.elapsedMs / s.lengthMs; modelDays++; }
  }
  return { kwh: Math.round(kwh * 100) / 100, source: days && readingDays === days ? 'readings' as const : modelDays ? 'heat-model' as const : readingDays ? 'readings' as const : 'none' as const,
    days, readingDays, modelDays, acKw: Math.round(acKw * 100) / 100, acKwSource: learned.coolKw != null ? 'learned' as const : 'estimated' as const, slope: Math.round(slope * 100) / 100 };
}

/** Today's applied-plan record (kv `<site>:ac:plan`). precoolOn/precoolRan: the spare-solar pre-cool state. */
export type AcRecord = { date: string; approved: boolean; lastStepHour: number | null; precoolOn?: boolean; precoolRan?: boolean };

/* ---------- the plan ---------- */
export type AcStep = { hour: number; coolF: number; why: string };
export type AcPlan = { date: string; steps: AcStep[]; precool: boolean; precoolFrom: number; precoolTo: number; coastFrom: number; coastTo: number; high: number; sunKwhM2: number;
  /** Savings estimates (learn/ac.ts acSavings); on today's plan replaced by the measured figures once control days allow, with `conf`. */
  shiftedKwh: number; eveningAvoidedKwh: number; control: boolean; why: string[];
  trim?: AppliedTrim | null; conf?: { shiftedKwh: Tier; eveningAvoidedKwh: Tier } };
/**
 * Pre-cool to (homeLo) while the panels are strong when tomorrow/today is hot and sunny; coast up to coastF into the evening;
 * night band overnight; away target when marked away. Steps only ever move inside the band, and by at most maxStepF at a time.
 */
export function planFor(o: { date: string; high: number; sunKwhM2: number; hourlySun: number[]; settings: AcSettings; acKw: number | null; slope: number; rate: number | null; humidity: number | null; control?: boolean }): AcPlan {
  const s = withTargets(o.settings), why: string[] = [], steps: AcStep[] = [];
  const sunny = o.sunKwhM2 >= 4.5, hot = o.high >= 88, humid = (o.humidity ?? 0) >= s.humidityCap;
  const peak = o.hourlySun.reduce((bi, v, i, a) => v > a[bi] ? i : bi, 0), from = o.high >= 100 ? 11 : Math.max(11, peak - 2), to = Math.min(17, peak + 3);
  const precool = sunny && hot && !humid && s.presence === 'home' && !o.control && s.precoolDepth > 0;   // mockup ag: pre-cool Off // control day (learn/ac.ts): hold the band so savings can be measured
  const low = s.band.homeLo, mid = s.dayF, night = s.nightF;   // mockup ag: the targets (the same values the band gave before)
  if (s.presence === 'away') { steps.push({ hour: 0, coolF: s.awayF, why: 'marked away' }); why.push(`Away: holding ${s.awayF}° until you mark Home`); return { date: o.date, steps, precool: false, precoolFrom: from, precoolTo: to, coastFrom: to, coastTo: 21, high: Math.round(o.high), sunKwhM2: Math.round(o.sunKwhM2 * 10) / 10, shiftedKwh: 0, eveningAvoidedKwh: 0, control: false, why }; }
  steps.push({ hour: s.nightTo, coolF: mid, why: 'morning, comfort band' });
  if (precool) {
    const deep = Math.max(low, mid - s.precoolDepth); steps.push({ hour: from, coolF: deep, why: 'pre-cool on solar surplus' });
    steps.push({ hour: to, coolF: Math.min(s.coastF, s.band.homeHi), why: 'coast on the Powerwalls' });
    why.push(`Pre-cool to ${deep}° from ${from}:00 to ${to}:00 while the panels peak (${(Math.round(o.sunKwhM2 * 10) / 10)} kWh/m² of sun, high ${Math.round(o.high)}°)`);
    why.push(`Coast to ${Math.min(s.coastF, s.band.homeHi)}° until ${Math.min(21, to + 4)}:00 so the batteries carry a lighter evening`);
    if (o.high >= 100) why.push('Heat wave: pre-cool starts at 11:00 so the system never falls behind');
    why.push('Pre-cool runs only while the panels measurably cover the house and the AC; otherwise it holds the band and skips the coast');
  } else why.push(o.control ? 'Control day: holding the comfort band (1 in 5 hot, sunny days) so Solstice can measure what pre-cooling saves' : !hot ? `Mild day (high ${Math.round(o.high)}°): no pre-cool needed` : !sunny ? 'Cloudy: no solar surplus to pre-cool with' : humid ? `Humidity ${o.humidity}%: no coast, holding ${mid}°` : 'Holding the comfort band');
  steps.push({ hour: precool ? Math.min(21, to + 4) : 21, coolF: mid, why: 'evening, comfort band' });
  steps.push({ hour: s.nightFrom, coolF: night, why: 'night band' });
  steps.sort((a, b) => a.hour - b.hour);
  const plan = { date: o.date, steps, precool, precoolFrom: from, precoolTo: to, coastFrom: to, coastTo: Math.min(21, to + 4), high: Math.round(o.high), sunKwhM2: Math.round(o.sunKwhM2 * 10) / 10, shiftedKwh: 0, eveningAvoidedKwh: 0, control: !!o.control, why };
  const saved = acSavings(plan, s, o.slope, o.acKw); // kWh shifted onto solar and evening kWh avoided, vs holding the middle of the band
  return { ...plan, shiftedKwh: saved.shiftedKwh, eveningAvoidedKwh: saved.eveningAvoidedKwh };
}
export const stepAt = (plan: AcPlan, hour: number) => [...plan.steps].reverse().find(s => s.hour <= hour) ?? plan.steps[plan.steps.length - 1];

/* ---------- settings: what POST /api/appliances/ac/settings may change (mockup v frame 5) ---------- */
export const NIGHT_TO_RANGE = [4, 11] as const, NIGHT_FROM_RANGE = [18, 23] as const;
const whole = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
/**
 * Why an AC settings patch is unusable, or null. Only known keys pass; temperatures are whole degrees inside 65–85°F (the Autopilot
 * guard's range), each low at or below its high; night runs from 18–23 h to 4–11 h. `band` is checked merged with the current band.
 */
export function acPatchError(patch: Record<string, unknown>, cur: Partial<AcSettings>): string | null {
  const known = new Set(['band', 'awayF', 'nightFrom', 'nightTo', 'autopilot', 'presence', 'nestPresence', 'dayF', 'nightF', 'driftF', 'precoolDepth']);
  const bad = Object.keys(patch).filter(k => !known.has(k)); if (bad.length) return `unknown setting ${bad.join(', ').replace(/[^\w ,]/g, '')}`;
  if (patch.autopilot !== undefined && !['off', 'suggest', 'auto'].includes(patch.autopilot as string)) return 'bad mode';
  if (patch.presence !== undefined && !['home', 'away'].includes(patch.presence as string)) return 'bad presence';
  if (patch.nestPresence !== undefined && typeof patch.nestPresence !== 'boolean') return 'nestPresence must be true or false';
  if (patch.band !== undefined) {
    if (typeof patch.band !== 'object' || !patch.band) return 'band must be an object';
    const b = { ...DEFAULTS.band, ...(cur.band ?? {}), ...(patch.band as object) } as Record<string, unknown>;
    if (Object.keys(patch.band).some(k => !(k in DEFAULTS.band))) return 'band has unknown keys';
    if (!['homeLo', 'homeHi', 'nightLo', 'nightHi'].every(k => whole(b[k], AC_MIN, AC_MAX))) return `band temperatures must be whole degrees ${AC_MIN}–${AC_MAX}°`;
    if ((b.homeLo as number) > (b.homeHi as number) || (b.nightLo as number) > (b.nightHi as number)) return 'each low must be at or below its high';
  }
  if (patch.awayF !== undefined && !whole(patch.awayF, AC_MIN, AC_MAX)) return `away must be a whole degree ${AC_MIN}–${AC_MAX}°`;
  // mockup ag: the targets, checked merged with the current ones (pre-cool and drift may not leave 65–85°)
  for (const k of ['dayF', 'nightF'] as const) if (patch[k] !== undefined && !whole(patch[k], AC_MIN, AC_MAX)) return `${k === 'dayF' ? 'day' : 'night'} target must be a whole degree ${AC_MIN}–${AC_MAX}°`;
  if (patch.precoolDepth !== undefined && !whole(patch.precoolDepth, 0, 3)) return 'pre-cool must be 0–3°';
  if (patch.driftF !== undefined && !whole(patch.driftF, 0, 2)) return 'evening drift must be 0–2°';
  if (['dayF', 'precoolDepth', 'driftF'].some(k => patch[k] !== undefined)) {
    const t = { ...targetsOf(cur), ...patch } as AcTargets & { precoolDepth: number };
    if (t.dayF - t.precoolDepth < AC_MIN || t.dayF + t.driftF > AC_MAX) return `pre-cool and drift must stay inside ${AC_MIN}–${AC_MAX}°`;
  }
  if (patch.nightFrom !== undefined && !whole(patch.nightFrom, ...NIGHT_FROM_RANGE)) return `night starts between ${NIGHT_FROM_RANGE[0]}:00 and ${NIGHT_FROM_RANGE[1]}:00`;
  if (patch.nightTo !== undefined && !whole(patch.nightTo, ...NIGHT_TO_RANGE)) return `night ends between ${NIGHT_TO_RANGE[0]}:00 and ${NIGHT_TO_RANGE[1]}:00`;
  return null;
}
const AC_MIN = 65, AC_MAX = 85;   // guards.ts AC_MIN_F / AC_MAX_F; the band can never ask Autopilot for a refused target
/** The four target settings of `cur` (raw saved settings), filled in as withTargets would. */
export function targetsOf(cur: Partial<AcSettings>) {
  const t = acSettingsOf({ ac: cur }); return { dayF: t.dayF, nightF: t.nightF, driftF: t.driftF, precoolDepth: t.precoolDepth };
}
/** Saved settings after a patch: once a target is set, all four are stored (so nothing is derived from an old band again) with the band they stand for. */
export function patchedAc(cur: Record<string, any>, patch: Record<string, any>) {
  const next: Record<string, any> = { ...cur, ...patch, band: { ...(cur.band ?? {}), ...(patch.band ?? {}) } };
  if (!['dayF', 'nightF', 'driftF', 'precoolDepth'].some(k => patch[k] !== undefined)) return next;
  const t = acSettingsOf({ ac: { ...next, ...targetsOf(cur), ...patch } });
  return { ...next, dayF: t.dayF, nightF: t.nightF, driftF: t.driftF, precoolDepth: t.precoolDepth, band: t.band, coastF: t.coastF };
}

/* ---------- learning from holds (mockup v frame 7) ---------- */
export type HoldRecord = { at: number; day: string; hour: number; coolF: number; planF: number; by?: HoldBy };
export const holdHistoryKey = (siteId: string) => `${siteId}:ac:holdHistory`, suggestDismissKey = (siteId: string) => `${siteId}:ac:suggestDismissed`;
export type BandSuggestion = { key: string; window: 'night' | 'day'; f: number; hour: number; days: number; of: number; from: number };
const isNight = (h: number, s: Pick<AcSettings, 'nightFrom' | 'nightTo'>) => h >= s.nightFrom || h < s.nightTo;
/** A pattern of manual changes (mockup ae; grouping mockup ag): one per part of the day (day/night) and direction (warmer/cooler). */
export type ChangePattern = BandSuggestion & { dir: 1 | -1; planF: number; set: number[] };
/**
 * Every pattern in the last 7 days, the most days first. A change counts when it went the same way against the plan and against the
 * current target (so changes made before the target moved don't count again); `f` is that target moved 1° in that direction.
 */
export function changePatterns(holds: HoldRecord[], s0: AcSettings, today = localDay()): ChangePattern[] {
  const s = withTargets(s0), since = addDays(today, -6), recent = holds.filter(h => h.day >= since && h.day <= today && Math.round(h.coolF) !== Math.round(h.planF));
  const out: ChangePattern[] = [];
  for (const window of ['day', 'night'] as const) for (const dir of [1, -1] as const) {
    const from = window === 'night' ? s.nightF : s.dayF, f = from + dir;
    const g = recent.filter(h => (isNight(h.hour, s) ? 'night' : 'day') === window && Math.sign(h.coolF - h.planF) === dir && Math.sign(Math.round(h.coolF) - from) === dir);
    if (!g.length || f < AC_MIN || f > AC_MAX) continue;
    out.push({ key: `${window}:${f}`, window, f, hour: Math.round(median(g.map(h => h.hour))) % 24, days: new Set(g.map(h => h.day)).size, of: 7, from, dir,
      planF: Math.round(median(g.map(h => h.planF))), set: [...new Set(g.map(h => Math.round(h.coolF)))].sort((a, b) => dir * (b - a)) });   // farthest from the plan first
  }
  return out.sort((x, y) => y.days - x.days);
}
/** The same kind of change (part of the day, direction) on 4 of the last 7 days: move that target 1° that way. Null until then. */
export function bandSuggestion(holds: HoldRecord[], s: AcSettings, today = localDay()): BandSuggestion | null {
  const p = changePatterns(holds, s, today).find(x => x.days >= 4); if (!p) return null;
  const { dir: _d, planF: _p, set: _s, ...sg } = p; return sg;
}
/** The settings patch a suggestion stands for (mockup ag): the day or night target. */
export const suggestionPatch = (sg: Pick<BandSuggestion, 'window' | 'f'>) => sg.window === 'night' ? { nightF: sg.f } : { dayF: sg.f };
async function rememberHold(siteId: string, r: HoldRecord) {
  const h = await kv.get<HoldRecord[]>(holdHistoryKey(siteId)) ?? [];
  h.unshift(r); await kv.set(holdHistoryKey(siteId), h.slice(0, 40));
}
/** Today's suggestion unless "Not now" hid that same one in the last 14 days. */
export async function currentSuggestion(siteId: string, s: AcSettings, now = Date.now()) {
  const sg = bandSuggestion(await kv.get<HoldRecord[]>(holdHistoryKey(siteId)) ?? [], s); if (!sg) return null;
  const dis = await kv.get<Record<string, number>>(suggestDismissKey(siteId)) ?? {};
  return dis[sg.key] && now - dis[sg.key] < 14 * 864e5 ? null : sg;
}
export async function dismissSuggestion(siteId: string, key: string, now = Date.now()) {
  const dis = await kv.get<Record<string, number>>(suggestDismissKey(siteId)) ?? {};
  await kv.set(suggestDismissKey(siteId), Object.fromEntries([...Object.entries(dis).filter(([, t]) => now - t < 14 * 864e5), [key, now]]));
}

/* ---------- pre-cool only on spare solar (owner, Q7 of docs/audit-2026-10.md) ---------- */
// The house rarely has spare solar, so a forecast alone mostly pre-cooled on grid power. The pre-cool step now runs only while the
// panels measurably cover the rest of the house plus the AC. Spare is solar minus the house's load without the AC (the AC's own draw
// is added back while Nest says it is cooling), averaged over the last 15 minutes of live readings. It starts at a full AC's worth of
// spare and keeps going down to half of one, so the AC's own draw can't switch it straight back off.
export const SURPLUS_WINDOW_MS = 15 * 60_000, PRECOOL_START = 1, PRECOOL_KEEP = .5;
export function precoolDecision(o: { spareW: number | null; acKw: number; on: boolean }) {
  if (o.spareW == null) return false;
  return o.spareW >= (o.on ? PRECOOL_KEEP : PRECOOL_START) * o.acKw * 1000;
}
export async function spareSolarW(siteId: string, cooling: boolean, acKw: number, now = Date.now()) {
  // mockup ad: spare only while the Powerwalls are full (95%+); below that the "surplus" is charging them for the evening, not free
  const r = await q<{ n: number; w: number | null; soc: number | null }>(`SELECT COUNT(*)::int n, AVG(solar_w - load_w)::float8 w, AVG(soc)::float8 soc FROM readings WHERE site_id = $1 AND ts > $2 AND solar_w IS NOT NULL AND load_w IS NOT NULL`, [siteId, now - SURPLUS_WINDOW_MS]);
  if (!r[0] || r[0].n < 2 || r[0].w == null) return null;
  if (r[0].soc == null || r[0].soc < SPARE_SOC) return 0;
  return r[0].w + (cooling ? acKw * 1000 : 0);
}

/* ---------- frozen daily inputs and manual holds (mockup v) ---------- */
type DayInputs = { high: number; sunKwhM2: number; hourlySun: number[]; humidity: number | null };
export const FREEZE_FROM_HOUR = 6;
export const dayInputsKey = (siteId: string) => `${siteId}:ac:dayInputs`;
/** Today's weather inputs for the plan: the ones frozen at the first plan from 06:00 on, else live (and frozen now if it is 06:00 or later). */
export async function dayInputs(siteId: string, date: string, live: DayInputs, hour = hourNow()): Promise<DayInputs> {
  const key = dayInputsKey(siteId), got = await kv.get<DayInputs & { date: string }>(key);
  if (got?.date === date) return { high: got.high, sunKwhM2: got.sunKwhM2, hourlySun: got.hourlySun, humidity: got.humidity };
  if (hour >= FREEZE_FROM_HOUR) await kv.set(key, { date, ...live });
  return live;
}
const clockAt = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)).replace(/\s/g, ' ');
/** The thermostat's setting in words for the log and the banner: "72°", "heat 68°", "68–76°", "Off". */
/** A setpoint as the thermostat shows it: whole degrees (Nest keeps Celsius, so 78 °F reads back as 77.9). */
export const wholeF = (f: number | null | undefined) => f == null ? f : Math.round(f);
export const setting = (h: Pick<Hold, 'mode' | 'coolF' | 'heatF'>) => h.mode === 'OFF' ? 'Off' : h.mode === 'HEAT' ? `heat ${wholeF(h.heatF)}°` : h.mode === 'HEATCOOL' ? `${wholeF(h.heatF)}–${wholeF(h.coolF)}°` : `${wholeF(h.coolF)}°`;
type Log = Array<{ at: number; day: string; text: string; delta?: string }>;
async function logAc(siteId: string, text: string, delta?: string) {
  const log = await kv.get<Log>(`${siteId}:ac:log`) ?? [];
  log.unshift({ at: Date.now(), day: localDay(), text, delta }); await kv.set(`${siteId}:ac:log`, log.slice(0, 40));
}
/** After a hold ends, the step due now is applied again (subject to Autopilot's own guard). */
async function replan(siteId: string) { const rec = await kv.get<any>(`${siteId}:ac:plan`); if (rec) { rec.lastStepHour = null; await kv.set(`${siteId}:ac:plan`, rec); } }
/** Start a hold for a change made by `by` (the wall, or the owner's tap in Solstice). */
export async function startHold(siteId: string, by: HoldBy, st: Pick<NestState, 'mode' | 'coolF' | 'heatF'>, plan: Pick<AcPlan, 'steps'>, s: AcSettings, now = Date.now()) {
  const u = holdUntil(now, plan.steps, s.nightTo), h: Hold = { at: now, by, mode: st.mode, coolF: st.coolF, heatF: st.heatF, until: u.until, why: u.why };
  await setHold(siteId, h);
  if (st.mode === 'COOL' && st.coolF != null) {   // frame 7: what was set, against what the plan wanted then
    const t = rfc3339(new Date(now)), hour = Number(t.slice(11, 13)) + Number(t.slice(14, 16)) / 60;
    await rememberHold(siteId, { at: now, day: t.slice(0, 10), hour, coolF: st.coolF, planF: stepAt(plan as AcPlan, hour).coolF, by });
  }
  await logAc(siteId, `${by === 'app' ? 'You set' : 'Someone set'} ${setting(h)} ${by === 'app' ? 'in Solstice' : 'at the thermostat'} (${clockAt(now)}). Holding until ${clockAt(h.until)}`, 'hold');
  return h;
}
/**
 * The hold in force after this reading: end one that is over (time, or Away since it began), and start one when the thermostat
 * moved from the previous reading to something Solstice did not send. `prev` is null unless this call read Nest fresh.
 */
export async function observeHold(siteId: string, prev: NestState | null, st: NestState | null, plan: AcPlan, s: AcSettings, presence: { state: string; since: number | null }, now = Date.now()) {
  let h = await getHold(siteId);
  if (h) { const over = holdOver(h, now, presence);
    if (over) { await setHold(siteId, null); await replan(siteId); await logAc(siteId, over === 'away' ? `Away: ended the hold on ${setting(h)}; back to the plan` : `Hold on ${setting(h)} ended; back to the plan`, 'resumed'); h = null; } }
  if (st && changed(prev, st) && !ours(st, await lastSent(st.deviceId), now)) {
    const dup = h && now - h.at < 10 * 60_000 && h.mode === st.mode && setting(h) === setting(st);   // two readers saw the same change
    if (!dup) h = await startHold(siteId, 'wall', st, plan, s, now);
  }
  return h;
}
/** "Resume now": end the hold and let the step due now apply. */
export async function resumeHold(siteId: string) {
  const h = await getHold(siteId); if (!h) return null;
  await setHold(siteId, null); await replan(siteId); await logAc(siteId, `You resumed the plan (was holding ${setting(h)})`, 'resumed');
  return h;
}
/** "Hold until morning": run the hold to the plan's next morning step. */
export async function holdToMorning(siteId: string, s: Pick<AcSettings, 'nightTo'>, now = Date.now()) {
  const h = await getHold(siteId); if (!h) return null;
  const next: Hold = { ...h, until: morningAfter(now, s.nightTo), why: 'until the morning step, as you asked', extended: true };
  await setHold(siteId, next); await logAc(siteId, `Holding ${setting(h)} until ${clockAt(next.until)}`, 'hold');
  return next;
}

/* ---------- detail for the app ---------- */
/** What the AC card and acTick need to know about the forecast behind today's plan (code review C-04). */
export function fcInfo(fc: { stale: boolean; ageMs: number | null; unavailable?: true }) {
  const ageH = fc.ageMs == null ? null : Math.round(fc.ageMs / 3600e3);
  const note = fc.unavailable ? 'No forecast (Open-Meteo unreachable for over 12 h): Autopilot sends no plan steps until it is back'
    : fc.stale ? `Forecast is ${ageH} h old (Open-Meteo unreachable)` : null;
  return { stale: fc.stale, ageH, unavailable: !!fc.unavailable, note };
}
export async function acDetail(siteId: string, settingsAll: Record<string, any>, rate: number | null, slope: number, opts: { fresh?: boolean } = {}) {
  const settings = acSettingsOf(settingsAll);   // mockup ag: with the targets
  const presence = await presenceFor(siteId, settingsAll);   // presence.ts: manual "Away until", then Nest Eco, then home
  settings.presence = presence.state;
  const configured = nestConfigured(), linked = configured && await nestLinked();
  let st = await kv.get<NestState>('nest:last') ?? null, error: string | null = null;
  const prev = st; let fresh = false;
  if (linked && (opts.fresh || !st || Date.now() - st.at > 60_000)) { try { st = await readNest(); fresh = true; await recordNest(siteId, st); } catch (e: any) { error = e.message; } }
  const learned = await learnAcKw(siteId), rt = await runtimeToday(siteId);
  // code review C-04: Open-Meteo down → the last forecast up to 12 h old (stale); with none, a neutral day (high 90, sun 5), and
  // acTick sends no plan step, while Nest sampling, holds, Eco and Vacation mode carry on
  const fc = await forecastAged().catch((e: Error) => ({ days: [], stale: true, ageMs: null, error: e.message, unavailable: true as const }));
  const forecastInfo = fcInfo(fc);
  const days = fc.days, today = localDay(), ti = Math.max(0, days.findIndex(d => d.date === today));
  // today's plan through the learning layer: a control day holds the band, a learned trim applies, the savings carry `conf`.
  // The day's weather inputs are frozen at the first plan from 06:00 on, so a refreshed forecast or a humidity reading near the
  // cap can't flip the plan back and forth during the day (it used to re-plan every 5 minutes). With no forecast nothing is frozen.
  const inputs = await dayInputs(siteId, today, { high: days[ti]?.high ?? 90, sunKwhM2: days[ti]?.sunKwhM2 ?? 5, hourlySun: days[ti]?.hourlySun ?? Array(24).fill(0), humidity: st?.humidity ?? null },
    forecastInfo.unavailable ? -1 : hourNow());
  let plan = await learnedPlan(siteId, { date: today, ...inputs, settings, acKw: learned.coolKw, slope, rate },
    // with no forecast the plan is a neutral day: it claims no control day and logs no prediction (readOnly), so learning isn't fed made-up weather
    planFor, learned.coolKw ?? (slope ? Math.max(2, Math.min(5, slope * 1.3)) : 3.4), { readOnly: !!settingsAll[PRESENCE_FIXED as any] || forecastInfo.unavailable });
  // Vacation mode (mockup ak): during a trip the plan is the trip's setting now (the hold, or the welcome home), computed in vacation/ac.ts
  const trip = presence.source === 'vacation' ? await liveTrip(siteId) : null, vacation = trip ? tripAcView(trip, settings) : null;
  if (vacation) plan = { ...plan, steps: [{ hour: 0, coolF: vacation.now.coolF, why: vacation.now.why }], precool: false, shiftedKwh: 0, eveningAvoidedKwh: 0, control: false,
    why: [vacation.now.welcome ? `Welcome home: cooling to ${vacation.arrivalF}°` : `Vacation: holding ${vacation.holdF}°${vacation.humid ? ' to keep the house dry' : ''} while you're away`] };
  if (forecastInfo.note) plan = { ...plan, why: [...plan.why, forecastInfo.note] };
  const hold = await observeHold(siteId, fresh ? prev : null, st, plan, settings, presence);
  const week = days.slice(ti, ti + 7).map(d => { const p = planFor({ date: d.date, high: d.high, sunKwhM2: d.sunKwhM2, hourlySun: d.hourlySun, settings, acKw: learned.coolKw, slope, rate, humidity: null }); return { date: d.date, high: Math.round(d.high), sunKwhM2: Math.round(d.sunKwhM2 * 10) / 10, precool: p.precool, depth: p.precool ? settings.precoolDepth : 0, shiftedKwh: p.shiftedKwh, eveningAvoidedKwh: p.eveningAvoidedKwh, precoolFrom: p.precoolFrom, precoolTo: p.precoolTo, coastFrom: p.coastFrom, coastTo: p.coastTo }; });
  const applied = await kv.get<AcRecord>(`${siteId}:ac:plan`) ?? null;
  const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:ac:log`) ?? [];
  const acKw = acKwFor(learned.coolKw, slope);
  const todayKwh = Math.round(rt.minutes / 60 * acKw * 10) / 10;
  const home = await q<{ kwh: number }>(`SELECT (SUM(home_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day = $2`, [siteId, today]);
  const suggestion = await currentSuggestion(siteId, settings);
  // mockup ae: the manual changes of the last 7 days and the patterns building toward a suggestion (mockup ag: from the first day; 4 makes one)
  const holds = await kv.get<HoldRecord[]>(holdHistoryKey(siteId)) ?? [], since = addDays(today, -6);
  const changes = { recent: holds.filter(h => h.day >= since).map(h => ({ at: h.at, by: h.by ?? null, coolF: Math.round(h.coolF), planF: Math.round(h.planF) })),
    patterns: changePatterns(holds, settings, today).slice(0, 4).map(p => ({ hour: p.hour, f: p.f, from: p.from, planF: p.planF, dir: p.dir, days: p.days, need: 4, window: p.window, set: p.set })) };
  return { id: 'ac', name: 'AC', configured, linked, error: error ?? (forecastInfo.unavailable ? forecastInfo.note : null), forecast: forecastInfo, settings, state: st, hold, suggestion, changes, vacation, learned: { ...learned, acKw, source: learned.coolKw ? 'measured' : 'estimated' }, runtime: rt, todayKwh, shareOfHomePct: home[0]?.kwh ? Math.round(todayKwh / home[0].kwh * 100) : null,
    plan, currentStep: stepAt(plan, hourNow()), week, presence, applied: applied?.date === today ? applied : null, log, outdoorF: days[ti] ? Math.round(days[ti].high) : null, hourlyOutdoor: null,
    equipment: { airHandler: 'Trane TEM4A0C42 · 3.5 ton variable-speed (2018)', heat: 'electric strips (staged)',
      outdoor: learned.heatKw != null ? (learned.heatKw < 5 ? `heat pump (measured ${learned.heatKw.toFixed(1)} kW when heating)` : `straight AC, heating on the strips (measured ${learned.heatKw.toFixed(1)} kW)`) : 'outdoor unit type: Solstice will measure it from the first heating steps this winter' } };
}

/**
 * Called every 5 minutes by the cron: sample Nest, and if today's plan is approved (or Autopilot is Auto), apply the step due now.
 * Every write goes through the safety guard (guards.ts): Autopilot Off writes nothing, 65–85 °F, at most 2 °F per write, one write
 * per 30 minutes. Refused and stepped writes are recorded in the AC log.
 */
export async function acTick(siteId: string, settingsAll: Record<string, any>, rate: number | null, slope: number) {
  const d = await acDetail(siteId, settingsAll, rate, slope, { fresh: true });
  if (!d.linked || !d.state) return { sampled: false };
  // a Vacation-mode trip under way runs its own step (holds, Eco, humidity, the welcome), through the same guards
  if (d.vacation) { const trip = await liveTrip(siteId); if (trip) return { sampled: true, ...(await tripAcTick(siteId, d, trip)) }; }
  if (d.hold) return { sampled: true, applied: !!d.applied?.approved, held: true };   // hold.ts: a manual change is in force; skip the plan
  // Nest refuses a setpoint while Eco is on, so nothing is sent until Eco is off (it used to try, and fail, every 5 minutes). Logged once a day.
  if (d.state.eco) {
    const text = 'Nest is in Eco, so Autopilot sends nothing until Eco is off';
    if (d.log[0]?.text !== text || d.log[0]?.day !== localDay()) await logAc(siteId, text, 'eco');
    return { sampled: true, applied: false, eco: true };
  }
  // code review C-04: a stale forecast is said once in the log; with none at all no plan step is sent (logged once a day)
  if (d.forecast.note) {
    const today = localDay(), said = d.forecast.unavailable ? d.log[0]?.text === d.forecast.note && d.log[0]?.day === today
      : d.log.some(l => l.day === today && l.text.startsWith('Forecast is'));
    // into d.log itself, which the plan step below writes back
    if (!said) { d.log.unshift({ at: Date.now(), day: today, text: d.forecast.note }); await kv.set(`${siteId}:ac:log`, d.log.slice(0, 40)); }
    if (d.forecast.unavailable) return { sampled: true, applied: false, noForecast: true };
  }
  const s = d.settings, plan = d.plan, h = hourNow(), planStep = stepAt(plan, h);
  let rec: AcRecord | null = d.applied;
  if (!rec) {
    // a new day: before the morning step the step due is last night's night band; if yesterday already set it, it is done
    // (it used to be re-sent just after midnight over whatever was set since)
    const y = await kv.get<{ date: string; lastStepHour: number | null }>(`${siteId}:ac:plan`);
    const carried = y?.date === addDays(plan.date, -1) && h < plan.steps[0].hour && y.lastStepHour === planStep.hour ? planStep.hour : null;
    rec = { date: plan.date, approved: s.autopilot === 'auto', lastStepHour: carried } as AcRecord;
    await kv.set(`${siteId}:ac:plan`, rec);
  }
  if (s.autopilot === 'auto') rec.approved = true;
  const log = d.log;
  // pre-cool only on measured spare solar; the coast after it only on a day that pre-cooled
  let step = planStep;
  if (plan.precool && step.hour >= plan.precoolFrom && step.hour < plan.coastFrom) {
    const on = precoolDecision({ spareW: await spareSolarW(siteId, d.state.hvac === 'COOLING', d.learned.acKw), acKw: d.learned.acKw, on: !!rec.precoolOn });
    if (on !== !!rec.precoolOn) {
      rec.precoolOn = on; rec.lastStepHour = null; if (on) rec.precoolRan = true;
      log.unshift({ at: Date.now(), day: plan.date, text: on ? `Spare solar: pre-cooling to ${step.coolF}°` : `No spare solar: holding ${bandMid(s)}° until there is` });
      await kv.set(`${siteId}:ac:plan`, rec); await kv.set(`${siteId}:ac:log`, log.slice(0, 40));
    }
    if (!on) step = { ...step, coolF: bandMid(s), why: 'pre-cool waits for spare solar' };
  } else if (plan.precool && step.hour >= plan.coastFrom && step.hour < plan.coastTo && !rec.precoolRan) {
    step = { ...step, coolF: bandMid(s), why: 'no pre-cool ran today, so no coast' };
  }
  // a step the thermostat already matches is done, so a later change during it is left alone (it used to be undone within minutes)
  if (rec.approved && d.state.mode === 'COOL' && rec.lastStepHour !== step.hour && d.state.coolF != null && Math.abs(step.coolF - d.state.coolF) < SAME_F) {
    rec.lastStepHour = step.hour; await kv.set(`${siteId}:ac:plan`, rec);
  }
  if (rec.approved && d.state.mode === 'COOL' && rec.lastStepHour !== step.hour && step.coolF !== d.state.coolF) {
    const lo = Math.min(s.band.homeLo, s.band.nightLo), hi = Math.max(s.band.homeHi, s.band.nightHi, s.awayF);
    const target = Math.max(lo, Math.min(hi, step.coolF));
    const from = d.state.coolF ?? target, next = Math.abs(target - from) > s.maxStepF ? from + Math.sign(target - from) * s.maxStepF : target;
    const g = guardCoolSetpoint({ mode: s.autopilot, targetF: target, valueF: next, currentF: d.state.coolF, lastWriteAt: (await lastSetpointWrite(d.state.deviceId))?.at ?? null, now: Date.now() });
    // setCool re-checks the same rules, and still refuses if another invocation took the 30-minute slot a moment ago
    const refused = !g.ok ? g.reason : await setCool(d.state.deviceId, g.value, s.autopilot).then(() => null, (e: unknown) => { if (e instanceof GuardRefusal) return e.reason; throw e; });
    if (refused == null && g.ok) {
      log.unshift({ at: Date.now(), day: plan.date, text: `Set ${g.value}° (${step.why})${g.stepped ? `; safety ${g.reason}` : ''}`, delta: g.value === target ? undefined : 'stepping' });
      if (g.value === target) rec.lastStepHour = step.hour;
      await kv.set(`${siteId}:ac:plan`, rec); await kv.set(`${siteId}:ac:log`, log.slice(0, 40));
    } else {
      const text = `Did not set ${g.ok ? g.value : next}° (${step.why}): ${explainRefusal(refused ?? '')}`;
      // the cron retries every 5 minutes: a refusal that repeats is logged once
      if (log[0]?.text !== text || log[0]?.day !== plan.date) { log.unshift({ at: Date.now(), day: plan.date, text, delta: 'refused' }); await kv.set(`${siteId}:ac:log`, log.slice(0, 40)); }
    }
  }
  return { sampled: true, applied: rec.approved };
}
