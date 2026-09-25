#!/usr/bin/env node
// Solstice PVS relay: reads per-panel production from the SunPower PVS6 on the home LAN and pushes it to Solstice.
// Node 22, built-ins only. Setup, launchd and the env file: scripts/README.md.
//
//   node scripts/pvs-relay.mjs [env-file] [--once] [--dry-run]
//
//   env-file   KEY=VALUE file outside this repo (default ~/.solstice/pvs.env): PVS_HOST, PVS_PASSWORD, SOLSTICE_URL,
//              SOLSTICE_OWNER_KEY, optional PVS_CERT_SHA256.
//   --once     one poll, then exit (0 = posted, 1 = failed). The first manual test.
//   --dry-run  one poll that prints the payload it would post and never contacts Solstice.
//   (neither)  keeps running and polls once per 5-minute clock bucket. launchd starts it (scripts/README.md).
//
// The PVS side is GET-only: it logs in (GET /auth?login, Basic ssm_owner:<PVS_PASSWORD>) and reads
// GET /vars?match=inverter/data&fmt=obj. It never calls vars?set= or anything else that writes.
// TLS: the PVS's self-signed certificate is accepted only on connections to PVS_HOST, made by pvsGet() below, and only
// after the certificate matches PVS_CERT_SHA256 when that is set. Nothing touches the global TLS settings, so the
// Solstice API call keeps full certificate verification.
// Solstice side: POST /api/auth/owner once with the owner key, keep the solstice_owner cookie in memory, and POST each
// poll to /api/pvs/readings with it; on a 401 it unlocks again once and retries.
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

export const INTERVAL_MS = 5 * 60_000;       // one poll per 5-minute clock bucket
const CHECK_MS = 15_000;                     // how often the loop looks at the clock (catches up quickly after sleep)
const PVS_TIMEOUT_MS = 15_000, API_TIMEOUT_MS = 20_000, MAX_BODY = 2 * 1024 * 1024;
export const VARS_PATH = '/vars?match=inverter/data&fmt=obj';
export const DEFAULT_ENV = resolve(homedir(), '.solstice', 'pvs.env');
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const UA = 'solstice-pvs-relay/1';

/** A configuration or credential problem: retrying cannot fix it, so the relay exits non-zero. */
export class FatalError extends Error {}
const describe = e => `${e?.message ?? e}${e?.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : ''}`;

/* ------------------------------------------------ configuration ------------------------------------------------ */

/** KEY=VALUE lines; `#` comments, blank lines, an optional `export ` prefix and matching quotes are allowed. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** True when `path` is inside this repository (where a secrets file could end up committed). */
export function insideRepo(path, repo = REPO) {
  let p = resolve(path), r = resolve(repo);
  try { p = realpathSync(p); } catch { /* not created yet */ }
  try { r = realpathSync(r); } catch { /* keep as is */ }
  return p === r || p.startsWith(r + sep);
}

