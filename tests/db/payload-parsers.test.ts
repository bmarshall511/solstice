// The parsers behind every outside call, fed raw payloads with the providers' real shape and synthetic values (tests/fixtures/payloads.ts;
// audit 10b, test batch 7 item 5). Until now every test replaced these functions above the parsing layer. Here fetch itself is faked per
// test, so the real code builds the request, reads the body and handles missing fields and error bodies:
//   PP-N*  Google SDM device list → readNest (Celsius to °F, traits that may be absent, Eco, Fan, errors, the Google token refresh)
//   PP-T*  the Fleet API HTTP layer, teslaFor().get (401 refresh once, 429 back-off, error and non-JSON bodies, a 2xx without a body,
//          the timeout signal) and the sync recording a body-less 2xx in Data health
//   PP-O*  Open-Meteo: the pool forecast (autopilot.ts), tilted irradiance (learn/wx.ts), the archive highs and lows (learn/homeModel.ts),
//          the soiling weather with its archive rain (soiling.ts)
//   PP-W*  NWS alerts GeoJSON (outage.ts nwsAlerts)
//   PP-E*  the ERCOT dashboards (watch.ts ercotNow)
// PGlite in memory for the kv caches; any URL a test did not fake is refused by tests/setup.ts. All values synthetic.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { readNest, cToF } from '../../server/src/appliances/nest.js';
import { teslaFor, localDay, addDays, FLEET_TIMEOUT_MS } from '../../server/src/tesla/client.js';
import { accessToken } from '../../server/src/tesla/auth.js';
import { syncSite } from '../../server/src/sync.js';
import { forecastAged } from '../../server/src/appliances/autopilot.js';
import { wxGti, WX_KEY } from '../../server/src/learn/wx.js';
import { wxHiLo, HILO_KEY } from '../../server/src/learn/homeModel.js';
import { soilWx } from '../../server/src/soiling.js';
import { nwsAlerts } from '../../server/src/outage.js';
import { ercotNow } from '../../server/src/watch.js';
import { sdmThermostat, sdmCamera, sdmError, SDM_DEVICE, fleetOk, fleetError, openMeteoForecast, openMeteoGti, openMeteoArchive, openMeteoError,
  nwsAlerts as nwsPayload, nwsProblem, ercotPrc, ercotSupplyDemand } from '../fixtures/payloads.js';

vi.mock(import('../../server/src/tesla/auth.js'), async orig => ({ ...(await orig()), accessToken: vi.fn(async (_id: number, stale: string | null = null) => stale ? 'test-fresh' : 'test-old') }));

type Fake = (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>;
const guardFetch = globalThis.fetch;   // tests/setup.ts's guard: anything not faked below is refused and fails the test
let calls: Array<{ url: string; init?: RequestInit }> = [];
/** Answer fetches whose URL starts with a key; the handler gets the call count for that key (0-based). */
function fake(routes: Record<string, Fake>) {
  const counts = new Map<string, number>();
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input), key = Object.keys(routes).find(k => url.startsWith(k));
    if (!key) return guardFetch(input, init);
    calls.push({ url, init }); const n = counts.get(key) ?? 0; counts.set(key, n + 1);
    return routes[key](url, init, n);
  });
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status: number) => new Response(`<html><body><h1>${status}</h1></body></html>`, { status, headers: { 'Content-Type': 'text/html' } });

