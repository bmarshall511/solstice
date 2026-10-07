// Powerwall commands and rules (server/src/tesla/commands.ts, server/src/powerwall.ts, the Powerwall guards in appliances/guards.ts;
// enhancements P1/P2, scope energy_cmds, every rule in Suggest by default).
//   PW-1 every clamp boundary: reserve 10–100, whole percent, ≥ 20 in a storm, one change an hour; export rule; operation mode
//   PW-2 the three rules, pure: reserve from the 48-hour model, storm raise and restore, export rule from the tariff
//   PW-3 the scope: config, authorize URL, GET /api/tesla/scopes from the stored scope and from the token's scp claim
//   PW-4 scope_missing: every command path answers it, nothing reaches Tesla, and it is logged
//   PW-5 with the scope: Apply sends the storm raise, the hourly slot refuses the restore, an hour later it goes through
//   PW-6 the guards on the command path refuse before sending; an unchanged value sends nothing
//   PW-7 Suggest never sends (an approval alert once a day instead), Off does nothing, Auto sends; the 5-minute cron end to end
//   PW-8 the rules routes: modes, validation, Apply only in Suggest, the export rule from a parsed bill, the digest counts
// In-process app on 127.0.0.1:0, PGlite in memory. The Fleet API is a fake inside the fetch guard (tests/setup.ts): it records
// every call, so "nothing was sent" is checked directly. Tokens, ids and bills are synthetic.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PEC_BILL } from '../fixtures/pec-bill.js';
import { guardReserve, guardExportRule, guardOperationMode, PW_CHANGE_INTERVAL_MS } from '../../server/src/appliances/guards.js';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => false),
}));

const KEY = 'test-owner-key-synthetic-powerwall-abcdefghi';   // test-only
const CRON = 'test-cron-secret-synthetic-powerwall';
const FLEET = 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/energy_sites/';
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let C: typeof import('../../server/src/tesla/commands.js');
let PW: typeof import('../../server/src/powerwall.js');

/* ---------- a fake Fleet API inside the fetch guard ---------- */
const tesla: Array<{ url: string; auth: string; body: any }> = [];
let teslaStatus = 200;
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.startsWith(FLEET)) {
    tesla.push({ url: u.slice(FLEET.length), auth: String((init?.headers as Record<string, string>)?.Authorization), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(teslaStatus === 200 ? { response: { code: 201, message: 'Updated' } } : { error: 'test failure' }), { status: teslaStatus });
  }
  return guard(input as any, init);
});

type Init = RequestInit & { cookie?: string; json?: unknown };
const call = (path: string, init: Init = {}) => {
  const { cookie = owner, json, ...rest } = init;
  return fetch(base + path, { ...rest, headers: { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers as Record<string, string> ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}) });
};
const jwt = (scp: string[]) => `x.${Buffer.from(JSON.stringify({ scp })).toString('base64url')}.y`;
const INFO = { nameplate_energy: 27000, nameplate_power: 10000, backup_reserve_percent: 20, default_real_mode: 'self_consumption',
  components: { customer_preferred_export_rule: 'battery_ok' }, user_settings: { storm_mode_enabled: true } };
const setScope = (scope: string | null, token = 'test-access') => db.q(`UPDATE tesla_accounts SET scope = $1, access_token = $2 WHERE id = 1`, [scope, token]);
const WITH = 'openid offline_access energy_device_data energy_cmds', WITHOUT = 'openid offline_access energy_device_data';
const storm = (alerts: Array<{ event: string; severity: string }>) => db.kv.set('nws', { at: Date.now(), alerts: alerts.map(a => ({ ...a, headline: a.event, ends: null })) });
const logRows = async () => (await db.q<{ rule: string | null; command: string; value: unknown; result: string; source: string }>(`SELECT rule, command, value, result, source FROM powerwall_log ORDER BY id`))
  .map(r => `${r.rule ?? '-'}:${r.command}:${JSON.stringify(r.value)}:${r.result}:${r.source}`);

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('powerwall tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, CRON_SECRET: CRON, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  C = await import('../../server/src/tesla/commands.js');
  PW = await import('../../server/src/powerwall.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at, scope) VALUES (1, NULL, 'test-access', 'test-refresh', $1, $2)`, [Date.now() + 864e5, WITHOUT]);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info) VALUES ('s', NULL, 1, 'Test home', $1)`, [JSON.stringify(INFO)]);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const r = await call('/api/auth/owner', { cookie: '', json: { key: KEY } });
  owner = (r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? '').split(';')[0];
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });
beforeEach(async () => {
  tesla.length = 0; teslaStatus = 200;
  await db.q(`UPDATE sites SET info = $1 WHERE id = 's'`, [JSON.stringify(INFO)]);
  await db.q('DELETE FROM powerwall_log'); await db.q('DELETE FROM alerts'); await db.q('DELETE FROM readings'); await db.q('DELETE FROM bills');
  await db.q(`DELETE FROM kv WHERE key LIKE 's:pw:%'`);
  await db.kv.set('settings:owner', {}); await storm([]); await setScope(WITHOUT);
});

