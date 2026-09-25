// Pentair ScreenLogic (EasyTouch/IntelliTouch) over Pentair's remote dispatcher, using node-screenlogic.
// Serverless-friendly: every call opens a connection, does its work and closes. Credentials come from the environment only.
import { RemoteLogin, UnitConnection } from 'node-screenlogic';
import { guardPoolWrite, GuardRefusal, HEAT_CMD_UNCHANGED, type PoolGuardContext } from './guards.js';

export type PoolSchedule = { id: number; circuitId: number; start: number; stop: number; dayMask: number; flags: number; heatCmd: number; heatSetPoint: number };
export type PoolSnapshot = {
  at: number; version: string; airTemp: number; freezeMode: boolean;
  bodies: Array<{ id: number; temp: number; setPoint: number; heatMode: number; heating: boolean }>;
  circuits: Array<{ id: number; name: string; on: boolean; freeze: boolean; function: number }>;
  pump: { id: number; name: string; running: boolean; watts: number; rpm: number; gpm: number | null; minRpm: number; maxRpm: number; primingRpm: number;
    circuits: Array<{ circuitId: number; speed: number; isRpm: boolean }> } | null;
  schedules: PoolSchedule[];
};

export const configured = () => !!(process.env.SCREENLOGIC_SYSTEM && process.env.SCREENLOGIC_PASSWORD);
const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));

/** Open a session, run `fn`, always close. */
export async function withUnit<T>(fn: (c: UnitConnection) => Promise<T>): Promise<T> {
  const name = process.env.SCREENLOGIC_SYSTEM!, pass = process.env.SCREENLOGIC_PASSWORD!;
  const gw = new RemoteLogin(name);
  const g = await gw.connectAsync().finally(() => gw.closeAsync().catch(() => {}));
  if (!g?.gatewayFound || !g.ipAddr) throw new Error(`ScreenLogic: system "${name}" not found via Pentair`);
  const c = new UnitConnection(); c.init(name, g.ipAddr, g.port, pass);
  await c.connectAsync();
  try { return await fn(c); } finally { await c.closeAsync().catch(() => {}); }
}

/**
 * Read-only status: versions, equipment state, circuits, pump status and schedules. No command here changes the controller.
 * Uses the 8000 ms netTimeout (Pentair's dispatcher can take longer than the library's 2.5 s default). `run` opens the
 * ScreenLogic session (tests pass a fake).
 */
export async function readPool(run: typeof withUnit = withUnit): Promise<PoolSnapshot> {
  return run(async c => {
    (c as any).netTimeout = 8000;
    const [ver, st, ctl, cfg, sched] = await Promise.all([c.getVersionAsync(), c.equipment.getEquipmentStateAsync(), c.equipment.getControllerConfigAsync(),
      c.equipment.getEquipmentConfigurationAsync(), c.schedule.getScheduleDataAsync(0)]);
    const on = new Map(st.circuitArray.map((x: any) => [x.id, !!x.state]));
    const circuits = ctl.circuitArray.map((x: any) => ({ id: x.circuitId, name: x.name, on: on.get(x.circuitId) ?? false, freeze: !!x.freeze, function: x.function }));
    let pump: PoolSnapshot['pump'] = null;
    const p0 = (cfg as any).pumps?.find((p: any) => p.type);
    if (p0) {
      // pump ids are 1-based on this firmware (0 times out)
      const s = await c.pump.getPumpStatusAsync(p0.id).catch(() => null) as any;
      pump = { id: p0.id, name: p0.name, running: !!s?.isRunning, watts: s?.pumpWatts ?? 0, rpm: s?.pumpRPMs ?? 0, gpm: s && s.pumpGPMs !== 255 ? s.pumpGPMs : null,
        minRpm: p0.minSpeed, maxRpm: p0.maxSpeed, primingRpm: p0.primingSpeed,
        circuits: (s?.pumpCircuits ?? p0.circuits.map((x: any) => ({ circuitId: x.circuit, speed: x.speed, isRPMs: x.units === 0 })))
          .filter((x: any) => x.circuitId).map((x: any) => ({ circuitId: x.circuitId, speed: x.speed, isRpm: !!x.isRPMs })) };
    }
    return { at: Date.now(), version: ver.version, airTemp: st.airTemp, freezeMode: !!st.freezeMode,
      bodies: st.bodies.map((b: any) => ({ id: b.id, temp: b.currentTemp, setPoint: b.setPoint, heatMode: b.heatMode, heating: !!b.heatStatus })),
      circuits, pump, schedules: sched.data.map((e: any) => ({ id: e.scheduleId, circuitId: e.circuitId, start: hhmm(e.startTime), stop: hhmm(e.stopTime), dayMask: e.dayMask, flags: e.flags, heatCmd: e.heatCmd, heatSetPoint: e.heatSetPoint })) };
  });
}

