// What the crons watch for the alerts feed (notify.ts). Read-only towards every device: Tesla live_status (a read), the NWS and ERCOT
// feeds, the database. Each step runs on its own and a failure is reported, never thrown.
//   every 5 minutes (/api/cron/nest)  NWS storm alerts, the Storm Watch edge (storm_mode_active false → true), the ERCOT level edge
//   nightly (/api/cron/sync)          the "your PEC bill should be ready" check, and the anomalies the learning job just opened
import { q, one, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';
import { refreshLive } from './sync.js';
import { listBills } from './bills.js';
import { nwsAlerts, type NwsAlert } from './outage.js';
import { notify, notifyAnomalies, type NotifyResult } from './notify.js';

/** NWS events that threaten the house or the grid feeding it. Any Severe or Extreme alert counts too. */
export const STORM_EVENTS = /(severe thunderstorm|tornado|winter storm|ice storm|blizzard|extreme cold|hard freeze|hurricane|tropical storm|high wind)/i;
/** Severe or Extreme alerts that are not about the weather hitting the house: heat, fire weather, air quality, dust, fog, frost. ERCOT's
 *  own conservation calls cover heat strain on the grid, so these never raise the reserve (a heat wave held it at 100% for days). */
export const NOT_STORM_EVENTS = /(heat|red flag|fire weather|fire warning|air quality|air stagnation|dust|smoke|fog|frost|beach|rip current|small craft)/i;
export const isStormAlert = (a: Pick<NwsAlert, 'event' | 'severity'>) => STORM_EVENTS.test(a.event) || (/^(severe|extreme)$/i.test(a.severity ?? '') && !NOT_STORM_EVENTS.test(a.event));
export const isWarning = (a: Pick<NwsAlert, 'event'>) => /warning|emergency/i.test(a.event);

export type StormNow = { alerts: NwsAlert[]; warning: boolean; watch: boolean; stormWatchEnabled: boolean | null; stormWatchActive: boolean; soc: number | null; active: boolean };
/**
 * The storm state from what is already stored: the NWS cache (kv 'nws', at most 2 h old unless `fetchNws` refreshes it), the latest
 * live reading (storm_mode_active, at most 30 min old) and site_info's Storm Watch switch. `active`: a storm alert or Storm Watch charging.
 */
export async function stormNow(siteId: string, o: { now?: number; fetchNws?: boolean } = {}): Promise<StormNow> {
  const now = o.now ?? Date.now();
  let alerts: NwsAlert[] = [];
  if (o.fetchNws) alerts = await nwsAlerts().catch(() => []);
  else { const hit = await kv.get<{ at: number; alerts: NwsAlert[] }>('nws'); if (hit && now - hit.at < 2 * 3600e3) alerts = hit.alerts ?? []; }
  const storms = alerts.filter(isStormAlert);
  const [r, s] = await Promise.all([
    one<{ ts: string; soc: number; storm_mode_active: boolean }>('SELECT ts, soc, storm_mode_active FROM readings WHERE site_id = $1 ORDER BY ts DESC LIMIT 1', [siteId]),
    one<{ info: any }>('SELECT info FROM sites WHERE id = $1', [siteId])]);
  const fresh = r && now - Number(r.ts) < 30 * 60_000;
  const stormWatchActive = !!(fresh && r!.storm_mode_active);
  return { alerts: storms, warning: storms.some(isWarning), watch: storms.some(a => !isWarning(a)), stormWatchEnabled: s?.info?.user_settings?.storm_mode_enabled ?? null,
    stormWatchActive, soc: fresh ? r!.soc : null, active: storms.length > 0 || stormWatchActive };
}

/** Every 5 minutes: a push for each new storm alert, and one when Storm Watch starts charging the Powerwalls. */
export async function stormWatch(siteId: string, now = Date.now()) {
  await refreshLive(siteId).catch(() => {});   // live_status is a read (and cached 25 s); a failure leaves the last reading
  const st = await stormNow(siteId, { now, fetchNws: true }), out: NotifyResult[] = [];
  const pw = `Powerwalls ${st.soc != null ? `${Math.round(st.soc)}%` : 'at an unknown charge'} · Storm Watch ${st.stormWatchEnabled === false ? 'off' : st.stormWatchActive ? 'charging' : 'on'}`;
  for (const a of st.alerts) out.push(await notify(siteId, 'storm', a.event, `${a.headline ?? a.event}. ${pw}.`, { event: a.event, severity: a.severity, ends: a.ends },
    { key: `nws:${a.event}:${a.ends ?? ''}`, windowH: 48, now, url: '/?go=v-sys&p=home' }));
  const key = `${siteId}:storm:active`, prev = !!(await kv.get<boolean>(key));
  if (st.stormWatchActive !== prev) {
    await kv.set(key, st.stormWatchActive);
    if (st.stormWatchActive) out.push(await notify(siteId, 'storm', 'Storm Watch is charging the Powerwalls',
      `Tesla's Storm Watch switched on ahead of severe weather. ${pw}.`, { stormWatch: true }, { key: `stormwatch:${localDay(new Date(now))}`, windowH: 12, now, url: '/?go=v-sys&p=powerwall' }));
  }
  return { alerts: st.alerts.length, stormWatchActive: st.stormWatchActive, notified: out.filter(r => r.stored).length };
}

/* ---------- ERCOT (informational: PEC bills a flat rate, so this is about grid stress, never the bill) ---------- */
export type ErcotData = { condition: string | null; title: string | null; note: string | null; eea: number; demandMw: number | null; capacityMw: number | null; at: string | null };
/** The ERCOT dashboards, cached 5 minutes in kv 'ercot' (the /api/ercot route and the 5-minute watch share it). */
export async function ercotNow(now = Date.now()): Promise<ErcotData> {
  const cached = await kv.get<{ at: number; data: ErcotData }>('ercot');
  if (cached && now - cached.at < 5 * 60_000) return cached.data;
  const [prc, sd] = await Promise.all(['daily-prc', 'supply-demand'].map(n => fetch(`https://www.ercot.com/api/1/services/read/dashboards/${n}.json`, { signal: AbortSignal.timeout(8_000) }).then(r => { if (!r.ok) throw new Error(`ERCOT ${n}: HTTP ${r.status}`); return r.json(); }))) as [any, any];
  const latest = (sd.data as any[]).filter(x => x.demand > 0).at(-1);
  const data = { condition: prc.current_condition?.state ?? null, title: prc.current_condition?.title ?? null, note: prc.current_condition?.condition_note ?? null,
    eea: prc.current_condition?.eea_level ?? 0, demandMw: latest?.demand ?? null, capacityMw: latest?.capacity ?? null, at: sd.lastUpdated };
  await kv.set('ercot', { at: now, data });
  return data;
}
export const ercotLevel = (d: Pick<ErcotData, 'condition' | 'eea'> | null) => !d ? 'unknown' : d.eea >= 1 ? `eea${d.eea}` : d.condition && d.condition !== 'normal' ? 'conservation' : 'normal';
/** Every 5 minutes: one alert when the grid leaves normal (a conservation call or an EEA level). No action is taken. */
export async function ercotWatch(siteId: string, now = Date.now()) {
  const d = await ercotNow(now), level = ercotLevel(d), key = `${siteId}:ercot:level`, prev = await kv.get<string>(key) ?? 'normal';
  if (level === prev) return { level };
  await kv.set(key, level);
  if (level === 'normal' || level === 'unknown') return { level, from: prev };
  const r = await notify(siteId, 'ercot', d.title || (level === 'conservation' ? 'ERCOT asks Texans to conserve' : `ERCOT energy emergency (EEA ${d.eea})`),
    `${d.note ? `${d.note} ` : ''}PEC bills a flat rate, so this is about grid stress, not your bill.`, { level, eea: d.eea },
    { key: `ercot:${level}:${localDay(new Date(now))}`, now, url: '/?go=v-now' });
  return { level, from: prev, notified: r.stored };
}

/* ---------- PEC bill due (the same arithmetic as the app's "your bill should be ready" card) ---------- */
export async function billDueCheck(siteId: string, now = Date.now()) {
  const bills = await listBills(siteId);
  const last = bills.reduce<typeof bills[number] | null>((a, b) => !a || b.period.to > a.period.to ? b : a, null);
  if (!last) return { due: false, reason: 'no bill yet' };
  const nextClose = addDays(last.period.to, 31), ready = addDays(nextClose, 2), today = localDay(new Date(now));
  if (ready > today) return { due: false, ready };
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(nextClose + 'T12:00:00Z'));
  const r = await notify(siteId, 'billDue', `Your ${month} PEC bill should be ready`,
    'Download it from SmartHub or myPEC.com and add it in History › Bills. Solstice checks it against Tesla and updates your rates.',
    { periodFrom: last.period.to, nextClose }, { key: `billDue:${nextClose}`, windowH: 24 * 45, now, url: '/?go=v-hist&bills=1' });
  return { due: true, ready, notified: r.stored };
}