describe('guards', () => {
  it('PW-1 every clamp boundary', () => {
    const now = Date.parse('2026-09-27T15:00:00Z'), R = (pct: number, storm = false, last: number | null = null) => guardReserve({ pct, storm, lastChangeAt: last, now });
    expect(R(9)).toMatchObject({ ok: false, reason: '9% is outside the 10–100% reserve range' });
    expect(R(10)).toMatchObject({ ok: true, value: 10 });
    expect(R(100)).toMatchObject({ ok: true, value: 100 });
    expect(R(101)).toMatchObject({ ok: false, reason: '101% is outside the 10–100% reserve range' });
    expect(R(20.5)).toMatchObject({ ok: false, reason: '20.5% is not a whole-number reserve' });
    expect(R(NaN).ok).toBe(false);
    expect(R(19, true)).toMatchObject({ ok: false, reason: 'never below 20% while a storm alert or Storm Watch is active' });
    expect(R(20, true)).toMatchObject({ ok: true, value: 20 });
    expect(R(19, false)).toMatchObject({ ok: true });
    expect(R(50, false, now - PW_CHANGE_INTERVAL_MS + 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/^one reserve change per hour; the last was at /) });
    expect(R(50, false, now - PW_CHANGE_INTERVAL_MS)).toMatchObject({ ok: true });
    const E = (rule: string, last: number | null = null) => guardExportRule({ rule, lastChangeAt: last, now });
    expect(E('pv_only')).toMatchObject({ ok: true, value: 'pv_only' });
    expect(E('battery_ok')).toMatchObject({ ok: true, value: 'battery_ok' });
    expect(E('never')).toMatchObject({ ok: false, reason: 'the export rule "never" is not battery_ok or pv_only' });
    expect(E('<b>x</b>').reason).not.toMatch(/[<>]/);
    expect(E('pv_only', now - 60_000)).toMatchObject({ ok: false });
    const M = (mode: string, last: number | null = null) => guardOperationMode({ mode, lastChangeAt: last, now });
    expect(M('self_consumption')).toMatchObject({ ok: true });
    expect(M('autonomous')).toMatchObject({ ok: true });
    expect(M('backup')).toMatchObject({ ok: false, reason: 'the operation mode "backup" is not self_consumption or autonomous' });
    expect(M('autonomous', now - 59 * 60_000)).toMatchObject({ ok: false });
  });
});

