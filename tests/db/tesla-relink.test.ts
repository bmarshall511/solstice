// Re-linking Tesla (server/src/tesla/auth.ts exchangeCode with expectSites): the new tokens must see a site already linked, or nothing is
// saved and the working tokens stay. In-memory PGlite; Tesla's token and products endpoints are fakes. All tokens and ids are synthetic.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { q, one, migrate } from '../../server/src/db.js';
import { config } from '../../server/src/config.js';
import { exchangeCode, OtherSiteError } from '../../server/src/tesla/auth.js';

let sites: string[] = [], products = 0;
const guard = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input);
  if (u === config.tokenUrl) return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 28800 }), { status: 200 });
  if (u.endsWith('/api/1/products')) { products++; return new Response(JSON.stringify({ response: sites.map(id => ({ energy_site_id: Number(id) })) }), { status: 200 }); }
  return guard(input as any, init);
});
const tokens = () => one<{ access_token: string; refresh_token: string }>('SELECT access_token, refresh_token FROM tesla_accounts WHERE user_id IS NULL ORDER BY id LIMIT 1');

beforeAll(async () => { process.env.TESLA_CLIENT_ID = 'test-client-id'; process.env.TESLA_CLIENT_SECRET = 'test-client-secret'; process.env.TESLA_REDIRECT_URI ??= 'https://test.invalid/auth/callback'; await migrate(); });   // synthetic
beforeEach(async () => {
  products = 0;
  await q('DELETE FROM tesla_accounts WHERE user_id IS NULL');
  await q(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'access-old', 'refresh-old', $1)`, [Date.now() + 3600e3]);
});

describe('Tesla re-link', () => {
  it('TR-1 the same account (it sees the linked site): the new tokens are saved', async () => {
    sites = ['111', '222'];
    await exchangeCode('code', null, { expectSites: ['222'] });
    expect(await tokens()).toEqual({ access_token: 'access-new', refresh_token: 'refresh-new' });
  });
  it('TR-2 a different account: refused before the save, the working tokens stay', async () => {
    sites = ['999'];
    await expect(exchangeCode('code', null, { expectSites: ['222'] })).rejects.toBeInstanceOf(OtherSiteError);
    expect(await tokens()).toEqual({ access_token: 'access-old', refresh_token: 'refresh-old' });
  });
  it('TR-3 the first link (no site yet): no check, saved as before', async () => {
    sites = ['999'];
    await exchangeCode('code', null, { expectSites: [] });
    expect([products, (await tokens())?.access_token]).toEqual([0, 'access-new']);
  });
});