const fingerprint = s => String(s ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();

/** Checks the env values and returns the relay's config. Throws FatalError with a message that names the problem. */
export function loadConfig(env, { dryRun = false } = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new FatalError('NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks for every connection, the Solstice API included. Unset it; the relay trusts the PVS certificate on its own.');
  const need = ['PVS_HOST', 'PVS_PASSWORD', ...(dryRun ? [] : ['SOLSTICE_URL', 'SOLSTICE_OWNER_KEY'])];
  const missing = need.filter(k => !env[k]);
  if (missing.length) throw new FatalError(`missing in the env file: ${missing.join(', ')}`);

  const host = String(env.PVS_HOST).trim().toLowerCase();
  let pvs;
  try { pvs = new URL(`https://${host}`); } catch { pvs = null; }
  if (!pvs || pvs.host !== host || pvs.username || pvs.password)
    throw new FatalError('PVS_HOST must be a bare host or IP, optionally with :port (no https://, no path), for example 192.168.1.20');

  const pin = env.PVS_CERT_SHA256 ? fingerprint(env.PVS_CERT_SHA256) : null;
  if (pin !== null && pin.length !== 64) throw new FatalError('PVS_CERT_SHA256 must be the certificate SHA-256 fingerprint: 64 hex digits, colons optional');

  let api = null;
  if (env.SOLSTICE_URL) {
    try { api = new URL(env.SOLSTICE_URL); } catch { throw new FatalError('SOLSTICE_URL is not a URL; use the app origin, for example https://<your-app>'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname);
    if (api.protocol !== 'https:' && !(api.protocol === 'http:' && local))
      throw new FatalError('SOLSTICE_URL must be https:// (plain http only for localhost), so the owner key never travels in the clear');
    if (api.pathname !== '/' || api.search || api.hash || api.username) throw new FatalError('SOLSTICE_URL must be the app origin only, for example https://<your-app>');
  }
  if (!dryRun && String(env.SOLSTICE_OWNER_KEY).trim().length < 32) throw new FatalError('SOLSTICE_OWNER_KEY must be the app\'s OWNER_KEY (32+ characters)');

  return {
    pvsHost: pvs.host, pvsHostname: pvs.hostname.replace(/^\[|\]$/g, ''), pvsPort: Number(pvs.port || 443),
    pvsPassword: String(env.PVS_PASSWORD).trim(), pvsCertSha256: pin,
    apiOrigin: api?.origin ?? null, ownerKey: env.SOLSTICE_OWNER_KEY ? String(env.SOLSTICE_OWNER_KEY).trim() : null,
  };
}

/** Reads and checks the env file: outside the repo, and (warning only) not readable by other users. */
export function readEnvFile(path, { warn = () => {} } = {}) {
  if (insideRepo(path)) throw new FatalError(`${path} is inside the Solstice repo, where it could be committed. Keep it outside, for example ${DEFAULT_ENV}`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new FatalError(`cannot read the env file ${path}: ${e.code ?? e.message}. Create it (scripts/README.md) or pass its path.`); }
  try { if (statSync(path).mode & 0o077) warn(`warning: ${path} is readable by other users; run chmod 600 ${path}`); } catch { /* ignore */ }
  return parseEnv(text);
}

/* ------------------------------------------------ PVS (LAN, GET only) ------------------------------------------------ */

/** Opens the TLS connection to PVS_HOST. This is the only place the PVS's self-signed certificate is accepted: the
 *  options are built here, for this host, per connection. With PVS_CERT_SHA256 set, a different certificate is refused
 *  before any request (and so any credential) is sent. */
function pvsConnect(cfg, state) {
  return new Promise((ok, fail) => {
    const opts = { host: cfg.pvsHostname, port: cfg.pvsPort, rejectUnauthorized: false, timeout: PVS_TIMEOUT_MS, ALPNProtocols: ['http/1.1'] };
    if (!isIP(cfg.pvsHostname)) opts.servername = cfg.pvsHostname;   // SNI never carries an IP address
    const sock = tls.connect(opts, () => {
      const fp = sock.getPeerCertificate()?.fingerprint256 ?? '';
      if (cfg.pvsCertSha256 && fingerprint(fp) !== cfg.pvsCertSha256) {
        sock.destroy();
        return fail(new FatalError(`the PVS at ${cfg.pvsHost} presented a certificate (SHA-256 ${fp}) that does not match PVS_CERT_SHA256. If the PVS firmware was updated, check the new fingerprint and update the env file; otherwise something else is answering at that address.`));
      }
      if (!cfg.pvsCertSha256 && state && !state.fingerprintShown) { state.fingerprintShown = true; state.log?.(`PVS certificate SHA-256 ${fp} (add PVS_CERT_SHA256=${fp} to the env file to pin it)`); }
      sock.setTimeout(0);
      ok(sock);
    });
    sock.once('timeout', () => sock.destroy(new Error(`timed out connecting to the PVS at ${cfg.pvsHost}`)));
    sock.once('error', e => fail(e));
  });
}

/** GET a path on PVS_HOST. The target host always comes from the config, so the relaxed TLS above cannot be pointed
 *  anywhere else; `path` must be a path, not a URL. */
export async function pvsGet(cfg, path, headers = {}, state) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error(`pvsGet takes a path on PVS_HOST, not ${path}`);
  const sock = await pvsConnect(cfg, state);
  return new Promise((ok, fail) => {
    const req = https.request({ host: cfg.pvsHostname, port: cfg.pvsPort, method: 'GET', path, createConnection: () => sock,
      headers: { Host: cfg.pvsHost, Accept: 'application/json', 'User-Agent': UA, Connection: 'close', ...headers } }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(new Error('the PVS response is larger than expected')); else chunks.push(c); });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.setTimeout(PVS_TIMEOUT_MS, () => req.destroy(new Error(`timed out waiting for the PVS at ${cfg.pvsHost}`)));
    req.on('error', fail);
    req.end();
  });
}

