// The pool water log (approved mockup aj). The controller has no chemistry sensors (no IntelliChem, no salt chlorinator: read on
// 2026-10-05), so tests come from the owner: free chlorine and pH every time; combined chlorine, alkalinity, CYA and calcium hardness
// when tested (drop kit or pool store); how the water looks; what was added. Solstice fills in the water temperature and puts each test
// against the pump's hours. Ranges only color values: Solstice never says what to add. Nothing here writes to the controller.
import { q, one } from '../db.js';
import { localDay, addDays } from '../tesla/client.js';
import { notify } from '../notify.js';
import { PUMP_RUNNING_SQL } from './pool.js';

export const CLARITY = ['clear', 'hazy', 'cloudy', 'green'] as const;
export const ADDED = ['liquid', 'tablets', 'shock', 'acid', 'other'] as const;
export const SOURCES = ['kit', 'store'] as const;
export type PoolTest = { id: number; at: number; day: string; fc: number; ph: number; cc: number | null; ta: number | null; cya: number | null; ch: number | null;
  clarity: typeof CLARITY[number]; added: Array<typeof ADDED[number]>; source: typeof SOURCES[number]; waterF: number | null };
/** Common residential ranges (they only color the card). Free chlorine's low end rises with stabilizer: at least ~7.5% of CYA. */
export const RANGES = { fc: [1, 4], ph: [7.2, 7.8], cc: [0, .5], ta: [80, 120], cya: [30, 50], ch: [200, 400] } as const;
export const fcMin = (cya: number | null) => Math.max(RANGES.fc[0], cya != null ? Math.round(cya * .075 * 2) / 2 : 0);
const LIMITS = { fc: [0, 20, .5], ph: [6.4, 8.6, .1], cc: [0, 5, .5], ta: [0, 300, 10], cya: [0, 200, 10], ch: [0, 1000, 25] } as const;
export const REMIND_WARM_F = 80, REMIND_WARM_DAYS = 4, REMIND_COOL_DAYS = 7, FINDINGS_MIN_TESTS = 6, FINDINGS_MIN_DAYS = 14;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Why a POST body is unusable, or null: fc and ph required, the rest optional, each a number on its step inside its limits. */
export function testError(b: Record<string, unknown>): string | null {
  for (const k of ['fc', 'ph'] as const) if (typeof b[k] !== 'number') return `${k === 'fc' ? 'free chlorine' : 'pH'} is required`;
  for (const [k, [lo, hi, step]] of Object.entries(LIMITS)) {
    const v = b[k]; if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || Math.abs(Math.round(v / step) * step - v) > 1e-6) return `${k} must be ${lo}–${hi} in steps of ${step}`;
  }
  if (!CLARITY.includes(b.clarity as any)) return 'clarity must be clear, hazy, cloudy or green';
  if (b.added != null && (!Array.isArray(b.added) || b.added.some(a => !ADDED.includes(a as any)))) return 'added must be a list of liquid, tablets, shock, acid, other';
  if (b.source != null && !SOURCES.includes(b.source as any)) return 'source must be kit or store';
  return null;
}

/** Each value against its range: 'ok', 'lo' or 'hi' (fc's low end from the CYA of the same test, or the latest one that has it). */
export function status(t: Pick<PoolTest, 'fc' | 'ph' | 'cc' | 'ta' | 'cya' | 'ch'>, cya: number | null) {
  const s = (v: number | null, [lo, hi]: readonly [number, number]) => v == null ? null : v < lo ? 'lo' : v > hi ? 'hi' : 'ok';
  return { fc: s(t.fc, [fcMin(cya), Math.max(RANGES.fc[1], fcMin(cya) + 3)]), ph: s(t.ph, RANGES.ph), cc: s(t.cc, RANGES.cc), ta: s(t.ta, RANGES.ta), cya: s(t.cya, RANGES.cya), ch: s(t.ch, RANGES.ch) };
}

/**
 * The two findings, once there are 6 tests over 14 days (else null):
 *   use    free chlorine lost per day between consecutive tests where it fell and nothing but tablets was added at the earlier one (median)
 *   hazy   the pump's average hours a day in the 7 days before hazy/cloudy/green tests, against before clear ones (needs one of each)
 */
