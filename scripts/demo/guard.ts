// The demo's network guard (scripts/demo-server.mjs): nothing leaves the machine. Installed before the app is imported.
//   fetch   localhost passes through; Open-Meteo, NWS and ERCOT get a synthetic answer (fixtures.ts); anything else (Tesla, Google,
//           Neon…) gets a 503 and a line on stderr naming the host.
//   sockets net.Socket#connect (which tls, http, https and node-screenlogic all go through) refuses any host that is not loopback.
import net from 'node:net';
import { fixtureFor } from './fixtures.js';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLocalHost = (host: string) => LOCAL.has(host.toLowerCase()) || host.toLowerCase().endsWith('.localhost');
const urlOf = (input: string | URL | Request) => input instanceof Request ? input.url : String(input);

export type GuardLog = (line: string) => void;
export type GuardStats = { passed: number; fixtures: Record<string, number>; blocked: Record<string, number> };
/** A fetch that only reaches localhost: `real` for loopback URLs, fixtures or 503 for everything else. */
export function makeFetchGuard(real: typeof fetch, o: { log?: GuardLog; now?: () => number } = {}) {
  const log = o.log ?? (l => process.stderr.write(l + '\n')), stats: GuardStats = { passed: 0, fixtures: {}, blocked: {} };
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    let host = '';
    try { host = new URL(url).hostname; } catch { /* a relative or malformed URL: refused below */ }
    if (host && isLocalHost(host)) { stats.passed++; return real(input as any, init); }
    const body = host ? fixtureFor(url, o.now?.() ?? Date.now()) : null;
    if (body != null) { stats.fixtures[host] = (stats.fixtures[host] ?? 0) + 1; return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
    stats.blocked[host || url] = (stats.blocked[host || url] ?? 0) + 1;
    log(`[demo-guard] blocked ${host || url} (offline demo; nothing leaves this machine)`);
    return new Response(JSON.stringify({ error: 'offline_demo', error_description: `the demo server blocks ${host || 'this URL'}` }), { status: 503, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: guarded, stats };
}

let socketsGuarded = false;
/** Refuse every outgoing TCP/TLS connection to a non-loopback host (Unix sockets and loopback pass). Idempotent. */
export function guardSockets(log: GuardLog = l => process.stderr.write(l + '\n')) {
  if (socketsGuarded) return; socketsGuarded = true;
  const orig = net.Socket.prototype.connect as (...a: any[]) => net.Socket;
  (net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    const host = String(opts.host ?? opts.hostname ?? 'localhost');
    if (!opts.path && !isLocalHost(host)) {
      log(`[demo-guard] blocked a socket to ${host}:${opts.port ?? '?'}`);
      process.nextTick(() => this.destroy(new Error(`demo: connection to ${host} blocked (offline demo)`)));
      return this;
    }
    return orig.apply(this, args);
  };
}
/** Install both guards on this process. Returns the fetch stats. */
export function installGuards(log?: GuardLog) {
  const g = makeFetchGuard(globalThis.fetch.bind(globalThis), { log });
  globalThis.fetch = g.fetch;
  guardSockets(log);
  return g.stats;
}
