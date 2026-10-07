// Vacation mode on PGlite (mockup ak, batch 1): the trip routes, the 5-minute lifecycle, presence during a trip, the start/end hooks,
// and the audit's fix that a guest's read on an Away day never claims an AC control day. In-process app on 127.0.0.1:0; Nest and
// ScreenLogic are not configured, so nothing reads or writes a device. No network.
//   VAC-1 plan a trip, see it, change its dates, cancel it; a second live trip is refused; bodies are checked
//   VAC-2 the tick starts a planned trip at its leave time (once, even when two ticks overlap) and runs the start hooks
//   VAC-3 presence is away (source 'vacation') during a trip, home again after; a guest's view never sees it
//   VAC-4 "I'm home" (the end route, or Home on the presence switch / AC card) ends a trip under way and runs the end hooks
//   VAC-5 a guest's read plans as if home but claims no control day and logs no prediction; the owner's own read does
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => false),
}));

const KEY = 'test-owner-key-synthetic-vacation-abcdefghij';   // test-only
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let V: typeof import('../../server/src/vacation/index.js');
let T: typeof import('../../server/src/vacation/trip.js');
type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie = owner, json, ...rest } = init;
  return fetch(base + path, { ...rest, headers: { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const D = 864e5;

beforeAll(async () => {
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  V = await import('../../server/src/vacation/index.js');
  T = await import('../../server/src/vacation/trip.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const r = await call('/api/auth/owner', { cookie: '', json: { key: KEY } });
  owner = (r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? '').split(';')[0];
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => {
  await db.q('DELETE FROM trips'); await db.kv.set('settings:owner', {}); await db.kv.set('s:presence', null); await db.kv.set('nest:last', null);
  for (const k of Object.keys(V.tripHooks.start)) delete V.tripHooks.start[k];
  for (const k of Object.keys(V.tripHooks.end)) delete V.tripHooks.end[k];
});

describe('the trip routes', () => {
  it('VAC-1 plan, read, change the dates, cancel; one live trip at a time; bad bodies refused', async () => {
    const leaveAt = Date.now() + 2 * D, backAt = Date.now() + 5 * D;
    expect(await (await call('/api/vacation')).json()).toMatchObject({ trip: null, phase: null, last: null });
    const r = await call('/api/vacation', { json: { leaveAt, backAt, checklist: { waterHeater: true } } });
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s).toMatchObject({ phase: 'planned', trip: { state: 'planned', leaveAt, backAt, startedAt: null, detected: false, data: { checklist: { waterHeater: true } } } });
    expect(s.trip.data.log.map((l: any) => l.text)).toEqual(['Trip planned']);
    expect((await call('/api/vacation', { json: { leaveAt, backAt } })).status).toBe(409);
    expect((await call('/api/vacation', { method: 'PATCH', json: { backAt: backAt + D } })).status).toBe(200);
    expect((await (await call('/api/vacation')).json()).trip.backAt).toBe(backAt + D);
    expect(await (await call('/api/vacation', { method: 'PATCH', json: { backAt: leaveAt } })).json()).toEqual({ error: 'backAt must be at least an hour after leaveAt' });
    const end = await (await call('/api/vacation/end', { method: 'POST' })).json();
    expect(end).toMatchObject({ trip: null, last: null });                                   // cancelled, not ended: no report to show
    expect((await db.one(`SELECT state, ended_by FROM trips`))).toEqual({ state: 'cancelled', ended_by: 'cancelled' });
    expect((await call('/api/vacation/end', { method: 'POST' })).status).toBe(409);
    expect((await call('/api/vacation', { method: 'PATCH', json: { backAt } })).status).toBe(409);
    expect(await (await call('/api/vacation', { json: { leaveAt: Date.now() - 3600e3, backAt } })).json()).toEqual({ error: 'leaveAt must be now or later' });
  });

  it('VAC-2 the tick starts a planned trip at its leave time, once, and runs the start hooks', async () => {
    const started: number[] = [];
    V.tripHooks.start.test = async (_s, t) => { started.push(t.id); };
    V.tripHooks.start.broken = async () => { throw new Error('boom'); };                     // a failing part is logged, the others still run
    const now = Date.now(), t = await T.createTrip('s', { leaveAt: now + 3600e3, backAt: now + 3 * D, detected: false });
    expect(await V.vacationTick('s', now)).toMatchObject({ trip: t.id, phase: 'planned' });
    const [a, b] = await Promise.all([V.vacationTick('s', now + 3600e3), V.vacationTick('s', now + 3600e3 + 1)]);
    expect([a, b].filter(x => 'started' in x)).toHaveLength(1);
    expect(started).toEqual([t.id]);
    const live = (await T.liveTrip('s'))!;
    expect(live).toMatchObject({ state: 'active', startedAt: now + 3600e3 });
    expect(live.data.log!.map(l => [l.text, l.delta])).toEqual([['Trip planned', 'you'], ['Vacation mode started', 'trip'], ['broken: boom', 'error']]);
    // leaving now: started by the route itself, hooks included
    await db.q('DELETE FROM trips'); started.length = 0;
    const s = await (await call('/api/vacation', { json: { backAt: Date.now() + 2 * D } })).json();
    expect(s).toMatchObject({ phase: 'away', trip: { state: 'active' } });
    expect(started).toEqual([s.trip.id]);
  });

  it('VAC-3 presence is away during a trip (source vacation), home after it; a guest view is always home', async () => {
    const P = await import('../../server/src/appliances/presence.js');
    const now = Date.now(), t = await T.createTrip('s', { leaveAt: now, backAt: now + 3 * D, detected: false }, now);
    expect(await P.presenceFor('s', {}, now + 1000)).toEqual({ state: 'away', source: 'vacation', since: now, until: now + 3 * D });
    expect(await P.presenceFor('s', { [P.PRESENCE_FIXED]: true }, now + 1000)).toMatchObject({ state: 'home', source: 'default' });
    expect(await (await call('/api/presence')).json()).toMatchObject({ state: 'away', source: 'vacation' });
    await T.endTrip('s', 'you', now + 2000);
    expect(await P.presenceFor('s', {}, now + 3000)).toMatchObject({ state: 'home', source: 'default' });
    expect(t.state).toBe('active');
  });

  it('VAC-4 "I\'m home" ends a trip under way: the end route, Home on the presence switch, Home on the AC card; the end hooks run', async () => {
    const ended: string[] = [];
    V.tripHooks.end.test = async (_s, t) => { ended.push(`${t.state}:${t.endedBy}`); };
    const go = async () => { await db.q('DELETE FROM trips'); await T.createTrip('s', { leaveAt: Date.now(), backAt: Date.now() + D, detected: false }); };
    await go(); await call('/api/vacation/end', { method: 'POST' });
    await go(); expect((await call('/api/presence', { json: { state: 'home' } })).status).toBe(200);
    await go(); expect((await call('/api/appliances/ac/settings', { json: { presence: 'home' } })).status).toBe(200);
    expect(ended).toEqual(['ended:you', 'ended:you', 'ended:you']);
    const last = await (await call('/api/vacation')).json();
    expect(last).toMatchObject({ trip: null, last: { endedBy: 'you', report: null } });
    // Away on the switch during a trip changes nothing about the trip
    await go(); await call('/api/presence', { json: { state: 'away' } });
    expect((await T.liveTrip('s'))?.state).toBe('active');
  });
});

describe('the sheet\'s routes', () => {
  it('VAC-7 the estimate (frame 2) and the past trips; bad dates refused', async () => {
    const leaveAt = Date.now() + 864e5, backAt = leaveAt + 3 * 864e5;
    const r = await call(`/api/vacation/estimate?leaveAt=${leaveAt}&backAt=${backAt}`);
    expect(r.status).toBe(200);
    const e = await r.json();
    expect(e).toMatchObject({ days: 3, open: false, conf: 'estimated', model: { k: .095, delta: 9, days: 0, fromLastTrip: false } });
    expect(e.perDay.empty).toBeGreaterThanOrEqual(e.perDay.vacation);                  // 85° instead of Eco's 82° (no weather here: equal)
    expect(e.saving.totalKwh).toBeCloseTo(e.total.empty - e.total.vacation, 0);
    expect((await call(`/api/vacation/estimate?leaveAt=${leaveAt}&backAt=${leaveAt - 1}`)).status).toBe(400);
    expect((await call(`/api/vacation/estimate?leaveAt=x`)).status).toBe(400);
    expect(await (await call('/api/vacation/trips')).json()).toEqual([]);
  });
});

describe('the learning layer', () => {
  it('VAC-6 /api/profile: home use is the average at-home day, trip days left out; solar keeps every day', async () => {
    const { localDay, addDays, localAt } = await import('../../server/src/tesla/client.js');
    const today = localDay(), days = Array.from({ length: 14 }, (_, i) => addDays(today, -14 + i)), tripD = new Set([days[5], days[6]]);
    await db.q('DELETE FROM energy');
    for (const day of days) for (let h = 0; h < 24; h++)
      await db.q(`INSERT INTO energy (site_id, ts, epoch, day, hour, solar_wh, home_wh) VALUES ('s', $1, $2, $3, $4, $5, $6)`, [`${day}T${String(h).padStart(2, '0')}:00:00`, localAt(day, h), day, h, 1000, tripD.has(day) ? 500 : 3000]);
    const before = await (await call('/api/profile')).json();
    expect(before.hours[0].home).toBeCloseTo((12 * 3 + 2 * .5) / 14, 5);
    await db.q(`INSERT INTO trips (site_id, leave_at, back_at, state, started_at, ended_at) VALUES ('s', $1, $2, 'ended', $1, $2)`, [localAt(days[5], 0), localAt(days[7], 0)]);
    const after = await (await call('/api/profile')).json();
    expect(after.hours[0].home).toBeCloseTo(3, 5);
    expect(after.hours[0].solar).toBeCloseTo(1, 5);
    await db.q('DELETE FROM energy');
  });
});

describe('the audit fix', () => {
  it('VAC-5 a guest\'s read on a hot, sunny Away day claims no control day and logs no prediction; the owner\'s read does', async () => {
    const { learnedPlan } = await import('../../server/src/learn/ac.js');
    const { planFor, acSettingsOf } = await import('../../server/src/appliances/ac.js');
    const { localDay } = await import('../../server/src/tesla/client.js');
    const sun = Array.from({ length: 24 }, (_, h) => h >= 7 && h <= 19 ? Math.sin((h - 7) / 12 * Math.PI) * .9 : 0);
    const input = { date: localDay(), high: 96, sunKwhM2: 7, hourlySun: sun, humidity: 40, settings: acSettingsOf({ ac: { presence: 'home' } }), acKw: 2.6, slope: 2.5, rate: null };
    await db.q(`DELETE FROM kv WHERE key = 's:ac:control'`); await db.q('DELETE FROM predictions');
    const guest = await learnedPlan('s', input, planFor, 2.6, { readOnly: true });
    expect(guest.precool).toBe(true);
    expect(await db.kv.get('s:ac:control')).toBeUndefined();
    expect((await db.q('SELECT 1 FROM predictions')).length).toBe(0);
    await learnedPlan('s', input, planFor, 2.6);
    expect(await db.kv.get<any>('s:ac:control')).toMatchObject({ count: 1, days: { [localDay()]: false } });
    expect((await db.q(`SELECT model FROM predictions ORDER BY model`)).map(r => r.model)).toEqual(['ac.eveningAvoided', 'ac.shifted']);
  });
});
