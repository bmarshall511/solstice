// The guest redaction layer (share view, server side; docs/audit-designs/share-view.md §1.3 and §3.3): every guest read goes
// through its route's allow-list view in server/src/redact.ts, and anything without a view is refused before its handler runs.
//   RED-1..4   the view helpers on their own (no database)
//   RED-5      every guest-readable route, against a deliberately leaky seed: the owner's response shows the private values
//              (so the check can see them), the guest's shows none of the deny-list
//   RED-6      history is hourly for guests: no five-minute bucket reaches them, and no energy is lost in the sum
//   RED-7..8   the bill skeleton; the AC card with no occupancy (presence forced home at the source, fresh reads ignored)
//   RED-9..10  every write route answers 401 to a guest and changes nothing; every read without a view answers 401 to a
//              guest and to the owner previewing
//
// Self-contained, following docs/audit-designs/tests.md and tests/server/auth.test.ts: the in-process Express app on
// 127.0.0.1:0 driven with the real fetch, PGlite in memory, no network (Tesla sync and Nest are mocked; ScreenLogic is
// stubbed by tests/server/pure-mocks.ts). Every value is synthetic, including the "private" ones the seed plants.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Response as ExpressResponse } from 'express';
import { poolSnapshot } from '../fixtures/screenlogic.js';
import { nestState } from '../fixtures/nest.js';
import { PEC_BILL } from '../fixtures/pec-bill.js';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}),
  // Tesla's errors carry the site id in the URL: a guest must only ever see a fixed string
  refreshLive: vi.fn(async () => { throw new Error('Tesla HTTP 500 on /api/1/energy_sites/7654321/live_status'); }),
}));
vi.mock('../../server/src/appliances/nest.js', async orig => {
  const real = await orig<typeof import('../../server/src/appliances/nest.js')>();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in redaction test`); });
  return { ...real, nestConfigured: () => true, nestLinked: vi.fn(async () => true),
    readNest: vi.fn(async () => { throw new Error('Nest: enterprises/test-project/devices/dev-test is unreachable'); }),
    nestExchangeCode: blocked('nestExchangeCode'), setCool: blocked('setCool'), setHeat: blocked('setHeat'), setMode: blocked('setMode'), setEco: blocked('setEco') };
});

const KEY = 'test-owner-key-synthetic-redact-abcdefghij-kl';   // test-only
const SHARE_LABEL = 'Neighbor Test Label';
let server: Server, base = '', owner = '', guest = '', preview = '';
let app: typeof import('../../server/src/app.js')['app'];
let db: typeof import('../../server/src/db.js');
let redact: typeof import('../../server/src/redact.js');
let nest: typeof import('../../server/src/appliances/nest.js');
let screenlogic: typeof import('../../server/src/appliances/screenlogic.js');
let today = '', yesterday = '';

type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie, json, ...rest } = init;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers as Record<string, string> ?? {}) };
  return fetch(base + path, { redirect: 'manual', ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const pair = (r: Response, name: string) => (r.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? '').split(';')[0];
const getJson = async (path: string, cookie: string) => { const r = await call(path, { cookie }); expect(r.status, `${path} as ${cookie.split('=')[0] || 'nobody'}`).toBe(200); return r.json(); };

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('redaction tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij',
    SITE_LAT: '12.34567', SITE_LON: '-56.78912', SITE_ZIP: '12345' });   // synthetic: the exact form the owner gets
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  ({ app } = await import('../../server/src/app.js'));
  db = await import('../../server/src/db.js');
  redact = await import('../../server/src/redact.js');
  nest = await import('../../server/src/appliances/nest.js');
  screenlogic = await import('../../server/src/appliances/screenlogic.js');
  await db.migrate();
  await seed();
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port); // the fetch guard in tests/setup.ts allows only registered in-process servers
  base = `http://127.0.0.1:${port}`;
  const unlock = await call('/api/auth/owner', { json: { key: KEY }, headers: { 'X-Real-IP': '198.18.0.1' } });
  owner = pair(unlock, 'solstice_owner');
  const link = await (await call('/api/share', { cookie: owner, json: { label: SHARE_LABEL } })).json();
  guest = pair(await call('/api/auth/guest', { json: { token: link.token }, headers: { 'X-Real-IP': '198.18.0.2' } }), 'solstice_guest');
  preview = `${owner}; ${pair(await call('/api/auth/preview', { cookie: owner, json: { on: true } }), 'solstice_preview')}`;
  expect([owner, guest, preview].every(Boolean)).toBe(true);
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

/** A leaky site: serials, DINs, firmware, a family name, a parsed bill with its tariff, the owner's system price and loan,
 *  presence away, a Nest device path, notes, a pool controller version, and five-minute history. */
async function seed() {
  const { saveEnergyRows, saveSoe } = await import('../../server/src/sync.js');
  const { localDay, addDays } = await import('../../server/src/tesla/client.js');
  const { saveBill, parsePecText } = await import('../../server/src/bills.js');
  const { planFor, powerModel, POOL_DEFAULTS } = await import('../../server/src/appliances/pool.js');
  today = localDay(); yesterday = addDays(today, -1);
  const now = Date.now(), pad = (n: number) => String(n).padStart(2, '0'), ts = (day: string, h: number, m: number) => `${day}T${pad(h)}:${pad(m)}:00-05:00`;
  const fives = (day: string, h: number, n: number, wh: { solar: number; home: number; imp: number; exp: number; chg: number; dis: number }) =>
    Array.from({ length: n }, (_, i) => ({ ts: ts(day, h, i * 5), epoch: Date.parse(ts(day, h, i * 5)), day, hour: h, ...wh }));
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info) VALUES ('s', NULL, 1, 'Test Family Home', $1)`, [JSON.stringify({
    site_name: 'Test Family Home', installation_date: '2026-01-15T00:00:00-06:00', battery_count: 2, nameplate_energy: 27000, nameplate_power: 10000,
    backup_reserve_percent: 20, default_real_mode: 'self_consumption', user_settings: { storm_mode_enabled: true }, version: '26.0.0 test-build',
    utility: 'Test Utility Co-op', din: 'TEST-DIN-GATEWAY', serial_number: 'TEST-SERIAL-GATEWAY', gateway_id: 'TEST-GW-ID',
    components: { batteries: [1, 2].map(i => ({ part_name: 'Powerwall 2', nameplate_energy: 13500, nameplate_max_discharge_power: 5000, serial_number: `TEST-SERIAL-PW${i}`, din: `TEST-DIN-PW${i}` })) },
  })]);
  await db.q(`INSERT INTO readings (site_id, ts, solar_w, battery_w, grid_w, load_w, soc, grid_status, island_status, storm_mode_active) VALUES ('s', $1, 5000, -1000, 0, 4000, 64, 'Active', 'on_grid', false)`, [now]);
  await saveEnergyRows('s', [
    ...fives(today, 10, 12, { solar: 500, home: 300, imp: 0, exp: 100, chg: 100, dis: 0 }),
    ...fives(today, 11, 6, { solar: 400, home: 250, imp: 0, exp: 50, chg: 100, dis: 0 }),      // a partial hour
    ...fives(yesterday, 13, 12, { solar: 600, home: 350, imp: 0, exp: 150, chg: 100, dis: 0 }),
    ...fives(yesterday, 21, 12, { solar: 0, home: 400, imp: 50, exp: 0, chg: 0, dis: 350 }),
  ]);
  await saveSoe('s', [0, 15, 30, 45].map((m, i) => ({ timestamp: ts(today, 10, m), soe: 60 + i })));
  await db.q(`INSERT INTO backup_events (site_id, ts, epoch, duration_s) VALUES ('s', '2026-05-01T14:37:00-05:00', $1, 1800)`, [Date.parse('2026-05-01T14:37:00-05:00')]);
  await saveBill('s', parsePecText(PEC_BILL));
  await db.q(`INSERT INTO events (site_id, type, day, note) VALUES ('s', 'cleaned', $1, 'secret note about the roof'), ('s', 'note', $1, 'private note text'), ('s', 'filter_cleaned', $2, NULL)`, [yesterday, today]);
  const plan = planFor({ waterTemp: 85, solarKw: Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 18 ? 5 : 0)), settings: POOL_DEFAULTS, W: powerModel([]), rate: 0.1, month: 8, names: new Map() });
  const kvs: Record<string, unknown> = {
    'settings:owner': { calm: true, alerts: { solar: false }, system: { priceUsd: 20000, taxCreditPct: 30, loanYears: 10, loanRatePct: 5 },
      pool: { propaneUsdPerGal: 3 }, ac: { presence: 'away', autopilot: 'suggest' } },
    's:lastLive': now, 's:lastHistory': now,
    's:error:siteInfo': { at: now, message: 'GET /api/1/energy_sites/7654321/site_info: HTTP 504' },
    ercot: { at: now, data: { condition: 'normal', title: 'Normal Conditions', note: null, eea: 0, demandMw: 50000, capacityMw: 70000, at: '2026-09-25 12:00:00' } },
    'pool:forecast': { at: now, days: Array.from({ length: 11 }, (_, i) => ({ date: addDays(today, i - 3), high: 96, rainMm: 0, rainPct: 10, sunKwhM2: 6.5,
      hourlySun: Array.from({ length: 24 }, (_, h) => Math.round(Math.max(0, Math.sin((h - 6) / 14 * Math.PI)) * 90) / 100) })) },
    's:pool:last': poolSnapshot(now),
    's:pool:autolog': [{ at: now, day: today, text: 'Suggested for tomorrow: 6 h. season plan', delta: 'waiting for you' }],
    's:pool:pending': { date: addDays(today, 1), plan, why: ['season plan'] },
    's:pool:applied': { at: now, plan: { start: plan.start, stop: plan.stop, boostAt: plan.boostAt, schedules: plan.schedules }, removed: [{ circuitId: 6, start: 480, stop: 1020, dayMask: 127 }], added: [], previousSpeeds: [{ circuitId: 6, speed: 1800, isRpm: true }] },
    'nest:last': nestState(now, { deviceId: 'enterprises/test-project/devices/dev-test', name: 'Test Family Hallway', eco: true, ecoCoolF: 82 }),
    's:ac:log': [{ at: now, day: today, text: 'Set 80° (marked away)' }, { at: now, day: today, text: 'Set 76° (morning, comfort band)' }],
    's:ac:plan': { date: today, approved: true, lastStepHour: 7 },
    's:ac:slope': { at: now, slope: 2.5 },
  };
  for (const [k, v] of Object.entries(kvs)) await db.kv.set(k, v);
}

/* ---------- the deny-list, applied to a whole response ---------- */
const DENY_KEY = /account|source|tariff|rate|price|loan|payback|serial|deviceid|device_id|projectid|project_id|siteid|site_id|firmware|gateway|token|hash/i;
const DENY_EXACT = /^(din|version|utility|eco|ecoCoolF|ecoHeatF)$/i;
const MONEY_END = /(cost|usd|dollars)$/i;
const MONEY_ANY = /cost|usd|dollar|saves|payment/i;                     // present only as null, { veiled: true } or []
const DENY_TEXT = [/\$\s?\d/, /energy_sites/, /enterprises\//, /marked away|\baway:/i, /Test Family/, /TEST-(SERIAL|DIN|GW)/, /test-build/, /Build 000/,
  /Test Utility/, /secret note|private note/, new RegExp(SHARE_LABEL), /12\.34567|56\.78912/];
const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
const veiled = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0) || (JSON.stringify(v) === '{"veiled":true}');
/** Every way this value leaks, as "path: reason". Empty means clean. */
function leaks(v: unknown, path = '$'): string[] {
  if (typeof v === 'string') return DENY_TEXT.filter(re => re.test(v)).map(re => `${path}: text ${re}`);
  if (Array.isArray(v)) return v.flatMap((x, i) => leaks(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => {
    const p = `${path}.${k}`, out: string[] = [];
    if (DENY_KEY.test(k) || DENY_EXACT.test(k) || MONEY_END.test(k)) out.push(`${p}: denied key`);
    if (MONEY_ANY.test(k) && !veiled(x)) out.push(`${p}: money not veiled`);
    if (/^(lat|latitude|lon|lng|longitude)$/i.test(k) && typeof x === 'number' && decimals(x) > 1) out.push(`${p}: coordinate finer than 0.1°`);
    if (/zip/i.test(k) && /\d{5}/.test(String(x))) out.push(`${p}: 5-digit ZIP`);
    if (k === 'presence' && x !== null) out.push(`${p}: presence`);
    if (k === 'label' && path === '$' && x !== null) out.push(`${p}: share label`);
    if (k === 'id' && !['pool', 'ac'].includes(x as string)) out.push(`${p}: row or device id`);
    return [...out, ...leaks(x, p)];
  });
}
/** Query strings for routes whose defaults would say little. */
const QUERY: Record<string, string> = { '/api/day': `?date=${'TODAY'}`, '/api/daily': '?days=30', '/api/whatif': '?panels=8&powerwalls=1&extra=2', '/api/grid-days': '?days=7' };
const urlFor = (path: string) => path + (QUERY[path] ?? '').replace('TODAY', today);
/** The routes the Express app serves, from its router: [method, path]. */
function routes(): Array<[string, string]> {
  const stack = (app as any).router?.stack ?? (app as any)._router?.stack;
  return stack.filter((l: any) => l.route).flatMap((l: any) => Object.keys(l.route.methods).filter(m => m !== '_all').map(m => [m.toUpperCase(), l.route.path]));
}
const OPEN = new Set(['POST /api/auth/owner', 'POST /api/auth/guest', 'POST /api/auth/leave', 'GET /api/auth/me', 'GET /api/cron/sync', 'GET /api/cron/pool', 'GET /api/cron/nest', 'GET /auth/callback', 'GET /auth/google/callback']);

/* ======================= RED-1..4: the helpers ======================= */
describe('view helpers', () => {
  it('RED-1 pick keeps only named keys, refuses unnamed objects, and veils by kind', () => {
    const { pick } = redact;
    expect(pick({ a: 1, b: 2, c: { d: 3 } }, { a: true, c: { d: true } })).toEqual({ a: 1, c: { d: 3 } });
    expect(pick({ a: { secret: 1 } }, { a: true })).toEqual({ a: null });                        // fail closed: an object needs its fields listed
    expect(pick({ a: [1, [2, 3]], b: [{ x: 1 }] }, { a: true, b: true })).toEqual({ a: [1, [2, 3]], b: null });
    expect(pick({ m: 12.5, o: { x: 1 }, l: [1], n: null }, { m: 'veil', o: 'veil', l: 'veil', n: 'veil' })).toEqual({ m: null, o: { veiled: true }, l: [], n: null });
    expect(pick({ a: 1 }, { a: true, missing: true })).toEqual({ a: 1 });                          // absent stays absent
    expect(pick({ list: 'not a list', obj: 5 }, { list: [true], obj: { x: true } })).toEqual({ list: null, obj: null });
    expect(pick([{ id: 1, v: 2 }], [{ v: true }])).toEqual([{ v: 2 }]);
    expect(redact.fixed('Home')('Test Family Home')).toBe('Home');
    expect(redact.fixed('Home')(null)).toBeNull();
  });

  it('RED-2 hourlyDay sums five-minute kW into hourly energy; t is a whole hour', () => {
    const buckets = [...Array.from({ length: 12 }, (_, i) => ({ t: 10 + i * 5 / 60, solar: 6, home: 3.6, grid: -1.2, battery: -1.2 })),
      ...Array.from({ length: 6 }, (_, i) => ({ t: 11 + i * 5 / 60, solar: 4.8, home: 3, grid: 0, battery: 0 }))];
    const d = redact.hourlyDay({ date: '2026-09-24', buckets, soe: [{ t: 10, soc: 60 }, { t: 10.25, soc: 61 }, { t: 10.5, soc: 62 }, { t: 11.75, soc: 70 }],
      totals: { solar: 8.4, home: 5.1, import: 0, export: 1.2, charge: 1.2, discharge: 0, secret: 1 } });
    expect(d).toEqual({ date: '2026-09-24', bucketMinutes: 60,
      buckets: [{ t: 10, solar: 6, home: 3.6, grid: -1.2, battery: -1.2 }, { t: 11, solar: 2.4, home: 1.5, grid: 0, battery: 0 }],
      soe: [{ t: 10, soc: 61 }, { t: 11, soc: 70 }], totals: { solar: 8.4, home: 5.1, import: 0, export: 1.2, charge: 1.2, discharge: 0 } });
    expect(redact.hourlyDay({})).toEqual({ date: null, bucketMinutes: 60, buckets: [], soe: [], totals: null });
  });

  it('RED-3 guestBills keeps month, period, kWh and the meter check, nothing else', () => {
    const row = { billDate: '2026-09-15', period: { from: '2026-08-12', to: '2026-09-11', days: 30, meterNo: 'M-1' }, total: 137.39, tariff: { importRateAllIn: 0.1 },
      charges: [{ label: 'Energy Charge', amount: 86.4 }], pec: { deliveredKwh: 1200, receivedKwh: 300, lastYearKwh: 1500 }, tesla: { importKwh: 1190 },
      checks: [{ id: 'meter', ok: true, label: 'Meter matches Tesla', detail: 'x' }, { id: 'math', ok: false, label: 'Bill adds up', detail: 'Line items sum to $137.39.' }],
      withoutSolarCost: 200 };
    expect(redact.guestBills([row])).toEqual([{ month: '2026-09', period: { from: '2026-08-12', to: '2026-09-11', days: 30 }, deliveredKwh: 1200, receivedKwh: 300,
      checks: { meterMatchesTesla: true } }]);
    expect(redact.guestBills([{ ...row, checks: [{ id: 'meter', ok: false }] }])[0].checks).toEqual({ meterMatchesTesla: false });
    expect(redact.guestBills(null)).toEqual([]);
  });

  it('RED-4 serveThrough: error bodies become a fixed string; a view that throws is a 500, never the raw body', () => {
    const fake = () => { const sent: unknown[] = []; const res: any = { statusCode: 200, json(b: unknown) { sent.push(b); return res; }, status(c: number) { res.statusCode = c; return res; } }; return { res, sent }; };
    const a = fake(); redact.serveThrough(a.res as ExpressResponse, b => ({ kept: (b as any).x })); a.res.json({ x: 1, y: 2 });
    expect(a.sent).toEqual([{ kept: 1 }]);
    const b = fake(); redact.serveThrough(b.res as ExpressResponse, x => x); b.res.statusCode = 500; b.res.json({ error: 'GET /api/1/energy_sites/7654321: 500' });
    expect(b.sent).toEqual([{ error: 'unavailable' }]);
    const c = fake(); vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    redact.serveThrough(c.res as ExpressResponse, () => { throw new Error('boom'); }); c.res.json({ secret: 1 });
    expect(c.sent).toEqual([{ error: 'unavailable' }]);
    expect(c.res.statusCode).toBe(500);
  });
});

/* ======================= RED-5..10: the routes ======================= */
describe('every guest-readable route', () => {
  it('RED-5 the owner sees the seed\'s private values; the guest (and the owner previewing) sees none of the deny-list', async () => {
    const getRoutes = new Set(routes().filter(([m]) => m === 'GET').map(([, p]) => p.toLowerCase()));
    expect([...redact.GUEST_GET.keys()].filter(p => !getRoutes.has(p)), 'views for routes that do not exist').toEqual([]);
    const paths = ['/api/auth/me', ...redact.GUEST_GET.keys()];               // /api/auth/me is open, and built per role at the source
    // /api/appliances is not in this set: since the learning layer the AC row's savesPerMonth is null at the source (no dollar
    // savings figure), and the pool is not configured here, so the owner's list holds nothing private to plant. Its view is
    // checked against a leaky body directly in RED-5c, and the guest's response still runs through the deny-list below.
    const ownerLeaky = new Set(['/api/auth/me', '/api/settings', '/api/now', '/api/status', '/api/reconcile', '/api/events', '/api/whatif', '/api/appliances/pool', '/api/appliances/ac']);
    const report: Record<string, string[]> = {};
    for (const path of paths) {
      const asOwner = await getJson(urlFor(path), owner), asGuest = await getJson(urlFor(path), guest), asPreview = await getJson(urlFor(path), preview);
      if (ownerLeaky.has(path)) expect(leaks(asOwner).length, `the seed plants nothing private in ${path}`).toBeGreaterThan(0);
      report[path] = [...leaks(asGuest), ...leaks(asPreview).map(l => `preview ${l}`)];
    }
    expect(report).toEqual(Object.fromEntries(paths.map(p => [p, []])));
  });

  it('RED-5b what the guest does get: the shape the views read, with money veiled and names fixed', async () => {
    const now = await getJson('/api/now', guest);
    expect(now.site.name).toBe('Home');
    expect(now.site).not.toHaveProperty('firmware');
    expect(now.site.batteries).toEqual([{ name: 'Powerwall 2', kwh: 13.5, kw: 5 }, { name: 'Powerwall 2', kwh: 13.5, kw: 5 }]);
    expect(now.health.liveError).toBe('unavailable');
    expect(now.health.errors.siteInfo).toEqual({ at: expect.any(Number), message: 'unavailable' });
    expect(now.reading).toMatchObject({ solarKw: 5, homeKw: 4, soc: 64 });
    expect(await getJson('/api/settings', guest)).toEqual({ location: { lat: 12.3, lon: -56.8, zip: '123xx', precision: 'coarse' } });
    expect(await getJson('/api/status', guest)).toEqual({ connected: true, lastLive: expect.any(Number), lastHistory: expect.any(Number), backfill: { daysDone: 2 } });
    expect(await getJson('/api/events', guest)).toEqual([{ type: 'filter_cleaned', day: today }, { type: 'cleaned', day: yesterday }]);
    const w = await getJson('/api/whatif?panels=8', guest);
    expect(w.system).toEqual({ veiled: true });
    expect(w.savesPerYear).toBeNull();
    expect(w.assumptions).toEqual({ panelW: 400, dollarsPerW: null });
    expect(Object.keys(w.baseline).sort()).toEqual(['batteryFullDays', 'exportKwh', 'homeKwh', 'importKwh', 'selfPowered', 'solarKwh']);
    const pool = await getJson('/api/appliances/pool', guest);
    expect(pool.current.costPerMonth).toBeNull();
    expect(pool.plan.costPerMonth).toBeNull();
    expect(pool.seasons.every((s: any) => s.costPerMonth === null)).toBe(true);
    expect(pool.pending.plan.costPerMonth).toBeNull();
    expect(pool.spaSession.electricUsdPerHour).toBeNull();
    expect(pool.spaSession).not.toHaveProperty('propaneUsd');
    expect(pool.snapshot).toEqual({ at: expect.any(Number), airTemp: 85, freezeMode: false, bodies: [{ temp: 88, setPoint: 0, heating: false }, { temp: 95, setPoint: 102, heating: false }] });
    expect(pool.applied).toEqual({ at: expect.any(Number) });
    expect(pool.settings).toEqual({ gallons: 14995, spaGallons: 1000, designGpm: 120, filterRpm: 1500, boostRpm: 2400, uv: true, autopilot: 'suggest' });
    for (const k of ['rate', 'todayCost']) expect(pool).not.toHaveProperty(k);
    const ownerPool = await getJson('/api/appliances/pool', owner);
    expect(ownerPool.rate).toBeGreaterThan(0);                               // the seed's bill gives the owner a rate
    expect(ownerPool.current.costPerMonth).not.toBeNull();
  });

  it('RED-5c the /api/appliances view veils savings and error text, and drops every unnamed key, on a leaky body', () => {
    const v = redact.GUEST_GET.get('/api/appliances')!;
    const body = [{ id: 'pool', name: 'Pool pump', status: 'linked', watts: 900, kwhPerDay: 7.2, savesPerMonth: 12.5, source: 'ScreenLogic', serial: 'TEST-SERIAL-POOL' },
      { id: 'ac', name: 'AC', status: 'estimated', watts: null, kwhPerDay: null, savesPerMonth: null, error: 'Nest: enterprises/test-project/devices/dev-test is unreachable' }];
    expect(leaks(body).length, 'the body is leaky').toBeGreaterThan(0);
    const out = v(body);
    expect(leaks(out)).toEqual([]);
    expect(out).toEqual([{ id: 'pool', name: 'Pool pump', status: 'linked', watts: 900, kwhPerDay: 7.2, savesPerMonth: null },
      { id: 'ac', name: 'AC', status: 'estimated', watts: null, kwhPerDay: null, savesPerMonth: null, error: 'unavailable' }]);
  });
});

describe('history is hourly for guests', () => {
  it('RED-6 /api/day: whole hours only, no five-minute bucket, and the energy adds up to the owner\'s', async () => {
    for (const date of [today, yesterday]) {
      const o = await getJson(`/api/day?date=${date}`, owner), g = await getJson(`/api/day?date=${date}`, guest);
      expect(o.buckets.some((b: any) => !Number.isInteger(b.t)), 'the owner still gets five-minute buckets').toBe(true);
      expect(g.bucketMinutes).toBe(60);
      expect(g.buckets.every((b: any) => Number.isInteger(b.t)) && g.soe.every((s: any) => Number.isInteger(s.t))).toBe(true);
      expect(g.buckets.length).toBeLessThanOrEqual(25);
      expect(new Set(g.buckets.map((b: any) => b.t)).size).toBe(g.buckets.length);
      for (const k of ['solar', 'home'] as const) {
        const ownerKwh = o.buckets.reduce((a: number, b: any) => a + b[k] / 12, 0), guestKwh = g.buckets.reduce((a: number, b: any) => a + b[k], 0);
        expect(guestKwh).toBeCloseTo(ownerKwh, 1);
        expect(guestKwh).toBeCloseTo(g.totals[k], 1);
      }
      expect(g.totals).toEqual(o.totals);
    }
    const g = await getJson(`/api/day?date=${today}`, guest);
    expect(g.buckets).toEqual([{ t: 10, solar: 6, home: 3.6, grid: -1.2, battery: -1.2 }, { t: 11, solar: 2.4, home: 1.5, grid: -0.3, battery: -0.6 }]);
    expect(g.soe).toEqual([{ t: 10, soc: 61.5 }]);
    // the other history routes are hourly or daily by construction: no time of day with minutes in any of them
    for (const path of ['/api/daily?days=30', '/api/monthly', '/api/profile', '/api/grid-days?days=7', '/api/overnight', `/api/day?date=${today}`]) {
      const text = JSON.stringify(await getJson(path, guest));
      expect(text, path).not.toMatch(/T\d\d:\d\d/);
      expect(text, path).not.toMatch(/"t":\d+\.\d/);
    }
    const profile = await getJson('/api/profile', guest), grid = await getJson('/api/grid-days?days=7', guest);
    expect(profile.hours.every((h: any) => Number.isInteger(h.hour))).toBe(true);
    expect(grid.solar.every((d: unknown[]) => d.length === 24)).toBe(true);
  });
});

describe('bills and the AC card', () => {
  it('RED-7 /api/reconcile is the bill skeleton for guests; the owner still gets the full check', async () => {
    const o = await getJson('/api/reconcile', owner), g = await getJson('/api/reconcile', guest);
    expect(o[0]).toHaveProperty('total');
    expect(o[0].tariff.importRateAllIn).toBeGreaterThan(0);
    expect(g).toEqual([{ month: o[0].billDate.slice(0, 7), period: { from: o[0].period.from, to: o[0].period.to, days: o[0].period.days },
      deliveredKwh: o[0].pec.deliveredKwh, receivedKwh: o[0].pec.receivedKwh, checks: { meterMatchesTesla: o[0].checks.find((c: any) => c.id === 'meter').ok } }]);
  });

  it('RED-8 AC: the plan is computed as if home, presence and Eco never leave, the away log lines are gone, fresh reads are the owner\'s', async () => {
    await db.kv.set('nest:last', nestState(Date.now(), { deviceId: 'enterprises/test-project/devices/dev-test', name: 'Test Family Hallway', eco: true, ecoCoolF: 82 }));   // fresh, so only ?fresh=1 reads
    const o = await getJson('/api/appliances/ac', owner), g = await getJson('/api/appliances/ac', guest);
    expect(o.settings.presence).toBe('away');
    expect(o.plan.why.join(' ')).toMatch(/Away: holding/);
    expect(o.state.deviceId).toMatch(/^enterprises\//);
    expect(g.settings.presence).toBeNull();
    expect(g.plan.precool).toBe(true);                                     // the home plan for a hot, sunny day
    expect(JSON.stringify(g)).not.toMatch(/marked away|Away:|mark Home/i);
    expect(g.plan.steps.map((s: any) => s.why)).not.toContain('marked away');
    expect(g.log).toEqual([{ at: expect.any(Number), day: today, text: 'Set 76° (morning, comfort band)' }]);
    expect(g.state).toEqual({ at: expect.any(Number), name: 'Thermostat', online: true, indoorF: 76, humidity: 45, mode: 'COOL', hvac: 'OFF', coolF: 80, heatF: null });
    expect(g.learned).not.toHaveProperty('source');
    // the learning layer replaced the dollar savings (costSavedMonth, gone at the source) with two kWh figures and their
    // confidence tiers: kWh and tiers reach the guest; no money-named key is on the plan at all
    expect(g.plan).not.toHaveProperty('costSavedMonth');
    expect(g.plan).not.toHaveProperty('kwhSaved');
    expect(Object.keys(g.plan).filter(k => /cost|usd|dollar|saves/i.test(k))).toEqual([]);
    expect(g.plan).toMatchObject({ shiftedKwh: expect.any(Number), eveningAvoidedKwh: expect.any(Number), control: expect.any(Boolean),
      conf: { shiftedKwh: expect.any(String), eveningAvoidedKwh: expect.any(String) } });
    expect(g.plan.shiftedKwh).toBeGreaterThan(0);                           // a pre-cool day shifts cooling onto solar
    expect(g.plan.trim ?? null).toBeNull();                                // no learned trim without three pre-cool days
    expect(g.week.every((d: any) => typeof d.shiftedKwh === 'number' && typeof d.eveningAvoidedKwh === 'number' && !('kwhSaved' in d))).toBe(true);
    const reads = vi.mocked(nest.readNest).mock.calls.length;
    expect((await call('/api/appliances/ac?fresh=1', { cookie: guest })).status).toBe(200);
    expect((await call('/api/appliances/pool?fresh=1', { cookie: guest })).status).toBe(200);
    expect(vi.mocked(nest.readNest).mock.calls.length, 'a guest cannot force a Nest read').toBe(reads);
    const forced = await getJson('/api/appliances/ac?fresh=1', owner);
    expect(vi.mocked(nest.readNest).mock.calls.length).toBe(reads + 1);
    expect(forced.error).toMatch(/enterprises\//);                         // the owner sees the real error
    const list = await getJson('/api/appliances', guest);
    expect(list).toEqual([{ id: 'ac', name: 'AC', status: 'linked', watts: 0, kwhPerDay: expect.any(Number), savesPerMonth: null }]);
  });
});

describe('everything else is refused to guests', () => {
  it('RED-9 every write route answers 401 to a guest before its handler runs, and nothing changes', async () => {
    const writes = routes().filter(([m, p]) => m !== 'GET' && m !== 'HEAD' && !OPEN.has(`${m} ${p}`));
    expect(writes.length).toBeGreaterThan(20);
    const state = async () => JSON.stringify(await Promise.all([
      db.q(`SELECT key, value FROM kv ORDER BY key`), db.q(`SELECT bill_date, raw FROM bills ORDER BY bill_date`), db.q(`SELECT id, type, day, note FROM events ORDER BY id`),
      db.q(`SELECT id, label, revoked_at, opened_count FROM access_tokens ORDER BY id`), db.q(`SELECT id FROM owner_sessions ORDER BY id`), db.q(`SELECT id, name, info FROM sites`)]));
    const before = await state(), refused: string[] = [];
    for (const [method, path] of writes) {
      const url = path.replace(':id', 'x').replace(':date', '2026-09-15');
      const r = await call(url, { cookie: guest, method, ...(method === 'DELETE' ? {} : { json: { label: 'x', mode: 'auto', presence: 'home', on: true, calm: false } }) });
      if (r.status !== 401 || JSON.stringify(await r.json()) !== '{"error":"owner_required"}') refused.push(`${method} ${path} → ${r.status}`);
    }
    expect(refused).toEqual([]);
    expect(await state()).toBe(before);
    expect(screenlogic.writePoolPlan).not.toHaveBeenCalled();
    expect(nest.setCool).not.toHaveBeenCalled();
  });

  it('RED-10 every GET without a guest view answers 401 to a guest and to the owner previewing, before its handler runs', async () => {
    const reads = routes().filter(([m, p]) => m === 'GET' && !OPEN.has(`${m} ${p}`) && !redact.GUEST_GET.has(p.toLowerCase()));
    expect(reads.map(([, p]) => p).sort()).toEqual(['/api/appliances/day', '/api/auth/devices', '/api/bills', '/api/export.csv', '/api/flows', '/api/outage', '/api/share', '/api/site', '/auth/google', '/auth/login']);
    for (const [, path] of reads) for (const cookie of [guest, preview]) {
      const r = await call(path, { cookie });
      expect(r.status, `${path} as ${cookie === guest ? 'guest' : 'preview'}`).toBe(401);
      expect(await r.json()).toEqual({ error: 'owner_required' });
    }
    // routes on routers mounted with app.use (the learning layer's /api/models and the AC untrim) are not in routes(): check them by name
    expect((await call('/api/models', { cookie: guest })).status).toBe(401);
    expect((await call('/api/models', { cookie: preview })).status).toBe(401);
    expect((await call('/api/appliances/ac/untrim', { cookie: guest, method: 'POST', json: {} })).status).toBe(401);
    // unknown paths (and case or slash variants of known ones) are refused too: the allow-list matches exact paths
    for (const path of ['/api/nope', '/api/site/', '/API/SITE', '/api/bills?x=1', '/api/now/extra']) expect((await call(path, { cookie: guest })).status, path).toBe(401);
    expect((await call('/API/Now/', { cookie: guest })).status).toBe(200);    // Express matches case-insensitively; so does the allow-list
  });
});
