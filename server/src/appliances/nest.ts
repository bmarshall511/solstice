// Google Nest via the Smart Device Management API. Credentials from the environment (NEST_PROJECT_ID, GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI); the refresh token from the one-time Google consent is kept in the database (kv 'nest:tokens').
import { q, kv } from '../db.js';
import { guardCoolSetpoint, guardHeatSetpoint, guardTripEco, guardManual, GuardRefusal, AC_WRITE_INTERVAL_MS, type ManualCommand } from './guards.js';
import { recordSent } from './hold.js';

const SDM = 'https://smartdevicemanagement.googleapis.com/v1';
const env = (k: string) => process.env[k] ?? '';
export const nestConfigured = () => !!(env('NEST_PROJECT_ID') && env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
export const nestLinked = async () => !!(await kv.get<Tokens>('nest:tokens'))?.refresh_token;
type Tokens = { access_token: string; refresh_token: string; expires_at: number };

/** Google consent URL for the Device Access project (partner connections flow). */
export const nestAuthorizeUrl = (state: string) => `https://nestservices.google.com/partnerconnections/${env('NEST_PROJECT_ID')}/auth?` + new URLSearchParams({
  redirect_uri: env('GOOGLE_REDIRECT_URI'), access_type: 'offline', prompt: 'consent', client_id: env('GOOGLE_CLIENT_ID'), response_type: 'code', scope: 'https://www.googleapis.com/auth/sdm.service', state });

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), ...body }), signal: AbortSignal.timeout(8_000) });
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
  const r = await fetch(`${SDM}${path}`, { signal: AbortSignal.timeout(10_000), ...init, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) throw new Error(`Nest: ${j.error?.message ?? r.status}`);
  return j;
}
export const cToF = (c: number) => Math.round((c * 9 / 5 + 32) * 10) / 10, fToC = (f: number) => Math.round(((f - 32) * 5 / 9) * 100) / 100;

export type NestState = { at: number; deviceId: string; name: string; online: boolean; indoorF: number | null; humidity: number | null; mode: string; hvac: 'OFF' | 'HEATING' | 'COOLING' | string;
  coolF: number | null; heatF: number | null; eco: boolean; ecoCoolF: number | null; ecoHeatF: number | null; fanTimer: boolean; fanUntil?: number | null; availableModes: string[] };

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
    fanTimer: T('Fan').timerMode === 'ON', fanUntil: T('Fan').timerMode === 'ON' && T('Fan').timerTimeout ? Date.parse(T('Fan').timerTimeout) || null : null, availableModes: T('ThermostatMode').availableModes ?? [] };
  await kv.set('nest:last', st);
  return st;
}
const exec = (deviceId: string, command: string, params: Record<string, unknown>) => sdm(`/${deviceId}:executeCommand`, { method: 'POST', body: JSON.stringify({ command: `sdm.devices.commands.${command}`, params }) });

/* ---------- the cooling-setpoint write, behind the safety guard ---------- */
export type SetpointWrite = { at: number; f: number };
const writeKey = (deviceId: string) => `nest:setpointWrite:${deviceId}`;
/** When Solstice last wrote this thermostat's setpoint. Kept in the database so every serverless invocation shares the 30-minute limit. */
export const lastSetpointWrite = (deviceId: string) => kv.get<SetpointWrite>(writeKey(deviceId));
/** Take the thermostat's write slot atomically: succeeds only if no write is recorded in the last 30 minutes, even when two invocations race. */
async function claimSetpointWrite(deviceId: string, f: number, now: number) {
  const rows = await q(`INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE COALESCE((kv.value->>'at')::float8, 0) <= $3 RETURNING key`, [writeKey(deviceId), JSON.stringify({ at: now, f } satisfies SetpointWrite), now - AC_WRITE_INTERVAL_MS]);
  return rows.length === 1;
}
/**
 * The only cooling-setpoint write. `mode` is the AC Autopilot setting (Off refuses every write). The guard (guards.ts) checks it
 * against the setpoint as last read and the last recorded write; anything it refuses, or would step, throws GuardRefusal and nothing
 * is sent: callers choose the step themselves (acTick does). The attempt is recorded before the command goes out.
 */
export async function setCool(deviceId: string, f: number, mode: string) {
  const now = Date.now(), last = await kv.get<NestState>('nest:last'), prev = await lastSetpointWrite(deviceId);
  const g = guardCoolSetpoint({ mode, targetF: f, currentF: last?.deviceId === deviceId ? last.coolF : null, lastWriteAt: prev?.at ?? null, now });
  if (!g.ok) throw new GuardRefusal('ac', g.reason);
  if (g.value !== f) throw new GuardRefusal('ac', `the write would have to be stepped (${g.reason})`);
  if (!(await claimSetpointWrite(deviceId, f, now))) throw new GuardRefusal('ac', `another setpoint change was just made; one per ${AC_WRITE_INTERVAL_MS / 60_000} min`);
  await recordSent(deviceId, { at: now, by: 'autopilot', mode: 'COOL', coolF: f, heatF: null });   // hold.ts: so the next reading is known as ours
  return exec(deviceId, 'ThermostatTemperatureSetpoint.SetCool', { coolCelsius: fToC(f) });
}

