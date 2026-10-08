// What a guest may see. Every guest read (a share-link cookie, or the owner previewing as a guest) is served through its
// route's view below, and a route with no view is refused to guests before its handler runs (access.ts): fail closed.
// Views are allow-lists: a field that is not named is dropped, so a field added to a route later stays owner-only until it
// is listed here. The rules come from the owner's decisions on the share view (docs/audit-designs/share-view.md):
//  - no dollar figures at all (bills, loan, price, payback, the tariff, every "≈ $ at PEC rates" estimate). Money a view
//    reads is veiled: null for a value, { veiled: true } for an object, [] for a list, so the client keeps its shape and
//    prints "—". Keys that name an account, source, tariff, rate, price, loan or payback, or end in Cost/Usd/Dollars,
//    are dropped outright;
//  - no identifiers: site id, serials, DINs, gateway, firmware, the Nest device path (it holds the Google project id), row
//    ids, the ScreenLogic system, the utility account. Error text becomes a fixed string, because Tesla and Nest errors
//    embed the site id and the device path;
//  - no occupancy: the AC plan is computed as if the owner were home (app.ts), and presence, Eco, the away setpoint, the
//    thermostat's own setpoints (the plan's step stands in), and the log lines and reasons that mention away, home, a trip,
//    the welcome or the trip's drying hold are dropped, as is every log entry a trip writes (S-02, S-03);
//  - history at hourly resolution only: /api/day's five-minute buckets are summed into hours here (the CSV is owner-only);
//  - the location coarse (site.ts coarseLocation), and bills as a skeleton: month, period, kWh bought and sent, and
//    whether the meter matched Tesla.
import type { Response } from 'express';
import { coarseLocation } from './site.js';

/** How one value is kept:
 *  true      a primitive, or a list (of lists) of primitives; an object under `true` is refused (null), so objects are
 *            always spelled out field by field
 *  'veil'    money or a private value: null; an object becomes { veiled: true }; a list becomes []
 *  {…}       an object: only the named keys, each by its own rule
 *  [rule]    a list: every element by the (one) rule
 *  function  a custom transform (fixed text, filters, aggregation) */
export type Rule = true | 'veil' | ((v: any) => unknown) | readonly Rule[] | { readonly [key: string]: Rule };
export type View = (body: any) => unknown;

export const UNAVAILABLE = 'unavailable';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const plainData = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every(plainData));

/** Apply a rule to a value. Keys the rule does not name are dropped; a value of the wrong kind becomes null. */
export function pick(v: unknown, rule: Rule): unknown {
  if (v === undefined) return undefined;
  if (typeof rule === 'function') return rule(v);
  if (rule === 'veil') return v === null ? null : Array.isArray(v) ? [] : isObject(v) ? { veiled: true } : null;
  if (rule === true) return plainData(v) ? v : null;
  if (Array.isArray(rule)) return Array.isArray(v) ? v.map(x => pick(x, rule[0])) : null;
  if (!isObject(v)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(rule as Record<string, Rule>)) if (Object.hasOwn(v, k) && v[k] !== undefined) out[k] = pick(v[k], r as Rule);
  return out;
}

/** A string replaced by fixed text (null stays null): error messages, names. */
export const fixed = (text: string) => (v: unknown) => (v == null ? null : text);
const r2 = (v: number) => Math.round(v * 100) / 100;

/* ---------- shared shapes ---------- */
const kwh = { solar: true, home: true, import: true, export: true, charge: true, discharge: true } as const;
const errorEntry = { at: true, message: fixed(UNAVAILABLE) } as const;
// the installer's name, the install date and Tesla's install timestamp are quasi-identifiers: a guest gets the install year only (S-09)
const SOLAR = { module: true, panels: true, panelWdc: true, panelVaAc: true, microinverter: true, efficiencyPct: true, tempCoefPctPerC: true,
  moduleM: { w: true, h: true }, dcKw: true, acKw: true, year: true, warrantedDcPct: true,
  warranty: { years: true, dcYear1Pct: true, dcDeclinePctPerYear: true, acFloorPct: true, labourYears: true } } as const;
