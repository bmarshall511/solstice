// History "Where every kWh went" (server/src/flows.ts, GET /api/flows; mockups/m-flows.html, docs/audit-designs/visualizations.md §5):
// the one-statement split, measured vs estimated ribbons, the "unaccounted" residual, the pool and AC slices, a range across a DST
// change, and the owner-only route. It runs the real db.ts on its own in-memory PGlite (the server project mocks db.js for pure
// tests; this file opts back in, as sync-window.test.ts does). ScreenLogic and Nest stay mocked by pure-mocks.ts. Synthetic values only.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

vi.hoisted(() => { process.env.DATABASE_URL = 'pglite:memory://'; });   // never Neon, whatever the shell exports
vi.mock('../../server/src/db.js', async importOriginal => importOriginal());

import { q, kv, migrate } from '../../server/src/db.js';
import { saveEnergyRows } from '../../server/src/sync.js';
import { saveBill } from '../../server/src/bills.js';
import { localMidnight, rfc3339, addDays } from '../../server/src/tesla/client.js';
import { powerModel } from '../../server/src/appliances/pool.js';
import { flowsFor, daySpans, FLOWS_SQL, FlowsInputError } from '../../server/src/flows.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';

const NOW = Date.parse('2026-11-10T18:00:00Z');   // well after every seeded day, so each one is complete
const H = 3600e3;
/** Every 5-minute bucket start of a local day (276 on 2026-03-08, 300 on 2026-11-01, 288 otherwise). */
const stamps = (day: string) => {
  const out: string[] = [];
  for (let t = localMidnight(day).getTime(); t < localMidnight(addDays(day, 1)).getTime(); t += 300_000) out.push(rfc3339(new Date(t)));
  return out;
};
type Totals = { s: number | null; h: number | null; i: number | null; x: number | null; c: number | null; d: number | null };
/** Tesla's seven per-path Wh in FLOW_PATHS order: solar→home, solar→PW, solar→PEC, PEC→home, PEC→PW, PW→home, PW→PEC. */
type Split = [number, number, number, number, number, number, number];
const COLS = ['solar_home_wh', 'solar_battery_wh', 'solar_grid_wh', 'grid_home_wh', 'grid_battery_wh', 'battery_home_wh', 'battery_grid_wh'] as const;
const row = (ts: string, t: Totals, split?: Split) => ({
  ts, epoch: Date.parse(ts), day: ts.slice(0, 10), hour: +ts.slice(11, 13),
  solar: t.s as number, home: t.h as number, imp: t.i as number, exp: t.x as number, chg: t.c as number, dis: t.d as number,
  ...(split ? Object.fromEntries(COLS.map((c, k) => [c, split[k]])) : {}),
});
/** A bucket as Tesla sends it with splits: home 40, import 17, export 10, charge 32, discharge 5; solar_energy_exported 61. */
const TESLA: Totals = { s: 61, h: 40, i: 17, x: 10, c: 32, d: 5 };
const TESLA_SPLIT: Split = [20, 30, 10, 15, 2, 5, 0];
const seed = (site: string, rows: ReturnType<typeof row>[]) => saveEnergyRows(site, rows);
const ribbons = (f: Awaited<ReturnType<typeof flowsFor>>) => Object.fromEntries(f.ribbons.map(r => [r.id, r.kwh]));
/** The design's per-bucket estimate, written out in JS, for comparison with the SQL. */
function estimate(t: Totals) {
  const s = t.s ?? 0, h = t.h ?? 0, c = t.c ?? 0, d = t.d ?? 0;
  const solarHome = Math.min(s, h), solarBatt = Math.min(Math.max(s - solarHome, 0), c), solarGrid = Math.max(s - solarHome - solarBatt, 0);
  const battHome = Math.min(d, Math.max(h - solarHome, 0)), gridHome = Math.max(h - solarHome - battHome, 0);
  return { solarHome, solarBatt, solarGrid, gridHome, gridBatt: Math.max(c - solarBatt, 0), battHome, battGrid: Math.max(d - battHome, 0) };
}