/* ---------- the cron entry points ---------- */
type Step = () => Promise<unknown>;
/** `onStep` (B2-11, cronLedger.ts): told each step's name, time and result, for the cron ledger. */
export type OnStep = (name: string, ms: number, result: unknown) => void;
async function run(steps: Record<string, Step>, onStep?: OnStep) {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(steps)) { const t = performance.now(); out[name] = await fn().catch((e: unknown) => ({ error: (e as Error)?.message ?? String(e) })); onStep?.(name, performance.now() - t, out[name]); }
  return out;
}
/** Extra steps other modules add to the 5-minute and nightly watches (digest, Powerwall rules), registered at import. */
export const fiveMinuteSteps: Record<string, (siteId: string, now: number) => Promise<unknown>> = {
  storm: stormWatch, ercot: (id, now) => ercotWatch(id, now),
};
/** `o.deadline` (epoch ms): when the nightly cron must be done (app.ts: 55 s after it started); a long step skips itself near it. */
export type NightlyOpts = { deadline?: number; onStep?: OnStep };
export const nightlySteps: Record<string, (siteId: string, now: number, o: NightlyOpts) => Promise<unknown>> = {
  billDue: billDueCheck, anomalies: notifyAnomalies,
};
export const fiveMinuteWatch = (siteId: string, now = Date.now(), onStep?: OnStep) => run(Object.fromEntries(Object.entries(fiveMinuteSteps).map(([k, f]) => [k, () => f(siteId, now)])), onStep);
/** A nightly step doesn't start with less than this left before `o.deadline`; it is recorded as skipped (code review C-06). */
export const NIGHTLY_STEP_MIN_MS = 5_000;
export const nightlyWatch = (siteId: string, now = Date.now(), o: NightlyOpts = {}) => run(Object.fromEntries(Object.entries(nightlySteps).map(([k, f]) => [k,
  () => o.deadline != null && o.deadline - Date.now() < NIGHTLY_STEP_MIN_MS ? Promise.resolve({ skipped: 'out of time' }) : f(siteId, now, o)])), o.onStep);
/** The sites the crons act for. */
export const cronSites = async () => (await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL')).map(s => s.id);
