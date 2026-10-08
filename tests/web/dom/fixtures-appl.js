// Synthetic payloads for the appliance routes (pool, AC, the appliance day, the water log, Vacation mode), shaped exactly as the
// server answers the owner, for the DOM tests. Pure: no imports, no randomness; every time is derived from `now` (epoch ms, the tests
// use 2026-10-07 14:30 America/Chicago). Keys are the path web/src/lib/api.js passes after `/api/`, query string stripped.
// Synthetic only (public repo): no names, addresses, account numbers, real coordinates or real prices.

/* ---------- time helpers (Chicago is UTC−5 for the whole of October 2026: DST ends Nov 1) ---------- */
const H = 3600e3, D = 864e5, OFF = 5 * H;
/** YYYY-MM-DD of an epoch in Chicago. */
const dayOf = ms => new Date(ms - OFF).toISOString().slice(0, 10);
/** Epoch of a Chicago clock hour (fractional ok) on the day of `now`, `days` later. */
const atHour = (now, h, days = 0) => Date.parse(`${dayOf(now)}T00:00:00-05:00`) + days * D + h * H;
/** The Chicago hour of an epoch, fractional. */
const hourOf = ms => { const t = new Date(ms - OFF); return t.getUTCHours() + t.getUTCMinutes() / 60; };
/** The pool cron's evening run (01:15 UTC) at or after t (pool.ts poolRunAfter). */
const poolRunAfter = t => { const d = new Date(t); d.setUTCHours(1, 15, 0, 0); if (d.getTime() < t) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

/* ---------- the pump models (pool.ts powerModel, gpmAt, hourlyRpm), on synthetic measured points ---------- */
const MEASURED = [{ rpm: 1500, watts: 172 }, { rpm: 1750, watts: 265 }, { rpm: 1800, watts: 287 }, { rpm: 2000, watts: 385 }, { rpm: 2400, watts: 640 }];
const ANCHORS = [...MEASURED, { rpm: 3450, watts: 2900 }];
/** Watts at an RPM: log-log between anchors, the cube law below the lowest (as powerModel). */
function W(rpm) {
  if (rpm <= 0) return 0;
  const exact = ANCHORS.find(p => Math.abs(p.rpm - rpm) <= 25); if (exact) return exact.watts;
  const lo = [...ANCHORS].reverse().find(p => p.rpm < rpm), hi = ANCHORS.find(p => p.rpm > rpm);
  if (lo && hi) { const k = Math.log(hi.watts / lo.watts) / Math.log(hi.rpm / lo.rpm); return lo.watts * (rpm / lo.rpm) ** k; }
  const near = lo ?? hi; return Math.max(20, Math.min(3200, near.watts * (rpm / near.rpm) ** 3));
}
const GPM = rpm => 120 * rpm / 3450;
const covers = (s, m) => s.stop > s.start ? m >= s.start && m < s.stop : m >= s.start || m < s.stop;
/** pool.ts hourlyRpm: per hour {rpm, frac, slices[4]}. */
function hourly(schedules, speeds) {
  const qr = Array.from({ length: 96 }, (_, i) => schedules.reduce((r, s) => covers(s, i * 15) ? Math.max(r, speeds.get(s.circuitId) ?? 0) : r, 0));
  return Array.from({ length: 24 }, (_, h) => { const slices = qr.slice(h * 4, h * 4 + 4); return { rpm: Math.max(0, ...slices), frac: slices.filter(r => r > 0).length / 4, slices }; });
}
const dayKwh = prof => prof.reduce((a, h) => a + h.slices.reduce((b, r) => b + W(r) / 4, 0), 0) / 1000;
const hoursOn = prof => prof.reduce((a, h) => a + h.frac, 0);
const turnovers = (prof, gallons) => Math.round(prof.reduce((a, h) => a + h.slices.reduce((b, r) => b + GPM(r) * 15, 0), 0) / gallons * 100) / 100;
const RATE = .12;   // a synthetic all-in import rate ($/kWh)
const usd = (kwh, cents = false) => cents ? Math.round(kwh * RATE * 100) / 100 : Math.round(kwh * RATE);
/** A synthetic sunny October day's solar (kW by hour). */
const SOLAR = [0, 0, 0, 0, 0, 0, 0, .3, 1.4, 3.1, 4.8, 6.0, 6.7, 6.9, 6.5, 5.6, 4.2, 2.6, 1.0, .1, 0, 0, 0, 0];

/* ---------- the controller snapshot (screenlogic.ts readPool → PoolSnapshot) ---------- */
const CIRCUITS = [
  { id: 1, name: 'Spa', function: 1 }, { id: 2, name: 'Air Blower', function: 0 }, { id: 3, name: 'Pool Light', function: 16 }, { id: 4, name: 'Spa Light', function: 16 },
  { id: 5, name: 'Waterfall', function: 0 }, { id: 6, name: 'Pool', function: 2 }, { id: 7, name: 'Jets', function: 0 }, { id: 8, name: 'High Speed', function: 0 }];
const SETTINGS_POOL = { gallons: 15000, spaGallons: 1000, designGpm: 120, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5], autopilot: 'auto', uv: true,
  heaterBtu: 400000, propaneUsdPerGal: 3, loads: { '2': 1100, '3': 500, '4': 100 }, turnoverGoal: 3, skimHours: 1, skimAt: null };

