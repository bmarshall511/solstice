// Per-panel data from the SunPower PVS6 (docs/audit-designs/enhancements.md V1): scripts/pvs-relay.mjs, the
// POST /api/pvs/readings ingest and the GET /api/pvs/day and /latest roll-ups.
//
// Nothing here reaches a real device or the internet. The "PVS" is an https server on 127.0.0.1 with a throwaway
// self-signed certificate made at run time (tests/fixtures/pvs.ts); "Solstice" is the real in-process app on in-memory
// PGlite, registered with the fetch guard in tests/setup.ts, plus two tiny mock APIs for failure cases. The CLI tests run
// the relay as a child process against the same local servers. Serials, keys and passwords are synthetic.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import https, { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pvsVars, PVS_EXPECTED, PVS_BAD_REQUEST, selfSignedCert } from '../fixtures/pvs.js';

vi.unmock('../../server/src/db.js');   // these tests need the real database module on PGlite

type Reading = { sn: string; kw: number | null; kwDc: number | null; v: number | null; tempC: number | null; kwhLifetime: number | null };
type Cfg = Record<string, any>;
type State = { pvsCookie: string | null; pvsLoginAt?: number | null; apiCookie: string | null; fingerprintShown: boolean; log: (m: string) => void };
type Relay = {
  FatalError: new (m: string) => Error; VARS_PATH: string;
  parseEnv(text: string): Record<string, string>; insideRepo(path: string): boolean;
  loadConfig(env: Record<string, string | undefined>, o?: { dryRun?: boolean }): Cfg;
  readEnvFile(path: string): Record<string, string>;
  pvsGet(cfg: Cfg, path: string, headers?: Record<string, string>, state?: State): Promise<{ status: number; body: string }>;
  parseInverters(json: unknown): { inverters: Reading[]; skipped: number; ts: string | null };
  readInverters(cfg: Cfg, state: State, o?: { now?: () => number }): Promise<{ ts: string | null; inverters: Reading[] }>;
  SESSION_MAX_MS: number; UPTIME_PATH: string;
  apiLogin(cfg: Cfg, state: State): Promise<string>;
  postReadings(cfg: Cfg, state: State, payload: unknown): Promise<{ ok: true; inserted: number; duplicates: number }>;
  pollOnce(cfg: Cfg, state: State, o?: { dryRun?: boolean; now?: () => number }): Promise<{ payload: { ts: string; inverters: Reading[] }; posted: any }>;
};

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const RELAY_PATH = fileURLToPath(new URL('../../scripts/pvs-relay.mjs', import.meta.url));
const PW = 'T3ST5';                                    // "last 5 of the PVS serial", synthetic
const TLS = selfSignedCert('pvs.local');

let relay: Relay, db: typeof import('../../server/src/db.js'), pvsMod: typeof import('../../server/src/pvs.js');
let app: Server, base = '', ownerCookie = '', tmp = '';
/** The route tests' own owner session id (the cookie is `solstice_owner=<id>.<mac>`); the relay tests revoke every other one. */
const routeSession = () => ownerCookie.slice(ownerCookie.indexOf('=') + 1, ownerCookie.lastIndexOf('.'));
const revokeRelaySessions = () => db.q('DELETE FROM owner_sessions WHERE id <> $1', [routeSession()]);
const ports: Set<number> = (globalThis as any).__testServerPorts;

/* ---------------- the mocked PVS6, answering as the real one did ----------------
 *  GET /auth?login (Basic ssm_owner:<PW>) → 200 {"session": "<64 chars>"} with NO Set-Cookie; the client sends Cookie: session=<value>.
 *  GET /vars?match=inverter&fmt=obj&cache=1 → the flat object; the old match=inverter/data query, or one without cache=1, → 400.
 *  A request without the current session → 400 0x0040 (what the real PVS6 answers to a request without a session; set
 *  pvs.expired = 401 for a firmware that says so). varsStatus = 400 is the PVS after a night-time restart: a good session, but
 *  0x0040 to the inverter query because it lists no inverters yet. GET /vars?match=/sys/info/uptime&fmt=obj → its uptime. */
type Hit = { method: string; url: string; auth?: string; cookie?: string };
const SESSION_1 = 'a1'.repeat(32), SESSION_2 = 'b2'.repeat(32);   // 64 characters like the real session, synthetic
/** A recent 5-minute boundary, so a posted msmtEps is inside Solstice's 7-day window. */
const recentMsmt = (minutesAgo = 10) => new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 300_000) * 300_000).toISOString().replace('.000Z', 'Z');
const MSMT = recentMsmt();                                         // as the PVS writes it: 2026-09-27T23:15:00Z
const isoOf = (s: string) => new Date(s).toISOString();            // as the relay posts it
const pvs = { server: null as unknown as Server, port: 0, session: SESSION_1, vars: pvsVars(MSMT) as unknown, varsStatus: 200, expired: 400 as 400 | 401, uptimeS: '14511.80', log: [] as Hit[] };
function pvsHandler(req: IncomingMessage, res: ServerResponse) {
  pvs.log.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie });
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (req.url === '/auth?login') {
    if (req.headers.authorization !== `Basic ${Buffer.from(`ssm_owner:${PW}`).toString('base64')}`) return send(401, { error: 'unauthorized' });
    return send(200, { session: pvs.session });
  }
  if (req.url === '/vars?match=/sys/info/uptime&fmt=obj') return send(200, { '/sys/info/uptime': pvs.uptimeS });
  if (req.url?.startsWith('/vars?')) {
    if (req.headers.cookie !== `session=${pvs.session}`) return pvs.expired === 401 ? send(401, { error: 'session expired' }) : send(400, PVS_BAD_REQUEST);
    if (req.url !== '/vars?match=inverter&fmt=obj&cache=1') return send(400, PVS_BAD_REQUEST);   // match=inverter/data, or no cache=1
    return pvs.varsStatus === 200 ? send(200, pvs.vars) : send(pvs.varsStatus, PVS_BAD_REQUEST);
  }
  send(404, { error: 'not found' });
}

/** A recording server: an https one with the same self-signed certificate (a "Solstice" whose certificate must be
 *  refused), or a plain http one registered with the fetch guard (a mock API with a canned answer). */
async function recorder(kind: 'https' | 'http', answer: (res: ServerResponse) => void = res => { res.writeHead(500); res.end(); }) {
  const hits: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => { hits.push(`${req.method} ${req.url}`); answer(res); };
  const server = kind === 'https' ? createHttpsServer({ cert: TLS.cert, key: TLS.key }, handler) : createHttpServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  if (kind === 'http') ports.add(port);
  return { server, port, hits, origin: `${kind}://127.0.0.1:${port}` };
}

const cfgFor = (extra: Record<string, string | undefined> = {}) => relay.loadConfig({
  PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW, SOLSTICE_URL: base, SOLSTICE_OWNER_KEY: process.env.OWNER_KEY, ...extra });
const newState = (log: string[] = []): State => ({ pvsCookie: null, apiCookie: null, fingerprintShown: false, log: m => log.push(m) });