describe('the rules, pure', () => {
  it('PW-2 reserve from the 48-hour model, storm raise and restore, export rule from the tariff', () => {
    // 18 hours from 17:00: the battery drains to the 30 % reserve at 22:00 and the house buys 1 kWh an hour for 6 hours
    const pts = Array.from({ length: 19 }, (_, k) => ({ k, t: `2026-09-27T${String((17 + k) % 24).padStart(2, '0')}:00`, s: 0, h: 2, soc: k < 6 ? .8 - k * .1 : .3, g: k >= 6 && k < 12 ? 1 : 0 }));
    const R = (o: Partial<Parameters<typeof PW.reserveAdvice>[0]>) => PW.reserveAdvice({ current: 30, floor: 20, capKwh: 27, points: pts, stormHold: false, ...o });
    expect(R({})).toEqual({ action: 'set', value: 20, current: 30, reason: 'Tonight the Powerwalls reach the 30% reserve around 22:00 and the house would buy about 6 kWh from PEC before the sun is back; 20% lets them carry it and still keeps 5.4 kWh for an outage.' });
    expect(R({ current: 20 })).toMatchObject({ action: 'none', reason: 'Tonight\'s low is about 30%, above the 20% reserve: no change needed.' });
    expect(R({ floor: 30 })).toMatchObject({ action: 'none', reason: 'The Powerwalls reach the 30% reserve tonight, which is already your floor.' });
    expect(R({ floor: 25 })).toMatchObject({ action: 'set', value: 25 });                                          // never below the floor
    expect(R({ current: 15 })).toMatchObject({ action: 'set', value: 20, reason: expect.stringMatching(/below your 20% floor/) });
    expect(R({ stormHold: true })).toMatchObject({ action: 'none', reason: expect.stringMatching(/storm rule/) });
    expect(R({ points: null })).toMatchObject({ action: 'wait' });
    expect(R({ current: null })).toMatchObject({ action: 'wait' });
    const small = pts.map(p => ({ ...p, g: p.g ? .05 : 0 }));
    expect(R({ points: small })).toMatchObject({ action: 'none', reason: 'Tonight\'s low is about 30%, above the 30% reserve: no change needed.' });

    const S = (o: Partial<Parameters<typeof PW.stormAdvice>[0]['storm']>, current: number | null = 20, revert: any = null) =>
      PW.stormAdvice({ current, storm: { alerts: [], warning: false, watch: false, stormWatchActive: false, ...o }, revert });
    expect(S({ alerts: [{ event: 'Tornado Warning', severity: 'Extreme', headline: null, ends: null }], warning: true })).toMatchObject({ action: 'set', value: 100, revert: 'store', reason: expect.stringMatching(/^Tornado Warning for your area: raise the reserve to 100%/) });
    expect(S({ alerts: [{ event: 'Winter Storm Watch', severity: 'Moderate', headline: null, ends: null }], watch: true })).toMatchObject({ action: 'set', value: 50 });
    expect(S({ stormWatchActive: true })).toMatchObject({ action: 'set', value: 100, reason: expect.stringMatching(/^Storm Watch is active/) });
    expect(S({ warning: true, alerts: [{ event: 'Tornado Warning', severity: 'Extreme', headline: null, ends: null }] }, 100)).toMatchObject({ action: 'none' });
    expect(S({}, 100, { prev: 20, to: 100, at: 1 })).toEqual({ action: 'set', value: 20, current: 100, revert: 'clear', reason: 'The storm has passed: back to your 20% reserve.' });
    expect(S({}, 60, { prev: 20, to: 100, at: 1 })).toMatchObject({ action: 'none' });   // the owner changed it since: leave it
    expect(S({})).toMatchObject({ action: 'none' });

    const X = (current: string | null, t: any) => PW.exportAdvice({ current, tariff: t });
    expect(X('battery_ok', { importRateAllIn: .1, exportCredit: .07 })).toEqual({ action: 'set', value: 'pv_only', current: 'battery_ok',
      reason: 'PEC credits an exported kWh at 70% of what an imported one costs, so energy in the Powerwalls is worth more used at home: export solar only.' });
    expect(X('pv_only', { importRateAllIn: .1, exportCredit: .07 })).toMatchObject({ action: 'none' });
    expect(X('pv_only', { importRateAllIn: .1, exportCredit: .12 })).toMatchObject({ action: 'set', value: 'battery_ok' });
    expect(X('pv_only', { importRateAllIn: .1, exportCredit: .105 })).toMatchObject({ action: 'none' });            // 1.05 × 0.9 < 1: not worth it
    expect(X('pv_only', null)).toMatchObject({ action: 'wait' });
    expect(X('pv_only', { importRateAllIn: .1, exportCredit: null })).toMatchObject({ action: 'wait' });
    expect(PW.ruleModes({})).toEqual({ reserve: 'suggest', storm: 'suggest', export: 'suggest' });
    expect(PW.ruleModes({ powerwall: { rules: { storm: 'auto', export: 'off', reserve: 'yolo' } } })).toEqual({ reserve: 'suggest', storm: 'auto', export: 'off' });
    expect(PW.reserveFloor({ powerwall: { reserveFloorPct: 5 } })).toBe(10);
  });
});