/**
 * GET /api/appliances/pool — server/src/appliances/pool.ts poolDetail (the snapshot from screenlogic.ts readPool, `autopilot` from
 * autopilot.ts autopilot, `changes` from poolLearn.ts poolChanges, `filter` from poolFilter.ts filterForecast).
 * The default: Autopilot Auto, today's plan 12 h at 1,750 rpm 8a–8p with the High Speed skim 1p–2p; at 14:30 the Pool circuit runs.
 */
function poolPayload(now, o = {}) {
  const today = dayOf(now), hNow = hourOf(now), clear = o.clearUp ?? null, g = SETTINGS_POOL.gallons;
  const filterRpm = clear ? clear.rpm : 1750;
  const speeds = new Map([[1, 3190], [5, 3000], [6, filterRpm], [8, 2400], [132, 1000]]);
  const sched = (id, circuitId, start, stop) => ({ id, circuitId, start, stop, dayMask: 127, flags: 0, heatCmd: 0, heatSetPoint: 0 });
  const progs = clear ? [sched(11, 6, 0, 1439)] : [sched(11, 6, 480, 1200), sched(12, 8, 780, 840)];
  const m = Math.floor(hNow * 60), onIds = new Set(progs.filter(s => covers(s, m)).map(s => s.circuitId));
  const circuits = CIRCUITS.map(c => ({ id: c.id, name: c.name, on: onIds.has(c.id), freeze: c.id === 6, function: c.function }));
  const runRpm = Math.max(0, ...[...onIds].map(id => speeds.get(id) ?? 0)), running = runRpm > 0;
  const snapshot = {
    at: now - 4 * 60e3, version: 'POOL: 5.2 Build 738.0 Rel', airTemp: 88, freezeMode: false,
    bodies: [{ id: 1, temp: 79, setPoint: 70, heatMode: 0, heating: false }, { id: 2, temp: 80, setPoint: 100, heatMode: 0, heating: false }],
    circuits,
    pump: { id: 1, name: 'Pump 1', running, watts: running ? Math.round(W(runRpm)) : 0, rpm: runRpm, gpm: null, minRpm: 450, maxRpm: 3450, primingRpm: 2750,
      circuits: [...speeds].map(([circuitId, speed]) => ({ circuitId, speed, isRpm: true })) },
    schedules: progs, runOnce: [] };
  const names = new Map(CIRCUITS.map(c => [c.id, c.name]));
  const current = progs.map(s => ({ ...s, rpm: speeds.get(s.circuitId) ?? 0, name: names.get(s.circuitId) }));
  const prof = hourly(current, speeds), kwh = dayKwh(prof) + hoursOn(prof) * .06;
  // the planner (pool.ts planFor): 12 h at 1,750 rpm toward 3 turnovers, the one-hour skim at the sunniest hour (13:00)
  const planSched = [{ circuitId: 6, start: 480, stop: 1200, rpm: 1750, name: 'Pool', why: '12 h of filtration at 1,750 RPM toward 3 turnovers of 15,000 gal a day' },
    { circuitId: 8, start: 780, stop: 840, rpm: 2400, name: 'High Speed', why: 'a one-hour skim at 2,400 RPM at the sunniest hour, for surface debris and mixing' }];
  const pprof = hourly(planSched, new Map(planSched.map(s => [s.circuitId, s.rpm]))), pkwh = dayKwh(pprof) + hoursOn(pprof) * .06;
  const plan = { month: 9, waterTemp: 79, turnovers: turnovers(pprof, g), goal: 3, rpm: 1750, hours: 12, boostHours: 1, start: 8, stop: 20, boostAt: 13, schedules: planSched,
    kwhPerDay: r1(pkwh), costPerMonth: usd(pkwh * 30.4), onSolarPct: 82, turnoverPerDay: turnovers(pprof, g), hourly: pprof, uvKwh: .72 };
  // water moved so far (frame 5's ring): the schedule's flow up to now, the rest of today's schedule after
  const q = Math.floor(hNow * 4), slices = prof.flatMap(h => h.slices), gal = r => GPM(r) * 15;
  const moved = slices.slice(0, q).reduce((a, r) => a + gal(r), 0), rest = slices.slice(q).reduce((a, r) => a + gal(r), 0);
  const extraHourly = Array.from({ length: 24 }, (_, h) => h < Math.floor(hNow) ? r3(prof[h].frac * .06) : h === Math.floor(hNow) ? r3(prof[h].frac * .06 * (hNow % 1)) : 0);
  const todayPump = slices.slice(0, q).reduce((a, r) => a + W(r) / 4, 0) / 1000, todayKwh = r1(todayPump + extraHourly.reduce((a, v) => a + v, 0));
  const nextRun = poolRunAfter(now), week = Array.from({ length: 7 }, (_, i) => ({ date: dayOf(now + (i + 1) * D), hours: i === 2 ? 13 : 12, boost: 1,
    sunKwhM2: [5.6, 5.2, 3.4, 5.8, 6.0, 5.5, 4.9][i], rainPct: [10, 20, 70, 5, 0, 10, 30][i], high: [91, 90, 84, 88, 89, 90, 87][i] }));
  const spaRise = 20, btu = 1000 * 8.34 * spaRise, propaneGal = Math.round(btu / .82 / 91500 * 100) / 100;
  const clearUp = clear ? { ...clear, day: Math.min(clear.days, Math.floor((now - clear.startedAt) / D) + 1) } : null;
  return {
    id: 'pool',
    water: { goal: 3, skimHours: 1, movedTurnovers: r2(moved / g), projectedTurnovers: r2((moved + rest) / g), gallons: g },
    clearUp,
    clearUpRates: Array.from({ length: 31 }, (_, i) => 1500 + i * 50).map(r => ({ rpm: r, kwhPerDay: Math.round((W(r) * 24 + 60 * 24) / 100) / 10, turnovers: Math.round(GPM(r) * 1440 / g * 10) / 10 })),
    changes: { recent: [{ at: now - D - 2 * H, kind: 'boost', minutes: 60 }], patterns: { skim: { hour: 12, days: 1, need: 4 }, goal: { days: 0, need: 4, extraMin: 0 } }, suggestions: [] },
    runFor: { '8': 60, '3': 120 },
    until: {},
    autopilot: {
      mode: SETTINGS_POOL.autopilot, nextRunAt: new Date(nextRun).toISOString(),
      signals: { waterTemp: 79, sunKwhM2: 5.6, sunPct: 70, high: 91, heatDays: 0, rainPct: 10, rainMm: 0, rainYesterdayMm: 0, useDays: 2, pollen: 'low' },
      tomorrow: { date: dayOf(now + D), plan, why: [] }, tomorrowIfHome: null, week, pending: false,
      log: [{ at: atHour(now, 20.25, -1), day: dayOf(now - D), text: 'Tomorrow: 12 h at 1,750 RPM + 1 h skim, 3.01× turnover. season plan', delta: `${plan.kwhPerDay} kWh` }],
      filterHours: 108, filterCleanedOn: dayOf(now - 9 * D) },
    pending: null,
    extras: { hourlyToday: extraHourly, todayKwh: r2(extraHourly.reduce((a, v) => a + v, 0)), nowW: running ? 60 : 0, loads: SETTINGS_POOL.loads, uvW: 60, lightReadings30d: 6 },
    spaSession: { spaGallons: 1000, spaTemp: 80, spaSet: 100, riseF: spaRise, heatMinutes: Math.round(btu / (400000 * .82) * 60), propaneGal, propaneUsd: Math.round(propaneGal * 3 * 100) / 100,
      pumpWattsAtSpa: Math.round(W(3190)), blowerWatts: 1100, electricUsdPerHour: usd((W(3190) + 1100 + 100) / 1000, true) },
    name: 'Pool pump', linked: true, error: null, settings: { ...SETTINGS_POOL }, snapshot,
    live: { watts: snapshot.pump.watts, rpm: runRpm, running, gpm: null, at: snapshot.at, waterTemp: 79, airTemp: 88, freezeMode: false,
      on: circuits.filter(c => c.on).map(c => c.name), activeRpm: runRpm },
    model: { measured: MEASURED, curve: [1000, 1500, 1800, 2400, 3000, 3450].map(r => ({ rpm: r, watts: Math.round(W(r)) })) },
    current: { schedules: current, hours: r1(hoursOn(prof)), kwhPerDay: r1(kwh), costPerMonth: usd(kwh * 30.4), onSolarPct: clear ? 41 : 82, turnoverPerDay: turnovers(prof, g), hourly: prof,
      byProgram: current.map(s => { const p = hourly([s], speeds); return { name: s.name, rpm: s.rpm, start: s.start, stop: s.stop, kwhPerDay: r1(dayKwh(p)) }; }) },
    plan,
    seasons: [['Dec–Feb', 58, 6, 4.1], ['Mar–May', 70, 10, 5.9], ['Jun–Aug', 88, 13, 7.6], ['Sep–Nov', 75, 12, 6.8]].map(([label, waterTemp, hours, kwhPerDay], i) =>
      ({ label, waterTemp, hours, boostHours: 1, rpm: 1750, kwhPerDay, costPerMonth: usd(kwhPerDay * 30.4), current: i === 3 })),
    solarKw: SOLAR,
    todayKwh, todayCost: usd(todayKwh, true), shareOfHomePct: 9, rate: RATE,
    applied: clear ? null : { at: atHour(now, 20.25, -1), plan: { start: 8, stop: 20, boostAt: 13, rpm: 1750, boostHours: 1, schedules: planSched }, removed: [], added: [], previousSpeeds: [{ circuitId: 6, speed: 1750, isRpm: true }, { circuitId: 8, speed: 2400, isRpm: true }] },
    conf: { kwhPerDay: 'learned' },
    filter: { rpm: 1750, baselineW: 270, thresholdW: 237.6, points: 9, slopeWPerDay: -.8, r2: .64, forecastDay: dayOf(now + 30 * D), conf: 'learned', cleanedOn: dayOf(now - 9 * D) },
  };
}
export const pool = now => poolPayload(now);
/** The pool during a Clear-up (pool.ts startClearUp → activeClearUp; the Pool circuit all day at 2,000 rpm, day 2 of 2, ends at the evening run). */
export function poolClearUp(now) {
  const startedAt = now - D - 2 * H;
  return poolPayload(now, { clearUp: { startedAt, until: poolRunAfter(startedAt + 2 * D), days: 2, rpm: 2000 } });
}
/** ScreenLogic not set up (pool.ts poolDetail with configured() false and no stored snapshot): no snapshot, no live, no programs; the planner still plans. */
export function poolNotLinked(now = Date.parse('2026-10-07T14:30:00-05:00')) {
  const p = poolPayload(now), prof = hourly([], new Map());
  return { ...p, linked: false, snapshot: null, live: null, until: {}, applied: null, pending: null, changes: { recent: [], patterns: { skim: null, goal: { days: 0, need: 4, extraMin: 0 } }, suggestions: [] },
    water: { ...p.water, movedTurnovers: 0, projectedTurnovers: 0 },
    extras: { ...p.extras, hourlyToday: Array(24).fill(0), todayKwh: 0, nowW: 0, lightReadings30d: 0 },
    spaSession: { ...p.spaSession, spaTemp: null, spaSet: null, riseF: null, heatMinutes: null, propaneGal: null, propaneUsd: null, pumpWattsAtSpa: Math.round(W(3190)) },
    model: { measured: [], curve: p.model.curve },
    current: { schedules: [], hours: 0, kwhPerDay: 0, costPerMonth: 0, onSolarPct: 0, turnoverPerDay: 0, hourly: prof, byProgram: [] },
    todayKwh: 0, todayCost: 0, shareOfHomePct: 0, filter: { rpm: null, baselineW: null, thresholdW: null, points: 0, slopeWPerDay: null, r2: null, forecastDay: null, conf: 'learning', cleanedOn: null } };
}

