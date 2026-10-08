// Synthetic answers for the public feeds the app reads (demo only): Open-Meteo forecast and archive, NWS alerts, the two ERCOT
// dashboards. Built from the request URL and the demo's weather model (model.ts), so any past_days / forecast_days / start_date /
// end_date / field list the server or the browser asks for gets a consistent answer. Pure: no network.
import { rfc3339, localMidnight, addDays, localDay } from '../../server/src/tesla/client.js';
import { dayWx, tempAt, cloudAt, gtiAt, ghiAt, sunAt, sunTimes, type DayWx } from './model.js';

const H = 3600_000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const list = (u: URL, k: string) => (u.searchParams.get(k) ?? '').split(',').map(s => s.trim()).filter(Boolean);
const code = (w: DayWx, cloud: number, hour: number) => w.sky === 'rain' && hour >= 12 && hour <= 18 ? 63 : cloud < 20 ? (cloud < 10 ? 0 : 1) : cloud < 60 ? 2 : 3;
/** The mean over the hour ending at `end` (Open-Meteo's radiation convention), sampled every 5 minutes. */
const hourMean = (end: number, f: (ms: number) => number) => { let s = 0; for (let k = 0; k < 12; k++) s += f(end - H + k * 300_000 + 150_000); return s / 12; };

function hourlyValue(field: string, ms: number, w: DayWx) {
  const t = rfc3339(new Date(ms)), hf = +t.slice(11, 13) + +t.slice(14, 16) / 60, cloud = cloudAt(w, hf);
  switch (field) {
    case 'temperature_2m': return r1(tempAt(w, hf));
    case 'cloud_cover': return Math.round(cloud);
    case 'weather_code': return code(w, cloud, hf);
    case 'global_tilted_irradiance': return r1(hourMean(ms, x => gtiAt(x, cloudAt(w, hf - .5))));
    case 'shortwave_radiation': return r1(hourMean(ms, x => ghiAt(x, cloudAt(w, hf - .5))));
    case 'precipitation_probability': return w.sky === 'rain' ? 70 : w.sky === 'overcast' ? 30 : w.sky === 'partly' ? 10 : 0;
    case 'precipitation': return w.sky === 'rain' && hf >= 12 && hf <= 18 ? r1(w.rainMm / 7) : 0;
    case 'relative_humidity_2m': return Math.round(85 - (tempAt(w, hf) - w.low) / Math.max(1, w.high - w.low) * 40);
    case 'is_day': return sunAt(ms).el > 0 ? 1 : 0;
    case 'wind_speed_10m': return r1(w.wind * (.7 + .5 * Math.sin(hf / 24 * Math.PI)));
    default: return 0;
  }
}
function dailyValue(field: string, day: string, today: string) {
  const w = dayWx(day, today);
  switch (field) {
    case 'temperature_2m_max': return w.high;
    case 'temperature_2m_min': return w.low;
    case 'temperature_2m_mean': return r1((w.high + w.low) / 2);
    case 'precipitation_sum': return w.rainMm;
    case 'precipitation_probability_max': return w.sky === 'rain' ? 80 : w.sky === 'overcast' ? 35 : w.sky === 'partly' ? 15 : 3;
    case 'uv_index_max': return r1(Math.max(1, 10 * Math.sin(Math.max(0, sunAt(localMidnight(day).getTime() + 13.5 * H).el) * Math.PI / 180) * (1 - w.cloud / 160)));
    case 'weather_code': return code(w, w.cloud, 14);
    case 'sunrise': return rfc3339(new Date(sunTimes(day).rise)).slice(0, 16);
    case 'sunset': return rfc3339(new Date(sunTimes(day).set)).slice(0, 16);
    case 'shortwave_radiation_sum': { let s = 0; const m0 = localMidnight(day).getTime(); for (let k = 0; k < 288; k++) s += ghiAt(m0 + k * 300_000 + 150_000, cloudAt(w, k / 12)) * 300; return r1(s / 1e6); }
    default: return 0;
  }
}

