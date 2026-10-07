// Vacation mode, the AC (server/src/vacation/ac.ts; mockup ak frames 2, 3, 5; owner's answers 2026-10-06), end to end through acTick
// on PGlite with a fake Nest: the real setCool/setHeat/tripEcoOff (so the guards and the 30-minute slot run) against a fake SDM that
// records each command; readNest answers from a synthetic thermostat the test moves. No network, no device.
//   VAC-AC-1 the trip starts: Eco off first, then 78 → 80 → 82 → 84 → 85, one write per 30 minutes
//   VAC-AC-2 humidity over 60% for 2 h steps the hold to 83°; under 55% for an hour steps it back up; never below 80°
//   VAC-AC-3 the welcome: started early enough at this house's rate, aiming at the arrival hour's target; late → back to the hold
//   VAC-AC-4 someone at the thermostat (a hold) is left alone; AC Autopilot Off writes nothing and says so once
//   VAC-AC-5 heating: 68 → 66 … → 55 in 2° steps; at the welcome your 68° comes back in one write; at the end too
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const S = vi.hoisted(() => ({ st: null as any, sdm: [] as Array<{ command: string; params: any }> }));
vi.mock('../../server/src/sync.js', async orig => ({ ...(await orig<typeof import('../../server/src/sync.js')>()), refreshLive: vi.fn(async () => false) }));
vi.mock('../../server/src/appliances/nest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/src/appliances/nest.js')>();
  const { kv } = await import('../../server/src/db.js');
  return { ...actual, nestConfigured: () => true, nestLinked: async () => true,
    readNest: vi.fn(async () => { const st = { ...S.st, at: Date.now() }; await kv.set('nest:last', st); return st; }) };
});

import { q, kv, migrate } from '../../server/src/db.js';
import { acTick } from '../../server/src/appliances/ac.js';
import { createTrip, liveTrip, endTrip, patchTripData } from '../../server/src/vacation/trip.js';
import { freshTripAc, tripAcEnd, pulldownKey } from '../../server/src/vacation/ac.js';

const SITE = 's', MIN = 60_000, H = 3600_000;
const NOW = Date.parse('2026-07-15T13:00:00-05:00');   // a July afternoon, Central
const SDM = 'https://smartdevicemanagement.googleapis.com/v1';
const settings = (o: Record<string, unknown> = {}) => ({ ac: { autopilot: 'auto', dayF: 78, nightF: 77, ...o } });
const thermostat = (o: Record<string, unknown> = {}) => ({ at: 0, deviceId: 'dev-test', name: 'Hallway', online: true, indoorF: 78, humidity: 50, mode: 'COOL', hvac: 'OFF',
  coolF: 78, heatF: null, eco: false, ecoCoolF: 82, ecoHeatF: 50, fanTimer: false, availableModes: ['COOL', 'HEAT', 'HEATCOOL', 'OFF'], ...o });
/** One cron tick at `t`: acTick, then the fake thermostat takes whatever was sent (as Nest would). */
async function tick(t: number, o: Record<string, unknown> = {}) {
  vi.setSystemTime(t);
  const n = S.sdm.length, r = await acTick(SITE, settings(o), .12, 2.5);
  for (const c of S.sdm.slice(n)) {
    if (c.command.endsWith('SetCool')) S.st.coolF = Math.round((c.params.coolCelsius * 9 / 5 + 32) * 10) / 10;
    if (c.command.endsWith('SetHeat')) S.st.heatF = Math.round((c.params.heatCelsius * 9 / 5 + 32) * 10) / 10;
    if (c.command.endsWith('ThermostatEco.SetMode')) S.st.eco = c.params.mode !== 'OFF';
  }
  // the change reaches the stored state within minutes in the app (a Pub/Sub event or the next sample), as it does here
  if (S.sdm.length > n) await kv.set('nest:last', { ...S.st, at: t + 60_000 });
  return r as any;
}
const sent = () => S.sdm.map(c => c.command.endsWith('SetMode') ? `eco ${c.params.mode}` : c.command.endsWith('SetHeat') ? `heat ${Math.round(c.params.heatCelsius * 9 / 5 + 32)}` : `cool ${Math.round(c.params.coolCelsius * 9 / 5 + 32)}`);
const acLog = async () => ((await kv.get<any[]>(`${SITE}:ac:log`)) ?? []).map(l => l.text);
async function startTrip(backAt: number | null, st = S.st) {
  const t = await createTrip(SITE, { leaveAt: Date.now(), backAt, detected: false }, Date.now());
  await patchTripData(t.id, { ac: freshTripAc(st) });
  return t;
}

