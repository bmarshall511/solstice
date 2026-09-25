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
import { PVS_INVERTERS_OBJ, PVS_INVERTERS_FLAT, PVS_INVERTERS_VALUES, PVS_EXPECTED, selfSignedCert } from '../fixtures/pvs.js';

vi.unmock('../../server/src/db.js');   // these tests need the real database module on PGlite

type Reading = { sn: string; kw: number; v: number | null; tempC: number | null };
type Cfg = Record<string, any>;
type State = { pvsCookie: string | null; apiCookie: string | null; fingerprintShown: boolean; log: (m: string) => void };
type Relay = {
  FatalError: new (m: string) => Error; VARS_PATH: string;
  parseEnv(text: string): Record<string, string>; insideRepo(path: string): boolean;
  loadConfig(env: Record<string, string | undefined>, o?: { dryRun?: boolean }): Cfg;
  readEnvFile(path: string): Record<string, string>;
  pvsGet(cfg: Cfg, path: string, headers?: Record<string, string>, state?: State): Promise<{ status: number; body: string }>;
  parseInverters(json: unknown): { inverters: Reading[]; skipped: number };
  readInverters(cfg: Cfg, state: State): Promise<Reading[]>;
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

/* ---------------- the mocked PVS: GET /auth?login (Basic ssm_owner:<PW>) and GET /vars?match=inverter/data&fmt=obj ---------------- */
type Hit = { method: string; url: string; auth?: string; cookie?: string };
const pvs = { server: null as unknown as Server, port: 0, session: 'test-session-1', vars: PVS_INVERTERS_OBJ as unknown, log: [] as Hit[] };
function pvsHandler(req: IncomingMessage, res: ServerResponse) {
  pvs.log.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie });
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (req.url === '/auth?login') {
    if (req.headers.authorization !== `Basic ${Buffer.from(`ssm_owner:${PW}`).toString('base64')}`) return send(401, { error: 'unauthorized' });
    return send(200, { session: pvs.session }, { 'Set-Cookie': `session=${pvs.session}; Path=/; HttpOnly; Secure` });
  }
  if (req.url === '/vars?match=inverter/data&fmt=obj') return req.headers.cookie === `session=${pvs.session}` ? send(200, pvs.vars) : send(401, { error: 'session expired' });
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

