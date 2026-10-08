// Strip-heat watch (I-15, approved mockup am frames 6 and 7): the database side of stripheat.ts. Read-only towards every device: the
// thermostat is only read from what the app already stored (nest_readings), Tesla's energy from `energy`. Advice only: nothing here
// writes to Nest or changes an Autopilot mode.
//   GET /api/appliances/ac/strip   the Systems › AC Strip heat card: today's morning so far, the week, the detected heating type.
//                                  Owner only: it has no guest view in redact.ts GUEST_GET, so a guest gets 401.
//   nightly (learn/nightly.ts)     the last 3 complete days into daily_metrics (strip.kwh, strip.min, hp.min, strip.peak_kw, strip.cause,
//                                  strip.conf, strip.setback_f) while it is winter or heating was seen; the learned levels into kv
//                                  `<site>:strip:levels`; once, last winter's energy-only days (the back-test) from the Open-Meteo
//                                  archive's hourly temperatures (kv `wx:hourly:winter`, dates and temperatures only).
//   10:00 Chicago (5-minute cron)  one `strip` alert for a heavy morning: pushed when a setback caused it, feed only when the cold did.
//                                  Every other tick returns before touching the database.
import { q, kv } from './db.js';
import { localDay, addDays, localAt, rfc3339 } from './tesla/client.js';
import { siteLocation } from './site.js';
import { learnAcKw } from './appliances/ac.js';
import { pumpRunning } from './appliances/pool.js';
import { baseOf } from './breakdown.js';
import { notify } from './notify.js';
import { homeSlopesKey, type HomeSlopes } from './learn/homeModel.js';
import { WX_KEY, type Wx } from './learn/wx.js';
import { chicago } from './appliances/sampling.js';
import {
  classifyDay, levelsFor, capOf, heatingMask, alertFor, stripMetrics, weekSummary, whyText, tipText, heatingLabel, winterDay, backtest,
  DEFAULT_BALANCE_F, ALERT_MINUTE, CARRY_MS, type Bucket, type NestRow, type Levels, type DayStrip,
} from './stripheat.js';

export const WINTER_HOURLY_KEY = 'wx:hourly:winter';
export const levelsKey = (siteId: string) => `${siteId}:strip:levels`;
export const backtestKey = (siteId: string) => `${siteId}:strip:backtest`;
export const alertedKey = (siteId: string) => `${siteId}:strip:alerted`;
/** The base when no night has one yet (kW). */
const BASE_FALLBACK_KW = .6;
type WinterHourly = { season: string; byHour: Record<string, number> };
type StoredLevels = Levels & { at: number; day: string };

/* ---------- weather ---------- */
/** The last complete winter, Nov 1 – Mar 31, before `today`: from April on, the one just gone; in Jan–Mar, the one before. */
export function lastWinter(today: string) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7), end = m >= 4 ? y : y - 1;
  return { season: `${end - 1}-${String(end).slice(2)}`, from: `${end - 1}-11-01`, to: `${end}-03-31` };
}
/**
 * Hourly outdoor °F for last winter (Nov 1 – Mar 31) from the Open-Meteo archive, fetched once per winter and kept in kv
 * `wx:hourly:winter` (local hour → °F; no location in the cache). Without a location, or when the pull fails, what is cached (or nothing).
 */
