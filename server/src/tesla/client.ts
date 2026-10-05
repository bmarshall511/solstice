import { config } from '../config.js';
import { accessToken } from './auth.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The longest one Fleet API call may take. */
export const FLEET_TIMEOUT_MS = 12_000;

export type LiveStatus = {
  solar_power: number; battery_power: number; grid_power: number; load_power: number; percentage_charged: number;
  grid_status: string; island_status: string; storm_mode_active: boolean; timestamp: string; [k: string]: unknown;
};
export type EnergyBucket = { timestamp: string; [field: string]: number | string };

/** Fleet API client bound to one connected Tesla account. */
export function teslaFor(accountId: number) {
  async function get<T>(path: string, params?: Record<string, string>, attempt = 0, stale: string | null = null): Promise<T> {
    const url = `${config.audience}${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
    const token = await accessToken(accountId, stale);
    // every Fleet call has a deadline, so one hung request (backup_history is known to stall into a 504) can't eat a cron's 60 s
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FLEET_TIMEOUT_MS) });
    if (res.status === 401 && attempt === 0) return get(path, params, 1, token);   // refresh past the refused token only
    if (res.status === 429 && attempt < 3) { await sleep(1500 * 2 ** attempt); return get(path, params, attempt + 2); }
    const j = (await res.json().catch(() => ({}))) as { response?: T; error?: string; error_description?: string };
    if (!res.ok) throw new Error(`Tesla ${path} → HTTP ${res.status}: ${j.error ?? ''} ${j.error_description ?? ''}`.trim());
    return j.response as T;
  }
  const cal = <T>(site: string, params: Record<string, string>) => get<T>(`/api/1/energy_sites/${site}/calendar_history`, { time_zone: config.timeZone, ...params });
  return {
    products: () => get<Array<Record<string, unknown>>>('/api/1/products'),
    liveStatus: (site: string) => get<LiveStatus>(`/api/1/energy_sites/${site}/live_status`),
    siteInfo: (site: string) => get<Record<string, unknown>>(`/api/1/energy_sites/${site}/site_info`),
    energy: (site: string, start: string, end: string) => cal<{ time_series?: EnergyBucket[] }>(site, { kind: 'energy', period: 'day', start_date: start, end_date: end }),
    soe: (site: string, start: string, end: string) => cal<{ time_series?: Array<{ timestamp: string; soe: number }> }>(site, { kind: 'soe', period: 'day', start_date: start, end_date: end }),
    backups: (site: string, start: string, end: string) => cal<{ events?: Array<{ timestamp: string; duration: number }> }>(site, { kind: 'backup', period: 'lifetime', start_date: start, end_date: end }),
    calendar: cal,
  };
}

/** RFC3339 timestamp with the site's UTC offset, e.g. 2026-09-24T00:00:00-05:00 */
export function rfc3339(date: Date, timeZone = config.timeZone): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second), off = Math.round((local - date.getTime()) / 60000), a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
export function localMidnight(day: string, timeZone = config.timeZone): Date {
  const guess = new Date(`${day}T00:00:00Z`), offset = new Date(rfc3339(guess, timeZone).slice(0, 19) + 'Z').getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
}
export const localDay = (d = new Date()) => rfc3339(d).slice(0, 10);
/**
 * Epoch ms of a local clock time on a day (`hour` may be fractional: 18.5 = 18:30). DST-aware: on the fall-back day 02:00 is 3 h after
 * midnight, not 2, and the repeated 01:xx resolves to its first occurrence; on the spring-forward day a time in the skipped hour lands
 * an hour later. (Midnight + hour × 1 h was an hour off for the rest of both change days.)
 */
export function localAt(day: string, hour: number, timeZone = config.timeZone): number {
  const h = Math.floor(hour), m = Math.round((hour - h) * 60), pad = (v: number) => String(v).padStart(2, '0');
  const wall = Date.parse(`${day}T${pad(h)}:${pad(m)}:00Z`);   // the clock reading as if it were UTC
  const offAt = (t: number) => Date.parse(rfc3339(new Date(t), timeZone).slice(0, 19) + 'Z') - t;
  const a = wall - offAt(wall - 12 * 3600e3), b = wall - offAt(wall + 12 * 3600e3);   // the offsets on either side of a change
  const ok = (t: number) => Date.parse(rfc3339(new Date(t), timeZone).slice(0, 19) + 'Z') === wall;
  return ok(a) && ok(b) ? Math.min(a, b) : ok(a) ? a : ok(b) ? b : Math.max(a, b);
}
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/**
 * The window to ask Tesla for one local day: local midnight to one second before the next local midnight, so the DST-start day
 * is 23 hours, the fall-back day 25 and every other day 24. It never ends after `now`, so today's window stops at the current time.
 */
export function dayWindow(day: string, now = Date.now()): { start: Date; end: Date } {
  const start = localMidnight(day), next = localMidnight(addDays(day, 1));
  return { start, end: new Date(Math.min(now, next.getTime() - 1000)) };
}
