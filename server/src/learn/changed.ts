// I-18 "What changed" (approved mockup mockups/am-ideas.html, frames 1–3 and 8): a day's (or a week's) home use and kWh bought,
// split against a baseline into parts that add up to the change exactly.
//   day   against the same weekday of the last 4 weeks (complete days, no trip day, no Clear-up day; 2 or more needed), else the
//         mean of the last 7 such days
//   week  Monday–Sunday against the week before (as the weekly digest compares them)
// Home use parts:
//   weather      f(T) of the day less the baseline's mean f(T), f = the home model (learn/homeModel.ts homeKwh) with no intercept:
//                cooling b·max(0, high − Tc) and heating c·max(0, Th − low) kept apart; "learning" while the model is still the
//                14-day line (no year fit yet)
//   ac           the AC's kWh change (nightly ac.kwh: cooling minutes × the learned draw; heating minutes × the heating draw once
//                one is learned) less the weather's cooling share (and its heating share once heating kWh are counted)
//   pool         the pool's kWh change (nightly pool.kwh)
//   alwaysOn     always-on kW × the day's hours (23, 24 or 25) change
//   trip         owner only: on a trip day, what the house used less what it would have used at home (the trip day's own
//                baseline, moved by its weather and its pool run)
//   unexplained  the change less every part above
// kWh bought: Δbought = Δused − ΔS, S = used − bought (what solar and the Powerwalls covered), so the solar part is −ΔS, exactly.
// Each part is rounded to 0.1 kWh and the rounding goes into "unexplained", so the shown parts add up to the shown change.
// A guest's answer is computed without trip awareness and folds AC, always-on and unexplained into one "other" part (redact.ts).
// Numbers only: the browser builds the sentences (web/src/lib/changed.js). No dollar figure anywhere.
import { q, kv } from '../db.js';
import { localDay, addDays, localMidnight } from '../tesla/client.js';
import { fitHome, homeSlopesKey, clearUpDays, type HomeSlopes } from './homeModel.js';
import { tripDays } from '../vacation/trip.js';
import { learnAcKw, acKwConf } from '../appliances/ac.js';

export type Conf = 'measured' | 'estimated' | 'learning';
export type PartId = 'weather' | 'ac' | 'pool' | 'alwaysOn' | 'trip' | 'unexplained' | 'other' | 'home' | 'solar';
export type Part = { id: PartId; kwh: number; conf: Conf | null };
/** One local day as the attribution reads it. `pool`, `ac`, `heatMin`, `alwaysOnKw`, `high`, `low`: null when not measured. */
export type Day = { day: string; home: number; imp: number; solar: number; complete: boolean; hours: number;
  pool: number | null; ac: number | null; heatMin: number | null; alwaysOnKw: number | null; high: number | null; low: number | null; trip: boolean; clearUp: boolean };
/** The weather terms (no intercept). learning: the 14-day line, before a year fit exists. */
export type Weather = { b: number; c: number; tc: number; th: number; learning: boolean } | null;
export type Section = { obs: number; base: number; delta: number; parts: Part[] };
export type Changed = {
  scope: 'day' | 'week'; date: string; to: string;
  baseline: { kind: 'weekday' | 'prev7' | 'week'; days: number } | null;
  wx: { high: number; baseHigh: number } | null;
  home: Section | null; import: (Section & { solar: { obs: number; base: number } }) | null;
  /** false: the history isn't clean enough to split the change yet, so home.parts is empty (the totals still show). */
  clean: boolean;
  notes: string[];
};
export type Inputs = { scope: 'day' | 'week'; date: string; days: ReadonlyMap<string, Day>; weather: Weather; heatKw: number | null; acConf: 'measured' | 'estimated'; guest?: boolean };

/** A bad scope or date: the route answers 400. */
export class ChangedInputError extends Error {}

export const WEEKDAY_WEEKS = 4, WEEKDAY_MIN = 2, PREV_DAYS = 7, PREV_SEARCH = 28, COMPLETE = .95, LINE_DAYS = 14;
const r1 = (v: number) => Math.round(v * 10) / 10;
const tenths = (v: number) => Math.round(v * 10);
const meanOf = (v: number[]) => v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
const utc = (d: string) => Date.parse(d + 'T12:00:00Z');
export const mondayOf = (day: string) => addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));
/** A Chicago day's length in hours: 23, 24 or 25. */
export const dayHours = (day: string) => Math.round((localMidnight(addDays(day, 1)).getTime() - localMidnight(day).getTime()) / 3600_000);

