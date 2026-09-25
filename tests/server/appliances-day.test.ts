// GET /api/appliances/day: the whole-home twin's day (mockup k-home-twin, docs/audit-designs/visualizations.md §3).
//
// Self-contained, following docs/audit-designs/tests.md: the in-process Express app on 127.0.0.1:0 driven with the real fetch,
// the real db.ts on in-memory PGlite (the server project's pure-mocks setup mocks db.js to throw; the vi.mock below restores the
// real module and wraps `q` in a spy so the test can count queries per table). ScreenLogic and Nest stay mocked by the pure-mocks
// setup file: their read functions throw, so the route would fail if it ever touched a device. All data is synthetic.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { acPhase, acKwFrom, buildDay, spanOf, type PoolRow } from '../../server/src/appliances/day.js';
import { AC_DEFAULTS } from '../../server/src/appliances/ac.js';

vi.mock('../../server/src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/db.js')>();
  return { ...real, q: vi.fn(real.q) };
});

const DAY = '2026-09-20';                                    // a past day, so the whole day counts (span 24); CDT = UTC−5
const at = (hh: number, mm = 0, day = DAY) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-05:00`);
const rfc = (hh: number, mm: number) => `${DAY}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-05:00`;

let server: Server, base = '', cookie = '';
let db: typeof import('../../server/src/db.js');

beforeAll(async () => {
  if (!String(process.env.DATABASE_URL).startsWith('pglite:')) throw new Error('these tests only run against PGlite');
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);

  // energy: 2 PM charging from the sun (6 kW solar, 3 kW home, 2.4 kW into the Powerwalls, 0.6 kW to PEC); 9 PM on the Powerwalls
  const e = (hh: number, mm: number, v: [number, number, number, number, number, number]) =>
    db.q(`INSERT INTO energy (site_id, ts, epoch, day, hour, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh) VALUES ('s', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [rfc(hh, mm), at(hh, mm), DAY, hh, ...v]);
  for (let m = 0; m < 60; m += 5) { await e(14, m, [500, 250, 0, 50, 200, 0]); await e(21, m, [0, 300, 0, 0, 0, 300]); }
  for (const [hh, mm, soe] of [[14, 0, 60], [14, 30, 64], [21, 0, 30]]) await db.q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) VALUES ('s', $1, $2, $3, $4, $5)`, [rfc(hh, mm), at(hh, mm), DAY, hh, soe]);

  // pool: readings at 9:15 and 9:30 (pump off) and 3:00 and 3:15 PM (1,500 rpm); the day before, enough readings for the power model
  // (median watts per rpm over all readings: 1,500 rpm → 150, 152, 154, 156, 160 → 154 W; 2,400 rpm → 700 W)
  const p = (ts: number, day: string, hour: number, running: boolean, watts: number, rpm: number) =>
    db.q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm, water_temp, air_temp, circuits) VALUES ('s', $1, $2, $3, $4, $5, $6, 80, 85, '[]')`, [ts, day, hour, running, watts, rpm]);
  await p(at(9, 15), DAY, 9, false, 0, 0); await p(at(9, 30), DAY, 9, false, 0, 0);
  await p(at(15, 0), DAY, 15, true, 156, 1500); await p(at(15, 15), DAY, 15, true, 160, 1500);
  for (const [i, w] of [150, 152, 154].entries()) await p(at(11, i * 15, '2026-09-19'), '2026-09-19', 11, true, w, 1500);
  for (let i = 0; i < 3; i++) await p(at(14, i * 15, '2026-09-19'), '2026-09-19', 14, true, 700, 2400);
  // the stored schedule: the last snapshot's pump programs. Pool 10a–7p @1500, High Speed 2p–3p @2400; freeze protection is ignored
  await db.kv.set('s:pool:last', { at: at(8), pump: { id: 1, circuits: [{ circuitId: 6, speed: 1500, isRpm: true }, { circuitId: 8, speed: 2400, isRpm: true }, { circuitId: 132, speed: 1000, isRpm: true }] },
    schedules: [{ id: 1, circuitId: 6, start: 600, stop: 1140 }, { id: 2, circuitId: 8, start: 840, stop: 900 }, { id: 3, circuitId: 132, start: 0, stop: 1439 }], circuits: [], bodies: [] });

  // Nest: 1 PM cooling at 74° (pre-cool), 6 PM off at 78° (coast), 9 PM cooling 10 of 12 samples at 76°, 11 PM off at 76° (night)
  const n = (hh: number, mm: number, hvac: string, cool: number, indoor: number) =>
    db.q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco) VALUES ('s', $1, $2, $3, $4, 48, 'COOL', $5, $6, NULL, false)`, [at(hh, mm), DAY, hh, indoor, hvac, cool]);
  for (let m = 0; m < 60; m += 5) {
    await n(13, m, 'COOLING', 74, 75); await n(18, m, 'OFF', 78, 76.5);
    await n(21, m, m < 50 ? 'COOLING' : 'OFF', 76, 76.2); await n(23, m, 'OFF', 76, 75.8);
  }
  await db.kv.set('s:ac:learned', { at: Date.now(), learned: { coolKw: 2.016, heatKw: null, samples: 9, heatSamples: 0 } });

  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port); // tests/setup.ts lets fetch reach only registered in-process servers
  base = `http://127.0.0.1:${port}`;
  const unlock = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) });
  expect(unlock.status).toBe(200);
  cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0];
}, 60_000); // a PGlite boot plus ~110 seeded rows; the server project's 10 s hook default is tight on a loaded machine
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie ? { cookie } : {} });