function envFile(name: string, env: Record<string, string>) {
  const p = join(tmp, name);
  writeFileSync(p, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return p;
}
/** Runs the relay CLI as a child process (it is not under this process's fetch guard, so it only gets local targets). */
function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    execFile(process.execPath, [RELAY_PATH, ...args], { env: { PATH: process.env.PATH ?? '', HOME: tmp }, timeout: 20_000 },
      (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }));
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'solstice-pvs-test-'));
  relay = await import(pathToFileURL(RELAY_PATH).href) as Relay;
  const { app: expressApp } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  pvsMod = await import('../../server/src/pvs.js');
  await db.migrate();
  app = createHttpServer(expressApp).listen(0, '127.0.0.1'); await once(app, 'listening');
  const port = (app.address() as AddressInfo).port;
  ports.add(port);                       // the fetch guard allows only registered in-process servers
  base = `http://127.0.0.1:${port}`;
  pvs.server = createHttpsServer({ cert: TLS.cert, key: TLS.key }, pvsHandler).listen(0, '127.0.0.1'); await once(pvs.server, 'listening');
  pvs.port = (pvs.server.address() as AddressInfo).port;
  // the route tests' own owner cookie, from a separate client IP so the relay's unlocks keep their own rate-limit bucket
  const r = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.40' }, body: JSON.stringify({ key: process.env.OWNER_KEY }) });
  expect(r.status).toBe(200);
  ownerCookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
});
afterAll(async () => {
  for (const s of [app, pvs.server]) if (s) { s.close(); s.closeAllConnections?.(); }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const rows = (sn: string) => db.q<{ ts: Date; sn: string; kw: number | null; kw_dc: number | null; v: number | null; t: number | null; kwh: number | null }>(
  'SELECT ts, sn, kw::float8 AS kw, kw_dc::float8 AS kw_dc, v::float8 AS v, temp_c::float8 AS t, kwh_lifetime::float8 AS kwh FROM pvs_readings WHERE sn = $1 ORDER BY ts', [sn]);
const api = (path: string, init: RequestInit = {}, cookie = ownerCookie) =>
  fetch(base + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string> ?? {}) } });
