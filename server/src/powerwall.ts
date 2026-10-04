// Powerwall rules (docs/audit-designs/enhancements.md P1/P2; owner approved the energy_cmds scope, every rule starts in Suggest).
// Three rules, each Off, Suggest or Auto in settings.powerwall.rules (default Suggest):
//   reserve  the backup reserve for tonight, from the 48-hour battery model (learn/forecast48.ts): up to your floor when below it;
//            down toward the floor when the model shows the Powerwalls sitting at the reserve tonight while the house buys from PEC
//   storm    before a storm: 100 % for an NWS storm Warning or while Storm Watch is active, 50 % for a Watch; back to the previous
//            reserve once it has passed
//   export   the grid export rule from the tariff's export credit (learned from bills): pv_only unless PEC credits an exported kWh
//            for more than a stored one is worth at home after round-trip losses
// Suggest: the suggestion is kept, and one `approval` alert per value per day; the owner applies it (POST …/apply). Auto: applied by
// the crons (storm every 5 minutes, reserve once after 17:00 Chicago, export nightly). Every command goes through tesla/commands.ts
// (scope check, guards, hourly slot) and every outcome is in `powerwall_log`.
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { q, one, kv } from './db.js';
import { localDay, addDays, rfc3339 } from './tesla/client.js';
import { currentTariff } from './tariff.js';
import type { Tariff } from './bills.js';
import { wxGti } from './learn/wx.js';
import { forecast48, type Fc48Point } from './learn/forecast48.js';
import { fc48Inputs } from './learn/nightly.js';
import { stormNow, type StormNow } from './watch.js';
import { notify } from './notify.js';
import { RESERVE_MIN, RESERVE_MAX, RESERVE_STORM_MIN } from './appliances/guards.js';
import { setBackupReserve, setGridExportRule, teslaScopes, logPowerwall, type CommandKind, type CommandResult, type CommandSource } from './tesla/commands.js';

export const PW_RULES = ['reserve', 'storm', 'export'] as const;
export type PwRule = typeof PW_RULES[number];
export type RuleMode = 'off' | 'suggest' | 'auto';
export const RULE_LABELS: Record<PwRule, string> = { reserve: 'Backup reserve for tonight', storm: 'Reserve before a storm', export: 'Grid export rule' };
export type Suggestion = { rule: PwRule; action: 'set' | 'none' | 'wait'; command: CommandKind; value: number | string | null; current: number | string | null; reason: string };
type Revert = { prev: number; to: number; at: number };

export const DEFAULT_FLOOR = 20;
const ceil5 = (v: number) => Math.ceil(v / 5) * 5;
const clampPct = (v: number) => Math.max(RESERVE_MIN, Math.min(RESERVE_MAX, Math.round(v)));

/** Each rule's mode from the owner's settings; anything unset or unknown is Suggest. */
export const ruleModes = (settings: Record<string, any>): Record<PwRule, RuleMode> =>
  Object.fromEntries(PW_RULES.map(r => { const m = settings.powerwall?.rules?.[r]; return [r, m === 'off' || m === 'auto' || m === 'suggest' ? m : 'suggest']; })) as Record<PwRule, RuleMode>;
/** The reserve floor the owner wants for backup (settings.powerwall.reserveFloorPct, 10–100, default 20). */
export const reserveFloor = (settings: Record<string, any>) => { const f = Number(settings.powerwall?.reserveFloorPct); return Number.isFinite(f) ? clampPct(f) : DEFAULT_FLOOR; };

/* ---------- the three rules, pure ---------- */
/**
 * Tonight's reserve. `points` is the 48-hour model run at the current reserve from now; the next 18 hours are "tonight". Below the
 * floor → up to the floor. When the model has the Powerwalls held at the reserve while the house buys ≥ 0.5 kWh, lower the reserve
 * (not below the floor) by enough to cover it, in 5 % steps. The storm rule wins while a storm or its revert is pending.
 */
