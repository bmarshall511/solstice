// AC appliance: Nest state, AC power learned from Tesla's load steps, today's comfort plan (pre-cool on solar surplus, coast on the
// Powerwalls) inside the owner's comfort band, and an Autopilot that suggests or applies the plan's setpoint steps through the day.
import { q, kv } from '../db.js';
import { localDay, addDays, rfc3339 } from '../tesla/client.js';
import { readNest, nestConfigured, nestLinked, setCool, type NestState } from './nest.js';
import { forecast } from './autopilot.js';
import type { Mode } from './autopilot.js';
import { lastSetpointWrite } from './nest.js';
import { guardCoolSetpoint, explainRefusal, GuardRefusal } from './guards.js';
import { acSavings, learnedPlan, type AppliedTrim } from '../learn/ac.js';
import type { Tier } from '../learn/confidence.js';
import { presenceFor } from './presence.js';
import { changed, ours, holdUntil, holdOver, morningAfter, getHold, setHold, lastSent, SAME_F, type Hold, type HoldBy } from './hold.js';

export type AcSettings = { band: { homeLo: number; homeHi: number; nightLo: number; nightHi: number }; awayF: number; nightFrom: number; nightTo: number; precoolDepth: number; coastF: number; maxStepF: number; humidityCap: number; autopilot: Mode; presence: 'home' | 'away' };
const DEFAULTS: AcSettings = { band: { homeLo: 74, homeHi: 78, nightLo: 74, nightHi: 76 }, awayF: 80, nightFrom: 22, nightTo: 7, precoolDepth: 2, coastF: 78, maxStepF: 2, humidityCap: 60, autopilot: 'suggest', presence: 'home' };
export { DEFAULTS as AC_DEFAULTS };
/** The Chicago hour with minutes as a fraction (19.5 = 19:30), so a step at a half hour (a learned coast trim) applies on time. */
const hourNow = () => { const t = rfc3339(new Date()); return Number(t.slice(11, 13)) + Number(t.slice(14, 16)) / 60; };

/* ---------- readings and learning ---------- */
export async function recordNest(siteId: string, st: NestState) {
  const d = new Date(st.at);
  await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [siteId, st.at, localDay(d), Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d)) % 24, st.indoorF, st.humidity, st.mode, st.hvac, st.coolF, st.heatF, st.eco]);
}
type AcLearned = { coolKw: number | null; heatKw: number | null; samples: number; heatSamples: number };
const LEARN_TTL_MS = 3600e3;
/**
 * AC power learned from load steps: for each pair of consecutive readings where HVAC switched between COOLING and OFF within 10 min,
 * the difference in Tesla's 5-minute home power across the switch. Median over the last 14 days; null until 5 samples exist.
 * Cached in kv (`<site>:ac:learned`) for an hour, so app reads and the 5-minute cron share one computation; new transitions show up
 * on the first call after the entry expires.
 */
