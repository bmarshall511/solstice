// A database the host has suspended (Neon's spent monthly quota, 2026-11-19 to 12-01) or can't reach names itself: 503 with a
// plain sentence for everyone, never "internal error". Ordinary query errors stay 500s.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const outage = vi.hoisted(() => ({ kind: null as null | 'quota' | 'unreachable' }));
vi.mock(import('../../server/src/db.js'), async importOriginal => {
  const real = await importOriginal();
  return { ...real, migrate: vi.fn(async () => { if (outage.kind) throw new real.DbUnavailableError(outage.kind, new Error('driver')); }) };
});

const { dbOutage, DbUnavailableError } = await import('../../server/src/db.js');
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

describe('the API during an outage', () => {
  let server: Server, base = '';
  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    (globalThis as any).__testServerPorts.add(port);   // tests/setup.ts lets fetch reach only the in-process app
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => { outage.kind = null; server.close(); });

  it('answers 503 with the quota sentence on the anonymous boot call, not "internal error"', async () => {
    outage.kind = 'quota';
    const r = await fetch(`${base}/api/auth/me`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('3600');
    const j = await r.json();
    expect(j).toMatchObject({ error: 'Database unavailable: its monthly usage limit is reached.', reason: 'db_quota' });
    expect(JSON.stringify(j)).not.toMatch(/internal error|402|neon/i);
  });
  it('answers 503 with the unreachable sentence on any route', async () => {
    outage.kind = 'unreachable';
    const r = await fetch(`${base}/api/status`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(await r.json()).toMatchObject({ error: 'Database unavailable: it can’t be reached right now.', reason: 'db_unreachable' });
  });
});