const rows = (sn: string) => db.q<{ ts: Date; sn: string; kw: number; v: number | null; t: number | null }>(
  'SELECT ts, sn, kw::float8 AS kw, v::float8 AS v, temp_c::float8 AS t FROM pvs_readings WHERE sn = $1 ORDER BY ts', [sn]);
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
    refuse({ PVS_HOST: '10.0.0.9', PVS_PASSWORD: PW }, /missing in the env file: SOLSTICE_URL, SOLSTICE_OWNER_KEY/);
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
describe('relay ↔ PVS (mocked, TLS with a self-signed certificate)', () => {
  it('PVS-1 logs in with Basic ssm_owner:<serial suffix>, reads inverter/data with the session cookie, GET only', async () => {
    pvs.log.length = 0;
    const log: string[] = [];
    const { payload, posted } = await relay.pollOnce(relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true }), newState(log), { dryRun: true });
    expect(posted).toBeNull();
    expect(payload.inverters).toEqual(PVS_EXPECTED);
    expect(Math.abs(Date.parse(payload.ts) - Date.now())).toBeLessThan(5000);
    expect(pvs.log.map(h => `${h.method} ${h.url}`)).toEqual(['GET /auth?login', 'GET /vars?match=inverter/data&fmt=obj']);
    expect(pvs.log[0].auth).toBe(`Basic ${Buffer.from(`ssm_owner:${PW}`).toString('base64')}`);
    expect(pvs.log[1]).toMatchObject({ auth: undefined, cookie: 'session=test-session-1' });
    expect(pvs.log.every(h => h.method === 'GET' && !/set=/.test(h.url))).toBe(true);
    expect(log.join('\n')).toContain(`PVS certificate SHA-256 ${TLS.sha256}`);   // shown once so the owner can pin it
  });

  it('PVS-2 reads the object, flat and values answer shapes; skips records without a serial or pMppt1Kw', () => {
    for (const shape of [PVS_INVERTERS_OBJ, PVS_INVERTERS_FLAT, PVS_INVERTERS_VALUES])
      expect(relay.parseInverters(shape)).toEqual({ inverters: PVS_EXPECTED, skipped: 0 });
    const odd = { a: { sn: 'TEST-INV-09', pMppt1Kw: 'n/a' }, b: { pMppt1Kw: '0.1' }, c: { sn: 'TEST-INV-01', pMppt1Kw: '0.2' }, d: { sn: 'TEST-INV-01', pMppt1Kw: '0.3' } };
    expect(relay.parseInverters(odd)).toEqual({ inverters: [{ sn: 'TEST-INV-01', kw: 0.2, v: null, tempC: null }], skipped: 2 });
  });

  it('PVS-3 an expired PVS session logs in again once and carries on', async () => {
    const state = newState(), cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true });
    await relay.readInverters(cfg, state);
    pvs.log.length = 0; pvs.session = 'test-session-2';
    expect(await relay.readInverters(cfg, state)).toEqual(PVS_EXPECTED);
    expect(pvs.log.map(h => h.url)).toEqual([relay.VARS_PATH, '/auth?login', relay.VARS_PATH]);
    expect(state.pvsCookie).toBe('session=test-session-2');
  });

  it('PVS-4 a refused login is fatal and says which setting to fix, without echoing it', async () => {
    const cfg = relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: 'WRONG' }, { dryRun: true });
    const err = await relay.readInverters(cfg, newState()).catch(e => e);
    expect(err).toBeInstanceOf(relay.FatalError);
    expect(err.message).toMatch(/PVS login refused \(HTTP 401\)\. Check PVS_PASSWORD/);
    expect(err.message).not.toContain('WRONG');
  });

  it('PVS-5 an answer without inverter readings is an error that lists the top-level keys', async () => {
    pvs.vars = { '/sys/info/sw_rev': '2026.01, Build 1' };
    try {
      const err = await relay.readInverters(relay.loadConfig({ PVS_HOST: `127.0.0.1:${pvs.port}`, PVS_PASSWORD: PW }, { dryRun: true }), newState()).catch(e => e);
      expect(err.message).toMatch(/without any inverter readings.*Top-level keys: \/sys\/info\/sw_rev/);
    } finally { pvs.vars = PVS_INVERTERS_OBJ; }
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
    expect(await relay.readInverters(pinned, newState())).toEqual(PVS_EXPECTED);
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
    const first = await relay.pollOnce(cfg, state);
    expect(first.posted).toEqual({ ok: true, inserted: 3, duplicates: 0 });
    expect(state.apiCookie).toMatch(/^solstice_owner=/);
    const cookie = state.apiCookie;
    const t0 = Date.parse(first.payload.ts);
    const second = await relay.pollOnce(cfg, state, { now: () => t0 + 300_000 });
    expect(second.posted).toEqual({ ok: true, inserted: 3, duplicates: 0 });
    expect(state.apiCookie).toBe(cookie);                                   // no second unlock
    expect((await db.q('SELECT id FROM owner_sessions WHERE id <> $1', [routeSession()])).length).toBe(1);   // one device row for the relay
    const stored = await rows('TEST-INV-02');
    expect(stored.map(r => r.ts.getTime())).toEqual([t0, t0 + 300_000]);
    expect(stored[0]).toMatchObject({ sn: 'TEST-INV-02', kw: 0.1987, v: 32.8, t: 43.5 });
    expect((await rows('TEST-INV-03'))[0]).toMatchObject({ kw: 0, v: 0, t: null });
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
  const one = (sn: string, extra: Record<string, unknown> = {}) => ({ ts: now(), inverters: [{ sn, kw: 0.2, v: 31, tempC: 40, ...extra }] });

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
      [inv({ kw: '0.2' }), /kw must be a number/],
      [inv({ kw: undefined }), /kw must be a number/],
      [inv({ kw: 5 }), /kw must be a number from -1 to 1/],
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

  it('ING-3 stores only ts, sn, kW, volts and °C: extra fields are dropped; nulls are allowed for v and tempC', async () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    const r = await postJson({ ts, pvs: { swRev: 'x' }, inverters: [{ sn: 'TEST-ING-3', kw: 0.12345678, v: null, tempC: 38.456, state: 'working', kwhLife: 1 }], extra: true });
    expect(await r.json()).toEqual({ ok: true, inserted: 1, duplicates: 0 });
    const cols = await db.q<{ c: string }>(`SELECT column_name c FROM information_schema.columns WHERE table_name = 'pvs_readings' ORDER BY ordinal_position`);
    expect(cols.map(c => c.c)).toEqual(['ts', 'sn', 'kw', 'v', 'temp_c']);
    expect(await rows('TEST-ING-3')).toEqual([{ ts: new Date(ts), sn: 'TEST-ING-3', kw: 0.12346, v: null, t: 38.46 }]);
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
describe('GET /api/pvs/day and /api/pvs/latest', () => {
  const put = (ts: string, inverters: Reading[]) => pvsMod.ingestPvs({ ts: new Date(ts), inverters });
  const R = (sn: string, kw: number, v: number | null = null, tempC: number | null = null): Reading => ({ sn, kw, v, tempC });

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
      { sn: 'TEST-DAY-A', kwh: 0.051, peakKw: 0.25, maxTempC: 44, buckets: 3, kw: [null, 0.25, 0.24, 0.12], v: [null, 31, 31, 29], tempC: [null, 41, 44, 39] },
      { sn: 'TEST-DAY-B', kwh: 0.02, peakKw: 0.18, maxTempC: 20, buckets: 3, kw: [0, null, 0.18, 0.06], v: [0, null, 30.5, null], tempC: [20, null, null, null] },
    ]);
    expect(d.total.kwh).toBe(0.071);
    expect(d.total.inverters).toBe(2);
    expect(d.total.medianKwh).toBeCloseTo(0.0355, 6);
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
    await put(iso(t - 60_000), [R('TEST-LAT-A', 0.21, 32.5, 41)]);
    const d = await (await api('/api/pvs/latest')).json();
    expect(d.count).toBe(2);
    expect(d.at).toBe(iso(t - 60_000));
    expect(d.ageS).toBeGreaterThanOrEqual(60); expect(d.ageS).toBeLessThan(70);
    expect(d.inverters.map((i: any) => ({ ...i, ageS: Math.round(i.ageS / 10) * 10 }))).toEqual([
      { sn: 'TEST-LAT-A', ts: iso(t - 60_000), ageS: 60, kw: 0.21, v: 32.5, tempC: 41 },
      { sn: 'TEST-LAT-B', ts: iso(t - 3600_000), ageS: 3600, kw: 0.1, v: 30, tempC: 35 },
    ]);
    await db.q('DELETE FROM pvs_readings');
    expect(await (await api('/api/pvs/latest')).json()).toEqual({ at: null, ageS: null, count: 0, inverters: [] });
  });
});
