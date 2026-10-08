// Strip-heat watch on PGlite (server/src/stripwatch.ts; I-15, approved mockup am frames 6 and 7). Read-only towards every device: the
// morning comes from seeded `energy` and `nest_readings`; no push subscription exists, so nothing is sent. Synthetic values only.
//   SW-1 the 10:00 alert: a setback-heavy morning pushes (once: dedupe and the claimed day), a cold-only one goes to the feed only,
//        a light morning is nothing, the "Strip heat" switch silences it, a trip holds it, the push limit is one a day
//   SW-2 the card: shown in winter or after heating, today's figures, the week from daily_metrics, the heating type
//   SW-3 the nightly: the last 3 days into daily_metrics; summer without heating does one query; last winter's back-test once, from
//        a mocked Open-Meteo archive (kv wx:hourly:winter holds dates and temperatures only)
//   SW-4 the weekly digest carries the strip line
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { localAt, rfc3339, addDays } from '../../server/src/tesla/client.js';
import { stripWatch, stripCard, stripNightly, winterHourly, lastWinter, WINTER_HOURLY_KEY, levelsKey, backtestKey } from '../../server/src/stripwatch.js';
import { PUSH_LIMITS, HELD_ON_TRIP, TOGGLES, notify } from '../../server/src/notify.js';
import { createTrip } from '../../server/src/vacation/trip.js';
import { buildDigest, digestAlert } from '../../server/src/digest.js';