beforeAll(async () => { await migrate(); });

describe('daySpans: real local day lengths', () => {
  it('23 h on the spring-forward day, 25 h on the fall-back day, 24 h otherwise; past days are whole', () => {
    expect(daySpans('2026-03-07', '2026-03-09', NOW).map(s => [s.day, s.lengthMs / H, s.elapsedMs / H, s.quarters]))
      .toEqual([['2026-03-07', 24, 24, 96], ['2026-03-08', 23, 23, 96], ['2026-03-09', 24, 24, 96]]);
    expect(daySpans('2026-10-31', '2026-11-02', NOW).map(s => s.lengthMs / H)).toEqual([24, 25, 24]);
  });
  it('today is cut at now (13:00 CDT → 52 quarter-hours), a later day has nothing elapsed', () => {
    const now = Date.parse('2026-09-25T18:00:00Z');
    expect(daySpans('2026-09-25', '2026-09-26', now).map(s => [s.elapsedMs / H, s.quarters])).toEqual([[13, 52], [0, 0]]);
  });
});

describe('measured path: Tesla\'s per-path columns on every bucket', () => {
  it('uses the stored splits, not the estimate, and marks no ribbon estimated', async () => {
    await seed('m', stamps('2026-09-20').map(ts => row(ts, TESLA, TESLA_SPLIT)));
    const f = await flowsFor('m', 'day', '2026-09-20', {}, NOW);
    expect([f.method, f.buckets, f.splitBuckets, f.days, f.dataDays]).toEqual(['measured', 288, 288, 1, 1]);
    expect(ribbons(f)).toEqual({ solarHome: 5.76, solarBatt: 8.64, solarGrid: 2.88, gridHome: 4.32, gridBatt: .58, battHome: 1.44, battGrid: 0 });
    expect(f.ribbons.every(r => !r.estimated)).toBe(true);
    expect(f.ribbons.map(r => `${r.from}>${r.to}`)).toEqual(['solar>home', 'solar>battery', 'solar>grid', 'grid>home', 'grid>battery', 'battery>home', 'battery>grid']);
    expect(f.totals).toEqual({ solar: 17.57, home: 11.52, import: 4.9, export: 2.88, charge: 9.22, discharge: 1.44 });
    expect([f.home.kwh, f.residual, f.unaccounted]).toEqual([11.52, { home: 0, export: 0 }, 0]);
    // the estimate from the same totals would have put 40 Wh a bucket on solar → home
    const [r] = await q(FLOWS_SQL, ['m', '2026-09-20', '2026-09-20']);
    expect(r.e_solarhome).toBe(40 * 288);
  });
});

