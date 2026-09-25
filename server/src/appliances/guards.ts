// Hard safety clamps for every device write: the Nest cooling setpoint and the ScreenLogic pump speeds and schedules.
// The owner confirmed these limits (audit question 4). No setting can widen them, and this file is the only place they live.
// Pure: each guard takes the intended write plus the current state and returns { ok, value, reason }. Callers log refusals.

export type Allowed<T> = { ok: true; value: T; reason: string | null; stepped: boolean };
export type Refused = { ok: false; value: null; reason: string; stepped: false };
export type Verdict<T> = Allowed<T> | Refused;

const allow = <T>(value: T, reason: string | null = null, stepped = false): Allowed<T> => ({ ok: true, value, reason, stepped });
const refuse = (reason: string): Refused => ({ ok: false, value: null, reason, stepped: false });

/** Thrown by a device client when a guard refuses a write, before anything is sent to the device. */
export class GuardRefusal extends Error {
  readonly device: 'ac' | 'pool';
  readonly reason: string;
  constructor(device: 'ac' | 'pool', reason: string) {
    super(`Safety guard refused the ${device === 'ac' ? 'thermostat' : 'pool'} write: ${explainRefusal(reason)}`);
    this.name = 'GuardRefusal'; this.device = device; this.reason = reason;
  }
}

/* ---------- AC (Nest cooling setpoint) ---------- */
export const AC_MIN_F = 65, AC_MAX_F = 85, AC_MAX_STEP_F = 2, AC_WRITE_INTERVAL_MS = 30 * 60_000;
/** AC Autopilot Off means no writes to Nest at all, including the rest of a plan approved earlier the same day (owner, 2026-09-25). */
export const AUTOPILOT_OFF = 'autopilot_off';
const EPS = 1e-6;
const deg = (f: number) => `${Math.round(f * 10) / 10}°`;
const clock = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)).replace(/\s/g, ' ');
const inAcRange = (f: number) => f >= AC_MIN_F && f <= AC_MAX_F;
/** A refusal reason as a sentence for the activity log (the Off rule's reason is the bare code). */
export const explainRefusal = (reason: string) => reason === AUTOPILOT_OFF ? `AC Autopilot is Off, so Solstice makes no thermostat changes (${AUTOPILOT_OFF})` : reason;

/**
 * A cooling-setpoint write. `mode` is the AC Autopilot setting; `targetF` is where the caller is heading; `valueF` (default `targetF`)
 * is what it wants to write now; `currentF` is the thermostat's setpoint as last read; `lastWriteAt` is when Solstice last wrote this
 * thermostat (from kv). Refused: Autopilot Off (reason 'autopilot_off'), target or value outside 65–85 °F, a write less than
 * 30 minutes ago, or an unknown current setpoint. Stepped: a value more than 2 °F from the current setpoint becomes the 2 °F step
 * toward it (ok, stepped: true). Suggest and Auto are otherwise treated alike: approval is the caller's business, not the guard's.
 */
export function guardCoolSetpoint(o: { mode: string; targetF: number; valueF?: number; currentF: number | null | undefined; lastWriteAt: number | null | undefined; now: number }): Verdict<number> {
  const target = o.targetF, value = o.valueF ?? o.targetF, cur = o.currentF;
  if (o.mode === 'off') return refuse(AUTOPILOT_OFF);
  if (o.mode !== 'suggest' && o.mode !== 'auto') return refuse(`the AC Autopilot mode "${String(o.mode).replace(/[^\w -]/g, '')}" is not Off, Suggest or Auto`);
  if (!Number.isFinite(target) || !Number.isFinite(value)) return refuse(`the setpoint ${value} is not a temperature`);
  if (!inAcRange(target)) return refuse(`the target ${deg(target)} is outside the ${AC_MIN_F}–${AC_MAX_F}° safety range`);
  if (!inAcRange(value)) return refuse(`${deg(value)} is outside the ${AC_MIN_F}–${AC_MAX_F}° safety range`);
  if (o.lastWriteAt != null && Number.isFinite(o.lastWriteAt) && o.now - o.lastWriteAt < AC_WRITE_INTERVAL_MS)
    return refuse(`one setpoint change per ${AC_WRITE_INTERVAL_MS / 60_000} min; the last was at ${clock(o.lastWriteAt)}`);
  if (cur == null || !Number.isFinite(cur)) return refuse(`the thermostat's current setpoint is unknown, so the ${AC_MAX_STEP_F}° step limit can't be checked`);
  if (Math.abs(value - cur) <= AC_MAX_STEP_F + EPS) return allow(value);
  const step = Math.round((cur + Math.sign(value - cur) * AC_MAX_STEP_F) * 10) / 10;
  if (!inAcRange(step)) return refuse(`the ${AC_MAX_STEP_F}° step from ${deg(cur)} toward ${deg(value)} would be ${deg(step)}, outside the ${AC_MIN_F}–${AC_MAX_F}° safety range`);
  return allow(step, `stepped: ${deg(cur)} → ${deg(value)} is more than ${AC_MAX_STEP_F}°, so ${deg(step)} now`, true);
}

