// A synthetic ScreenLogic snapshot (the PoolSnapshot type from server/src/appliances/screenlogic.ts). Hand-written:
// pump id 1; pump circuits Pool 6 @1500, High Speed 8 @2400, Waterfall 5 @3000, Spa 1 @3190 and ScreenLogic's virtual
// freeze-protection circuit 132; three schedules (two pump programs and a light that the pump model must ignore).
import type { PoolSnapshot } from '../../server/src/appliances/screenlogic.js';

export const CIRCUITS = [
  { id: 1, name: 'Spa' }, { id: 2, name: 'Blower' }, { id: 3, name: 'Pool Light' }, { id: 4, name: 'Spa Light' },
  { id: 5, name: 'Waterfall' }, { id: 6, name: 'Pool' }, { id: 8, name: 'High Speed' },
];

export function poolSnapshot(at: number, o: { on?: number[]; rpm?: number; watts?: number; running?: boolean; waterF?: number; schedules?: PoolSnapshot['schedules'] } = {}): PoolSnapshot {
  const on = new Set(o.on ?? [6]);
  return {
    at, version: 'POOL: 0.0 Build 000.0 Rel', airTemp: 85, freezeMode: false,
    bodies: [
      { id: 1, temp: o.waterF ?? 88, setPoint: 0, heatMode: 0, heating: false },
      { id: 2, temp: 95, setPoint: 102, heatMode: 0, heating: false },
    ],
    circuits: CIRCUITS.map(c => ({ ...c, on: on.has(c.id), freeze: false, function: 0 })),
    pump: {
      id: 1, name: 'Pump 1', running: o.running ?? true, watts: o.watts ?? 153, rpm: o.rpm ?? 1500, gpm: null, minRpm: 450, maxRpm: 3450, primingRpm: 2500,
      circuits: [
        { circuitId: 6, speed: 1500, isRpm: true }, { circuitId: 8, speed: 2400, isRpm: true }, { circuitId: 5, speed: 3000, isRpm: true },
        { circuitId: 1, speed: 3190, isRpm: true }, { circuitId: 132, speed: 1000, isRpm: true },
      ],
    },
    schedules: o.schedules ?? [
      { id: 1, circuitId: 6, start: 480, stop: 1020, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
      { id: 2, circuitId: 8, start: 720, stop: 780, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
      { id: 3, circuitId: 3, start: 1140, stop: 1320, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
    ],
  };
}

/**
 * A fake, read-only ScreenLogic session for readPool(run): answers the six status calls readPool makes with synthetic raw
 * responses (pump id 1 at 1500 RPM / 153 W; Pool 10:00–19:00, High Speed 14:00–15:00) and throws on any method that is not a
 * `get…Async` read, so a write can never slip through. `calls` records each call with the netTimeout in force when it was made.
 */
export function readOnlyUnit() {
  const calls: Array<{ path: string; netTimeout: unknown }> = [];
  const raw: Record<string, unknown> = {
    getVersionAsync: { version: 'POOL: 0.0 Build 000.0 Rel' },
    'equipment.getEquipmentStateAsync': { airTemp: 85, freezeMode: 0, circuitArray: [{ id: 6, state: 1 }, { id: 8, state: 0 }],
      bodies: [{ id: 1, currentTemp: 88, setPoint: 0, heatMode: 0, heatStatus: 0 }] },
    'equipment.getControllerConfigAsync': { circuitArray: [{ circuitId: 6, name: 'Pool', freeze: 0, function: 2 }, { circuitId: 8, name: 'High Speed', freeze: 0, function: 0 }] },
    'equipment.getEquipmentConfigurationAsync': { pumps: [{ id: 1, type: 3, name: 'Pump 1', minSpeed: 450, maxSpeed: 3450, primingSpeed: 2500, circuits: [] }] },
    'schedule.getScheduleDataAsync': { data: [
      { scheduleId: 1, circuitId: 6, startTime: '1000', stopTime: '1900', dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
      { scheduleId: 2, circuitId: 8, startTime: '1400', stopTime: '1500', dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 }] },
    'pump.getPumpStatusAsync': { isRunning: true, pumpWatts: 153, pumpRPMs: 1500, pumpGPMs: 255,
      pumpCircuits: [{ circuitId: 6, speed: 1500, isRPMs: true }, { circuitId: 8, speed: 2400, isRPMs: true }] },
  };
  const state: { netTimeout?: unknown } = {};
  const node = (path: string): any => new Proxy(() => {}, {
    get: (_t, k) => typeof k === 'symbol' || k === 'then' ? undefined : path === '' && k === 'netTimeout' ? state.netTimeout : node(path ? `${path}.${k}` : k),
    set: (_t, k, v) => { if (path === '' && k === 'netTimeout') { state.netTimeout = v; return true; } throw new Error(`read-only session: set ${String(k)}`); },
    apply: async () => {
      calls.push({ path, netTimeout: state.netTimeout });
      if (!/(^|\.)get[A-Z]\w*Async$/.test(path)) throw new Error(`read-only session: ${path} is not a read`);
      if (!(path in raw)) throw new Error(`read-only session: no fake answer for ${path}`);
      return JSON.parse(JSON.stringify(raw[path]));
    },
  });
  const conn = node('');
  return { conn, calls, run: async <T>(fn: (c: any) => Promise<T>) => fn(conn) };
}
