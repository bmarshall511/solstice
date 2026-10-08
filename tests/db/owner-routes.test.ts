// Owner-positive route tests (audit 10b, test batch 7 item 1): many routes were only ever tested for the guest's 401. Here every
// GET the app serves (read from its router at runtime, tests/helpers/routes.ts, sub-routers included) is called with the owner
// cookie on a seeded PGlite site and must answer 200 with its expected top-level shape. A GET with no entry in SHAPES fails OWN-0,
// so a new route needs one on purpose.
//
// Device reads are mocked: Tesla's live read and sync (sync.js), ScreenLogic (configured, readPool → a synthetic snapshot; every
// write throws), Nest (configured and linked, readNest → a synthetic state; every write throws). OWN-W pins that nothing was written.
// All values synthetic.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountedRoutes, concrete } from '../helpers/routes.js';   // before the app is imported
import { app } from '../../server/src/app.js';
import { q, kv, migrate } from '../../server/src/db.js';
import { saveEnergyRows, saveSoe, markSynced } from '../../server/src/sync.js';
import { localDay, addDays, localMidnight, rfc3339 } from '../../server/src/tesla/client.js';
import { saveBill, parsePecText } from '../../server/src/bills.js';
import * as screenlogic from '../../server/src/appliances/screenlogic.js';
import * as nest from '../../server/src/appliances/nest.js';
import { PEC_BILL } from '../fixtures/pec-bill.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';
import { nestState } from '../fixtures/nest.js';
import { siteInfo } from '../fixtures/tesla.js';
import { forecastDays } from '../fixtures/forecast.js';

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
vi.mock(import('../../server/src/sync.js'), async orig => ({
  ...(await orig()), syncSite: vi.fn(async () => ({ mocked: true } as any)), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => undefined as any),
}));
vi.mock(import('../../server/src/appliances/screenlogic.js'), async orig => {
  const real = await orig(), { poolSnapshot: snap } = await import('../fixtures/screenlogic.js');
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in owner-routes test`); });
  return { ...real, configured: () => true, readPool: vi.fn(async () => snap(Date.now())), withUnit: blocked('withUnit') as any,
    writePoolPlan: blocked('writePoolPlan') as any, writeOwnerPool: blocked('writeOwnerPool') as any };
});
vi.mock(import('../../server/src/appliances/nest.js'), async orig => {
  const real = await orig(), { nestState: st } = await import('../fixtures/nest.js'), { kv: store } = await import('../../server/src/db.js');
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in owner-routes test`); });
  return { ...real, nestConfigured: () => true, nestLinked: vi.fn(async () => true),
    readNest: vi.fn(async () => { const s = st(Date.now()); await store.set('nest:last', s); return s; }),
    nestExchangeCode: blocked('nestExchangeCode'), setCool: blocked('setCool'), setHeat: blocked('setHeat'), tripEcoOff: blocked('tripEcoOff'), ownerCommand: blocked('ownerCommand') };
});

let server: Server, base = '', cookie = '', today = '';
const get = (path: string) => fetch(base + path, { headers: { cookie }, redirect: 'manual' });