describe('estimated path: any bucket without the splits', () => {
  it('splits the four totals bucket by bucket, COALESCEs NULL totals and marks every ribbon estimated', async () => {
    const [a, b, c] = stamps('2026-09-21').slice(144).reduce<string[][]>((g, ts, i) => (g[i % 3].push(ts), g), [[], [], []]);
    const SUN: Totals = { s: 60, h: 40, i: 17, x: 10, c: 32, d: 5 }, NIGHT: Totals = { s: 0, h: 30, i: 5, x: 0, c: 0, d: 25 };
    await seed('e', [...a.slice(0, 10).map(ts => row(ts, SUN, TESLA_SPLIT)), ...b.slice(0, 10).map(ts => row(ts, NIGHT)),
      row(c[0], { s: null, h: null, i: null, x: null, c: null, d: null })]);
    const f = await flowsFor('e', 'day', '2026-09-21', {}, NOW);
    expect([f.method, f.buckets, f.splitBuckets]).toEqual(['estimated', 21, 10]);
    // SUN: solar 40 → home, 20 → Powerwalls, PEC 12 → Powerwalls, Powerwalls 5 → PEC. NIGHT: Powerwalls 25 and PEC 5 → home.
    expect(ribbons(f)).toEqual({ solarHome: .4, solarBatt: .2, solarGrid: 0, gridHome: .05, gridBatt: .12, battHome: .25, battGrid: .05 });
    expect(f.ribbons.every(r => r.estimated)).toBe(true);
    expect(f.totals).toEqual({ solar: .6, home: .7, import: .22, export: .1, charge: .32, discharge: .3 });
    // the estimate places all of the home; 50 Wh of Tesla's 100 Wh export is not on a ribbon into PEC
    expect([f.residual, f.unaccounted]).toEqual([{ home: 0, export: .05 }, .05]);
  });

  it('the SQL matches the design\'s arithmetic on arbitrary buckets', async () => {
    let seedN = 7; const rnd = () => (seedN = (seedN * 16807) % (2 ** 31 - 1)) % 101;   // deterministic, 0–100 Wh
    const days = stamps('2026-09-22').slice(0, 60), totals = days.map(() => ({ s: rnd(), h: rnd(), i: rnd(), x: rnd(), c: rnd(), d: rnd() }));
    await seed('p', days.map((ts, k) => row(ts, totals[k])));
    const want = totals.map(estimate).reduce((a, e) => { for (const k in e) a[k] = (a[k] ?? 0) + e[k as keyof typeof e]; return a; }, {} as Record<string, number>);
    const [r] = await q(FLOWS_SQL, ['p', '2026-09-22', '2026-09-22']);
    for (const id of Object.keys(want)) expect(r[`e_${id.toLowerCase()}`], id).toBe(want[id]);   // exact Wh
    const f = await flowsFor('p', 'day', '2026-09-22', {}, NOW);
    for (const x of f.ribbons) expect(x.kwh, x.id).toBe(Math.round(want[x.id] / 10) / 100);
    // an estimate always places every kWh of solar, home, charge and discharge
    const sum = (ids: string[]) => ids.reduce((a, id) => a + want[id], 0), tot = (k: 's' | 'h' | 'c' | 'd') => totals.reduce((a, t) => a + (t[k] ?? 0), 0);
    expect([sum(['solarHome', 'solarBatt', 'solarGrid']), sum(['solarHome', 'battHome', 'gridHome']), sum(['solarBatt', 'gridBatt']), sum(['battHome', 'battGrid'])])
      .toEqual([tot('s'), tot('h'), tot('c'), tot('d')]);
  });
});