/* ---------- Pool (ScreenLogic pump speeds and schedules) ---------- */
export const RPM_HARD_MIN = 450, RPM_HARD_MAX = 3450; // IntelliFlo VSF range, used when the controller reports no limits
export const FREEZE_CIRCUIT = 132;                   // ScreenLogic's virtual "freeze protection" pump circuit
export const HEAT_CMD_UNCHANGED = 4;                 // schedule heat command "don't change" (node-screenlogic HEAT_MODE_DONTCHANGE)
const SPA_FUNCTIONS = new Set([1, 3]);                                 // Pentair circuit functions: Spa, Second spa
const LIGHT_FUNCTIONS = new Set([7, 8, 9, 10, 11, 12, 16, 17]);        // Light, Dimmer, SAm, SAL, Photon Gen, Color Wheel, IntelliBrite, MagicStream

export type PoolCircuitInfo = { id: number; name: string; function: number };
/** What the guard knows about the controller (from the snapshot the caller already read) and which circuits Autopilot manages. */
export type PoolGuardContext = { circuits: PoolCircuitInfo[]; pumpCircuits: number[]; minRpm?: number | null; maxRpm?: number | null; managed: number[] };
export type PoolScheduleWrite = { circuitId: number; start: number; stop: number; dayMask?: number; flags?: number; heatCmd?: number; heatSetPoint?: number };
export type PoolWrite = { speeds: Array<{ circuitId: number; rpm: number }>; replaceCircuits: number[]; schedules: PoolScheduleWrite[] };

// circuit names are rendered with innerHTML in the activity log, so keep them to plain text
const label = (id: number, c?: PoolCircuitInfo) => c?.name ? `circuit ${id} (${c.name.replace(/[<>&"'`]/g, '').trim()})` : `circuit ${id}`;

/** The pump's usable RPM range: the controller's min/max when it reports a sane pair, never wider than the IntelliFlo VSF range. */
export function pumpRpmLimits(minRpm?: number | null, maxRpm?: number | null) {
  const reported = Number.isFinite(minRpm) && Number.isFinite(maxRpm) && minRpm! > 0 && maxRpm! > minRpm!;
  return reported ? { min: Math.max(minRpm!, RPM_HARD_MIN), max: Math.min(maxRpm!, RPM_HARD_MAX), source: 'controller' as const }
    : { min: RPM_HARD_MIN, max: RPM_HARD_MAX, source: 'IntelliFlo VSF' as const };
}

/** A pump speed: a whole number of RPM inside the pump's range. Never clamped. */
export function guardPumpRpm(rpm: number, limits: { min: number; max: number }): Verdict<number> {
  if (!Number.isInteger(rpm)) return refuse(`${rpm} RPM is not a whole-number pump speed`);
  if (rpm < limits.min || rpm > limits.max) return refuse(`${rpm} RPM is outside the pump's ${limits.min}–${limits.max} RPM range`);
  return allow(rpm);
}

/** Why a circuit may never be written (freeze protection, heater, lights, spa, spa-related), or null. */
export function forbiddenCircuit(id: number, c?: PoolCircuitInfo): string | null {
  const name = c?.name ?? '', fn = c?.function ?? -1;
  if (id === FREEZE_CIRCUIT || /freeze/i.test(name)) return 'freeze protection';
  if (/heat/i.test(name)) return 'a heater circuit';
  if (LIGHT_FUNCTIONS.has(fn) || /light|lite/i.test(name)) return 'a light';
  if (SPA_FUNCTIONS.has(fn) || /\bspa/i.test(name)) return 'the spa';
  if (/blow|jet|bubbl|spill/i.test(name)) return 'spa-related (blower, jets or spillway)';
  return null;
}

/** A circuit touched by a pool write (a speed, a new schedule or a replaced schedule). */
export function guardPoolCircuit(id: number, ctx: PoolGuardContext): Verdict<number> {
  if (!Number.isInteger(id)) return refuse(`${id} is not a circuit id`);
  const c = ctx.circuits.find(x => x.id === id), bad = forbiddenCircuit(id, c);
  if (bad) return refuse(`${label(id, c)} is ${bad} and is never written`);
  if (!c) return refuse(`${label(id)} is not on the controller`);
  if (!ctx.managed.includes(id)) return refuse(`${label(id, c)} is not one of the pump circuits Autopilot manages (${ctx.managed.join(', ')})`);
  if (!ctx.pumpCircuits.includes(id)) return refuse(`${label(id, c)} has no pump speed slot`);
  return allow(id);
}

/** A schedule event: never a heat command or heat set point (heatCmd must be "don't change"). */
export function guardPoolSchedule(s: PoolScheduleWrite, ctx: PoolGuardContext): Verdict<PoolScheduleWrite> {
  const c = guardPoolCircuit(s.circuitId, ctx); if (!c.ok) return c;
  if (s.heatCmd != null && s.heatCmd !== HEAT_CMD_UNCHANGED) return refuse(`a schedule for ${label(s.circuitId, ctx.circuits.find(x => x.id === s.circuitId))} would change the heat mode (heat command ${s.heatCmd})`);
  return allow(s);
}

/** A whole pool write, checked before anything is sent: all or nothing, with every reason. */
export function guardPoolWrite<W extends PoolWrite>(w: W, ctx: PoolGuardContext): Verdict<W> {
  const limits = pumpRpmLimits(ctx.minRpm, ctx.maxRpm), why: string[] = [];
  const note = (v: Verdict<unknown>) => { if (!v.ok && !why.includes(v.reason)) why.push(v.reason); };
  for (const s of w.speeds) { note(guardPoolCircuit(s.circuitId, ctx)); note(guardPumpRpm(s.rpm, limits)); }
  for (const s of w.schedules) note(guardPoolSchedule(s, ctx));
  for (const id of w.replaceCircuits) note(guardPoolCircuit(id, ctx));
  return why.length ? refuse(why.join('; ')) : allow(w);
}
