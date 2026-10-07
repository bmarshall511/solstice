// S-13: the Nest Pub/Sub push's hardening, pure parts. A token must be issued (iat) within 10 minutes; an event's time is clamped
// to at most a minute ahead of now; an unknown signing key refetches Google's certs at most once a minute per instance.
// The route-level checks are NE-7 in nest-events.test.ts. Google's certs endpoint is a counting fake; keys are generated here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'hard-kid', alg: 'RS256' };
const AUD = 'https://app.invalid/api/nest/events', SA = 'nest-push@test-project.iam.gserviceaccount.com';
const jwt = (claims: Record<string, unknown>, kid = 'hard-kid') => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc({ iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, iat: now, exp: now + 3600, ...claims })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
};
let certFetches = 0;
vi.stubGlobal('fetch', async (input: string | URL | Request) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u === 'https://www.googleapis.com/oauth2/v3/certs') { certFetches++; return new Response(JSON.stringify({ keys: [JWK] }), { status: 200 }); }
  throw new Error(`unexpected fetch ${u}`);
});
const fresh = async () => { vi.resetModules(); return import('../../server/src/appliances/nestEvents.js'); };   // a new instance: no cached certs
beforeEach(() => { certFetches = 0; });

describe('S-13 Nest push hardening', () => {
  it('NH-1 a token issued over 10 minutes ago, or with no iat, or from the future, is refused; a fresh one passes', async () => {
    const { oidcError } = await fresh(), o = { audience: AUD, email: SA, keys: [JWK] }, now = Math.floor(Date.now() / 1000);
    expect(await oidcError(jwt({}), o)).toBeNull();
    expect(await oidcError(jwt({ iat: now - 9 * 60 }), o)).toBeNull();
    expect(await oidcError(jwt({ iat: now - 11 * 60 }), o)).toBe('stale token');   // still inside its hour (exp), but too old to be a push
    expect(await oidcError(jwt({ iat: undefined }), o)).toBe('stale token');
    expect(await oidcError(jwt({ iat: now + 3600 }), o)).toBe('stale token');
  });

  it('NH-2 an event time is clamped to a minute ahead of now; a missing or bad one is now', async () => {
    const { eventTime } = await fresh(), now = Date.parse('2026-07-01T12:00:00Z');
    expect(eventTime('2026-07-01T11:59:00Z', now)).toBe(now - 60_000);
    expect(eventTime('2026-07-01T12:00:30Z', now)).toBe(now + 30_000);
    expect(eventTime('2026-07-02T12:00:00Z', now)).toBe(now + 60_000);
    expect(eventTime('2099-01-01T00:00:00Z', now)).toBe(now + 60_000);
    expect(eventTime(undefined, now)).toBe(now);
    expect(eventTime('not a date', now)).toBe(now);
  });

  it('NH-3 two tokens with unknown kids within a minute fetch Google’s certs once; after a minute one more refetch is allowed', async () => {
    const { oidcError, JWKS_REFETCH_MS } = await fresh(), o = { audience: AUD, email: SA };
    expect(await oidcError(jwt({}, 'made-up-1'), o)).toBe('unknown signing key');
    expect(await oidcError(jwt({}, 'made-up-2'), o)).toBe('unknown signing key');
    expect(certFetches).toBe(1);
    expect(await oidcError(jwt({}), o)).toBeNull();                                    // the known key is served from the cache
    expect(certFetches).toBe(1);
    vi.useFakeTimers({ now: Date.now() + JWKS_REFETCH_MS + 1_000, toFake: ['Date'] });
    try {
      expect(await oidcError(jwt({}, 'made-up-3'), o)).toBe('unknown signing key');
      expect(certFetches).toBe(2);
      expect(await oidcError(jwt({}, 'made-up-4'), o)).toBe('unknown signing key');
      expect(certFetches).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});
