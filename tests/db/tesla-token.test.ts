// Tesla token refresh (server/src/tesla/auth.ts): refresh tokens are single-use, so a refresh must use the newest one, never refresh
// over a token another instance just renewed, and keep retrying the save of a new pair Tesla has already issued. In-memory PGlite;
// the token endpoint is a fake that records every refresh token it is given. All tokens are synthetic.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { q, one, migrate } from '../../server/src/db.js';
import { config } from '../../server/src/config.js';
import { accessToken } from '../../server/src/tesla/auth.js';

const sent: string[] = [];
let issue = 1;
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input) === config.tokenUrl) {
    const rt = new URLSearchParams(String(init?.body)).get('refresh_token')!; sent.push(rt);
    const n = issue++;
    return new Response(JSON.stringify({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 28800 }), { status: 200 });
  }
  return guard(input as any, init);
});
const row = () => one<{ access_token: string; refresh_token: string; refreshing_until: string | null }>('SELECT access_token, refresh_token, refreshing_until FROM tesla_accounts WHERE id = 9');

beforeAll(async () => { process.env.TESLA_CLIENT_ID = 'test-client-id'; await migrate(); });   // synthetic
beforeEach(async () => {
  sent.length = 0; issue = 1;
  await q('DELETE FROM tesla_accounts WHERE id = 9');
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (9, NULL, 'access-0', 'refresh-0', $1)`, [Date.now() - 1000]);
});

describe('Tesla token refresh', () => {
  it('TT-1 an expired token is refreshed once with the stored refresh token, and the new pair is saved', async () => {
    expect(await accessToken(9)).toBe('access-1');
    expect(sent).toEqual(['refresh-0']);
    expect(await row()).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1', refreshing_until: null });
    expect(await accessToken(9)).toBe('access-1');                         // still fresh: no second refresh
    expect(sent).toHaveLength(1);
  });
  it('TT-2 ten instances at once refresh exactly once and all get the new token', async () => {
    const got = await Promise.all(Array.from({ length: 10 }, () => accessToken(9)));
    expect(new Set(got)).toEqual(new Set(['access-1']));
    expect(sent).toEqual(['refresh-0']);
  });
  it('TT-3 a 401 refreshes past the refused token, but not past one another instance already renewed', async () => {
    await accessToken(9);                                                  // access-1
    expect(await accessToken(9, 'access-1')).toBe('access-2');             // Tesla refused access-1
    expect(sent).toEqual(['refresh-0', 'refresh-1']);
    expect(await accessToken(9, 'access-1')).toBe('access-2');             // a late 401 for the old token: access-2 is already newer
    expect(sent).toHaveLength(2);
  });
  it('TT-4 a token endpoint that hangs fails inside the refresh lock and releases it', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => String(input) === config.tokenUrl
      ? new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('timed out', 'TimeoutError')))) : guard(input as any, init));
    await expect(accessToken(9)).rejects.toThrow(/timed out/);
    expect((await row())!.refreshing_until).toBeNull();
    expect((await row())!.refresh_token).toBe('refresh-0');               // nothing was spent, so nothing is lost
  }, 15_000);
});
