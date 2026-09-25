// History → "Where every kWh went" (mockups/m-flows.html; docs/audit-designs/visualizations.md §5). The stored 5-minute buckets of one
// local day, or of the 30 days ending on a date, split into seven paths from where energy came from (solar, PEC, the Powerwalls
// discharging) to where it went (the home, the Powerwalls charging, export to PEC). One aggregate statement over `energy` per request;
// the home is then split into pool, AC and the rest by the appliance models. Database only: never ScreenLogic, Nest, Tesla or Open-Meteo.
import { one, kv } from './db.js';
import { localDay, addDays, localMidnight } from './tesla/client.js';
import { currentTariff, usd } from './tariff.js';
import { poolKwhBetween, quarterOf, type DaySpan } from './appliances/pool.js';
import { acKwhBetween } from './appliances/ac.js';

/** A bad `range` or `date`: the route answers 400 with the message. */
export class FlowsInputError extends Error {}

/** The seven paths: id, source → sink, and the `energy` column holding Tesla's own per-path Wh. */
export const FLOW_PATHS = [
  { id: 'solarHome', from: 'solar', to: 'home', col: 'solar_home_wh' },
  { id: 'solarBatt', from: 'solar', to: 'battery', col: 'solar_battery_wh' },
  { id: 'solarGrid', from: 'solar', to: 'grid', col: 'solar_grid_wh' },
  { id: 'gridHome', from: 'grid', to: 'home', col: 'grid_home_wh' },
  { id: 'gridBatt', from: 'grid', to: 'battery', col: 'grid_battery_wh' },
  { id: 'battHome', from: 'battery', to: 'home', col: 'battery_home_wh' },
  { id: 'battGrid', from: 'battery', to: 'grid', col: 'battery_grid_wh' },
] as const;
export type FlowId = typeof FLOW_PATHS[number]['id'];

/**
 * One statement per request. $1 site, $2 first local day, $3 last (inclusive; `day` is the Chicago day, so a DST day brings its 276 or
 * 300 buckets). `split` counts the buckets that carry all seven of Tesla's per-path columns and m_* sums those columns. e_* is the design's
 * estimate from the four totals (solar, home, charge, discharge), bucket by bucket, then summed: solar serves the home first, then charges
 * the Powerwalls, then exports; the Powerwalls serve what solar did not; PEC covers the rest of the home; any other charge came from PEC
 * and any other discharge went to PEC. Wh, float8, COALESCE(col, 0) on every total.
 */
export const FLOWS_SQL = `
  SELECT COUNT(*)::int AS buckets, (COUNT(*) FILTER (WHERE split))::int AS split, COUNT(DISTINCT day)::int AS days,
    SUM(s) AS solar, SUM(h) AS home, SUM(i) AS import, SUM(x) AS export, SUM(c) AS charge, SUM(d) AS discharge,
    ${FLOW_PATHS.map(p => `SUM(${p.col}) AS m_${p.id}`).join(', ')},
    SUM(LEAST(s, h)) AS e_solarHome,
    SUM(LEAST(GREATEST(s - LEAST(s, h), 0), c)) AS e_solarBatt,
    SUM(GREATEST(s - LEAST(s, h) - LEAST(GREATEST(s - LEAST(s, h), 0), c), 0)) AS e_solarGrid,
    SUM(LEAST(d, GREATEST(h - LEAST(s, h), 0))) AS e_battHome,
    SUM(GREATEST(h - LEAST(s, h) - LEAST(d, GREATEST(h - LEAST(s, h), 0)), 0)) AS e_gridHome,
    SUM(GREATEST(c - LEAST(GREATEST(s - LEAST(s, h), 0), c), 0)) AS e_gridBatt,
    SUM(GREATEST(d - LEAST(d, GREATEST(h - LEAST(s, h), 0)), 0)) AS e_battGrid
  FROM (SELECT day, COALESCE(solar_wh, 0)::float8 AS s, COALESCE(home_wh, 0)::float8 AS h, COALESCE(import_wh, 0)::float8 AS i,
          COALESCE(export_wh, 0)::float8 AS x, COALESCE(charge_wh, 0)::float8 AS c, COALESCE(discharge_wh, 0)::float8 AS d,
          ${FLOW_PATHS.map(p => `${p.col}::float8 AS ${p.col}`).join(', ')},
          (${FLOW_PATHS.map(p => `${p.col} IS NOT NULL`).join(' AND ')}) AS split
        FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3) b`;