describe('the energy_cmds scope', () => {
  it('PW-3 requested at login, reported from the stored scope or the token', async () => {
    const { config } = await import('../../server/src/config.js');
    expect(config.scopes.split(' ')).toEqual(['openid', 'offline_access', 'energy_device_data', 'energy_cmds']);
    Object.assign(process.env, { TESLA_CLIENT_ID: 'test-client', TESLA_REDIRECT_URI: 'http://127.0.0.1/cb' });
    const { authorizeUrl } = await import('../../server/src/tesla/auth.js');
    const u = new URL(authorizeUrl('st'));
    delete process.env.TESLA_CLIENT_ID; delete process.env.TESLA_REDIRECT_URI;
    expect(u.searchParams.get('scope')).toBe('openid offline_access energy_device_data energy_cmds');
    expect(u.searchParams.get('prompt_missing_scopes')).toBe('true');
    expect(await (await call('/api/tesla/scopes')).json()).toEqual({ connected: true, scopes: WITHOUT.split(' '), energyCmds: false, source: 'stored', relink: '/auth/login' });
    await setScope(WITH);
    expect(await (await call('/api/tesla/scopes')).json()).toMatchObject({ energyCmds: true, source: 'stored', relink: null });
    await setScope(WITH, jwt(['openid', 'energy_device_data']));                       // the token itself wins: it lacks the scope
    expect(await (await call('/api/tesla/scopes')).json()).toMatchObject({ energyCmds: false, source: 'token' });
    await setScope(null, jwt(['energy_device_data', 'energy_cmds']));
    expect(await (await call('/api/tesla/scopes')).json()).toMatchObject({ energyCmds: true, source: 'token' });
    expect(C.tokenScopes('not-a-jwt')).toBeNull();
    expect((await call('/api/tesla/scopes', { cookie: '' })).status).toBe(401);
  });

  it('PW-4 without the scope every command path answers scope_missing, sends nothing and logs it', async () => {
    await storm([{ event: 'Tornado Warning', severity: 'Extreme' }]);
    const r = await call('/api/powerwall/rules/storm/apply', { method: 'POST' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, result: 'scope_missing', command: 'backup', value: 100, reason: expect.stringMatching(/energy_cmds.*\/auth\/login.*nothing was sent/) });
    for (const res of [await C.setBackupReserve('s', 30, { source: 'owner' }), await C.setGridExportRule('s', 'pv_only', { source: 'owner' }), await C.setOperationMode('s', 'autonomous', { source: 'owner' })])
      expect(res).toMatchObject({ ok: false, result: 'scope_missing' });
    await db.q(`UPDATE tesla_accounts SET scope = $1 WHERE id = 1`, [WITHOUT]);
    expect((await PW.evaluatePowerwall('s', { powerwall: { rules: { storm: 'auto' } } }, ['storm'])).storm).toMatchObject({ mode: 'auto', result: 'scope_missing' });
    expect(tesla).toEqual([]);
    expect(await logRows()).toEqual(['storm:backup:100:scope_missing:owner', '-:backup:30:scope_missing:owner', '-:grid_import_export:"pv_only":scope_missing:owner',
      '-:operation:"autonomous":scope_missing:owner', 'storm:backup:100:scope_missing:auto']);
    expect((await db.one<{ info: any }>(`SELECT info FROM sites WHERE id = 's'`))!.info.backup_reserve_percent).toBe(20);
  });
});

