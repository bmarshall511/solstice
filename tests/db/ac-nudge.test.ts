// "Too cold" / "Too warm" (POST /api/appliances/ac/nudge, mockup ag; audit 10b test batch 7 item 2). The owner's route on PGlite with the
// REAL Nest module (nest.ts readNest, ownerCommand, setCool and their guards) talking to a fake Smart Device Management API: fetch to
// smartdevicemanagement.googleapis.com is answered here from a synthetic thermostat (tests/fixtures/payloads.ts, SDM's own shape),
// every executeCommand is recorded, and nothing else may leave the process (tests/setup.ts). What is pinned:
//   NUDGE-1  "just for now": 1° from the current setpoint as an owner command, held until the next step
//   NUDGE-2  ...refused by guardManual outside 65–85°: 400, nothing sent, no hold
//   NUDGE-3  not cooling (Heat, Eco with no cool setpoint, a bad dir): 400, nothing sent
//   NUDGE-4  "keep" with Suggest: the day target moves 1° and the plan's step goes out as one owner command
//   NUDGE-5  "keep" refused by acPatchError (pre-cool/drift would leave 65–85°): 400, settings untouched, nothing sent
//   NUDGE-6  "keep" with Auto: Autopilot's guard refuses inside the 30-minute write slot; nothing sent, the refusal is logged
//   NUDGE-7  "keep" with Auto and a free slot: at most a 2° step goes out, inside 65–85°, and takes the slot
//   NUDGE-8  "keep" with Autopilot Off: Autopilot itself sends nothing; the nudge is the owner's own tap, sent as an owner command
// All values synthetic; the clock is fixed to a summer afternoon (14:00 Chicago).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../../server/src/app.js';
import { q, kv, migrate } from '../../server/src/db.js';
import { localDay } from '../../server/src/tesla/client.js';
import { fToC, cToF, readNest } from '../../server/src/appliances/nest.js';
import { forecastDays } from '../fixtures/forecast.js';
import { sdmThermostat, sdmError, SDM_DEVICE, type SdmThermostat } from '../fixtures/payloads.js';

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => false,
  readPool: vi.fn(async () => { throw new Error('readPool in nudge test'); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan in nudge test'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit in nudge test'); }),
}));

const NOW = Date.parse('2026-08-12T19:00:00Z');   // 14:00 CDT, a day hour
const SDM = 'https://smartdevicemanagement.googleapis.com/v1';
let server: Server, base = '', cookie = '';
let dev: SdmThermostat = {};
const sent: Array<{ command: string; params: any }> = [];
const guardFetch = globalThis.fetch;   // tests/setup.ts's guard: only the in-process app

