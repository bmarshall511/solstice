// The cron run ledger (B2-11, idea I-09). Vercel never retries a cron and logs only a status, so each of the three crons now leaves
// a record of its last run in kv `cron:<name>:last` = {at, ms, steps: {step: ms | 'skipped' | 'error'}, ok, errors}: the nightly
// sync (/api/cron/sync), the evening pool plan (/api/cron/pool) and the 5-minute tick (/api/cron/nest). /api/now's health carries
// them for Insights › Home › Data health (owner only), and the crons watch each other, since a cron can't report its own absence:
//   the 5-minute tick went quiet for 20 minutes or more   (seen by the next tick, or by the nightly)
//   the pool plan hadn't run by 21:00 Chicago             (seen by the 5-minute tick)
//   the nightly took more than 50 s of its 60             (seen by the 5-minute tick after it)
// One `anomaly` alert each, deduped per Chicago day.
import { kv } from './db.js';
import { localDay, rfc3339 } from './tesla/client.js';
import { notify } from './notify.js';

export type CronName = 'sync' | 'pool' | 'nest';
export const CRON_NAMES: readonly CronName[] = ['sync', 'pool', 'nest'];
export type StepMark = number | 'skipped' | 'error';
export type CronRecord = { at: number; ms: number; steps: Record<string, StepMark>; ok: boolean; errors: string[] };
export const cronKey = (name: CronName) => `cron:${name}:last`;
export const NEST_SILENT_MS = 20 * 60_000, POOL_DUE_HOUR = 21, SYNC_SLOW_MS = 50_000;

/** What a step's result says: an `{error}` result (or `errors` listed, or a sub-step's error one level down) is an error, `{skipped}` skipped. */
export function markOf(result: unknown, ms: number): StepMark {
  const r = result as Record<string, any> | null | undefined;
  if (r && typeof r === 'object') {
    if (r.error) return 'error';
    if (Array.isArray(r.errors) && r.errors.length) return 'error';
    if (r.skipped) return 'skipped';
    if (Object.values(r).some(v => v && typeof v === 'object' && !Array.isArray(v) && (v as any).error)) return 'error';
  }
  return Math.round(ms);
}
const errorOf = (r: unknown): string | null => { const x = r as any; return x?.error ? String(x.error) : Array.isArray(x?.errors) && x.errors.length ? String(x.errors[0]) : null; };

/**
 * A run's ledger: `step` times a step (several sites add up under one name), records its mark and passes its result (or its throw)
 * through unchanged; `mark` records a step timed elsewhere; `finish` writes the record and returns it.
 */
export function ledger(name: CronName, startedAt = Date.now()) {
  const t0 = performance.now(), steps: Record<string, StepMark> = {}, errors: string[] = [];
  const mark = (step: string, m: StepMark, error?: string | null) => {
    const prev = steps[step];
    steps[step] = prev === 'error' || m === 'error' ? 'error' : typeof prev === 'number' && typeof m === 'number' ? prev + m : m;
    if (error && errors.length < 5) errors.push(`${step}: ${error.slice(0, 120)}`);
  };
  return {
    mark,
    async step<T>(step: string, fn: () => Promise<T>): Promise<T> {
      const s = performance.now();
      try { const v = await fn(); mark(step, markOf(v, performance.now() - s), errorOf(v)); return v; }
      catch (e) { mark(step, 'error', (e as Error)?.message ?? String(e)); throw e; }
    },
    async finish(): Promise<CronRecord> {
      const rec: CronRecord = { at: startedAt, ms: Math.round(performance.now() - t0), steps, ok: !Object.values(steps).includes('error'), errors };
      await kv.set(cronKey(name), rec).catch(e => console.error(`[solstice] cron ledger ${name}: ${(e as Error).message}`));
      return rec;
    },
  };
}