/** A flat 5-minute day: 1.2 kW house, a midday bell of solar, the rest from the grid or to it. */
async function seedDay(day: string) {
  const rows = [];
  for (let t = localMidnight(day).getTime(); t < localMidnight(addDays(day, 1)).getTime() && t < Date.now(); t += 300_000) {
    const ts = rfc3339(new Date(t)), h = +ts.slice(11, 13), solar = Math.round(Math.max(0, Math.sin((h - 7) / 12 * Math.PI)) * 500);
    rows.push({ ts, epoch: t, day, hour: h, solar, home: 100, imp: Math.max(0, 100 - solar), exp: Math.max(0, solar - 100), chg: 0, dis: 0 });
  }
  await saveEnergyRows('s', rows);
  await saveSoe('s', [0, 6, 12, 18].map(h => ({ timestamp: rfc3339(new Date(localMidnight(day).getTime() + h * 3600e3)), soe: 50 + h })).filter(p => Date.parse(p.timestamp) < Date.now()));
}

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-session-secret-synthetic-owner-routes-0';   // the OAuth routes sign their state
  Object.assign(process.env, { NEST_PROJECT_ID: 'test-project', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_REDIRECT_URI: 'http://127.0.0.1/auth/google/callback',
    TESLA_CLIENT_ID: 'test-tesla-client', TESLA_REDIRECT_URI: 'http://127.0.0.1/auth/callback' });   // synthetic: only the consent URLs are built
  await migrate();
  today = localDay();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at, scope) VALUES (1, NULL, 'test-access', 'test-refresh', 0, 'openid energy_device_data')`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info) VALUES ('s', NULL, 1, 'Test Site', $1)`, [JSON.stringify(siteInfo('2026-01-15'))]);
  await q(`INSERT INTO readings (site_id, ts, solar_w, battery_w, grid_w, load_w, soc, grid_status, island_status, storm_mode_active) VALUES ('s', $1, 3000, -1000, 0, 2000, 64, 'Active', 'on_grid', false)`, [Date.now()]);
  for (let i = 3; i >= 0; i--) await seedDay(addDays(today, -i));
  for (let i = 3; i >= 1; i--) await markSynced('s', addDays(today, -i));   // as the sync does for every finished day (today stays unmarked)
  await q(`INSERT INTO backup_events (site_id, ts, epoch, duration_s) VALUES ('s', '2026-05-01T14:37:00-05:00', $1, 1800)`, [Date.parse('2026-05-01T14:37:00-05:00')]);
  await saveBill('s', parsePecText(PEC_BILL));
  await q(`INSERT INTO events (site_id, type, day, note) VALUES ('s', 'cleaned', $1, NULL)`, [addDays(today, -2)]);
  await kv.set('ercot', { at: Date.now(), data: { condition: 'normal', title: 'Normal Conditions', note: null, eea: 0, demandMw: 50000, capacityMw: 70000, at: '2026-09-25 12:00:00' } });
  await kv.set('pool:forecast', { at: Date.now(), days: forecastDays(today) });
  await kv.set('s:pool:last', poolSnapshot(Date.now()));
  await kv.set('nest:last', nestState(Date.now()));
  await kv.set('soiling:wx', { day: today, w: { hourly: { time: [`${today}T12:00`], global_tilted_irradiance: [800], cloud_cover: [0] }, daily: { time: [today], precipitation_sum: [0], temperature_2m_max: [90] } } });
  await (await import('../../server/src/capacity.js')).refreshCapacity('s');
  await kv.set('nest:tokens', { access_token: 'test-a', refresh_token: 'test-r', expires_at: Date.now() + 3600e3 });
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const unlock = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) });
  expect(unlock.status).toBe(200);
  cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0];
});
afterAll(async () => { await new Promise(r => server.close(r)); });

type Shape = { query?: string; status?: number; keys?: string[]; array?: string[] | true; check?: (body: any, res: Response) => void };
const obj = (...keys: string[]): Shape => ({ keys });
const arr = (...keys: string[]): Shape => ({ array: keys.length ? keys : true });
/** Every GET the app serves, with the owner's answer: 200 and the top-level fields the views read (more may follow), or the status a
 *  route answers the owner by design (the crons want their bearer, the OAuth routes redirect). */
