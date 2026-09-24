// Pentair ScreenLogic (EasyTouch/IntelliTouch) over Pentair's remote dispatcher, using node-screenlogic.
// Serverless-friendly: every call opens a connection, does its work and closes. Credentials come from the environment only.
import { RemoteLogin, UnitConnection } from 'node-screenlogic';

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

export async function readPool(): Promise<PoolSnapshot> {
  return withUnit(async c => {
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
 * Replace the schedules of the given circuits and set pump speeds per circuit. Returns the schedules that were removed (for restore).
 * Only touches the circuits named; everything else on the controller is left alone.
 */
export async function writePoolPlan(opts: { pumpId: number; speeds: Array<{ circuitId: number; rpm: number }>; replaceCircuits: number[]; schedules: ScheduleWrite[] }) {
  return withUnit(async c => {
    const before = (await c.schedule.getScheduleDataAsync(0)).data as any[];
    const removed = before.filter(e => opts.replaceCircuits.includes(e.circuitId));
    for (const e of removed) await c.schedule.deleteScheduleEventByIdAsync(e.scheduleId);
    for (const s of opts.speeds) await c.pump.setPumpSpeedAsync(opts.pumpId, s.circuitId, s.rpm, true);
    const added: number[] = [];
    for (const s of opts.schedules) {
      const id = (await c.schedule.addNewScheduleEventAsync(0)).val;
      await c.schedule.setScheduleEventByIdAsync(id, s.circuitId, s.start, s.stop, s.dayMask ?? 127, 0, 4, 70);
      added.push(id);
    }
    return { removed: removed.map(e => ({ id: e.scheduleId, circuitId: e.circuitId, start: hhmm(e.startTime), stop: hhmm(e.stopTime), dayMask: e.dayMask })), added };
  });
}
