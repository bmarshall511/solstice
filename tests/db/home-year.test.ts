// B2-8 (audit L-09, D4; idea I-01): the home model's heating season on PGlite. The nightly fits kWh = a + b·max(0, high − Tc) +
// c·max(0, Th − low) on the daily totals with the archived highs and lows (kv `wx:hilo`, one Open-Meteo archive pull a day, mocked
// here inside the fetch guard), leaves out days the pool ran beyond its plan, and the app's forecast and breakdown use it. Synthetic data only.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { wxHiLo, homeForecast, homeSlopesKey, HILO_KEY, type HomeSlopes } from '../../server/src/learn/homeModel.js';
import { WX_KEY } from '../../server/src/learn/wx.js';
import { runLearn } from '../../server/src/learn/nightly.js';
import { breakdownFor } from '../../server/src/breakdown.js';
import { outageDetail } from '../../server/src/outage.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({ configured: () => false, readPool: vi.fn(), writePoolPlan: vi.fn(), withUnit: vi.fn() }));
const S = 'hy', B = 300_000;
const DAYS = Array.from({ length: 59 }, (_, i) => addDays('2026-01-01', i));                  // 1 Jan … 28 Feb 2026
const high = (i: number) => 50 + (i * 7) % 45, low = (i: number) => high(i) - 20;              // highs 50–94, lows 30–74
const kwh = (i: number) => 40 + 3 * Math.max(0, high(i) - 70) + 2 * Math.max(0, 60 - low(i));
const EXTRA = '2026-02-10';                                                                     // a Clear-up day: +100 kWh, marked pool.extra
/** A day's 288 five-minute buckets, `kw` steady, plus `extra` kW in the buckets `on` marks. */
async function energyDay(site: string, d: string, kw: number, extra = 0, on: (t: number) => boolean = () => false) {
  const rows: Array<{ t: number; h: number; wh: number }> = [];
  for (let t = localMidnight(d).getTime(); t < localMidnight(addDays(d, 1)).getTime(); t += B) rows.push({ t, h: +rfc3339(new Date(t)).slice(11, 13), wh: Math.round((kw + (on(t) ? extra : 0)) * 1000 / 12) });
  await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh) SELECT $1, ts, epoch, $2, hour, wh FROM unnest($3::text[], $4::bigint[], $5::int[], $6::int[]) AS x(ts, epoch, hour, wh)`,
    [site, d, rows.map(r => rfc3339(new Date(r.t))), rows.map(r => r.t), rows.map(r => r.h), rows.map(r => r.wh)]);
}
const guard = globalThis.fetch;
afterEach(() => { vi.stubGlobal('fetch', guard); delete process.env.SITE_LAT; delete process.env.SITE_LON; });

beforeAll(async () => {
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, NULL, 1, 'Test'), ('hb', NULL, 1, 'Test')`, [S]);
  for (const [i, d] of DAYS.entries()) await energyDay(S, d, (kwh(i) + (d === EXTRA ? 100 : 0)) / 24);
  await q(`INSERT INTO daily_metrics (site_id, day, metric, value) VALUES ($1, $2, 'pool.extra', 1)`, [S, EXTRA]);
}, 120_000);

describe('B2-8: the archived highs and lows (kv wx:hilo)', () => {
  const NOW = Date.parse('2026-03-01T18:00:00Z');
  it('HY-1 one archive pull a day, cached without the location; none without a location; the stale cache when the pull fails', async () => {
    expect(await wxHiLo(NOW)).toEqual({});                                                           // no SITE_LAT/SITE_LON: nothing fetched
    process.env.SITE_LAT = '12.34'; process.env.SITE_LON = '-56.78';                                  // synthetic
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ daily: { time: ['2026-02-26', '2026-02-27', '2026-02-28'], temperature_2m_max: [61.5, 70, null], temperature_2m_min: [33.1, 45, null] } }));
    });
    expect(await wxHiLo(NOW)).toEqual({ '2026-02-26': { high: 61.5, low: 33.1 }, '2026-02-27': { high: 70, low: 45 } });
    expect(await wxHiLo(NOW + 3600e3)).toEqual({ '2026-02-26': { high: 61.5, low: 33.1 }, '2026-02-27': { high: 70, low: 45 } });
    expect(urls).toHaveLength(1);                                                                     // the same Chicago day: the cache
    expect(urls[0]).toMatch(/^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?.*start_date=2025-02-24&end_date=2026-02-28&daily=temperature_2m_max,temperature_2m_min/);
    expect(JSON.stringify(await kv.get(HILO_KEY))).not.toMatch(/12\.34|56\.78/);
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    expect(await wxHiLo(NOW + 864e5)).toEqual({ '2026-02-26': { high: 61.5, low: 33.1 }, '2026-02-27': { high: 70, low: 45 } });   // the next day: the pull fails, the last cache
    await kv.set(HILO_KEY, null);
  });
});

