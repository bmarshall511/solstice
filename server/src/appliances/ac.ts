// AC appliance: Nest state, AC power learned from Tesla's load steps, today's comfort plan (pre-cool on solar surplus, coast on the
// Powerwalls) inside the owner's comfort band, and an Autopilot that suggests or applies the plan's setpoint steps through the day.
import { q, kv } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { readNest, nestConfigured, nestLinked, setCool, type NestState } from './nest.js';
import { forecast } from './autopilot.js';
import type { Mode } from './autopilot.js';

export type AcSettings = { band: { homeLo: number; homeHi: number; nightLo: number; nightHi: number }; awayF: number; nightFrom: number; nightTo: number; precoolDepth: number; coastF: number; maxStepF: number; humidityCap: number; autopilot: Mode; presence: 'home' | 'away' };
const DEFAULTS: AcSettings = { band: { homeLo: 74, homeHi: 78, nightLo: 74, nightHi: 76 }, awayF: 80, nightFrom: 22, nightTo: 7, precoolDepth: 2, coastF: 78, maxStepF: 2, humidityCap: 60, autopilot: 'suggest', presence: 'home' };
const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date())) % 24;

/* ---------- readings and learning ---------- */
export async function recordNest(siteId: string, st: NestState) {
  const d = new Date(st.at);
  await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [siteId, st.at, localDay(d), Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d)) % 24, st.indoorF, st.humidity, st.mode, st.hvac, st.coolF, st.heatF, st.eco]);
}
/**
 * AC power learned from load steps: for each pair of consecutive readings where HVAC switched between COOLING and OFF within 10 min,
 * the difference in Tesla's 5-minute home power across the switch. Median over the last 14 days; null until 5 samples exist.
 */
