// I-18 "What changed" on PGlite: the nightly writes its four new values (pool.kwh, ac.kwh, ac.heat_min, wx.low_f), GET /api/changed
// splits a day and a week for the owner, and a guest read (the owner previewing as a guest) gets only weather, pool and "other",
// with no trip awareness, through the route's guest view. The weekly digest carries the week's split. All data synthetic.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { q, kv, migrate } from '../../server/src/db.js';
import { runLearn } from '../../server/src/learn/nightly.js';
import { HILO_KEY, homeSlopesKey } from '../../server/src/learn/homeModel.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({ configured: () => false, readPool: vi.fn(), writePoolPlan: vi.fn(), withUnit: vi.fn() }));

const S = 's', B = 300_000, NOW = Date.parse('2026-10-07T18:00:00Z');   // Wed 13:00 CDT
const YDAY = '2026-10-06', TRIP = '2026-09-29';                          // both Tuesdays
const DAYS = Array.from({ length: 42 }, (_, i) => addDays(YDAY, i - 41)); // 26 Aug … 6 Oct
const NEST_FROM = '2026-09-01';   // Nest and the pool readings from here; the nights before 1 Sep have neither
const coolHours = (d: string) => d === YDAY ? [14, 15, 16, 17] : [14, 15];
let server: Server, base = '', owner = '', preview = '';
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const pair = (r: Response, name: string) => (r.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? '').split(';')[0];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, NULL, 1, 'Test')`, [S]);
  for (const d of DAYS) {
    const rows: Array<{ t: number; h: number; home: number; solar: number; imp: number }> = [];
    for (let t = localMidnight(d).getTime(); t < localMidnight(addDays(d, 1)).getTime(); t += B) {
      const h = +rfc3339(new Date(t)).slice(11, 13), away = d === TRIP;
      const kw = (away ? 0.4 : 1.2) + (d >= NEST_FROM && !away && coolHours(d).includes(h) ? 3 : 0) + (h >= 10 && h < 14 && d >= NEST_FROM ? 1 : 0);
      const sun = h >= 8 && h < 18 ? 4 : 0;
      rows.push({ t, h, home: Math.round(kw * 1000 / 12), solar: Math.round(sun * 1000 / 12), imp: Math.round(Math.max(0, kw - sun) * 1000 / 12) });
    }
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh, solar_wh, import_wh) SELECT $1, ts, epoch, $2, hour, h, s, i
      FROM unnest($3::text[], $4::bigint[], $5::int[], $6::int[], $7::int[], $8::int[]) AS x(ts, epoch, hour, h, s, i)`,
      [S, d, rows.map(r => rfc3339(new Date(r.t))), rows.map(r => r.t), rows.map(r => r.h), rows.map(r => r.home), rows.map(r => r.solar), rows.map(r => r.imp)]);
    if (d >= NEST_FROM) {   // Nest every 5 minutes: cooling in the day's cooling hours
      const ts = rows.map(r => r.t), hrs = rows.map(r => r.h);
      await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac, mode) SELECT $1, ts, $2, hour, CASE WHEN hour = ANY($5::int[]) THEN 'COOLING' ELSE 'OFF' END, 'COOL'
        FROM unnest($3::bigint[], $4::int[]) AS x(ts, hour)`, [S, d, ts, hrs, d === TRIP ? [] : coolHours(d)]);
    }
    if (d >= NEST_FROM) for (let m = 10 * 60; m < 14 * 60; m += 15) {   // the pump 10:00–14:00 at 1 kW, read every 15 minutes
      const at = localMidnight(d).getTime() + m * 60_000;
      await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ($1, $2, $3, $4, true, 1000, 2000)`, [S, at, d, Math.floor(m / 60)]);
    }
  }
  await q(`INSERT INTO trips (site_id, leave_at, back_at, state, started_at, ended_at, ended_by) VALUES ($1, $2, $3, 'ended', $2, $3, 'you')`,
    [S, localMidnight(TRIP).getTime(), localMidnight(addDays(TRIP, 1)).getTime()]);
  await kv.set('settings:owner', { pool: { uv: false } });
  await kv.set(HILO_KEY, { day: '2026-10-07', at: NOW, byDay: Object.fromEntries(DAYS.map(d => [d, [d === YDAY ? 96 : 89, d === YDAY ? 75 : 70]])) });
  await kv.set(homeSlopesKey(S), { day: '2026-10-07', a: 20, b: 0.5, c: 0, tc: 70, th: 60, n: 60, heatDays: 0, from: DAYS[0], to: YDAY, rmse: 2 });
  server = createServer((await import('../../server/src/app.js')).app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  owner = pair(await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) }), 'solstice_owner');
  const pv = await fetch(`${base}/api/auth/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: owner }, body: JSON.stringify({ on: true }) });
  preview = `${owner}; ${pair(pv, 'solstice_preview')}`;
  expect(owner && preview.includes('solstice_preview=')).toBeTruthy();
}, 120_000);
afterAll(async () => { vi.useRealTimers(); await new Promise(r => server.close(r)); });

const tenths = (v: number) => Math.round(v * 10);
const addsUp = (s: { delta: number; parts: Array<{ kwh: number }> }) => expect(tenths(s.parts.reduce((a, p) => a + p.kwh, 0))).toBe(tenths(s.delta));

describe('I-18 on PGlite', () => {
  it('CHD-1 the nightly writes pool.kwh, ac.kwh, ac.heat_min and wx.low_f', async () => {
    // three nights, as the cron runs them: each writes pool.kwh for its last 14 days, so the older Tuesdays have theirs too
    for (const back of [20, 10]) expect((await runLearn(S, { now: NOW - back * 864e5 })).errors).toEqual([]);
    const r = await runLearn(S, { now: NOW });
    expect(r.steps.metrics).toEqual({ ms: expect.any(Number) });
    const m = Object.fromEntries((await q<{ metric: string; value: number }>(`SELECT metric, value::float8 value FROM daily_metrics WHERE site_id = $1 AND day = $2`, [S, YDAY])).map(x => [x.metric, x.value]));
    expect(m['pool.kwh']).toBeCloseTo(4, 1);                  // 4 h × 1 kW, from the readings
    expect(m['ac.kwh']).toBeGreaterThan(4);                   // 4 h of cooling × the learned (or estimated) draw
    expect(m['ac.heat_min']).toBe(0);
    expect(m['wx.low_f']).toBe(75); expect(m['wx.high_f']).toBe(96);
    const old = await q(`SELECT metric FROM daily_metrics WHERE site_id = $1 AND day = '2026-08-28' AND metric IN ('ac.kwh', 'pool.kwh')`, [S]);
    expect(old).toEqual([]);                                  // no Nest and no pool readings then: neither is written
  });
  it('CHD-2 the owner gets the day split against the last 4 Tuesdays at home (the trip Tuesday left out)', async () => {
    const r = await get(`/api/changed?scope=day&date=${YDAY}`, owner), c = await r.json();
    expect(r.status).toBe(200);
    expect(c).toMatchObject({ scope: 'day', date: YDAY, baseline: { kind: 'weekday', days: 3 }, wx: { high: 96, baseHigh: 89 } });
    expect(c.home.parts.map((p: any) => p.id)).toEqual(expect.arrayContaining(['weather', 'ac', 'pool', 'alwaysOn', 'unexplained']));
    expect(c.home.parts.find((p: any) => p.id === 'weather').kwh).toBe(3.5);   // 0.5 × (96 − 89)
    addsUp(c.home); addsUp(c.import);
    expect(JSON.stringify(c)).not.toMatch(/\$/);
    expect((await get('/api/changed?scope=month', owner)).status).toBe(400);
    expect((await get('/api/changed?date=yesterday', owner)).status).toBe(400);
    expect((await (await get('/api/changed?scope=day&date=2026-10-07', owner)).json())).toMatchObject({ home: null, notes: ['incomplete'] });
  });
  it('CHD-3 a guest read: the Used split only (weather, pool, everything else), no Bought split, no trip awareness, no notes, and the parts add up', async () => {
    const c = await (await get(`/api/changed?scope=day&date=${YDAY}`, preview)).json();
    expect(c.home.parts.map((p: any) => p.id)).toEqual(['weather', 'pool', 'other']);
    expect(c.baseline).toEqual({ kind: 'weekday', days: 4 });   // the trip Tuesday is just a Tuesday to a guest
    expect(c).not.toHaveProperty('notes');
    expect(c).not.toHaveProperty('import');   // the owner's answer (2026-10-08): guests get the Used card only, nothing bought
    addsUp(c.home);
    const w = await (await get('/api/changed?scope=week&date=2026-09-28', preview)).json();
    expect(JSON.stringify(w)).not.toMatch(/trip|alwaysOn|"ac"|unexplained/);
    addsUp(w.home);
  });
  it('CHD-4 the week with the trip: the owner sees the trip part, and the digest carries the week', async () => {
    const c = await (await get('/api/changed?scope=week&date=2026-10-01', owner)).json();
    expect(c).toMatchObject({ scope: 'week', date: '2026-09-28', to: '2026-10-04', baseline: { kind: 'week', days: 7 } });
    expect(c.home.parts.find((p: any) => p.id === 'trip').kwh).toBeLessThan(-10);
    expect(c.notes).toContain('trip');
    addsUp(c.home);
    const { buildDigest } = await import('../../server/src/digest.js');
    const d = await buildDigest(S, '2026-09-28', NOW);
    expect(d.changed).toMatchObject({ scope: 'week', date: '2026-09-28', home: { delta: c.home.delta } });
  });
});