/** Logs in as ssm_owner and returns the `session=…` cookie. A refused login is fatal (wrong PVS_PASSWORD). */
export async function pvsLogin(cfg, state) {
  const basic = Buffer.from(`ssm_owner:${cfg.pvsPassword}`).toString('base64');
  let r;
  try { r = await pvsGet(cfg, '/auth?login', { Authorization: `Basic ${basic}` }, state); }
  catch (e) { if (e instanceof FatalError) throw e; throw new Error(`cannot reach the PVS at ${cfg.pvsHost}: ${describe(e)}`); }
  if (r.status === 401 || r.status === 403)
    throw new FatalError(`PVS login refused (HTTP ${r.status}). Check PVS_PASSWORD: the last 5 characters of the PVS serial number, exactly as printed on the PVS6 label.`);
  if (r.status !== 200) throw new Error(`PVS login failed: HTTP ${r.status}`);
  const set = [].concat(r.headers['set-cookie'] ?? []).map(c => c.split(';')[0].trim()).find(c => c.startsWith('session='));
  if (set) return set;
  let body = null; try { body = JSON.parse(r.body); } catch { /* fall through */ }
  if (typeof body?.session === 'string' && body.session) return `session=${body.session}`;
  throw new Error('the PVS accepted the login but returned no session');
}

const num = x => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

/** Turns the varserver answer into [{ sn, kw, v, tempC }]. Accepts the per-inverter object form
 *  ({ "/sys/devices/inverter/0": { sn, pMppt1Kw, … } }), the flat form ({ "/sys/devices/inverter/0/sn": … }) and the
 *  { values: [{ name, value }] } form, so a firmware difference in the shape does not lose data. */