describe('sending', () => {
  it('PW-5 Apply sends the storm raise; the restore waits for the hourly slot, then goes through', async () => {
    await setScope(WITH);
    await storm([{ event: 'Tornado Warning', severity: 'Extreme' }]);
    const r = await call('/api/powerwall/rules/storm/apply', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, result: 'sent', command: 'backup', value: 100, suggestion: { action: 'set', value: 100, current: 20 } });
    expect(tesla).toEqual([{ url: 's/backup', auth: 'Bearer test-access', body: { backup_reserve_percent: 100 } }]);
    expect((await db.one<{ info: any }>(`SELECT info FROM sites WHERE id = 's'`))!.info.backup_reserve_percent).toBe(100);
    expect(await db.kv.get('s:pw:stormRevert')).toMatchObject({ prev: 20, to: 100 });
    // the storm passes: restoring 20 % is suggested, but the hourly slot refuses it
    await storm([]);
    const rules = await (await call('/api/powerwall/rules')).json();
    expect(rules.rules.find((x: any) => x.id === 'storm').suggestion).toMatchObject({ action: 'set', value: 20, reason: 'The storm has passed: back to your 20% reserve.' });
    expect(rules.rules.find((x: any) => x.id === 'reserve').suggestion).toMatchObject({ action: 'none', reason: expect.stringMatching(/storm rule/) });
    const again = await call('/api/powerwall/rules/storm/apply', { method: 'POST' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ result: 'refused', reason: expect.stringMatching(/^one reserve change per hour/) });
    expect(tesla).toHaveLength(1);
    await db.kv.set('s:pw:last:backup', { at: Date.now() - PW_CHANGE_INTERVAL_MS - 1000 });
    expect(await (await call('/api/powerwall/rules/storm/apply', { method: 'POST' })).json()).toMatchObject({ ok: true, result: 'sent', value: 20 });
    expect(tesla.at(-1)).toMatchObject({ body: { backup_reserve_percent: 20 } });
    expect(await db.kv.get('s:pw:stormRevert')).toBeNull();
    expect(await logRows()).toEqual(['storm:backup:100:sent:owner', 'storm:backup:20:refused:owner', 'storm:backup:20:sent:owner']);
    // Tesla failing is reported, logged, and leaves site info alone
    teslaStatus = 500; await db.kv.set('s:pw:last:backup', null);
    expect(await C.setBackupReserve('s', 40, { source: 'owner' })).toMatchObject({ ok: false, result: 'error', reason: 'Tesla answered HTTP 500: test failure' });
    expect((await db.one<{ info: any }>(`SELECT info FROM sites WHERE id = 's'`))!.info.backup_reserve_percent).toBe(20);
  });

  it('PW-6 the guards refuse on the command path before anything is sent; an unchanged value sends nothing', async () => {
    await setScope(WITH);
    expect(await C.setBackupReserve('s', 9, { source: 'owner' })).toMatchObject({ result: 'refused', reason: '9% is outside the 10–100% reserve range' });
    expect(await C.setBackupReserve('s', 101, { source: 'owner' })).toMatchObject({ result: 'refused' });
    expect(await C.setBackupReserve('s', 20, { source: 'owner' })).toMatchObject({ result: 'unchanged', reason: 'already 20' });
    await storm([{ event: 'Severe Thunderstorm Warning', severity: 'Severe' }]);
    expect(await C.setBackupReserve('s', 15, { source: 'owner' })).toMatchObject({ result: 'refused', reason: 'never below 20% while a storm alert or Storm Watch is active' });
    await storm([]);
    await db.q(`INSERT INTO readings (site_id, ts, soc, grid_status, island_status, storm_mode_active) VALUES ('s', $1, 70, 'Active', 'on_grid', true)`, [Date.now()]);
    expect(await C.setBackupReserve('s', 15, { source: 'owner' })).toMatchObject({ result: 'refused', reason: expect.stringMatching(/Storm Watch/) });   // Storm Watch alone counts
    await db.q('DELETE FROM readings');
    expect(await C.setGridExportRule('s', 'never', { source: 'owner' })).toMatchObject({ result: 'refused', reason: 'the export rule "never" is not battery_ok or pv_only' });
    expect(await C.setOperationMode('s', 'backup', { source: 'owner' })).toMatchObject({ result: 'refused' });
    expect(tesla).toEqual([]);
    expect(await C.setBackupReserve('s', 15, { source: 'owner' })).toMatchObject({ result: 'sent' });
    expect(await C.setBackupReserve('s', 25, { source: 'owner' })).toMatchObject({ result: 'refused', reason: expect.stringMatching(/one reserve change per hour/) });
    expect(await C.setGridExportRule('s', 'pv_only', { source: 'owner' })).toMatchObject({ result: 'sent' });   // each setting has its own hour
    expect(tesla.map(t => t.url)).toEqual(['s/backup', 's/grid_import_export']);
    expect(tesla[1].body).toEqual({ customer_preferred_export_rule: 'pv_only' });
    expect((await db.one<{ info: any }>(`SELECT info FROM sites WHERE id = 's'`))!.info.components.customer_preferred_export_rule).toBe('pv_only');
  });

  it('PW-7 Suggest never sends (one approval alert a day), Off does nothing, Auto sends; the 5-minute cron end to end', async () => {
    await setScope(WITH);
    await storm([{ event: 'Tornado Warning', severity: 'Extreme' }]);
    expect(await PW.evaluatePowerwall('s', {}, ['storm'])).toEqual({ storm: { mode: 'suggest', action: 'set', value: 100, notified: true } });
    expect(await PW.evaluatePowerwall('s', {}, ['storm'])).toEqual({ storm: { mode: 'suggest', action: 'set', value: 100, notified: false } });
    expect(tesla).toEqual([]);
    expect(await db.q(`SELECT kind, title, data FROM alerts`)).toEqual([{ kind: 'approval', title: 'Reserve before a storm: 100%?', data: expect.objectContaining({ rule: 'storm', value: 100, current: 20 }) }]);
    expect(await logRows()).toEqual(['storm:backup:100:suggested:auto']);
    expect(await db.kv.get('s:pw:suggest:storm')).toMatchObject({ action: 'set', value: 100 });
    expect(await PW.evaluatePowerwall('s', { powerwall: { rules: { storm: 'off' } } }, ['storm'])).toEqual({ storm: { mode: 'off' } });
    // the cron: Suggest by default, so a storm tick sends nothing
    await db.kv.set('ercot', { at: Date.now(), data: { condition: 'normal', title: 'Normal', note: null, eea: 0, demandMw: 1, capacityMw: 2, at: 'x' } });
    const tick = await (await call('/api/cron/nest', { cookie: '', headers: { authorization: `Bearer ${CRON}` } })).json();
    expect(tick.watch.s.powerwall).toMatchObject({ storm: { mode: 'suggest', action: 'set', value: 100 } });
    expect(tesla).toEqual([]);
    // Auto: the cron sends it
    await db.kv.set('settings:owner', { powerwall: { rules: { storm: 'auto' } } });
    const auto = await (await call('/api/cron/nest', { cookie: '', headers: { authorization: `Bearer ${CRON}` } })).json();
    expect(auto.watch.s.powerwall.storm).toEqual({ mode: 'auto', action: 'set', value: 100, result: 'sent', reason: null });
    expect(tesla).toEqual([{ url: 's/backup', auth: 'Bearer test-access', body: { backup_reserve_percent: 100 } }]);
    expect((await logRows()).at(-1)).toBe('storm:backup:100:sent:auto');
  });

  it('PW-8 the rules routes: modes, validation, Apply only in Suggest, the export rule from a bill, the digest counts', async () => {
    expect(await (await call('/api/powerwall/rules/storm', { json: { mode: 'auto' } })).json()).toEqual({ ok: true, id: 'storm', mode: 'auto' });
    expect((await db.kv.get<any>('settings:owner')).powerwall.rules).toEqual({ storm: 'auto' });
    expect((await call('/api/powerwall/rules/storm', { json: { mode: 'yes' } })).status).toBe(400);
    expect((await call('/api/powerwall/rules/nope', { json: { mode: 'off' } })).status).toBe(404);
    expect((await call('/api/powerwall/rules/nope/apply', { method: 'POST' })).status).toBe(404);
    const auto = await call('/api/powerwall/rules/storm/apply', { method: 'POST' });
    expect(auto.status).toBe(409);
    expect(await auto.json()).toMatchObject({ mode: 'auto', error: expect.stringMatching(/Suggest mode/) });
    expect((await call('/api/powerwall/rules/storm', { cookie: '', json: { mode: 'off' } })).status).toBe(401);
    // the export rule, from the fixture bill's published tariff: credit below the import rate → pv_only
    const { saveBill, parsePecText } = await import('../../server/src/bills.js');
    await saveBill('s', parsePecText(PEC_BILL));
    const list = await (await call('/api/powerwall/rules')).json();
    expect(list).toMatchObject({ scope: { energyCmds: false, relink: '/auth/login' }, floorPct: 20 });
    expect(list.rules.map((r: any) => [r.id, r.mode, r.suggestion.action])).toEqual([['reserve', 'suggest', 'wait'], ['storm', 'auto', 'none'], ['export', 'suggest', 'set']]);
    expect(list.rules[2].suggestion).toMatchObject({ value: 'pv_only', current: 'battery_ok', reason: expect.stringMatching(/export solar only/) });
    expect(JSON.stringify(list)).not.toMatch(/\$\s?\d/);
    await setScope(WITH);
    expect(await (await call('/api/powerwall/rules/export/apply', { method: 'POST' })).json()).toMatchObject({ ok: true, result: 'sent', value: 'pv_only' });
    // the weekly digest counts the week's Powerwall outcomes
    const { buildDigest, mondayOf } = await import('../../server/src/digest.js');
    const { localDay } = await import('../../server/src/tesla/client.js');
    expect((await buildDigest('s', mondayOf(localDay()))).autopilot.powerwall).toEqual({ sent: 1, refused: 0, suggested: 0, scopeMissing: 0 });
  });
});

