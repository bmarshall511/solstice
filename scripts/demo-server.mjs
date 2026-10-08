#!/usr/bin/env node
// Solstice offline demo: the real app on http://localhost:8790 with synthetic data on every screen, for checking the UI in a browser
// as the owner (and as a guest) without Tesla, Nest, ScreenLogic, Neon or any other network. See scripts/README.md.
//
//   npm run demo                 (builds web/dist first when it is missing)
//   npm run demo -- --build      (rebuild web/dist first)
//   PORT=8791 npm run demo
//
// Order matters: the env is set and the network guard installed before the app is imported (scripts/demo/main.ts).
//  - DATABASE_URL is a fresh PGlite directory under the OS temp dir, deleted on exit. Any DATABASE_URL / POSTGRES_* in the shell is ignored.
//  - Every credential the app knows is removed from the environment; the owner key, session and cron secrets are synthetic constants
//    that only open this local server. The Nest and ScreenLogic variables are set to dummy values only so the Pool and AC screens show.
//  - fetch reaches localhost only; Open-Meteo, NWS and ERCOT answer from synthetic fixtures, anything else gets a 503 (logged to stderr).
//    Sockets to any non-loopback host are refused, node-screenlogic and the Neon driver are replaced with stubs that throw.
import { register } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));   // not .pathname: the repo folder may have a space (or a trailing one) in its name
const args = process.argv.slice(2);

/* ---------- 1. the environment: synthetic, test-only values; nothing real ---------- */
/** TEST-ONLY, SYNTHETIC: opens this local demo server and nothing else. Never a real key. */
export const DEMO_OWNER_KEY = 'demo-owner-key-synthetic-local-only-000000000000';
const STRIP = /^(TESLA_|SCREENLOGIC_|NEST_|GOOGLE_|POSTGRES_|PG|NEON_|VERCEL_|OWNER_|SITE_|SOLAR_|PVS_|VAPID_|PUSH_|DATABASE_)/;
for (const k of Object.keys(process.env)) if (STRIP.test(k) || ['CRON_SECRET', 'SESSION_SECRET', 'SETUP_TOKEN', 'MULTI_USER', 'ALLOW_SIGNUPS'].includes(k)) delete process.env[k];
const dbDir = mkdtempSync(join(tmpdir(), 'solstice-demo-'));
Object.assign(process.env, {
  TZ: 'UTC',                                   // what the Vercel function runs with
  DATABASE_URL: `pglite:${dbDir}`,
  OWNER_KEY: DEMO_OWNER_KEY,
  SESSION_SECRET: 'demo-session-secret-synthetic-local-only-0000000',
  CRON_SECRET: 'demo-cron-secret-synthetic-local-only-0000000000',
  // a generic public point (Austin city hall), never the owner's location
  SITE_LAT: '30.2672', SITE_LON: '-97.7431', SITE_ZIP: '78701',
  // dummies so the Pool and AC screens are "configured"; every read is answered from the stored snapshots, every call is blocked
  SCREENLOGIC_SYSTEM: 'Pentair: DE-MO-00', SCREENLOGIC_PASSWORD: 'demo-not-a-password',
  NEST_PROJECT_ID: 'demo-project', GOOGLE_CLIENT_ID: 'demo-client-id', GOOGLE_CLIENT_SECRET: 'demo-not-a-secret', GOOGLE_REDIRECT_URI: 'http://localhost/auth/google/callback',
  TESLA_CLIENT_ID: 'demo-client-id', TESLA_CLIENT_SECRET: 'demo-not-a-secret', TESLA_REDIRECT_URI: 'http://localhost/auth/callback',
});
const port = Number(process.env.PORT ?? 8790);
const cleanup = () => { try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* already gone */ } };
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));

/* ---------- 2. module stubs: the pool controller library and the Neon driver can never load ---------- */
const hooks = `
const STUB = {
  'node-screenlogic': 'const no = () => { throw new Error("node-screenlogic is blocked in the offline demo"); }; export class RemoteLogin { constructor() { no(); } } export class UnitConnection { constructor() { no(); } } export default { RemoteLogin, UnitConnection };',
  '@neondatabase/serverless': 'export const neon = () => { throw new Error("the Neon driver is blocked in the offline demo"); }; export default { neon };',
};
export async function resolve(spec, ctx, next) {
  if (Object.hasOwn(STUB, spec)) return { url: 'data:text/javascript,' + encodeURIComponent(STUB[spec]), shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

/* ---------- 3. the web build ---------- */
if (args.includes('--build') || !existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
  console.log('[demo] building web/dist (npm run build)…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('[demo] the web build failed'); process.exit(1); }
}

/* ---------- 4. the guard, then the app ---------- */
const { installGuards } = await import('./demo/guard.ts');
const stats = installGuards();
const { main } = await import('./demo/main.ts');
await main({ port, ownerKey: DEMO_OWNER_KEY, stats }).catch(e => { console.error('[demo] failed to start:', e); process.exit(1); });