export function reserveAdvice(o: { current: number | null; floor: number; capKwh: number; points: Fc48Point[] | null; stormHold: boolean }): Omit<Suggestion, 'rule' | 'command'> {
  const cur = o.current;
  if (o.stormHold) return { action: 'none', value: null, current: cur, reason: 'The storm rule is holding the reserve until the storm has passed.' };
  if (cur == null) return { action: 'wait', value: null, current: null, reason: 'The current reserve is unknown until Tesla site info is synced.' };
  if (cur < o.floor) return { action: 'set', value: o.floor, current: cur, reason: `The reserve is below your ${o.floor}% floor; ${o.floor}% keeps about ${Math.round(o.floor / 100 * o.capKwh * 10) / 10} kWh for an outage.` };
  if (!o.points?.length) return { action: 'wait', value: null, current: cur, reason: 'Waiting for the 48-hour battery model (weather and a few days of history).' };
  const night = o.points.filter(p => p.k >= 1 && p.k <= 18);
  const low = Math.min(...night.map(p => p.soc * 100)), atReserve = night.filter(p => p.soc * 100 <= cur + .5);
  const buys = atReserve.reduce((a, p) => a + Math.max(0, p.g), 0);
  if (buys >= .5 && cur > o.floor) {
    const to = Math.max(o.floor, cur - ceil5(buys / o.capKwh * 100));
    const hour = atReserve[0]?.t.slice(11, 16);
    if (to < cur) return { action: 'set', value: to, current: cur, reason: `Tonight the Powerwalls reach the ${cur}% reserve around ${hour} and the house would buy about ${Math.round(buys * 10) / 10} kWh from PEC before the sun is back; ${to}% lets them carry it and still keeps ${Math.round(to / 100 * o.capKwh * 10) / 10} kWh for an outage.` };
  }
  return { action: 'none', value: null, current: cur, reason: buys >= .5 ? `The Powerwalls reach the ${cur}% reserve tonight, which is already your floor.` : `Tonight's low is about ${Math.round(low)}%, above the ${cur}% reserve: no change needed.` };
}

/** Before a storm: 100 % for a Warning or active Storm Watch, 50 % for a Watch; afterwards, back to the reserve it replaced. */
export function stormAdvice(o: { current: number | null; storm: Pick<StormNow, 'alerts' | 'warning' | 'watch' | 'stormWatchActive'>; revert: Revert | null }): Omit<Suggestion, 'rule' | 'command'> & { revert?: 'store' | 'clear' } {
  const cur = o.current, s = o.storm, event = s.alerts.find(a => /warning|emergency/i.test(a.event))?.event ?? s.alerts[0]?.event;
  const target = s.warning || s.stormWatchActive ? 100 : s.watch ? 50 : null;
  if (target != null) {
    const why = s.stormWatchActive && !s.warning ? 'Storm Watch is active' : `${event} for your area`;
    if (cur == null) return { action: 'wait', value: null, current: null, reason: `${why}, but the current reserve is unknown.` };
    if (cur >= target) return { action: 'none', value: null, current: cur, reason: `${why}; the reserve is already ${cur}%.` };
    return { action: 'set', value: target, current: cur, revert: 'store', reason: `${why}: raise the reserve to ${target}% so the Powerwalls are ${target === 100 ? 'full' : 'half full'} if the grid goes down. It goes back to ${cur}% once the storm has passed.` };
  }
  if (o.revert && cur === o.revert.to) return { action: 'set', value: o.revert.prev, current: cur, revert: 'clear', reason: `The storm has passed: back to your ${o.revert.prev}% reserve.` };
  return { action: 'none', value: null, current: cur, reason: 'No storm alert for your area and Storm Watch is idle.' };
}