const eligible = (x: Day | undefined, guest: boolean): x is Day => !!x && x.complete && !x.clearUp && (guest || !x.trip);
/** The day baseline: the same weekday of the last 4 weeks (2 or more eligible), else the last 7 eligible days of the 28 before. */
export function dayBaseline(days: ReadonlyMap<string, Day>, date: string, guest = false): { kind: 'weekday' | 'prev7'; days: string[] } | null {
  const wk = Array.from({ length: WEEKDAY_WEEKS }, (_, i) => addDays(date, -7 * (i + 1))).filter(d => eligible(days.get(d), guest));
  if (wk.length >= WEEKDAY_MIN) return { kind: 'weekday', days: wk };
  const prev: string[] = [];
  for (let i = 1; i <= PREV_SEARCH && prev.length < PREV_DAYS; i++) { const d = addDays(date, -i); if (eligible(days.get(d), guest)) prev.push(d); }
  return prev.length ? { kind: 'prev7', days: prev } : null;
}

/** The weather terms the attribution uses: the year fit's slopes, else the 14-day line fitted on the eligible days before `date`. */
export function weatherModel(slopes: Pick<HomeSlopes, 'b' | 'c' | 'tc' | 'th'> | null | undefined, days: ReadonlyMap<string, Day>, date: string, guest = false): Weather {
  if (slopes) return { b: slopes.b, c: slopes.c, tc: slopes.tc, th: slopes.th, learning: false };
  const pts = Array.from({ length: LINE_DAYS }, (_, i) => days.get(addDays(date, -(i + 1))))
    .filter((x): x is Day => eligible(x, guest) && x.high != null).map(x => ({ day: x.day, high: x.high!, kwh: x.home }));
  const f = fitHome(pts);
  return f ? { b: f.b, c: 0, tc: f.tc, th: f.th, learning: true } : null;
}