const log = { at: true, day: true, text: true, delta: true } as const;

/** /api/day at hourly resolution: each hour's five-minute buckets summed (kW over 5 min / 12 = kWh), so every value is the
 *  hour's energy, which is also its average kW; battery % is the hour's mean. `t` is a whole hour; `bucketMinutes` says 60. */
export function hourlyDay(b: any) {
  const hours = new Map<number, { solar: number; home: number; grid: number; battery: number }>(), soc = new Map<number, number[]>();
  for (const x of Array.isArray(b?.buckets) ? b.buckets : []) {
    const h = Math.floor(Number(x?.t)); if (!Number.isFinite(h)) continue;
    const a = hours.get(h) ?? { solar: 0, home: 0, grid: 0, battery: 0 };
    for (const k of ['solar', 'home', 'grid', 'battery'] as const) a[k] += (Number(x[k]) || 0) / 12;
    hours.set(h, a);
  }
  for (const x of Array.isArray(b?.soe) ? b.soe : []) {
    const h = Math.floor(Number(x?.t)); if (!Number.isFinite(h) || !Number.isFinite(Number(x?.soc))) continue;
    soc.set(h, [...(soc.get(h) ?? []), Number(x.soc)]);
  }
  return {
    date: typeof b?.date === 'string' ? b.date : null, bucketMinutes: 60,
    buckets: [...hours].sort((p, q) => p[0] - q[0]).map(([t, a]) => ({ t, solar: r2(a.solar), home: r2(a.home), grid: r2(a.grid), battery: r2(a.battery) })),
    soe: [...soc].sort((p, q) => p[0] - q[0]).map(([t, v]) => ({ t, soc: Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 })),
    totals: pick(b?.totals ?? null, kwh),
  };
}

/** Bills for guests, from /api/reconcile: the month, the period, kWh bought and sent, and whether PEC's meter matched Tesla. */
export const guestBills = (rows: unknown) => (Array.isArray(rows) ? rows : []).map((r: any) => ({
  month: typeof r?.billDate === 'string' ? r.billDate.slice(0, 7) : null,
  period: pick(r?.period ?? null, { from: true, to: true, days: true }),
  deliveredKwh: typeof r?.pec?.deliveredKwh === 'number' ? r.pec.deliveredKwh : null,
  receivedKwh: typeof r?.pec?.receivedKwh === 'number' ? r.pec.receivedKwh : null,
  checks: { meterMatchesTesla: Array.isArray(r?.checks) && r.checks.find((c: any) => c?.id === 'meter')?.ok === true },
}));

/* ---------- appliances ---------- */
const POOL_ERROR = 'Couldn’t reach the pool controller.';
/* ---------- presence and trips (audit 10b, S-02) ---------- */
/** Log lines and reasons that mention presence ("marked away", "until you mark Home"), Nest's Eco (an occupancy signal), a trip
 *  ("Vacation: …", "trip plan"), the welcome home, or the trip's humidity hold ("holding 83° to dry the house", "drying the house")
 *  never reach a guest. */
export const PRESENCE_WORDS = /\b(away|home|eco|vacation|trips?|travel(?:l?ing)?|welcome|dry the house|drying the house|keep the house dry|drying)\b/i;
export const noPresence = (v: unknown) => (typeof v === 'string' ? !PRESENCE_WORDS.test(v) : true);
/** Log entries a guest never gets, whatever their text: the ones a trip writes (`delta` trip, welcome or humidity), Nest's Eco (an
 *  occupancy signal, presence.ts), and any entry its writer marked `private: true` (every line vacation/ac.ts logs carries it). */
export const PRIVATE_DELTAS: ReadonlySet<string> = new Set(['trip', 'welcome', 'humidity', 'eco']);
export const guestLogEntry = (x: any) => isObject(x) && x.private !== true && !(typeof x.delta === 'string' && PRIVATE_DELTAS.has(x.delta)) && noPresence(x.text);
const whyList = (w: unknown) => (Array.isArray(w) ? w.filter(x => typeof x === 'string' && noPresence(x)) : []);
/** A pool day's reasons come as a set: when one names the trip the others are the trip's too ("+0.5 turnover: water at 88°F" follows
 *  "Vacation: 1 turnover a day"), so the whole list is dropped. */