/** The export rule from the tariff: battery_ok only when a kWh exported pays more than a kWh kept (after 10 % round-trip loss). */
export function exportAdvice(o: { current: string | null; tariff: Pick<Tariff, 'importRateAllIn' | 'exportCredit'> | null }): Omit<Suggestion, 'rule' | 'command'> {
  const t = o.tariff;
  if (!t) return { action: 'wait', value: null, current: o.current, reason: 'Waiting for a parsed PEC bill: the export credit comes from it.' };
  if (t.exportCredit == null || !(t.importRateAllIn > 0)) return { action: 'wait', value: null, current: o.current, reason: 'The last bill has no export credit to compare.' };
  const pct = Math.round(t.exportCredit / t.importRateAllIn * 100), want = t.exportCredit * .9 > t.importRateAllIn ? 'battery_ok' : 'pv_only';
  const reason = want === 'pv_only'
    ? `PEC credits an exported kWh at ${pct}% of what an imported one costs, so energy in the Powerwalls is worth more used at home: export solar only.`
    : `PEC credits an exported kWh at ${pct}% of an imported one, more than a stored kWh is worth after battery losses: let the Powerwalls export too.`;
  if (o.current === want) return { action: 'none', value: null, current: o.current, reason };
  return { action: 'set', value: want, current: o.current, reason };
}

/* ---------- inputs ---------- */
const infoOf = async (siteId: string) => (await one<{ info: any }>(`SELECT info FROM sites WHERE id = $1`, [siteId]))?.info ?? {};
const revertKey = (siteId: string) => `${siteId}:pw:stormRevert`;
/** The 48-hour model from now at the current reserve (the same inputs the nightly learning job uses), or null while it can't run. */
async function reservePoints(siteId: string, info: any, now: number): Promise<Fc48Point[] | null> {
  const today = localDay(new Date(now)), w = await wxGti(now); if (!w) return null;
  const [daily, hourly, soe] = await Promise.all([
    q<{ day: string; solar: number }>(`SELECT day, (SUM(solar_wh) / 1000.0)::float8 solar FROM energy WHERE site_id = $1 AND day >= $2 AND day <= $3 GROUP BY day`, [siteId, addDays(today, -31), today]),
    q<{ day: string; hour: number; home: number }>(`SELECT day, hour::int, (SUM(home_wh) / 1000.0)::float8 home FROM energy WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`, [siteId, addDays(today, -15)]),
    q<{ day: string; hour: number; last: number; at: number }>(`SELECT day, hour::int, ((ARRAY_AGG(soe ORDER BY epoch DESC))[1])::float8 last, MAX(epoch)::float8 at FROM soe WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`, [siteId, addDays(today, -9)]),
  ]);
  const fc = fc48Inputs(w, daily, hourly, soe, today); if (!fc.ready) return null;
  const capKwh = (info.nameplate_energy ?? 0) / 1000 || 27, maxKw = (info.nameplate_power ?? 0) / 1000 || 10;
  return forecast48({ w: fc.w, startDate: today, startHour: +rfc3339(new Date(now)).slice(11, 13), soc0: fc.soc0, yieldK: fc.yieldK, profile: fc.profile, capKwh, maxKw, reservePct: info.backup_reserve_percent ?? DEFAULT_FLOOR }).points;
}

/** One rule's suggestion now. Reads only: the database, the caches and (for the reserve) Open-Meteo through the learning layer's cache. */
export async function suggest(siteId: string, rule: PwRule, settings: Record<string, any>, now = Date.now()): Promise<Suggestion & { revert?: 'store' | 'clear' }> {
  const info = await infoOf(siteId), reserve = typeof info.backup_reserve_percent === 'number' ? info.backup_reserve_percent : null;
  if (rule === 'export') return { rule, command: 'grid_import_export', ...exportAdvice({ current: info.components?.customer_preferred_export_rule ?? null, tariff: await currentTariff(siteId) }) };
  const [storm, revert] = await Promise.all([stormNow(siteId, { now }), kv.get<Revert | null>(revertKey(siteId))]);
  if (rule === 'storm') return { rule, command: 'backup', ...stormAdvice({ current: reserve, storm, revert: revert ?? null }) };
  const capKwh = (info.nameplate_energy ?? 0) / 1000 || 27;
  const stormHold = storm.active || (!!revert && reserve === revert.to);
  const points = stormHold || reserve == null || reserve < reserveFloor(settings) ? null : await reservePoints(siteId, info, now).catch(() => null);
  return { rule, command: 'backup', ...reserveAdvice({ current: reserve, floor: Math.max(reserveFloor(settings), storm.active ? RESERVE_STORM_MIN : 0), capKwh, points, stormHold }) };
}