const SHAPES: Record<string, Shape> = {
  '/api/auth/me': { check: b => expect(b).toEqual({ mode: 'single', owner: true, user: null, site: { id: 's', name: 'Test Site' } }) },
  '/api/auth/devices': { ...arr('id', 'label', 'createdAt', 'lastSeen', 'current'), check: b => expect(b.filter((d: any) => d.current)).toHaveLength(1) },
  '/api/share': arr(),
  '/auth/login': { status: 302, check: (_b, r) => expect(r.headers.get('location')).toMatch(/^https:\/\/[^/]*tesla\.com\/.*state=/) },
  '/auth/callback': { status: 302, check: (_b, r) => expect(r.headers.get('location')).toBe('/?tesla_error=expired') },   // no signed state
  '/auth/google': { status: 302, check: (_b, r) => expect(r.headers.get('location')).toMatch(/^https:\/\/nestservices\.google\.com\/partnerconnections\/test-project\/auth\?.*state=/) },
  '/auth/google/callback': { status: 302, check: (_b, r) => expect(r.headers.get('location')).toBe('/?nest_error=expired') },
  '/api/cron/sync': { status: 401 }, '/api/cron/pool': { status: 401 }, '/api/cron/nest': { status: 401 },   // a cookie is not the cron bearer
  '/api/pvs/panels': obj('date', 'today', 'timeZone', 'bucketMinutes', 'times', 'layout', 'relay', 'panels', 'totals', 'anomalies', 'alerts'),
  '/api/pvs/day': obj('date', 'timeZone', 'start', 'end', 'bucketMinutes', 'times', 'inverters', 'total'),
  '/api/pvs/latest': obj('at', 'ageS', 'count', 'inverters'),
  '/api/pvs/layout': obj('learned', 'mapped', 'expected', 'positions'),
  '/api/settings': { check: b => expect(b).toEqual({ location: null }) },   // tests never set SITE_LAT/SITE_LON
  '/api/now': { ...obj('reading', 'today', 'site', 'outage', 'health'),
    check: b => { expect(b.reading).toMatchObject({ solarKw: 3, homeKw: 2, soc: 64, gridStatus: 'Active' }); expect(b.site).toMatchObject({ name: 'Test Site', batteryCount: 2, capacityKwh: 27 });
      expect(b.outage).toEqual({ active: false }); expect(b.health).toMatchObject({ stale: false, liveError: null }); expect(b.health).toHaveProperty('crons'); } },
  '/api/status': { ...obj('connected', 'siteId', 'lastLive', 'lastHistory', 'backfill'), check: b => expect(b.backfill.daysDone).toBe(4) },
  '/api/day': { ...obj('date', 'buckets', 'peaks', 'soe', 'totals'), check: b => { expect(b.date).toBe(today); expect(b.buckets.length).toBeGreaterThan(0); expect(b.totals.home).toBeGreaterThan(0); } },
  '/api/breakdown': { ...obj('range', 'from', 'to', 'days', 'homeKwh', 'parts', 'bursts', 'trend'), check: b => expect(b.range).toBe('week') },
  '/api/loads': obj('at', 'day', 'days', 'clusters', 'unsorted'),
  '/api/flows': { ...obj('range', 'from', 'to', 'days', 'buckets', 'ribbons', 'totals', 'unaccounted', 'home'), check: b => expect(b.range).toBe('day') },
  '/api/changed': { ...obj('scope', 'date', 'baseline', 'home', 'import', 'notes'), check: b => expect(b.scope).toBe('day') },
  '/api/spare': obj('months', 'days', 'exportKwh', 'now'),
  '/api/daily': { ...arr('date', 'solar', 'home', 'import', 'export', 'charge', 'discharge', 'socMin', 'socMax'), check: b => expect(b.map((d: any) => d.date)).toEqual([3, 2, 1, 0].map(i => addDays(today, -i))) },
  '/api/monthly': arr('month', 'days', 'solar', 'home', 'import', 'export', 'charge', 'discharge'),
  '/api/profile': { ...obj('days', 'hours', 'conf', 'scale', 'correction'), check: b => expect(b.days).toBe(14) },
  '/api/grid-days': { ...obj('dates', 'solar', 'soc'), check: b => { expect(b.dates).toHaveLength(30); expect(b.solar.every((d: unknown[]) => d.length === 24)).toBe(true); } },
  '/api/overnight': { ...arr('date', 'kw', 'base', 'ac', 'pump', 'split'), check: b => expect(b.find((n: any) => n.date === addDays(today, -1))?.kw).toBeCloseTo(1.2, 3) },
  '/api/records': { ...obj('bestSolarDay', 'biggestUsageDay', 'lowestImportDay', 'totals', 'batteryFullDays', 'longestOutage', 'outages'), check: b => expect(b.outages).toBe(1) },
  '/api/outages': { ...arr('ts', 'duration_s'), check: b => expect(b).toEqual([{ ts: '2026-05-01T14:37:00-05:00', duration_s: 1800 }]) },
  '/api/outage': obj('at', 'date', 'startHour', 'soc', 'capacityKwh', 'usableKwh', 'reservePct', 'batteries', 'drawKw', 'loads', 'ladder', 'scenarios', 'solar', 'outages', 'storm'),
  '/api/site': { ...obj('summary', 'raw'), check: b => { expect(b.summary).toMatchObject({ name: 'Test Site', reservePct: 20, mode: 'self_consumption', stormWatch: true }); expect(b.raw.site_name).toBe('Test Site'); } },
  '/api/capacity': obj('measuredKwh', 'nameplateKwh', 'count', 'months', 'at'),
  '/api/bills': { ...arr('utility', 'billDate', 'period', 'deliveredKwh', 'receivedKwh', 'total', 'charges', 'tariff', 'checks'), check: b => expect(b).toHaveLength(1) },
  '/api/reconcile': arr('billDate', 'period', 'total', 'tariff', 'pec', 'tesla', 'checks'),
  '/api/events': { ...arr('id', 'type', 'day', 'note', 'created_at'), check: b => expect(b[0]).toMatchObject({ type: 'cleaned', day: addDays(today, -2) }) },
  '/api/soiling': obj('state', 'lossPct', 'score', 'kwhPerDay'),
  '/api/pool/water': obj('tests', 'last', 'status', 'ranges', 'waterF', 'pumpHours', 'findings', 'due'),
  '/api/ercot': { check: b => expect(b).toEqual({ condition: 'normal', title: 'Normal Conditions', note: null, eea: 0, demandMw: 50000, capacityMw: 70000, at: '2026-09-25 12:00:00' }) },
  '/api/whatif': { ...obj('days', 'kwpNow', 'acKw', 'panels', 'assumptions', 'actual', 'baseline', 'upgraded', 'noSystem', 'cost', 'savesPerYear', 'system', 'backupHoursEvening'),
    check: b => { expect(b.days).toBe(3); expect(b.system).toBeNull(); } },   // three full days before today; no system price in settings
  '/api/appliances': { ...arr('id', 'name', 'status', 'watts', 'kwhPerDay', 'savesPerMonth'), check: b => expect(b.map((a: any) => a.id)).toEqual(expect.arrayContaining(['pool', 'ac'])) },
  '/api/appliances/pool': { ...obj('id', 'name', 'linked', 'settings', 'snapshot', 'live', 'plan', 'seasons', 'autopilot', 'water', 'clearUp', 'rate', 'todayKwh'),
    check: b => { expect(b.linked).toBe(true); expect(b.snapshot.bodies[0].temp).toBe(88); expect(b.rate).toBeGreaterThan(0); } },
  '/api/appliances/ac': { ...obj('id', 'name', 'configured', 'linked', 'settings', 'state', 'hold', 'plan', 'currentStep', 'week', 'presence', 'log', 'learned'),
    check: b => { expect(b).toMatchObject({ configured: true, linked: true }); expect(b.state).toMatchObject({ mode: 'COOL', coolF: 80, indoorF: 76 }); } },
  '/api/appliances/ac/strip': obj('show', 'today', 'week', 'heating'),
  '/api/appliances/day': { ...obj('date', 'acKw', 'coverage', 'hours'), check: b => expect(b.date).toBe(today) },
  '/api/models': obj('summary', 'lastRun', 'models', 'anomalies', 'log', 'ac', 'home'),
  '/api/alerts': obj('unread', 'alerts'),
  '/api/push/key': obj('key', 'configured'),
  '/api/digest': { ...obj('week', 'from', 'to', 'partial', 'totals', 'stored'), check: b => expect(b.stored).toBe(false) },
  '/api/presence': obj('state', 'source', 'since', 'until'),
  '/api/vacation': { ...obj('now', 'trip', 'phase', 'last'), check: b => expect(b.trip).toBeNull() },
  '/api/vacation/estimate': obj('days', 'perDay', 'total', 'model', 'conf'),
  '/api/vacation/trips': { ...arr(), check: b => expect(b).toEqual([]) },
  '/api/vacation/check': { ...obj('pool', 'nest'), check: b => { expect(b.pool.linked).toBe(true); expect(b.nest).toMatchObject({ linked: true, mode: 'COOL' }); } },
  '/api/tesla/scopes': { check: b => expect(b).toEqual({ connected: true, scopes: ['openid', 'energy_device_data'], energyCmds: false, source: 'stored', relink: '/auth/login' }) },
  '/api/powerwall/rules': obj('scope', 'floorPct', 'rules', 'log'),
  '/api/export.csv': { check: (b, r) => { expect(r.headers.get('content-type')).toMatch(/^text\/csv/); expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="solstice-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (b as string).trim().split('\n'); expect(lines[0]).toBe('timestamp,solar_wh,home_wh,import_wh,export_wh,battery_charge_wh,battery_discharge_wh'); expect(lines.length).toBeGreaterThan(3 * 288); } },
};

const gets = () => [...new Set(mountedRoutes(app).filter(r => r.method === 'GET').map(r => r.path))];

describe('owner GET routes', () => {
  it('OWN-0 every GET the app serves has an entry here (and every entry is still served)', () => {
    expect(gets().filter(p => !SHAPES[p])).toEqual([]);
    expect(Object.keys(SHAPES).filter(p => !gets().includes(p))).toEqual([]);
    expect(gets().length).toBeGreaterThan(50);
  });

  it.each(Object.entries(SHAPES))('OWN %s', async (path, s) => {
    const r = await get(concrete(path) + (s.query ?? ''));
    const ct = r.headers.get('content-type') ?? '', b = ct.includes('json') ? await r.json() : await r.text();
    expect(r.status, `${path}: ${JSON.stringify(b).slice(0, 200)}`).toBe(s.status ?? 200);
    if (s.keys) { expect(b && typeof b === 'object' && !Array.isArray(b), `${path} is an object`).toBe(true); expect(Object.keys(b)).toEqual(expect.arrayContaining(s.keys)); }
    if (s.array) {
      expect(Array.isArray(b), `${path} is a list`).toBe(true);
      if (s.array !== true) { expect(b.length, `${path} has rows`).toBeGreaterThan(0); for (const row of b) expect(Object.keys(row)).toEqual(expect.arrayContaining(s.array)); }
    }
    s.check?.(b, r);
  });

  it('OWN-W the owner\'s reads wrote nothing to ScreenLogic or Nest, and reached Tesla only through the mocked live read', async () => {
    const sync = await import('../../server/src/sync.js');
    for (const f of [screenlogic.writePoolPlan, screenlogic.writeOwnerPool, screenlogic.withUnit, nest.setCool, nest.setHeat, nest.tripEcoOff, nest.ownerCommand, nest.nestExchangeCode])
      expect(f).not.toHaveBeenCalled();
    expect(sync.refreshLive).toHaveBeenCalled();                        // /api/now's live read, mocked
    expect(sync.syncSite).not.toHaveBeenCalled();                       // no read route syncs
  });
});