/** The slowest timed step of a record, or null. */
export function slowest(rec: Pick<CronRecord, 'steps'> | null | undefined): { name: string; ms: number } | null {
  let best: { name: string; ms: number } | null = null;
  for (const [name, m] of Object.entries(rec?.steps ?? {})) if (typeof m === 'number' && (!best || m > best.ms)) best = { name, ms: m };
  return best;
}
/** The three records for /api/now's health (owner only): when, how long, ok, the slowest step and the error count. */
export async function cronHealth() {
  const recs = await Promise.all(CRON_NAMES.map(n => kv.get<CronRecord>(cronKey(n))));
  return Object.fromEntries(CRON_NAMES.map((n, i) => { const r = recs[i];
    return [n, r ? { at: r.at, ms: r.ms, ok: r.ok, slowest: slowest(r), errors: r.errors?.length ?? 0 } : null]; })) as Record<CronName, { at: number; ms: number; ok: boolean; slowest: { name: string; ms: number } | null; errors: number } | null>;
}

const chicagoHour = (t: number) => +rfc3339(new Date(t)).slice(11, 13);
const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
export type CronAlert = { key: string; title: string; body: string; data: Record<string, unknown> };
/**
 * The alerts the records call for at `now` (pure). `which`: the 5-minute tick checks all three; the nightly only the 5-minute gap.
 * Without a record there is nothing to judge (the first runs after a deploy write them).
 */
export function cronAlerts(r: Partial<Record<CronName, CronRecord | null>>, now: number, which: readonly ('nest' | 'pool' | 'sync')[] = ['nest', 'pool', 'sync']): CronAlert[] {
  const today = localDay(new Date(now)), out: CronAlert[] = [];
  const nest = r.nest, pool = r.pool, sync = r.sync;
  if (which.includes('nest') && nest && now - nest.at >= NEST_SILENT_MS) {
    const min = Math.round((now - nest.at) / 60_000);
    out.push({ key: `cron:nest:silent:${today}`, title: 'The 5-minute checks went quiet',
      body: `No 5-minute check ran for ${min} minutes (the last at ${clock(nest.at)}), so AC steps, pool reads and storm alerts were paused. Check Vercel's cron logs if this repeats.`, data: { minutes: min } });
  }
  if (which.includes('pool') && pool && chicagoHour(now) >= POOL_DUE_HOUR && localDay(new Date(pool.at)) !== today)
    out.push({ key: `cron:pool:missed:${today}`, title: 'Tonight’s pool plan didn’t run',
      body: `The evening pool plan normally runs around 8:15 PM; the last run was ${localDay(new Date(pool.at))} at ${clock(pool.at)}. The pump keeps its current schedule. Check Vercel's cron logs if this repeats.`, data: { lastAt: pool.at } });
  if (which.includes('sync') && sync && sync.ms > SYNC_SLOW_MS && now - sync.at < 864e5) {
    const s = slowest(sync);
    out.push({ key: `cron:sync:slow:${localDay(new Date(sync.at))}`, title: 'The nightly update is running long',
      body: `Last night's update took ${Math.round(sync.ms / 1000)} s of the 60 s Vercel allows${s ? ` (slowest: ${s.name}, ${Math.round(s.ms / 1000)} s)` : ''}. Past 60 s it is cut off and the last steps don't run.`, data: { ms: sync.ms, slowest: s?.name ?? null } });
  }
  return out;
}
/** The watch step: read the records and push what cronAlerts finds (one per kind per day). */
export async function cronWatch(siteId: string, now = Date.now(), which: readonly ('nest' | 'pool' | 'sync')[] = ['nest', 'pool', 'sync']) {
  const [sync, pool, nest] = await Promise.all(CRON_NAMES.map(n => kv.get<CronRecord>(cronKey(n))));
  const alerts = cronAlerts({ sync, pool, nest }, now, which);
  for (const a of alerts) await notify(siteId, 'anomaly', a.title, a.body, a.data, { key: a.key, now, url: '/?go=v-sys&p=home' });
  return { alerts: alerts.map(a => a.key.split(':').slice(1, 3).join(':')) };
}