/* ---------- AC ---------- */
// ac.ts acSettingsOf → withTargets: the owner's targets (day 78°, night 77°, pre-cool 2°, drift 1°) and the band they stand for
const SETTINGS_AC = { band: { homeLo: 76, homeHi: 79, nightLo: 77, nightHi: 77 }, awayF: 80, nightFrom: 22, nightTo: 7, precoolDepth: 2, coastF: 79, maxStepF: 2, humidityCap: 60,
  autopilot: 'auto', presence: 'home', dayF: 78, nightF: 77, driftF: 1 };
const STEPS = [{ hour: 7, coolF: 78, why: 'morning, comfort band' }, { hour: 11, coolF: 76, why: 'pre-cool on solar surplus' }, { hour: 16, coolF: 79, why: 'coast on the Powerwalls' },
  { hour: 20, coolF: 78, why: 'evening, comfort band' }, { hour: 22, coolF: 77, why: 'night band' }];
const stepAt = (steps, h) => [...steps].reverse().find(s => s.hour <= h) ?? steps[steps.length - 1];
const LEARNED = { coolKw: 4.3, heatKw: null, samples: 12, heatSamples: 0, diag: { lateKw: 4.4, lateSamples: 9, regressionKw: 4.1, regressionHours: 312 } };

/**
 * GET /api/appliances/ac — server/src/appliances/ac.ts acDetail (state: nest.ts readNest → NestState; hold: hold.ts Hold; presence:
 * presence.ts presenceFor; plan: ac.ts planFor through learn/ac.ts learnedPlan; vacation: vacation/ac.ts tripAcView).
 * The default: Autopilot Auto, a hot sunny pre-cool day, cooling to the 76° pre-cool step at 14:30, no hold, home by Nest.
 */