const postJson = (body: unknown, cookie = ownerCookie) => api('/api/pvs/readings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, cookie);

/* ======================================================================================================== */
describe('relay configuration', () => {
  it('RELAY-1 parses the env file: comments, blank lines, export prefix, quotes', () => {
    expect(relay.parseEnv('# PVS\n\nexport PVS_HOST=10.0.0.9\nPVS_PASSWORD="T3ST5"\nSOLSTICE_URL = \'https://app.invalid\'\nnot a line\n'))
      .toEqual({ PVS_HOST: '10.0.0.9', PVS_PASSWORD: 'T3ST5', SOLSTICE_URL: 'https://app.invalid' });
  });

  it('RELAY-2 refuses unsafe or incomplete settings with a message that names the problem, never a value', () => {
    const ok = { PVS_HOST: '10.0.0.9', PVS_PASSWORD: PW, SOLSTICE_URL: 'https://app.invalid', SOLSTICE_OWNER_KEY: 'k'.repeat(40) };
    const refuse = (env: Record<string, string | undefined>, msg: RegExp, o = {}) => {
      let err: any; try { relay.loadConfig(env, o); } catch (e) { err = e; }
      expect(err, msg.source).toBeInstanceOf(relay.FatalError);
      expect(err.message).toMatch(msg);
      expect(err.message).not.toContain(PW);
    };
    refuse({ ...ok, PVS_PASSWORD: '' }, /missing in the env file: PVS_PASSWORD/);
    refuse({ PVS_HOST: '10.0.0.9', PVS_PASSWORD: PW }, /missing in the env file: SOLSTICE_URL, SOLSTICE_INGEST_TOKEN/);
    refuse({ ...ok, PVS_HOST: 'https://10.0.0.9' }, /PVS_HOST must be a bare host/);
    refuse({ ...ok, PVS_HOST: '10.0.0.9/vars' }, /PVS_HOST must be a bare host/);
    refuse({ ...ok, SOLSTICE_URL: 'http://app.invalid' }, /must be https/);
    refuse({ ...ok, SOLSTICE_URL: 'https://app.invalid/api' }, /origin only/);
    refuse({ ...ok, SOLSTICE_OWNER_KEY: 'short' }, /OWNER_KEY \(32\+ characters\)/);
    refuse({ ...ok, PVS_CERT_SHA256: 'AB:CD' }, /64 hex digits/);
    // a dry run only needs the PVS settings
    expect(relay.loadConfig({ PVS_HOST: '10.0.0.9', PVS_PASSWORD: PW }, { dryRun: true })).toMatchObject({ pvsHost: '10.0.0.9', pvsPort: 443, apiOrigin: null });
    expect(relay.loadConfig({ ...ok, SOLSTICE_URL: 'http://127.0.0.1:8787' }).apiOrigin).toBe('http://127.0.0.1:8787'); // plain http only locally
    // turning TLS verification off process-wide would weaken the Solstice call too
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try { refuse(ok, /NODE_TLS_REJECT_UNAUTHORIZED=0/); } finally { delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; }
  });

  it('RELAY-3 refuses an env file inside the repo, where it could be committed', () => {
    expect(relay.insideRepo(join(REPO, 'scripts', 'pvs.env'))).toBe(true);
    expect(relay.insideRepo(join(tmp, 'pvs.env'))).toBe(false);
    expect(() => relay.readEnvFile(join(REPO, 'pvs.env'))).toThrow(/inside the Solstice repo/);
  });
});

/* ======================================================================================================== */
describe('relay ↔ PVS (mocked as the real PVS6 answers, TLS with a self-signed certificate)', () => {
  it('PVS-1 logs in with Basic ssm_owner:<serial suffix>, sends the body session as its own cookie, reads match=inverter&cache=1, GET only', async () => {
    pvs.log.length = 0;
    const log: string[] = [];
    const { payload, posted } = await relay.pollOnce(relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true }), newState(log), { dryRun: true });
    expect(posted).toBeNull();
    expect(payload).toEqual({ ts: isoOf(MSMT), inverters: PVS_EXPECTED });        // the PVS's msmtEps is the reading time
    expect(relay.VARS_PATH).toBe('/vars?match=inverter&fmt=obj&cache=1');
    expect(pvs.log.map(h => `${h.method} ${h.url}`)).toEqual(['GET /auth?login', 'GET /vars?match=inverter&fmt=obj&cache=1']);
    expect(pvs.log[0].auth).toBe(`Basic ${Buffer.from(`ssm_owner:${PW}`).toString('base64')}`);
    expect(pvs.log[1]).toMatchObject({ auth: undefined, cookie: `session=${SESSION_1}` });
    expect(pvs.log.every(h => h.method === 'GET' && !/set=/.test(h.url))).toBe(true);
    expect(log.join('\n')).toContain(`PVS certificate SHA-256 ${TLS.sha256}`);   // shown once so the owner can pin it
  });

  it('PVS-1b the mock answers like the real PVS6: 400 0x0040 to the old inverter/data query and to a query without cache=1', async () => {
    const cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    const login = await relay.pvsGet(cfg, '/auth?login', { Authorization: `Basic ${Buffer.from(`ssm_owner:${PW}`).toString('base64')}` }) as { status: number; body: string; headers: Record<string, unknown> };
    expect([login.status, JSON.parse(login.body), login.headers['set-cookie']]).toEqual([200, { session: SESSION_1 }, undefined]);
    for (const path of ['/vars?match=inverter/data&fmt=obj', '/vars?match=inverter&fmt=obj']) {
      const r = await relay.pvsGet(cfg, path, { Cookie: `session=${SESSION_1}` });
      expect([path, r.status, JSON.parse(r.body)]).toEqual([path, 400, PVS_BAD_REQUEST]);
    }
    // and a 400 on the relay's own query surfaces the PVS's description and error code
    pvs.varsStatus = 400;
    try {
      const err = await relay.readInverters(cfg, newState()).catch(e => e);
      expect(err.message).toMatch(/^PVS \/vars\?match=inverter&fmt=obj&cache=1 answered HTTP 400 \(Bad request 0x0040\)/);
    } finally { pvs.varsStatus = 200; }
  });

  it('PVS-2 parses the flat /sys/devices/inverter/<n>/<field> object of strings; skips records without a serial or any reading', () => {
    expect(relay.parseInverters(pvsVars(MSMT))).toEqual({ inverters: PVS_EXPECTED, skipped: 0, ts: isoOf(MSMT) });
    expect(relay.parseInverters(pvsVars(null))).toEqual({ inverters: PVS_EXPECTED, skipped: 0, ts: null });
    const later = new Date(Date.parse(MSMT) + 300_000).toISOString();
    expect(relay.parseInverters(pvsVars(MSMT, { '/sys/devices/inverter/1/msmtEps': later })).ts).toBe(later);   // the newest msmtEps
    const odd = {
      '/sys/info/sw_rev': '2026.01', '/sys/livedata/pv_p': '6.1', '/sys/devices/inverter/x/sn': 'TEST-INV-99',   // not inverter records
      '/sys/devices/inverter/0/sn': 'TEST-INV-09', '/sys/devices/inverter/0/p3phsumKw': 'n/a',                     // no usable reading
      '/sys/devices/inverter/1/p3phsumKw': '0.1',                                                                  // no serial
      '/sys/devices/inverter/2/sn': 'TEST-INV-01', '/sys/devices/inverter/2/p3phsumKw': '0.2',
      '/sys/devices/inverter/10/sn': 'TEST-INV-01', '/sys/devices/inverter/10/p3phsumKw': '0.3',                  // repeated serial
      '/sys/devices/inverter/3/sn': 'TEST-INV-04', '/sys/devices/inverter/3/ltea3phsumKwh': '12.5',              // energy only is enough
    };
    expect(relay.parseInverters(odd)).toEqual({ inverters: [
      { sn: 'TEST-INV-01', kw: 0.2, kwDc: null, v: null, tempC: null, kwhLifetime: null },
      { sn: 'TEST-INV-04', kw: null, kwDc: null, v: null, tempC: null, kwhLifetime: 12.5 },
    ], skipped: 3, ts: null });
    for (const x of [null, [], 'x', [{ '/sys/devices/inverter/0/sn': 'TEST-INV-01' }]]) expect(relay.parseInverters(x)).toEqual({ inverters: [], skipped: 0, ts: null });
  });

  it('PVS-2b the reading time falls back to now when msmtEps is missing or ahead of the clock', async () => {
    const cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    const now = Date.now();
    try {
      pvs.vars = pvsVars(null);
      expect((await relay.pollOnce(cfg, newState(), { dryRun: true, now: () => now })).payload.ts).toBe(new Date(now).toISOString());
      pvs.vars = pvsVars(new Date(now + 3600_000).toISOString());
      expect((await relay.pollOnce(cfg, newState(), { dryRun: true, now: () => now })).payload.ts).toBe(new Date(now).toISOString());
    } finally { pvs.vars = pvsVars(MSMT); }
  });

  it('PVS-3 an expired PVS session answered with 401 logs in again once and carries on', async () => {
    const state = newState(), cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    pvs.expired = 401;
    try {
      await relay.readInverters(cfg, state);
      pvs.log.length = 0; pvs.session = SESSION_2;
      expect((await relay.readInverters(cfg, state)).inverters).toEqual(PVS_EXPECTED);
      expect(pvs.log.map(h => h.url)).toEqual([relay.VARS_PATH, '/auth?login', relay.VARS_PATH]);
      expect(state.pvsCookie).toBe(`session=${SESSION_2}`);
    } finally { pvs.expired = 400; pvs.session = SESSION_1; }
  });

  it('PVS-3b regression 2026-09-28: an expired session answered with 400 0x0040 logs in again once, and the poll lands', async () => {
    const log: string[] = [], state = newState(log), cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    try {
      await relay.readInverters(cfg, state);
      pvs.log.length = 0; pvs.session = SESSION_2;                          // the PVS forgot SESSION_1 (it restarted)
      expect((await relay.readInverters(cfg, state)).inverters).toEqual(PVS_EXPECTED);
      expect(pvs.log.map(h => h.url)).toEqual([relay.VARS_PATH, '/auth?login', relay.VARS_PATH]);
      expect(pvs.log[0].cookie).toBe(`session=${SESSION_1}`);
      expect(pvs.log[2].cookie).toBe(`session=${SESSION_2}`);
      expect(log.join('\n')).toContain('answered HTTP 400 (Bad request 0x0040); logging in again');
    } finally { pvs.session = SESSION_1; }
  });

  it('PVS-3c the login answer carries no expiry, so a session an hour old is replaced before the read', async () => {
    const state = newState(), cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    const t0 = Date.now();
    await relay.readInverters(cfg, state, { now: () => t0 });
    expect(state.pvsLoginAt).toBe(t0);
    pvs.log.length = 0;
    await relay.readInverters(cfg, state, { now: () => t0 + relay.SESSION_MAX_MS - 60_000 });
    expect(pvs.log.map(h => h.url)).toEqual([relay.VARS_PATH]);            // 59 minutes: the same session
    pvs.log.length = 0;
    await relay.readInverters(cfg, state, { now: () => t0 + relay.SESSION_MAX_MS });
    expect(pvs.log.map(h => h.url)).toEqual(['/auth?login', relay.VARS_PATH]);
    expect(relay.SESSION_MAX_MS).toBe(3600_000);
  });

  it('PVS-3d when the read fails again with a fresh session: one login only, then the PVS\'s uptime says it is up but lists no inverters', async () => {
    const log: string[] = [], state = newState(log), cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    await relay.readInverters(cfg, state);
    pvs.log.length = 0; pvs.varsStatus = 400;
    try {
      const err = await relay.readInverters(cfg, state).catch(e => e);
      expect(pvs.log.map(h => h.url)).toEqual([relay.VARS_PATH, '/auth?login', relay.VARS_PATH, relay.UPTIME_PATH]);
      expect(err).toMatchObject({ pvs: 'no-inverters', http: 400, uptimeS: 14512 });
      expect(err).not.toBeInstanceOf(relay.FatalError);                    // the loop tries again at the next 5-minute bucket
      expect(err.message).toMatch(/answered HTTP 400 \(Bad request 0x0040\) with a fresh session; the PVS is up \(uptime 242 min\) but lists no inverters/);
      // the next bucket: again one login and one retry, never a loop
      pvs.log.length = 0;
      await relay.readInverters(cfg, state).catch(() => {});
      expect(pvs.log.filter(h => h.url === '/auth?login')).toHaveLength(1);
      // without an uptime answer it is reported as a refusal, not as "no inverters"
      pvs.uptimeS = 'n/a';
      expect(await relay.readInverters(cfg, newState()).catch(e => e)).toMatchObject({ pvs: 'refused', http: 400, uptimeS: null });
    } finally { pvs.varsStatus = 200; pvs.uptimeS = '14511.80'; }
    expect(pvs.log.every(h => h.method === 'GET' && !/set=/.test(h.url))).toBe(true);
  });

  it('PVS-4 a refused login is fatal and says which setting to fix, without echoing it', async () => {
    const cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: 'WRONG' }, { dryRun: true });
    const err = await relay.readInverters(cfg, newState()).catch(e => e);
    expect(err).toBeInstanceOf(relay.FatalError);
    expect(err).toMatchObject({ pvs: 'login-refused', http: 401 });
    expect(err.message).toMatch(/PVS login refused \(HTTP 401\)\. Check PVS_PASSWORD/);
    expect(err.message).not.toContain('WRONG');
  });

  it('PVS-5 an answer without inverter readings is an error that lists the top-level keys', async () => {
    pvs.vars = { '/sys/info/sw_rev': '2026.01, Build 1' };
    try {
      const err = await relay.readInverters(relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true }), newState()).catch(e => e);
      expect(err.message).toMatch(/without any inverter readings.*Top-level keys: \/sys\/info\/sw_rev/);
    } finally { pvs.vars = pvsVars(MSMT); }
  });
});