const whySet = (w: unknown) => (Array.isArray(w) && w.every(x => typeof x === 'string' && noPresence(x)) ? w : []);
const whyText = (v: unknown) => (typeof v === 'string' && noPresence(v) ? v : null);
const guestLog = (l: unknown) => (Array.isArray(l) ? l.filter(guestLogEntry).map(x => pick(x, log)) : []);

const schedule = { name: true, rpm: true, start: true, stop: true } as const;
const hourly = [{ rpm: true, frac: true }] as const;
const poolPlan = { month: true, waterTemp: true, turnovers: true, goal: true, rpm: true, hours: true, boostHours: true, start: true, stop: true, boostAt: true,
  schedules: [{ ...schedule, why: whyText }], kwhPerDay: true, costPerMonth: 'veil', onSolarPct: true, turnoverPerDay: true, hourly, uvKwh: true } as const;
const autopilot = { mode: true, nextRunAt: true, pending: true, filterHours: true, filterCleanedOn: true,
  signals: { waterTemp: true, sunKwhM2: true, sunPct: true, high: true, heatDays: true, rainPct: true, rainMm: true, rainYesterdayMm: true, useDays: true, pollen: true },
  tomorrow: { date: true, plan: poolPlan, why: whySet }, week: [{ date: true, hours: true, boost: true, sunKwhM2: true, rainPct: true, high: true }], log: guestLog } as const;
/**
 * A guest's view of Pool Autopilot never shows a trip (audit 10b, S-01): trip days show the plan as if the owner were home
 * (`ifHome` / `tomorrowIfHome` from autopilot.ts), and reasons or log lines that name the trip are dropped.
 */
const guestAutopilot = (a: any) => {
  if (!isObject(a)) return a === undefined ? undefined : null;
  if ('error' in a) return { error: UNAVAILABLE };
  const g = pick(a, autopilot) as any;
  if (isObject(a.tomorrowIfHome)) g.tomorrow = pick(a.tomorrowIfHome, autopilot.tomorrow);
  if (Array.isArray(a.week)) g.week = a.week.map((w: any) => { const p = pick(w, autopilot.week[0]) as any; return isObject(w?.ifHome) ? { ...p, hours: w.ifHome.hours, boost: w.ifHome.boost } : p; });
  return g;   // tomorrow.why, each schedule's why and the log go through whySet, whyText and guestLog (S-02)
};
const POOL: Rule = {
  id: true, name: true, linked: true, error: fixed(POOL_ERROR),
  autopilot: guestAutopilot,
  // a suggested plan whose reasons name a trip is withheld from guests altogether
  pending: (p: any) => (isObject(p) && Array.isArray(p.why) && !p.why.every(noPresence) ? null : pick(p, { date: true, plan: poolPlan, why: whySet })),
  extras: { hourlyToday: true, todayKwh: true, nowW: true, uvW: true, lightReadings30d: true },
  spaSession: { spaGallons: true, spaTemp: true, spaSet: true, riseF: true, heatMinutes: true, propaneGal: true, pumpWattsAtSpa: true, blowerWatts: true, electricUsdPerHour: 'veil' },
  settings: { gallons: true, spaGallons: true, designGpm: true, filterRpm: true, boostRpm: true, uv: true, autopilot: true, turnoverGoal: true, skimHours: true, boostCircuit: true },
  water: { goal: true, skimHours: true, movedTurnovers: true, projectedTurnovers: true, gallons: true },
  clearUp: { startedAt: true, until: true, days: true, rpm: true, day: true },   // frame 6: the Clear-up banner   // mockup w frame 5: the planner's ring
  snapshot: { at: true, airTemp: true, freezeMode: true, bodies: [{ temp: true, setPoint: true, heating: true }] },
  live: { watts: true, rpm: true, running: true, gpm: true, at: true, waterTemp: true, airTemp: true, freezeMode: true, on: true, activeRpm: true },
  model: { measured: [{ rpm: true, watts: true }], curve: [{ rpm: true, watts: true }] },
  current: { schedules: [schedule], hours: true, kwhPerDay: true, costPerMonth: 'veil', onSolarPct: true, turnoverPerDay: true, hourly,
    byProgram: [{ ...schedule, kwhPerDay: true }] },
  plan: poolPlan,
  seasons: [{ label: true, waterTemp: true, hours: true, boostHours: true, rpm: true, kwhPerDay: true, costPerMonth: 'veil', current: true }],
  solarKw: true, todayKwh: true, shareOfHomePct: true,
  applied: { at: true },
  conf: { kwhPerDay: true },   // learning layer: the confidence tier of the kWh/day figures
};
/**
 * The thermostat's own setpoints never reach a guest (audit 10b, S-03). Outside a trip a manual Away or Nest's Eco leaves the
 * thermostat at the away setpoint (or no setpoint at all, in Eco), and the guest body's `state` is the real reading even though its
 * plan is computed as if the owner were home (access.ts presenceHidden). So a guest's coolF is the as-if-home plan's step for this
 * hour (currentStep.coolF) while the thermostat is cooling (COOL or Heat · Cool), else null; heatF is always null; the mode, the
 * indoor reading and whether it is running pass. The away setpoint (settings.awayF) is not in the view at all.
 */