function acPayload(now, o = {}) {
  const today = dayOf(now), h = hourOf(now), coolF = o.coolF ?? 76;
  const state = { at: now - 2 * 60e3, deviceId: 'enterprises/test-project/devices/thermostat-1', name: 'Hallway', online: true, indoorF: 76.8, humidity: 48, mode: 'COOL', hvac: 'COOLING',
    coolF, heatF: null, eco: false, ecoCoolF: 85, ecoHeatF: 50, fanTimer: false, fanUntil: null, availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] };
  const plan = { date: today, steps: STEPS, precool: true, precoolFrom: 11, precoolTo: 16, coastFrom: 16, coastTo: 20, high: 91, sunKwhM2: 5.6, shiftedKwh: 2.1, eveningAvoidedKwh: 1.4, control: false,
    why: ['Pre-cool to 76° from 11:00 to 16:00 while the panels peak (5.6 kWh/m² of sun, high 91°)', 'Coast to 79° until 20:00 so the batteries carry a lighter evening',
      'Pre-cool runs only while the panels measurably cover the house and the AC; otherwise it holds the band and skips the coast'],
    trim: null, conf: { shiftedKwh: 'estimated', eveningAvoidedKwh: 'estimated' } };
  const runtime = { minutes: 212, duty: 25, heatMinutes: 0, heatDuty: 0 }, acKw = LEARNED.coolKw, todayKwh = r1(runtime.minutes / 60 * acKw);
  return {
    id: 'ac', name: 'AC', configured: true, linked: true, error: null,
    forecast: { stale: false, ageH: 0, unavailable: false, note: null },
    settings: { ...SETTINGS_AC, band: { ...SETTINGS_AC.band } }, state, hold: null, suggestion: null,
    changes: { recent: [], patterns: [] }, vacation: null,
    learned: { ...LEARNED, acKw, source: 'measured' }, runtime, todayKwh, shareOfHomePct: 41,
    plan, currentStep: stepAt(STEPS, h),
    week: Array.from({ length: 7 }, (_, i) => { const high = [91, 90, 84, 88, 89, 90, 87][i], sun = [5.6, 5.2, 3.4, 5.8, 6.0, 5.5, 4.9][i], pre = high >= 88 && sun >= 4.5;
      return { date: dayOf(now + i * D), high, sunKwhM2: sun, precool: pre, depth: pre ? 2 : 0, shiftedKwh: pre ? 2.1 : 0, eveningAvoidedKwh: pre ? 1.4 : 0, precoolFrom: 11, precoolTo: 16, coastFrom: 16, coastTo: 20 }; }),
    presence: { state: 'home', source: 'nest', since: now - 8 * H, until: null },
    applied: { date: today, approved: true, lastStepHour: 11, precoolOn: true, precoolRan: true },
    log: [{ at: atHour(now, 11.1), day: today, text: 'Set 76° (pre-cool on solar surplus)' }, { at: atHour(now, 11), day: today, text: 'Spare solar: pre-cooling to 76°' },
      { at: atHour(now, 7), day: today, text: 'Set 78° (morning, comfort band)' }],
    outdoorF: 91, hourlyOutdoor: null,
    equipment: { airHandler: 'Air handler · 3.5 ton variable-speed', heat: 'electric strips (staged)', outdoor: 'outdoor unit type: Solstice will measure it from the first heating steps this winter' },
  };
}
export const ac = now => acPayload(now);
/** A hold the owner started from the app 30 minutes ago (hold.ts startHold → holdUntil: to the next plan step, the 16:00 coast). */
export function acHold(now) {
  const d = acPayload(now, { coolF: 75 }), at = now - 30 * 60e3;
  return { ...d, hold: { at, by: 'app', mode: 'COOL', coolF: 75, heatF: null, until: atHour(now, 16), why: 'until the plan’s next step (coast on the Powerwalls)', extended: false },
    changes: { recent: [{ at, by: 'app', coolF: 75, planF: 76 }], patterns: [{ hour: 14, f: 77, from: 78, planF: 76, dir: -1, days: 1, need: 4, window: 'day', set: [75] }] },
    log: [{ at, day: dayOf(now), text: 'You set 75° in Solstice (2:00 PM). Holding until 4:00 PM', delta: 'hold' }, ...d.log] };
}
/** Nest configured but not linked (ac.ts acDetail with nestLinked() false and no stored reading): no state, no hold; the plan is still made. */
export function acNotLinked(now = Date.parse('2026-10-07T14:30:00-05:00')) {
  const d = acPayload(now);
  return { ...d, linked: false, configured: true, state: null, hold: null, applied: null, log: [], runtime: { minutes: 0, duty: null, heatMinutes: 0, heatDuty: null }, todayKwh: 0,
    learned: { coolKw: null, heatKw: null, samples: 0, heatSamples: 0, acKw: 3.4, source: 'estimated' }, presence: { state: 'home', source: 'default', since: null, until: null } };
}
/** During a Vacation trip (vacationAway): presence from the trip, the plan is the trip's hold (vacation/ac.ts tripAcView, holding 85°). */
export function acVacation(now) {
  const d = acPayload(now, { coolF: 85 }), t = vacationAway(now).trip;
  return { ...d, state: { ...d.state, indoorF: 83.6, hvac: 'OFF', humidity: 52 }, settings: { ...d.settings, presence: 'away' },
    presence: { state: 'away', source: 'vacation', since: t.startedAt, until: t.backAt },
    vacation: { phase: 'away', holdF: 85, humid: 0, heatF: 55, arrivalF: 78, welcome: null, now: { coolF: 85, heatF: 55, why: 'vacation', welcome: false } },
    plan: { ...d.plan, steps: [{ hour: 0, coolF: 85, why: 'vacation' }], precool: false, shiftedKwh: 0, eveningAvoidedKwh: 0, control: false, why: ['Vacation: holding 85° while you\'re away'] },
    currentStep: { hour: 0, coolF: 85, why: 'vacation' }, applied: null, runtime: { minutes: 31, duty: 4, heatMinutes: 0, heatDuty: 0 }, todayKwh: 2.2 };
}

