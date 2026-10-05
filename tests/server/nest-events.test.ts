// Nest change events over Pub/Sub (server/src/appliances/nestEvents.ts, POST /api/nest/events): the push's OIDC token must be Google's,
// for our audience and service account; events merge into the stored thermostat state; a setting change starts a hold at once; replays,
// stale events and other devices change nothing. In-process app on PGlite; Google's keys and the SDM API are fakes; all ids synthetic.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { oidcError, applyTraits, eventOf, isSettingEvent } from '../../server/src/appliances/nestEvents.js';

vi.unmock('../../server/src/db.js');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'test-kid', alg: 'RS256' };
const AUD = 'https://app.invalid/api/nest/events', SA = 'nest-push@test-project.iam.gserviceaccount.com', DEV = 'enterprises/test-proj/devices/test-dev';
const jwt = (claims: Record<string, unknown>, kid = 'test-kid', key = privateKey) => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc({ iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
};
const push = (ev: unknown) => ({ message: { data: Buffer.from(JSON.stringify(ev)).toString('base64'), messageId: '1' }, subscription: 'projects/p/subscriptions/s' });
const C = (f: number) => Math.round((f - 32) * 5 / 9 * 100) / 100;

describe('OIDC check (pure)', () => {
  it('NE-1 accepts Google’s token for our audience and service account; refuses everything else', async () => {
    const keys = [JWK];
    expect(await oidcError(jwt({}), { audience: AUD, email: SA, keys })).toBeNull();
    expect(await oidcError(jwt({ aud: 'https://elsewhere.invalid' }), { audience: AUD, email: SA, keys })).toBe('wrong audience');
    expect(await oidcError(jwt({ email: 'other@x.iam.gserviceaccount.com' }), { audience: AUD, email: SA, keys })).toBe('wrong service account');
    expect(await oidcError(jwt({ email_verified: false }), { audience: AUD, email: SA, keys })).toBe('wrong service account');
    expect(await oidcError(jwt({ iss: 'https://evil.invalid' }), { audience: AUD, email: SA, keys })).toBe('wrong issuer');
    expect(await oidcError(jwt({ exp: Math.floor(Date.now() / 1000) - 600 }), { audience: AUD, email: SA, keys })).toBe('expired');
    expect(await oidcError(jwt({}, 'other-kid'), { audience: AUD, email: SA, keys })).toBe('unknown signing key');
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await oidcError(jwt({}, 'test-kid', forged), { audience: AUD, email: SA, keys })).toBe('bad signature');
    expect(await oidcError('nope', { audience: AUD, email: SA, keys })).toBe('not a JWT');
  });
});