export async function learnAcKw(siteId: string) {
  const rows = await q<{ ts: string; hvac: string }>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND day >= $2 ORDER BY ts`, [siteId, addDays(localDay(), -14)]);
  const steps: number[] = [], heat: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i], dt = Number(b.ts) - Number(a.ts); if (dt > 10 * 60_000) continue;
    const change = a.hvac !== b.hvac && (a.hvac === 'OFF' || b.hvac === 'OFF'); if (!change) continue;
    const on = b.hvac !== 'OFF' ? b : a, off = b.hvac !== 'OFF' ? a : b;
    const kw = async (ts: string) => (await q<{ kw: number }>(`SELECT (home_wh * 12 / 1000.0)::float8 kw FROM energy WHERE site_id = $1 AND epoch BETWEEN $2 AND $3 ORDER BY ABS(epoch - $4) LIMIT 1`, [siteId, Number(ts) - 5 * 60_000, Number(ts) + 5 * 60_000, Number(ts)]))[0]?.kw;
    const kOn = await kw(on.ts), kOff = await kw(off.ts); if (kOn == null || kOff == null) continue;
    const d = kOn - kOff; if (d > .5 && d < 25) (on.hvac === 'HEATING' ? heat : steps).push(d);
  }
  const med = (a: number[]) => a.length >= 5 ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  return { coolKw: med(steps), heatKw: med(heat), samples: steps.length, heatSamples: heat.length };
}
/** Today's run time and duty from readings (gaps capped at 10 min). */
async function runtimeToday(siteId: string) {
  const rows = await q<{ ts: string; hvac: string }>(`SELECT ts::text, hvac FROM nest_readings WHERE site_id = $1 AND day = $2 ORDER BY ts`, [siteId, localDay()]);
  let on = 0, all = 0; for (let i = 1; i < rows.length; i++) { const dt = Math.min(10 * 60_000, Number(rows[i].ts) - Number(rows[i - 1].ts)); all += dt; if (rows[i - 1].hvac === 'COOLING') on += dt; }
  return { minutes: Math.round(on / 60_000), duty: all ? Math.round(on / all * 100) : null };
}

/* ---------- the plan ---------- */
export type AcStep = { hour: number; coolF: number; why: string };
export type AcPlan = { date: string; steps: AcStep[]; precool: boolean; precoolFrom: number; precoolTo: number; coastFrom: number; coastTo: number; high: number; sunKwhM2: number; kwhSaved: number; costSavedMonth: number; why: string[] };
/**
 * Pre-cool to (homeLo) while the panels are strong when tomorrow/today is hot and sunny; coast up to coastF into the evening;
 * night band overnight; away target when marked away. Steps only ever move inside the band, and by at most maxStepF at a time.
 */
export function planFor(o: { date: string; high: number; sunKwhM2: number; hourlySun: number[]; settings: AcSettings; acKw: number | null; slope: number; rate: number; humidity: number | null }): AcPlan {
  const s = o.settings, why: string[] = [], steps: AcStep[] = [];
  const kwPerDeg = o.slope; // kWh per degree of daily high, from the heat model; also a fair proxy for kWh per degree of setpoint
  const sunny = o.sunKwhM2 >= 4.5, hot = o.high >= 88, humid = (o.humidity ?? 0) >= s.humidityCap;
  const peak = o.hourlySun.reduce((bi, v, i, a) => v > a[bi] ? i : bi, 0), from = Math.max(11, peak - 2), to = Math.min(17, peak + 3);
  const precool = sunny && hot && !humid && s.presence === 'home';
  const low = s.band.homeLo, mid = Math.min(s.band.homeHi, Math.max(low, Math.round((s.band.homeLo + s.band.homeHi) / 2)));
  const night = Math.max(s.band.nightLo, Math.min(s.band.nightHi, mid));
  if (s.presence === 'away') { steps.push({ hour: 0, coolF: s.awayF, why: 'marked away' }); why.push(`Away: holding ${s.awayF}° until you mark Home`); return { date: o.date, steps, precool: false, precoolFrom: from, precoolTo: to, coastFrom: to, coastTo: 21, high: o.high, sunKwhM2: o.sunKwhM2, kwhSaved: 0, costSavedMonth: 0, why }; }
  steps.push({ hour: s.nightTo, coolF: mid, why: 'morning, comfort band' });
  if (precool) {
    const deep = Math.max(low, mid - s.precoolDepth); steps.push({ hour: from, coolF: deep, why: 'pre-cool on solar surplus' });
    steps.push({ hour: to, coolF: Math.min(s.coastF, s.band.homeHi), why: 'coast on the Powerwalls' });
    why.push(`Pre-cool to ${deep}° from ${from}:00 to ${to}:00 while the panels peak (${o.sunKwhM2} kWh/m² of sun, high ${Math.round(o.high)}°)`);
    why.push(`Coast to ${Math.min(s.coastF, s.band.homeHi)}° until ${Math.min(21, to + 4)}:00 so the batteries carry a lighter evening`);
    if (o.high >= 100) { steps[1].hour = 11; why.push('Heat wave: pre-cool starts at 11:00 so the system never falls behind'); }
  } else why.push(!hot ? `Mild day (high ${Math.round(o.high)}°): no pre-cool needed` : !sunny ? 'Cloudy: no solar surplus to pre-cool with' : humid ? `Humidity ${o.humidity}%: no coast, holding ${mid}°` : 'Holding the comfort band');
  steps.push({ hour: precool ? Math.min(21, to + 4) : 21, coolF: mid, why: 'evening, comfort band' });
  steps.push({ hour: s.nightFrom, coolF: night, why: 'night band' });
  // savings vs holding the middle of the band all day: coasting degrees-hours minus pre-cool degrees-hours, at the learned kWh/°F/day ÷ hours
  const kwhSaved = precool ? Math.round(((Math.min(s.coastF, s.band.homeHi) - mid) * 4 - s.precoolDepth * (to - from) * .55) * kwPerDeg / 10 * 10) / 10 : 0;
  steps.sort((a, b) => a.hour - b.hour);
  return { date: o.date, steps, precool, precoolFrom: from, precoolTo: to, coastFrom: to, coastTo: Math.min(21, to + 4), high: o.high, sunKwhM2: o.sunKwhM2, kwhSaved: Math.max(0, kwhSaved), costSavedMonth: Math.round(Math.max(0, kwhSaved) * 30.4 * o.rate), why };
}
export const stepAt = (plan: AcPlan, hour: number) => [...plan.steps].reverse().find(s => s.hour <= hour) ?? plan.steps[plan.steps.length - 1];

/* ---------- detail for the app ---------- */
export async function acDetail(siteId: string, settingsAll: Record<string, any>, rate: number, slope: number, opts: { fresh?: boolean } = {}) {
  const settings: AcSettings = { ...DEFAULTS, ...(settingsAll.ac ?? {}), band: { ...DEFAULTS.band, ...(settingsAll.ac?.band ?? {}) } };
  const configured = nestConfigured(), linked = configured && await nestLinked();
  let st = await kv.get<NestState>('nest:last') ?? null, error: string | null = null;
  if (linked && (opts.fresh || !st || Date.now() - st.at > 60_000)) { try { st = await readNest(); await recordNest(siteId, st); } catch (e: any) { error = e.message; } }
  const learned = await learnAcKw(siteId), rt = await runtimeToday(siteId);
  const days = await forecast(), today = localDay(), ti = Math.max(0, days.findIndex(d => d.date === today));
  const plan = planFor({ date: today, high: days[ti]?.high ?? 90, sunKwhM2: days[ti]?.sunKwhM2 ?? 5, hourlySun: days[ti]?.hourlySun ?? Array(24).fill(0), settings, acKw: learned.coolKw, slope, rate, humidity: st?.humidity ?? null });
  const week = days.slice(ti, ti + 7).map(d => { const p = planFor({ date: d.date, high: d.high, sunKwhM2: d.sunKwhM2, hourlySun: d.hourlySun, settings, acKw: learned.coolKw, slope, rate, humidity: null }); return { date: d.date, high: Math.round(d.high), sunKwhM2: Math.round(d.sunKwhM2 * 10) / 10, precool: p.precool, depth: p.precool ? settings.precoolDepth : 0, kwhSaved: p.kwhSaved }; });
  const applied = await kv.get<{ date: string; approved: boolean; lastStepHour: number | null }>(`${siteId}:ac:plan`) ?? null;
  const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:ac:log`) ?? [];
  const acKw = learned.coolKw ?? (slope ? Math.max(2, Math.min(5, slope * 1.3)) : 3.4);
  const todayKwh = Math.round(rt.minutes / 60 * acKw * 10) / 10;
  const home = await q<{ kwh: number }>(`SELECT (SUM(home_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day = $2`, [siteId, today]);
  return { id: 'ac', name: 'AC', configured, linked, error, settings, state: st, learned: { ...learned, acKw, source: learned.coolKw ? 'measured' : 'estimated' }, runtime: rt, todayKwh, shareOfHomePct: home[0]?.kwh ? Math.round(todayKwh / home[0].kwh * 100) : null,
    plan, currentStep: stepAt(plan, hourNow()), week, applied: applied?.date === today ? applied : null, log, outdoorF: days[ti] ? Math.round(days[ti].high) : null, hourlyOutdoor: null,
    equipment: { airHandler: 'Trane TEM4A0C42 · 3.5 ton variable-speed (2018)', heat: 'electric strips (staged)',
      outdoor: learned.heatKw != null ? (learned.heatKw < 5 ? `heat pump (measured ${learned.heatKw.toFixed(1)} kW when heating)` : `straight AC, heating on the strips (measured ${learned.heatKw.toFixed(1)} kW)`) : 'outdoor unit type: Solstice will measure it from the first heating steps this winter' } };
}