/** The local days from..to with their real lengths (23, 24 or 25 h) and how much of each has elapsed at `now`. */
export function daySpans(from: string, to: string, now = Date.now()): DaySpan[] {
  const out: DaySpan[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const start = localMidnight(d).getTime(), end = localMidnight(addDays(d, 1)).getTime();
    out.push({ day: d, lengthMs: end - start, elapsedMs: Math.max(0, Math.min(now, end) - start), quarters: now >= end ? 96 : now <= start ? 0 : quarterOf(now) });
  }
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kwh = (wh: number | null | undefined) => Math.round((wh ?? 0) / 10) / 100; // Wh → kWh, 2 decimals

/**
 * GET /api/flows?range=day|month&date=YYYY-MM-DD. `day`: that local day (default today). `month`: the 30 days ending on `date`
 * (default today), as the History Month bars show. The ribbons are `measured` (Tesla's own per-path split) when every bucket in the range
 * carries all seven per-path columns, `estimated` from the totals otherwise, `none` when nothing is stored. `unaccounted` is what Tesla's
 * home and export totals hold beyond the ribbons into them (shown on the card, not hidden).
 */
export async function flowsFor(siteId: string, range: string, date: string | undefined, settings: Record<string, any>, now = Date.now()) {
  if (range !== 'day' && range !== 'month') throw new FlowsInputError('range must be day or month');
  const to = date ?? localDay(new Date(now));
  if (!DAY.test(to) || Number.isNaN(Date.parse(`${to}T12:00:00Z`)) || addDays(to, 0) !== to) throw new FlowsInputError('date must be YYYY-MM-DD');
  const from = range === 'day' ? to : addDays(to, -29), spans = daySpans(from, to, now);

  const r = (await one(FLOWS_SQL, [siteId, from, to]))!;
  const method = !r.buckets ? 'none' as const : r.split === r.buckets ? 'measured' as const : 'estimated' as const;
  // unquoted aliases come back lower-cased (m_solarhome, e_solarhome)
  const wh = Object.fromEntries(FLOW_PATHS.map(p => [p.id, Number(r[`${method === 'measured' ? 'm' : 'e'}_${p.id.toLowerCase()}`] ?? 0)])) as Record<FlowId, number>;
  const ribbons = FLOW_PATHS.map(p => ({ id: p.id, from: p.from, to: p.to, kwh: kwh(wh[p.id]), estimated: method === 'estimated' }));
  const homeWh = wh.solarHome + wh.battHome + wh.gridHome;
  const residual = { home: kwh(Number(r.home ?? 0) - homeWh), export: kwh(Number(r.export ?? 0) - wh.solarGrid - wh.battGrid) };

  const slope = (await kv.get<{ slope: number }>(`${siteId}:ac:slope`))?.slope ?? 2.5; // the heat model the AC card uses (cached by acSlope)
  const [pool, ac, tariff] = await Promise.all([poolKwhBetween(siteId, spans, settings), acKwhBetween(siteId, spans, slope), currentTariff(siteId)]);
  const totals = { solar: kwh(r.solar), home: kwh(r.home), import: kwh(r.import), export: kwh(r.export), charge: kwh(r.charge), discharge: kwh(r.discharge) };
  const rate = tariff ? { importRateAllIn: tariff.importRateAllIn, exportCredit: tariff.exportCredit ?? null } : null; // learned from bills; null = unknown
  return {
    range, from, to, days: spans.length, dataDays: r.days as number, buckets: r.buckets as number, splitBuckets: r.split as number, method,
    ribbons, totals, residual, unaccounted: Math.round((residual.home + residual.export) * 100) / 100,
    home: { kwh: kwh(homeWh), pool, ac, rest: Math.max(0, Math.round((kwh(homeWh) - pool.kwh - ac.kwh) * 100) / 100) },
    rate, money: { importUsd: usd(totals.import, rate?.importRateAllIn, true), exportCreditUsd: rate?.exportCredit != null ? usd(totals.export, rate.exportCredit, true) : null },
  };
}
export type Flows = Awaited<ReturnType<typeof flowsFor>>;