/** An Open-Meteo forecast (api.open-meteo.com/v1/forecast) or archive (archive-api.open-meteo.com/v1/archive) answer for this URL. */
export function openMeteo(url: string, now = Date.now()) {
  const u = new URL(url), today = localDay(new Date(now)), archive = u.hostname.startsWith('archive');
  const from = archive ? (u.searchParams.get('start_date') ?? addDays(today, -7)) : addDays(today, -Number(u.searchParams.get('past_days') ?? 0));
  const to = archive ? (u.searchParams.get('end_date') ?? addDays(today, -1)) : addDays(today, Number(u.searchParams.get('forecast_days') ?? 7) - 1);
  const days: string[] = []; for (let d = from; d <= to && days.length < 800; d = addDays(d, 1)) days.push(d);
  const out: Record<string, unknown> = { latitude: Number(u.searchParams.get('latitude')), longitude: Number(u.searchParams.get('longitude')), timezone: 'America/Chicago',
    timezone_abbreviation: rfc3339(new Date(now)).endsWith('-05:00') ? 'CDT' : 'CST', utc_offset_seconds: rfc3339(new Date(now)).endsWith('-05:00') ? -18000 : -21600, elevation: 150, generationtime_ms: .5 };
  const hourly = list(u, 'hourly'), daily = list(u, 'daily'), current = list(u, 'current');
  if (hourly.length && days.length) {
    const t0 = localMidnight(days[0]).getTime(), t1 = localMidnight(addDays(days[days.length - 1], 1)).getTime(), wx = new Map<string, DayWx>();
    const times: number[] = []; for (let t = t0; t < t1; t += H) times.push(t);
    const h: Record<string, unknown[]> = { time: times.map(t => rfc3339(new Date(t)).slice(0, 16)) };
    for (const f of hourly) h[f] = times.map(t => { const day = rfc3339(new Date(t)).slice(0, 10);
      return hourlyValue(f, t, wx.get(day) ?? wx.set(day, dayWx(day, today)).get(day)!); });
    out.hourly = h; out.hourly_units = Object.fromEntries(hourly.map(f => [f, f.startsWith('temperature') ? '°F' : '']));
  }
  if (daily.length && days.length) {
    out.daily = { time: days, ...Object.fromEntries(daily.map(f => [f, days.map(d => dailyValue(f, d, today))])) };
    out.daily_units = Object.fromEntries(daily.map(f => [f, f.startsWith('temperature') ? '°F' : '']));
  }
  if (current.length) {
    const t = Math.floor(now / 900_000) * 900_000, w = dayWx(today, today);
    out.current = { time: rfc3339(new Date(t)).slice(0, 16), interval: 900, ...Object.fromEntries(current.map(f => [f, hourlyValue(f, t, w)])) };
  }
  return out;
}
/** NWS active alerts for a point: none (a quiet week). */
export const nwsAlerts = () => ({ type: 'FeatureCollection', features: [], title: 'Current watches, warnings, and advisories (demo: none)', updated: new Date().toISOString() });
/** ERCOT's two dashboards: normal conditions, demand a little under capacity. */
export function ercot(url: string, now = Date.now()) {
  const stamp = rfc3339(new Date(now)).replace('T', ' ').replace(/([+-]\d\d):(\d\d)$/, '$1$2');
  if (/daily-prc/.test(url)) return { lastUpdated: stamp, current_condition: { state: 'normal', title: 'Normal Conditions', condition_note: '', eea_level: 0, energy_level_value: 0, datetime: 0 },
    data: [{ timestamp: stamp, interval: 0, prc: 6800 }] };
  const h = +rfc3339(new Date(now)).slice(11, 13), demand = Math.round(52000 + 18000 * Math.max(0, Math.sin((h - 6) / 24 * 2 * Math.PI)));
  return { lastUpdated: stamp, data: [{ timestamp: stamp, interval: 0, demand, capacity: demand + 11000 }, { timestamp: stamp, interval: 1, demand: 0, capacity: 0 }] };
}
/** The fixture for a URL, or null when the demo has none for it (the guard then answers 503). */
export function fixtureFor(url: string, now = Date.now()): unknown | null {
  let host = ''; try { host = new URL(url).hostname; } catch { return null; }
  if (host === 'api.open-meteo.com' || host === 'archive-api.open-meteo.com') return openMeteo(url, now);
  if (host === 'api.weather.gov') return nwsAlerts();
  if (host === 'www.ercot.com') return ercot(url, now);
  return null;
}