/**
 * GET /api/appliances/ac/strip — server/src/stripwatch.ts stripCard (today: stripheat.ts classifyDay + whyText/tipText; week:
 * weekSummary; heating: levels and heatingLabel). October, no heating learned yet: `show` false, 32 quiet quarter-hours 4a–12p.
 */
export function acStrip(now) {
  const today = dayOf(now), start = atHour(now, 4);
  return {
    show: false,
    today: { day: today, mode: 'nest', stripKwh: 0, stripMin: 0, hpMin: 0, stackedMin: 0, peakKw: null, hpKw: null, cause: null, conf: 'learning', runs: [], setbackF: null, balanceF: 40,
      quarters: Array.from({ length: 32 }, (_, i) => ({ at: start + i * 900e3, kw: 0, cls: '' })), why: null, tip: null },
    week: { mornings: 0, kwh: 0, setbacks: 0 },
    heating: { kind: 'learning', label: 'learning (0 of 5 heating runs)', conf: 'learning', heatKw: null, stageKw: null, stages: null },
  };
}
/** A winter-style morning for the card (show true): a heat pump with two strip stages, strips after a 4° setback at 6 AM. */
export function acStripWinter(now) {
  const s = acStrip(now), start = atHour(now, 4), sb = atHour(now, 6);
  const quarters = Array.from({ length: 32 }, (_, i) => { const h = 4 + i / 4; return { at: start + i * 900e3, kw: h >= 6 && h < 7.5 ? 9.2 : h >= 4 && h < 10 ? 2.6 : 0, cls: h >= 6 && h < 7.5 ? 'st' : h < 10 ? 'hp' : '' }; });
  const run = { start: sb, end: sb + 1.5 * H, kwh: 7.8, cause: 'setback', setback: { fromF: 64, toF: 68, at: sb }, outdoorF: 43 };
  return { show: true,
    today: { ...s.today, stripKwh: 7.8, stripMin: 90, hpMin: 270, peakKw: 6.6, hpKw: 2.6, cause: 'setback', conf: 'measured', runs: [run], setbackF: 4, quarters,
      why: 'Catching up from the 64° night setback (heat to 68° at 6:00 AM). Outside was 43°, above the ~40° point where the heat pump needs help.',
      tip: 'Keep overnight setbacks to 2° or less. The heat pump catches up without the strips.' },
    week: { mornings: 3, kwh: 19, setbacks: 2 },
    heating: { kind: 'heat-pump', label: 'heat pump + 2 strip stages', conf: 'learned', heatKw: 2.6, stageKw: 4.8, stages: 2 } };
}