/* ======================================================================================================== */
describe('TLS: the self-signed certificate is trusted only on the relay\'s own connection to PVS_HOST', () => {
  it('TLS-1 the relay reads the PVS, but an ordinary https request to the same server is still refused', async () => {
    await relay.readInverters(relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true }), newState());
    const err = await new Promise<any>(done => https.get(`https://127.0.0.1:${pvs.port}/auth?login`, r => { r.resume(); done(null); }).on('error', done));
    expect(err?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(https.globalAgent.options.rejectUnauthorized).not.toBe(false);
  });

  it('TLS-2 pvsGet takes only a path on PVS_HOST: a URL for another host is refused before connecting', async () => {
    pvs.log.length = 0;
    const cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    for (const p of ['https://example.invalid/auth?login', '//example.invalid/x', 'auth?login'])
      await expect(relay.pvsGet(cfg, p)).rejects.toThrow('pvsGet takes a path on PVS_HOST');
    expect(pvs.log).toEqual([]);
  });

  it('TLS-3 with PVS_CERT_SHA256 set, the matching certificate works (any case, colons optional) and another is refused before any credential is sent', async () => {
    const env = { PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW };
    const pinned = relay.loadConfig({ ...env, PVS_CERT_SHA256: TLS.sha256.replace(/:/g, '').toLowerCase() }, { dryRun: true });
    expect((await relay.readInverters(pinned, newState())).inverters).toEqual(PVS_EXPECTED);
    pvs.log.length = 0;
    const other = selfSignedCert('pvs.local').sha256;
    const err = await relay.readInverters(relay.loadConfig({ ...env, PVS_CERT_SHA256: other }, { dryRun: true }), newState()).catch(e => e);
    expect(err).toBeInstanceOf(relay.FatalError);
    expect(err.message).toMatch(/does not match PVS_CERT_SHA256/);
    expect(pvs.log).toEqual([]);                  // no request reached the server, so no password was sent
  });

  it('TLS-4 (CLI) the same self-signed certificate on the Solstice side is refused: exit 1, and that server never sees a request', async () => {
    const fake = await recorder('https');
    try {
      pvs.log.length = 0;
      const env = envFile('tls4.env', { PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW, SOLSTICE_URL: fake.origin, SOLSTICE_OWNER_KEY: 'k'.repeat(40) });
      const r = await cli([env, '--once']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/cannot reach Solstice at https:\/\/127\.0\.0\.1:\d+: .*(SELF_SIGNED|self[- ]signed|certificate)/i);
      expect(fake.hits).toEqual([]);
      expect(pvs.log.map(h => h.url)).toEqual(['/auth?login', relay.VARS_PATH]);   // the PVS itself was read
    } finally { fake.server.close(); }
  });
});

