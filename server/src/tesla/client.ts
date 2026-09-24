import { config } from '../config.ts';
import { accessToken } from './auth.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function get<T>(path: string, params?: Record<string, string>, attempt = 0): Promise<T> {
  const url = `${config.audience}${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(attempt > 0)}` } });
  if (res.status === 401 && attempt === 0) return get(path, params, 1);           // expired early: refresh once
  if (res.status === 429 && attempt < 3) { await sleep(2000 * 2 ** attempt); return get(path, params, attempt + 1); }
  const json = (await res.json().catch(() => ({}))) as { response?: T; error?: string; error_description?: string };
  if (!res.ok) throw new Error(`Tesla ${path} → HTTP ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
  return json.response as T;
}

export type LiveStatus = {
  solar_power: number; battery_power: number; grid_power: number; load_power: number;
  percentage_charged: number; energy_left: number; total_pack_energy: number;
  grid_status: string; island_status: string; storm_mode_active: boolean; timestamp: string;
  [k: string]: unknown;
};

export type EnergyBucket = { timestamp: string; [field: string]: number | string };

export const tesla = {
  products: () => get<Array<Record<string, unknown>>>('/api/1/products'),
  liveStatus: (siteId: string) => get<LiveStatus>(`/api/1/energy_sites/${siteId}/live_status`),
  siteInfo: (siteId: string) => get<Record<string, unknown>>(`/api/1/energy_sites/${siteId}/site_info`),
  energyHistory: (siteId: string, start: string, end: string, period = 'day') =>
    get<{ period: string; time_series: EnergyBucket[] }>(`/api/1/energy_sites/${siteId}/calendar_history`,
      { kind: 'energy', period, start_date: start, end_date: end, time_zone: config.timeZone }),
  backupHistory: (siteId: string, start: string, end: string) =>
    get<{ events?: Array<{ timestamp: string; duration: number }> }>(`/api/1/energy_sites/${siteId}/calendar_history`,
      { kind: 'backup', period: 'lifetime', start_date: start, end_date: end, time_zone: config.timeZone }),
};

/** RFC3339 timestamp with the site's UTC offset, e.g. 2026-09-24T00:00:00-05:00 */
export function rfc3339(date: Date, timeZone = config.timeZone): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((local - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-', abs = Math.abs(offsetMin);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Midnight at the start of a local calendar day (YYYY-MM-DD) in the site's time zone. */
export function localMidnight(day: string, timeZone = config.timeZone): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const offset = new Date(rfc3339(guess, timeZone).slice(0, 19) + 'Z').getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
}