export function parseInverters(json) {
  const objects = [], flat = new Map();
  const addFlat = (name, value) => {
    const i = name.lastIndexOf('/'); if (i <= 0) return;
    const key = name.slice(0, i); if (!flat.has(key)) flat.set(key, {});
    flat.get(key)[name.slice(i + 1)] = value;
  };
  const visit = node => {
    if (Array.isArray(node)) {
      for (const x of node) {
        if (x && typeof x === 'object' && typeof x.name === 'string' && 'value' in x) addFlat(x.name, x.value); else visit(x);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.sn === 'string' || typeof node.sn === 'number') { objects.push(node); return; }
    for (const [k, v] of Object.entries(node)) {
      if (v !== null && typeof v === 'object') visit(v);
      else if (k.includes('/')) addFlat(k, v);
    }
  };
  visit(json);
  for (const o of flat.values()) if (o.sn !== undefined && o.sn !== null) objects.push(o);
  const inverters = [], seen = new Set(); let skipped = 0;
  for (const o of objects) {
    const sn = String(o.sn).trim(), kw = num(o.pMppt1Kw);
    if (!sn || kw === null || seen.has(sn)) { skipped++; continue; }
    seen.add(sn);
    inverters.push({ sn, kw, v: num(o.vMppt1V), tempC: num(o.tHtsnkDegc) });
  }
  return { inverters, skipped };
}

/** Logs in when needed (again once if the session has expired) and returns the parsed inverter readings. */
export async function readInverters(cfg, state) {
  state.pvsCookie ??= await pvsLogin(cfg, state);
  let r = await pvsGet(cfg, VARS_PATH, { Cookie: state.pvsCookie }, state);
  if (r.status === 401 || r.status === 403) {
    state.pvsCookie = await pvsLogin(cfg, state);
    r = await pvsGet(cfg, VARS_PATH, { Cookie: state.pvsCookie }, state);
  }
  if (r.status !== 200) throw new Error(`PVS ${VARS_PATH} answered HTTP ${r.status}`);
  let json;
  try { json = JSON.parse(r.body); } catch { throw new Error(`PVS ${VARS_PATH} did not answer with JSON`); }
  const { inverters, skipped } = parseInverters(json);
  if (!inverters.length) {
    const keys = json && typeof json === 'object' ? Object.keys(json).slice(0, 5).join(', ') : typeof json;
    throw new Error(`the PVS answered without any inverter readings (sn + pMppt1Kw). Top-level keys: ${keys || 'none'}`);
  }
  if (skipped) state.log?.(`skipped ${skipped} inverter record(s) without a serial or pMppt1Kw`);
  return inverters;
}

/* ------------------------------------------------ Solstice API ------------------------------------------------ */

async function apiFetch(cfg, path, init) {
  let r;
  try { r = await fetch(new URL(path, cfg.apiOrigin), { ...init, redirect: 'manual', signal: AbortSignal.timeout(API_TIMEOUT_MS) }); }
  catch (e) { throw new Error(`cannot reach Solstice at ${cfg.apiOrigin}: ${describe(e)}`); }
  if (r.status >= 300 && r.status < 400) throw new FatalError(`Solstice redirected ${path} to ${r.headers.get('location')}; set SOLSTICE_URL to the final https origin`);
  return r;
}
const bodyOf = async r => { const text = await r.text().catch(() => ''); try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; } };

/** POST /api/auth/owner with the owner key; keeps the solstice_owner cookie in `state` (memory only). */
export async function apiLogin(cfg, state) {
  state.apiCookie = null;
  const r = await apiFetch(cfg, '/api/auth/owner', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ key: cfg.ownerKey }) });
  const { json } = await bodyOf(r);
  if (r.status === 401 && json?.error === 'invalid_owner_key') throw new FatalError('Solstice refused SOLSTICE_OWNER_KEY (invalid_owner_key). Copy the current OWNER_KEY from the Vercel env into the env file.');
  if (r.status === 503 && json?.error === 'owner_key_not_configured') throw new FatalError('Solstice has no OWNER_KEY configured (owner_key_not_configured). Set it in the Vercel env first.');
  if (r.status === 429 || r.status >= 500) throw new Error(`Solstice owner unlock answered HTTP ${r.status}; the next poll tries again`);
  if (!r.ok || !json?.ok) throw new FatalError(`Solstice owner unlock answered HTTP ${r.status}${json ? '' : ' without Solstice\'s JSON (is SOLSTICE_URL the production app, not a protected preview?)'}`);
  const cookie = (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0].trim()).find(c => c.startsWith('solstice_owner='));
  if (!cookie) throw new Error('Solstice unlocked but set no solstice_owner cookie');
  state.apiCookie = cookie;
  return cookie;
}

/** POST one poll to /api/pvs/readings with the owner cookie; unlocks first if needed and once more on a 401. */
export async function postReadings(cfg, state, payload) {
  const send = () => apiFetch(cfg, '/api/pvs/readings', { method: 'POST', body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Cookie: state.apiCookie } });
  if (!state.apiCookie) await apiLogin(cfg, state);
  let r = await send();
  if (r.status === 401) { await apiLogin(cfg, state); r = await send(); }
  const { text, json } = await bodyOf(r);
  if (r.status === 401) throw new FatalError('Solstice still answers 401 with a fresh owner cookie; check SOLSTICE_URL and SOLSTICE_OWNER_KEY');
  if (!r.ok || !json?.ok) throw new Error(`POST /api/pvs/readings answered HTTP ${r.status}: ${(json?.error ?? text).slice(0, 200)}`);
  return json;
}

