// Powerwall commands through the Fleet API (scope energy_cmds; docs/fleet-api-energy-research.md §2.7, all POST and "not charged"):
//   backup              {backup_reserve_percent}                   setBackupReserve
//   operation           {default_real_mode}                        setOperationMode
//   grid_import_export  {customer_preferred_export_rule}           setGridExportRule
// Every path, in order: the stored token must carry energy_cmds (else `scope_missing` and nothing is sent); the value must differ from
// what site_info says (else `unchanged`); the safety guard (appliances/guards.ts) must allow it; the hourly slot for that setting is
// claimed atomically in kv; only then is the command sent. Every outcome, sent or not, is a row in `powerwall_log`.
import { config } from '../config.js';
import { q, one, kv } from '../db.js';
import { accessToken } from './auth.js';
import { guardReserve, guardExportRule, guardOperationMode, PW_CHANGE_INTERVAL_MS, type Verdict } from '../appliances/guards.js';
import { stormNow } from '../watch.js';

export const ENERGY_CMDS = 'energy_cmds';
export type CommandKind = 'backup' | 'operation' | 'grid_import_export';
export type CommandSource = 'owner' | 'auto';
export type CommandOutcome = 'sent' | 'scope_missing' | 'unchanged' | 'refused' | 'no_account' | 'error';
export type CommandResult = { ok: boolean; result: CommandOutcome; command: CommandKind; value: number | string; reason: string | null };

/** The scopes on a Fleet API access token (a JWT with an `scp` array), or null when it can't be read. */
export function tokenScopes(token: string | null | undefined): string[] | null {
  const part = token?.split('.')[1]; if (!part) return null;
  try { const scp = JSON.parse(Buffer.from(part, 'base64url').toString()).scp; return Array.isArray(scp) ? scp.map(String) : typeof scp === 'string' ? scp.split(' ') : null; }
  catch { return null; }
}

/** Whether the site's Tesla token can send energy commands. The token's own `scp` claim wins; else the scope stored at consent. */
export async function teslaScopes(siteId: string) {
  const a = await one<{ id: number | null; scope: string | null; access_token: string | null }>(
    `SELECT a.id, a.scope, a.access_token FROM sites s LEFT JOIN tesla_accounts a ON a.id = s.tesla_account_id WHERE s.id = $1`, [siteId]);
  if (!a?.id) return { connected: false, scopes: [] as string[], energyCmds: false, source: 'none' as const, relink: '/auth/login' };
  const fromToken = tokenScopes(a.access_token), scopes = fromToken ?? (a.scope ?? '').split(/\s+/).filter(Boolean);
  const energyCmds = scopes.includes(ENERGY_CMDS);
  return { connected: true, scopes, energyCmds, source: fromToken ? 'token' as const : a.scope ? 'stored' as const : 'none' as const, relink: energyCmds ? null : '/auth/login' };
}

type Ctx = { source: CommandSource; rule?: string | null; now?: number };
const lastKey = (siteId: string, kind: CommandKind) => `${siteId}:pw:last:${kind}`;
export const lastChange = async (siteId: string, kind: CommandKind) => (await kv.get<{ at: number } | null>(lastKey(siteId, kind)))?.at ?? null;
/** Take the setting's hourly slot: succeeds only when no change is recorded in the last hour, even when two invocations race. */
async function claim(siteId: string, kind: CommandKind, value: unknown, now: number) {
  const rows = await q(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE COALESCE((kv.value->>'at')::float8, 0) <= $3 RETURNING key`, [lastKey(siteId, kind), JSON.stringify({ at: now, value }), now - PW_CHANGE_INTERVAL_MS]);
  return rows.length === 1;
}
export async function logPowerwall(siteId: string, e: { at: number; rule?: string | null; command: string; value: unknown; result: string; reason: string | null; source: string }) {
  await q(`INSERT INTO powerwall_log (site_id, at, rule, command, value, result, reason, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [siteId, e.at, e.rule ?? null, e.command, JSON.stringify(e.value), e.result, e.reason, e.source]);
}

async function send(siteId: string, kind: CommandKind, value: number | string, ctx: Ctx, o: {
  current: (info: any) => unknown; check: (last: number | null, now: number) => Promise<Verdict<unknown>>; body: Record<string, unknown>; patch: (info: any) => any;
}): Promise<CommandResult> {
  const now = ctx.now ?? Date.now();
  const done = async (result: CommandOutcome, reason: string | null): Promise<CommandResult> => {
    await logPowerwall(siteId, { at: now, rule: ctx.rule, command: kind, value, result, reason, source: ctx.source });
    return { ok: result === 'sent', result, command: kind, value, reason };
  };
  const site = await one<{ tesla_account_id: number | null; info: any }>(`SELECT tesla_account_id, info FROM sites WHERE id = $1`, [siteId]);
  if (!site?.tesla_account_id) return done('no_account', 'no Tesla account is connected for this site');
  if (!(await teslaScopes(siteId)).energyCmds)
    return done('scope_missing', 'the Tesla token lacks the energy_cmds scope: open /auth/login once to approve Powerwall settings; nothing was sent');
  if (o.current(site.info ?? {}) === value) return done('unchanged', `already ${value}`);
  const g = await o.check(await lastChange(siteId, kind), now);
  if (!g.ok) return done('refused', g.reason);
  if (!(await claim(siteId, kind, value, now))) return done('refused', 'another change to this setting was just made; one per hour');
  try {
    const r = await fetch(`${config.audience}/api/1/energy_sites/${siteId}/${kind}`, { method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${await accessToken(site.tesla_account_id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(o.body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; return done('error', `Tesla answered HTTP ${r.status}${j.error ? `: ${j.error}` : ''}`); }
  } catch (e) { return done('error', (e as Error).message); }
  // keep the stored site_info in step until the next sync re-reads it
  await q(`UPDATE sites SET info = $2 WHERE id = $1`, [siteId, JSON.stringify(o.patch(structuredClone(site.info ?? {})))]);
  return done('sent', null);
}

/** Backup reserve, 10–100 %, never below 20 % in a storm, one change an hour. */
export const setBackupReserve = (siteId: string, pct: number, ctx: Ctx) => send(siteId, 'backup', pct, ctx, {
  current: info => info.backup_reserve_percent,
  check: async (last, now) => guardReserve({ pct, storm: (await stormNow(siteId, { now })).active, lastChangeAt: last, now }),
  body: { backup_reserve_percent: pct },
  patch: info => ({ ...info, backup_reserve_percent: pct }),
});
/** Operation mode (self_consumption | autonomous). No rule sends it automatically; exposed for completeness behind the same checks. */
export const setOperationMode = (siteId: string, mode: string, ctx: Ctx) => send(siteId, 'operation', mode, ctx, {
  current: info => info.default_real_mode,
  check: async (last, now) => guardOperationMode({ mode, lastChangeAt: last, now }),
  body: { default_real_mode: mode },
  patch: info => ({ ...info, default_real_mode: mode }),
});
/** Grid export rule, battery_ok or pv_only only. */
export const setGridExportRule = (siteId: string, rule: string, ctx: Ctx) => send(siteId, 'grid_import_export', rule, ctx, {
  current: info => info.components?.customer_preferred_export_rule,
  check: async (last, now) => guardExportRule({ rule, lastChangeAt: last, now }),
  body: { customer_preferred_export_rule: rule },
  patch: info => ({ ...info, components: { ...(info.components ?? {}), customer_preferred_export_rule: rule } }),
});
