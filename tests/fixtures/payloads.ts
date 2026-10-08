// Raw third-party payloads with the real *shape* and synthetic values (audit 10b, test batch 7 item 5): the Google SDM device list,
// Fleet API envelopes, Open-Meteo forecast and archive, NWS alerts GeoJSON and the two ERCOT dashboards. Hand-written from the
// providers' public documentation; no ids, names, coordinates or readings from the owner's site. Dates are 2026 only (hygiene).

/* ---------- Google Smart Device Management: GET enterprises/{project}/devices ---------- */
export type SdmThermostat = { mode?: string; hvac?: string; coolC?: number | null; heatC?: number | null; ambientC?: number | null; humidity?: number | null;
  eco?: 'OFF' | 'MANUAL_ECO'; ecoCoolC?: number | null; ecoHeatC?: number | null; online?: boolean; fan?: { timerMode: 'ON' | 'OFF'; timerTimeout?: string } | null;
  availableModes?: string[]; room?: string | null; omit?: string[] };
export const SDM_DEVICE = 'enterprises/test-project/devices/dev-test';
const T = (k: string) => `sdm.devices.traits.${k}`;
/** One thermostat as SDM lists it. Celsius everywhere, as the API sends it; `omit` drops whole traits (a device that lacks them). */
export function sdmThermostat(o: SdmThermostat = {}) {
  const sp: Record<string, number> = {};
  if (o.coolC !== null) sp.coolCelsius = o.coolC ?? 25.5556;   // 78 °F
  if (o.heatC != null) sp.heatCelsius = o.heatC;
  const traits: Record<string, unknown> = {
    [T('Info')]: { customName: '' },
    [T('Humidity')]: o.humidity === null ? {} : { ambientHumidityPercent: o.humidity ?? 45 },
    [T('Connectivity')]: { status: o.online === false ? 'OFFLINE' : 'ONLINE' },
    [T('Fan')]: o.fan === null ? {} : o.fan ?? { timerMode: 'OFF' },
    [T('ThermostatMode')]: { mode: o.mode ?? 'COOL', availableModes: o.availableModes ?? ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] },
    [T('ThermostatEco')]: { availableModes: ['OFF', 'MANUAL_ECO'], mode: o.eco ?? 'OFF', heatCelsius: o.ecoHeatC ?? 7.7778, coolCelsius: o.ecoCoolC ?? 29.4444 },
    [T('ThermostatHvac')]: { status: o.hvac ?? 'OFF' },
    [T('Settings')]: { temperatureScale: 'FAHRENHEIT' },
    [T('ThermostatTemperatureSetpoint')]: sp,
    [T('Temperature')]: o.ambientC === null ? {} : { ambientTemperatureCelsius: o.ambientC ?? 24.4444 },   // 76 °F
  };
  for (const k of o.omit ?? []) delete traits[T(k)];
  return {
    name: SDM_DEVICE, type: 'sdm.devices.types.THERMOSTAT', assignee: 'enterprises/test-project/structures/st-test/rooms/rm-test', traits,
    parentRelations: o.room === null ? [] : [{ parent: 'enterprises/test-project/structures/st-test/rooms/rm-test', displayName: o.room ?? 'Hallway' }],
  };
}
/** A camera on the same account: readNest must skip it. */
export const sdmCamera = () => ({ name: 'enterprises/test-project/devices/cam-test', type: 'sdm.devices.types.CAMERA', traits: { [T('Info')]: { customName: '' } }, parentRelations: [] });
/** SDM's error envelope (google.rpc.Status). */
export const sdmError = (code: number, status: string, message: string) => ({ error: { code, message, status } });

/* ---------- Tesla Fleet API ---------- */
export const fleetOk = <T>(response: T) => ({ response });
export const fleetError = (error: string, error_description?: string) => ({ response: null, error, ...(error_description ? { error_description } : {}) });