/** Send what a suggestion asks for (the command path checks the scope, the guards and the hourly slot). */
export async function applySuggestion(siteId: string, s: Suggestion & { revert?: 'store' | 'clear' }, source: CommandSource, now = Date.now()): Promise<CommandResult & { suggestion: Suggestion }> {
  const ctx = { source, rule: s.rule, now };
  if (s.action !== 'set' || s.value == null) {
    const reason = s.action === 'wait' ? s.reason : `nothing to apply: ${s.reason}`;
    await logPowerwall(siteId, { at: now, rule: s.rule, command: s.command, value: s.value, result: 'unchanged', reason, source });
    return { ok: false, result: 'unchanged', command: s.command, value: s.value ?? '', reason, suggestion: s };
  }
  const r = s.command === 'grid_import_export' ? await setGridExportRule(siteId, String(s.value), ctx) : await setBackupReserve(siteId, Number(s.value), ctx);
  if (r.ok && s.revert === 'store' && typeof s.current === 'number') {
    // a Watch that became a Warning (50 → 100): keep the reserve from before the storm, not the Watch's 50
    const had = await kv.get<Revert | null>(revertKey(siteId));
    await kv.set(revertKey(siteId), { prev: had && had.to === s.current ? had.prev : s.current, to: Number(s.value), at: now } satisfies Revert);
  }
  if (r.ok && s.revert === 'clear') await kv.set(revertKey(siteId), null);
  return { ...r, suggestion: s };
}

/**
 * The crons' evaluation. Off: nothing. Suggest: keep the suggestion, and when it asks for a change send one `approval` alert per
 * value per day (logged once as 'suggested'). Auto: apply it. Nothing here sends a command in Suggest.
 */