beforeAll(async () => { await migrate(); });
beforeEach(async () => {
  calls = [];
  Object.assign(process.env, { SITE_LAT: '12.34', SITE_LON: '-56.78', NEST_PROJECT_ID: 'test-project', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });   // synthetic
  await q(`DELETE FROM kv`);
});
afterEach(() => { vi.stubGlobal('fetch', guardFetch); vi.useRealTimers(); for (const k of ['SITE_LAT', 'SITE_LON', 'NEST_PROJECT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) delete process.env[k]; });

/* ======================= Google SDM ======================= */
const SDM_LIST = 'https://smartdevicemanagement.googleapis.com/v1/enterprises/test-project/devices';
const TOKEN = 'https://oauth2.googleapis.com/token';
describe('Nest: readNest on the SDM device list', () => {
  beforeEach(async () => { await kv.set('nest:tokens', { access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Date.now() + 3600e3 }); });

  it('PP-N1 a full thermostat: every trait read, Celsius to °F (one decimal), stored as nest:last', async () => {
    fake({ [SDM_LIST]: () => json({ devices: [sdmThermostat({ hvac: 'COOLING', humidity: 52 })] }) });
    const st = await readNest();
    expect(st).toEqual({ at: expect.any(Number), deviceId: SDM_DEVICE, name: 'Hallway', online: true, indoorF: 76, humidity: 52, mode: 'COOL', hvac: 'COOLING',
      coolF: 78, heatF: null, eco: false, ecoCoolF: 85, ecoHeatF: 46, fanTimer: false, fanUntil: null, availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] });
    expect(await kv.get('nest:last')).toEqual(st);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer test-access');
    expect(cToF(25.5556)).toBe(78); expect(cToF(23.8889)).toBe(75); expect(cToF(24.1)).toBe(75.4);
  });

  it('PP-N2 Heat · Cool range, Eco on with no setpoint, the fan timer', async () => {
    fake({ [SDM_LIST]: (_u, _i, n) => json({ devices: [n === 0
      ? sdmThermostat({ mode: 'HEATCOOL', heatC: 20, coolC: 25.5556 })
      : sdmThermostat({ eco: 'MANUAL_ECO', coolC: null, fan: { timerMode: 'ON', timerTimeout: '2026-08-12T20:15:00Z' } })] }) });
    expect(await readNest()).toMatchObject({ mode: 'HEATCOOL', heatF: 68, coolF: 78, eco: false });
    expect(await readNest()).toMatchObject({ eco: true, coolF: null, heatF: null, ecoCoolF: 85, fanTimer: true, fanUntil: Date.parse('2026-08-12T20:15:00Z') });
  });

  it('PP-N3 missing traits read as unknown, never as numbers; offline; no room name', async () => {
    fake({ [SDM_LIST]: () => json({ devices: [sdmThermostat({ omit: ['Temperature', 'Humidity', 'ThermostatHvac', 'Fan', 'ThermostatEco', 'ThermostatMode', 'Connectivity'], room: null })] }) });
    expect(await readNest()).toMatchObject({ name: 'Thermostat', online: false, indoorF: null, humidity: null, mode: 'OFF', hvac: 'OFF', coolF: 78,
      eco: false, ecoCoolF: null, ecoHeatF: null, fanTimer: false, fanUntil: null, availableModes: [] });
  });

  it('PP-N4 the first thermostat on the account (a camera is skipped); none at all is an error and nothing is stored', async () => {
    fake({ [SDM_LIST]: (_u, _i, n) => json(n === 0 ? { devices: [sdmCamera(), sdmThermostat()] } : n === 1 ? { devices: [sdmCamera()] } : {}) });
    expect((await readNest()).deviceId).toBe(SDM_DEVICE);
    await kv.set('nest:last', null as any);
    await expect(readNest()).rejects.toThrow('No thermostat shared with Solstice');
    await expect(readNest()).rejects.toThrow('No thermostat shared with Solstice');   // {} (no devices key): the same
    expect(await kv.get('nest:last')).toBeNull();
  });

  it('PP-N5 error bodies: Google\'s message when there is one, else the status', async () => {
    fake({ [SDM_LIST]: (_u, _i, n) => n === 0 ? json(sdmError(429, 'RESOURCE_EXHAUSTED', 'Rate limited.'), 429) : html(502) });
    await expect(readNest()).rejects.toThrow('Nest: Rate limited.');
    await expect(readNest()).rejects.toThrow('Nest: 502');
  });

  it('PP-N6 an expired access token is refreshed once with the stored refresh token; a refused refresh says why', async () => {
    await kv.set('nest:tokens', { access_token: 'test-expired', refresh_token: 'test-refresh', expires_at: Date.now() - 1000 });
    fake({
      [TOKEN]: (_u, init, n) => n === 0 ? json({ access_token: 'test-renewed', expires_in: 3599, scope: 'https://www.googleapis.com/auth/sdm.service', token_type: 'Bearer' })
        : json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
      [SDM_LIST]: (_u, init) => (init?.headers as Record<string, string>).Authorization === 'Bearer test-renewed' ? json({ devices: [sdmThermostat()] }) : json(sdmError(401, 'UNAUTHENTICATED', 'bad token'), 401),
    });
    expect((await readNest()).coolF).toBe(78);
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(Object.fromEntries(body)).toEqual({ client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh', grant_type: 'refresh_token' });
    const t = await kv.get<any>('nest:tokens');
    expect(t).toMatchObject({ access_token: 'test-renewed', refresh_token: 'test-refresh' });   // Google sends no new refresh token: the old one is kept
    expect(t.expires_at).toBeGreaterThan(Date.now() + 3400e3);
    await kv.set('nest:tokens', { ...t, expires_at: 0 });
    await expect(readNest()).rejects.toThrow('Google token: Token has been expired or revoked.');
  });
});

/* ======================= Tesla Fleet API ======================= */
const FLEET = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
describe('Fleet API: teslaFor().get', () => {
  const tokens = () => calls.map(c => (c.init?.headers as Record<string, string>).Authorization);

  it('PP-T1 200: the response envelope is unwrapped; query parameters are sent encoded', async () => {
    fake({ [FLEET]: () => json(fleetOk({ time_series: [{ timestamp: '2026-08-12T00:00:00-05:00', solar_energy_exported: 0 }] })) });
    const r = await teslaFor(1).energy('test-site', '2026-08-12T00:00:00-05:00', '2026-08-12T23:59:59-05:00');
    expect(r.time_series).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/1/energy_sites/test-site/calendar_history');
    expect(Object.fromEntries(u.searchParams)).toEqual({ time_zone: 'America/Chicago', kind: 'energy', period: 'day', start_date: '2026-08-12T00:00:00-05:00', end_date: '2026-08-12T23:59:59-05:00' });
    expect(tokens()).toEqual(['Bearer test-old']);
  });

  it('PP-T2 401: one refresh past the refused token, then the retry; a second 401 is an error (no loop)', async () => {
    fake({ [FLEET]: (_u, init) => (init?.headers as Record<string, string>).Authorization === 'Bearer test-fresh' ? json(fleetOk({ ok: 1 })) : json(fleetError('invalid bearer token'), 401) });
    expect(await teslaFor(1).liveStatus('test-site')).toEqual({ ok: 1 });
    expect(tokens()).toEqual(['Bearer test-old', 'Bearer test-fresh']);
    expect(vi.mocked(accessToken).mock.calls.slice(-2)).toEqual([[1, null], [1, 'test-old']]);   // the stale token is passed, so auth.ts refreshes
    calls = [];
    fake({ [FLEET]: () => json(fleetError('invalid bearer token', 'token expired'), 401) });
    await expect(teslaFor(1).siteInfo('test-site')).rejects.toThrow('Tesla /api/1/energy_sites/test-site/site_info → HTTP 401: invalid bearer token token expired');
    expect(calls).toHaveLength(2);
  });

  it('PP-T3 429: backs off 1.5 s then 6 s, three tries in all, then the error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fake({ [FLEET]: (_u, _i, n) => n < 2 ? json(fleetError('Too Many Requests'), 429) : json(fleetOk({ ok: 2 })) });
    const p = teslaFor(1).liveStatus('test-site');
    await vi.advanceTimersByTimeAsync(1499); expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5999); expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: 2 });
    calls = [];
    fake({ [FLEET]: () => json(fleetError('Too Many Requests'), 429) });
    const q2 = teslaFor(1).liveStatus('test-site').catch(e => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await q2) as Error).message).toBe('Tesla /api/1/energy_sites/test-site/live_status → HTTP 429: Too Many Requests');
    expect(calls).toHaveLength(3);
  });

  it('PP-T4 a non-JSON error body (a gateway\'s HTML page) still gives a clean error with the status', async () => {
    fake({ [FLEET]: () => html(504) });
    await expect(teslaFor(1).backups('test-site', 'a', 'b')).rejects.toThrow(/^Tesla \/api\/1\/energy_sites\/test-site\/calendar_history → HTTP 504:$/);
  });

  it('PP-T5 a 200 without the response envelope (or with a non-JSON body) is a clear error, not undefined; an explicit null passes', async () => {
    fake({ [FLEET]: (_u, _i, n) => n === 0 ? json({ unexpected: true }) : n === 1 ? new Response('not json', { status: 200 }) : json({ response: null }) });
    await expect(teslaFor(1).products()).rejects.toThrow('Tesla /api/1/products → HTTP 200 without a response body');
    await expect(teslaFor(1).products()).rejects.toThrow('Tesla /api/1/products → HTTP 200 without a response body');
    expect(await teslaFor(1).products()).toBeNull();
  });

  it('PP-T7 every sync step records a body-less 200 in Data health (kv error:<step>) and the sync returns, nothing stored', async () => {
    const [a] = await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'test-access', 'test-refresh', 0) RETURNING id`);
    await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('pp-t7', NULL, $1, 'Test Site') ON CONFLICT (id) DO NOTHING`, [a.id]);
    fake({ [FLEET]: () => json({}) });
    const r = await syncSite('pp-t7', 8_000, { nightly: true });
    const msg = (p: string) => `Tesla /api/1/energy_sites/pp-t7/${p} → HTTP 200 without a response body`;
    expect(r.done).toEqual([]);
    expect(r.errors).toEqual(expect.arrayContaining([`live: ${msg('live_status')}`, `siteInfo: ${msg('site_info')}`,
      `lastHistory: ${msg('calendar_history')}`, `lastBackups: ${msg('calendar_history')}`]));
    for (const [k, p] of [['live', 'live_status'], ['siteInfo', 'site_info'], ['lastHistory', 'calendar_history'], ['lastBackups', 'calendar_history']])
      expect(await kv.get(`pp-t7:error:${k}`)).toMatchObject({ message: msg(p) });
    expect(r.errors.every(e => !/TypeError|Cannot read|undefined/.test(e))).toBe(true);
    for (const t of ['readings', 'energy', 'soe', 'backup_events']) expect(await q(`SELECT 1 FROM ${t} WHERE site_id = 'pp-t7'`)).toEqual([]);
  });

  it('PP-T6 every call carries a deadline signal; a timeout rejects the call (no retry)', async () => {
    fake({ [FLEET]: (_u, init) => { expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init!.signal!.aborted).toBe(false);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
    await expect(teslaFor(1).liveStatus('test-site')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls).toHaveLength(1);
    expect(FLEET_TIMEOUT_MS).toBe(12_000);
  });
});