/** The fake SDM API: the device list from `dev`; executeCommand applies SetCool/SetHeat/SetMode to `dev` and is recorded. */
async function sdm(url: string, init?: RequestInit): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if ((init?.headers as Record<string, string>)?.Authorization !== 'Bearer test-access') return json(sdmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'), 401);
  if (url === `${SDM}/enterprises/test-project/devices` && (init?.method ?? 'GET') === 'GET') return json({ devices: [sdmThermostat(dev)] });
  if (url === `${SDM}/${SDM_DEVICE}:executeCommand` && init?.method === 'POST') {
    const b = JSON.parse(String(init.body)); sent.push(b);
    if (b.command === 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool') {
      if ((dev.mode ?? 'COOL') !== 'COOL') return json(sdmError(400, 'FAILED_PRECONDITION', 'Command not supported in current mode.'), 400);
      dev = { ...dev, coolC: b.params.coolCelsius };
    }
    return json({});
  }
  return json(sdmError(404, 'NOT_FOUND', 'not found'), 404);
}
const setCools = () => sent.filter(c => c.command.endsWith('SetCool')).map(c => cToF(c.params.coolCelsius));
const nudge = (body: unknown) => fetch(`${base}/api/appliances/ac/nudge`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
/** The owner's AC settings and the thermostat, then one real readNest so `nest:last` is what the device says. */
async function given(ac: Record<string, unknown>, d: SdmThermostat) {
  dev = d; sent.length = 0;
  await kv.set('settings:owner', { ac });
  for (const k of ['s:ac:hold', 's:ac:plan', 's:ac:log', `nest:setpointWrite:${SDM_DEVICE}`, `nest:lastSent:${SDM_DEVICE}`, 'settings:changes']) await kv.set(k, null as any);
  await readNest();
  sent.length = 0;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  Object.assign(process.env, { NEST_PROJECT_ID: 'test-project', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });   // synthetic: nestConfigured()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    return u.startsWith(SDM) ? sdm(u, init) : guardFetch(input, init);
  });
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test')`);
  await kv.set('nest:tokens', { access_token: 'test-access', refresh_token: 'test-refresh', expires_at: NOW + 24 * 3600e3 });
  await kv.set('pool:forecast', { at: NOW, days: forecastDays(localDay()) });
  await kv.set('s:ac:slope', { at: NOW, slope: 2.5 });
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const unlock = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) });
  expect(unlock.status).toBe(200);
  cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0];
});
afterAll(async () => { vi.stubGlobal('fetch', guardFetch); vi.useRealTimers(); await new Promise(r => server.close(r)); });
beforeEach(() => { sent.length = 0; });