describe('event merge (pure)', () => {
  const prev = { at: 1, deviceId: DEV, name: 'Hallway', online: true, indoorF: 76, humidity: 50, mode: 'COOL', hvac: 'OFF', coolF: 76, heatF: null, eco: false, ecoCoolF: 82, ecoHeatF: 50, fanTimer: false, fanUntil: null, availableModes: ['COOL', 'HEAT', 'HEATCOOL', 'OFF'] };
  it('NE-2 only the traits in the event change; a setpoint event is the whole current setpoint', () => {
    const s = applyTraits(prev as any, { 'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: C(72) } }, 5);
    expect(s).toMatchObject({ at: 5, coolF: 72, heatF: null, mode: 'COOL', indoorF: 76, hvac: 'OFF' });
    expect(applyTraits(prev as any, { 'sdm.devices.traits.ThermostatHvac': { status: 'COOLING' }, 'sdm.devices.traits.Temperature': { ambientTemperatureCelsius: C(77) } }, 6))
      .toMatchObject({ hvac: 'COOLING', indoorF: 77, coolF: 76 });
    expect(applyTraits(prev as any, { 'sdm.devices.traits.ThermostatMode': { mode: 'HEAT' }, 'sdm.devices.traits.ThermostatTemperatureSetpoint': { heatCelsius: C(68) } }, 7))
      .toMatchObject({ mode: 'HEAT', heatF: 68, coolF: null });
  });
  it('NE-3 setting events vs readings; the push body decodes', () => {
    const ev = { resourceUpdate: { name: DEV, traits: { 'sdm.devices.traits.ThermostatEco': { mode: 'MANUAL_ECO' } } } };
    expect(isSettingEvent(ev)).toBe(true);
    expect(isSettingEvent({ resourceUpdate: { name: DEV, traits: { 'sdm.devices.traits.Humidity': { ambientHumidityPercent: 52 } } } })).toBe(false);
    expect(eventOf(push(ev))).toEqual(ev);
    expect(eventOf({ message: { data: '%%%' } })).toBeNull();
  });
});

/* ---------- the route, end to end ---------- */
let server: Server, base = '', db: typeof import('../../server/src/db.js');
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [JWK] }), { status: 200 });
  if (u.startsWith('https://api.open-meteo.com') || u.startsWith('https://archive-api.open-meteo.com')) return new Response('{}', { status: 500 });
  return guard(input as any, init);
});
beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  Object.assign(process.env, { OWNER_KEY: 'test-owner-key-synthetic-nestevents-abcdefgh', SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij', NEST_EVENTS_AUDIENCE: AUD, NEST_EVENTS_SA: SA });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', $1)`, [Date.now() + 864e5]);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo; (globalThis as any).__testServerPorts.add(port); base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => {
  await db.kv.set('nest:last', { at: Date.now() - 60_000, deviceId: DEV, name: 'Hallway', online: true, indoorF: 76, humidity: 50, mode: 'COOL', hvac: 'OFF', coolF: 76, heatF: null, eco: false, ecoCoolF: 82, ecoHeatF: 50, fanTimer: false, availableModes: ['COOL', 'HEAT', 'OFF'] });
  await db.kv.set('s:ac:hold', null); await db.kv.set('nest:eventIds', {}); await db.kv.set('nest:lastSent:' + DEV, null);
  await db.kv.set('pool:forecast', { at: Date.now() + 864e5, days: [] });
});
const post = (body: unknown, token: string | null = jwt({})) => fetch(`${base}/api/nest/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const ev = (traits: Record<string, unknown>, o: Record<string, unknown> = {}) => push({ eventId: `e-${Math.random()}`, timestamp: new Date().toISOString(), resourceUpdate: { name: DEV, traits }, ...o });

describe('POST /api/nest/events', () => {
  it('NE-4 a setpoint changed at the wall is held within the same push', async () => {
    expect((await post(ev({ 'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: C(72) } }))).status).toBe(204);
    expect(await db.kv.get('nest:last')).toMatchObject({ coolF: 72 });
    expect(await db.kv.get('s:ac:hold')).toMatchObject({ by: 'wall', coolF: 72 });
    expect((await db.q(`SELECT cool_f FROM nest_readings WHERE site_id = 's' ORDER BY ts DESC LIMIT 1`))[0]).toMatchObject({ cool_f: 72 });
  });
  it('NE-5 Solstice’s own write, a reading, a replay, an older event and another device start no hold', async () => {
    await db.kv.set('nest:lastSent:' + DEV, { at: Date.now() - 5_000, by: 'autopilot', mode: 'COOL', coolF: 78, heatF: null });
    expect((await post(ev({ 'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: C(78) } }))).status).toBe(204);
    expect(await db.kv.get('s:ac:hold')).toBeNull();
    await post(ev({ 'sdm.devices.traits.ThermostatHvac': { status: 'COOLING' } }));
    expect(await db.kv.get('nest:last')).toMatchObject({ hvac: 'COOLING' });
    const once = ev({ 'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: C(70) } }, { eventId: 'dup-1', timestamp: new Date(Date.now() - 3600_000).toISOString() });
    await post(once);                                                                    // an hour older than the stored state: ignored
    expect(await db.kv.get('nest:last')).toMatchObject({ coolF: 78 });
    await post(ev({ 'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: C(70) } }, { resourceUpdate: { name: 'enterprises/test-proj/devices/other', traits: {} } }));
    expect(await db.kv.get('s:ac:hold')).toBeNull();
  });
  it('NE-6 no token, a forged token or a wrong audience is 401 and changes nothing; unconfigured is 503', async () => {
    const body = ev({ 'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: C(70) } });
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, jwt({}, 'test-kid', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey))).status).toBe(401);
    expect((await post(body, jwt({ aud: 'https://elsewhere.invalid' }))).status).toBe(401);
    expect(await db.kv.get('nest:last')).toMatchObject({ coolF: 76 });
    delete process.env.NEST_EVENTS_SA;
    expect((await post(body)).status).toBe(503);
    process.env.NEST_EVENTS_SA = SA;
  });
});