export async function evaluatePowerwall(siteId: string, settings: Record<string, any>, rules: readonly PwRule[], now = Date.now()) {
  const modes = ruleModes(settings), out: Record<string, unknown> = {};
  for (const rule of rules) {
    const mode = modes[rule];
    if (mode === 'off') { out[rule] = { mode }; continue; }
    const s = await suggest(siteId, rule, settings, now);
    await kv.set(`${siteId}:pw:suggest:${rule}`, { ...s, at: now });
    if (s.action !== 'set') { out[rule] = { mode, action: s.action }; continue; }
    if (mode === 'auto') { const r = await applySuggestion(siteId, s, 'auto', now); out[rule] = { mode, action: 'set', value: s.value, result: r.result, reason: r.reason }; continue; }
    // Suggest still asks before a storm raise, but the way back is automatic (owner, Q10 of docs/audit-2026-10.md): a raise that was
    // applied has stored its revert, and once the storm has passed that revert is sent without waiting for a tap
    if (rule === 'storm' && (s as Suggestion & { revert?: string }).revert === 'clear') {
      const r = await applySuggestion(siteId, s, 'auto', now);
      if (r.ok) await notify(siteId, 'storm', `Reserve back to ${s.value}%`, `${s.reason} Solstice set it back on its own, as it does after every storm raise.`, { rule, value: s.value }, { key: `pw:storm:revert:${s.value}:${localDay(new Date(now))}`, now, url: '/?go=v-ins' });
      out[rule] = { mode, action: 'set', value: s.value, result: r.result, reason: r.reason, autoRevert: true }; continue;
    }
    const n = await notify(siteId, 'approval', `${RULE_LABELS[rule]}: ${s.command === 'backup' ? `${s.value}%` : s.value}?`, s.reason, { rule, value: s.value, current: s.current },
      { key: `pw:${rule}:${s.value}:${localDay(new Date(now))}`, now, url: '/?go=v-ins' });
    if (n.stored) await logPowerwall(siteId, { at: now, rule, command: s.command, value: s.value, result: 'suggested', reason: s.reason, source: 'auto' });
    out[rule] = { mode, action: 'set', value: s.value, notified: n.stored };
  }
  return out;
}
const settingsNow = async () => await kv.get<Record<string, any>>('settings:owner') ?? {};
/** Every 5 minutes: the storm rule; the reserve rule once a day from 17:00 Chicago (claimed in kv). */
export async function powerwallTick(siteId: string, now = Date.now()) {
  const stamp = rfc3339(new Date(now)), today = stamp.slice(0, 10), rules: PwRule[] = ['storm'];
  if (+stamp.slice(11, 13) >= 17) {
    const claimed = await q(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE kv.value <> excluded.value RETURNING key`,
      [`${siteId}:pw:reserveDay`, JSON.stringify(today)]);
    if (claimed.length) rules.push('reserve');
  }
  return evaluatePowerwall(siteId, await settingsNow(), rules, now);
}
/** Nightly: the export rule. */
export const powerwallNightly = async (siteId: string, now = Date.now()) => evaluatePowerwall(siteId, await settingsNow(), ['export'], now);

/* ---------- routes (owner-only, mounted after requireSite) ---------- */
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const isRule = (id: string): id is PwRule => (PW_RULES as readonly string[]).includes(id);
export function powerwallRoutes(app: Express) {
  app.get('/api/tesla/scopes', wrap(async (req, res) => res.json(await teslaScopes(req.siteId!))));
  app.get('/api/powerwall/rules', wrap(async (req, res) => {
    const id = req.siteId!, settings = await settingsNow(), modes = ruleModes(settings);
    const [scope, log] = await Promise.all([teslaScopes(id),
      q(`SELECT at::float8 at, rule, command, value, result, reason, source FROM powerwall_log WHERE site_id = $1 ORDER BY at DESC, id DESC LIMIT 30`, [id])]);
    const rules = await Promise.all(PW_RULES.map(async r => ({ id: r, label: RULE_LABELS[r], mode: modes[r],
      suggestion: await suggest(id, r, settings).catch(e => ({ rule: r, action: 'wait', command: r === 'export' ? 'grid_import_export' : 'backup', value: null, current: null, reason: `Could not evaluate: ${(e as Error).message}` })),
      last: log.find(l => l.rule === r && l.result !== 'suggested') ?? null })));
    res.json({ scope: { energyCmds: scope.energyCmds, relink: scope.relink }, floorPct: reserveFloor(settings), rules, log });
  }));
  app.post('/api/powerwall/rules/:id', express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const id = String(req.params.id), mode = String(req.body?.mode ?? '');
    if (!isRule(id)) return res.status(404).json({ error: `no rule ${id.replace(/[^\w-]/g, '')}; rules are ${PW_RULES.join(', ')}` });
    if (!['off', 'suggest', 'auto'].includes(mode)) return res.status(400).json({ error: 'mode must be off, suggest or auto' });
    const s = await settingsNow(), pw = s.powerwall ?? {};
    await kv.set('settings:owner', { ...s, powerwall: { ...pw, rules: { ...(pw.rules ?? {}), [id]: mode } } });
    res.json({ ok: true, id, mode });
  }));
  app.post('/api/powerwall/rules/:id/apply', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!isRule(id)) return res.status(404).json({ error: `no rule ${id.replace(/[^\w-]/g, '')}` });
    const settings = await settingsNow(), mode = ruleModes(settings)[id];
    if (mode !== 'suggest') return res.status(409).json({ error: `the ${id} rule is ${mode === 'off' ? 'Off' : 'on Auto'}; Apply is for Suggest mode`, mode });
    const r = await applySuggestion(req.siteId!, await suggest(req.siteId!, id, settings), 'owner');
    res.status(r.ok ? 200 : r.result === 'error' ? 502 : 409).json(r);
  }));
}