const guestAcState = (st: unknown, body: any) => {
  if (!isObject(st)) return st === undefined ? undefined : null;
  const g = pick(st, { at: true, name: fixed('Thermostat'), online: true, indoorF: true, humidity: true, mode: true, hvac: true }) as any;
  const step = Number(body?.currentStep?.coolF), cooling = st.mode === 'COOL' || st.mode === 'HEATCOOL';
  return { ...g, coolF: cooling && Number.isFinite(step) ? step : null, heatF: null };
};
const AC_RULE = {
  id: true, name: true, configured: true, linked: true, error: fixed(UNAVAILABLE),
  settings: { band: { homeLo: true, homeHi: true, nightLo: true, nightHi: true }, nightFrom: true, nightTo: true, precoolDepth: true,
    coastF: true, maxStepF: true, humidityCap: true, autopilot: true, presence: 'veil', dayF: true, nightF: true, driftF: true },   // mockup ag: the targets
  learned: { coolKw: true, heatKw: true, samples: true, heatSamples: true, acKw: true },
  runtime: { minutes: true, duty: true }, todayKwh: true, shareOfHomePct: true,
  plan: { date: true, steps: [{ hour: true, coolF: true, why: whyText }], precool: true, precoolFrom: true, precoolTo: true, coastFrom: true, coastTo: true,
    high: true, sunKwhM2: true, why: whyList,
    // learning layer (learn/ac.ts): the two savings figures are kWh, so they pass, with their confidence tiers; whether today is a
    // control day; a learned trim with its reason (indoor temperatures and times, no presence; filtered anyway, like `why`)
    shiftedKwh: true, eveningAvoidedKwh: true, conf: { shiftedKwh: true, eveningAvoidedKwh: true }, control: true,
    trim: { what: true, amount: true, unit: true, from: true, to: true, warmupFPerH: true, reason: whyText } },
  currentStep: { hour: true, coolF: true, why: whyText },
  week: [{ date: true, high: true, sunKwhM2: true, precool: true, depth: true, shiftedKwh: true, eveningAvoidedKwh: true,
    precoolFrom: true, precoolTo: true, coastFrom: true, coastTo: true }],   // window hours: the Next 48 hours road draws them
  applied: { date: true, approved: true, lastStepHour: true },
  log: guestLog,
  outdoorF: true, hourlyOutdoor: true,
  equipment: { airHandler: true, heat: true, outdoor: true },
} as const;
/** The AC view: the allow-list, then `state` from the thermostat reading with the plan's setpoint in place of the thermostat's. */
const acView: View = b => { const g = pick(b, AC_RULE) as any; if (isObject(b) && 'state' in b && isObject(g)) g.state = guestAcState(b.state, b); return g; };