/** The attribution (pure). */
export function attribute(inp: Inputs): Changed {
  const { scope, days, weather: w, heatKw, guest = false } = inp, notes = new Set<string>();
  const date = scope === 'week' ? mondayOf(inp.date) : inp.date, to = scope === 'week' ? addDays(date, 6) : date;
  const empty = (note: string, baseline: Changed['baseline'] = null): Changed => ({ scope, date, to, baseline, wx: null, home: null, import: null, clean: false, notes: [note] });
  let O: Day[], B: Day[], kind: 'weekday' | 'prev7' | 'week';
  if (scope === 'day') {
    const o = days.get(date); if (!o || !o.complete) return empty('incomplete');
    const bl = dayBaseline(days, date, guest); if (!bl) return empty('no-baseline');
    O = [o]; B = bl.days.map(d => days.get(d)!); kind = bl.kind;
  } else {
    O = Array.from({ length: 7 }, (_, i) => days.get(addDays(date, i))!); B = Array.from({ length: 7 }, (_, i) => days.get(addDays(date, i - 7))!);
    if (O.some(x => !x)) return empty('incomplete');
    if (B.some(x => !x)) return empty('no-baseline');
    kind = 'week';
  }
  if (kind === 'prev7') notes.add('prev7');
  const scale = scope === 'week' ? B.length : 1;   // a day compares with the baseline's mean, a week with the week before's total

  // the weather terms of one day (null when its temperature is missing)
  const fc = (x: Day) => !w ? 0 : x.high == null ? null : w.b * Math.max(0, x.high - w.tc);
  const fh = (x: Day) => !w || !w.c ? 0 : x.low == null ? null : w.c * Math.max(0, w.th - x.low);
  const acOf = (x: Day) => x.ac == null ? null : x.ac + (heatKw != null && x.heatMin != null ? x.heatMin / 60 * heatKw : 0);
  const aoOf = (x: Day) => x.alwaysOnKw == null ? null : x.alwaysOnKw * x.hours;
  const mean = (xs: Day[], f: (x: Day) => number | null, all = false) => { const v = xs.map(f); if (all && v.some(x => x == null)) return null; return meanOf(v.filter((x): x is number => x != null)); };

  // a trip day stands in as the day at home: its own baseline, moved by its weather and its pool run (owner only)
  type Eff = { home: number; ac: number | null; ao: number | null };
  const eff = new Map<string, Eff>(), trips = guest ? [] : [...O, ...B].filter(x => x.trip);
  for (const x of trips) {
    const ref = dayBaseline(days, x.day, false); if (!ref) { notes.add('trip-unadjusted'); continue; }
    const R = ref.days.map(d => days.get(d)!);
    const wc = fc(x), wh = fh(x), rc = mean(R, fc, true), rh = mean(R, fh, true);
    const dWc = wc != null && rc != null ? wc - rc : 0, dWh = wh != null && rh != null ? wh - rh : 0;
    const rp = mean(R, d => d.pool), dP = x.pool != null && rp != null ? x.pool - rp : 0, rAc = mean(R, acOf), rAo = mean(R, d => d.alwaysOnKw);
    eff.set(x.day, { home: mean(R, d => d.home)! + dWc + dWh + dP, ac: rAc != null ? rAc + dWc + (heatKw != null ? dWh : 0) : null, ao: rAo != null ? rAo * x.hours : null });
  }
  if (trips.length) notes.add('trip');
  const homeE = (x: Day) => eff.get(x.day)?.home ?? x.home, acE = (x: Day) => eff.has(x.day) ? eff.get(x.day)!.ac : acOf(x), aoE = (x: Day) => eff.has(x.day) ? eff.get(x.day)!.ao : aoOf(x);

  // Δ of a quantity: every observed day needs it; the baseline the days that have it (`all`: every baseline day)
  const sumO = (f: (x: Day) => number | null) => { const v = O.map(f); return v.some(x => x == null) ? null : (v as number[]).reduce((a, x) => a + x, 0); };
  const baseB = (f: (x: Day) => number | null, all = false) => { const m = mean(B, f, all); return m == null ? null : m * scale; };
  const delta = (f: (x: Day) => number | null, all = false) => { const o = sumO(f), b = baseB(f, all); return o == null || b == null ? null : o - b; };
  const covered = (f: (x: Day) => number | null) => [...O, ...B].every(x => f(x) != null);

  const dHome = sumO(x => x.home)! - baseB(x => x.home)!, dHomeE = sumO(homeE)! - baseB(homeE)!;
  const Wc = w ? delta(fc, true) : null, Wh = w ? delta(fh, true) : null, W = Wc != null && Wh != null ? Wc + Wh : null;
  if (!w) notes.add('no-weather-model'); else if (W == null) notes.add('weather-missing');
  const dAc = delta(acE, true), dPool = delta(x => x.pool), dAo = delta(aoE);
  if (dAc == null) notes.add('ac-uncovered'); if (dPool == null) notes.add('pool-missing'); if (dAo == null) notes.add('always-on-missing');
  const raw: Array<{ id: PartId; v: number | null; conf: Conf | null }> = [
    { id: 'weather', v: W, conf: w?.learning ? 'learning' : 'estimated' },
    { id: 'ac', v: dAc == null ? null : dAc - (W == null ? 0 : Wc! + (heatKw != null ? Wh! : 0)), conf: inp.acConf },
    { id: 'pool', v: dPool, conf: covered(x => x.pool) ? 'measured' : 'estimated' },
    { id: 'alwaysOn', v: dAo, conf: 'measured' },
    ...(trips.length ? [{ id: 'trip' as const, v: dHome - dHomeE, conf: 'estimated' as const }] : []),
  ];
  // in tenths of a kWh, so the shown parts add up to the shown change exactly
  const dT = tenths(dHome), shown = raw.filter(p => p.v != null).map(p => ({ id: p.id, t: tenths(p.v!), conf: p.conf }));
  const uT = dT - shown.reduce((a, p) => a + p.t, 0);
  let parts: Part[] = [...shown.map(p => ({ id: p.id, kwh: p.t / 10, conf: p.conf })), { id: 'unexplained', kwh: uT / 10, conf: null }];
  // The owner's rule (2026-10-08): hide the split until the history is clean. Clean = every day used (observed and baseline) has its
  // pool kWh, and "unexplained" is at most half the change or 3 kWh. Until then the card shows the totals and one line, no parts
  // (a September baseline still carries the old overnight pump program as "always-on", which would read as a −50 kWh always-on part).
  const clean = covered(x => x.pool) && !(Math.abs(uT) > 30 && Math.abs(uT) * 2 > Math.abs(dT));
  if (!clean) notes.add('not-clean');   // changedFor empties the parts before they leave the server
  if (guest) {   // weather, pool and "everything else": AC, always-on and what the models can't place, folded together
    const keep = parts.filter(p => p.id === 'weather' || p.id === 'pool');
    parts = [...keep, { id: 'other', kwh: (dT - keep.reduce((a, p) => a + tenths(p.kwh), 0)) / 10, conf: null }];
  }

  // bought: Δbought = Δused − ΔS, S = used − bought; the solar part is −ΔS
  const dImp = sumO(x => x.imp)! - baseB(x => x.imp)!, iT = tenths(dImp);
  const hi = sumO(x => x.high), bhi = mean(B, x => x.high, true);
  return {
    scope, date, to, baseline: { kind, days: B.length },
    wx: hi != null && bhi != null ? { high: r1(hi / O.length), baseHigh: r1(bhi) } : null,
    home: { obs: r1(sumO(x => x.home)!), base: r1(baseB(x => x.home)!), delta: dT / 10, parts },
    import: { obs: r1(sumO(x => x.imp)!), base: r1(baseB(x => x.imp)!), delta: iT / 10,
      parts: [{ id: 'home', kwh: dT / 10, conf: null }, { id: 'solar', kwh: (iT - dT) / 10, conf: 'measured' }],
      solar: { obs: r1(sumO(x => x.solar)!), base: r1(baseB(x => x.solar)!) } },
    clean,
    notes: guest ? [] : [...notes],
  };
}

