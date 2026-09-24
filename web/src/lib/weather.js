import { LAT, LON } from './util.js';

const base = `latitude=${LAT}&longitude=${LON}&timezone=America%2FChicago`;
const tilt = 'tilt=27&azimuth=64'; // Open-Meteo azimuth: 0 = south, +90 = west → 244° compass = 64

export const WMO = c => c === 0 ? 'Clear' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Overcast' : c <= 48 ? 'Fog' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : 'Storms';
export const WICON = (c, day = true) => c === 0 ? (day ? '☀︎' : '☾') : c <= 2 ? '⛅︎' : c <= 48 ? '☁︎' : c >= 95 ? '⛈︎' : '☂︎';

/** Forecast: today + 2 days, plus the last 31 days (for performance baselines and AC analysis). */
export const forecast = () => fetch(`https://api.open-meteo.com/v1/forecast?${base}&${tilt}&past_days=31&forecast_days=3&temperature_unit=fahrenheit&wind_speed_unit=mph` +
  `&current=temperature_2m,cloud_cover,weather_code,is_day,wind_speed_10m` +
  `&hourly=temperature_2m,cloud_cover,weather_code,global_tilted_irradiance,precipitation_probability` +
  `&daily=temperature_2m_max,temperature_2m_mean,precipitation_sum,precipitation_probability_max,uv_index_max,sunrise,sunset`).then(r => r.json());

/** Historical archive (for longer baselines). */
export const archive = (from, to) => fetch(`https://archive-api.open-meteo.com/v1/archive?${base}&${tilt}&start_date=${from}&end_date=${to}&temperature_unit=fahrenheit` +
  `&hourly=global_tilted_irradiance&daily=temperature_2m_max,temperature_2m_mean,precipitation_sum`).then(r => r.json());

export const nwsAlerts = () => fetch(`https://api.weather.gov/alerts/active?point=${LAT},${LON}`).then(r => r.json()).then(j => j.features?.map(f => f.properties) ?? []);

/** Index hourly arrays by local date → hour. */
export function hourlyIndex(w) {
  const idx = {};
  w.hourly.time.forEach((t, i) => { const d = t.slice(0, 10), h = +t.slice(11, 13); (idx[d] ??= [])[h] = i; });
  return idx;
}
