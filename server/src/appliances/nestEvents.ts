// Nest change events through Google Cloud Pub/Sub (owner decision Q3 of docs/audit-2026-10.md): the thermostat tells Solstice within
// seconds when its mode, setpoint, Eco, HVAC state, temperature or humidity changes, so a manual change is held at once instead of up to
// 15 minutes later. Setup (outside the repo): a topic in the owner's GCP project that Google's SDM publisher group may publish to, the
// Device Access project pointed at it, and a push subscription to POST /api/nest/events that signs each push with a service account's
// OIDC token. This module verifies that token (Google's keys, our audience, our service account), decodes the event and merges its
// traits into the stored thermostat state. Read-only towards Nest: an event never sends a command.
import { createPublicKey, verify as verifySig } from 'node:crypto';
import { kv } from '../db.js';
import { cToF, type NestState } from './nest.js';

/* ---------- the push's OIDC token ---------- */
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };
let jwks: { at: number; keys: Jwk[] } | null = null;
async function googleKeys(force = false): Promise<Jwk[]> {
  if (!force && jwks && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`Google certs: HTTP ${r.status}`);
  jwks = { at: Date.now(), keys: ((await r.json()) as { keys: Jwk[] }).keys ?? [] };
  return jwks.keys;
}
const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
/**
 * Why a Pub/Sub push's Bearer token is not acceptable, or null: RS256 signed by one of Google's current keys, issued by Google, for
 * `audience`, from `email` (verified), and not expired. `keys` is injectable for tests.
 */
export async function oidcError(token: string, o: { audience: string; email: string; now?: number; keys?: Jwk[] }): Promise<string | null> {
  const parts = token.split('.'); if (parts.length !== 3) return 'not a JWT';
  let head: any, claims: any;
  try { head = b64json(parts[0]); claims = b64json(parts[1]); } catch { return 'unreadable JWT'; }
  if (head.alg !== 'RS256' || !head.kid) return 'not an RS256 token';
  let keys = o.keys ?? await googleKeys(), jwk = keys.find(k => k.kid === head.kid);
  if (!jwk && !o.keys) { keys = await googleKeys(true); jwk = keys.find(k => k.kid === head.kid); }   // Google rotated its keys
  if (!jwk) return 'unknown signing key';
  const ok = verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk as any, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) return 'bad signature';
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (!ISSUERS.has(claims.iss)) return 'wrong issuer';
  if (claims.aud !== o.audience) return 'wrong audience';
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) return 'expired';
  if (claims.email !== o.email || claims.email_verified !== true) return 'wrong service account';
  return null;
}

/* ---------- the event ---------- */
export type SdmEvent = { eventId?: string; timestamp?: string; resourceUpdate?: { name: string; traits?: Record<string, any> }; relationUpdate?: unknown };
/** The SDM event inside a Pub/Sub push body ({ message: { data: base64 JSON } }), or null. */
export function eventOf(body: any): SdmEvent | null {
  const data = body?.message?.data; if (typeof data !== 'string') return null;
  try { return JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch { return null; }
}
const SETTING_TRAITS = ['ThermostatMode', 'ThermostatTemperatureSetpoint', 'ThermostatEco'];
/** Whether an event changes something a person sets (mode, setpoint, Eco), as opposed to a reading (temperature, humidity, HVAC). */
export const isSettingEvent = (e: SdmEvent) => SETTING_TRAITS.some(t => `sdm.devices.traits.${t}` in (e.resourceUpdate?.traits ?? {}));
/**
 * The stored thermostat state with an event's traits merged in, dated by the event. Only traits in the event change; within a trait the
 * event carries its whole current value (a setpoint trait without coolCelsius means there is no cooling setpoint in that mode).
 */
export function applyTraits(prev: NestState, traits: Record<string, any>, at: number): NestState {
  const T = (k: string) => traits[`sdm.devices.traits.${k}`], has = (k: string) => T(k) !== undefined, f = (c: unknown) => typeof c === 'number' ? cToF(c) : null;
  const s: NestState = { ...prev, at };
  if (has('ThermostatMode')) { s.mode = T('ThermostatMode').mode ?? s.mode; if (T('ThermostatMode').availableModes) s.availableModes = T('ThermostatMode').availableModes; }
  if (has('ThermostatTemperatureSetpoint')) { s.coolF = f(T('ThermostatTemperatureSetpoint').coolCelsius); s.heatF = f(T('ThermostatTemperatureSetpoint').heatCelsius); }
  if (has('ThermostatEco')) { s.eco = T('ThermostatEco').mode === 'MANUAL_ECO'; if ('coolCelsius' in T('ThermostatEco')) s.ecoCoolF = f(T('ThermostatEco').coolCelsius); if ('heatCelsius' in T('ThermostatEco')) s.ecoHeatF = f(T('ThermostatEco').heatCelsius); }
  if (has('ThermostatHvac')) s.hvac = T('ThermostatHvac').status ?? s.hvac;
  if (has('Temperature') && typeof T('Temperature').ambientTemperatureCelsius === 'number') s.indoorF = f(T('Temperature').ambientTemperatureCelsius);
  if (has('Humidity') && typeof T('Humidity').ambientHumidityPercent === 'number') s.humidity = T('Humidity').ambientHumidityPercent;
  if (has('Connectivity')) s.online = T('Connectivity').status === 'ONLINE';
  if (has('Fan')) { s.fanTimer = T('Fan').timerMode === 'ON'; s.fanUntil = s.fanTimer && T('Fan').timerTimeout ? Date.parse(T('Fan').timerTimeout) || null : null; }
  return s;
}
/** Event ids already applied (Pub/Sub delivers at least once), kept for a day. */
export async function seenEvent(id: string | undefined) {
  if (!id) return false;
  const key = 'nest:eventIds', seen = await kv.get<Record<string, number>>(key) ?? {}, now = Date.now();
  if (seen[id]) return true;
  await kv.set(key, Object.fromEntries([...Object.entries(seen).filter(([, t]) => now - t < 864e5).slice(-200), [id, now]]));
  return false;
}
