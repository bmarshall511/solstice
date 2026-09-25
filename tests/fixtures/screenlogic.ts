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