/* ---------- per-panel health ---------- */
const panelPos = { id: true, name: true } as const;
const PANELS_VIEW: Rule = {
  date: true, today: true, timeZone: true, at: true, bucketMinutes: true, times: true,
  layout: { learned: true, mapped: true, expected: true, unmapped: true },
  relay: { lastPoll: true, ageS: true, silent: true, daylight: true, silentMin: true, heardAt: true, cause: true, note: true },   // not relay.pvs (the raw error)
  since: true, days: true, sunDown: true, reporting: true,
  now: { medianKw: true, medianKwDc: true, medianConvPct: true, arrayKw: true, weakest: { ...panelPos, pct: true } },
  totals: { kwh: true, medianKwh: true, spread: { loPct: true, hiPct: true }, hottest: { ...panelPos, tempC: true } },
  lowest: [{ ...panelPos, kwh: true, pct: true }],
  notReporting: [{ ...panelPos, at: true, lastKw: true, kwh: true, silentMin: true, pushAt: true }],
  panels: [{ ...panelPos, row: true, col: true, reporting: true, at: true, ageS: true, kw: true, kwDc: true, tempC: true, kwh: true, kwhSource: true,
    maxTempC: true, sharePct: true, pctNow: true, pctToday: true, flagged: true, spark: true }],
  medianSeries: true,
  anomalies: [{ kind: true, ...panelPos, day: true, openedAt: true, title: true, body: true, nLow: true, window: true, days: [{ day: true, pct: true }],
    diag: { kind: true, lead: true, text: true } }],
};

/* ---------- I-18 "What changed" (learn/changed.ts, mockup am frame 8) ---------- */
/** A guest's parts: only the listed ids (the route already computed them without trip awareness and folded AC, always-on and
 *  unexplained into "other"), so no trip, AC or always-on part can ever reach a guest; notes never do. */
const changedParts = (ids: readonly string[]) => (v: unknown) => (Array.isArray(v) ? v : []).filter((p: any) => isObject(p) && ids.includes(p.id as string))
  .map(p => pick(p, { id: true, kwh: true, conf: true }));
// the owner's answer (2026-10-08): guests get the Used card only, so nothing of what was bought leaves the server
export const GUEST_CHANGED_IDS = { home: ['weather', 'pool', 'other'] } as const;
const CHANGED: Rule = {
  scope: true, date: true, to: true, baseline: { kind: true, days: true }, wx: { high: true, baseHigh: true },
  home: { obs: true, base: true, delta: true, parts: changedParts(GUEST_CHANGED_IDS.home) },
};