const S = 's', MIN = 60_000, D = '2027-01-14';
const at = (day: string, h: number) => localAt(day, h);
const TEN = at(D, 10) + 30_000;   // the 10:00 tick
const learned = (heatKw: number | null, heatSamples: number) => kv.set(`${S}:ac:learned:v2`, { at: Date.now(), learned: { coolKw: 3.4, heatKw, samples: 8, heatSamples, diag: { lateKw: null, lateSamples: 0, regressionKw: null, regressionHours: 0 } } });
/** The day's energy 00:00–`to`: 0.6 kW base, the compressor 05:00–10:00 (3.4 kW) and strips 06:00–07:35 (`strip` kW). */
async function energy(day: string, strip = 9.6, to = 10) {
  const rows: unknown[][] = [];
  for (let t = at(day, 0); t < at(day, to); t += 5 * MIN) {
    const kw = .6 + (t >= at(day, 5) && t < at(day, 10) ? 3.4 : 0) + (t >= at(day, 6) && t < at(day, 7) + 35 * MIN ? strip : 0);
    rows.push([S, rfc3339(new Date(t)), t, day, +rfc3339(new Date(t)).slice(11, 13), kw * 1000 / 12]);
  }
  await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::int[], $6::real[]) ON CONFLICT DO NOTHING`,
    [rows.map(r => r[0]), rows.map(r => r[1]), rows.map(r => r[2]), rows.map(r => r[3]), rows.map(r => r[4]), rows.map(r => r[5])]);
}
/** Nest every 15 minutes, the evening before to noon: HEATING 05:00–10:00; the heat setpoint 62° before 06:00 on a setback morning, else 68°. */
async function nest(day: string, setback: boolean) {
  for (let t = at(day, 0) - 60 * MIN; t < at(day, 12); t += 15 * MIN) {
    const h = +rfc3339(new Date(t)).slice(11, 13);
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, mode, hvac, heat_f) VALUES ($1,$2,$3,$4,'HEAT',$5,$6) ON CONFLICT DO NOTHING`,
      [S, t, rfc3339(new Date(t)).slice(0, 10), h, t >= at(day, 5) && t < at(day, 10) ? 'HEATING' : 'OFF', setback && t < at(day, 6) ? 62 : 68]);
  }
}
/** wx:gti with the day's hours at `f` °F. */
const weather = (day: string, f: number) => kv.set('wx:gti', { at: Date.now(), w: { hourly: { time: Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, '0')}:00`), temperature_2m: Array(24).fill(f), global_tilted_irradiance: Array(24).fill(0) }, daily: { time: [day], temperature_2m_max: [f + 10], precipitation_sum: [0] } } });
const alerts = () => q<{ kind: string; title: string; body: string; data: any; pushed: number }>(`SELECT kind, title, body, data, pushed FROM alerts ORDER BY id`);

beforeAll(async () => { await migrate(); });
beforeEach(async () => {
  for (const t of ['alerts', 'energy', 'nest_readings', 'pool_readings', 'daily_metrics', 'trips', 'readings']) await q(`DELETE FROM ${t}`);
  await q('DELETE FROM kv');
  await q(`INSERT INTO sites (id, name) VALUES ($1, 'Test') ON CONFLICT DO NOTHING`, [S]);
  await kv.set('settings:owner', {});
  await learned(3.4, 6);
});
afterEach(() => { delete process.env.SITE_LAT; delete process.env.SITE_LON; });

describe('the 10:00 alert', () => {
  it('SW-1 a setback-heavy morning pushes once; cold-only is feed only; light is nothing; the switch, a trip and the limit', async () => {
    expect(TOGGLES.strip).toEqual(['strip']);
    expect(PUSH_LIMITS.strip).toEqual({ max: 1, hours: 24 });
    expect(HELD_ON_TRIP).toContain('strip');
    await energy(D); await nest(D, true); await weather(D, 45);
    expect(await stripWatch(S, at(D, 9) + 55 * MIN)).toEqual({ skipped: 'not 10:00' });
    expect(await stripWatch(S, at(D, 10) + 15 * MIN)).toEqual({ skipped: 'not 10:00' });
    const r = await stripWatch(S, TEN);
    expect(r).toMatchObject({ day: D, alert: true, push: true, cause: 'setback', stored: true, held: false });
    expect((r as { kwh: number }).kwh).toBeCloseTo(15.2, 1);
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'strip', title: 'Strip heat ran 1 h 35 m this morning', body: 'About 15 kWh, mostly catching up from the 62° setback. A shallower setback keeps the strips off.' });
    expect(a[0].data).toMatchObject({ key: `strip:${D}`, cause: 'setback', day: D });
    expect(a[0].data.feedOnly).toBeUndefined();
    // the next tick inside the window: the day is claimed; a repeat of the key inside 36 h is a duplicate
    expect(await stripWatch(S, TEN + 5 * MIN)).toEqual({ skipped: 'already checked', day: D });
    expect(await notify(S, 'strip', 'x', 'y', {}, { key: `strip:${D}`, windowH: 36, now: TEN + 3600e3 })).toMatchObject({ skipped: 'duplicate' });
    // the push limit: one strip push a day (a row that was pushed counts)
    await q(`UPDATE alerts SET pushed = 1 WHERE kind = 'strip'`);
    expect(await notify(S, 'strip', 'x', 'y', {}, { key: 'other', now: TEN + 7200e3 })).toMatchObject({ stored: true, limited: true });
  });
  it('SW-1b cold-only heavy → feed only; a light morning → nothing; switched off → nothing; on a trip → held', async () => {
    await energy(D); await nest(D, false); await weather(D, 25);
    expect(await stripWatch(S, TEN)).toMatchObject({ alert: true, push: false, cause: 'cold', stored: true });
    const [a] = await alerts();
    expect(a).toMatchObject({ kind: 'strip', pushed: 0 });
    expect(a.body).toMatch(/^About 15 kWh on a 25° morning/);
    // a light morning (strips 06:00–07:35 at 5 kW → 7.9 kWh, under 12)
    const L = addDays(D, 1);
    await energy(L, 5); await nest(L, true); await weather(L, 45);
    expect(await stripWatch(S, at(L, 10) + 30_000)).toMatchObject({ alert: false });
    // the "Strip heat" switch off: checked, nothing stored
    const O = addDays(D, 2);
    await energy(O); await nest(O, true); await weather(O, 45);
    await kv.set('settings:owner', { alerts: { strip: false } });
    expect(await stripWatch(S, at(O, 10) + 30_000)).toMatchObject({ alert: true, stored: false });
    await kv.set('settings:owner', {});
    // during a Vacation trip the push is held (kept in the feed, marked held)
    const T = addDays(D, 3);
    await energy(T); await nest(T, true); await weather(T, 45);
    await createTrip(S, { leaveAt: at(T, 0) - 864e5, backAt: at(T, 0) + 3 * 864e5, detected: false }, at(T, 0) - 864e5);
    expect(await stripWatch(S, at(T, 10) + 30_000)).toMatchObject({ alert: true, push: true, held: true });
    expect((await alerts()).at(-1)?.data).toMatchObject({ held: true, key: `strip:${T}` });
  });
});

describe('the card and the nightly', () => {
  it('SW-2 the card: today so far, the week, the heating type; shown in winter or after heating', async () => {
    await energy(D); await nest(D, true); await weather(D, 45);
    await q(`INSERT INTO daily_metrics (site_id, day, metric, value) VALUES ($1,$2,'strip.kwh',9),($1,$2,'strip.cause',2),($1,$3,'strip.kwh',7),($1,$3,'strip.cause',1),($1,$3,'strip.setback_f',1)`, [S, addDays(D, -2), addDays(D, -5)]);
    const c = await stripCard(S, TEN);
    expect(c.show).toBe(true);
    expect(c.today).toMatchObject({ mode: 'nest', stripMin: 95, peakKw: 9.6, cause: 'setback', conf: 'estimated' });   // stage not learned yet: estimated
    expect(c.today.quarters).toHaveLength(32);
    expect(c.today.why).toMatch(/^Catching up from the 62° night setback \(heat to 68° at 6:00 AM\)\. Outside was 45°, above the ~40° point/);
    expect(c.today.tip).toMatch(/^Keep overnight setbacks to 2° or less\..* A 2° setback last \w+day used \d+(\.\d)? kWh less\.$/);
    expect(c.week).toEqual({ mornings: 3, kwh: 31, setbacks: 2 });   // 9 + 7 + today's 15.2
    expect(c.heating).toMatchObject({ kind: 'heat-pump', label: 'heat pump + strips', conf: 'learned' });
    // learning until 5 heating steps; a summer day with no heating: hidden
    await learned(3.4, 2);
    expect((await stripCard(S, TEN)).heating).toMatchObject({ kind: 'learning', conf: 'learning', label: 'learning (2 of 5 heating runs)' });
    expect((await stripCard(S, Date.parse('2027-07-14T15:00:00Z'))).show).toBe(false);
    // the card's route is owner only (redaction.test.ts RED-10 pins it among the GETs without a guest view)
  });
  it('SW-3 the nightly writes the last 3 days; summer without heating is one query; last winter is back-tested once', async () => {
    for (const d of [addDays(D, -3), addDays(D, -2), addDays(D, -1)]) { await energy(d, 9.6, 24); await nest(d, true); }
    const r = await stripNightly(S, { now: at(D, 5) + 15 * MIN, nights: new Map() });
    expect(r).toMatchObject({ levels: { kind: 'heat-pump' } });
    const m = await q<{ day: string; metric: string; value: number }>(`SELECT day, metric, value FROM daily_metrics WHERE metric LIKE 'strip.%' OR metric = 'hp.min' ORDER BY day, metric`);
    expect(new Set(m.map(x => x.day))).toEqual(new Set([addDays(D, -3), addDays(D, -2), addDays(D, -1)]));
    expect(m.find(x => x.day === addDays(D, -1) && x.metric === 'strip.min')?.value).toBe(95);
    expect(m.find(x => x.day === addDays(D, -1) && x.metric === 'hp.min')?.value).toBe(300 - 95);
    expect(await kv.get(levelsKey(S))).toMatchObject({ kind: 'heat-pump', compressorKw: 3.4 });
    // July, no heating in 14 days: skipped after the one check
    expect(await stripNightly(S, { now: Date.parse('2027-07-14T10:15:00Z') })).toMatchObject({ skipped: 'no heating' });
    // last winter (Nov 1 – Mar 31), once, from a mocked archive: dates and temperatures only in kv
    process.env.SITE_LAT = '30.0'; process.env.SITE_LON = '-97.0';
    const W = lastWinter('2027-10-07');
    expect(W).toEqual({ season: '2026-27', from: '2026-11-01', to: '2027-03-31' });
    expect(lastWinter('2027-02-01').from).toBe('2025-11-01');
    const fetcher = vi.fn(async (u: string | URL | Request) => {
      expect(String(u)).toMatch(/^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?.*start_date=2026-11-01&end_date=2027-03-31&hourly=temperature_2m/);
      const time: string[] = [], temperature_2m: number[] = [];
      for (let d = '2026-11-01'; d <= '2027-03-31'; d = addDays(d, 1)) for (let h = 0; h < 24; h++) { time.push(`${d}T${String(h).padStart(2, '0')}:00`); temperature_2m.push(30); }
      return new Response(JSON.stringify({ latitude: 30, longitude: -97, hourly: { time, temperature_2m } }), { status: 200 });
    });
    const now = Date.parse('2027-10-07T10:15:00Z');
    await q(`DELETE FROM nest_readings`);
    const bt = await stripNightly(S, { now, fetcher: fetcher as unknown as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(bt).toMatchObject({ backtest: { season: '2026-27', heavyKwh: 12 } });
    expect((bt as any).backtest.stripDays).toBeGreaterThanOrEqual(1);   // the three seeded January days, energy only
    const cache = await kv.get<{ season: string; byHour: Record<string, number> }>(WINTER_HOURLY_KEY);
    expect(cache?.season).toBe('2026-27');
    expect(JSON.stringify(cache)).not.toMatch(/latitude|longitude|30\.0|-97/);
    expect(await kv.get(backtestKey(S))).toMatchObject({ season: '2026-27' });
    expect(await q(`SELECT value FROM daily_metrics WHERE day = $1 AND metric = 'strip.conf'`, [addDays(D, -1)])).toEqual([{ value: 1 }]);   // estimated
    // once: the next night neither fetches nor re-runs it
    await stripNightly(S, { now: now + 864e5, fetcher: fetcher as unknown as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Object.keys(await winterHourly(now, fetcher as unknown as typeof fetch)).length).toBe(151 * 24);
  });
  it('SW-4 the weekly digest carries the strip line', async () => {
    const mon = '2027-01-11';
    await q(`INSERT INTO daily_metrics (site_id, day, metric, value) VALUES ($1,$2,'strip.kwh',14),($1,$2,'strip.cause',2),($1,$3,'strip.kwh',9.2),($1,$3,'strip.cause',1),($1,$4,'strip.kwh',7.6),($1,$4,'strip.cause',3)`,
      [S, mon, addDays(mon, 2), addDays(mon, 4)]);
    const d = await buildDigest(S, mon, Date.parse('2027-01-18T13:00:00Z'));
    expect(d.strip).toEqual({ mornings: 3, kwh: 31, setbacks: 2 });
    expect(digestAlert(d).body).toMatch(/ Strip heat: 3 mornings · 31 kWh \(2 after setbacks\)\.$/);
    expect((await buildDigest(S, addDays(mon, -7), Date.parse('2027-01-18T13:00:00Z'))).strip).toBeUndefined();
  });
});
