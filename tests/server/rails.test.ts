// Proves the safety rails in tests/setup.ts and tests/server/pure-mocks.ts are in force (rule 4 as code).
import { describe, it, expect } from 'vitest';
import { RemoteLogin, UnitConnection } from 'node-screenlogic';
import { neon } from '@neondatabase/serverless';
import { q, kv } from '../../server/src/db.js';
import { configured, writePoolPlan } from '../../server/src/appliances/screenlogic.js';
import { nestConfigured, setCool } from '../../server/src/appliances/nest.js';

describe('safety rails', () => {
  it('the only database is in-memory PGlite', () => {
    expect(process.env.DATABASE_URL).toBe('pglite:memory://');
  });
  it('no device, Tesla, Google, Neon or cron credentials are in the environment', () => {
    const leaked = Object.keys(process.env).filter(k => /^(TESLA_|SCREENLOGIC_|NEST_|GOOGLE_|POSTGRES_|NEON_)/.test(k)
      || ['CRON_SECRET', 'SETUP_TOKEN', 'SESSION_SECRET', 'MULTI_USER'].includes(k));
    expect(leaked).toEqual([]);
  });
  it('fetch to anything but the in-process app throws, and is recorded even if the error is swallowed', async () => {
    const log: string[] = (globalThis as any).__blockedFetches;
    expect(() => fetch('https://api.open-meteo.com/v1/forecast?latitude=0')).toThrow('unmocked fetch in test: https://api.open-meteo.com/v1/forecast');
    expect(() => fetch(new URL('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/products'))).toThrow('unmocked fetch');
    expect(() => fetch('http://localhost:8787/api/now')).toThrow('unmocked fetch');
    expect(() => fetch('http://127.0.0.1:8787/api/cron/nest')).toThrow('unmocked fetch'); // a local dev server is not the in-process app
    expect(log).toEqual(['https://api.open-meteo.com/v1/forecast', 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/products', 'http://localhost:8787/api/now',
      'http://127.0.0.1:8787/api/cron/nest']);
    log.splice(0); // deliberately tripped above; otherwise the afterEach in setup.ts fails this test
  });
  it('node-screenlogic and the Neon driver cannot be constructed', () => {
    expect(() => new RemoteLogin('any')).toThrow('node-screenlogic is blocked in tests');
    expect(() => new UnitConnection()).toThrow('node-screenlogic is blocked in tests');
    expect(() => neon('postgres://example.invalid/db')).toThrow('the Neon driver is blocked in tests');
  });
  it('pure tests cannot touch the database', () => {
    expect(() => q('SELECT 1')).toThrow('db in pure test (q)');
    expect(() => kv.get('x')).toThrow('db in pure test (kv.get)');
  });
  it('ScreenLogic and Nest are unconfigured and their writes throw', async () => {
    expect([configured(), nestConfigured()]).toEqual([false, false]);
    await expect(writePoolPlan({ pumpId: 1, speeds: [], replaceCircuits: [], schedules: [] })).rejects.toThrow('writePoolPlan in pure test');
    await expect(setCool('dev-test', 78)).rejects.toThrow('setCool in pure test');
  });
});
