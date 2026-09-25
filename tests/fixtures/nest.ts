// A synthetic Nest thermostat state (the NestState type from server/src/appliances/nest.ts). Hand-written.
import type { NestState } from '../../server/src/appliances/nest.js';

export function nestState(at: number, o: Partial<NestState> = {}): NestState {
  return {
    at, deviceId: 'dev-test', name: 'Hallway', online: true, indoorF: 76, humidity: 45, mode: 'COOL', hvac: 'OFF',
    coolF: 80, heatF: null, eco: false, ecoCoolF: null, ecoHeatF: null, fanTimer: false, availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'],
    ...o,
  };
}
