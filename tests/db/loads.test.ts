// I-22 load signatures on PGlite (server/src/loads.ts): the nightly step is idempotent and stops before the deadline with its cursor
// kept, the breakdown's parts still add up to the home total once a load is named, and /api/loads + /api/loads/label validate their
// input, are owner-only and refuse a guest. Two weeks of a synthetic house: a 1 kW base, a 4.4 kW / 20 min water heater at 06:00,
// 13:00 and 21:00, a 2.6 kW / 50 min oven at 17:00, and the pool pump at 1.5 kW 10:00–19:00 (read every 15 minutes). All synthetic.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { q, kv, migrate } from '../../server/src/db.js';
import { loadsNightly, storeDays } from '../../server/src/loads.js';
import { breakdownFor } from '../../server/src/breakdown.js';
import { localMidnight, addDays, rfc3339 } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => false, readPool: vi.fn(async () => { throw new Error('readPool in loads test'); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan in loads test'); }), withUnit: vi.fn(async () => { throw new Error('withUnit in loads test'); }),
}));
vi.mock(import('../../server/src/appliances/nest.js'), async importOriginal => {
  const real = await importOriginal();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in loads test`); });
  return { ...real, nestConfigured: () => false, nestLinked: vi.fn(async () => false), readNest: blocked('readNest'), nestExchangeCode: blocked('nestExchangeCode'), setCool: blocked('setCool'), ownerCommand: blocked('ownerCommand') };
});

const NOW = Date.parse('2026-10-07T18:00:00Z'), TODAY = '2026-10-07', YESTERDAY = '2026-10-06', B = 300_000, SITE = 'ld';
const DAYS = Array.from({ length: 14 }, (_, i) => addDays(YESTERDAY, -i)).reverse();   // 09-23 … 10-06
const on = (m: number, from: number, mins: number, kw: number) => m >= from && m < from + mins ? kw : 0;
const WH = [6 * 60, 13 * 60, 21 * 60];

let server: Server, base = '', owner = '', guest = '';
const call = (path: string, o: { cookie?: string; json?: unknown } = {}) => fetch(base + path, {
  method: o.json !== undefined ? 'POST' : 'GET', headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Real-IP': '198.18.4.1' },
  ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
const pair = (r: Response, name: string) => (r.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? '').split(';')[0];
const snapshot = async () => ({
  bursts: await q(`SELECT start::text, seq, day, hour, minutes, kw, kwh, overlap, sig, label_id FROM load_bursts WHERE site_id = $1 ORDER BY start, seq`, [SITE]),
  metrics: await q(`SELECT day, metric, value FROM daily_metrics WHERE site_id = $1 AND metric LIKE 'load:%' ORDER BY day, metric`, [SITE]),
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  process.env.SESSION_SECRET ??= 'test-session-secret-synthetic-loads-abcdef';
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, NULL, 1, 'Test')`, [SITE]);
  for (const d of DAYS) {
    const t0 = localMidnight(d).getTime(), ts: number[] = [], hrs: number[] = [], wh: number[] = [];
    for (let t = t0; t < localMidnight(addDays(d, 1)).getTime(); t += B) {
      const s = rfc3339(new Date(t)), h = +s.slice(11, 13), m = h * 60 + +s.slice(14, 16);
      const kw = 1 + WH.reduce((a, w) => a + on(m, w, 20, 4.4), 0) + on(m, 17 * 60, 50, 2.6) + on(m, 10 * 60, 9 * 60, 1.56);   // the pump's 1.5 kW and the UV lamp's 60 W
      ts.push(t); hrs.push(h); wh.push(Math.round(kw * 1000 / 12));
    }
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, home_wh) SELECT $1, ts, epoch, $2, hour, wh FROM unnest($3::text[], $4::bigint[], $5::int[], $6::int[]) AS x(ts, epoch, hour, wh)`,
      [SITE, d, ts.map(t => rfc3339(new Date(t))), ts, hrs, wh]);
    const nt = ts.filter((_, i) => i % 3 === 0);
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac) SELECT $1, ts, $2, ((ts - $3) / 3600000)::int, 'OFF' FROM unnest($4::bigint[]) AS x(ts)`, [SITE, d, t0, nt]);
    const pt = Array.from({ length: 36 }, (_, i) => t0 + (10 * 60 + 5 + 15 * i) * 60_000);
    await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) SELECT $1, ts, $2, ((ts - $3) / 3600000)::int, true, 1500, 2400 FROM unnest($4::bigint[]) AS x(ts)`, [SITE, d, t0, pt]);
    await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ($1, $2, $3, 19, false, 0, 0)`, [SITE, t0 + (19 * 60 + 5) * 60_000, d]);
  }
  const { app } = await import('../../server/src/app.js');
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  owner = pair(await call('/api/auth/owner', { json: { key: process.env.OWNER_KEY } }), 'solstice_owner');
  const link = await (await call('/api/share', { cookie: owner, json: { label: 'Test guest' } })).json();
  guest = pair(await call('/api/auth/guest', { json: { token: link.token } }), 'solstice_guest');
  expect([owner, guest].every(Boolean)).toBe(true);
});
afterAll(async () => { vi.useRealTimers(); if (server) { server.close(); await once(server, 'close'); } });