/** Called every 5 minutes by the cron: sample Nest, and if today's plan is approved (or Autopilot is Auto), apply the step due now. */
export async function acTick(siteId: string, settingsAll: Record<string, any>, rate: number, slope: number) {
  const d = await acDetail(siteId, settingsAll, rate, slope, { fresh: true });
  if (!d.linked || !d.state) return { sampled: false };
  const s = d.settings, plan = d.plan, h = hourNow(), step = stepAt(plan, h), rec = d.applied ?? { date: plan.date, approved: s.autopilot === 'auto', lastStepHour: null as number | null };
  if (s.autopilot === 'auto') rec.approved = true;
  const log = d.log;
  if (rec.approved && d.state.mode === 'COOL' && rec.lastStepHour !== step.hour && step.coolF !== d.state.coolF) {
    const lo = Math.min(s.band.homeLo, s.band.nightLo), hi = Math.max(s.band.homeHi, s.band.nightHi, s.awayF);
    const target = Math.max(lo, Math.min(hi, step.coolF));
    const from = d.state.coolF ?? target, next = Math.abs(target - from) > s.maxStepF ? from + Math.sign(target - from) * s.maxStepF : target;
    await setCool(d.state.deviceId, next);
    log.unshift({ at: Date.now(), day: plan.date, text: `Set ${next}° (${step.why})`, delta: next === target ? undefined : 'stepping' });
    if (next === target) rec.lastStepHour = step.hour;
    await kv.set(`${siteId}:ac:plan`, rec); await kv.set(`${siteId}:ac:log`, log.slice(0, 40));
  }
  return { sampled: true, applied: rec.approved };
}