/* ---------- Open-Meteo ---------- */
const hoursOf = (days: string[]) => days.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
const sunAt = (h: number) => Math.max(0, Math.round(Math.sin((h - 6) / 14 * Math.PI) * 800));
/** The pool Autopilot's forecast call (autopilot.ts): daily max °F, rain, rain chance, MJ/m² sun; hourly shortwave W/m². */
export function openMeteoForecast(days: string[], o: { highF?: number; rainMm?: Array<number | null>; nullSun?: boolean } = {}) {
  const time = hoursOf(days);
  return {
    latitude: 12.375, longitude: -56.75, generationtime_ms: 0.1, utc_offset_seconds: -18000, timezone: 'America/Chicago', timezone_abbreviation: 'GMT-5', elevation: 100,
    hourly_units: { time: 'iso8601', shortwave_radiation: 'W/m²' },
    hourly: { time, shortwave_radiation: time.map(t => o.nullSun ? null : sunAt(+t.slice(11, 13))) },
    daily_units: { time: 'iso8601', temperature_2m_max: '°F', precipitation_sum: 'mm', precipitation_probability_max: '%', shortwave_radiation_sum: 'MJ/m²' },
    daily: { time: days, temperature_2m_max: days.map(() => o.highF ?? 91.4), precipitation_sum: days.map((_, i) => o.rainMm?.[i] ?? 0),
      precipitation_probability_max: days.map(() => 10), shortwave_radiation_sum: days.map(() => 21.6) },
  };
}
/** The learning layer's tilted-irradiance call (learn/wx.ts): hourly GTI and temperature, daily max/min and rain. */
export function openMeteoGti(days: string[]) {
  const time = hoursOf(days);
  return {
    latitude: 12.375, longitude: -56.75, timezone: 'America/Chicago', utc_offset_seconds: -18000,
    hourly_units: { time: 'iso8601', global_tilted_irradiance: 'W/m²', temperature_2m: '°F' },
    hourly: { time, global_tilted_irradiance: time.map(t => sunAt(+t.slice(11, 13))), temperature_2m: time.map(t => 75 + (+t.slice(11, 13) >= 12 && +t.slice(11, 13) <= 17 ? 15 : 0)) },
    daily_units: { time: 'iso8601', temperature_2m_max: '°F', temperature_2m_min: '°F', precipitation_sum: 'mm' },
    daily: { time: days, temperature_2m_max: days.map(() => 90), temperature_2m_min: days.map(() => 75), precipitation_sum: days.map(() => 0) },
  };
}
/** The archive API (homeModel.ts wxHiLo, app.ts acSlope): daily max (and min) °F; `gaps` days come back null, as the archive does for its last days. */
export function openMeteoArchive(days: string[], o: { gaps?: number; min?: boolean } = {}) {
  const n = days.length, gap = (i: number) => i >= n - (o.gaps ?? 0);
  return {
    latitude: 12.375, longitude: -56.75, timezone: 'America/Chicago', utc_offset_seconds: -18000,
    daily_units: { time: 'iso8601', temperature_2m_max: '°F', ...(o.min === false ? {} : { temperature_2m_min: '°F' }) },
    daily: { time: days, temperature_2m_max: days.map((_, i) => gap(i) ? null : 85 + (i % 10)), ...(o.min === false ? {} : { temperature_2m_min: days.map((_, i) => gap(i) ? null : 70 + (i % 5)) }) },
  };
}
/** Open-Meteo's error body (HTTP 400). */
export const openMeteoError = (reason: string) => ({ error: true, reason });

/* ---------- NWS: GET /alerts/active?point= (application/geo+json) ---------- */
export function nwsAlerts(alerts: Array<{ event: string; headline?: string | null; severity?: string; ends?: string | null; expires?: string }>) {
  return {
    '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld', { '@version': '1.1' }], type: 'FeatureCollection',
    features: alerts.map((a, i) => ({
      id: `https://api.weather.gov/alerts/urn:oid:test.${i}`, type: 'Feature', geometry: null,
      properties: { '@id': `https://api.weather.gov/alerts/urn:oid:test.${i}`, '@type': 'wx:Alert', id: `urn:oid:test.${i}`, areaDesc: 'Test County',
        sent: '2026-06-01T15:00:00-05:00', effective: '2026-06-01T15:00:00-05:00', onset: '2026-06-01T15:00:00-05:00', expires: a.expires ?? '2026-06-01T18:00:00-05:00',
        ends: a.ends === undefined ? '2026-06-01T21:00:00-05:00' : a.ends, status: 'Actual', messageType: 'Alert', category: 'Met', severity: a.severity ?? 'Severe',
        certainty: 'Likely', urgency: 'Expected', event: a.event, sender: 'w-nws.webmaster@noaa.gov', senderName: 'NWS Test Office',
        headline: a.headline === undefined ? `${a.event} issued June 1 at 3:00PM CDT by NWS Test Office` : a.headline, description: 'Synthetic.', instruction: null, response: 'Prepare' },
    })),
    title: 'Current watches, warnings, and advisories', updated: '2026-06-01T20:00:00+00:00',
  };
}
/** NWS problem+json (an unknown point, an outage). */
export const nwsProblem = (status: number, title: string) => ({ correlationId: 'test', title, type: 'https://api.weather.gov/problems/InvalidPoint', status, detail: title, instance: 'https://api.weather.gov/requests/test' });

/* ---------- ERCOT dashboards: daily-prc.json and supply-demand.json ---------- */
export function ercotPrc(o: { state?: string; title?: string; note?: string; eea?: number; omitCondition?: boolean } = {}) {
  return {
    lastUpdated: '2026-08-12 15:55:10-0500',
    ...(o.omitCondition ? {} : { current_condition: { state: o.state ?? 'normal', title: o.title ?? 'Normal Conditions', condition_note: o.note ?? '', eea_level: o.eea ?? 0, energy_level_value: 0, datetime: 0 } }),
    data: [{ timestamp: '2026-08-12 15:55:00-0500', interval: 0, prc: 6100.5 }],
  };
}
/** Five-minute supply and demand: the last intervals of the day are future (demand 0) and must be skipped for "now". */
export function ercotSupplyDemand(o: { rows?: Array<{ demand: number; capacity: number }>; omitData?: boolean } = {}) {
  const rows = o.rows ?? [{ demand: 70500, capacity: 81000 }, { demand: 71234, capacity: 81500 }, { demand: 0, capacity: 0 }, { demand: 0, capacity: 0 }];
  return {
    lastUpdated: '2026-08-12 15:55:10-0500',
    ...(o.omitData ? {} : { data: rows.map((r, i) => ({ timestamp: `2026-08-12 15:${String(45 + i * 5).padStart(2, '0')}:00-0500`, interval: i * 300, ...r, forecast: r.demand ? 0 : 1 })) }),
  };
}
