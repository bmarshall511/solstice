// Solstice test harness (docs/audit-designs/tests.md). `web/vite.config.js` stays the build config.
// Every project loads tests/setup.ts: it refuses any database other than in-memory PGlite, strips device and Tesla
// credentials from the environment and blocks every network call except the in-process Express app.
import { defineConfig } from 'vitest/config';

const DB = 'pglite:memory://';
const serverEnv = { TZ: 'UTC', DATABASE_URL: DB }; // UTC is what the Vercel function runs with

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', environment: 'node', include: ['tests/server/**/*.test.ts'], env: serverEnv,
                setupFiles: ['tests/setup.ts', 'tests/server/pure-mocks.ts'] } },
      // one fresh in-memory PGlite per file (default isolation); budget: at most three files
      { test: { name: 'db', environment: 'node', include: ['tests/db/**/*.test.ts'], env: serverEnv,
                setupFiles: ['tests/setup.ts'], testTimeout: 20_000, hookTimeout: 30_000 } },
      // the browser runs in the site's time zone
      { test: { name: 'web', environment: 'node', include: ['tests/web/**/*.test.js'], env: { TZ: 'America/Chicago', DATABASE_URL: DB },
                setupFiles: ['tests/setup.ts'] } },
      { test: { name: 'hygiene', environment: 'node', include: ['tests/hygiene.test.ts'], env: { DATABASE_URL: DB },
                setupFiles: ['tests/setup.ts'] } },
    ],
  },
});