export type ScheduleWrite = { circuitId: number; start: number; stop: number; dayMask?: number };
/**
 * Write a plan safely: add the new schedules first, then set pump speeds, then remove the old schedules of the replaced circuits.
 * Pump speeds are addressed by the SLOT INDEX in the pump's circuit list (not the circuit id), and a slow acknowledgement is
 * verified against the pump status rather than treated as a failure. Returns what was removed (for restore).
 * The safety guard (guards.ts) checks every circuit, speed and schedule before the controller is contacted; a refusal throws
 * GuardRefusal and nothing is written. `run` opens the ScreenLogic session (tests pass a fake).
 */
export async function writePoolPlan(opts: { pumpId: number; speeds: Array<{ circuitId: number; rpm: number }>; replaceCircuits: number[]; schedules: ScheduleWrite[]; guard: PoolGuardContext },
  run: typeof withUnit = withUnit) {
  // flags 0, heat command "don't change", set point 70: a schedule never touches the heater
  const rows = opts.schedules.map(s => ({ circuitId: s.circuitId, start: s.start, stop: s.stop, dayMask: s.dayMask ?? 127, flags: 0, heatCmd: HEAT_CMD_UNCHANGED, heatSetPoint: 70 }));
  const g = guardPoolWrite({ speeds: opts.speeds, replaceCircuits: opts.replaceCircuits, schedules: rows }, opts.guard);
  if (!g.ok) throw new GuardRefusal('pool', g.reason);
  return run(async c => {
    (c as any).netTimeout = 8000;
    const before = (await c.schedule.getScheduleDataAsync(0)).data as any[];
    const removed = before.filter(e => opts.replaceCircuits.includes(e.circuitId));
    const added: number[] = [];
    for (const s of rows) {
      const id = (await c.schedule.addNewScheduleEventAsync(0)).val;
      await c.schedule.setScheduleEventByIdAsync(id, s.circuitId, s.start, s.stop, s.dayMask, s.flags, s.heatCmd, s.heatSetPoint);
      added.push(id);
    }
    const status = await c.pump.getPumpStatusAsync(opts.pumpId) as any;
    const slots: Array<{ circuitId: number; speed: number }> = status.pumpCircuits;
    for (const s of opts.speeds) {
      const idx = slots.findIndex(x => x.circuitId === s.circuitId);
      if (idx < 0) throw new Error(`Circuit ${s.circuitId} has no pump speed slot on the controller`);
      if (slots[idx].speed === s.rpm) continue;
      try { await c.pump.setPumpSpeedAsync(opts.pumpId, idx, s.rpm, true); }
      catch (e: any) { // slow ack: check whether it took anyway
        const now = ((await c.pump.getPumpStatusAsync(opts.pumpId)) as any).pumpCircuits[idx];
        if (!now || now.speed !== s.rpm) throw new Error(`Pump speed for circuit ${s.circuitId} did not take (${e.message})`);
      }
    }
    for (const e of removed) if (!added.includes(e.scheduleId)) await c.schedule.deleteScheduleEventByIdAsync(e.scheduleId);
    return { removed: removed.map(e => ({ id: e.scheduleId, circuitId: e.circuitId, start: hhmm(e.startTime), stop: hhmm(e.stopTime), dayMask: e.dayMask })), added };
  });
}