/* ======================================================================================================== */
describe('relay → Solstice (the real app on PGlite)', () => {
  it('API-1 unlocks once with the owner key, keeps the cookie in memory and posts each poll', async () => {
    await revokeRelaySessions();
    const cfg = cfgFor(), state = newState();
    const m0 = recentMsmt(20), m1 = recentMsmt(15), t0 = Date.parse(m0);
    pvs.vars = pvsVars(m0);
    try {
      const first = await relay.pollOnce(cfg, state);
      expect(first.posted).toEqual({ ok: true, inserted: 3, duplicates: 0 });
      expect(first.payload.ts).toBe(isoOf(m0));
      expect(state.apiCookie).toMatch(/^solstice_owner=/);
      const cookie = state.apiCookie;
      const same = await relay.pollOnce(cfg, state);                        // the PVS has not measured again yet
      expect(same.posted).toEqual({ ok: true, inserted: 0, duplicates: 3 });
      pvs.vars = pvsVars(m1);
      const second = await relay.pollOnce(cfg, state);
      expect(second.posted).toEqual({ ok: true, inserted: 3, duplicates: 0 });
      expect(state.apiCookie).toBe(cookie);                                 // no second unlock
    } finally { pvs.vars = pvsVars(MSMT); }
    expect((await db.q('SELECT id FROM owner_sessions WHERE id <> $1', [routeSession()])).length).toBe(1);   // one device row for the relay
    const stored = await rows('TEST-INV-02');
    expect(stored.map(r => r.ts.getTime())).toEqual([t0, Date.parse(m1)]);
    expect(stored[0]).toMatchObject({ sn: 'TEST-INV-02', kw: 0.192, kw_dc: 0.1987, v: 32.8, t: 43.5, kwh: 2511.204102 });
    expect((await rows('TEST-INV-03'))[0]).toMatchObject({ kw: 0, kw_dc: 0, v: 0, t: null, kwh: 2702 });
  });

  it('API-6 with SOLSTICE_INGEST_TOKEN the relay posts without the owner key, makes no owner session, and the token opens nothing else', async () => {
    const TOKEN = 'test-ingest-token-synthetic-abcdefghijklmnop';   // test-only
    process.env.PVS_INGEST_TOKEN = TOKEN;
    await revokeRelaySessions();
    const before = (await db.q('SELECT id FROM owner_sessions')).length;
    const cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW, SOLSTICE_URL: base, SOLSTICE_INGEST_TOKEN: TOKEN }), state = newState();
    const m0 = recentMsmt(40); pvs.vars = pvsVars(m0);
    try {
      expect((await relay.pollOnce(cfg, state)).posted).toMatchObject({ ok: true, inserted: 3 });
      expect(state.apiCookie).toBeNull();
      expect((await db.q('SELECT id FROM owner_sessions')).length).toBe(before);              // no owner session for the relay
      const bearer = { authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
      expect((await fetch(`${base}/api/pvs/heartbeat`, { method: 'POST', headers: bearer, body: JSON.stringify({ pvs: 'ok' }) })).status).toBe(200);
      for (const [m, path] of [['GET', '/api/pvs/latest'], ['GET', '/api/settings'], ['POST', '/api/appliances/ac/command'], ['POST', '/api/pvs/layout']] as const)
        expect((await fetch(`${base}${path}`, { method: m, headers: bearer, ...(m === 'POST' ? { body: '{}' } : {}) })).status).toBe(401);
      expect((await fetch(`${base}/api/pvs/readings`, { method: 'POST', headers: { ...bearer, authorization: 'Bearer wrong-token-wrong-token-wrong-token-xx' }, body: '{}' })).status).toBe(401);
      process.env.PVS_INGEST_TOKEN = '';                                                       // no token configured: bearer opens nothing
      expect((await fetch(`${base}/api/pvs/heartbeat`, { method: 'POST', headers: bearer, body: JSON.stringify({ pvs: 'ok' }) })).status).toBe(401);
    } finally { pvs.vars = pvsVars(MSMT); delete process.env.PVS_INGEST_TOKEN; }
  });

  it('API-2 a 401 (cookie revoked) unlocks again once and the poll still lands; a retried poll stores nothing twice', async () => {
    const cfg = cfgFor(), state = newState();
    const t = Date.now() - 60_000, payload = { ts: new Date(t).toISOString(), inverters: PVS_EXPECTED };
    await relay.postReadings(cfg, state, payload);
    await revokeRelaySessions();                                           // e.g. "sign out other devices"
    const seen: string[] = [], guard = globalThis.fetch;
    vi.stubGlobal('fetch', (input: any, init?: any) => { seen.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`); return guard(input, init); });
    try {
      expect(await relay.postReadings(cfg, state, payload)).toEqual({ ok: true, inserted: 0, duplicates: 3 });
    } finally { vi.stubGlobal('fetch', guard); }
    expect(seen).toEqual(['POST /api/pvs/readings', 'POST /api/auth/owner', 'POST /api/pvs/readings']);
  });

  it('API-5 a poll that fails on the PVS side posts a heartbeat; a stored poll marks the PVS ok again', async () => {
    const hb = async () => (await db.q<{ value: any }>(`SELECT value FROM kv WHERE key = 'pvs:heartbeat'`))[0]?.value;
    const cfg = cfgFor(), state = newState(), seen: string[] = [], guard = globalThis.fetch;
    pvs.varsStatus = 400;
    vi.stubGlobal('fetch', (input: any, init?: any) => { seen.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`); return guard(input, init); });
    try {
      const before = Date.now();
      const err = await relay.pollOnce(cfg, state).catch(e => e);
      expect(err).toMatchObject({ pvs: 'no-inverters' });
      expect(seen.filter(x => x.includes('/api/pvs/'))).toEqual(['POST /api/pvs/heartbeat']);   // no readings posted
      const v = await hb();
      expect(v).toMatchObject({ pvs: 'no-inverters', http: 400, uptimeS: 14512 });
      expect(v.at).toBeGreaterThanOrEqual(before);
      expect(v.error).toMatch(/lists no inverters/);
      expect(v.error).not.toContain(PW);
      // unreachable: the heartbeat still says the Mac is up
      const down = relay.loadConfig({ PVS_HOST: '127.0.0.1:1', PVS_PASSWORD: PW, SOLSTICE_URL: base, SOLSTICE_OWNER_KEY: process.env.OWNER_KEY });
      expect(await relay.pollOnce(down, state).catch(e => e)).toMatchObject({ pvs: 'unreachable' });
      expect(await hb()).toMatchObject({ pvs: 'unreachable', http: null });
      pvs.varsStatus = 200; pvs.vars = pvsVars(recentMsmt(5));
      expect((await relay.pollOnce(cfg, state)).posted).toMatchObject({ ok: true });
      expect(await hb()).toMatchObject({ pvs: 'ok', http: 200, error: null });
    } finally { vi.stubGlobal('fetch', guard); pvs.varsStatus = 200; pvs.vars = pvsVars(MSMT); }
  });

  it('API-3 a wrong owner key is fatal with a message that says what to fix', async () => {
    const err = await relay.apiLogin(cfgFor({ SOLSTICE_OWNER_KEY: 'wrong-key-synthetic-0000000000000000' }), newState()).catch(e => e);
    expect(err).toBeInstanceOf(relay.FatalError);
    expect(err.message).toMatch(/refused SOLSTICE_OWNER_KEY \(invalid_owner_key\)/);
    expect(err.message).not.toContain('wrong-key');
  });

  it('API-4 a 401 page that is not Solstice\'s JSON (a protected preview URL) is fatal with a hint', async () => {
    const mock = await recorder('http', res => { res.writeHead(401, { 'Content-Type': 'text/html' }); res.end('<html>Authentication Required</html>'); });
    try {
      const err = await relay.apiLogin(cfgFor({ SOLSTICE_URL: mock.origin }), newState()).catch(e => e);
      expect(err).toBeInstanceOf(relay.FatalError);
      expect(err.message).toMatch(/HTTP 401 without Solstice's JSON \(is SOLSTICE_URL the production app/);
      expect(mock.hits).toEqual(['POST /api/auth/owner']);
    } finally { mock.server.close(); }
  });
});

/* ======================================================================================================== */
describe('relay CLI', () => {
  it('CLI-1 --dry-run prints the payload and never contacts Solstice', async () => {
    const mock = await recorder('http');
    try {
      const env = envFile('dry.env', { PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW, SOLSTICE_URL: mock.origin, SOLSTICE_OWNER_KEY: 'k'.repeat(40) });
      const r = await cli([env, '--dry-run']);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(Object.keys(out)).toEqual(['ts', 'inverters']);
      expect(out.inverters).toEqual(PVS_EXPECTED);
      expect(mock.hits).toEqual([]);
    } finally { mock.server.close(); }
  });

  it('CLI-2 a wrong PVS password exits 1 with a clear message and does not print the password', async () => {
    const env = envFile('badpw.env', { PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: 'ZZ9ZZ', SOLSTICE_URL: 'http://127.0.0.1:9', SOLSTICE_OWNER_KEY: 'k'.repeat(40) });
    const r = await cli([env, '--once']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pvs-relay: PVS login refused \(HTTP 401\)\. Check PVS_PASSWORD/);
    expect(r.stderr + r.stdout).not.toContain('ZZ9ZZ');
  });

  it('CLI-3 a missing env file or an unknown option exits 2 with usage help', async () => {
    const missing = await cli([join(tmp, 'nope.env'), '--once']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/cannot read the env file .*nope\.env: ENOENT/);
    const bad = await cli(['--forever']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/unknown option --forever\nusage: node scripts\/pvs-relay\.mjs/);
  });
});