export function findings(tests: PoolTest[], pumpHours: Record<string, number>) {
  const t = [...tests].sort((a, b) => a.at - b.at);
  if (t.length < FINDINGS_MIN_TESTS || (t.at(-1)!.at - t[0].at) / 864e5 < FINDINGS_MIN_DAYS) return null;
  const drops = t.slice(1).map((b, i) => { const a = t[i], days = (b.at - a.at) / 864e5;
    return a.added.some(x => x !== 'tablets') || days < .5 || b.fc >= a.fc ? null : { perDay: (a.fc - b.fc) / days, temps: [a.waterF, b.waterF] }; }).filter(x => x != null);
  const med = (xs: number[]) => { const v = [...xs].sort((x, y) => x - y), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const temps = drops.flatMap(d => d!.temps).filter((v): v is number => v != null);
  const before = (x: PoolTest) => { const hs = Array.from({ length: 7 }, (_, i) => pumpHours[addDays(x.day, -1 - i)]).filter((v): v is number => v != null); return hs.length >= 4 ? hs.reduce((a, v) => a + v, 0) / hs.length : null; };
  const hz = t.filter(x => x.clarity !== 'clear').map(before).filter((v): v is number => v != null), cl = t.filter(x => x.clarity === 'clear').map(before).filter((v): v is number => v != null);
  return {
    use: drops.length >= 2 ? { ppmPerDay: r1(med(drops.map(d => d!.perDay))), n: drops.length, waterF: temps.length ? [Math.round(Math.min(...temps)), Math.round(Math.max(...temps))] : null } : null,
    hazy: hz.length && cl.length ? { hazyHours: r1(hz.reduce((a, v) => a + v, 0) / hz.length), clearHours: r1(cl.reduce((a, v) => a + v, 0) / cl.length), hazyTests: hz.length } : null,
  };
}

/** Days until the reminder is due after a test: 4 in warm water (80°F+), 7 otherwise. */
export const remindAfterDays = (waterF: number | null) => waterF != null && waterF >= REMIND_WARM_F ? REMIND_WARM_DAYS : REMIND_COOL_DAYS;

/* ---------- storage and the app ---------- */
const row = (r: any): PoolTest => ({ id: r.id, at: Number(r.at), day: r.day, fc: r.fc, ph: r.ph, cc: r.cc, ta: r.ta, cya: r.cya, ch: r.ch, clarity: r.clarity, added: r.added ?? [], source: r.source, waterF: r.water_f });
/** The latest water temperature the controller reported (pool_readings), °F. */
const waterNow = async (siteId: string) => (await one<{ t: number | null }>(`SELECT water_temp::float8 t FROM pool_readings WHERE site_id = $1 AND water_temp IS NOT NULL ORDER BY ts DESC LIMIT 1`, [siteId]))?.t ?? null;
/** Hours the pump ran on each day: the quarter-hours whose read found it running (reads are every 15 min in pump hours, hourly outside, so outside runs count low). */
async function pumpHoursSince(siteId: string, from: string): Promise<Record<string, number>> {
  const rows = await q<{ day: string; h: number }>(`SELECT day, (COUNT(DISTINCT (hour * 4 + (((ts / 60000) % 60) / 15))) FILTER (WHERE ${PUMP_RUNNING_SQL}) / 4.0)::float8 h FROM pool_readings WHERE site_id = $1 AND day >= $2 GROUP BY day`, [siteId, from]);
  return Object.fromEntries(rows.map(r => [r.day, r1(r.h)]));
}
export async function addTest(siteId: string, b: Record<string, any>, now = Date.now()) {
  const waterF = await waterNow(siteId);
  const r = await one(`INSERT INTO pool_tests (site_id, at, day, fc, ph, cc, ta, cya, ch, clarity, added, source, water_f) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [siteId, now, localDay(new Date(now)), b.fc, b.ph, b.cc ?? null, b.ta ?? null, b.cya ?? null, b.ch ?? null, b.clarity, JSON.stringify(b.added ?? []), b.source ?? 'kit', waterF]);
  return row(r);
}
export const deleteTest = (siteId: string, id: number) => q(`DELETE FROM pool_tests WHERE site_id = $1 AND id = $2`, [siteId, id]);
/** The card and the history: the last 60 days of tests, the last test's status, the findings, the pump's hours and when a test is due. */
export async function poolWater(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), from = addDays(today, -60);
  const [rows, hours, waterF] = await Promise.all([
    q(`SELECT * FROM pool_tests WHERE site_id = $1 AND day >= $2 ORDER BY at DESC`, [siteId, from]), pumpHoursSince(siteId, addDays(today, -37)), waterNow(siteId)]);
  const tests = rows.map(row), last = tests[0] ?? null, cya = tests.find(t => t.cya != null)?.cya ?? null;
  const dueDays = remindAfterDays(waterF), due = last ? last.at + dueDays * 864e5 : null;
  return { tests, last, status: last ? status(last, cya) : null, cya, fcMin: fcMin(cya), ranges: RANGES, waterF, pumpHours: hours,
    findings: findings(tests, hours), due, dueDays, overdue: due != null && now > due };
}

/** Nightly (watch.ts): one push when the last test is older than 4 days in warm water, 7 otherwise; none before the first test. */
export async function poolTestReminder(siteId: string, now = Date.now()) {
  const w = await poolWater(siteId, now);
  if (!w.last) return { skipped: 'no test yet' };
  if (!w.overdue) return { due: w.due };
  const days = Math.floor((now - w.last.at) / 864e5), hrs = Object.entries(w.pumpHours).filter(([d]) => d > w.last!.day).map(([, h]) => h);
  const r = await notify(siteId, 'poolTest', 'Time to test the pool',
    `Last test ${days} days ago.${w.waterF != null ? ` Water is ${Math.round(w.waterF)}°` : ''}${hrs.length ? ` and the pump ran ${Math.round(hrs.reduce((a, v) => a + v, 0) / hrs.length)} h a day since` : ''}.`,
    { lastTest: w.last.day }, { key: `poolTest:${w.last.id}`, windowH: 24 * 60, now, url: '/?go=v-sys&p=pool' });   // once per test: the next test clears it
  return { pushed: r.pushed, skipped: r.skipped ?? null };
}