describe('just for now (keep: false)', () => {
  it('NUDGE-1 "Too cold" sends the current setpoint + 1° as an owner command and holds it', async () => {
    await given({ autopilot: 'suggest' }, { coolC: fToC(78) });
    const r = await nudge({ dir: 1, keep: false });
    expect(r.status).toBe(200);
    expect(sent).toEqual([{ command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', params: { coolCelsius: fToC(79) } }]);
    const b = await r.json();
    expect(b.state.coolF).toBe(79);
    expect(await kv.get('s:ac:hold')).toMatchObject({ by: 'app', mode: 'COOL', coolF: 79 });
    expect(await kv.get(`nest:setpointWrite:${SDM_DEVICE}`)).toBeNull();      // an owner tap never takes Autopilot's 30-minute slot
    expect((await kv.get<any>('settings:owner')).ac).toEqual({ autopilot: 'suggest' });   // "just for now" changes no target
  });

  it('NUDGE-2 outside 65–85° the guard refuses: 400, nothing sent, no hold', async () => {
    for (const [f, dir] of [[85, 1], [65, -1]] as const) {
      await given({ autopilot: 'suggest' }, { coolC: fToC(f) });
      const r = await nudge({ dir, keep: false });
      expect(r.status, `${f}° ${dir}`).toBe(400);
      expect((await r.json()).error).toMatch(/cooling setpoints must be 65–85°/);
      expect(sent).toEqual([]);
      expect(await kv.get('s:ac:hold')).toBeNull();
      expect((await kv.get<any>('nest:last')).coolF).toBe(f);
    }
  });

  it('NUDGE-3 nothing to nudge when the thermostat is not cooling, or the body is wrong', async () => {
    await given({ autopilot: 'suggest' }, { mode: 'HEAT', coolC: null, heatC: fToC(68) });
    expect((await nudge({ dir: 1 })).status).toBe(400);
    await given({ autopilot: 'suggest' }, { mode: 'COOL', eco: 'MANUAL_ECO', coolC: null });   // SDM sends no cool setpoint in Eco
    const r = await nudge({ dir: -1 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/isn.t cooling/);
    await given({ autopilot: 'suggest' }, { coolC: fToC(78) });
    for (const bad of [{ dir: 2 }, { dir: 'up' }, {}, { dir: 0, keep: true }]) expect((await nudge(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe('keep (the target moves)', () => {
  it('NUDGE-4 Suggest: the day target moves 1° and the plan\'s step goes out once, inside 65–85°', async () => {
    await given({ autopilot: 'suggest', dayF: 77, nightF: 76, driftF: 1, precoolDepth: 2 }, { coolC: fToC(77) });
    const r = await nudge({ dir: 1, keep: true });
    expect(r.status).toBe(200);
    expect((await kv.get<any>('settings:owner')).ac).toMatchObject({ dayF: 78, nightF: 76 });   // 14:00 is a day hour: only dayF moved
    const b = await r.json();
    expect(b.settings.dayF).toBe(78);
    expect(setCools()).toHaveLength(1);
    const f = setCools()[0];
    expect(f).toBeGreaterThanOrEqual(65); expect(f).toBeLessThanOrEqual(85);
    expect(b.plan.steps.some((s: any) => s.coolF === f)).toBe(true);           // a step of the new plan, not a free number
    expect(await kv.get('s:ac:hold')).toMatchObject({ by: 'app', coolF: f });
  });

  it('NUDGE-5 a target that would take pre-cool or drift outside 65–85° is refused: 400, settings untouched, nothing sent', async () => {
    const ac = { autopilot: 'suggest', dayF: 83, nightF: 78, driftF: 2, precoolDepth: 2 };
    await given(ac, { coolC: fToC(80) });
    const r = await nudge({ dir: 1, keep: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/pre-cool and drift must stay inside 65–85°/);
    expect((await kv.get<any>('settings:owner')).ac).toEqual(ac);
    expect(sent).toEqual([]);
  });

  it('NUDGE-6 Auto inside the 30-minute write slot: Autopilot\'s guard refuses, nothing is sent, the refusal is logged', async () => {
    await given({ autopilot: 'auto', dayF: 77, nightF: 76, driftF: 1, precoolDepth: 2 }, { coolC: fToC(82) });
    await kv.set(`nest:setpointWrite:${SDM_DEVICE}`, { at: NOW - 10 * 60_000, f: 82 });
    const r = await nudge({ dir: -1, keep: true });
    expect(r.status).toBe(200);
    expect((await kv.get<any>('settings:owner')).ac.dayF).toBe(76);
    expect(sent).toEqual([]);
    expect((await kv.get<any[]>('s:ac:log'))?.[0]?.text).toMatch(/^Did not set .*one setpoint change per 30 min/);
  });

  it('NUDGE-7 Auto with a free slot: one write, at most 2° from the setpoint, inside 65–85°, and it takes the slot', async () => {
    await given({ autopilot: 'auto', dayF: 77, nightF: 76, driftF: 1, precoolDepth: 2 }, { coolC: fToC(85) });
    const r = await nudge({ dir: -1, keep: true });
    expect(r.status).toBe(200);
    expect(setCools()).toEqual([83]);                                          // 85 → the plan's ~75°: stepped to 83 by the guard
    expect(await kv.get(`nest:setpointWrite:${SDM_DEVICE}`)).toEqual({ at: NOW, f: 83 });
    expect((await kv.get<any[]>('s:ac:log'))?.[0]).toMatchObject({ text: expect.stringMatching(/^Set 83° \(/), delta: 'stepping' });   // acTick steps it itself; the guard re-checks
    // a second nudge in the same half hour: the slot is taken, nothing more goes out
    sent.length = 0;
    expect((await nudge({ dir: -1, keep: true })).status).toBe(200);
    expect(setCools()).toEqual([]);
  });

  it('NUDGE-8 Autopilot Off: the nudge is the owner\'s own tap, so it goes out as an owner command (not through Autopilot)', async () => {
    await given({ autopilot: 'off', dayF: 77, nightF: 76, driftF: 1, precoolDepth: 2 }, { coolC: fToC(80) });
    const r = await nudge({ dir: -1, keep: true });
    expect(r.status).toBe(200);
    expect(setCools()).toHaveLength(1);
    expect(await kv.get(`nest:setpointWrite:${SDM_DEVICE}`)).toBeNull();      // Autopilot's slot untouched: it wrote nothing
    expect(await kv.get('s:ac:hold')).toMatchObject({ by: 'app' });
  });
});