/**
 * GET /api/appliances/day?date= — server/src/appliances/day.ts applianceDay → buildDay. Today up to 14:30: span 15 hours; energy, pool
 * (measured reads in pump hours, one HH:05 read outside) and Nest hours; later hours null.
 */
export function applDay(now) {
  const date = dayOf(now), span = Math.floor(hourOf(now)) + 1, acKw = LEARNED.coolKw;
  const speeds = new Map([[6, 1750], [8, 2400]]), prof = hourly([{ circuitId: 6, start: 480, stop: 1200 }, { circuitId: 8, start: 780, stop: 840 }], speeds);
  const HOME = [1.1, 1.0, 1.0, .9, .9, 1.0, 1.3, 1.6, 1.5, 1.4, 1.6, 3.4, 4.8, 5.3, 5.6], COOL = [0, 0, 0, 0, 0, 0, 0, 4, 8, 6, 10, 38, 52, 55, 30];
  const hours = Array.from({ length: 24 }, (_, hour) => {
    if (hour >= span) return { hour, energy: null, pool: null, ac: null };
    const solar = SOLAR[hour], home = HOME[hour], batt = solar > home ? -Math.min(3.5, solar - home) : r2(home - solar) * .9, grid = r2(home - solar - batt);
    const energy = { solarKw: r2(solar), homeKw: r2(home), batteryKw: r2(batt), gridKw: grid, importKw: Math.max(0, grid), exportKw: Math.max(0, -grid), soc: r1(hour < 8 ? 62 - hour * 3 : Math.min(100, 38 + (hour - 7) * 9)), buckets: 12 };
    const p = prof[hour], running = p.frac >= .5, meanKw = r3(p.slices.reduce((a, r) => a + W(r) / 4, 0) / 1000);
    const pool = { running, rpm: running ? p.rpm : 0, watts: running ? Math.round(W(p.rpm)) : 0, meanKw, source: 'measured' };
    const coolMin = COOL[hour], on = coolMin >= 30, setpointF = stepAt(STEPS, hour).coolF;
    const phase = on ? (hour >= 7 && hour < 22 && setpointF < 77.75 ? 'pre-cool' : 'cool') : hour >= 7 && hour < 22 && setpointF > 78.25 ? 'coast' : 'idle';
    const ac = { on, phase, setpointF, indoorF: r1(hour < 11 ? 77.6 : 76.9), kw: on ? acKw : 0, meanKw: r3(acKw * coolMin / 60), kwh: r3(coolMin / 60 * acKw) };
    return { hour, energy, pool, ac };
  });
  return { date, acKw, acConf: 'measured', coverage: { pool: 1, nest: 1 }, hours };
}