/* ------------------------------------------------ one poll, the loop, the CLI ------------------------------------------------ */

/** One poll: read the PVS, then (unless dryRun) post. Returns { payload, posted }. */
export async function pollOnce(cfg, state, { dryRun = false, now = Date.now } = {}) {
  const ts = new Date(now()).toISOString();       // one ts per poll, reused if the POST is retried
  const inverters = await readInverters(cfg, state);
  const payload = { ts, inverters };
  if (dryRun) return { payload, posted: null };
  return { payload, posted: await postReadings(cfg, state, payload) };
}

const summary = ({ payload, posted }) => {
  const kw = payload.inverters.reduce((a, i) => a + i.kw, 0);
  return `${payload.ts} ${payload.inverters.length} inverters, ${kw.toFixed(3)} kW total` + (posted ? `: ${posted.inserted} stored, ${posted.duplicates} already stored` : '');
};

const USAGE = `usage: node scripts/pvs-relay.mjs [env-file] [--once] [--dry-run]
  env-file   default ${DEFAULT_ENV}
  --once     poll the PVS once, post to Solstice, exit (0 ok, 1 failed)
  --dry-run  poll once and print the payload; never contacts Solstice
  (no flag)  keep running, one poll per 5-minute clock bucket (what launchd runs)`;

export async function main(argv = process.argv.slice(2), io = { out: console.log, err: console.error }) {
  const flags = new Set(argv.filter(a => a.startsWith('--'))), files = argv.filter(a => !a.startsWith('--'));
  const unknown = [...flags].filter(f => !['--once', '--dry-run', '--help'].includes(f));
  if (flags.has('--help')) { io.out(USAGE); return 0; }
  if (unknown.length || files.length > 1) { io.err(`${unknown.length ? `unknown option ${unknown.join(' ')}` : 'more than one env file'}\n${USAGE}`); return 2; }
  const dryRun = flags.has('--dry-run'), once = flags.has('--once') || dryRun;
  const stamp = m => `${new Date().toISOString()} ${m}`;
  let cfg;
  try { cfg = loadConfig(readEnvFile(resolve(files[0] ?? DEFAULT_ENV), { warn: m => io.err(m) }), { dryRun }); }
  catch (e) { io.err(`pvs-relay: ${describe(e)}`); return 2; }
  const state = { pvsCookie: null, apiCookie: null, fingerprintShown: false, log: m => io.err(stamp(m)) };

  if (once) {
    try {
      const r = await pollOnce(cfg, state, { dryRun });
      if (dryRun) io.out(JSON.stringify(r.payload, null, 2)); else io.out(summary(r));
      return 0;
    } catch (e) { io.err(`pvs-relay: ${describe(e)}`); return 1; }
  }

  io.err(stamp(`pvs-relay: polling ${cfg.pvsHost} every ${INTERVAL_MS / 60_000} minutes, posting to ${cfg.apiOrigin}`));
  return new Promise(done => {
    let last = -1, busy = false;
    const tick = async () => {
      const bucket = Math.floor(Date.now() / INTERVAL_MS);
      if (busy || bucket === last) return;
      busy = true; last = bucket;
      try { io.out(summary(await pollOnce(cfg, state))); }
      catch (e) {
        io.err(stamp(`pvs-relay: ${describe(e)}`));
        if (e instanceof FatalError) { clearInterval(timer); done(1); }   // launchd starts it again after StartInterval
      } finally { busy = false; }
    };
    const timer = setInterval(tick, CHECK_MS);
    tick();
  });
}

const invoked = process.argv[1] && (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; } })();
if (invoked) process.exitCode = await main();