describe('nightly', () => {
  it('LDB-1 the nightly step stores every day once: a re-run, or the same days again, changes nothing', async () => {
    const r = await loadsNightly(SITE, NOW) as any;
    expect(r.stopped).toBeUndefined();
    expect(await kv.get(`${SITE}:loads:cursor`)).toBe(YESTERDAY);
    const a = await snapshot();
    expect(a.bursts.length).toBe(14 * 4);                                                              // 3 water-heater runs and the oven a day; the pump is no load
    expect(a.bursts.every((b: any) => b.minutes <= 50)).toBe(true);
    expect(a.metrics.filter((m: any) => m.metric === 'load:count').map((m: any) => m.day)).toEqual(DAYS);
    await loadsNightly(SITE, NOW);
    await storeDays(SITE, DAYS[0], YESTERDAY, NOW);
    expect(await snapshot()).toEqual(a);
  });
  it('LDB-2 it stops 8 s before the deadline with the cursor where it got to; the next night carries on', async () => {
    await kv.set(`${SITE}:loads:cursor`, null);
    let t = NOW - 10_000; const clock = () => (t += 10_000);                                             // each check is 10 s later
    const r = await loadsNightly(SITE, NOW, { deadline: NOW + 25_000, clock }) as any;
    expect(r.done).toEqual([[YESTERDAY, YESTERDAY], ['2026-09-07', '2026-09-13']]);
    expect(r).toMatchObject({ stopped: '2026-09-14', skipped: 'out of time; tomorrow night' });
    expect(await kv.get(`${SITE}:loads:cursor`)).toBe('2026-09-13');
    const r2 = await loadsNightly(SITE, NOW) as any;
    expect(r2.done[1][0]).toBe('2026-09-14');
    expect(await kv.get(`${SITE}:loads:cursor`)).toBe(YESTERDAY);
  });
});

