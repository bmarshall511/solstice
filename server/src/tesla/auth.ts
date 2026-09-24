import { config } from '../config.js';
import { q, one } from '../db.js';

export type TeslaTokens = { access_token: string; refresh_token: string; expires_at: number; scope?: string };

export function authorizeUrl(state: string) {
  return `${config.authorizeUrl}?${new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scopes, state, prompt_missing_scopes: 'true' })}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TeslaTokens> {
  const res = await fetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== 'string') throw new Error(`Tesla token request failed (${res.status}): ${j.error ?? ''} ${j.error_description ?? ''}`.trim());
  return { access_token: j.access_token, refresh_token: String(j.refresh_token), expires_at: Date.now() + Number(j.expires_in ?? 28800) * 1000, scope: j.scope as string | undefined };
}

/** Exchange the OAuth code and store/replace the user's Tesla account. Returns the tesla_accounts id. */
export async function exchangeCode(code: string, userId: number): Promise<number> {
  const t = await tokenRequest({ grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code, audience: config.audience, redirect_uri: config.redirectUri });
  const existing = await one<{ id: number }>('SELECT id FROM tesla_accounts WHERE user_id = $1', [userId]);
  if (existing) { await q('UPDATE tesla_accounts SET access_token=$2, refresh_token=$3, expires_at=$4, scope=$5 WHERE id=$1', [existing.id, t.access_token, t.refresh_token, t.expires_at, t.scope]); return existing.id; }
  return (await one<{ id: number }>('INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at, scope) VALUES ($1,$2,$3,$4,$5) RETURNING id', [userId, t.access_token, t.refresh_token, t.expires_at, t.scope]))!.id;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A valid access token for a Tesla account. Refresh tokens are single-use, so only one serverless instance
 * may refresh at a time: whoever claims `refreshing_until` refreshes; the others wait and re-read.
 */
export async function accessToken(accountId: number, force = false): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = await one<{ access_token: string; refresh_token: string; expires_at: string }>('SELECT access_token, refresh_token, expires_at FROM tesla_accounts WHERE id = $1', [accountId]);
    if (!a) throw new Error('Tesla account not connected');
    if (!force && Number(a.expires_at) - Date.now() > 60_000) return a.access_token;
    const claimed = await one('UPDATE tesla_accounts SET refreshing_until = $2 WHERE id = $1 AND (refreshing_until IS NULL OR refreshing_until < $3) RETURNING id', [accountId, Date.now() + 20_000, Date.now()]);
    if (claimed) {
      try {
        const t = await tokenRequest({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: a.refresh_token });
        await q('UPDATE tesla_accounts SET access_token=$2, refresh_token=$3, expires_at=$4, refreshing_until=NULL WHERE id=$1', [accountId, t.access_token, t.refresh_token, t.expires_at]);
        return t.access_token;
      } catch (e) { await q('UPDATE tesla_accounts SET refreshing_until = NULL WHERE id = $1', [accountId]); throw e; }
    }
    force = false;
    await sleep(700); // someone else is refreshing
  }
  throw new Error('Timed out waiting for Tesla token refresh');
}
