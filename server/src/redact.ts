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
//  - no occupancy: the AC plan is computed as if the owner were home (app.ts), and presence, Eco and the log lines that
//    mention away or home are dropped;
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
const SOLAR = { installer: true, module: true, panels: true, panelWdc: true, panelVaAc: true, microinverter: true, efficiencyPct: true, tempCoefPctPerC: true,
  moduleM: { w: true, h: true }, dcKw: true, acKw: true, installedOn: true, year: true, warrantedDcPct: true,
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
const schedule = { name: true, rpm: true, start: true, stop: true } as const;
const hourly = [{ rpm: true, frac: true }] as const;
const poolPlan = { month: true, waterTemp: true, turnovers: true, hours: true, boostHours: true, start: true, stop: true, boostAt: true,
  schedules: [{ ...schedule, why: true }], kwhPerDay: true, costPerMonth: 'veil', onSolarPct: true, turnoverPerDay: true, hourly, uvKwh: true } as const;
const autopilot = { mode: true, nextRunAt: true, pending: true, filterHours: true, filterCleanedOn: true,
  signals: { waterTemp: true, sunKwhM2: true, sunPct: true, high: true, heatDays: true, rainPct: true, rainMm: true, rainYesterdayMm: true, useDays: true, pollen: true },
  tomorrow: { date: true, plan: poolPlan, why: true }, week: [{ date: true, hours: true, boost: true, sunKwhM2: true, rainPct: true, high: true }], log: [log] } as const;
const POOL: Rule = {
  id: true, name: true, linked: true, error: fixed(POOL_ERROR),
  autopilot: (a: any) => (isObject(a) && 'error' in a ? { error: UNAVAILABLE } : pick(a, autopilot)),
  pending: { date: true, plan: poolPlan, why: true },
  extras: { hourlyToday: true, todayKwh: true, nowW: true, uvW: true, lightReadings30d: true },
  spaSession: { spaGallons: true, spaTemp: true, spaSet: true, riseF: true, heatMinutes: true, propaneGal: true, pumpWattsAtSpa: true, blowerWatts: true, electricUsdPerHour: 'veil' },
  settings: { gallons: true, spaGallons: true, designGpm: true, filterRpm: true, boostRpm: true, uv: true, autopilot: true },
  snapshot: { at: true, airTemp: true, freezeMode: true, bodies: [{ temp: true, setPoint: true, heating: true }] },
  live: { watts: true, rpm: true, running: true, gpm: true, at: true, waterTemp: true, airTemp: true, freezeMode: true, on: true, activeRpm: true },
  model: { measured: [{ rpm: true, watts: true }], curve: [{ rpm: true, watts: true }] },
  current: { schedules: [schedule], hours: true, kwhPerDay: true, costPerMonth: 'veil', onSolarPct: true, turnoverPerDay: true, hourly,
    byProgram: [{ ...schedule, kwhPerDay: true }] },
  plan: poolPlan,
  seasons: [{ label: true, waterTemp: true, hours: true, boostHours: true, rpm: true, kwhPerDay: true, costPerMonth: 'veil', current: true }],
  solarKw: true, todayKwh: true, shareOfHomePct: true,
  applied: { at: true },
};
/** Log lines and reasons that mention presence ("marked away", "until you mark Home") never reach a guest. */
const noPresence = (v: unknown) => (typeof v === 'string' ? !/\b(away|home)\b/i.test(v) : true);
const AC: Rule = {
  id: true, name: true, configured: true, linked: true, error: fixed(UNAVAILABLE),
  settings: { band: { homeLo: true, homeHi: true, nightLo: true, nightHi: true }, awayF: true, nightFrom: true, nightTo: true, precoolDepth: true,
    coastF: true, maxStepF: true, humidityCap: true, autopilot: true, presence: 'veil' },
  state: { at: true, name: fixed('Thermostat'), online: true, indoorF: true, humidity: true, mode: true, hvac: true, coolF: true, heatF: true },
  learned: { coolKw: true, heatKw: true, samples: true, heatSamples: true, acKw: true },
  runtime: { minutes: true, duty: true }, todayKwh: true, shareOfHomePct: true,
  plan: { date: true, steps: [{ hour: true, coolF: true, why: true }], precool: true, precoolFrom: true, precoolTo: true, coastFrom: true, coastTo: true,
    high: true, sunKwhM2: true, kwhSaved: true, costSavedMonth: 'veil', why: (w: unknown) => (Array.isArray(w) ? w.filter(x => typeof x === 'string' && noPresence(x)) : []) },
  currentStep: { hour: true, coolF: true, why: true },
  week: [{ date: true, high: true, sunKwhM2: true, precool: true, depth: true, kwhSaved: true }],
  applied: { date: true, approved: true, lastStepHour: true },
  log: (l: unknown) => (Array.isArray(l) ? l.filter(x => noPresence(x?.text)).map(x => pick(x, log)) : []),
  outdoorF: true, hourlyOutdoor: true,
  equipment: { airHandler: true, heat: true, outdoor: true },
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
    site: { name: fixed('Home'), installed: true, batteryCount: true, batteries: [{ name: true, kwh: true, kw: true }], capacityKwh: true, maxPowerKw: true,
      reservePct: true, mode: true, stormWatch: true, solar: SOLAR },
    outage: { active: true, since: true },
    health: { lastLive: true, lastHistory: true, stale: true, liveError: fixed(UNAVAILABLE),
      errors: { siteInfo: errorEntry, lastHistory: errorEntry, lastBackups: errorEntry } },
  })],
  ['/api/status', view({ connected: true, lastLive: true, lastHistory: true, backfill: { daysDone: true } })],
  ['/api/day', hourlyDay],
  ['/api/daily', view([{ date: true, ...kwh, socMin: true, socMax: true }])],
  ['/api/monthly', view([{ month: true, days: true, ...kwh }])],
  ['/api/profile', view({ days: true, hours: [{ hour: true, home: true, solar: true }] })],
  ['/api/grid-days', view({ dates: true, solar: true, soc: true })],
  ['/api/overnight', view([{ date: true, kw: true }])],
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
  ['/api/appliances/ac', view(AC)],
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