/* ======================================================================================================== */
describe('POST /api/pvs/readings', () => {
  const now = () => new Date().toISOString();
  const one = (sn: string, extra: Record<string, unknown> = {}) => ({ ts: now(), inverters: [{ sn, kw: 0.2, kwDc: 0.21, v: 31, tempC: 40, kwhLifetime: 100, ...extra }] });

  it('ING-1 is owner-only: no cookie is 401 and nothing is stored; a cross-site write is 403', async () => {
    const r = await postJson(one('TEST-ING-1'), '');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'owner_required' });
    const x = await api('/api/pvs/readings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify(one('TEST-ING-1')) });
    expect(x.status).toBe(403);
    for (const path of ['/api/pvs/day', '/api/pvs/latest']) expect((await api(path, {}, '')).status).toBe(401);
    expect(await rows('TEST-ING-1')).toEqual([]);
  });

  it('ING-2 validates the shape and says what is wrong', async () => {
    const t = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
    const inv = (x: Record<string, unknown>) => ({ ts: iso(t), inverters: [{ sn: 'TEST-ING-2', kw: 0.2, v: 31, tempC: 40, ...x }] });
    const cases: Array<[unknown, RegExp]> = [
      [[], /body must be a JSON object/],
      [{}, /ts must be an ISO 8601 time with a zone/],
      [{ ts: '2026-09-25 12:00', inverters: [] }, /ts must be an ISO 8601 time with a zone/],
      [{ ts: '2026-09-25T12:00:00', inverters: [] }, /ts must be an ISO 8601 time with a zone/],
      [{ ts: iso(t + 10 * 60_000), inverters: [{ sn: 'TEST-ING-2', kw: 0.2 }] }, /ts is in the future/],
      [{ ts: iso(t - 8 * 864e5), inverters: [{ sn: 'TEST-ING-2', kw: 0.2 }] }, /more than 7 days old/],
      [{ ts: iso(t), inverters: [] }, /non-empty array/],
      [{ ts: iso(t), inverters: {} }, /non-empty array/],
      [{ ts: iso(t), inverters: Array.from({ length: 61 }, (_, i) => ({ sn: `TEST-ING-2-${i}`, kw: 0 })) }, /at most 60 inverters/],
      [{ ts: iso(t), inverters: ['TEST-ING-2'] }, /inverters\[0\] must be an object/],
      [inv({ sn: '' }), /inverters\[0\]\.sn must be/],
      [inv({ sn: 'has space' }), /inverters\[0\]\.sn must be/],
      [inv({ sn: 42 }), /inverters\[0\]\.sn must be/],
      [{ ts: iso(t), inverters: [{ sn: 'TEST-ING-2', kw: 0.1 }, { sn: 'TEST-ING-2', kw: 0.2 }] }, /inverters\[1\]\.sn is repeated/],
      [inv({ kw: '0.2' }), /inverters\[0\]\.kw must be null or a number from 0 to 2/],
      [inv({ kw: 2.5 }), /inverters\[0\]\.kw must be null or a number from 0 to 2/],
      [inv({ kw: -0.1 }), /inverters\[0\]\.kw must be null or a number from 0 to 2/],
      [inv({ kwDc: 3 }), /inverters\[0\]\.kwDc must be null or a number from 0 to 2/],
      [inv({ kwDc: '0.2' }), /inverters\[0\]\.kwDc must be null/],
      [inv({ kwhLifetime: -1 }), /inverters\[0\]\.kwhLifetime must be null or a number of at least 0/],
      [inv({ kwhLifetime: '2693.5' }), /inverters\[0\]\.kwhLifetime must be null/],
      [inv({ v: 'x' }), /v must be null or a number/],
      [inv({ tempC: 999 }), /tempC must be null or a number/],
    ];
    for (const [body, msg] of cases) {
      const r = await postJson(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await r.json()).error).toMatch(msg);
    }
    const bad = await postJson('{not json');
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'body is not valid JSON' }]);
    const big = await postJson(JSON.stringify({ ts: iso(t), pad: 'x'.repeat(70_000), inverters: [] }));
    expect(big.status).toBe(413);
    expect((await db.q(`SELECT count(*)::int n FROM pvs_readings WHERE sn LIKE 'TEST-ING-2%'`))[0].n).toBe(0);
  });

  it('ING-3 stores only ts, sn, AC kW, DC kW, volts, °C and lifetime kWh: extra fields are dropped; every number may be null', async () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    const r = await postJson({ ts, pvs: { swRev: 'x' }, inverters: [
      { sn: 'TEST-ING-3', kw: 0.12345678, kwDc: 0.13, v: null, tempC: 38.456, kwhLifetime: 2693.5639651, state: 'working', freqHz: 60 },
      { sn: 'TEST-ING-3b' },                                               // only sn is required
    ], extra: true });
    expect(await r.json()).toEqual({ ok: true, inserted: 2, duplicates: 0 });
    const cols = await db.q<{ c: string }>(`SELECT column_name c FROM information_schema.columns WHERE table_name = 'pvs_readings' ORDER BY ordinal_position`);
    expect(cols.map(c => c.c)).toEqual(['ts', 'sn', 'kw', 'v', 'temp_c', 'kw_dc', 'kwh_lifetime']);
    expect(await rows('TEST-ING-3')).toEqual([{ ts: new Date(ts), sn: 'TEST-ING-3', kw: 0.12346, kw_dc: 0.13, v: null, t: 38.46, kwh: 2693.563965 }]);
    expect(await rows('TEST-ING-3b')).toEqual([{ ts: new Date(ts), sn: 'TEST-ING-3b', kw: null, kw_dc: null, v: null, t: null, kwh: null }]);
  });

  it('ING-4 is idempotent: the same poll posted twice stores it once, and the first write wins', async () => {
    const ts = new Date(Date.now() - 2000).toISOString();
    const body = { ts, inverters: [{ sn: 'TEST-ING-4a', kw: 0.2, v: 30, tempC: 40 }, { sn: 'TEST-ING-4b', kw: 0.1, v: 31, tempC: 41 }] };
    expect(await (await postJson(body)).json()).toEqual({ ok: true, inserted: 2, duplicates: 0 });
    expect(await (await postJson(body)).json()).toEqual({ ok: true, inserted: 0, duplicates: 2 });
    const changed = { ts, inverters: [{ sn: 'TEST-ING-4a', kw: 0.3, v: 30, tempC: 40 }, { sn: 'TEST-ING-4c', kw: 0.15, v: 31, tempC: 41 }] };
    expect(await (await postJson(changed)).json()).toEqual({ ok: true, inserted: 1, duplicates: 1 });
    expect((await rows('TEST-ING-4a')).map(r => r.kw)).toEqual([0.2]);
    expect((await rows('TEST-ING-4c')).length).toBe(1);
  });
});

