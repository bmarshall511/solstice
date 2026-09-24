import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { kv } from '../db.ts';

type Tokens = { access_token: string; refresh_token: string; expires_at: number; scope?: string };

const pendingStates = new Set<string>();

export function loginUrl(): string {
  const state = randomBytes(16).toString('hex');
  pendingStates.add(state);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    prompt_missing_scopes: 'true',
  });
  return `${config.authorizeUrl}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new Error(`Token request failed (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
  }
  const tokens: Tokens = {
    access_token: json.access_token,
    refresh_token: String(json.refresh_token),
    expires_at: Date.now() + Number(json.expires_in ?? 28800) * 1000,
    scope: json.scope as string | undefined,
  };
  kv.set('tesla.tokens', tokens); // refresh tokens are single-use: always persist the newest one
  return tokens;
}

export async function handleCallback(code: string, state: string): Promise<void> {
  if (!pendingStates.delete(state)) throw new Error('Unknown or expired sign-in state. Start again from /auth/login.');
  await tokenRequest({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    audience: config.audience,
    redirect_uri: config.redirectUri,
  });
}

let refreshing: Promise<Tokens> | null = null;

export async function accessToken(force = false): Promise<string> {
  const tokens = kv.get<Tokens>('tesla.tokens');
  if (!tokens) throw new Error('Not connected to Tesla yet. Open /auth/login.');
  if (!force && tokens.expires_at - Date.now() > 60_000) return tokens.access_token;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: tokens.refresh_token })
    .finally(() => { refreshing = null; });
  return (await refreshing).access_token;
}

export const isConnected = () => kv.get<Tokens>('tesla.tokens') !== undefined;