describe('B2-8: the nightly year fit and the forecast', () => {
  const NOW = Date.parse('2026-03-01T18:00:00Z');   // 12:00 CST on 1 Mar
  it('HY-2 the nightly fits both slopes from the winter days, leaves the pool-extra day out, and keeps the fit in kv', async () => {
    await kv.set(HILO_KEY, { day: '2026-03-01', at: NOW, byDay: Object.fromEntries(DAYS.map((d, i) => [d, [high(i), low(i)]])) });
    const r = await runLearn(S, { now: NOW });
    expect(r.steps.home).toEqual({ ms: expect.any(Number) });
    const f = await kv.get<HomeSlopes>(homeSlopesKey(S));
    expect(f).toMatchObject({ day: '2026-03-01', tc: 70, th: 60, n: 58, from: '2026-01-01', to: '2026-02-28' });   // 59 days less the Clear-up day
    expect(f!.b).toBeCloseTo(3, 1); expect(f!.c).toBeCloseTo(2, 1); expect(f!.a).toBeCloseTo(40, 0);
    expect(f!.heatDays).toBeGreaterThan(10);
  });
  it('HY-3 homeForecast: the year slopes, the 14-day level, and a freezing tomorrow scaled to 2×', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      const all = [...DAYS.slice(-20), '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];
      const time = all.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
      const hl = (d: string) => { const i = DAYS.indexOf(d); return i >= 0 ? [high(i), low(i)] : d === '2026-03-02' ? [30, 5] : [72, 55]; };
      await kv.set(WX_KEY, { at: NOW, w: { hourly: { time, global_tilted_irradiance: time.map(() => 0), temperature_2m: time.map(() => 50) },
        daily: { time: all, temperature_2m_max: all.map(d => hl(d)[0]), temperature_2m_min: all.map(d => hl(d)[1]), precipitation_sum: all.map(() => 0) } } });
      const h = await homeForecast(S, NOW);
      expect(h.fit).toMatchObject({ tc: 70, th: 60, year: { n: 58 } });
      expect(h.fit!.c).toBeGreaterThan(1.8);
      expect(h.fit!.a).toBeCloseTo(40, 0);                                                         // the level refitted on 15–28 Feb
      expect(h.tomorrow).toMatchObject({ day: '2026-03-02', high: 30, low: 5 });
      expect(h.tomorrow!.kwh).toBeCloseTo(h.fit!.a + h.fit!.c * 55, 0);                             // 5° is 55° below 60
      expect(h.scale['2026-03-02']).toBeGreaterThan(1.5);                                            // above the cooling cap: only a heating day may
      expect(h.scale['2026-03-02']).toBeLessThanOrEqual(2);
      expect(h.today).toEqual({ high: 72, low: 55 });
    } finally { vi.useRealTimers(); }
  });
});

describe('B2-8: heating in the breakdown', () => {
  const D = '2026-12-02', NOW = Date.parse('2026-12-03T18:00:00Z');
  it('HY-4 heating hours: never at the cooling kW; booked at the heating kW once learned, else the AC part is "estimated"', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      // 1 kW all day; the Nest heats 06:00–08:00 and the house draws 8 kW more then
      const h0 = localMidnight(D).getTime() + 6 * 3600e3, heat = (t: number) => t >= h0 && t < h0 + 2 * 3600e3;
      await energyDay('hb', D, 1, 8, heat);
      const ts: number[] = [], hrs: number[] = [], hv: string[] = [];
      for (let t = localMidnight(D).getTime(); t < localMidnight(addDays(D, 1)).getTime(); t += 3 * B) { ts.push(t); hrs.push(+rfc3339(new Date(t)).slice(11, 13)); hv.push(heat(t) ? 'HEATING' : 'OFF'); }
      await q(`INSERT INTO nest_readings (site_id, ts, day, hour, mode, hvac) SELECT 'hb', ts, $1, hour, 'HEAT', hvac FROM unnest($2::bigint[], $3::int[], $4::text[]) AS x(ts, hour, hvac)`, [D, ts, hrs, hv]);
      const learned = (heatKw: number | null) => ({ coolKw: 3, heatKw, samples: 9, heatSamples: heatKw ? 6 : 0, diag: { lateKw: 3, lateSamples: 9, regressionKw: 3, regressionHours: 200 } });
      await kv.set('hb:ac:learned:v2', { at: Date.now(), learned: learned(null) });
      let ac = (await breakdownFor('hb', 'week', {})).parts.find(p => p.id === 'ac')! as any;
      expect(ac).toMatchObject({ kwh: 0, conf: 'estimated', hours: 2, heatHours: 2, heatKw: null });   // was 2 h × 3 kW of "cooling"
      let big = (await breakdownFor('hb', 'week', {})).parts.find(p => p.id === 'big')!;
      expect(big.kwh).toBe(0);                                                                         // strip heat is not a "water heater"
      await kv.set('hb:ac:learned:v2', { at: Date.now(), learned: learned(8) });
      ac = (await breakdownFor('hb', 'week', {})).parts.find(p => p.id === 'ac')!;
      expect(ac).toMatchObject({ kwh: 16, conf: 'measured', heatHours: 2, heatKw: 8 });
      big = (await breakdownFor('hb', 'week', {})).parts.find(p => p.id === 'big')!;
      expect(big.kwh).toBe(0);
      // the outage ladder's AC rung: in HEAT it is the heating kW × heating duty (no reading today, no low known: 50%), not cooling
      await kv.set('nest:last', { mode: 'HEAT', hvac: 'OFF' });
      expect((await outageDetail('hb', {}, new Date(NOW))).loads).toMatchObject({ acHeat: true, acKw: 8, acSource: 'measured', acDuty: .5, dutySource: 'estimated' });
      await kv.set('nest:last', { mode: 'COOL', hvac: 'OFF' });
      expect((await outageDetail('hb', {}, new Date(NOW))).loads).toMatchObject({ acHeat: false, acKw: 3 });
      await kv.set('nest:last', null);
    } finally { vi.useRealTimers(); }
  });
});