describe('GET /api/appliances/day', () => {
  it('DAY-1 is owner-only and checks the date', async () => {
    expect((await get(`/api/appliances/day?date=${DAY}`, false)).status).toBe(401);
    const bad = await get('/api/appliances/day?date=2026-9-20');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'date must be YYYY-MM-DD' });
  });

  it('DAY-2 returns 24 hours with the hourly energy means and SOC, one query per table, cached for a past day', async () => {
    const q = vi.mocked(db.q); q.mockClear();
    const r = await get(`/api/appliances/day?date=${DAY}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400');
    const sql = q.mock.calls.map(c => String(c[0]));
    for (const table of ['energy', 'soe', 'pool_readings', 'nest_readings', 'kv']) expect(sql.filter(s => new RegExp(`FROM ${table}\\b`).test(s)), table).toHaveLength(1);
    const d = await r.json();
    expect(d.date).toBe(DAY);
    expect(d.hours).toHaveLength(24);
    expect(d.hours.map((h: any) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(d.hours[14].energy).toEqual({ solarKw: 6, homeKw: 3, batteryKw: -2.4, gridKw: -.6, importKw: 0, exportKw: .6, soc: 62, buckets: 12 });
    expect(d.hours[21].energy).toEqual({ solarKw: 0, homeKw: 3.6, batteryKw: 3.6, gridKw: 0, importKw: 0, exportKw: 0, soc: 30, buckets: 12 });
    expect(d.hours[3].energy).toBeNull();
  });

  it('DAY-3 pool: measured where a reading covers the hour, else the stored schedule, with the day\'s coverage', async () => {
    const d = await (await get(`/api/appliances/day?date=${DAY}`)).json();
    expect(d.hours[9].pool).toEqual({ running: false, rpm: 0, watts: 0, meanKw: 0, source: 'measured' });
    // 15:00 and 15:15 measured (156, 160 W); 15:30 and 15:45 from the schedule at the measured 1,500-rpm median (154 W)
    expect(d.hours[15].pool).toEqual({ running: true, rpm: 1500, watts: 158, meanKw: .156, source: 'measured' });
    // no reading at 2 PM: the schedule says High Speed 2400 (its measured median 700 W) for the whole hour
    expect(d.hours[14].pool).toEqual({ running: true, rpm: 2400, watts: 700, meanKw: .7, source: 'schedule' });
    expect(d.hours[3].pool).toEqual({ running: false, rpm: 0, watts: 0, meanKw: 0, source: 'schedule' });   // freeze protection is not the pump schedule
    expect(d.hours[20].pool).toEqual({ running: false, rpm: 0, watts: 0, meanKw: 0, source: 'schedule' });
    expect(d.coverage.pool).toBeCloseTo(2 / 24, 3);
  });

  it('DAY-4 AC: on, phase, setpoint and indoor from the Nest readings, kW from the learned step; no eco or humidity served', async () => {
    const d = await (await get(`/api/appliances/day?date=${DAY}`)).json();
    expect(d.acKw).toBe(2.02);
    expect(d.hours[13].ac).toEqual({ on: true, phase: 'pre-cool', setpointF: 74, indoorF: 75, kw: 2.02, meanKw: 2.016 });
    expect(d.hours[18].ac).toEqual({ on: false, phase: 'coast', setpointF: 78, indoorF: 76.5, kw: 0, meanKw: 0 });
    expect(d.hours[21].ac).toEqual({ on: true, phase: 'cool', setpointF: 76, indoorF: 76.2, kw: 2.02, meanKw: 1.68 });
    expect(d.hours[23].ac).toEqual({ on: false, phase: 'idle', setpointF: 76, indoorF: 75.8, kw: 0, meanKw: 0 });
    expect(d.hours[2].ac).toBeNull();
    expect(d.coverage.nest).toBeCloseTo(4 / 24, 3);
    expect(JSON.stringify(d)).not.toMatch(/eco|humidity/);
  });

  it('DAY-5 a day with nothing stored has empty hours and zero coverage', async () => {
    const d = await (await get('/api/appliances/day?date=2026-09-01')).json();
    expect(d.coverage).toEqual({ pool: 0, nest: 0 });
    expect(d.hours.every((h: any) => h.energy === null && h.ac === null)).toBe(true);
    expect(d.hours[12].pool?.source).toBe('schedule');       // the stored schedule still answers "was the pump meant to run"
  });
});

describe('day.ts pure parts', () => {
  const S = AC_DEFAULTS;                                      // band 74–78 (middle 76), coast 78, night 22:00–07:00
  it.each([
    [true, 74, 13, 'pre-cool'], [true, 76, 13, 'cool'], [true, 74, 23, 'cool'], [true, null, 13, 'cool'],
    [false, 78, 18, 'coast'], [false, 76, 18, 'idle'], [false, 80, 18, 'idle'], [false, 78, 23, 'idle'],
  ] as const)('DAY-6 acPhase(on %s, %s°, %s h) → %s', (on, setpointF, hour, phase) => {
    expect(acPhase({ on, setpointF, hour, settings: S })).toBe(phase);
  });

  it('DAY-7 acKwFrom: learned step, else 1.3 × the heat-model slope within 2–5 kW', () => {
    expect(acKwFrom({ learned: { coolKw: 2.2 } }, { slope: 3 })).toBe(2.2);
    expect(acKwFrom({ learned: { coolKw: null } }, { slope: 3 })).toBeCloseTo(3.9, 6);
    expect(acKwFrom(null, null)).toBeCloseTo(3.25, 6);
    expect(acKwFrom(null, { slope: 6 })).toBe(5);
  });

  it('DAY-8 spanOf: 24 before today, the current Chicago hour + 1 today, 0 after', () => {
    const now = new Date('2026-09-25T19:40:00Z');             // 2:40 PM CDT
    expect(spanOf('2026-09-24', now)).toBe(24);
    expect(spanOf('2026-09-25', now)).toBe(15);
    expect(spanOf('2026-09-26', now)).toBe(0);
  });

  it('DAY-9 buildDay: the last applied plan stands in when there is no snapshot; no schedule and no reading → pool null; no schedule after now', () => {
    const base = { date: DAY, energy: [], soc: [], nest: [], settings: S, acKw: 2 };
    const applied = { plan: { schedules: [{ circuitId: 6, start: 600, stop: 1140, rpm: 1500 }] } };
    const pool: PoolRow[] = [{ ts: null, running: null, watts: 150, rpm: 1500, n: 3 }];
    const d = buildDay({ ...base, span: 24, pool, snapshot: null, applied });
    expect(d.hours[12].pool).toEqual({ running: true, rpm: 1500, watts: 150, meanKw: .15, source: 'schedule' });
    expect(buildDay({ ...base, span: 24, pool: [], snapshot: null, applied: null }).hours[12].pool).toBeNull();
    const today = buildDay({ ...base, span: 11, pool, snapshot: null, applied });
    expect(today.hours[10].pool?.source).toBe('schedule');
    expect(today.hours[11].pool).toBeNull();
  });

  it('DAY-10 the owner\'s comfort band moves the pre-cool / coast line', () => {
    const band = { ...S, band: { ...S.band, homeLo: 72, homeHi: 76 } }; // middle 74
    expect(acPhase({ on: true, setpointF: 74, hour: 13, settings: band })).toBe('cool');
    expect(acPhase({ on: false, setpointF: 76, hour: 18, settings: band })).toBe('coast');
  });
});