describe('unaccounted: Tesla\'s home and export totals beyond the ribbons into them', () => {
  const DAY = '2026-09-23';
  beforeAll(async () => {
    // 100 buckets with 5 Wh more home and 2 Wh more export than the splits place, 50 with 2 Wh less home, 138 exact
    await seed('u', stamps(DAY).map((ts, k) => row(ts, k < 100 ? { ...TESLA, h: 45, x: 12 } : k < 150 ? { ...TESLA, h: 38 } : TESLA, TESLA_SPLIT)));
    // pool: the fixture controller with one program, Pool 08:00–17:00 at 1,500 RPM, and no readings; AC: 30 min of COOLING at a learned 2 kW
    await kv.set('u:pool:last', poolSnapshot(NOW, { schedules: [{ id: 1, circuitId: 6, start: 480, stop: 1020, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 }] }));
    await kv.set('u:ac:learned', { at: Date.now(), learned: { coolKw: 2, heatKw: null, samples: 5, heatSamples: 0 } });
    const nest = stamps(DAY).map(ts => Date.parse(ts));
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac) SELECT 'u', t, $1, 0, CASE WHEN t >= $2 AND t < $3 THEN 'COOLING' ELSE 'OFF' END FROM unnest($4::bigint[]) t`,
      [DAY, Date.parse(`${DAY}T12:00:00-05:00`), Date.parse(`${DAY}T12:30:00-05:00`), nest]);
  });

  it('residual.home + residual.export, signed, in kWh', async () => {
    const f = await flowsFor('u', 'day', DAY, {}, NOW);
    expect(f.method).toBe('measured');
    expect(f.totals.home).toBe(11.92);                  // 288 × 40 + 100 × 5 − 50 × 2 Wh
    expect(f.home.kwh).toBe(11.52);                     // what the ribbons into the home place
    expect(f.residual).toEqual({ home: .4, export: .2 });
    expect(f.unaccounted).toBe(.6);
  });

  it('the home splits into pool (schedule × curve + UV lamp), AC (cooling time × kW) and the rest', async () => {
    const f = await flowsFor('u', 'day', DAY, {}, NOW), W = powerModel([]);
    expect(f.home.pool).toMatchObject({ source: 'schedule', coverage: 0, rpm: 1500, watts: Math.round(W(1500)) });
    expect(f.home.pool.kwh).toBeCloseTo((36 * W(1500) / 4 + 36 * 60 / 4) / 1000, 2);   // 36 quarter-hours at W(1500), UV lamp 60 W
    expect(f.home.ac).toMatchObject({ kwh: 1, source: 'readings', days: 1, readingDays: 1, modelDays: 0, acKw: 2, acKwSource: 'learned' });
    expect(f.home.rest).toBeCloseTo(f.home.kwh - f.home.pool.kwh - f.home.ac.kwh, 2);
  });

  it('pool readings covering the scheduled quarter-hours replace the schedule', async () => {
    const ts = Array.from({ length: 36 }, (_, k) => Date.parse(`${DAY}T08:00:00-05:00`) + k * 900_000 + 60_000);
    await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) SELECT 'u', t, $1, 0, true, 150, 1500 FROM unnest($2::bigint[]) t`, [DAY, ts]);
    const f = await flowsFor('u', 'day', DAY, {}, NOW);
    expect(f.home.pool).toMatchObject({ source: 'readings', coverage: 1 });
    expect(f.home.pool.kwh).toBeCloseTo((36 * 150 / 4 + 36 * 60 / 4) / 1000, 2);
    await q(`DELETE FROM pool_readings WHERE site_id = 'u'`);
  });

  it('days without Nest coverage use the heat model (pro rata today); the rest never goes below zero', async () => {
    await seed('h', stamps('2026-09-24').slice(0, 12).map(ts => row(ts, TESLA, TESLA_SPLIT)));   // one hour: 0.48 kWh of home
    await kv.set('h:ac:slope', { at: Date.now(), slope: 2 });
    await kv.set('wx:highs', { at: Date.now(), byDay: { '2026-09-24': 95 } });
    await kv.set('pool:forecast', { at: Date.now(), days: [{ date: '2026-09-25', high: 90 }] });
    const past = await flowsFor('h', 'day', '2026-09-24', {}, NOW);
    expect(past.home.ac).toMatchObject({ kwh: 30, source: 'heat-model', modelDays: 1, readingDays: 0, slope: 2 });   // 2 × (95 − 80)
    expect(past.home.pool).toMatchObject({ kwh: 0, source: 'none' });
    expect(past.home.rest).toBe(0);                                                                             // 0.48 − 30 floors at 0
    const noon = Date.parse('2026-09-25T17:00:00Z');                                                            // 12:00 CDT: half the day
    expect((await flowsFor('h', 'day', '2026-09-25', {}, noon)).home.ac.kwh).toBe(10);                          // 2 × (90 − 80) × ½
  });
});