/* ======================================================================================================== */
describe('POST /api/pvs/heartbeat', () => {
  const hb = (body: unknown, cookie = ownerCookie) => api('/api/pvs/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, cookie);
  it('HB-1 is owner-only, validates the status, and stores the server\'s time with it', async () => {
    expect((await hb({ pvs: 'refused' }, '')).status).toBe(401);
    for (const bad of [{ pvs: 'asleep' }, { pvs: 'refused', http: 42 }, { pvs: 'refused', uptimeS: -1 }, { pvs: 'refused', error: 7 }, []]) {
      const r = await hb(bad);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/pvs|http|uptimeS|error|object/);
    }
    const before = Date.now();
    const r = await hb({ pvs: 'refused', http: 400, error: 'PVS answered\nHTTP 400', uptimeS: 61.4, at: 0, extra: 'dropped' });
    expect(await r.json()).toEqual({ ok: true });
    const v = (await db.q<{ value: any }>(`SELECT value FROM kv WHERE key = 'pvs:heartbeat'`))[0].value;
    expect(v).toEqual({ at: expect.any(Number), pvs: 'refused', http: 400, error: 'PVS answered HTTP 400', uptimeS: 61 });
    expect(v.at).toBeGreaterThanOrEqual(before);                           // the server's clock, not the body's
  });
});

