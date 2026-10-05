// Powerwall capacity measured from the site's own discharges (mockup af). Each stretch of 2 h or more in which the Powerwalls only
// discharge and their charge falls 25 points or more gives one measurement: kWh delivered ÷ charge used × 100, the kWh a full charge
// delivers. The figure the estimates use pools the last 90 days (kWh ÷ charge used) once there are 5 measurements; until then nameplate × 95%.
// Recomputed nightly (app.ts, after the sync) into kv `<site>:battery:capacity`; reads only the energy and soe tables.
import { q, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';

export const EFF = .95;                                  // the battery model's one-way efficiency (outage.ts, forecast48, /api/whatif)
export const MIN_HOURS = 2, MIN_DROP = 25, WINDOW_DAYS = 90, MIN_COUNT = 5, FADE_PCT = 5, LOOK_DAYS = 400;
const BUCKET_MS = 300_000, ON_WH = 50 / 12;              // a 5-minute bucket discharging at 0.05 kW or more
const r1 = (v: number) => Math.round(v * 10) / 10;
/** kWh a full charge delivers across several measurements: all the energy over all the charge used, so long discharges (less SoC rounding) weigh more. */
const pooled = (xs: Measurement[]) => xs.reduce((a, m) => a + m.kwh, 0) / xs.reduce((a, m) => a + m.drop, 0) * 100;

export type Bucket = { epoch: number; charge: number; discharge: number };
export type SoePoint = { epoch: number; soe: number };
export type Measurement = { at: number; day: string; hours: number; kwh: number; drop: number; fullKwh: number };

/** The charge at `t` by linear interpolation, or null more than 30 minutes from any reading. */
function soeAt(pts: SoePoint[], t: number) {
  let lo = 0, hi = pts.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].epoch <= t) lo = m; else hi = m - 1; }
  const a = pts[lo], b = pts[lo + 1];
  if (a.epoch > t) return a.epoch - t <= 1800e3 ? a.soe : null;                          // before the first reading
  if (!b) return t - a.epoch <= 1800e3 ? a.soe : null;
  if (b.epoch - a.epoch > 3600e3) return t - a.epoch <= 1800e3 ? a.soe : b.epoch - t <= 1800e3 ? b.soe : null;
  return a.soe + (b.soe - a.soe) * (t - a.epoch) / (b.epoch - a.epoch);
}

/** Every discharge of 2 h or more that lowers the charge 25 points or more. `buckets` sorted by epoch; only discharging, non-charging ones count. */
export function measurements(buckets: Bucket[], soe: SoePoint[]): Measurement[] {
  const out: Measurement[] = [], on = buckets.filter(b => b.discharge >= ON_WH && b.charge < ON_WH);
  let i = 0;
  while (i < on.length) {
    let j = i; while (j + 1 < on.length && on[j + 1].epoch - on[j].epoch === BUCKET_MS) j++;
    const start = on[i].epoch, end = on[j].epoch + BUCKET_MS, hours = (end - start) / 3600e3;
    if (hours >= MIN_HOURS) {
      const s0 = soeAt(soe, start), s1 = soeAt(soe, end), kwh = on.slice(i, j + 1).reduce((a, b) => a + b.discharge, 0) / 1000;
      if (s0 != null && s1 != null && s0 - s1 >= MIN_DROP)
        out.push({ at: start, day: localDay(new Date(start)), hours: r1(hours), kwh: r1(kwh), drop: r1(s0 - s1), fullKwh: Math.round(kwh / (s0 - s1) * 1000) / 10 });
    }
    i = j + 1;
  }
  return out;
}

export type Capacity = {
  measuredKwh: number | null; nameplateKwh: number; count: number; countAll: number; since: string | null;
  months: Array<{ month: string; kwh: number; n: number }>; range: [number, number] | null; fade: { month: string; pct: number } | null; at: number;
};
/** The card and the estimates: the last 90 days pooled (5 or more measurements), each month pooled, and a fade note. */
export function summarize(ms: Measurement[], nameplateKwh: number, now = Date.now()): Capacity {
  const since90 = addDays(localDay(new Date(now)), -WINDOW_DAYS), recent = ms.filter(m => m.day >= since90);
  const byMonth = new Map<string, Measurement[]>();
  for (const m of ms) { const k = m.day.slice(0, 7); byMonth.set(k, [...byMonth.get(k) ?? [], m]); }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([month, v]) => ({ month, kwh: r1(pooled(v)), n: v.length }));
  const year = ms.length ? pooled(ms) : null, last = months.at(-1);
  const pct = year && last && last.n >= 3 ? (year - last.kwh) / year * 100 : 0;
  return {
    measuredKwh: recent.length >= MIN_COUNT ? r1(pooled(recent)) : null, nameplateKwh, count: recent.length, countAll: ms.length,
    since: ms.length ? ms.reduce((a, m) => m.day < a ? m.day : a, ms[0].day) : null, months,
    range: months.length ? [Math.min(...months.map(m => m.kwh)), Math.max(...months.map(m => m.kwh))] : null,
    fade: pct >= FADE_PCT ? { month: last!.month, pct: Math.round(pct) } : null, at: now,
  };
}

const key = (siteId: string) => `${siteId}:battery:capacity`;
/** Nightly: measure the last 400 days and store the summary. */
export async function refreshCapacity(siteId: string, now = Date.now()) {
  const from = now - LOOK_DAYS * 864e5;
  const [buckets, soe, site] = await Promise.all([
    q<Bucket>(`SELECT epoch::float8 epoch, COALESCE(charge_wh, 0)::float8 charge, discharge_wh::float8 discharge FROM energy
      WHERE site_id = $1 AND epoch >= $2 AND discharge_wh >= $3 ORDER BY epoch`, [siteId, from, ON_WH]),
    q<SoePoint>(`SELECT epoch::float8 epoch, soe::float8 soe FROM soe WHERE site_id = $1 AND epoch >= $2 ORDER BY epoch`, [siteId, from]),
    q<{ info: any }>(`SELECT info FROM sites WHERE id = $1`, [siteId]),
  ]);
  const cap = summarize(measurements(buckets, soe), (site[0]?.info?.nameplate_energy ?? 0) / 1000 || 27, now);
  await kv.set(key(siteId), cap);
  return { measuredKwh: cap.measuredKwh, count: cap.count, countAll: cap.countAll };
}
export const capacityOf = (siteId: string) => kv.get<Capacity | null>(key(siteId)).then(c => c ?? null);

/**
 * The capacity the battery models use (they apply 95% on the way out): the measured kWh ÷ 95% once measured, so a full charge
 * delivers exactly the measured figure; nameplate (27 kWh for two Powerwall 2s) until then.
 */
export const modelKwh = (c: Capacity | null, nameplateKwh: number) => c?.measuredKwh ? Math.round(c.measuredKwh / EFF * 100) / 100 : nameplateKwh || 27;