describe('routes and the breakdown', () => {
  it('LDB-3 GET /api/loads: the clusters, their suggestion and 24-hour strip; naming one gives it a part, and the parts still add up', async () => {
    const v = await (await call('/api/loads', { cookie: owner })).json();
    // the water heater runs morning, afternoon and late, and is still one cluster (one row: mockup am frame 4); the oven is another
    expect(v.clusters.map((c: any) => c.sig).sort()).toEqual(['k1m2', 'k2m1']);
    expect(v.clusters.find((c: any) => c.sig === 'k2m1').count).toBe(42);
    const oven = v.clusters.find((c: any) => c.sig === 'k1m2');
    expect(oven).toMatchObject({ kw: 2.6, minutes: 50, count: 14, days: 14, perDay: 1, window: { from: 17, to: 18 }, badge: 'estimated', suggestion: { name: 'Oven' }, name: null });
    expect(oven.hist[17]).toBe(1);
    expect(oven.kwhPerDay).toBeCloseTo(2.17, 1);
    const before = await breakdownFor(SITE, 'week', {});
    expect(before.parts.map(p => p.id)).toEqual(['ac', 'alwaysOn', 'big', 'pool', 'other']);
    expect(before.parts.find(p => p.id === 'big')!.kwh).toBeCloseTo(4.4 + 2.2, 0);

    const named = await (await call('/api/loads/label', { cookie: owner, json: { sig: 'k2m1', name: '  Water heater ' } })).json();
    const wh = named.clusters.find((c: any) => c.name === 'Water heater');
    expect(wh).toMatchObject({ sig: 'k2m1', count: 42, hue: 0, suggestion: null });           // every run within ±20% kW and 1.5× the minutes
    expect(named.clusters.map((c: any) => c.sig)).toEqual(['k2m1', 'k1m2']);
    expect((await q(`SELECT COUNT(*)::int n FROM load_bursts WHERE site_id = $1 AND label_id = $2`, [SITE, wh.labelId]))[0].n).toBe(42);
    expect((await q(`SELECT value FROM daily_metrics WHERE site_id = $1 AND day = $2 AND metric = $3`, [SITE, YESTERDAY, `load:${wh.labelId}`]))[0].value).toBeCloseTo(4.4, 1);

    const d = await breakdownFor(SITE, 'week', {}), by = Object.fromEntries(d.parts.map(p => [p.id, p]));
    expect(d.parts.map(p => p.id)).toEqual(['ac', 'alwaysOn', `load:${wh.labelId}`, 'big', 'pool', 'other']);
    expect(by[`load:${wh.labelId}`]).toMatchObject({ name: 'Water heater', conf: 'learned', hue: 0 });   // named, 42 runs, steady two weeks
    expect(by[`load:${wh.labelId}`].kwh).toBeCloseTo(4.4, 1);
    expect(by.big).toMatchObject({ unnamed: 1, perDay: 1 });
    expect(by.big.kwh).toBeCloseTo(2.2, 1);
    expect(by.alwaysOn.kw).toBeCloseTo(1, 2);
    expect(d.parts.reduce((a, p) => a + p.kwh, 0)).toBeCloseTo(d.homeKwh, 0);                           // BD-5's rule, with a named load
    expect(by.other.kwh).toBeLessThan(.3);
  });
  it('LDB-4 POST /api/loads/label: validated; "Not one appliance" and unnaming', async () => {
    const post = (json: unknown) => call('/api/loads/label', { cookie: owner, json });
    for (const bad of [{}, [], { sig: 'oven', name: 'Oven' }, { sig: 'k1m2', name: '' }, { sig: 'k1m2', name: '   ' }, { sig: 'k1m2', name: 'x'.repeat(25) }, { sig: 'k1m2', name: 'a\u0000b' },
      { sig: 'k1m2', name: 'Oven', extra: 1 }, { sig: 'k1m2', dismissed: false }, { sig: 'k1m2' }, { id: '1', name: null }, { id: 1, name: 'x' }])
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await post({ sig: 'k5m3', name: 'Kiln' })).status).toBe(404);
    expect((await post({ id: 9999, name: null })).status).toBe(404);
    const dis = await (await post({ sig: 'k1m2', dismissed: true })).json();
    expect(dis.clusters.find((c: any) => c.sig === 'k1m2')).toMatchObject({ dismissed: true, name: null, suggestion: null });
    expect(dis.clusters.at(-1).sig).toBe('k1m2');                                                      // "Not one appliance" goes last
    const id = dis.clusters.find((c: any) => c.name === 'Water heater').labelId;
    const un = await (await post({ id, name: null })).json();
    expect(un.clusters.some((c: any) => c.name)).toBe(false);
    expect((await q(`SELECT COUNT(*)::int n FROM load_bursts WHERE site_id = $1 AND label_id IS NOT NULL`, [SITE]))[0].n).toBe(0);
    expect((await q(`SELECT COUNT(*)::int n FROM daily_metrics WHERE site_id = $1 AND metric = $2`, [SITE, `load:${id}`]))[0].n).toBe(0);
  });
  it('LDB-5 owner-only: no cookie and a guest are both refused, for the read and the write', async () => {
    for (const cookie of [undefined, guest]) {
      expect((await call('/api/loads', { cookie })).status).toBe(401);
      expect((await call('/api/loads/label', { cookie, json: { sig: 'k1m2', name: 'Oven' } })).status).toBe(401);
    }
    expect((await q(`SELECT COUNT(*)::int n FROM load_labels WHERE site_id = $1 AND name = 'Oven'`, [SITE]))[0].n).toBe(0);
  });
});
describe('v2 (2026-10-08): variable-speed AC and stored v1 bursts', () => {
  it('LDB-6 bursts stored by the v1 detector are ignored by the clusters and the nightly detects their days again', async () => {
    const d = DAYS[DAYS.length - 3];
    await q(`INSERT INTO load_bursts (site_id, start, seq, day, hour, minutes, kw, kwh, overlap, sig, label_id, v) VALUES ($1, $2, 99, $3, 3, 200, 1.68, 40, true, 'k0m3', NULL, 1)`,
      [SITE, localMidnight(d).getTime() + 3 * 3600e3 + 60_000, d]);
    const { loadClusters, LOADS_V } = await import('../../server/src/loads.js');
    expect(LOADS_V).toBe(2);
    await kv.set(`${SITE}:loads:clusters`, null);
    const c = await loadClusters(SITE, NOW);
    expect(c.v).toBe(2);
    expect(c.clusters.some(x => x.kw === 1.68 && x.minutes === 200)).toBe(false);
    await loadsNightly(SITE, NOW);
    expect((await q(`SELECT COUNT(*)::int n FROM load_bursts WHERE site_id = $1 AND v < 2`, [SITE]))[0].n).toBe(0);
    expect((await q(`SELECT COUNT(*)::int n FROM load_bursts WHERE site_id = $1 AND kw = 1.68 AND minutes = 200`, [SITE]))[0].n).toBe(0);
  });
  it('LDB-7 the breakdown\'s parts never add up to more than the home used, on every range', async () => {
    for (const range of ['today', 'week', 'month'] as const) {
      const b = await breakdownFor(SITE, range, {});
      expect(b.parts.reduce((a, p) => a + p.kwh, 0), range).toBeLessThanOrEqual(b.homeKwh + 0.3);
      expect(b.parts.every(p => p.kwh >= 0), range).toBe(true);
    }
  });
});