/* ---------- the database side ---------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRICS = ['pool.kwh', 'ac.kwh', 'ac.heat_min', 'home.alwaysOn_kw', 'wx.high_f', 'wx.low_f'];
/**
 * GET /api/changed?scope=day|week&date=: the day (default yesterday) or the Monday–Sunday week holding `date` (default last week).
 * Three queries (energy by day, the nightly metrics, the kv state) plus the trip days (owner) and the learned AC draw.
 */
export async function changedFor(siteId: string, scope: string, date: string | undefined, o: { guest?: boolean; now?: number } = {}): Promise<Changed> {
  if (scope !== 'day' && scope !== 'week') throw new ChangedInputError('scope must be day or week');
  if (date != null && (!DAY_RE.test(date) || Number.isNaN(utc(date)))) throw new ChangedInputError('date must be YYYY-MM-DD');
  const now = o.now ?? Date.now(), today = localDay(new Date(now)), guest = !!o.guest;
  const d0 = scope === 'day' ? date ?? addDays(today, -1) : mondayOf(date ?? addDays(today, -7));
  const end = scope === 'day' ? d0 : addDays(d0, 6), from = addDays(scope === 'day' ? d0 : addDays(d0, -7), -(PREV_SEARCH + 7));
  if (end >= today) return { scope, date: d0, to: end, baseline: null, wx: null, home: null, import: null, clean: false, notes: ['incomplete'] };
  const [energy, metrics, state] = await Promise.all([
    q<{ day: string; home: number; imp: number; solar: number; buckets: number }>(`SELECT day, (COALESCE(SUM(home_wh), 0) / 1000.0)::float8 home, (COALESCE(SUM(import_wh), 0) / 1000.0)::float8 imp,
       (COALESCE(SUM(solar_wh), 0) / 1000.0)::float8 solar, COUNT(*)::int buckets FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day`, [siteId, from, end]),
    q<{ day: string; metric: string; value: number }>(`SELECT day, metric, value::float8 value FROM daily_metrics WHERE site_id = $1 AND day BETWEEN $2 AND $3 AND metric = ANY($4::text[])`, [siteId, from, end, METRICS]),
    q<{ key: string; value: any }>(`SELECT key, value FROM kv WHERE key = ANY($1::text[])`, [[homeSlopesKey(siteId), `${siteId}:pool:clearup`]]),
  ]);
  const kvs = Object.fromEntries(state.map(r => [r.key, r.value]));
  const [trips, learned] = await Promise.all([guest ? new Set<string>() : tripDays(siteId, from, end, now), learnAcKw(siteId)]);
  const clearUp = clearUpDays(kvs[`${siteId}:pool:clearup`], now), m = new Map<string, Record<string, number>>();
  for (const r of metrics) (m.get(r.day) ?? m.set(r.day, {}).get(r.day)!)[r.metric] = Number(r.value);
  const days = new Map<string, Day>();
  for (const e of energy) {
    const hours = dayHours(e.day), x = m.get(e.day) ?? {};
    const v = (k: string) => Number.isFinite(x[k]) ? x[k] : null;
    days.set(e.day, { day: e.day, home: e.home, imp: e.imp, solar: e.solar, complete: e.buckets >= COMPLETE * hours * 12, hours,
      pool: v('pool.kwh'), ac: v('ac.kwh'), heatMin: v('ac.heat_min'), alwaysOnKw: v('home.alwaysOn_kw'), high: v('wx.high_f'), low: v('wx.low_f'),
      trip: trips.has(e.day), clearUp: clearUp.has(e.day) });
  }
  const slopes = kvs[homeSlopesKey(siteId)] as HomeSlopes | undefined;
  const res = attribute({ scope, date: d0, days, weather: weatherModel(slopes, days, d0, guest), heatKw: learned.heatKw ?? null, acConf: acKwConf(learned), guest });
  // the owner's rule (2026-10-08): the Used split never leaves the server until the history is clean; the totals still do
  if (!res.clean && res.home) res.home = { ...res.home, parts: [] };
  return res;
}