export async function learnAcKw(siteId: string): Promise<AcLearned> {
  const key = `${siteId}:ac:learned`, hit = await kv.get<{ at: number; learned: AcLearned }>(key), age = hit ? Date.now() - hit.at : -1;
  if (hit && age >= 0 && age < LEARN_TTL_MS) return hit.learned;
  const learned = await computeAcKw(siteId);
  await kv.set(key, { at: Date.now(), learned });
  return learned;
}
async function computeAcKw(siteId: string): Promise<AcLearned> {
  type R = { ts: string; hvac: string };
  const rows = await q<R>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND day >= $2 ORDER BY ts`, [siteId, addDays(localDay(), -14)]);
  const pairs: Array<{ on: R; off: R }> = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i], dt = Number(b.ts) - Number(a.ts); if (dt > 10 * 60_000) continue;
    const change = a.hvac !== b.hvac && (a.hvac === 'OFF' || b.hvac === 'OFF'); if (!change) continue;
    pairs.push(b.hvac !== 'OFF' ? { on: b, off: a } : { on: a, off: b });
  }
  // One query for every transition: the energy bucket nearest each reading within ±5 min (energy_site_epoch index), kW from its
  // home_wh (null when the bucket is missing or has no home_wh). Two equally near buckets resolve to the earlier one.
  const kwAt = new Map<string, number | null>();
  if (pairs.length) {
    const ts = [...new Set(pairs.flatMap(p => [p.on.ts, p.off.ts]))].map(Number);
    const got = await q<{ ts: string; kw: number | null }>(`SELECT t.ts::text, e.kw FROM unnest($2::bigint[]) t(ts) LEFT JOIN LATERAL (
        SELECT (home_wh * 12 / 1000.0)::float8 kw FROM energy WHERE site_id = $1 AND epoch BETWEEN t.ts - 300000 AND t.ts + 300000
        ORDER BY ABS(epoch - t.ts), epoch LIMIT 1) e ON true`, [siteId, ts]);
    for (const r of got) kwAt.set(r.ts, r.kw);
  }
  const steps: number[] = [], heat: number[] = [];
  for (const { on, off } of pairs) {
    const kOn = kwAt.get(on.ts), kOff = kwAt.get(off.ts); if (kOn == null || kOff == null) continue;
    const d = kOn - kOff; if (d > .5 && d < 25) (on.hvac === 'HEATING' ? heat : steps).push(d);
  }
  const med = (a: number[]) => a.length >= 5 ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  return { coolKw: med(steps), heatKw: med(heat), samples: steps.length, heatSamples: heat.length };
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
  const s = o.settings, why: string[] = [], steps: AcStep[] = [];
  const sunny = o.sunKwhM2 >= 4.5, hot = o.high >= 88, humid = (o.humidity ?? 0) >= s.humidityCap;
  const peak = o.hourlySun.reduce((bi, v, i, a) => v > a[bi] ? i : bi, 0), from = o.high >= 100 ? 11 : Math.max(11, peak - 2), to = Math.min(17, peak + 3);
  const precool = sunny && hot && !humid && s.presence === 'home' && !o.control; // control day (learn/ac.ts): hold the band so savings can be measured
  const low = s.band.homeLo, mid = Math.min(s.band.homeHi, Math.max(low, Math.round((s.band.homeLo + s.band.homeHi) / 2)));
  const night = Math.max(s.band.nightLo, Math.min(s.band.nightHi, mid));
  if (s.presence === 'away') { steps.push({ hour: 0, coolF: s.awayF, why: 'marked away' }); why.push(`Away: holding ${s.awayF}° until you mark Home`); return { date: o.date, steps, precool: false, precoolFrom: from, precoolTo: to, coastFrom: to, coastTo: 21, high: Math.round(o.high), sunKwhM2: Math.round(o.sunKwhM2 * 10) / 10, shiftedKwh: 0, eveningAvoidedKwh: 0, control: false, why }; }
  steps.push({ hour: s.nightTo, coolF: mid, why: 'morning, comfort band' });
  if (precool) {
    const deep = Math.max(low, mid - s.precoolDepth); steps.push({ hour: from, coolF: deep, why: 'pre-cool on solar surplus' });
    steps.push({ hour: to, coolF: Math.min(s.coastF, s.band.homeHi), why: 'coast on the Powerwalls' });
    why.push(`Pre-cool to ${deep}° from ${from}:00 to ${to}:00 while the panels peak (${(Math.round(o.sunKwhM2 * 10) / 10)} kWh/m² of sun, high ${Math.round(o.high)}°)`);
    why.push(`Coast to ${Math.min(s.coastF, s.band.homeHi)}° until ${Math.min(21, to + 4)}:00 so the batteries carry a lighter evening`);
    if (o.high >= 100) why.push('Heat wave: pre-cool starts at 11:00 so the system never falls behind');
  } else why.push(o.control ? 'Control day: holding the comfort band (1 in 5 hot, sunny days) so Solstice can measure what pre-cooling saves' : !hot ? `Mild day (high ${Math.round(o.high)}°): no pre-cool needed` : !sunny ? 'Cloudy: no solar surplus to pre-cool with' : humid ? `Humidity ${o.humidity}%: no coast, holding ${mid}°` : 'Holding the comfort band');
  steps.push({ hour: precool ? Math.min(21, to + 4) : 21, coolF: mid, why: 'evening, comfort band' });
  steps.push({ hour: s.nightFrom, coolF: night, why: 'night band' });
  steps.sort((a, b) => a.hour - b.hour);
  const plan = { date: o.date, steps, precool, precoolFrom: from, precoolTo: to, coastFrom: to, coastTo: Math.min(21, to + 4), high: Math.round(o.high), sunKwhM2: Math.round(o.sunKwhM2 * 10) / 10, shiftedKwh: 0, eveningAvoidedKwh: 0, control: !!o.control, why };
  const saved = acSavings(plan, s, o.slope, o.acKw); // kWh shifted onto solar and evening kWh avoided, vs holding the middle of the band
  return { ...plan, shiftedKwh: saved.shiftedKwh, eveningAvoidedKwh: saved.eveningAvoidedKwh };
}
export const stepAt = (plan: AcPlan, hour: number) => [...plan.steps].reverse().find(s => s.hour <= hour) ?? plan.steps[plan.steps.length - 1];

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
export const setting = (h: Pick<Hold, 'mode' | 'coolF' | 'heatF'>) => h.mode === 'OFF' ? 'Off' : h.mode === 'HEAT' ? `heat ${h.heatF}°` : h.mode === 'HEATCOOL' ? `${h.heatF}–${h.coolF}°` : `${h.coolF}°`;
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
export async function acDetail(siteId: string, settingsAll: Record<string, any>, rate: number | null, slope: number, opts: { fresh?: boolean } = {}) {
  const settings: AcSettings = { ...DEFAULTS, ...(settingsAll.ac ?? {}), band: { ...DEFAULTS.band, ...(settingsAll.ac?.band ?? {}) } };
  const presence = await presenceFor(siteId, settingsAll);   // presence.ts: manual "Away until", then Nest Eco, then home
  settings.presence = presence.state;
  const configured = nestConfigured(), linked = configured && await nestLinked();
  let st = await kv.get<NestState>('nest:last') ?? null, error: string | null = null;
  const prev = st; let fresh = false;
  if (linked && (opts.fresh || !st || Date.now() - st.at > 60_000)) { try { st = await readNest(); fresh = true; await recordNest(siteId, st); } catch (e: any) { error = e.message; } }
  const learned = await learnAcKw(siteId), rt = await runtimeToday(siteId);
  const days = await forecast(), today = localDay(), ti = Math.max(0, days.findIndex(d => d.date === today));
  // today's plan through the learning layer: a control day holds the band, a learned trim applies, the savings carry `conf`.
  // The day's weather inputs are frozen at the first plan from 06:00 on, so a refreshed forecast or a humidity reading near the
  // cap can't flip the plan back and forth during the day (it used to re-plan every 5 minutes).
  const inputs = await dayInputs(siteId, today, { high: days[ti]?.high ?? 90, sunKwhM2: days[ti]?.sunKwhM2 ?? 5, hourlySun: days[ti]?.hourlySun ?? Array(24).fill(0), humidity: st?.humidity ?? null });
  const plan = await learnedPlan(siteId, { date: today, ...inputs, settings, acKw: learned.coolKw, slope, rate },
    planFor, learned.coolKw ?? (slope ? Math.max(2, Math.min(5, slope * 1.3)) : 3.4));
  const hold = await observeHold(siteId, fresh ? prev : null, st, plan, settings, presence);
  const week = days.slice(ti, ti + 7).map(d => { const p = planFor({ date: d.date, high: d.high, sunKwhM2: d.sunKwhM2, hourlySun: d.hourlySun, settings, acKw: learned.coolKw, slope, rate, humidity: null }); return { date: d.date, high: Math.round(d.high), sunKwhM2: Math.round(d.sunKwhM2 * 10) / 10, precool: p.precool, depth: p.precool ? settings.precoolDepth : 0, shiftedKwh: p.shiftedKwh, eveningAvoidedKwh: p.eveningAvoidedKwh, precoolFrom: p.precoolFrom, precoolTo: p.precoolTo, coastFrom: p.coastFrom, coastTo: p.coastTo }; });
  const applied = await kv.get<{ date: string; approved: boolean; lastStepHour: number | null }>(`${siteId}:ac:plan`) ?? null;
  const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:ac:log`) ?? [];
  const acKw = acKwFor(learned.coolKw, slope);
  const todayKwh = Math.round(rt.minutes / 60 * acKw * 10) / 10;
  const home = await q<{ kwh: number }>(`SELECT (SUM(home_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day = $2`, [siteId, today]);
  return { id: 'ac', name: 'AC', configured, linked, error, settings, state: st, hold, learned: { ...learned, acKw, source: learned.coolKw ? 'measured' : 'estimated' }, runtime: rt, todayKwh, shareOfHomePct: home[0]?.kwh ? Math.round(todayKwh / home[0].kwh * 100) : null,
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
  if (d.hold) return { sampled: true, applied: !!d.applied?.approved, held: true };   // hold.ts: a manual change is in force; skip the plan
  const s = d.settings, plan = d.plan, h = hourNow(), step = stepAt(plan, h);
  let rec = d.applied;
  if (!rec) {
    // a new day: before the morning step the step due is last night's night band; if yesterday already set it, it is done
    // (it used to be re-sent just after midnight over whatever was set since)
    const y = await kv.get<{ date: string; lastStepHour: number | null }>(`${siteId}:ac:plan`);
    const carried = y?.date === addDays(plan.date, -1) && h < plan.steps[0].hour && y.lastStepHour === step.hour ? step.hour : null;
    rec = { date: plan.date, approved: s.autopilot === 'auto', lastStepHour: carried };
    await kv.set(`${siteId}:ac:plan`, rec);
  }
  if (s.autopilot === 'auto') rec.approved = true;
  const log = d.log;
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