export async function winterHourly(now = Date.now(), fetcher: typeof fetch = fetch): Promise<Record<string, number>> {
  const w = lastWinter(localDay(new Date(now))), c = await kv.get<WinterHourly>(WINTER_HOURLY_KEY);
  if (c?.season === w.season) return c.byHour;
  const loc = siteLocation(); if (!loc) return c?.byHour ?? {};
  try {
    const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${w.from}&end_date=${w.to}` +
      '&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=America%2FChicago';
    const j = await fetcher(u, { signal: AbortSignal.timeout(15_000) }).then(r => { if (!r.ok) throw new Error(`Open-Meteo archive: HTTP ${r.status}`); return r.json(); }) as
      { hourly?: { time?: string[]; temperature_2m?: Array<number | null> } };
    const byHour: Record<string, number> = {};
    (j.hourly?.time ?? []).forEach((t, i) => { const v = j.hourly?.temperature_2m?.[i]; if (typeof v === 'number') byHour[t.slice(0, 13)] = Math.round(v * 10) / 10; });
    if (!Object.keys(byHour).length) throw new Error('Open-Meteo archive returned no hours');
    await kv.set(WINTER_HOURLY_KEY, { season: w.season, byHour } satisfies WinterHourly);
    return byHour;
  } catch (e) { console.warn(`[strip] ${(e as Error).message}`); return c?.byHour ?? {}; }
}
/** The outdoor °F of the Chicago hour holding an epoch, from the learning layer's 31 days (wx:gti) over last winter's archive. */
export function outdoorOf(wx: Pick<Wx, 'hourly'> | null | undefined, winter: Record<string, number> = {}) {
  const byHour: Record<string, number> = { ...winter };
  wx?.hourly?.time?.forEach((t, i) => { const v = wx.hourly.temperature_2m?.[i]; if (typeof v === 'number') byHour[t.slice(0, 13)] = v; });
  return (ms: number) => byHour[rfc3339(new Date(ms)).slice(0, 13)] ?? null;
}
/** The balance point: the home model's heating change point when its year fit has a heating term, else 40 °F. */
/** The strip balance point (°F). The home model's heating change point is fitted against the daily low (55–75°F): it says when the house
 *  starts heating, not when a heat pump needs its strips (25–45°F for most units), so it is only a hint, held inside that range
 *  (overnight QA on the demo read "below the ~63° point where the heat pump needs help"). */
export const BALANCE_RANGE_F = [25, 45] as const;
export const balanceOf = (s: HomeSlopes | null | undefined) =>
  Math.min(BALANCE_RANGE_F[1], Math.max(BALANCE_RANGE_F[0], s && s.c > 0 ? s.th : DEFAULT_BALANCE_F));

/* ---------- rows ---------- */
type Rows = { buckets: Bucket[]; byDay: Map<string, Array<Bucket & { day: string; hour: number }>>; nest: NestRow[]; pool: Array<{ ts: number; kw: number }> };
/** Energy, Nest and pool readings for the local days [from, to] (Nest and pool from two hours before, for the carry and the setback). */
async function rows(siteId: string, from: string, to: string, o: { nest?: boolean } = {}): Promise<Rows> {
  const a = localAt(from, 0) - 2 * 3600_000, b = localAt(addDays(to, 1), 0);
  const [e, n, p] = await Promise.all([
    q<{ epoch: string; day: string; hour: number; kw: number }>(`SELECT epoch::text, day, hour::int, (home_wh * 12 / 1000.0)::float8 kw FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3 AND home_wh IS NOT NULL ORDER BY epoch`, [siteId, from, to]),
    o.nest === false ? Promise.resolve([]) : q<{ ts: string; hvac: string | null; heat_f: number | null }>(`SELECT ts::text, hvac, heat_f FROM nest_readings WHERE site_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts`, [siteId, a, b]),
    q<{ ts: string; running: boolean; watts: number | null; rpm: number | null }>(`SELECT ts::text, running, watts::float8 watts, rpm::float8 rpm FROM pool_readings WHERE site_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts`, [siteId, a, b]),
  ]);
  const byDay = new Map<string, Array<Bucket & { day: string; hour: number }>>(), buckets: Bucket[] = [];
  for (const r of e) { const x = { epoch: Number(r.epoch), kw: Number(r.kw), day: r.day, hour: r.hour }; buckets.push(x); (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(x); }
  return { buckets, byDay, nest: n.map(r => ({ ts: Number(r.ts), hvac: r.hvac ?? 'OFF', heatF: r.heat_f == null ? null : Number(r.heat_f) })),
    pool: p.map(r => ({ ts: Number(r.ts), kw: pumpRunning(r) ? Number(r.watts) / 1000 : 0 })) };
}
/** The pool pump's draw in a bucket: the last reading held up to 20 minutes (night reads are sparse, so gaps count as off). */
export function poolKwOf(pool: ReadonlyArray<{ ts: number; kw: number }>) {
  const xs = [...pool].sort((a, b) => a.ts - b.ts);
  return (start: number) => {   // the last reading at or before the bucket's end (binary search), if it is at most 20 minutes old
    let lo = 0, hi = xs.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m].ts <= start + 300_000) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 && start - xs[at].ts <= CARRY_MS ? xs[at].kw : 0;
  };
}
/** Each day's base: the always-on night when the nightly computed one (breakdown.ts alwaysOnKw), else the quietest tenth of its 1–5 AM. */
function baseFor(day: string, r: Rows, nights: ReadonlyMap<string, number>, fallback: number) {
  return nights.get(day) ?? baseOf(r.byDay.get(day) ?? []) ?? fallback;
}
/** Excess kW while Nest said HEATING over some days, for the stage histogram. */
function heatingExcess(r: Rows, base: (day: string) => number) {
  const on = heatingMask(r.nest), pool = poolKwOf(r.pool), out: number[] = [];
  for (const [day, bs] of r.byDay) for (const b of bs) if (on(b.epoch)) out.push(b.kw - base(day) - pool(b.epoch));
  return out;
}
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/* ---------- the nightly step ---------- */
/**
 * learn/nightly.ts, after the metrics: the last 3 complete days into daily_metrics while it is winter (Nov–Mar) or Nest said HEATING in
 * the last 14 days, the learned levels into kv; and, once, last winter's energy-only back-test. `nights`: the always-on night of each
 * day (alwaysOnKw, already computed by the nightly). Summer nights with no heating cost one query.
 */
export async function stripNightly(siteId: string, o: { now?: number; nights?: ReadonlyMap<string, number>; wx?: Wx | null; slopes?: HomeSlopes | null; fetcher?: typeof fetch } = {}) {
  const now = o.now ?? Date.now(), today = localDay(new Date(now)), nights = o.nights ?? new Map<string, number>();
  const out: Record<string, unknown> = {};
  if (siteLocation() && !(await kv.get<unknown>(backtestKey(siteId)))) out.backtest = await lastWinterBacktest(siteId, { now, fetcher: o.fetcher });
  const days = [3, 2, 1].map(i => addDays(today, -i));
  const heat = await q<{ n: number }>(`SELECT COUNT(*)::int n FROM nest_readings WHERE site_id = $1 AND day >= $2 AND hvac = 'HEATING'`, [siteId, addDays(today, -14)]);
  if (!days.some(winterDay) && !(heat[0]?.n > 0)) return { ...out, skipped: 'no heating' };
  const r = await rows(siteId, addDays(today, -14), addDays(today, -1));
  const fb = median([...nights.values()]) ?? BASE_FALLBACK_KW, base = (day: string) => baseFor(day, r, nights, fb);
  const capRow = await q<{ kw: number | null; n: number }>(`SELECT (PERCENTILE_CONT(0.995) WITHIN GROUP (ORDER BY home_wh) * 12 / 1000.0)::float8 kw, COUNT(*)::int n FROM energy WHERE site_id = $1 AND day >= $2 AND home_wh IS NOT NULL`, [siteId, addDays(today, -365)]);
  const cap = (capRow[0]?.n ?? 0) >= 288 ? capRow[0].kw : capOf(r.buckets.map(b => b.kw));
  const learned = await learnAcKw(siteId), levels = levelsFor(learned, heatingExcess(r, base), cap);
  await kv.set(levelsKey(siteId), { ...levels, at: now, day: today } satisfies StoredLevels);
  const outdoor = outdoorOf(o.wx ?? (await kv.get<{ w: Wx }>(WX_KEY))?.w ?? null), balanceF = balanceOf(o.slopes ?? await kv.get<HomeSlopes>(homeSlopesKey(siteId)));
  const res = days.filter(d => r.byDay.has(d)).map(day => classifyDay({ day, buckets: r.byDay.get(day)!, baseKw: base(day), levels, balanceF, nest: r.nest, poolKw: poolKwOf(r.pool), outdoorF: outdoor }));
  await putMetrics(siteId, res);
  return { ...out, levels: { kind: levels.kind, stageKw: levels.stageKw, stages: levels.stages }, days: res.map(d => ({ day: d.day, kwh: d.stripKwh, cause: d.cause, conf: d.conf })) };
}
async function putMetrics(siteId: string, days: DayStrip[]) {
  const rowsOut = days.flatMap(d => stripMetrics(d).map(([m, v]) => [d.day, m, v] as const)); if (!rowsOut.length) return;
  await q(`INSERT INTO daily_metrics (site_id, day, metric, value) SELECT $1, * FROM unnest($2::text[], $3::text[], $4::float8[])
    ON CONFLICT (site_id, day, metric) DO UPDATE SET value = excluded.value`, [siteId, rowsOut.map(x => x[0]), rowsOut.map(x => x[1]), rowsOut.map(x => x[2])]);
}
/**
 * Once: last winter's days, energy only (Nest readings don't reach back that far), with the archive's hourly temperatures, into
 * daily_metrics (conf "estimated") and the back-test summary into kv `<site>:strip:backtest`. Not marked done when there are no
 * temperatures (no location, the archive down), so the next night tries again.
 */
export async function lastWinterBacktest(siteId: string, o: { now?: number; fetcher?: typeof fetch } = {}) {
  const now = o.now ?? Date.now(), w = lastWinter(localDay(new Date(now))), temps = await winterHourly(now, o.fetcher);
  if (!Object.keys(temps).length) return { skipped: 'no temperatures' };
  const r = await rows(siteId, w.from, w.to, { nest: false });
  const learned = await learnAcKw(siteId).catch(() => ({ heatKw: null, heatSamples: 0 })), levels = levelsFor(learned, [], capOf(r.buckets.map(b => b.kw)));
  const outdoor = outdoorOf(null, temps), fb = median([...r.byDay.keys()].map(d => baseOf(r.byDay.get(d)!)).filter((v): v is number => v != null)) ?? BASE_FALLBACK_KW;
  const res = [...r.byDay.keys()].filter(d => (r.byDay.get(d)?.length ?? 0) >= 250).sort()
    .map(day => classifyDay({ day, buckets: r.byDay.get(day)!, baseKw: baseFor(day, r, new Map(), fb), levels, balanceF: DEFAULT_BALANCE_F, nest: null, poolKw: poolKwOf(r.pool), outdoorF: outdoor }));
  await putMetrics(siteId, res);
  const summary = { at: now, season: w.season, ...backtest(res) };
  await kv.set(backtestKey(siteId), summary);
  return summary;
}

/* ---------- today (the card and the 10:00 alert) ---------- */
/** Today's morning so far with the stored levels (or the defaults from the learned heating step). */
export async function stripToday(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), learned = await learnAcKw(siteId);
  const [r, stored, wx, slopes, bases] = await Promise.all([rows(siteId, today, today), kv.get<StoredLevels>(levelsKey(siteId)), kv.get<{ w: Wx }>(WX_KEY), kv.get<HomeSlopes>(homeSlopesKey(siteId)),
    q<{ v: number }>(`SELECT value::float8 v FROM daily_metrics WHERE site_id = $1 AND metric = 'home.alwaysOn_kw' AND day >= $2 ORDER BY day DESC`, [siteId, addDays(today, -7)])]);
  const levels: Levels = stored && stored.kind === levelsFor(learned).kind ? stored : levelsFor(learned, [], stored?.capKw ?? null);
  const baseKw = baseOf(r.byDay.get(today) ?? []) ?? median(bases.map(b => Number(b.v))) ?? BASE_FALLBACK_KW;
  const day = classifyDay({ day: today, buckets: r.buckets, baseKw, levels, balanceF: balanceOf(slopes), nest: r.nest, poolKw: poolKwOf(r.pool), outdoorF: outdoorOf(wx?.w ?? null), until: now });
  return { day, levels, learned, nest: r.nest };
}
/** GET /api/appliances/ac/strip: the card (frame 6). `show`: Nov–Mar, or Nest said HEATING in the last 7 days. */
export async function stripCard(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), t = await stripToday(siteId, now), d = t.day;
  const [seen, metrics] = await Promise.all([
    q<{ n: number }>(`SELECT COUNT(*)::int n FROM nest_readings WHERE site_id = $1 AND day >= $2 AND hvac = 'HEATING'`, [siteId, addDays(today, -6)]),
    q<{ day: string; metric: string; value: number }>(`SELECT day, metric, value::float8 value FROM daily_metrics WHERE site_id = $1 AND day >= $2 AND day < $3 AND metric LIKE ANY(ARRAY['strip.%', 'hp.%'])`, [siteId, addDays(today, -13), today]),
  ]);
  const byDay: Record<string, Record<string, number>> = {};
  for (const m of metrics) (byDay[m.day] ??= {})[m.metric] = Number(m.value);
  const week: Record<string, Record<string, number>> = Object.fromEntries(Object.entries(byDay).filter(([k]) => k >= addDays(today, -6)));
  week[today] = Object.fromEntries(stripMetrics(d));
  // the comparison in the tip: the most recent morning of the last two weeks with a setback of 2° or less
  const cmpDay = Object.entries(byDay).filter(([, m]) => m['strip.setback_f'] != null ? m['strip.setback_f'] <= 2 : m['strip.cause'] === 0 && m['hp.min'] > 0).sort(([a], [b]) => b.localeCompare(a))[0];
  const kind = t.levels.kind;
  return {
    show: winterDay(today) || (seen[0]?.n ?? 0) > 0 || d.runs.length > 0,
    today: { ...d, why: whyText(d, kind), tip: tipText(d, kind, cmpDay ? { day: cmpDay[0], kwh: cmpDay[1]['strip.kwh'] ?? 0 } : null) },
    week: weekSummary(week),
    heating: { kind, label: heatingLabel(t.levels, t.learned.heatSamples), conf: kind === 'learning' ? 'learning' : 'learned', heatKw: t.levels.heatKw, stageKw: t.levels.stageLearned ? t.levels.stageKw : null, stages: t.levels.stages },
  };
}
/**
 * The 5-minute cron's strip step: only the 10:00–10:15 Chicago ticks do anything (every other tick returns before touching the database);
 * the first of them claims the day (kv), so the morning is judged once. A heavy morning (HEAVY_STRIP_KWH) caused by a setback is
 * pushed; one the cold caused goes to the feed only. During a Vacation trip notify() holds it (HELD_ON_TRIP).
 */
export async function stripWatch(siteId: string, now = Date.now()) {
  const { minute } = chicago(now);
  if (minute < ALERT_MINUTE.from || minute >= ALERT_MINUTE.to) return { skipped: 'not 10:00' };
  const day = localDay(new Date(now));
  const claimed = await q(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE kv.value <> excluded.value RETURNING key`, [alertedKey(siteId), JSON.stringify(day)]);
  if (!claimed.length) return { skipped: 'already checked', day };
  const { day: d } = await stripToday(siteId, now), a = alertFor(d);
  if (!a) return { day, kwh: d.stripKwh, alert: false };
  const r = await notify(siteId, 'strip', a.title, a.body, { day, kwh: d.stripKwh, minutes: d.stripMin, cause: d.cause, conf: d.conf },
    { key: `strip:${day}`, windowH: 36, now, url: '/?go=v-sys&p=ac', feedOnly: !a.push });
  return { day, kwh: d.stripKwh, cause: d.cause, alert: true, push: a.push, stored: r.stored, pushed: r.pushed, held: !!r.held };
}