let restore = () => {};
beforeAll(async () => { await migrate(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  S.st = thermostat(); S.sdm.length = 0;
  for (const t of ['trips', 'nest_readings', 'readings']) await q(`DELETE FROM ${t}`);
  await q(`DELETE FROM kv`);
  await kv.set('nest:tokens', { access_token: 'test-token', refresh_token: 'test-refresh', expires_at: NOW + 10 * 864e5 });
  await kv.set('pool:forecast', { at: NOW + 10 * 864e5, days: [] });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${SDM}/dev-test:executeCommand`)) throw new Error(`unexpected fetch: ${url}`);
    const b = JSON.parse(String(init?.body)); S.sdm.push({ command: b.command, params: b.params });
    return new Response('{}', { status: 200 });
  });
  restore = () => spy.mockRestore();
});
afterEach(() => { restore(); vi.useRealTimers(); });

describe('the AC during a trip', () => {
  it('VAC-AC-1 Eco off first, then 78 → 80 → 82 → 84 → 85, one write per 30 minutes', async () => {
    S.st.eco = true; S.st.coolF = null;
    await startTrip(NOW + 3 * 864e5);
    expect(await tick(NOW)).toMatchObject({ ecoOff: true });
    S.st.coolF = 78;                                                         // out of Eco, the thermostat shows its own setpoint again
    for (let m = 5; m <= 120; m += 5) await tick(NOW + m * MIN);
    expect(sent()).toEqual(['eco OFF', 'cool 80', 'cool 82', 'cool 84', 'cool 85']);
    const writes = await q<{ value: any }>(`SELECT value FROM kv WHERE key = 'nest:setpointWrite:dev-test'`);
    expect(writes[0].value.f).toBe(85);
    expect((await acLog()).slice(-2)).toEqual(['Set 80° (vacation); safety stepped: 78° → 85° is more than 2°, so 80° now', 'Vacation mode: turned Eco off so Solstice can hold the trip setting']);
    // Home/Away Assist turns Eco back on an hour later: off again only after 6 h
    S.st.eco = true; await tick(NOW + 3 * H); expect(sent()).toHaveLength(5);
    await tick(NOW + 6 * H + MIN); expect(sent().at(-1)).toBe('eco OFF');
  });

  it('VAC-AC-2 humidity over 60% for 2 h → 83°; under 55% for an hour → back to 85°; the floor is 80°', async () => {
    S.st.coolF = 85; S.st.humidity = 63; await startTrip(NOW + 5 * 864e5);   // each tick also stores the thermostat's own reading
    const rh = async (from: number, to: number, v: number) => { for (let t = from; t <= to; t += 15 * MIN) await q(`INSERT INTO nest_readings (site_id, ts, day, hour, humidity, mode, hvac, cool_f, eco) VALUES ($1,$2,'2026-07-15',13,$3,'COOL','OFF',85,false) ON CONFLICT DO NOTHING`, [SITE, t, v]); };
    await rh(NOW - 90 * MIN, NOW, 63);                                        // 1.5 h of 63%: not yet
    await tick(NOW); expect(sent()).toEqual([]);
    await rh(NOW, NOW + 30 * MIN, 64); await tick(NOW + 30 * MIN);
    expect(sent()).toEqual(['cool 83']);
    expect(await acLog()).toContain('Humidity 63–64% for 2 h: holding 83° to dry the house');
    // still damp 2 h later: 81, then 80 is the floor
    await rh(NOW + 30 * MIN, NOW + 7 * H, 66); S.st.humidity = 66;
    for (const h of [2.5, 3, 4.5, 5, 6.5, 7]) await tick(NOW + h * H);
    expect(sent()).toEqual(['cool 83', 'cool 81', 'cool 80']);
    // dry again: an hour under 55% steps it back up a step an hour (85 − 2 per step: 81, then 83)
    await rh(NOW + 7.25 * H, NOW + 10 * H, 50); S.st.humidity = 50;
    for (const h of [8.5, 9.5]) await tick(NOW + h * H);
    expect(sent().slice(3)).toEqual(['cool 81', 'cool 83']);
  });

  it('VAC-AC-3 the welcome starts early enough at this house\'s rate; late with no sign of you → back to the hold', async () => {
    S.st.coolF = 85; S.st.indoorF = 85;
    const back = NOW + 5 * H;                                                // 6 PM: the day target, 78°
    await kv.set(pulldownKey(SITE), [{ at: 1, high: 95, rate: 2 }, { at: 2, high: 96, rate: 2 }]);   // two measured welcomes
    await startTrip(back);
    await tick(NOW);                                                          // 0.5 + 7 / 2 = 4 h ahead: not yet (14:00)
    expect(sent()).toEqual([]);
    await tick(NOW + 61 * MIN);                                               // 14:01: started
    expect(sent()).toEqual(['cool 83']);
    expect((await acLog()).some(t => /^Welcome home: cooling from 85° to 78° for 6:00 PM/.test(t))).toBe(true);
    for (let m = 61; m <= 300; m += 30) { S.st.indoorF = Math.max(78, 85 - (m - 61) / 60 * 2); await tick(NOW + m * MIN + MIN); }
    expect(sent()).toEqual(['cool 83', 'cool 81', 'cool 79', 'cool 78']);
    const trip = (await liveTrip(SITE))!;
    expect((trip.data.ac as any).welcome).toMatchObject({ target: 78, fromF: 85, solar: false });
    expect((trip.data.ac as any).welcome.reachedAt).toBeGreaterThan(NOW);
    expect((await kv.get<any[]>(pulldownKey(SITE)))![0]).toMatchObject({ rate: expect.any(Number) });
    // 2 h past the arrival time and nobody came home: back to 85° (stepped)
    for (const m of [0, 30, 60, 90]) await tick(back + 2 * H + m * MIN);
    expect(sent().slice(4)).toEqual(['cool 80', 'cool 82', 'cool 84', 'cool 85']);
  });

  it('VAC-AC-4 a change at the thermostat during a trip is left alone; Autopilot Off writes nothing and says so once', async () => {
    S.st.coolF = 85; await startTrip(NOW + 3 * 864e5);
    await tick(NOW);
    S.st.coolF = 74; await tick(NOW + 5 * MIN); await tick(NOW + 40 * MIN);   // someone set 74° at the wall
    expect(sent()).toEqual([]);
    expect((await acLog()).some(t => t.startsWith('Someone set 74° at the thermostat'))).toBe(true);
    await kv.set(`${SITE}:ac:hold`, null); S.sdm.length = 0;
    await tick(NOW + 9 * H, { autopilot: 'off' }); await tick(NOW + 9 * H + 5 * MIN, { autopilot: 'off' });
    expect(sent()).toEqual([]);
    expect((await acLog()).filter(t => t.startsWith('Vacation mode: AC Autopilot is Off'))).toHaveLength(1);
  });

  it('VAC-AC-5 heating: 68 → 55 in 2° steps; your 68° back in one write at the welcome, and at the end', async () => {
    vi.setSystemTime(Date.parse('2026-01-15T09:00:00-06:00'));
    const t0 = Date.now();
    S.st = thermostat({ mode: 'HEAT', heatF: 68, coolF: null, indoorF: 67 });
    await startTrip(t0 + 2 * 864e5);
    for (let m = 0; m <= 240; m += 30) await tick(t0 + m * MIN);
    expect(sent()).toEqual(['heat 66', 'heat 64', 'heat 62', 'heat 60', 'heat 58', 'heat 56', 'heat 55']);
    S.st.indoorF = 58;
    await tick(t0 + 2 * 864e5 - 30 * MIN);                                    // the welcome: 68° in one write
    expect(sent().at(-1)).toBe('heat 68');
    // a second trip that ends early: the end puts the heat back
    await endTrip(SITE, 'you'); S.sdm.length = 0; S.st.heatF = 68;
    vi.setSystemTime(t0 + 3 * 864e5);
    const trip = await startTrip(t0 + 10 * 864e5);
    for (let m = 0; m <= 60; m += 30) await tick(t0 + 3 * 864e5 + m * MIN);
    expect(sent()).toEqual(['heat 66', 'heat 64', 'heat 62']);
    vi.setSystemTime(t0 + 3 * 864e5 + 2 * H);
    const ended = (await endTrip(SITE, 'you'))!;
    expect(await tripAcEnd(SITE, ended, 'auto')).toEqual({ restored: true });
    expect(sent().at(-1)).toBe('heat 68');
    expect(trip.id).toBe(ended.id);
  });
});
