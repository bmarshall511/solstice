// Hard safety clamps for every device write: the Nest cooling setpoint (Autopilot) and the owner's own thermostat commands, the
// ScreenLogic pump speeds and schedules, and the Powerwall settings (backup reserve, operation mode, grid export rule).
// The owner confirmed these limits (audit question 4). No setting can widen them, and this file is the only place they live.
// Pure: each guard takes the intended write plus the current state and returns { ok, value, reason }. Callers log refusals.

export type Allowed<T> = { ok: true; value: T; reason: string | null; stepped: boolean };
export type Refused = { ok: false; value: null; reason: string; stepped: false };
export type Verdict<T> = Allowed<T> | Refused;

const allow = <T>(value: T, reason: string | null = null, stepped = false): Allowed<T> => ({ ok: true, value, reason, stepped });
const refuse = (reason: string): Refused => ({ ok: false, value: null, reason, stepped: false });

/** Thrown by a device client when a guard refuses a write, before anything is sent to the device. */
export class GuardRefusal extends Error {
  readonly device: 'ac' | 'pool' | 'powerwall';
  readonly reason: string;
  constructor(device: 'ac' | 'pool' | 'powerwall', reason: string) {
    super(`Safety guard refused the ${device === 'ac' ? 'thermostat' : device} write: ${explainRefusal(reason)}`);
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

/* ---------- AC during a Vacation-mode trip (mockup ak; owner, 2026-10-06) ---------- */
/** While away: cooling held 80–85 °F (85 by default; the humidity guard steps it down, never below 80); heating set back to 50–60 °F. */
export const TRIP_COOL = { min: 80, max: 85 }, TRIP_HEAT = { min: 50, max: 60 };
/**
 * A heating-setpoint write by Vacation mode. Away: the target must be inside 50–60 °F, and `valueF` (what is written now) must be a step
 * of at most 2 °F from the current setpoint toward it (so 68 → 66 → … → 55 passes through values above 60 on the way down). Restore:
 * the heat setpoint the thermostat had when the trip started, put back at the welcome or the end; it is the owner's own setting, so it is
 * checked against 50–80 °F only and goes in one write, as their own tap would. Both: Autopilot Off refuses, one write per 30 minutes,
 * an unknown current setpoint refuses.
 */
export function guardHeatSetpoint(o: { mode: string; targetF: number; valueF?: number; currentF: number | null | undefined; lastWriteAt: number | null | undefined; now: number; restore?: boolean }): Verdict<number> {
  const target = o.targetF, value = o.valueF ?? o.targetF, cur = o.currentF;
  if (o.mode === 'off') return refuse(AUTOPILOT_OFF);
  if (o.mode !== 'suggest' && o.mode !== 'auto') return refuse(`the AC Autopilot mode "${String(o.mode).replace(/[^\w -]/g, '')}" is not Off, Suggest or Auto`);
  if (!Number.isFinite(target) || !Number.isFinite(value)) return refuse(`the heat setpoint ${value} is not a temperature`);
  if (o.restore ? target < TRIP_HEAT.min || target > MANUAL_HEAT.max || value !== target : target < TRIP_HEAT.min || target > TRIP_HEAT.max)
    return refuse(`heat ${deg(target)} is outside the ${TRIP_HEAT.min}–${o.restore ? MANUAL_HEAT.max : TRIP_HEAT.max}° ${o.restore ? 'heat' : 'away heat'} range`);
  if (o.lastWriteAt != null && Number.isFinite(o.lastWriteAt) && o.now - o.lastWriteAt < AC_WRITE_INTERVAL_MS)
    return refuse(`one setpoint change per ${AC_WRITE_INTERVAL_MS / 60_000} min; the last was at ${clock(o.lastWriteAt)}`);
  if (cur == null || !Number.isFinite(cur)) return refuse(`the thermostat's current heat setpoint is unknown, so the ${AC_MAX_STEP_F}° step limit can't be checked`);
  if (o.restore) return allow(value);
  const lo = Math.min(cur, target) - EPS, hi = Math.max(cur, target) + EPS;
  if (value < lo || value > hi || Math.abs(value - cur) > AC_MAX_STEP_F + EPS) return refuse(`heat ${deg(value)} is not a ${AC_MAX_STEP_F}° step from ${deg(cur)} toward ${deg(target)}`);
  return allow(value, value === target ? null : `stepped: heat ${deg(cur)} → ${deg(target)} is more than ${AC_MAX_STEP_F}°, so ${deg(value)} now`, value !== target);
}
/** Vacation mode turning Nest's Eco off so it can hold its own setpoint: only during a trip under way, never with Autopilot Off. */
export function guardTripEco(o: { mode: string; tripAway: boolean }): Verdict<true> {
  if (o.mode === 'off') return refuse(AUTOPILOT_OFF);
  if (!o.tripAway) return refuse('Eco is only turned off for Vacation mode, while a trip is under way');
  return allow(true);
}

/* ---------- AC: the owner's own thermostat commands (mockup v; owner, 2026-10-04) ---------- */
// The owner's taps are checked only against these ranges: no 2 °F step and no 30-minute slot, and they never use up Autopilot's slot.
export const MANUAL_COOL = { min: 65, max: 85 }, MANUAL_HEAT = { min: 55, max: 80 }, RANGE_GAP_F = 3, FAN_MAX_S = 12 * 3600;
export const NEST_MODES = ['COOL', 'HEAT', 'HEATCOOL', 'OFF'] as const;
export type ManualCommand =
  | { kind: 'cool'; f: number } | { kind: 'heat'; f: number } | { kind: 'range'; heatF: number; coolF: number }
  | { kind: 'mode'; mode: typeof NEST_MODES[number] } | { kind: 'eco'; on: boolean } | { kind: 'fan'; seconds: number };
const inRange = (f: unknown, r: { min: number; max: number }) => typeof f === 'number' && Number.isFinite(f) && f >= r.min && f <= r.max;
/**
 * An owner command, checked against the thermostat as last read (`mode`, `availableModes`). A setpoint must match the mode it is for
 * (Nest refuses SetCool outside Cool), whole or half degrees; a range keeps heat at least 3 °F below cool; the fan runs 1 s–12 h or stops (0).
 */
export function guardManual(c: ManualCommand, st: { mode: string; availableModes?: string[]; eco?: boolean }): Verdict<ManualCommand> {
  const half = (f: number) => Math.round(f * 2) / 2 === f;
  switch (c?.kind) {
    case 'cool': case 'heat': {
      const r = c.kind === 'cool' ? MANUAL_COOL : MANUAL_HEAT, want = c.kind === 'cool' ? 'COOL' : 'HEAT';
      if (!inRange(c.f, r) || !half(c.f)) return refuse(`${c.kind === 'cool' ? 'cooling' : 'heating'} setpoints must be ${r.min}–${r.max}°`);
      if (st.eco) return refuse('the thermostat is in Eco; turn Eco off first');
      if (st.mode !== want) return refuse(`the thermostat is in ${st.mode}, not ${want}`);
      return allow(c);
    }
    case 'range':
      if (!inRange(c.heatF, MANUAL_HEAT) || !inRange(c.coolF, MANUAL_COOL) || !half(c.heatF) || !half(c.coolF)) return refuse(`heat must be ${MANUAL_HEAT.min}–${MANUAL_HEAT.max}° and cool ${MANUAL_COOL.min}–${MANUAL_COOL.max}°`);
      if (c.coolF - c.heatF < RANGE_GAP_F) return refuse(`keep heat at least ${RANGE_GAP_F}° below cool`);
      if (st.eco) return refuse('the thermostat is in Eco; turn Eco off first');
      if (st.mode !== 'HEATCOOL') return refuse(`the thermostat is in ${st.mode}, not Heat · Cool`);
      return allow(c);
    case 'mode':
      if (!(NEST_MODES as readonly string[]).includes(c.mode)) return refuse(`"${String(c.mode).replace(/[^\w -]/g, '')}" is not Cool, Heat, Heat · Cool or Off`);
      if (st.availableModes?.length && !st.availableModes.includes(c.mode)) return refuse(`this thermostat does not offer ${c.mode}`);
      return allow(c);
    case 'eco': return typeof c.on === 'boolean' ? allow(c) : refuse('eco must be on or off');
    case 'fan': return Number.isInteger(c.seconds) && c.seconds >= 0 && c.seconds <= FAN_MAX_S ? allow(c) : refuse(`the fan timer runs up to ${FAN_MAX_S / 3600} h`);
    default: return refuse('unknown thermostat command');
  }
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

/**
 * The owner's own pool commands (mockup w): any circuit on the controller on or off with a run time, and the speed of any circuit with a
 * pump slot. Wider than Autopilot's limits on purpose (the spa, lights, jets and blower are the owner's to switch); never freeze
 * protection, and pump speeds stay inside the pump's range. The run time is the controller's egg timer, 1 min to 12 h.
 */
export const POOL_RUN_MAX_MIN = 720, SPA_SET_MIN_F = 80, SPA_SET_MAX_F = 104, HEAT_MODE_OFF = 0, HEAT_MODE_HEATER = 3;
export type PoolOwnerCommand = { kind: 'circuit'; id: number; on: boolean; minutes?: number } | { kind: 'speed'; id: number; rpm: number }
  | { kind: 'spaHeat'; on: boolean; setF?: number };
export function guardOwnerPool(c: PoolOwnerCommand, ctx: Omit<PoolGuardContext, 'managed'> & { hasSpa?: boolean }): Verdict<PoolOwnerCommand> {
  if (c?.kind === 'spaHeat') {   // the spa's heater (frame 4): its setpoint 80–104 °F and heater on or off; it heats only while the Spa circuit runs
    if (!ctx.hasSpa) return refuse('this controller reports no spa');
    if (typeof c.on !== 'boolean') return refuse('heat must be on or off');
    if (c.on && !(Number.isInteger(c.setF) && c.setF! >= SPA_SET_MIN_F && c.setF! <= SPA_SET_MAX_F)) return refuse(`spa heat is set ${SPA_SET_MIN_F}–${SPA_SET_MAX_F}°`);
    return allow(c);
  }
  if (!c || !Number.isInteger(c.id)) return refuse('pick a circuit');
  const info = ctx.circuits.find(x => x.id === c.id);
  if (c.id === FREEZE_CIRCUIT || /freeze/i.test(info?.name ?? '')) return refuse('freeze protection is never switched');
  if (!info) return refuse(`${label(c.id)} is not on the controller`);
  switch (c.kind) {
    case 'circuit':
      if (typeof c.on !== 'boolean') return refuse('on must be true or false');
      if (c.on && !(Number.isInteger(c.minutes) && c.minutes! >= 1 && c.minutes! <= POOL_RUN_MAX_MIN)) return refuse(`run times are 1 min to ${POOL_RUN_MAX_MIN / 60} h`);
      return allow(c);
    case 'speed': {
      if (!ctx.pumpCircuits.includes(c.id)) return refuse(`${label(c.id, info)} has no pump speed`);
      const r = guardPumpRpm(c.rpm, pumpRpmLimits(ctx.minRpm, ctx.maxRpm)); return r.ok ? allow(c) : r;
    }
    default: return refuse('unknown pool command');
  }
}

/* ---------- Powerwall (Fleet API energy_cmds: backup reserve, operation mode, grid export rule) ---------- */
export const RESERVE_MIN = 10, RESERVE_MAX = 100, RESERVE_STORM_MIN = 20, PW_CHANGE_INTERVAL_MS = 3600_000;
export const EXPORT_RULES = ['battery_ok', 'pv_only'] as const;             // never 'never': the array must always be able to export
export const OPERATION_MODES = ['self_consumption', 'autonomous'] as const;
export type ExportRule = typeof EXPORT_RULES[number];
export type OperationMode = typeof OPERATION_MODES[number];
const since = (o: { lastChangeAt: number | null | undefined; now: number }, what: string) =>
  o.lastChangeAt != null && Number.isFinite(o.lastChangeAt) && o.now - o.lastChangeAt < PW_CHANGE_INTERVAL_MS
    ? `one ${what} change per hour; the last was at ${clock(o.lastChangeAt)}` : null;

/**
 * A backup reserve write. Refused (never clamped): not a whole percent, outside 10–100%, below 20% while an NWS storm alert or Storm
 * Watch is active (`storm`), or a reserve change less than an hour after the last one (`lastChangeAt`, from kv).
 */
export function guardReserve(o: { pct: number; storm: boolean; lastChangeAt: number | null | undefined; now: number }): Verdict<number> {
  if (!Number.isInteger(o.pct)) return refuse(`${o.pct}% is not a whole-number reserve`);
  if (o.pct < RESERVE_MIN || o.pct > RESERVE_MAX) return refuse(`${o.pct}% is outside the ${RESERVE_MIN}–${RESERVE_MAX}% reserve range`);
  if (o.storm && o.pct < RESERVE_STORM_MIN) return refuse(`never below ${RESERVE_STORM_MIN}% while a storm alert or Storm Watch is active`);
  const t = since(o, 'reserve'); if (t) return refuse(t);
  return allow(o.pct);
}
/** The grid export rule: only 'battery_ok' or 'pv_only', at most one change an hour. */
export function guardExportRule(o: { rule: string; lastChangeAt: number | null | undefined; now: number }): Verdict<ExportRule> {
  if (!(EXPORT_RULES as readonly string[]).includes(o.rule)) return refuse(`the export rule "${String(o.rule).replace(/[^\w -]/g, '')}" is not battery_ok or pv_only`);
  const t = since(o, 'export rule'); if (t) return refuse(t);
  return allow(o.rule as ExportRule);
}
/** The operation mode: only self-powered or time-based control, at most one change an hour. */
export function guardOperationMode(o: { mode: string; lastChangeAt: number | null | undefined; now: number }): Verdict<OperationMode> {
  if (!(OPERATION_MODES as readonly string[]).includes(o.mode)) return refuse(`the operation mode "${String(o.mode).replace(/[^\w -]/g, '')}" is not self_consumption or autonomous`);
  const t = since(o, 'operation mode'); if (t) return refuse(t);
  return allow(o.mode as OperationMode);
}