/** GET /api/appliances — server/src/app.ts: pool.ts poolSummary, then ac.ts acSummary (Nest configured, so no comingSoon row). */
export function appliances(now) {
  const p = poolPayload(now);
  return [{ id: 'pool', name: 'Pool pump', status: 'linked', watts: p.snapshot.pump.watts, kwhPerDay: p.current.kwhPerDay, savesPerMonth: 0 },
    { id: 'ac', name: 'AC', status: 'linked', watts: Math.round(LEARNED.coolKw * 1000), kwhPerDay: r1(212 / 60 * LEARNED.coolKw), savesPerMonth: null }];
}

/**
 * GET /api/pool/water — server/src/appliances/poolTests.ts poolWater: the last 60 days of tests (newest first), the last test's
 * status (fc's low end from the CYA: 40 → 3 ppm), pump hours per day, findings (null under 6 tests), when the next test is due.
 */
export function poolWater(now) {
  const test = (id, daysAgo, v) => { const at = atHour(now, 9.5, -daysAgo); return { id, at, day: dayOf(at), cc: null, ta: null, cya: null, ch: null, added: [], source: 'kit', waterF: 79, ...v }; };
  const tests = [test(3, 2, { fc: 3.5, ph: 7.5, ta: 90, cya: 40, clarity: 'clear', added: ['tablets'] }), test(2, 6, { fc: 2.5, ph: 7.6, clarity: 'clear', added: ['liquid'], waterF: 81 }),
    test(1, 11, { fc: 4, ph: 7.4, ta: 100, cya: 40, ch: 300, clarity: 'hazy', added: ['shock'], source: 'store', waterF: 82 })];
  const last = tests[0], due = last.at + 7 * D;
  return { tests, last, status: { fc: 'ok', ph: 'ok', cc: null, ta: 'ok', cya: 'ok', ch: null }, cya: 40, fcMin: 3,
    ranges: { fc: [1, 4], ph: [7.2, 7.8], cc: [0, .5], ta: [80, 120], cya: [30, 50], ch: [200, 400] }, waterF: 79,
    pumpHours: Object.fromEntries(Array.from({ length: 38 }, (_, i) => [dayOf(now - (37 - i) * D), i === 37 ? 6.5 : 12 + (i % 3 === 0 ? 1 : 0)])),
    findings: null, due, dueDays: 7, overdue: now > due };
}

/* ---------- Vacation mode (server/src/vacation/) ---------- */
/** GET /api/vacation — vacation/index.ts vacationState: no trip planned or under way, none ended. */
export const vacation = now => ({ now, trip: null, phase: null, last: null });
const tripOf = (now, o) => ({ id: o.id, siteId: 'default', leaveAt: o.leaveAt, backAt: o.backAt, state: o.state, startedAt: o.startedAt ?? null, endedAt: null, endedBy: null, detected: false,
  data: { log: o.log, checklist: { waterHeater: true, unplug: true, mac: true }, macHome: true, ...(o.ac ? { ac: o.ac } : {}) } });
/** A trip under way since yesterday 14:30, back in three days at 6 PM (vacation/trip.ts Trip, phase 'away'; data.ac from vacation/ac.ts freshTripAc). */
export function vacationAway(now) {
  const leaveAt = now - D, backAt = atHour(now, 18, 3);
  const trip = tripOf(now, { id: 7, leaveAt, backAt, state: 'active', startedAt: leaveAt,
    log: [{ at: leaveAt, text: 'Vacation mode started', delta: 'you' }, { at: leaveAt + 60e3, text: 'AC: holding 85° while you’re away', delta: 'ac' }],
    ac: { humid: 0, humidAt: null, heatF0: null, coolF0: 78, ecoOffAt: null, welcome: null } });
  return { now, trip, phase: 'away', last: null };
}
/** A trip planned for the day after tomorrow at 7 AM, back three days later at 6 PM (phase 'planned': nothing changes yet). */
export function vacationPlanned(now) {
  const leaveAt = atHour(now, 7, 2), backAt = atHour(now, 18, 5);
  return { now, trip: tripOf(now, { id: 7, leaveAt, backAt, state: 'planned', log: [{ at: now - H, text: 'Trip planned', delta: 'you' }] }), phase: 'planned', last: null };
}
/** GET /api/vacation/check — app.ts departure.check: the pool (vacation/pool.ts leftOn, cloudyWater, a Clear-up, its Autopilot) and the thermostat. */
export const vacationCheck = () => ({ pool: { linked: true, leftOn: [], water: null, clearUp: false, autopilot: 'auto' }, nest: { linked: true, eco: false, mode: 'COOL', autopilot: 'auto' } });
/** The same with the Pool Light left on and spa heat set (vacation/pool.ts leftOn: a light at its load, and the heat row with id −1). */
export const vacationCheckLeftOn = () => ({ ...vacationCheck(), pool: { ...vacationCheck().pool,
  leftOn: [{ id: 3, name: 'Pool Light', kind: 'light', watts: 500, kwhPerDay: 12 }, { id: -1, name: 'Spa heat', kind: 'heat', watts: null, kwhPerDay: null }] } });
