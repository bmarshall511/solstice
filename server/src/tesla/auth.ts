import { config } from '../config.js';
import { q, one } from '../db.js';

export type TeslaTokens = { access_token: string; refresh_token: string; expires_at: number; scope?: string };

export function authorizeUrl(state: string) {
  return `${config.authorizeUrl}?${new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scopes, state, prompt_missing_scopes: 'true' })}`;
}

/** Tesla's token endpoint answers in well under a second; 8 s is far inside the 20 s refresh lock, so a slow call can't outlive it. */
export const TOKEN_TIMEOUT_MS = 8_000, REFRESH_LOCK_MS = 20_000;
async function tokenRequest(body: Record<string, string>): Promise<TeslaTokens> {
  const res = await fetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== 'string') throw new Error(`Tesla token request failed (${res.status}): ${j.error ?? ''} ${j.error_description ?? ''}`.trim());
  return { access_token: j.access_token, refresh_token: String(j.refresh_token), expires_at: Date.now() + Number(j.expires_in ?? 28800) * 1000, scope: j.scope as string | undefined };
}

/** Exchange the OAuth code and store/replace the user's Tesla account. Returns the tesla_accounts id. */
export async function exchangeCode(code: string, userId: number | null): Promise<number> {
  const t = await tokenRequest({ grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code, audience: config.audience, redirect_uri: config.redirectUri });
  const existing = await one<{ id: number }>('SELECT id FROM tesla_accounts WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY id LIMIT 1', [userId]);
  if (existing) { await q('UPDATE tesla_accounts SET access_token=$2, refresh_token=$3, expires_at=$4, scope=$5 WHERE id=$1', [existing.id, t.access_token, t.refresh_token, t.expires_at, t.scope]); return existing.id; }
  return (await one<{ id: number }>('INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at, scope) VALUES ($1,$2,$3,$4,$5) RETURNING id', [userId, t.access_token, t.refresh_token, t.expires_at, t.scope]))!.id;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A valid access token for a Tesla account. Refresh tokens are single-use, so only one serverless instance may refresh at a time:
 * whoever claims `refreshing_until` refreshes; the others wait and re-read. The claim returns the row as it is at that moment, so the
 * refresh always uses the newest refresh token (reading it before the claim could replay one another instance had just used), and an
 * instance that finds the token renewed since it decided to refresh hands that one back instead of refreshing again.
 * `stale`: the access token Tesla just refused (401), to refresh past it; without it, an unexpired token is used as is.
 */
export async function accessToken(accountId: number, stale: string | null = null): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = await one<{ access_token: string; expires_at: string }>('SELECT access_token, expires_at FROM tesla_accounts WHERE id = $1', [accountId]);
    if (!a) throw new Error('Tesla account not connected');
    const fresh = (r: { access_token: string; expires_at: string }) => Number(r.expires_at) - Date.now() > 60_000 && r.access_token !== stale;
    if (fresh(a)) return a.access_token;
    const now = Date.now();
    const c = await one<{ access_token: string; refresh_token: string; expires_at: string }>(`UPDATE tesla_accounts SET refreshing_until = $2 WHERE id = $1 AND (refreshing_until IS NULL OR refreshing_until < $3)
      RETURNING access_token, refresh_token, expires_at`, [accountId, now + REFRESH_LOCK_MS, now]);
    if (c) {
      if (fresh(c)) { await q('UPDATE tesla_accounts SET refreshing_until = NULL WHERE id = $1', [accountId]); return c.access_token; }   // renewed meanwhile
      let t: TeslaTokens;
      try { t = await tokenRequest({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: c.refresh_token }); }
      catch (e) { await q('UPDATE tesla_accounts SET refreshing_until = NULL WHERE id = $1', [accountId]); throw e; }
      // Tesla has now spent the old refresh token: the new pair must be saved, or the account needs relinking. Retry the write.
      for (let i = 0; ; i++) {
        try { await q('UPDATE tesla_accounts SET access_token=$2, refresh_token=$3, expires_at=$4, refreshing_until=NULL WHERE id=$1', [accountId, t.access_token, t.refresh_token, t.expires_at]); break; }
        catch (e: any) {
          if (i >= 2) { console.error(`[solstice] CRITICAL: Tesla returned new tokens but saving them failed 3 times (${e?.message ?? e}); the Tesla link will need relinking`); throw e; }
          await sleep(400 * 3 ** i);
        }
      }
      return t.access_token;
    }
    await sleep(700); // someone else is refreshing
  }
  throw new Error('Timed out waiting for Tesla token refresh');
}