/* ---------- Vacation mode's two other writes (mockup ak), behind their guards ---------- */
/**
 * A heating setpoint for a trip (away heat 50–60 °F, stepped) or the restore of the heat setpoint the trip started with. The same
 * write slot as setCool, so the two never land within 30 minutes of each other. Refusals throw GuardRefusal and nothing is sent.
 */
export async function setHeat(deviceId: string, f: number, mode: string, o: { targetF?: number; restore?: boolean } = {}) {
  const now = Date.now(), last = await kv.get<NestState>('nest:last'), prev = await lastSetpointWrite(deviceId);
  const g = guardHeatSetpoint({ mode, targetF: o.targetF ?? f, valueF: f, currentF: last?.deviceId === deviceId ? last.heatF : null, lastWriteAt: prev?.at ?? null, now, restore: o.restore });
  if (!g.ok) throw new GuardRefusal('ac', g.reason);
  if (!(await claimSetpointWrite(deviceId, f, now))) throw new GuardRefusal('ac', `another setpoint change was just made; one per ${AC_WRITE_INTERVAL_MS / 60_000} min`);
  await recordSent(deviceId, { at: now, by: 'autopilot', mode: 'HEAT', coolF: null, heatF: f });
  await exec(deviceId, 'ThermostatTemperatureSetpoint.SetHeat', { heatCelsius: fToC(f) });
  if (last?.deviceId === deviceId) await kv.set('nest:last', { ...last, heatF: f });
}
/**
 * Eco off for a trip under way (guardTripEco). `nest:last` is left as it was (in Eco): the next reading brings the setpoint back, and a
 * reading that follows one in Eco is never taken for somebody's change (hold.ts), so turning Eco off can't start a hold by itself.
 */
export async function tripEcoOff(deviceId: string, mode: string, tripAway: boolean) {
  const g = guardTripEco({ mode, tripAway }); if (!g.ok) throw new GuardRefusal('ac', g.reason);
  await exec(deviceId, 'ThermostatEco.SetMode', { mode: 'OFF' });
}

/* ---------- the owner's own commands (mockup v), behind guardManual ---------- */
/**
 * Send one owner command. Checked by guardManual against the thermostat as last read; not subject to Autopilot's 2 °F step or
 * 30-minute slot, and it does not take that slot. What is sent is recorded (hold.ts) and written into `nest:last` at once, so the
 * app shows it and the next reading is not mistaken for somebody else's change. Returns the state as Solstice now expects it.
 */
export async function ownerCommand(c: ManualCommand): Promise<NestState> {
  const st = await kv.get<NestState>('nest:last'); if (!st?.deviceId) throw new Error('The thermostat has not been read yet');
  const g = guardManual(c, st); if (!g.ok) throw new GuardRefusal('ac', g.reason);
  const id = st.deviceId, now = Date.now(), next: NestState = { ...st };
  switch (c.kind) {
    case 'cool': await exec(id, 'ThermostatTemperatureSetpoint.SetCool', { coolCelsius: fToC(c.f) }); next.coolF = c.f; break;
    case 'heat': await exec(id, 'ThermostatTemperatureSetpoint.SetHeat', { heatCelsius: fToC(c.f) }); next.heatF = c.f; break;
    case 'range': await exec(id, 'ThermostatTemperatureSetpoint.SetRange', { heatCelsius: fToC(c.heatF), coolCelsius: fToC(c.coolF) }); next.heatF = c.heatF; next.coolF = c.coolF; break;
    case 'mode': await exec(id, 'ThermostatMode.SetMode', { mode: c.mode }); next.mode = c.mode; break;
    case 'eco': await exec(id, 'ThermostatEco.SetMode', { mode: c.on ? 'MANUAL_ECO' : 'OFF' }); next.eco = c.on; break;
    case 'fan': await exec(id, 'Fan.SetTimer', c.seconds ? { timerMode: 'ON', duration: `${c.seconds}s` } : { timerMode: 'OFF' }); next.fanTimer = c.seconds > 0; next.fanUntil = c.seconds ? now + c.seconds * 1000 : null; break;
  }
  if (c.kind !== 'eco' && c.kind !== 'fan') await recordSent(id, { at: now, by: 'owner', mode: next.mode, coolF: next.coolF, heatF: next.heatF });
  await kv.set('nest:last', next);
  return next;
}