describe('GET /api/pvs/day and /api/pvs/latest', () => {
  const put = (ts: string, inverters: Reading[]) => pvsMod.ingestPvs({ ts: new Date(ts), inverters });
  const R = (sn: string, kw: number | null, v: number | null = null, tempC: number | null = null, kwhLifetime: number | null = null): Reading =>
    ({ sn, kw, kwDc: kw, v, tempC, kwhLifetime });

  it('DAY-1 per-inverter 5-minute series (bucket averages, null where missing) and per-panel kWh for one Chicago day', async () => {
    await put('2026-09-19T23:59:59-05:00', [R('TEST-DAY-A', 0.3)]);             // the day before: excluded
    await put('2026-09-20T00:00:00-05:00', [R('TEST-DAY-B', 0, 0, 20)]);        // local midnight: included
    await put('2026-09-20T12:00:10-05:00', [R('TEST-DAY-A', 0.2, 30, 40)]);
    await put('2026-09-20T12:03:00-05:00', [R('TEST-DAY-A', 0.3, 32, 42)]);      // same bucket as 12:00:10 → averaged
    await put('2026-09-20T12:05:30-05:00', [R('TEST-DAY-A', 0.24, 31, 44)]);
    await put('2026-09-20T12:05:40-05:00', [R('TEST-DAY-B', 0.18, 30.5, null)]);
    await put('2026-09-20T12:20:00-05:00', [R('TEST-DAY-A', 0.12, 29, 39), R('TEST-DAY-B', 0.06)]);
    await put('2026-09-21T00:00:00-05:00', [R('TEST-DAY-A', 0.3)]);             // the next day: excluded
    const r = await api('/api/pvs/day?date=2026-09-20');
    expect(r.status).toBe(200);
    const d = await r.json();
    const at = (hm: string) => Date.parse(`2026-09-20T${hm}:00-05:00`);
    expect(d).toMatchObject({ date: '2026-09-20', timeZone: 'America/Chicago', start: '2026-09-20T05:00:00.000Z', end: '2026-09-21T05:00:00.000Z', bucketMinutes: 5 });
    expect(d.times).toEqual([at('00:00'), at('12:00'), at('12:05'), at('12:20')]);
    expect(d.inverters).toEqual([
      { sn: 'TEST-DAY-A', kwh: 0.051, kwhSource: 'integrated', peakKw: 0.25, maxTempC: 44, buckets: 3, kw: [null, 0.25, 0.24, 0.12], v: [null, 31, 31, 29], tempC: [null, 41, 44, 39] },
      { sn: 'TEST-DAY-B', kwh: 0.02, kwhSource: 'integrated', peakKw: 0.18, maxTempC: 20, buckets: 3, kw: [0, null, 0.18, 0.06], v: [0, null, 30.5, null], tempC: [20, null, null, null] },
    ]);
    expect(d.total.kwh).toBe(0.071);
    expect(d.total.inverters).toBe(2);
    expect(d.total.medianKwh).toBeCloseTo(0.0355, 6);
  });

  it('DAY-4 per-panel kWh is the lifetime counter\'s last minus first reading of the day when both exist', async () => {
    const at = (hm: string) => `2026-09-22T${hm}:00-05:00`;
    await put('2026-09-21T23:55:00-05:00', [R('TEST-LIFE-A', 0, null, null, 90)]);          // the day before: not the first reading
    await put(at('07:00'), [R('TEST-LIFE-A', 0.01, null, null, 100), R('TEST-LIFE-B', 0.1, null, null, 500), R('TEST-LIFE-C', 0.2, null, null, 700)]);
    await put(at('12:00'), [R('TEST-LIFE-A', 0.3, null, null, null), R('TEST-LIFE-B', 0.3), R('TEST-LIFE-C', 0.2, null, null, 10)]);
    await put(at('19:00'), [R('TEST-LIFE-A', 0.02, null, null, 102.25), R('TEST-LIFE-B', 0.1)]);
    await put('2026-09-23T00:00:00-05:00', [R('TEST-LIFE-A', 0, null, null, 110)]);          // the next day: not the last reading
    const d = await (await api('/api/pvs/day?date=2026-09-22')).json();
    const got = Object.fromEntries(d.inverters.filter((i: any) => i.sn.startsWith('TEST-LIFE')).map((i: any) => [i.sn, [i.kwh, i.kwhSource, i.buckets]]));
    expect(got).toEqual({
      'TEST-LIFE-A': [2.25, 'lifetime', 3],        // 102.25 − 100, across the gaps, ignoring the null in between
      'TEST-LIFE-B': [0.042, 'integrated', 3],     // one lifetime reading only: (0.1 + 0.3 + 0.1) kW × 5 min
      'TEST-LIFE-C': [0.033, 'integrated', 2],     // the counter went backwards (a replaced inverter): (0.2 + 0.2) × 5 min
    });
  });

  it('DAY-5 without any lifetime readings the day falls back to integrating AC kW; a bucket with no kW counts as nothing', async () => {
    await put('2026-09-24T10:00:00-05:00', [R('TEST-INTEG', 0.24)]);
    await put('2026-09-24T10:05:00-05:00', [R('TEST-INTEG', null, 30, 40)]);
    await put('2026-09-24T10:10:00-05:00', [R('TEST-INTEG', 0.12)]);
    const d = await (await api('/api/pvs/day?date=2026-09-24')).json();
    expect(d.inverters.find((i: any) => i.sn === 'TEST-INTEG')).toMatchObject({ kwh: 0.03, kwhSource: 'integrated', buckets: 2, kw: [0.24, null, 0.12], v: [null, 30, null] });
  });

  it('DAY-2 the fall-back day is 25 hours long and keeps both 1 a.m. hours', async () => {
    await put('2026-10-31T23:55:00-05:00', [R('TEST-DST', 0.1)]);
    await put('2026-11-01T00:30:00-05:00', [R('TEST-DST', 0.1)]);
    await put('2026-11-01T01:30:00-05:00', [R('TEST-DST', 0.1)]);   // first 1:30 (CDT)
    await put('2026-11-01T01:30:00-06:00', [R('TEST-DST', 0.1)]);   // second 1:30 (CST)
    await put('2026-11-01T23:30:00-06:00', [R('TEST-DST', 0.1)]);
    await put('2026-11-02T00:05:00-06:00', [R('TEST-DST', 0.1)]);
    const d = await (await api('/api/pvs/day?date=2026-11-01')).json();
    expect([d.start, d.end]).toEqual(['2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z']);
    expect(d.inverters.map((i: any) => [i.sn, i.buckets])).toEqual([['TEST-DST', 4]]);
  });

  it('DAY-3 a bad date is 400; a day without readings is empty; no date means today in Chicago', async () => {
    for (const q of ['2026-13-01', '2026-02-30', 'yesterday', '2026-9-1']) {
      const r = await api(`/api/pvs/day?date=${q}`);
      expect([q, r.status]).toEqual([q, 400]);
    }
    expect(await (await api('/api/pvs/day?date=2026-01-15')).json()).toMatchObject({ times: [], inverters: [], total: { kwh: 0, inverters: 0, medianKwh: null } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    expect((await (await api('/api/pvs/day')).json()).date).toBe(today);
  });

  it('LATEST-1 the newest reading per inverter with its age in seconds; inverters silent a week before the newest drop out', async () => {
    await db.q('DELETE FROM pvs_readings');       // this file's in-memory database only
    const t = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
    await put(iso(t - 8 * 864e5), [R('TEST-LAT-C', 0.2)]);
    await put(iso(t - 3600_000), [R('TEST-LAT-B', 0.1, 30, 35)]);
    await put(iso(t - 600_000), [R('TEST-LAT-A', 0.15, 31, 38)]);
    await put(iso(t - 60_000), [{ sn: 'TEST-LAT-A', kw: 0.21, kwDc: 0.22, v: 32.5, tempC: 41, kwhLifetime: 2693.563965 }]);
    const d = await (await api('/api/pvs/latest')).json();
    expect(d.count).toBe(2);
    expect(d.at).toBe(iso(t - 60_000));
    expect(d.ageS).toBeGreaterThanOrEqual(60); expect(d.ageS).toBeLessThan(70);
    expect(d.inverters.map((i: any) => ({ ...i, ageS: Math.round(i.ageS / 10) * 10 }))).toEqual([
      { sn: 'TEST-LAT-A', ts: iso(t - 60_000), ageS: 60, kw: 0.21, kwDc: 0.22, v: 32.5, tempC: 41, kwhLifetime: 2693.563965 },
      { sn: 'TEST-LAT-B', ts: iso(t - 3600_000), ageS: 3600, kw: 0.1, kwDc: 0.1, v: 30, tempC: 35, kwhLifetime: null },
    ]);
    await db.q('DELETE FROM pvs_readings');
    expect(await (await api('/api/pvs/latest')).json()).toEqual({ at: null, ageS: null, count: 0, inverters: [] });
  });

  it('LATEST-2 the last 24 hours first; the week back from the newest reading whenever a panel is missing from the day (code review C-12)', async () => {
    await db.q('DELETE FROM pvs_readings');
    const t = Date.now(), iso = (ms: number) => new Date(ms).toISOString(), sns = async () => (await (await api('/api/pvs/latest')).json()).inverters.map((i: any) => i.sn);
    await put(iso(t - 2 * 864e5), [R('TEST-L2-OLD', 0.2)]);
    await put(iso(t - 600_000), [R('TEST-L2-NEW', 0.15)]);
    expect(await sns()).toEqual(['TEST-L2-NEW', 'TEST-L2-OLD']);          // fewer than the 30 panels in the day: the 2-day-old inverter is looked up over the week, so the grid keeps it
    // a full day (30 inverters) answers from the day alone: the 2-day-old one is then genuinely gone from the window
    await put(iso(t - 300_000), Array.from({ length: 30 }, (_, i) => R(`TEST-L2-P${String(i).padStart(2, '0')}`, 0.1)));
    expect((await sns()).filter((x: string) => x === 'TEST-L2-OLD')).toEqual([]);
    await db.q(`DELETE FROM pvs_readings WHERE sn LIKE 'TEST-L2-P%'`);
    await db.q(`DELETE FROM pvs_readings WHERE sn = 'TEST-L2-NEW'`);
    await put(iso(t - 4 * 864e5), [R('TEST-L2-OLDER', 0.1)]);
    expect(await sns()).toEqual(['TEST-L2-OLD', 'TEST-L2-OLDER']);         // the relay quiet for 2 days: as before, the week back from its last poll
    await db.q('DELETE FROM pvs_readings');
  });
});

describe('retention', () => {
  it('RET-1 the nightly prune keeps 90 days of raw readings, records the relay\'s first day before deleting it, and is idempotent', async () => {
    const now = Date.now(), day = 864e5, at = (d: number) => new Date(Math.floor((now - d * day) / 300_000) * 300_000);
    const oldest = at(100), kept = at(89);
    await db.q(`DELETE FROM kv WHERE key = 'pvs:since'`);
    await db.q(`INSERT INTO pvs_readings (ts, sn, kw) VALUES ($1, 'TEST-RET-01', 0.1), ($2, 'TEST-RET-01', 0.2), ($1, 'TEST-RET-02', 0.1)`, [oldest.toISOString(), kept.toISOString()]);
    try {
      expect(pvsMod.PVS_KEEP_DAYS).toBe(90);
      expect(pvsMod.PVS_KEEP_DAYS).toBeGreaterThan(21 * 2);                 // learn/nightly.ts recomputes the last 21 days from raw readings
      expect(await pvsMod.pvsSince()).toBe(oldest.getTime());               // before the first prune: the oldest stored reading
      const r = await pvsMod.prunePvs(now);
      expect(r).toEqual({ deleted: 2, since: oldest.toISOString() });
      expect((await rows('TEST-RET-01')).map(x => x.ts.getTime())).toEqual([kept.getTime()]);
      expect(await rows('TEST-RET-02')).toEqual([]);
      expect(await db.kv.get('pvs:since')).toBe(oldest.getTime());         // the first day survives the prune
      expect(await pvsMod.pvsSince()).toBe(oldest.getTime());
      expect(await pvsMod.prunePvs(now)).toEqual({ deleted: 0, since: oldest.toISOString() });
    } finally {
      await db.q(`DELETE FROM pvs_readings WHERE sn LIKE 'TEST-RET-%'`);
      await db.q(`DELETE FROM kv WHERE key = 'pvs:since'`);
    }
  });
});