/* ---------- the routes a guest may read (GET only), each with its view. Paths are lower-case, as access.ts compares them. ---------- */
const REPLAY = { importKwh: true, exportKwh: true, solarKwh: true, homeKwh: true, selfPowered: true, batteryFullDays: true } as const;
const view = (rule: Rule): View => b => pick(b, rule);
export const GUEST_GET: ReadonlyMap<string, View> = new Map<string, View>([
  // the coarse location feeds weather, NWS and the sun position; nothing else of the owner's settings
  ['/api/settings', () => ({ location: coarseLocation() })],
  ['/api/now', view({
    reading: { ts: true, solarKw: true, homeKw: true, batteryKw: true, gridKw: true, soc: true, gridStatus: true, islandStatus: true, stormActive: true },
    today: kwh,
    site: { name: fixed('Home'), batteryCount: true, batteries: [{ name: true, kwh: true, kw: true }], capacityKwh: true, measuredKwh: true, modelKwh: true, maxPowerKw: true,
      reservePct: true, mode: true, stormWatch: true, solar: SOLAR },
    outage: { active: true, since: true },
    health: { lastLive: true, lastHistory: true, stale: true, liveError: fixed(UNAVAILABLE),
      errors: { siteInfo: errorEntry, lastHistory: errorEntry, lastBackups: errorEntry, live: errorEntry } },
  })],
  ['/api/status', view({ connected: true, lastLive: true, lastHistory: true, backfill: { daysDone: true } })],
  ['/api/day', hourlyDay],
  ['/api/daily', view([{ date: true, ...kwh, socMin: true, socMax: true }])],
  ['/api/monthly', view([{ month: true, days: true, ...kwh }])],
  ['/api/profile', view({ days: true, hours: [{ hour: true, home: true, solar: true }], conf: { 'fc48.solar': true, 'fc48.home': true, 'fc48.soc': true }, scale: true,
    correction: { solar: { 'h1-6': true, 'h7-24': true, 'h25-48': true }, home: { 'h1-6': true, 'h7-24': true, 'h25-48': true } } })],   // B2-2: bias factors, no personal data
  ['/api/grid-days', view({ dates: true, solar: true, soc: true })],
  // mockup ai: the Cleaning check card; the $ figure is the owner's (from the bill), never a guest's
  ['/api/soiling', b => b == null ? null : pick(b, { state: true, lossPct: true, lossSd: true, score: true, kwhPerDay: true, ref: { from: true, to: true, y: true, after: true }, now: true, resetOn: true, resetBy: true,
    lastRain: { day: true, mm: true, daysAgo: true }, nextRain: { day: true, mm: true }, clearSince: true, points: [{ day: true, y: true }], rains: [{ day: true, mm: true }], at: true })],
  ['/api/overnight', view([{ date: true, kw: true, base: true, ac: true, pump: true, split: true }])],
  ['/api/records', view({ bestSolarDay: { date: true, kwh: true }, biggestUsageDay: { date: true, kwh: true }, lowestImportDay: { date: true, kwh: true },
    totals: { since: true, ...kwh }, batteryFullDays: { days: true, of: true }, longestOutage: { ts: true, duration_s: true }, outages: true })],
  ['/api/outages', view([{ ts: true, duration_s: true }])],
  ['/api/reconcile', guestBills],
  // panel and filter cleanings only (the dates the Panels and Pool cards show); notes and row ids never
  ['/api/events', b => (Array.isArray(b) ? b : []).filter((e: any) => e?.type === 'cleaned' || e?.type === 'filter_cleaned').map((e: any) => ({ type: e.type, day: e.day }))],
  ['/api/ercot', view({ condition: true, title: true, note: true, eea: true, demandMw: true, capacityMw: true, at: true })],
  ['/api/whatif', view({
    days: true, kwpNow: true, acKw: true, panels: true, panelWdc: true, assumptions: { panelW: true, dollarsPerW: 'veil' },
    actual: { importKwh: true, exportKwh: true }, baseline: REPLAY, upgraded: REPLAY, noSystem: REPLAY,
    savesPerYear: 'veil', system: () => ({ veiled: true }), backupHoursEvening: { now: true, upgraded: true },
  })],
  ['/api/appliances', view([{ id: true, name: true, status: true, watts: true, kwhPerDay: true, savesPerMonth: 'veil', error: fixed(UNAVAILABLE) }])],
  ['/api/appliances/pool', view(POOL)],
  ['/api/appliances/ac', acView],
  // per-panel health (panels.ts, mockup u-panels): positions only (the route never names a serial), and not the owner's alert state
  ['/api/pvs/panels', view(PANELS_VIEW)],
  ['/api/changed', view(CHANGED)],
]);

/** Serve this response through a guest view: res.json runs the view first. Error responses keep their status but carry a
 *  fixed message (server error text can hold the site id or a device path); a view that throws is a 500, never the raw body. */
export function serveThrough(res: Response, v: View) {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) return json({ error: UNAVAILABLE });
    let out: unknown;
    try { out = v(body); } catch (e) { console.error('[solstice] guest view failed', e); res.status(500); return json({ error: UNAVAILABLE }); }
    return json(out);
  }) as typeof res.json;
}
