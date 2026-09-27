// Presence (server/src/appliances/presence.ts; enhancements A1: manual "Away until", then Nest Home/Away Assist, then home).
//   PRS-1 the precedence table, pure
//   PRS-2 the POST body rules
//   PRS-3 the routes on PGlite: default, Nest Eco (with since), stale Nest, Away until → expiry → Nest, Home over Nest until Eco changes,
//         Nest switched off, the old AC switch; a mark mirrors into settings.ac.presence
//   PRS-4 the AC planner reads it (owner), a guest's plan is always home, and /api/appliances/ac/settings {presence} is the same mark
// In-process app on 127.0.0.1:0, PGlite in memory. Nest is "not configured" (pure-mocks): nothing reads or writes a thermostat; the
// Nest state is the synthetic kv 'nest:last' the app would have stored. No network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { nestState } from '../fixtures/nest.js';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => false),
}));

const KEY = 'test-owner-key-synthetic-presence-abcdefghij';   // test-only
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let P: typeof import('../../server/src/appliances/presence.js');
type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie = owner, json, ...rest } = init;
  return fetch(base + path, { ...rest, headers: { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const get = async () => (await call('/api/presence')).json();

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('presence tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  P = await import('../../server/src/appliances/presence.js');
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
  await db.kv.set('settings:owner', {}); await db.kv.set('s:presence', null); await db.kv.set('nest:last', null);
  await db.q('DELETE FROM nest_readings');
});

describe('precedence', () => {
  it('PRS-1 manual away (until expiry) › manual home (until Eco changes) › the old switch › fresh Nest Eco › home', () => {
    const now = Date.parse('2026-09-27T15:00:00Z'), eco = (on: boolean, age = 0) => ({ at: now - age, eco: on });
    const R = (o: Partial<Parameters<typeof P.resolvePresence>[0]>) => P.resolvePresence({ manual: null, nest: null, useNest: true, now, ...o });
    const away = (until: number | null) => ({ state: 'away' as const, at: now - 3600e3, until, nestEco: false });
    const home = (nestEco: boolean | null) => ({ state: 'home' as const, at: now - 3600e3, until: null, nestEco });
    expect(R({})).toEqual({ state: 'home', source: 'default', since: null, until: null });
    expect(R({ nest: eco(true) })).toEqual({ state: 'away', source: 'nest', since: null, until: null });
    expect(R({ nest: eco(true), nestSince: 5 })).toMatchObject({ state: 'away', source: 'nest', since: 5 });
    expect(R({ nest: eco(false) })).toMatchObject({ state: 'home', source: 'nest' });
    expect(R({ nest: eco(true, 31 * 60_000) })).toMatchObject({ state: 'home', source: 'default' });          // stale reading
    expect(R({ nest: eco(true), useNest: false })).toMatchObject({ state: 'home', source: 'default' });      // switched off
    expect(R({ manual: away(now + 1), nest: eco(false) })).toEqual({ state: 'away', source: 'manual', since: now - 3600e3, until: now + 1 });
    expect(R({ manual: away(null), nest: eco(false) })).toMatchObject({ state: 'away', source: 'manual', until: null });
    expect(R({ manual: away(now), nest: eco(false) })).toMatchObject({ state: 'home', source: 'nest' });         // expired at `until`
    expect(R({ manual: away(now - 1) })).toMatchObject({ state: 'home', source: 'default' });
    expect(R({ manual: home(true), nest: eco(true) })).toMatchObject({ state: 'home', source: 'manual' });       // Eco unchanged since the mark
    expect(R({ manual: home(false), nest: eco(true) })).toMatchObject({ state: 'away', source: 'nest' });        // Eco came on after it
    expect(R({ manual: home(null) })).toMatchObject({ state: 'home', source: 'manual' });
    expect(R({ manual: home(true), nest: eco(true), nestSince: now - 7200e3 })).toMatchObject({ state: 'home', source: 'manual' });   // the spell it overrode
    expect(R({ manual: home(true), nest: eco(true), nestSince: now - 60e3 })).toMatchObject({ state: 'away', source: 'nest' });      // a new spell since
    expect(R({ legacy: 'away', nest: eco(false) })).toMatchObject({ state: 'away', source: 'manual', since: null });   // the AC switch, as before
    expect(R({ legacy: 'away', manual: away(now - 1), nest: eco(false) })).toMatchObject({ state: 'home', source: 'nest' }); // a record supersedes it
    expect(R({ legacy: 'home', nest: eco(true) })).toMatchObject({ state: 'away', source: 'nest' });
  });

  it('PRS-2 the POST body: home or away, until only for away, in the future, within 60 days', () => {
    const now = Date.parse('2026-09-27T15:00:00Z');
    expect(P.parsePresenceBody({ state: 'away' }, now)).toEqual({ state: 'away', until: null });
    expect(P.parsePresenceBody({ state: 'away', until: '2026-09-27T23:00:00Z' }, now)).toEqual({ state: 'away', until: Date.parse('2026-09-27T23:00:00Z') });
    expect(P.parsePresenceBody({ state: 'away', until: now + 1 }, now)).toEqual({ state: 'away', until: now + 1 });
    expect(P.parsePresenceBody({ state: 'home' }, now)).toEqual({ state: 'home', until: null });
    expect(P.parsePresenceBody({ state: 'home', until: now + 1 }, now)).toEqual({ error: 'until applies to away only' });
    expect(P.parsePresenceBody({ state: 'gone' }, now)).toEqual({ error: 'state must be home or away' });
    expect(P.parsePresenceBody({ state: 'away', until: 'soon' }, now)).toEqual({ error: 'until must be a time (epoch ms or ISO 8601)' });
    expect(P.parsePresenceBody({ state: 'away', until: now }, now)).toEqual({ error: 'until must be in the future' });
    expect(P.parsePresenceBody({ state: 'away', until: now + 61 * 864e5 }, now)).toEqual({ error: 'until must be within 60 days' });
    expect(P.parsePresenceBody(null, now)).toEqual({ error: 'state must be home or away' });
  });
});

describe('GET/POST /api/presence', () => {
  it('PRS-3 default, Nest Eco with since, stale Nest, Away until and its expiry, Home over Nest, Nest off, the old switch', async () => {
    const now = Date.now();
    expect(await get()).toEqual({ state: 'home', source: 'default', since: null, until: null });
    // Nest Eco on since the second of three readings
    for (const [ts, eco] of [[now - 20 * 60_000, false], [now - 10 * 60_000, true], [now - 5 * 60_000, true]] as const)
      await db.q(`INSERT INTO nest_readings (site_id, ts, day, hour, eco) VALUES ('s', $1, '2026-09-27', 10, $2)`, [ts, eco]);
    await db.kv.set('nest:last', nestState(now - 60_000, { eco: true }));
    expect(await get()).toEqual({ state: 'away', source: 'nest', since: now - 10 * 60_000, until: null });
    await db.kv.set('nest:last', nestState(now - 45 * 60_000, { eco: true }));
    expect(await get()).toMatchObject({ state: 'home', source: 'default' });
    // Away until two hours from now: manual; mirrored into the AC switch; after `until` Nest decides again
    await db.kv.set('nest:last', nestState(now, { eco: false }));
    const until = now + 2 * 3600e3;
    const r = await call('/api/presence', { json: { state: 'away', until } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: 'away', source: 'manual', until });
    expect((await db.kv.get<any>('settings:owner')).ac.presence).toBe('away');
    const settings = await db.kv.get<Record<string, any>>('settings:owner') ?? {};
    await db.kv.set('nest:last', nestState(until + 60_000, { eco: false }));
    expect(await P.presenceFor('s', settings, until + 60_000)).toMatchObject({ state: 'home', source: 'nest' });
    // Home while Eco is on holds until Eco changes
    await db.kv.set('nest:last', nestState(Date.now(), { eco: true }));
    expect(await (await call('/api/presence', { json: { state: 'home' } })).json()).toMatchObject({ state: 'home', source: 'manual' });
    const seen = async (eco: boolean) => { const t = Date.now() + 1; await db.q(`INSERT INTO nest_readings (site_id, ts, day, hour, eco) VALUES ('s', $1, '2026-09-27', 10, $2)`, [t, eco]);
      await db.kv.set('nest:last', nestState(t, { eco })); await new Promise(r => setTimeout(r, 3)); };
    await seen(false);
    expect(await get()).toMatchObject({ state: 'home', source: 'nest' });
    await seen(true);                                   // a new spell of Eco after the Home mark: Nest decides again
    expect(await get()).toMatchObject({ state: 'away', source: 'nest' });
    // the owner switched the Nest source off
    await db.kv.set('settings:owner', { ac: { nestPresence: false } }); await db.kv.set('s:presence', null);
    expect(await get()).toMatchObject({ state: 'home', source: 'default' });
    // the old AC switch alone (no kv record): exactly as before
    await db.kv.set('settings:owner', { ac: { presence: 'away' } });
    expect(await get()).toMatchObject({ state: 'away', source: 'manual', since: null });
    for (const body of [{ state: 'nope' }, { state: 'away', until: 1 }]) expect((await call('/api/presence', { json: body })).status).toBe(400);
    expect((await call('/api/presence', { cookie: '' })).status).toBe(401);
    expect((await call('/api/presence', { cookie: '', json: { state: 'away' } })).status).toBe(401);
  });
});

describe('the AC planner reads presence', () => {
  it('PRS-4 Nest Eco plans the away setpoint for the owner; a guest always gets the home plan; the AC switch is the same mark', async () => {
    const { acDetail } = await import('../../server/src/appliances/ac.js');
    const { PRESENCE_FIXED } = P;
    const today = (await import('../../server/src/tesla/client.js')).localDay();
    await db.kv.set('pool:forecast', { at: Date.now(), days: [{ date: today, high: 96, rainMm: 0, rainPct: 0, sunKwhM2: 7, hourlySun: Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 18 ? .8 : 0)) }] });
    await db.kv.set('nest:last', nestState(Date.now(), { eco: true }));
    const o = await acDetail('s', {}, null, 2.5);
    expect(o.presence).toMatchObject({ state: 'away', source: 'nest' });
    expect(o.settings.presence).toBe('away');
    expect(o.plan.steps).toEqual([{ hour: 0, coolF: 80, why: 'marked away' }]);
    const g = await acDetail('s', { ac: { presence: 'home' }, [PRESENCE_FIXED]: true }, null, 2.5);
    expect(g.presence).toEqual({ state: 'home', source: 'default', since: null, until: null });
    expect(g.plan.steps.some(s => s.why === 'marked away')).toBe(false);
    // Nest says home, and the old switch marks away: the switch writes the manual record, so the plan is away
    await db.kv.set('nest:last', nestState(Date.now(), { eco: false }));
    expect((await acDetail('s', {}, null, 2.5)).presence).toMatchObject({ state: 'home', source: 'nest' });
    expect((await call('/api/appliances/ac/settings', { json: { presence: 'away' } })).status).toBe(200);
    expect(await db.kv.get('s:presence')).toMatchObject({ state: 'away', until: null, nestEco: false });
    const after = await (await call('/api/appliances/ac')).json();
    expect(after.presence).toMatchObject({ state: 'away', source: 'manual' });
    expect(after.settings.presence).toBe('away');
  });
});