/* ======================= Open-Meteo ======================= */
const OM = 'https://api.open-meteo.com/v1/forecast', OMA = 'https://archive-api.open-meteo.com/v1/archive';
const daysFrom = (start: string, n: number) => Array.from({ length: n }, (_, i) => addDays(start, i));
describe('Open-Meteo', () => {
  it('PP-O1 pool forecast: MJ/m² → kWh/m², hourly W/m² → kW/m² by local hour, null rain is 0; cached', async () => {
    const today = localDay(), days = daysFrom(addDays(today, -3), 10);
    fake({ [OM]: () => json(openMeteoForecast(days, { rainMm: [null, 2.5] })) });
    const f = await forecastAged();
    expect(f.stale).toBe(false);
    expect(f.days).toHaveLength(10);
    expect(f.days[0]).toMatchObject({ date: days[0], high: 91.4, rainMm: 0, rainPct: 10, sunKwhM2: 6 });
    expect(f.days[1].rainMm).toBe(2.5);
    expect(f.days[0].hourlySun).toHaveLength(24);
    expect(f.days[0].hourlySun[13]).toBe(0.8); expect(f.days[0].hourlySun[3]).toBe(0);
    const u = new URL(calls[0].url);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ latitude: '12.34', longitude: '-56.78', timezone: 'America/Chicago', past_days: '3', forecast_days: '7', temperature_unit: 'fahrenheit' });
    expect((await kv.get<any>('pool:forecast')).days).toEqual(f.days);
    expect((await forecastAged()).days).toEqual(f.days);                    // within the hour: from the cache, no second call
    expect(calls).toHaveLength(1);
  });

  it('PP-O2 pool forecast errors: an error body throws with no cache; a cache up to 12 h old is served stale', async () => {
    fake({ [OM]: () => json(openMeteoError('Latitude must be in range of -90 to 90°.'), 400) });
    await expect(forecastAged()).rejects.toThrow('Open-Meteo: HTTP 400');
    const days = [{ date: localDay(), high: 90, rainMm: 0, rainPct: 0, sunKwhM2: 6, hourlySun: Array(24).fill(0) }];
    await kv.set('pool:forecast', { at: Date.now() - 2 * 3600e3, days });
    expect(await forecastAged()).toMatchObject({ days, stale: true, error: 'Open-Meteo: HTTP 400' });
    await kv.set('pool:forecast', { at: Date.now() - 13 * 3600e3, days });
    await expect(forecastAged()).rejects.toThrow('Open-Meteo: HTTP 400');
  });

  it('PP-O3 pool forecast: a 200 without the hourly block is an error (never a forecast of zero sun); the stale cache covers it', async () => {
    const p = openMeteoForecast([localDay()]) as any; delete p.hourly;
    fake({ [OM]: () => json(p) });
    await expect(forecastAged()).rejects.toThrow();
    await kv.set('pool:forecast', { at: Date.now() - 2 * 3600e3, days: [] });
    expect((await forecastAged()).stale).toBe(true);
    expect(await kv.get<any>('pool:forecast')).toMatchObject({ days: [] });   // the bad payload was not cached
  });

  it('PP-O4 tilted irradiance (wx:gti): the panels\' tilt and azimuth are asked for; an empty or failed reply keeps the last good payload', async () => {
    const days = daysFrom(addDays(localDay(), -31), 34);
    fake({ [OM]: (_u, _i, n) => n === 0 ? json(openMeteoGti(days)) : n === 1 ? json({ ...openMeteoGti([]), hourly: { time: [], global_tilted_irradiance: [], temperature_2m: [] } }) : json(openMeteoError('boom'), 500) });
    const w = await wxGti();
    expect(w!.hourly.time).toHaveLength(34 * 24);
    expect(w!.daily.temperature_2m_min).toHaveLength(34);
    expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toMatchObject({ tilt: '27', azimuth: '64', past_days: '31', forecast_days: '3' });
    const later = Date.now() + 2 * 3600e3;
    expect(await wxGti(later)).toEqual(w);                                    // "returned no hours": the cache
    expect(await wxGti(later)).toEqual(w);                                    // HTTP 500: the cache
    expect(calls).toHaveLength(3);
    await kv.set(WX_KEY, null as any);
    expect(await wxGti(later)).toBeNull();                                    // nothing cached and the call fails
  });

  it('PP-O5 archive highs and lows (wx:hilo): only days with both, the archive\'s null tail left out; none at all keeps the cache', async () => {
    const today = localDay(), days = daysFrom(addDays(today, -370), 369);
    fake({ [OMA]: (_u, _i, n) => json(n === 0 ? openMeteoArchive(days, { gaps: 4 }) : openMeteoArchive(days, { min: false })) });
    const t = await wxHiLo();
    expect(Object.keys(t)).toHaveLength(365);
    expect(t[days[0]]).toEqual({ high: 85, low: 70 });
    expect(t[days.at(-1)!]).toBeUndefined();
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('end_date')).toBe(addDays(today, -1));
    expect(u.searchParams.get('daily')).toBe('temperature_2m_max,temperature_2m_min');
    await kv.set(HILO_KEY, { ...(await kv.get<any>(HILO_KEY)), day: addDays(today, -1) });   // yesterday's pull: refetch today
    expect(Object.keys(await wxHiLo())).toHaveLength(365);                    // no lows in the reply → "no days" → the last cache
  });

  it('PP-O6 soiling weather: the archive\'s rain replaces the forecast service\'s for past days; a failed archive keeps the forecast\'s', async () => {
    const today = localDay(), days = daysFrom(addDays(today, -2), 4);
    const forecast = { latitude: 12.375, longitude: -56.75, hourly: { time: [`${days[0]}T12:00`], global_tilted_irradiance: [700], cloud_cover: [10] },
      daily: { time: days, precipitation_sum: [5, 6, 7, 8], temperature_2m_max: [90, 90, 90, 90] } };
    fake({ [OM]: () => json(forecast), [OMA]: (_u, _i, n) => n === 0 ? json({ daily: { time: days.slice(0, 2), precipitation_sum: [0.5, null] } }) : html(503) });
    const w = await soilWx(Date.now(), true);
    expect(w!.daily.precipitation_sum).toEqual([0.5, 6, 7, 8]);               // a null archive day keeps the forecast's figure
    expect((w as any).rainFrom).toEqual(['archive', 'forecast', 'forecast', 'forecast']);
    await kv.set('soiling:wx', null as any);
    expect((await soilWx(Date.now(), true))!.daily.precipitation_sum).toEqual([5, 6, 7, 8]);
  });
});

