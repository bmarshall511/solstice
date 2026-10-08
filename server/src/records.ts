// History › Records (GET /api/records): the best solar day, the biggest usage day, the lowest import day, lifetime totals, the days
// the batteries reached 99%, and the outages. Batch 7: with history back to the install date (I-16, ~650k energy rows), the route
// used to aggregate the whole energy and soe tables every 5 minutes while the app was open. Now the days up to yesterday are
// aggregated once, in the nightly chain after the sync, into kv `<site>:records`; the route adds the days after that (today, and any
// day a missed night left out) through the (site_id, day) index and answers exactly what the full aggregation would.
// The cached part is checked against a fingerprint of the synced-day marks up to its last day (how many, and their bucket counts), so
// a day the deep back-fill stores after the nightly ran, or a short day the coverage check re-fetched, recomputes it on the next read.
import { one, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';

type DayRecord = { date: string; kwh: number | null } | null;
const COLS = ['solar', 'home', 'import', 'export', 'charge', 'discharge'] as const;
type Col = typeof COLS[number];
type Sums = Record<Col, number | null>;
type Mark = { n: number; b: number };
/** The cached days, from the first through `through` (Chicago days). `wh` keeps raw float8 sums, rounded only when served. */
export type RecordsCache = { v: 1; through: string; at: number; mark: Mark; best: DayRecord; big: DayRecord; low: DayRecord; since: string | null; wh: Sums; full: number; soeDays: number };
export const recordsKey = (siteId: string) => `${siteId}:records`;

/** A day's kWh as the old route computed it, per day (to 0.1 kWh). */
const DAY = (col: string) => `ROUND((SUM(${col}) / 1000.0)::numeric, 1)::float8`;
/** A lifetime total (to 0.01 kWh): the cached sum (param) plus these days' sum; null when neither has a value, as SUM over no rows. */
const TOTAL = (c: Col, p: number) => `ROUND(((CASE WHEN $${p}::float8 IS NULL AND SUM(${c}) IS NULL THEN NULL ELSE COALESCE($${p}::float8, 0) + COALESCE(SUM(${c}), 0) END) / 1000.0)::numeric, 2)::float8 t_${c}`;

/**
 * One pass over the energy days `cmp` `through` (`<=` the cached part, `>` the live part): each record day, the first day, the raw
 * sums, and the totals with `wh` (the cached sums) added. Ties go to the earlier day, like ORDER BY kwh DESC, day.
 */
async function energyPart(siteId: string, cmp: '<=' | '>', through: string, wh: Partial<Sums> = {}) {
  type Row = { best: DayRecord; big: DayRecord; low: DayRecord; since: string | null } & Sums & Record<`t_${Col}`, number | null>;
  const r = await one<Row>(`WITH d AS (SELECT day, ${DAY('solar_wh')} s, ${DAY('home_wh')} h, ${DAY('import_wh')} i,
      ${COLS.map(c => `SUM(${c}_wh::float8) ${c}`).join(', ')}
      FROM energy WHERE site_id = $1 AND day ${cmp} $2 GROUP BY day)
    SELECT (SELECT json_build_object('date', day, 'kwh', s) FROM d ORDER BY s DESC, day LIMIT 1) best,
      (SELECT json_build_object('date', day, 'kwh', h) FROM d ORDER BY h DESC, day LIMIT 1) big,
      (SELECT json_build_object('date', day, 'kwh', i) FROM d ORDER BY i ASC, day LIMIT 1) low,
      MIN(day) since, ${COLS.map(c => `SUM(${c})::float8 ${c}`).join(', ')}, ${COLS.map((c, k) => TOTAL(c, 3 + k)).join(', ')}
    FROM d`, [siteId, through, ...COLS.map(c => wh[c] ?? null)]);
  return r!;
}
/** The synced-day fingerprint up to `through`, the soe days `cmp` `through` (99% or more, and all), and the outages (a small table). */
async function extras(siteId: string, cmp: '<=' | '>', through: string) {
  return (await one<{ mark: Mark; full_days: number; days: number; longest: { ts: string; duration_s: number } | null; outages: number }>(`SELECT
      (SELECT json_build_object('n', COUNT(*), 'b', COALESCE(SUM(buckets), 0)) FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day <= $2) mark,
      x.full_days, x.days,
      (SELECT json_build_object('ts', ts, 'duration_s', duration_s) FROM backup_events WHERE site_id = $1 ORDER BY duration_s DESC LIMIT 1) longest,
      (SELECT COUNT(*)::int FROM backup_events WHERE site_id = $1) outages
    FROM (SELECT (COUNT(*) FILTER (WHERE mx >= 99))::int full_days, COUNT(*)::int days FROM (SELECT MAX(soe) mx FROM soe WHERE site_id = $1 AND day ${cmp} $2 GROUP BY day) s) x`,
    [siteId, through]))!;
}
const sameMark = (a: Mark | undefined, b: Mark) => !!a && Number(a.n) === Number(b.n) && Number(a.b) === Number(b.b);

/** Aggregate every day through `through` (default yesterday) into kv. The nightly chain's step, after the sync; the route's fallback. */
export async function refreshRecords(siteId: string, now = Date.now(), through = addDays(localDay(new Date(now)), -1)): Promise<RecordsCache> {
  const x = await extras(siteId, '<=', through);   // the fingerprint first: a day marked while this runs makes the next read recompute
  const e = await energyPart(siteId, '<=', through);
  const c: RecordsCache = { v: 1, through, at: now, mark: { n: Number(x.mark.n), b: Number(x.mark.b) }, best: e.best, big: e.big, low: e.low, since: e.since,
    wh: Object.fromEntries(COLS.map(k => [k, e[k]])) as Sums, full: x.full_days, soeDays: x.days };
  await kv.set(recordsKey(siteId), c);
  return c;
}

/** The higher (`desc`) or lower record of the cached days `a` and the later days `b`: ties keep `a` (the earlier day); a null kWh sorts as Postgres does (first when descending, last ascending). */
function pick(a: DayRecord, b: DayRecord, desc: boolean): DayRecord {
  if (!a) return b; if (!b) return a;
  if (desc) return a.kwh == null ? a : b.kwh == null ? b : b.kwh > a.kwh ? b : a;
  return b.kwh == null ? a : a.kwh == null ? b : b.kwh < a.kwh ? b : a;
}

/** GET /api/records: the cached days plus the days after them. Three queries when the cache holds (kv, one energy pass, one for the rest). */
export async function recordsFor(siteId: string, now = Date.now()) {
  let c = await kv.get<RecordsCache>(recordsKey(siteId)), x: Awaited<ReturnType<typeof extras>> | null = null;
  if (c?.v === 1 && c.through < localDay(new Date(now))) {
    x = await extras(siteId, '>', c.through);
    if (!sameMark(c.mark, x.mark)) c = undefined;   // a day stored or re-fetched at or before the cached last day since it was computed
  } else c = undefined;
  if (!c) { c = await refreshRecords(siteId, now); x = await extras(siteId, '>', c.through); }
  const e = await energyPart(siteId, '>', c.through, c.wh);
  const since = [c.since, e.since].filter((d): d is string => d != null).sort()[0] ?? null;
  const totals = { since, ...Object.fromEntries(COLS.map(k => [k, e[`t_${k}`]])) };
  const opt = (r: DayRecord) => r ?? undefined;   // no day at all: left out, as the old one() row was
  return { bestSolarDay: opt(pick(c.best, e.best, true)), biggestUsageDay: opt(pick(c.big, e.big, true)), lowestImportDay: opt(pick(c.low, e.low, false)), totals,
    batteryFullDays: { days: c.full + x!.full_days, of: c.soeDays + x!.days }, longestOutage: x!.longest ?? null, outages: x!.outages ?? 0 };
}