/** GET /api/vacation/estimate?leaveAt=&backAt= — vacation/report.ts estimateTrip (no ended trip yet, so the defaults; `model` from the house's AC model). */
export const vacationEstimate = () => ({ days: 3.1, open: false, perDay: { home: 38.4, empty: 24.6, vacation: 17.3 }, total: { home: 119.0, empty: 76.3, vacation: 53.6 },
  saving: { acPerDay: 5.8, poolPerDay: 1.5, totalKwh: 22.7 }, model: { k: .21, delta: 4, days: 24, fromLastTrip: false }, conf: 'estimated' });
/** GET /api/vacation/trips — vacation/index.ts: the ended trips (newest first, at most 12), each with its report (vacation/report.ts Report). */
export function vacationTrips(now) {
  const startedAt = atHour(now, 9, -24), endedAt = atHour(now, 17, -21);
  return [{ id: 3, startedAt, endedAt, backAt: atHour(now, 18, -21), report: { v: 1, from: startedAt, to: endedAt, days: 3.3, usedKwh: 61.2, emptyKwh: 83.9, homeKwh: 131.5, savedKwh: 22.7, ecoCoolF: 82,
    parts: [{ id: 'ac', used: 14.1, empty: 31.6 }, { id: 'pool', used: 9.8, empty: 14.2 }, { id: 'alwaysOn', used: 27.7, empty: 27.7 }, { id: 'waterHeater', used: 4.3, empty: 4.3 }, { id: 'else', used: 5.3, empty: 6.1 }],
    awayBaseKw: .35, homeBaseKw: .52, did: ['AC: holding 85° while you’re away', 'Welcome home: cooling to 78°'], alerts: 1, next: ['Log a pool test so the next trip’s pool plan can learn from it'],
    conf: { ac: 'measured', empty: 'estimated', home: 'estimated' }, model: { k: .21, delta: 4, days: 24 } } }];
}

/** Every route the appliance views read, keyed as api.js passes it. */
export function applFixtures(now) {
  return {
    'appliances/pool': poolPayload(now),
    'appliances/ac': acPayload(now),
    'appliances/ac/strip': acStrip(now),
    'appliances/day': applDay(now),
    'appliances': appliances(now),
    'pool/water': poolWater(now),
    'vacation': vacation(now),
    'vacation/check': vacationCheck(),
    'vacation/estimate': vacationEstimate(),
    'vacation/trips': vacationTrips(now),
  };
}

/**
 * The api.js methods that write (POST/PUT/PATCH/DELETE) to a device, to Solstice's settings or to the owner's records, and the path each
 * calls (`:id` where the path carries one). A test spies on these and asserts none is called before a sheet's primary is tapped.
 */
export const WRITE_ROUTES = {
  poolApply: 'appliances/pool/apply', poolRestore: 'appliances/pool/restore', poolApplyTomorrow: 'appliances/pool/apply-tomorrow', poolAutopilot: 'appliances/pool/autopilot',
  poolCommand: 'appliances/pool/command', poolGoal: 'appliances/pool/goal', poolClearUp: 'appliances/pool/clearup', poolSuggestion: 'appliances/pool/suggestion', poolSchedule: 'appliances/pool/schedule',
  acApply: 'appliances/ac/apply', acSettings: 'appliances/ac/settings', acUntrim: 'appliances/ac/untrim', acCommand: 'appliances/ac/command', acHold: 'appliances/ac/hold',
  acSuggestion: 'appliances/ac/suggestion', acNudge: 'appliances/ac/nudge',
  saveSettings: 'settings', setPresence: 'presence', pwRuleMode: 'powerwall/rules/:id', pwApply: 'powerwall/rules/:id/apply',
  vacationStart: 'vacation', vacationPatch: 'vacation', vacationEnd: 'vacation/end', vacationSnooze: 'vacation/snooze', vacationAnswer: 'vacation/answer',
  addPoolTest: 'pool/tests', deletePoolTest: 'pool/tests/:id', addEvent: 'events', deleteEvent: 'events/:id',
};