/* ======================= NWS ======================= */
const NWS = 'https://api.weather.gov/alerts/active';
describe('NWS alerts', () => {
  it('PP-W1 GeoJSON features → event, headline, severity, ends (expires when ends is null); asked for as geo+json with a User-Agent', async () => {
    fake({ [NWS]: () => json(nwsPayload([{ event: 'Severe Thunderstorm Warning' }, { event: 'Heat Advisory', ends: null, expires: '2026-06-01T19:00:00-05:00', headline: null, severity: 'Moderate' }])) });
    expect(await nwsAlerts()).toEqual([
      { event: 'Severe Thunderstorm Warning', headline: 'Severe Thunderstorm Warning issued June 1 at 3:00PM CDT by NWS Test Office', severity: 'Severe', ends: '2026-06-01T21:00:00-05:00' },
      { event: 'Heat Advisory', headline: null, severity: 'Moderate', ends: '2026-06-01T19:00:00-05:00' }]);
    expect(calls[0].url).toBe(`${NWS}?point=12.34,-56.78`);
    expect(calls[0].init?.headers).toMatchObject({ 'User-Agent': expect.stringContaining('Solstice'), Accept: 'application/geo+json' });
    expect((await kv.get<any>('nws')).alerts).toHaveLength(2);
  });

  it('PP-W2 no alerts is [], cached; a problem+json or non-JSON reply keeps the last alerts (or none)', async () => {
    fake({ [NWS]: (_u, _i, n) => n === 0 ? json(nwsPayload([])) : n === 1 ? json(nwsProblem(400, 'Invalid Point'), 400) : new Response('<html>busy</html>', { status: 200 }) });
    expect(await nwsAlerts()).toEqual([]);
    const old = [{ event: 'Flood Watch', headline: null, severity: 'Moderate', ends: null }];
    await kv.set('nws', { at: Date.now() - 10 * 60_000, alerts: old });
    expect(await nwsAlerts()).toEqual(old);
    expect(await nwsAlerts()).toEqual(old);
    await kv.set('nws', null as any);
    expect(await nwsAlerts()).toEqual([]);
  });

  it('PP-W3 a feature without properties does not hide the other alerts', async () => {
    const p = nwsPayload([{ event: 'Tornado Warning' }]) as any; p.features.unshift({ id: 'x', type: 'Feature', geometry: null });
    fake({ [NWS]: () => json(p) });
    expect((await nwsAlerts()).map(a => a.event)).toEqual(['Alert', 'Tornado Warning']);
  });

  it('PP-W4 no site location: no call, no alerts', async () => {
    delete process.env.SITE_LAT;
    fake({});
    expect(await nwsAlerts()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

/* ======================= ERCOT ======================= */
const ERCOT = 'https://www.ercot.com/api/1/services/read/dashboards/';
describe('ERCOT dashboards', () => {
  it('PP-E1 condition from daily-prc; demand and capacity from the last supply-demand interval with demand (future ones are 0); cached 5 min', async () => {
    fake({ [`${ERCOT}daily-prc.json`]: () => json(ercotPrc({ state: 'watch', title: 'Conservation Appeal', note: 'Please conserve 3–8 PM.', eea: 0 })),
      [`${ERCOT}supply-demand.json`]: () => json(ercotSupplyDemand()) });
    const d = await ercotNow();
    expect(d).toEqual({ condition: 'watch', title: 'Conservation Appeal', note: 'Please conserve 3–8 PM.', eea: 0, demandMw: 71234, capacityMw: 81500, at: '2026-08-12 15:55:10-0500' });
    expect(await ercotNow()).toEqual(d);
    expect(calls).toHaveLength(2);
  });

  it('PP-E2 missing fields: no current_condition is normal-unknown (eea 0); no supply-demand rows leave demand unknown, not an error', async () => {
    fake({ [`${ERCOT}daily-prc.json`]: () => json(ercotPrc({ omitCondition: true })),
      [`${ERCOT}supply-demand.json`]: (_u, _i, n) => json(n === 0 ? ercotSupplyDemand({ rows: [{ demand: 0, capacity: 0 }] }) : ercotSupplyDemand({ omitData: true })) });
    expect(await ercotNow()).toEqual({ condition: null, title: null, note: null, eea: 0, demandMw: null, capacityMw: null, at: '2026-08-12 15:55:10-0500' });
    await kv.set('ercot', null as any);
    expect(await ercotNow()).toMatchObject({ demandMw: null, capacityMw: null, eea: 0 });
  });

  it('PP-E3 an HTTP error from either dashboard is an error naming it (the 5-minute watch catches it)', async () => {
    fake({ [`${ERCOT}daily-prc.json`]: () => html(503), [`${ERCOT}supply-demand.json`]: () => json(ercotSupplyDemand()) });
    await expect(ercotNow()).rejects.toThrow('ERCOT daily-prc: HTTP 503');
    expect(await kv.get('ercot') ?? null).toBeNull();
  });
});
