// Google Nest via the Smart Device Management API. Credentials from the environment (NEST_PROJECT_ID, GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI); the refresh token from the one-time Google consent is kept in the database (kv 'nest:tokens').
import { kv } from '../db.js';

const SDM = 'https://smartdevicemanagement.googleapis.com/v1';
const env = (k: string) => process.env[k] ?? '';
export const nestConfigured = () => !!(env('NEST_PROJECT_ID') && env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
export const nestLinked = async () => !!(await kv.get<Tokens>('nest:tokens'))?.refresh_token;
type Tokens = { access_token: string; refresh_token: string; expires_at: number };

/** Google consent URL for the Device Access project (partner connections flow). */
export const nestAuthorizeUrl = (state: string) => `https://nestservices.google.com/partnerconnections/${env('NEST_PROJECT_ID')}/auth?` + new URLSearchParams({
  redirect_uri: env('GOOGLE_REDIRECT_URI'), access_type: 'offline', prompt: 'consent', client_id: env('GOOGLE_CLIENT_ID'), response_type: 'code', scope: 'https://www.googleapis.com/auth/sdm.service', state });

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), ...body }) });
  const j = await r.json() as any;
  if (!r.ok) throw new Error(`Google token: ${j.error_description ?? j.error ?? r.status}`);
  return j;
}
export async function nestExchangeCode(code: string) {
  const j = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: env('GOOGLE_REDIRECT_URI') });
  await kv.set('nest:tokens', { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 } satisfies Tokens);
}
async function accessToken() {
  const t = await kv.get<Tokens>('nest:tokens'); if (!t?.refresh_token) throw new Error('Nest is not linked');
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  const j = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  await kv.set('nest:tokens', { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token as string;
}
async function sdm(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SDM}${path}`, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) throw new Error(`Nest: ${j.error?.message ?? r.status}`);
  return j;
}
export const cToF = (c: number) => Math.round((c * 9 / 5 + 32) * 10) / 10, fToC = (f: number) => Math.round(((f - 32) * 5 / 9) * 100) / 100;

export type NestState = { at: number; deviceId: string; name: string; online: boolean; indoorF: number | null; humidity: number | null; mode: string; hvac: 'OFF' | 'HEATING' | 'COOLING' | string;
  coolF: number | null; heatF: number | null; eco: boolean; ecoCoolF: number | null; ecoHeatF: number | null; fanTimer: boolean; availableModes: string[] };

/** The first thermostat on the account. */
export async function readNest(): Promise<NestState> {
  const j = await sdm(`/enterprises/${env('NEST_PROJECT_ID')}/devices`);
  const d = (j.devices ?? []).find((x: any) => x.type === 'sdm.devices.types.THERMOSTAT'); if (!d) throw new Error('No thermostat shared with Solstice');
  const T = (k: string) => d.traits?.[`sdm.devices.traits.${k}`] ?? {};
  const st: NestState = { at: Date.now(), deviceId: d.name, name: d.parentRelations?.[0]?.displayName ?? 'Thermostat', online: T('Connectivity').status === 'ONLINE',
    indoorF: T('Temperature').ambientTemperatureCelsius != null ? cToF(T('Temperature').ambientTemperatureCelsius) : null, humidity: T('Humidity').ambientHumidityPercent ?? null,
    mode: T('ThermostatMode').mode ?? 'OFF', hvac: T('ThermostatHvac').status ?? 'OFF', coolF: T('ThermostatTemperatureSetpoint').coolCelsius != null ? cToF(T('ThermostatTemperatureSetpoint').coolCelsius) : null,
    heatF: T('ThermostatTemperatureSetpoint').heatCelsius != null ? cToF(T('ThermostatTemperatureSetpoint').heatCelsius) : null, eco: T('ThermostatEco').mode === 'MANUAL_ECO',
    ecoCoolF: T('ThermostatEco').coolCelsius != null ? cToF(T('ThermostatEco').coolCelsius) : null, ecoHeatF: T('ThermostatEco').heatCelsius != null ? cToF(T('ThermostatEco').heatCelsius) : null,
    fanTimer: T('Fan').timerMode === 'ON', availableModes: T('ThermostatMode').availableModes ?? [] };
  await kv.set('nest:last', st);
  return st;
}
const exec = (deviceId: string, command: string, params: Record<string, unknown>) => sdm(`/${deviceId}:executeCommand`, { method: 'POST', body: JSON.stringify({ command: `sdm.devices.commands.${command}`, params }) });
export const setCool = (deviceId: string, f: number) => exec(deviceId, 'ThermostatTemperatureSetpoint.SetCool', { coolCelsius: fToC(f) });
export const setHeat = (deviceId: string, f: number) => exec(deviceId, 'ThermostatTemperatureSetpoint.SetHeat', { heatCelsius: fToC(f) });
export const setMode = (deviceId: string, mode: 'HEAT' | 'COOL' | 'HEATCOOL' | 'OFF') => exec(deviceId, 'ThermostatMode.SetMode', { mode });
export const setEco = (deviceId: string, on: boolean) => exec(deviceId, 'ThermostatEco.SetMode', { mode: on ? 'MANUAL_ECO' : 'OFF' });