describe('a month across the fall-back change', () => {
  it('counts all 300 buckets of 2026-11-01 and keeps the 30-day window', async () => {
    for (const d of ['2026-10-31', '2026-11-01', '2026-11-02']) await seed('dst', stamps(d).map(ts => row(ts, TESLA, TESLA_SPLIT)));
    const f = await flowsFor('dst', 'month', '2026-11-02', {}, NOW);
    expect([f.from, f.to, f.days, f.dataDays, f.buckets, f.method]).toEqual(['2026-10-04', '2026-11-02', 30, 3, 288 + 300 + 288, 'measured']);
    expect(f.totals.solar).toBe(53.44);                // 61 Wh × 876 buckets
    expect(ribbons(f).solarHome).toBe(20 * 876 / 1000);
    expect((await flowsFor('dst', 'day', '2026-11-01', {}, NOW)).buckets).toBe(300);
  });

  it('and the spring-forward day holds 276 buckets', async () => {
    await seed('dst', stamps('2026-03-08').map(ts => row(ts, TESLA)));
    const f = await flowsFor('dst', 'day', '2026-03-08', {}, NOW);
    expect([f.buckets, f.method, f.days]).toEqual([276, 'estimated', 1]);
    expect(f.totals.home).toBe(40 * 276 / 1000);
  });

  it('an empty range answers method none with zero ribbons', async () => {
    const f = await flowsFor('nobody', 'month', '2026-11-02', {}, NOW);
    expect([f.method, f.buckets, f.unaccounted, f.home.kwh]).toEqual(['none', 0, 0, 0]);
    expect(f.ribbons.every(r => r.kwh === 0)).toBe(true);
  });

  it('rejects a bad range or date', async () => {
    await expect(flowsFor('m', 'week', undefined, {}, NOW)).rejects.toBeInstanceOf(FlowsInputError);
    await expect(flowsFor('m', 'day', '2026-02-30', {}, NOW)).rejects.toBeInstanceOf(FlowsInputError);
    await expect(flowsFor('m', 'day', 'yesterday', {}, NOW)).rejects.toBeInstanceOf(FlowsInputError);
  });
});

describe('GET /api/flows (owner-only)', () => {
  let server: Server, base = '', cookie = '';
  beforeAll(async () => {
    const { app } = await import('../../server/src/app.js');
    const [acct] = await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'test-a', 'test-r', 0) RETURNING id`);
    await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('m', NULL, $1, 'Test home')`, [acct.id]);
    await saveBill('m', { utility: 'PEC', billDate: '2026-09-01', dueDate: null, period: { from: '2026-08-01', to: '2026-08-31', days: 31 }, deliveredKwh: 100, receivedKwh: 10,
      total: 20, charges: [], tariff: { importRate: .1, importRateAllIn: .1, exportCredit: .05, fixedMonthly: null, discounts: 0, franchisePct: null } });
    server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    (globalThis as any).__testServerPorts.add(port);
    base = `http://127.0.0.1:${port}`;
    const unlock = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) });
    expect(unlock.status).toBe(200);
    cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0];
  });
  afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

  it('answers 401 without the owner cookie', async () => {
    expect((await fetch(`${base}/api/flows?range=day&date=2026-09-20`)).status).toBe(401);
  });
  it('answers the flows with the learned rate, and 400 for a bad range or date', async () => {
    const r = await fetch(`${base}/api/flows?range=day&date=2026-09-20`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const f = await r.json();
    expect(Object.keys(f)).toEqual(['range', 'from', 'to', 'days', 'dataDays', 'buckets', 'splitBuckets', 'method', 'ribbons', 'totals', 'residual', 'unaccounted', 'home', 'rate', 'money']);
    expect([f.method, f.ribbons.length, f.rate]).toEqual(['measured', 7, { importRateAllIn: .1, exportCredit: .05 }]);
    expect(f.money).toEqual({ importUsd: .49, exportCreditUsd: .14 });   // 4.9 kWh × .1, 2.88 kWh × .05
    expect((await fetch(`${base}/api/flows?range=week`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/api/flows?range=day&date=2026-13-01`, { headers: { cookie } })).status).toBe(400);
  });
});