describe('storm reserve: escalation, the automatic way back, heat (docs/audit-2026-10.md Q10)', () => {
  const pass = () => db.kv.set('s:pw:last:backup', { at: Date.now() - PW_CHANGE_INTERVAL_MS - 1000 });   // past the hourly slot
  it('PW-9 a Watch that becomes a Warning still goes back to the reserve from before the storm (20%, not 50%)', async () => {
    await setScope(WITH);
    await storm([{ event: 'Flood Watch', severity: 'Severe' }]);
    expect(await (await call('/api/powerwall/rules/storm/apply', { method: 'POST' })).json()).toMatchObject({ result: 'sent', value: 50 });
    expect(await db.kv.get('s:pw:stormRevert')).toMatchObject({ prev: 20, to: 50 });
    await pass(); await storm([{ event: 'Tornado Warning', severity: 'Extreme' }]);
    expect(await (await call('/api/powerwall/rules/storm/apply', { method: 'POST' })).json()).toMatchObject({ result: 'sent', value: 100 });
    expect(await db.kv.get('s:pw:stormRevert')).toMatchObject({ prev: 20, to: 100 });
  });
  it('PW-10 in Suggest, a raise that was applied comes back down by itself when the storm passes, with a push', async () => {
    await setScope(WITH);
    await storm([{ event: 'Flood Watch', severity: 'Severe' }]);
    await call('/api/powerwall/rules/storm/apply', { method: 'POST' });
    await pass(); await storm([]);
    expect(await PW.evaluatePowerwall('s', {}, ['storm'])).toMatchObject({ storm: { mode: 'suggest', action: 'set', value: 20, result: 'sent', autoRevert: true } });
    expect(tesla.at(-1)).toMatchObject({ body: { backup_reserve_percent: 20 } });
    expect(await db.kv.get('s:pw:stormRevert')).toBeNull();
    expect(await db.q(`SELECT kind, title FROM alerts WHERE kind = 'storm'`)).toEqual([{ kind: 'storm', title: 'Reserve back to 20%' }]);
    // with no stored revert (nothing was raised by Solstice), a passing storm sends nothing
    tesla.length = 0;
    expect(await PW.evaluatePowerwall('s', {}, ['storm'])).toMatchObject({ storm: { mode: 'suggest', action: 'none' } });
    expect(tesla).toEqual([]);
  });
  it('PW-11 heat, fire-weather and air-quality warnings never raise the reserve; a severe freeze still does', async () => {
    const W = await import('../../server/src/watch.js');
    expect(W.isStormAlert({ event: 'Extreme Heat Warning', severity: 'Extreme' })).toBe(false);
    expect(W.isStormAlert({ event: 'Red Flag Warning', severity: 'Severe' })).toBe(false);
    expect(W.isStormAlert({ event: 'Air Quality Alert', severity: 'Severe' })).toBe(false);
    expect(W.isStormAlert({ event: 'Flood Watch', severity: 'Severe' })).toBe(true);
    expect(W.isStormAlert({ event: 'Freeze Warning', severity: 'Severe' })).toBe(true);
    await setScope(WITH);
    await storm([{ event: 'Extreme Heat Warning', severity: 'Extreme' }]);
    expect(await PW.evaluatePowerwall('s', {}, ['storm'])).toMatchObject({ storm: { action: 'none' } });
  });
});

