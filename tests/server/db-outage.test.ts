// A database the host has suspended (Neon's spent monthly quota, 2026-11-19 to 12-01) or can't reach names itself: 503 with a
// plain sentence for everyone, never "internal error". Ordinary query errors stay 500s.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rootCertificates } from 'node:tls';

const outage = vi.hoisted(() => ({ kind: null as null | 'quota' | 'unreachable' }));
vi.mock(import('../../server/src/db.js'), async importOriginal => {
  const real = await importOriginal();
  return { ...real, migrate: vi.fn(async () => { if (outage.kind) throw new real.DbUnavailableError(outage.kind, new Error('driver')); }) };
});

const { dbOutage, DbUnavailableError, pgConfig } = await import('../../server/src/db.js');
const { app } = await import('../../server/src/app.js');

/** The text Neon's serverless driver throws for each case, as seen in the production log. */
const NEON_QUOTA = 'Server error (HTTP status 402): {"message":"Your account or project has exceeded the quota. Upgrade your plan to increase limits.","code":""}';

describe('dbOutage', () => {
  it('names a spent quota', () => {
    expect(dbOutage(new Error(NEON_QUOTA))).toBe('quota');
  });
  it('names a database it cannot reach, from the error or its cause', () => {
    expect(dbOutage(new TypeError('fetch failed'))).toBe('unreachable');
    expect(dbOutage(Object.assign(new Error('request failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }))).toBe('unreachable');
    expect(dbOutage(new Error('Server error (HTTP status 503): busy'))).toBe('unreachable');
    // Neon's wrapper for any failed connection, with the network error in `sourceError`
    expect(dbOutage(Object.assign(new Error('Error connecting to database: TypeError: fetch failed'), { sourceError: new TypeError('fetch failed') }))).toBe('unreachable');
    expect(dbOutage(Object.assign(new Error('wrapped'), { sourceError: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }))).toBe('unreachable');
  });
  it('reads node-postgres SQLSTATE codes from `code`, never from digits in a message', () => {
    const pgErr = (code: string, message = 'x') => Object.assign(new Error(message), { code });
    expect(dbOutage(pgErr('25006', 'cannot execute INSERT in a read-only transaction'))).toBe('quota');   // a host over its size limit
    expect(dbOutage(pgErr('53100'))).toBe('quota');
    for (const c of ['08006', '08P01', '53300', '57P01', '57P03', 'ECONNREFUSED']) expect(dbOutage(pgErr(c)), c).toBe('unreachable');
    expect(dbOutage(new Error('timeout exceeded when trying to connect'))).toBe('unreachable');   // pg's pool
    expect(dbOutage(pgErr('23505', 'duplicate key 25006 08006'))).toBeNull();
  });
  it('leaves ordinary query errors alone', () => {
    expect(dbOutage(new Error('relation "nope" does not exist'))).toBeNull();
    expect(dbOutage(new Error('duplicate key value violates unique constraint'))).toBeNull();
    expect(dbOutage('not an error')).toBeNull();
  });
  it('keeps the driver error as the cause, for the log', () => {
    const cause = new Error(NEON_QUOTA);
    expect(new DbUnavailableError('quota', cause).cause).toBe(cause);
  });
});

describe('pgConfig', () => {
  const URL_ = 'postgres://user:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x';
  it('verifies TLS itself and drops the URL’s sslmode and host-specific parameters', () => {
    const c = pgConfig(URL_, undefined);
    expect(c.connectionString).toBe('postgres://user:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
  });
  it('trusts the host’s CA besides the system roots, with escaped newlines restored', () => {
    const ssl = pgConfig(URL_, '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----').ssl as { rejectUnauthorized: boolean; ca: string[] };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca.at(-1)).toBe('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
    // Node's `ca` replaces the default store, so the system roots must be in the list too (Neon's public certificate)
    expect(ssl.ca.slice(0, -1)).toEqual([...rootCertificates]);
    expect(ssl.ca.length).toBeGreaterThan(100);
  });
  it('turns TLS off only for sslmode=disable', () => {
    expect(pgConfig('postgres://u:p@localhost:5432/db?sslmode=disable', undefined).ssl).toBe(false);
  });
  it('keeps a small pool that lets idle sockets go', () => {
    expect(pgConfig(URL_, undefined)).toMatchObject({ max: 3, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
  });
});

describe('the API during an outage', () => {
  let server: Server, base = '';
  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    (globalThis as any).__testServerPorts.add(port);   // tests/setup.ts lets fetch reach only the in-process app
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => { outage.kind = null; delete process.env.DB_MAINTENANCE; server.close(); });

  it('answers 503 with the quota sentence on the anonymous boot call, not "internal error"', async () => {
    outage.kind = 'quota';
    const r = await fetch(`${base}/api/auth/me`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('3600');
    const j = await r.json();
    expect(j).toMatchObject({ error: 'Database unavailable: it has reached its plan’s limit.', reason: 'db_quota' });
    expect(JSON.stringify(j)).not.toMatch(/internal error|402|neon/i);
  });
  it('answers 503 with the unreachable sentence on any route', async () => {
    outage.kind = 'unreachable';
    const r = await fetch(`${base}/api/status`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(await r.json()).toMatchObject({ error: 'Database unavailable: it can’t be reached right now.', reason: 'db_unreachable' });
  });
  it('DB_MAINTENANCE answers 503 on every route, crons and ingest included, before touching the database', async () => {
    outage.kind = null;
    process.env.DB_MAINTENANCE = '1';
    const { migrate } = await import('../../server/src/db.js');
    vi.mocked(migrate).mockClear();
    const auth = { authorization: 'Bearer not-checked' };
    for (const [method, path] of [['GET', '/api/auth/me'], ['GET', '/api/cron/nest'], ['GET', '/api/cron/pool'], ['GET', '/api/cron/sync'], ['POST', '/api/pvs/readings'], ['POST', '/api/nest/events']]) {
      const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...auth }, body: method === 'POST' ? '{}' : undefined });
      expect(r.status, path).toBe(503);
      expect(await r.json(), path).toMatchObject({ reason: 'db_maintenance' });
    }
    expect(migrate).not.toHaveBeenCalled();
    delete process.env.DB_MAINTENANCE;
  });
});
