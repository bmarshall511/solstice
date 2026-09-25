// Safety rails for every test file (docs/audit-designs/tests.md §3). No test run may reach ScreenLogic, Nest, Tesla or Neon.
//  1. DATABASE_URL must be in-memory PGlite; anything else (Neon, a Postgres URL, a PGlite directory on disk) stops the run.
//  2. Device, Tesla, Google, Neon and cron credentials are removed from process.env, so `configured()` / `nestConfigured()`
//     are false unless a test mocks the module, and nothing can authenticate anywhere.
//  3. fetch is allowed only to the in-process Express app: 127.0.0.1 on a port a test registered after listening
//     (so a local `npm run dev` on 127.0.0.1:8787, which may hold real credentials, is unreachable too). Any other URL
//     throws, and is also recorded so the test fails even when app code swallows the error.
//  4. node-screenlogic and the Neon driver are replaced with stubs that throw, so a forgotten module mock cannot open a
//     connection to the pool controller or the cloud database.
import { vi, beforeAll, afterEach } from 'vitest';

const SAFE_DB = /^pglite:(memory:\/\/)?$/;
const STRIP_PREFIX = /^(TESLA_|SCREENLOGIC_|NEST_|GOOGLE_|POSTGRES_|PG|NEON_|VERCEL_|OWNER_)/;
const STRIP_KEYS = ['CRON_SECRET', 'SETUP_TOKEN', 'SESSION_SECRET', 'DATABASE_URL_UNPOOLED', 'MULTI_USER', 'ALLOW_SIGNUPS', 'SITE_LAT', 'SITE_LON'];

function rails() {
  const url = process.env.DATABASE_URL ?? '';
  if (!SAFE_DB.test(url)) throw new Error(`tests refuse to run against DATABASE_URL=${url.slice(0, 12)}… (only pglite:memory:// is allowed)`);
  for (const k of Object.keys(process.env)) if (STRIP_PREFIX.test(k) || STRIP_KEYS.includes(k)) delete process.env[k];
}
rails();            // before any test module is imported
beforeAll(rails);   // and again before the first test, in case a module set something at import time

// Shared through globalThis: tests/db/api.test.ts registers its server's port; tests/server/rails.test.ts proves the
// guard and then clears what it deliberately tripped.
const blocked: string[] = ((globalThis as any).__blockedFetches = []);
const ports = ((globalThis as any).__testServerPorts = new Set<number>());
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const u = input instanceof Request ? input.url : String(input);
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(u);
  if (m && ports.has(Number(m[1]))) return realFetch(input, init); // only the in-process Express app
  blocked.push(u.split('?')[0]);
  throw new Error(`unmocked fetch in test: ${u.split('?')[0]}`);
});
afterEach(() => {
  if (blocked.length) throw new Error(`test attempted network call(s): ${blocked.splice(0).join(', ')}`);
});

vi.mock('node-screenlogic', () => {
  class Blocked { constructor() { throw new Error('node-screenlogic is blocked in tests'); } }
  return { RemoteLogin: Blocked, UnitConnection: Blocked, default: { RemoteLogin: Blocked, UnitConnection: Blocked } };
});
vi.mock('@neondatabase/serverless', () => ({
  neon: () => { throw new Error('the Neon driver is blocked in tests'); },
}));