describe('Vacation mode (mockup ak)', () => {
  it('PW-12 during a trip the storm rule raises without a tap (with a push) and still reverts by itself; the reserve rule rests', async () => {
    await setScope(WITH); await db.q('DELETE FROM trips');
    await db.q(`INSERT INTO trips (site_id, leave_at, back_at, state, started_at) VALUES ('s', $1, $2, 'active', $1)`, [Date.now() - 3600e3, Date.now() + 3 * 864e5]);
    try {
      await storm([{ event: 'Tornado Warning', severity: 'Extreme' }]);
      expect(await PW.evaluatePowerwall('s', {}, ['storm', 'reserve'])).toMatchObject({ storm: { mode: 'suggest', action: 'set', value: 100, result: 'sent', trip: true }, reserve: { mode: 'suggest', skipped: 'vacation' } });
      expect(tesla.at(-1)).toMatchObject({ body: { backup_reserve_percent: 100 } });
      expect(await db.q(`SELECT kind, title, body FROM alerts WHERE kind = 'storm'`)).toEqual([{ kind: 'storm', title: 'Storm warning · reserve raised to 100%', body: 'Your trip rule raised it without waiting. It goes back to 20% when the warning ends.' }]);
      expect(await (await call('/api/powerwall/rules')).json()).toMatchObject({ trip: { backAt: expect.any(Number) } });
      await db.kv.set('s:pw:last:backup', { at: Date.now() - PW_CHANGE_INTERVAL_MS - 1000 }); await storm([]);
      expect(await PW.evaluatePowerwall('s', {}, ['storm'])).toMatchObject({ storm: { action: 'set', value: 20, autoRevert: true } });
    } finally { await db.q('DELETE FROM trips'); }
  });
});

describe('the nightly watchdog (5-minute cron)', () => {
  it('WD-1 quiet while the nightly run is recent; one alert a day once it is more than 26 hours old', async () => {
    await db.kv.set('ercot', { at: Date.now(), data: { condition: 'normal', title: 'Normal', note: null, eea: 0, demandMw: 1, capacityMw: 2, at: 'x' } });
    const tick = async () => (await (await call('/api/cron/nest', { cookie: '', headers: { authorization: `Bearer ${CRON}` } })).json()).watch.s.watchdog;
    await db.kv.set('cron:sync:done', Date.now() - 20 * 3600e3);
    expect(await tick()).toMatchObject({ ok: true });
    await db.kv.set('cron:sync:done', Date.now() - 27 * 3600e3);
    expect(await tick()).toMatchObject({ stored: true });
    expect(await tick()).toMatchObject({ stored: false });                // once a day
    expect(await db.q(`SELECT kind, title FROM alerts WHERE kind = 'anomaly'`)).toEqual([{ kind: 'anomaly', title: 'The nightly update didn’t run' }]);
    expect((await call('/api/cron/nest', { cookie: '', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });
});

describe('the nightly cron\'s tail (code review C-06)', () => {
  it('NW-1 with the deadline passed every nightly step is skipped and said so, and nightlyWatch still returns', async () => {
    const W = await import('../../server/src/watch.js'), probe = vi.fn(async () => ({ ran: true }));
    W.nightlySteps.zzProbe = probe;
    try {
      const out = await W.nightlyWatch('s', Date.now(), { deadline: Date.now() + 4_000 });   // under the 5 s a step needs
      expect(Object.keys(out).sort()).toEqual(Object.keys(W.nightlySteps).sort());
      for (const v of Object.values(out)) expect(v).toEqual({ skipped: 'out of time' });
      expect(probe).not.toHaveBeenCalled();
      expect((await W.nightlyWatch('s', Date.now(), { deadline: Date.now() + 30_000 })).zzProbe).toEqual({ ran: true });   // with time, it runs
    } finally { delete W.nightlySteps.zzProbe; }
  });
  it('NW-2 the done marker is written once the sync and learning finish, before the tail, so a failing tail leaves it set', async () => {
    const W = await import('../../server/src/watch.js');
    await db.kv.set('cron:sync:done', 1);
    let seen: number | undefined;
    W.nightlySteps.zzProbe = async () => { seen = await db.kv.get<number>('cron:sync:done'); throw new Error('tail failed'); };
    try {
      const t0 = Date.now(), r = await call('/api/cron/sync', { cookie: '', headers: { authorization: `Bearer ${CRON}` } });
      expect(r.status).toBe(200);
      expect((await r.json())['watch:s'].zzProbe).toEqual({ error: 'tail failed' });
      expect(seen).toBeGreaterThanOrEqual(t0);                              // already written when the tail ran
      expect(await db.kv.get<number>('cron:sync:done')).toBe(seen);         // and not written again after it
    } finally { delete W.nightlySteps.zzProbe; }
  });
});
