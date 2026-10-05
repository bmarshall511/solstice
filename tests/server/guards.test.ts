// Safety clamps (server/src/appliances/guards.ts) and proof that every device write path calls them.
// Pure tables first, then the write paths with the database, the ScreenLogic session and the Nest SDM API replaced by in-memory
// fakes: node-screenlogic is mocked to throw if anything tries to connect, and fetch only answers the fake SDM URL. Nothing here can
// reach a device, Google or Neon. All fixtures are synthetic.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  guardCoolSetpoint, guardPumpRpm, guardPoolCircuit, guardPoolSchedule, guardPoolWrite, pumpRpmLimits, explainRefusal,
  GuardRefusal, AUTOPILOT_OFF, AC_WRITE_INTERVAL_MS, type PoolGuardContext,
} from '../../server/src/appliances/guards.js';

/* ---------- fakes (hoisted so the vi.mock factories can use them) ---------- */
const H = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  // the kv statements db.ts and nest.ts send; everything else (readings, energy, events) reads as empty
  const q = async (text: string, params: unknown[] = []): Promise<any[]> => {
    if (/SELECT value FROM kv WHERE key/.test(text)) { const v = store.get(String(params[0])); return v === undefined ? [] : [{ value: clone(v) }]; }
    if (/INSERT INTO kv/.test(text)) {
      const key = String(params[0]), value = JSON.parse(String(params[1]));
      if (/RETURNING/.test(text)) { // nest.ts claimSetpointWrite: conditional upsert
        const prev = store.get(key) as { at?: number } | undefined;
        if (prev && Number(prev.at ?? 0) > Number(params[2])) return [];
        store.set(key, value); return [{ key }];
      }
      store.set(key, value); return [];
    }
    if (/FROM readings/.test(text)) return readings.spare;                                     // ac.ts spareSolarW: set per test
    return [];
  };
  const readings: { spare: any[] } = { spare: [] };
  const kv = { get: async (k: string) => clone(store.get(k)) as any, set: async (k: string, v: unknown) => { store.set(k, clone(v)); } };
  const db = { q, one: async (t: string, p: unknown[] = []) => (await q(t, p))[0], kv, migrate: async () => {} };

  // a ScreenLogic session: records every call, never touches a network
  const calls: unknown[][] = [];
  const slots = () => [[6, 1800], [8, 3000], [5, 3400], [1, 3190], [9, 2000], [7, 3000], [132, 1000], [0, 0]].map(([circuitId, speed]) => ({ circuitId, speed, isRPMs: true }));
  let pump = slots(), nextId = 20;
  const conn = {
    schedule: {
      getScheduleDataAsync: async () => { calls.push(['getSchedules']); return { data: [
        { scheduleId: 1, circuitId: 6, startTime: '0800', stopTime: '1700', dayMask: 127 },
        { scheduleId: 2, circuitId: 8, startTime: '1200', stopTime: '1800', dayMask: 127 },
        { scheduleId: 3, circuitId: 5, startTime: '0000', stopTime: '0500', dayMask: 127 }] }; },
      addNewScheduleEventAsync: async () => { const id = nextId++; calls.push(['add', id]); return { val: id }; },
      setScheduleEventByIdAsync: async (...a: unknown[]) => { calls.push(['set', ...a]); return { val: true }; },
      deleteScheduleEventByIdAsync: async (id: number) => { calls.push(['delete', id]); return { val: true }; },
    },
    pump: {
      getPumpStatusAsync: async () => { calls.push(['status']); return { pumpCircuits: pump.map(s => ({ ...s })) }; },
      setPumpSpeedAsync: async (pumpId: number, slot: number, rpm: number, isRpm: boolean) => { calls.push(['speed', pumpId, slot, rpm, isRpm]); pump[slot].speed = rpm; return { val: true }; },
    },
  };
  const run = vi.fn(async (fn: (c: any) => Promise<any>) => fn(conn));
  const sdm: Array<{ url: string; body: any }> = [];
  const nestState = { at: 0, deviceId: 'dev-test', name: 'Hallway', online: true, indoorF: 77, humidity: 45, mode: 'COOL', hvac: 'OFF',
    coolF: 76 as number | null, heatF: null, eco: false, ecoCoolF: null, ecoHeatF: null, fanTimer: false, availableModes: ['COOL', 'HEAT', 'OFF'] };
  const reset = () => { readings.spare = []; store.clear(); calls.length = 0; sdm.length = 0; pump = slots(); nextId = 20; run.mockClear(); nestState.coolF = 76; nestState.mode = 'COOL'; };
  return { store, db, calls, run, sdm, nestState, reset, readings };
});

vi.mock('../../server/src/db.js', () => H.db);
vi.mock('node-screenlogic', () => {
  const blocked = (): never => { throw new Error('a test tried to open a ScreenLogic connection'); };
  return { RemoteLogin: class { constructor() { blocked(); } }, UnitConnection: class { constructor() { blocked(); } } };
});
// pool.ts gets the real writePoolPlan (so its guard runs) on the fake session
vi.mock('../../server/src/appliances/screenlogic.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/src/appliances/screenlogic.js')>();
  return { ...actual, configured: () => false, readPool: vi.fn(async () => { throw new Error('readPool is not used here'); }),
    writePoolPlan: vi.fn((opts: Parameters<typeof actual.writePoolPlan>[0]) => actual.writePoolPlan(opts, H.run)) };
});
// ac.ts gets the real setCool (so its guard and the kv claim run) against a fake SDM, and a fake readNest
vi.mock('../../server/src/appliances/nest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/src/appliances/nest.js')>();
  return { ...actual, nestConfigured: () => true, nestLinked: async () => true,
    readNest: vi.fn(async () => { const st = { ...H.nestState, at: Date.now() }; await H.db.kv.set('nest:last', st); return st; }),
    setCool: vi.fn(actual.setCool) };
});

import { writePoolPlan } from '../../server/src/appliances/screenlogic.js';
import { setCool, lastSetpointWrite, ownerCommand } from '../../server/src/appliances/nest.js';
import { applyPlan, restorePrevious, planFor, powerModel, type PoolSettings } from '../../server/src/appliances/pool.js';
import { autopilot } from '../../server/src/appliances/autopilot.js';
import { acTick, resumeHold, dayInputs } from '../../server/src/appliances/ac.js';
import { getHold, lastSent } from '../../server/src/appliances/hold.js';
import { presenceKey } from '../../server/src/appliances/presence.js';
import { localDay, addDays } from '../../server/src/tesla/client.js';
import type { PoolSnapshot } from '../../server/src/appliances/screenlogic.js';

/* ---------- shared synthetic fixtures ---------- */
const NOW = new Date('2026-07-15T18:00:00Z').getTime(); // 13:00 Central
const MIN = 60_000;
const SITE = 's';
const SDM = 'https://smartdevicemanagement.googleapis.com/v1';
const circuit = (id: number, name: string, fn = 0) => ({ id, name, on: false, freeze: false, function: fn });
const SNAP: PoolSnapshot = {
  at: 0, version: 'test', airTemp: 80, freezeMode: false,
  bodies: [{ id: 1, temp: 88, setPoint: 80, heatMode: 0, heating: false }, { id: 2, temp: 90, setPoint: 102, heatMode: 3, heating: false }],
  circuits: [circuit(1, 'Spa', 1), circuit(2, 'Blower'), circuit(3, 'Pool Light', 16), circuit(4, 'Spa Light', 16), circuit(5, 'Waterfall'), circuit(6, 'Pool', 2),
    circuit(7, 'Jets'), circuit(8, 'High Speed'), circuit(9, 'Cleaner', 6), circuit(10, 'Heater'), circuit(11, 'Aux 1'), circuit(12, 'Aux 2', 1), circuit(13, 'Aux 3', 7), circuit(14, 'Freeze Protect')],
  pump: { id: 1, name: 'IntelliFlo VSF', running: true, watts: 150, rpm: 1500, gpm: null, minRpm: 450, maxRpm: 3450, primingRpm: 2500,
    circuits: [[6, 1800], [8, 3000], [5, 3400], [1, 3190], [9, 2000], [7, 3000], [132, 1000]].map(([circuitId, speed]) => ({ circuitId, speed, isRpm: true })) },
  schedules: [],
};
const CTX: PoolGuardContext = { circuits: SNAP.circuits, pumpCircuits: SNAP.pump!.circuits.map(c => c.circuitId), minRpm: 450, maxRpm: 3450, managed: [6, 8, 5] };
// POOL_DEFAULTS, copied until tests-T4 (X2) exports them
const POOL: PoolSettings = { gallons: 14995, spaGallons: 1000, designGpm: 120, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5], autopilot: 'auto', uv: true,
  heaterBtu: 400_000, propaneUsdPerGal: 3.0, loads: { '2': 1100, '3': 500, '4': 100 }, turnoverGoal: 3, skimHours: 1 };
const BELL = [0, 0, 0, 0, 0, 0, 0, .5, 1.5, 3, 4.5, 5.5, 6, 6, 5.5, 4.5, 3, 1.5, .5, 0, 0, 0, 0, 0];
const W0 = powerModel([]);
const poolPlan = (settings: PoolSettings) => planFor({ waterTemp: 88, solarKw: BELL, settings, W: W0, rate: .1064, month: 6, names: new Map() });

/* ======================================================================================================== */
describe('guardCoolSetpoint: AC clamps (65–85 °F, 2 °F per write, one write per 30 min, Off writes nothing)', () => {
  const base = { mode: 'auto', currentF: 76 as number | null, lastWriteAt: null as number | null, now: NOW };
  // [#, case, input overrides, ok, value, reason contains]
  it.each([
    [1, 'lower bound 65 is allowed', { targetF: 65, currentF: 66 }, true, 65, null],
    [2, 'upper bound 85 is allowed', { targetF: 85, currentF: 84 }, true, 85, null],
    [3, 'just below 65 is refused', { targetF: 64.9, currentF: 66 }, false, null, 'outside the 65–85° safety range'],
    [4, 'just above 85 is refused', { targetF: 85.1, currentF: 84 }, false, null, 'outside the 65–85° safety range'],
    [5, '64 is refused, not clamped to 65', { targetF: 64, currentF: 65 }, false, null, 'the target 64°'],
    [6, '86 is refused, not clamped to 85', { targetF: 86, currentF: 85 }, false, null, 'the target 86°'],
    [7, 'exactly 2 °F down is one write', { targetF: 74 }, true, 74, null],
    [8, 'exactly 2 °F up is one write', { targetF: 78 }, true, 78, null],
    [9, '2.1 °F down is stepped to 2 °F', { targetF: 73.9 }, true, 74, 'stepped'],
    [10, '4 °F up is stepped to 2 °F', { targetF: 80 }, true, 78, 'stepped: 76° → 80° is more than 2°, so 78° now'],
    [11, '6 °F down is stepped to 2 °F', { targetF: 70 }, true, 74, 'stepped'],
    [12, "the caller's own step toward a legal target", { targetF: 80, valueF: 78 }, true, 78, null],
    [13, 'a legal step toward an illegal target is refused', { targetF: 88, valueF: 78 }, false, null, 'the target 88°'],
    [14, 'an illegal value toward a legal target is refused', { targetF: 80, valueF: 86 }, false, null, '86° is outside'],
    [15, 'a step that would land outside 65–85 is refused', { targetF: 80, currentF: 88 }, false, null, 'would be 86°'],
    [16, 'from an out-of-range current, a legal step is fine', { targetF: 70, currentF: 64 }, true, 66, 'stepped'],
    [17, 'unknown current setpoint is refused', { targetF: 76, currentF: null }, false, null, 'current setpoint is unknown'],
    [18, 'a write 1 ms short of 30 min ago is refused', { targetF: 74, lastWriteAt: NOW - AC_WRITE_INTERVAL_MS + 1 }, false, null, 'one setpoint change per 30 min'],
    [19, 'a write exactly 30 min ago allows the next', { targetF: 74, lastWriteAt: NOW - AC_WRITE_INTERVAL_MS }, true, 74, null],
    [20, 'a write just now is refused', { targetF: 74, lastWriteAt: NOW }, false, null, 'the last was at 1:00 PM'],
    [21, 'a write "in the future" (clock skew) is refused', { targetF: 74, lastWriteAt: NOW + MIN }, false, null, 'one setpoint change per 30 min'],
    [22, 'NaN is refused', { targetF: NaN }, false, null, 'not a temperature'],
  ] as const)('%i %s', (_n, _case, over, ok, value, why) => {
    const v = guardCoolSetpoint({ ...base, ...over });
    expect(v.ok).toBe(ok);
    expect(v.value).toBe(value);
    if (why) expect(v.reason).toContain(why); else expect(v.reason).toBeNull();
    expect(v.stepped).toBe(!!why && ok);
  });

  // [#, mode, target, ok, reason]
  it.each([
    [23, 'off', 78, false, AUTOPILOT_OFF],
    [24, 'off', 99, false, AUTOPILOT_OFF],                // Off wins over every other rule, with the bare code
    [25, 'suggest', 78, true, null],                      // approval is acTick's business; the guard allows it
    [26, 'auto', 78, true, null],
    [27, 'bogus', 78, false, 'is not Off, Suggest or Auto'],
  ] as const)('%i mode %s', (_n, mode, targetF, ok, why) => {
    const v = guardCoolSetpoint({ ...base, mode, targetF });
    expect(v.ok).toBe(ok);
    if (why === AUTOPILOT_OFF) expect(v.reason).toBe(AUTOPILOT_OFF);                       // the bare code, exactly
    else if (why) expect(v.reason).toContain(why);
    else expect(v.reason).toBeNull();
  });

  it('28 explainRefusal turns the Off code into a sentence and leaves others alone', () => {
    expect(explainRefusal(AUTOPILOT_OFF)).toBe('AC Autopilot is Off, so Solstice makes no thermostat changes (autopilot_off)');
    expect(explainRefusal('x')).toBe('x');
  });
});

describe('pool clamps: RPM range, managed circuits only, never freeze/spa/lights/heater/heat mode', () => {
  // [#, reported min, reported max, min, max, source]
  it.each([
    [29, 450, 3450, 450, 3450, 'controller'],
    [30, 600, 3000, 600, 3000, 'controller'],
    [31, undefined, undefined, 450, 3450, 'IntelliFlo VSF'],
    [32, null, null, 450, 3450, 'IntelliFlo VSF'],
    [33, 0, 0, 450, 3450, 'IntelliFlo VSF'],
    [34, 3000, 600, 450, 3450, 'IntelliFlo VSF'],       // nonsense pair
    [35, 400, 3600, 450, 3450, 'controller'],            // never wider than the IntelliFlo VSF range
  ] as const)('%i pumpRpmLimits(%s, %s)', (_n, lo, hi, min, max, source) => {
    expect(pumpRpmLimits(lo, hi)).toEqual({ min, max, source });
  });

  // [#, limits, rpm, ok]
  it.each([
    [36, [450, 3450], 449, false], [37, [450, 3450], 450, true], [38, [450, 3450], 1500, true], [39, [450, 3450], 3450, true], [40, [450, 3450], 3451, false],
    [41, [600, 3000], 599, false], [42, [600, 3000], 600, true], [43, [600, 3000], 3000, true], [44, [600, 3000], 3001, false],
    [45, [450, 3450], 0, false], [46, [450, 3450], -1500, false], [47, [450, 3450], 1500.5, false], [48, [450, 3450], NaN, false],
  ] as const)('%i guardPumpRpm %j %d', (_n, [min, max], rpm, ok) => {
    const v = guardPumpRpm(rpm, { min, max });
    expect(v.ok).toBe(ok);
    expect(v.value).toBe(ok ? rpm : null);
    if (!ok) expect(v.reason).toMatch(/RPM/);
  });

  // [#, circuit, ok, reason contains]
  it.each([
    [49, 6, true, null], [50, 8, true, null], [51, 5, true, null],
    [52, 1, false, 'circuit 1 (Spa) is the spa'],
    [53, 2, false, 'circuit 2 (Blower) is spa-related'],
    [54, 3, false, 'circuit 3 (Pool Light) is a light'],
    [55, 4, false, 'circuit 4 (Spa Light) is a light'],
    [56, 7, false, 'circuit 7 (Jets) is spa-related'],
    [57, 132, false, 'circuit 132 is freeze protection'],
    [58, 14, false, 'circuit 14 (Freeze Protect) is freeze protection'],
    [59, 10, false, 'circuit 10 (Heater) is a heater circuit'],
    [60, 12, false, 'circuit 12 (Aux 2) is the spa'],          // by circuit function, whatever the name
    [61, 13, false, 'circuit 13 (Aux 3) is a light'],
    [62, 9, false, 'is not one of the pump circuits Autopilot manages (6, 8, 5)'],
    [63, 99, false, 'circuit 99 is not on the controller'],
    [64, 6.5, false, 'is not a circuit id'],
  ] as const)('%i guardPoolCircuit %d', (_n, id, ok, why) => {
    const v = guardPoolCircuit(id, CTX);
    expect(v.ok).toBe(ok);
    if (why) expect(v.reason).toContain(why);
  });
  it('65 a managed circuit with no pump speed slot is refused', () => {
    expect(guardPoolCircuit(11, { ...CTX, managed: [6, 8, 5, 11] }).reason).toContain('circuit 11 (Aux 1) has no pump speed slot');
  });
  it('66 circuit names are stripped of markup before they reach the log', () => {
    const v = guardPoolCircuit(9, { ...CTX, circuits: [circuit(9, '<img src=x onerror=alert(1)>Cleaner')] });
    expect(v.reason).not.toMatch(/[<>"']/);
  });

  // [#, heatCmd, ok]
  it.each([[67, 4, true], [68, undefined, true], [69, 0, false], [70, 3, false]] as const)('%i schedule heat command %s', (_n, heatCmd, ok) => {
    const v = guardPoolSchedule({ circuitId: 6, start: 600, stop: 1140, heatCmd }, CTX);
    expect(v.ok).toBe(ok);
    if (!ok) expect(v.reason).toContain('would change the heat mode');
  });

  const W = { speeds: [{ circuitId: 6, rpm: 1500 }, { circuitId: 8, rpm: 2400 }], replaceCircuits: [6, 8, 5], schedules: [{ circuitId: 6, start: 480, stop: 1020 }, { circuitId: 8, start: 720, stop: 780 }] };
  // [#, case, write, reason contains (null = allowed)]
  it.each([
    [71, "today's plan shape", W, null],
    [72, 'the spa in speeds', { ...W, speeds: [{ circuitId: 1, rpm: 1500 }] }, 'the spa'],
    [73, 'a light in schedules', { ...W, schedules: [{ circuitId: 3, start: 1200, stop: 1320 }] }, 'a light'],
    [74, 'freeze protection in the replaced set', { ...W, replaceCircuits: [6, 8, 132] }, 'freeze protection'],
    [75, 'a pump circuit Autopilot does not manage', { ...W, replaceCircuits: [6, 8, 9] }, 'not one of the pump circuits'],
    [76, 'RPM above the pump maximum', { ...W, speeds: [{ circuitId: 6, rpm: 3451 }] }, '3451 RPM is outside'],
    [77, 'RPM below the pump minimum', { ...W, speeds: [{ circuitId: 8, rpm: 449 }] }, '449 RPM is outside'],
  ] as const)('%i guardPoolWrite: %s', (_n, _case, w, why) => {
    const v = guardPoolWrite(w as any, CTX);
    expect(v.ok).toBe(why == null);
    if (why) expect(v.reason).toContain(why); else expect(v.value).toBe(w);
  });
  it('78 every reason is reported once, all or nothing', () => {
    const v = guardPoolWrite({ speeds: [{ circuitId: 1, rpm: 9999 }], replaceCircuits: [1, 3], schedules: [{ circuitId: 1, start: 0, stop: 60 }] }, CTX);
    expect(v.ok).toBe(false);
    expect(v.reason!.split('; ')).toEqual(['circuit 1 (Spa) is the spa and is never written', "9999 RPM is outside the pump's 450–3450 RPM range", 'circuit 3 (Pool Light) is a light and is never written']);
  });
});

/* ======================================================================================================== */
describe('write paths call the guard (fake ScreenLogic session, fake SDM, in-memory kv)', () => {
  let restoreFetch = () => {};
  beforeEach(async () => {
    H.reset();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.mocked(writePoolPlan).mockClear(); vi.mocked(setCool).mockClear();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${SDM}/dev-test:executeCommand`)) throw new Error(`unexpected fetch in guards.test: ${url}`);
      H.sdm.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    });
    restoreFetch = () => fetchSpy.mockRestore();                                              // back to the harness's fetch rail
    await H.db.kv.set('nest:tokens', { access_token: 'test-token', refresh_token: 'test-refresh', expires_at: NOW + 3600_000 });
    await H.db.kv.set('pool:forecast', { at: NOW, days: [] });
  });
  afterEach(() => { restoreFetch(); vi.useRealTimers(); });

  describe('ScreenLogic: writePoolPlan checks everything before it opens a session', () => {
    const ok = { pumpId: 1, speeds: [{ circuitId: 6, rpm: 1500 }, { circuitId: 8, rpm: 2400 }], replaceCircuits: [6, 8, 5], schedules: [{ circuitId: 6, start: 480, stop: 1020 }, { circuitId: 8, start: 720, stop: 780 }], guard: CTX };
    it('79 a legal plan: adds first, never a heat command, speeds in range, deletes last', async () => {
      await writePoolPlan(ok);
      expect(H.run).toHaveBeenCalledTimes(1);
      const kinds = H.calls.map(c => c[0]);
      expect(kinds).toEqual(['getSchedules', 'add', 'set', 'add', 'set', 'status', 'speed', 'speed', 'delete', 'delete', 'delete']);
      expect(H.calls.filter(c => c[0] === 'set').map(c => c[7])).toEqual([4, 4]);           // heatCmd "don't change"
      expect(H.calls.filter(c => c[0] === 'speed').map(c => c[3])).toEqual([1500, 2400]);
      expect(kinds.lastIndexOf('add')).toBeLessThan(kinds.indexOf('delete'));
    });
    // [#, case, override]
    it.each([
      [80, 'spa speed', { speeds: [{ circuitId: 1, rpm: 1500 }] }],
      [81, 'RPM 3451', { speeds: [{ circuitId: 6, rpm: 3451 }] }],
      [82, 'RPM 449', { speeds: [{ circuitId: 6, rpm: 449 }] }],
      [83, 'freeze circuit replaced', { replaceCircuits: [6, 8, 132] }],
      [84, 'light schedule', { schedules: [{ circuitId: 3, start: 1200, stop: 1260 }] }],
      [85, 'unmanaged pump circuit', { replaceCircuits: [6, 8, 9] }],
    ] as const)('%i refused before connecting: %s', async (_n, _case, over) => {
      await expect(writePoolPlan({ ...ok, ...over } as any)).rejects.toBeInstanceOf(GuardRefusal);
      expect(H.run).not.toHaveBeenCalled();
      expect(H.calls).toEqual([]);
    });
  });

  describe('pool applyPlan / restorePrevious / Autopilot', () => {
    const autolog = async () => (await H.db.kv.get(`${SITE}:pool:autolog`)) as Array<{ text: string; delta?: string }>;
    it('86 applyPlan with the default circuits writes once', async () => {
      await applyPlan(SITE, poolPlan(POOL), SNAP, POOL);
      expect(writePoolPlan).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writePoolPlan).mock.calls[0][0].replaceCircuits).toEqual([6, 8]);   // never the Waterfall (5), a switch only
      expect(H.run).toHaveBeenCalledTimes(1);
    });
    // [#, case, settings override, reason contains]
    it.each([
      [87, 'settings point the filter at the spa', { poolCircuit: 1 } as Partial<PoolSettings>, 'circuit 1 (Spa) is the spa'],
      [88, 'settings point the pool circuit at freeze protection', { poolCircuit: 132 } as Partial<PoolSettings>, 'freeze protection'],
      [89, 'settings ask for 3,451 RPM (the skim speed)', { boostRpm: 3451 } as Partial<PoolSettings>, '3451 RPM is outside'],
      [90, 'settings point the boost at the pool light', { boostCircuit: 3 } as Partial<PoolSettings>, 'a light'],
    ] as const)('%i applyPlan refuses and logs when %s', async (_n, _case, over, why) => {
      const settings: PoolSettings = { ...POOL, ...over };
      await expect(applyPlan(SITE, poolPlan(settings), SNAP, settings)).rejects.toBeInstanceOf(GuardRefusal);
      expect(H.run).not.toHaveBeenCalled();
      const log = await autolog();
      expect(log[0].delta).toBe('refused');
      expect(log[0].text).toMatch(/^Refused a pool schedule write: /);
      expect(log[0].text).toContain(why);
    });
    it('91 restorePrevious refuses a record that would rewrite the spa, and logs it', async () => {
      await H.db.kv.set(`${SITE}:pool:applied`, { plan: { schedules: [{ circuitId: 6 }] }, removed: [{ circuitId: 1, start: 0, stop: 60, dayMask: 127 }], previousSpeeds: [{ circuitId: 6, speed: 1800 }] });
      await expect(restorePrevious(SITE, SNAP)).rejects.toBeInstanceOf(GuardRefusal);
      expect(H.run).not.toHaveBeenCalled();
      expect((await autolog())[0].text).toMatch(/^Refused the restore: circuit 1 \(Spa\) is the spa/);
    });
    it('92 restorePrevious of an ordinary record writes', async () => {
      await H.db.kv.set(`${SITE}:pool:applied`, { plan: { schedules: [{ circuitId: 6 }, { circuitId: 8 }] }, removed: [{ circuitId: 5, start: 0, stop: 300, dayMask: 127 }, { circuitId: 6, start: 480, stop: 1020, dayMask: 127 }],
        previousSpeeds: [{ circuitId: 6, speed: 1800 }, { circuitId: 8, speed: 3000 }, { circuitId: 5, speed: 3400 }] });
      await restorePrevious(SITE, SNAP);
      expect(H.run).toHaveBeenCalledTimes(1);
    });

    const seedForecast = async () => {
      const today = localDay(), sun = BELL.map(v => v / 7.56);
      await H.db.kv.set('pool:forecast', { at: NOW, days: [-1, 0, 1, 2].map(k => ({ date: addDays(today, k), high: 85, rainMm: 0, rainPct: 0, sunKwhM2: 6, hourlySun: sun })) });
    };
    const runAutopilot = (settings: PoolSettings, mode: 'off' | 'suggest' | 'auto') =>
      autopilot(SITE, { settings, mode, W: W0, rate: .1064, names: new Map(SNAP.circuits.map(c => [c.id, c.name])), snap: SNAP, waterTemp: 88, currentHours: 9, act: true });
    it('93 Auto with default circuits writes tomorrow once', async () => {
      await seedForecast();
      await runAutopilot(POOL, 'auto');
      expect(writePoolPlan).toHaveBeenCalledTimes(1);
      expect(H.run).toHaveBeenCalledTimes(1);
    });
    it('94 Auto refuses a plan aimed at the spa: logged, nothing written, no throw', async () => {
      await seedForecast();
      const st = await runAutopilot({ ...POOL, poolCircuit: 1 }, 'auto');
      expect(writePoolPlan).not.toHaveBeenCalled();
      expect(st.log[0].delta).toBe('refused');
      expect(st.log[0].text).toMatch(/^Refused tomorrow's plan: circuit 1 \(Spa\) is the spa/);
      expect((await autolog())[0].delta).toBe('refused');
    });
    it('95 Suggest is unchanged: stores the plan, writes nothing', async () => {
      await seedForecast();
      const st = await runAutopilot(POOL, 'suggest');
      expect(writePoolPlan).not.toHaveBeenCalled();
      expect(st.pending).toBe(true);
      expect(st.log[0].delta).toBe('waiting for you');
    });
  });

  describe('Nest: setCool refuses before it calls the SDM API', () => {
    const seedLast = async (coolF: number) => { await H.db.kv.set('nest:last', { ...H.nestState, coolF }); };
    it('96 a legal write sends one SetCool and records the slot', async () => {
      await seedLast(76);
      await setCool('dev-test', 78, 'auto');
      expect(H.sdm).toEqual([{ url: `${SDM}/dev-test:executeCommand`, body: { command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', params: { coolCelsius: 25.56 } } }]);
      expect(await lastSetpointWrite('dev-test')).toEqual({ at: NOW, f: 78 });
    });
    // [#, case, mode, current, f, reason contains]
    it.each([
      [97, 'Autopilot Off', 'off', 76, 78, AUTOPILOT_OFF],
      [98, 'above 85', 'auto', 84, 86, 'outside the 65–85° safety range'],
      [99, 'below 65', 'auto', 66, 64, 'outside the 65–85° safety range'],
      [100, 'a 3 °F jump (setCool never steps for the caller)', 'auto', 76, 79, 'would have to be stepped'],
      [101, 'unknown current setpoint', 'auto', null, 76, 'current setpoint is unknown'],
    ] as const)('%i refused: %s', async (_n, _case, mode, cur, f, why) => {
      if (cur != null) await seedLast(cur);
      const err = await setCool('dev-test', f, mode).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(GuardRefusal);
      expect((err as GuardRefusal).reason).toContain(why);
      expect(H.sdm).toEqual([]);
      expect(await lastSetpointWrite('dev-test')).toBeUndefined();
    });
    it('102 one write per 30 minutes, shared through kv', async () => {
      await seedLast(76);
      await setCool('dev-test', 78, 'auto');
      await seedLast(78);
      vi.setSystemTime(NOW + 30 * MIN - 1);
      await expect(setCool('dev-test', 80, 'auto')).rejects.toThrow('one setpoint change per 30 min');
      vi.setSystemTime(NOW + 30 * MIN);
      await setCool('dev-test', 80, 'auto');
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([25.56, 26.67]);
    });
    it('103 a racing invocation that took the slot after our read is refused by the atomic claim', async () => {
      await seedLast(76);
      await H.db.kv.set('nest:setpointWrite:dev-test', { at: NOW - MIN, f: 77 });              // written by the other invocation
      const get = H.db.kv.get;
      const spy = vi.spyOn(H.db.kv, 'get').mockImplementation(async (k: string) => (k.startsWith('nest:setpointWrite:') ? undefined : get(k)));
      await expect(setCool('dev-test', 78, 'auto')).rejects.toThrow('another setpoint change was just made');
      spy.mockRestore();
      expect(H.sdm).toEqual([]);
    });
  });

  describe('AC: acTick steps, refuses and logs through the guard', () => {
    const ac = (over: Record<string, unknown>) => ({ ac: { autopilot: 'auto', presence: 'away', awayF: 80, ...over } }); // away: one step, any hour
    const tick = (over: Record<string, unknown> = {}) => acTick(SITE, ac(over), .1064, 2.5);
    const acLog = async () => ((await H.db.kv.get(`${SITE}:ac:log`)) ?? []) as Array<{ text: string; delta?: string }>;
    const approve = () => H.db.kv.set(`${SITE}:ac:plan`, { date: localDay(), approved: true, lastStepHour: null });

    it('104 Auto: 76 → 80 goes 78 now, then waits 30 min (logged once), then 80', async () => {
      await tick();
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([25.56]);
      expect((await acLog())[0]).toMatchObject({ text: 'Set 78° (marked away)', delta: 'stepping' });
      H.nestState.coolF = 78;
      vi.setSystemTime(NOW + 5 * MIN); await tick();
      vi.setSystemTime(NOW + 10 * MIN); await tick();
      expect(H.sdm).toHaveLength(1);
      const log = await acLog();
      expect(log).toHaveLength(2);                                                            // the repeat is not logged again
      expect(log[0]).toMatchObject({ delta: 'refused', text: 'Did not set 80° (marked away): one setpoint change per 30 min; the last was at 1:00 PM' });
      vi.setSystemTime(NOW + 30 * MIN); await tick();
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([25.56, 26.67]);
      expect((await acLog())[0]).toMatchObject({ text: 'Set 80° (marked away)' });
      expect(((await H.db.kv.get(`${SITE}:ac:plan`)) as any).lastStepHour).toBe(0);
    });
    it('105 a maxStepF of 5 from settings is still stepped to 2 °F, and the log says so', async () => {
      await tick({ maxStepF: 5 });
      expect(setCool).toHaveBeenCalledWith('dev-test', 78, 'auto');
      expect((await acLog())[0]).toMatchObject({ delta: 'stepping', text: 'Set 78° (marked away); safety stepped: 76° → 80° is more than 2°, so 78° now' });
    });
    it('106 an away target of 88 is refused, never clamped', async () => {
      await tick({ awayF: 88 });
      expect(setCool).not.toHaveBeenCalled();
      expect((await acLog())[0]).toMatchObject({ delta: 'refused', text: 'Did not set 78° (marked away): the target 88° is outside the 65–85° safety range' });
    });
    // [#, mode, approved earlier today, writes?, log]
    it.each([
      [107, 'off', true, false, 'Did not set 78° (marked away): AC Autopilot is Off, so Solstice makes no thermostat changes (autopilot_off)'],
      [108, 'suggest', true, true, 'Set 78° (marked away)'],
      [109, 'suggest', false, false, null],                                                   // Suggest without approval: unchanged, no attempt
      [110, 'auto', false, true, 'Set 78° (marked away)'],
    ] as const)('%i mode %s, approved %s', async (_n, mode, approved, writes, text) => {
      if (approved) await approve();
      await tick({ autopilot: mode });
      expect(H.sdm).toHaveLength(writes ? 1 : 0);
      const log = await acLog();
      if (text) expect(log[0].text).toBe(text); else expect(log).toEqual([]);
    });
    it('111 heating mode is left alone (no attempt, nothing logged)', async () => {
      H.nestState.mode = 'HEAT';
      await tick();
      expect(setCool).not.toHaveBeenCalled();
      expect(await acLog()).toEqual([]);
    });
  });

  describe('AC: manual holds and the owner\'s commands (mockup v)', () => {
    // a mild day at home: the plan is 76° from 07:00, 76° at 21:00, night band 76° from 22:00; NOW is 13:00 Central
    const home = { ac: { autopilot: 'auto', presence: 'home' } };
    const tick = () => acTick(SITE, home, .1064, 2.5);
    const acLog = async () => ((await H.db.kv.get(`${SITE}:ac:log`)) ?? []) as Array<{ text: string; delta?: string }>;
    const at = (hhmm: string, day = localDay()) => new Date(`${day}T${hhmm}:00-05:00`).getTime();
    beforeEach(async () => {
      const today = localDay();
      await H.db.kv.set('nest:tokens', { access_token: 'test-token', refresh_token: 'test-refresh', expires_at: NOW + 864e5 });   // the clock runs into the evening
      await H.db.kv.set('pool:forecast', { at: NOW + 864e5, days: [-1, 0, 1].map(k => ({ date: addDays(today, k), high: 75, rainMm: 0, rainPct: 0, sunKwhM2: 3, hourlySun: Array(24).fill(0) })) });
    });

    it('H1 a step the thermostat already matches is marked done; a wall change is then held, not undone', async () => {
      await tick();
      expect(H.sdm).toEqual([]);
      expect(((await H.db.kv.get(`${SITE}:ac:plan`)) as any).lastStepHour).toBe(7);
      H.nestState.coolF = 72; vi.setSystemTime(at('13:05')); await tick();
      expect(H.sdm).toEqual([]);
      const h = await getHold(SITE);
      expect(h).toMatchObject({ by: 'wall', coolF: 72, until: at('21:00') });
      expect((await acLog())[0]).toMatchObject({ delta: 'hold', text: 'Someone set 72° at the thermostat (1:05 PM). Holding until 9:00 PM' });
      vi.setSystemTime(at('16:00')); await tick();
      expect(H.sdm).toEqual([]);
    });
    it('H2 when the hold ends the step due then applies, through the guard (2° step)', async () => {
      await tick(); H.nestState.coolF = 72; vi.setSystemTime(at('13:05')); await tick();
      vi.setSystemTime(at('21:05')); await tick();
      expect(await getHold(SITE)).toBeNull();
      expect((await acLog()).map(l => l.delta)).toContain('resumed');
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([23.33]);                     // 72 → 74, stepping toward 76
    });
    it('H3 a hold is 2 h at least: a change at 20:30 holds to 22:30, past the 21:00 and 22:00 steps', async () => {
      vi.setSystemTime(at('20:25')); await tick();
      H.nestState.coolF = 73; vi.setSystemTime(at('20:30')); await tick();
      expect(await getHold(SITE)).toMatchObject({ until: at('22:30') });
      vi.setSystemTime(at('22:05')); await tick();
      expect(H.sdm).toEqual([]);
    });
    it('H4 resume ends the hold and the step due now applies on the next tick', async () => {
      await tick(); H.nestState.coolF = 72; vi.setSystemTime(at('13:05')); await tick();
      await resumeHold(SITE);
      expect(await getHold(SITE)).toBeNull();
      vi.setSystemTime(at('13:40')); await tick();
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([23.33]);
    });
    it('H5 going Away after the change ends the hold', async () => {
      await tick(); H.nestState.coolF = 72; vi.setSystemTime(at('13:05')); await tick();
      vi.setSystemTime(at('14:00'));
      await H.db.kv.set(presenceKey(SITE), { state: 'away', at: at('13:30'), until: null, nestEco: null });
      await tick();
      expect(await getHold(SITE)).toBeNull();
      expect((await acLog()).some(l => l.text.startsWith('Away: ended the hold on 72°'))).toBe(true);
    });
    it('H6 just after midnight, a night step set yesterday is not re-sent over a later change', async () => {
      const yesterday = addDays(localDay(), -1);
      vi.setSystemTime(at('00:15'));
      await H.db.kv.set(`${SITE}:ac:plan`, { date: yesterday, approved: true, lastStepHour: 22 });
      H.nestState.coolF = 74;
      await H.db.kv.set('nest:last', { ...H.nestState, at: at('00:00') });                       // no change since the last reading
      await tick();
      expect(H.sdm).toEqual([]);
      expect(((await H.db.kv.get(`${SITE}:ac:plan`)) as any)).toMatchObject({ date: localDay(), lastStepHour: 22 });
    });
    it('H7 Autopilot\'s own write is not mistaken for a wall change', async () => {
      H.nestState.coolF = 80; await tick();                                                     // 80 → 78 (stepping to 76)
      expect(H.sdm).toHaveLength(1);
      H.nestState.coolF = 78; vi.setSystemTime(at('13:05')); await tick();
      expect(await getHold(SITE)).toBeNull();
    });
    it('H8 the owner\'s command is sent inside 65–85 cool / 55–80 heat, recorded, and not taken for a wall change', async () => {
      await tick();
      await ownerCommand({ kind: 'cool', f: 78 });
      expect(H.sdm.map(s => [s.body.command, s.body.params.coolCelsius])).toEqual([['sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', 25.56]]);
      expect(await lastSent('dev-test')).toMatchObject({ by: 'owner', coolF: 78 });
      H.nestState.coolF = 78; vi.setSystemTime(at('13:05')); await tick();
      expect(await getHold(SITE)).toBeNull();                                                    // the route starts the 'app' hold, not detection
      await expect(ownerCommand({ kind: 'cool', f: 90 })).rejects.toThrow('cooling setpoints must be 65–85°');
      await expect(ownerCommand({ kind: 'heat', f: 70 })).rejects.toThrow('the thermostat is in COOL, not HEAT');
      expect(H.sdm).toHaveLength(1);
    });
    it('H9 the day\'s weather inputs freeze at the first plan from 06:00, so a new forecast can\'t flip today\'s plan', async () => {
      const a = { high: 95, sunKwhM2: 7, hourlySun: Array(24).fill(.5), humidity: 40 }, b = { high: 80, sunKwhM2: 2, hourlySun: Array(24).fill(.1), humidity: 70 };
      expect(await dayInputs(SITE, '2026-07-15', a, 5)).toEqual(a);
      expect(await dayInputs(SITE, '2026-07-15', b, 5)).toEqual(b);                             // before 06:00 nothing is frozen
      expect(await dayInputs(SITE, '2026-07-15', a, 6)).toEqual(a);
      expect(await dayInputs(SITE, '2026-07-15', b, 13)).toEqual(a);
      expect(await dayInputs(SITE, '2026-07-16', b, 7)).toEqual(b);
    });
  });

  describe('AC: pre-cool only on spare solar (Q7)', () => {
    // a hot, sunny day at home: the plan pre-cools 74° from 11:00 and coasts to 78° from 16:00; NOW is 13:00 Central
    const home = { ac: { autopilot: 'auto', presence: 'home' } };
    const tick = () => acTick(SITE, home, .1064, 2.5);
    const at = (hhmm: string) => new Date(`${localDay()}T${hhmm}:00-05:00`).getTime();
    const sun = Array.from({ length: 24 }, (_, h) => Math.max(0, 1 - Math.abs(h - 13) / 6));
    beforeEach(async () => {
      const today = localDay();
      await H.db.kv.set('nest:tokens', { access_token: 'test-token', refresh_token: 'test-refresh', expires_at: NOW + 864e5 });
      await H.db.kv.set('pool:forecast', { at: NOW + 864e5, days: [-1, 0, 1].map(k => ({ date: addDays(today, k), high: 96, rainMm: 0, rainPct: 0, sunKwhM2: 7, hourlySun: sun })) });
      await H.db.kv.set(`${SITE}:ac:control`, { count: 1, days: {} });   // not a control day
    });
    it('P1 no spare solar: holds the band (76°) instead of pre-cooling, and says so', async () => {
      H.readings.spare = [{ n: 3, w: -800 }];
      await tick();
      expect(H.sdm).toEqual([]);                                                                 // 76 already: nothing to send
      const log = (await H.db.kv.get(`${SITE}:ac:log`)) as any[] ?? [];
      expect(log.some(l => /pre-cooling/.test(l.text))).toBe(false);
    });
    it('P2 a full AC of spare solar starts the pre-cool; half an AC keeps it; less ends it', async () => {
      H.readings.spare = [{ n: 3, w: 3500 }];                                                    // the AC is 3.25 kW (estimated) here
      await tick();
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([23.33]);                      // 76 → 74
      expect(((await H.db.kv.get(`${SITE}:ac:plan`)) as any)).toMatchObject({ precoolOn: true, precoolRan: true });
      H.nestState.coolF = 74; H.nestState.hvac = 'COOLING'; H.readings.spare = [{ n: 3, w: -900 }];   // AC on: + its 3.25 kW back, 2.35 kW ≥ half
      vi.setSystemTime(at('13:40')); await tick();
      expect(H.sdm).toHaveLength(1);
      H.readings.spare = [{ n: 3, w: -2000 }];
      vi.setSystemTime(at('14:20')); await tick();
      expect(H.sdm.map(s => s.body.params.coolCelsius)).toEqual([23.33, 24.44]);               // back to 76
      expect(((await H.db.kv.get(`${SITE}:ac:plan`)) as any).precoolOn).toBe(false);
    });
    it('P3 no pre-cool today: no coast either', async () => {
      H.readings.spare = [];
      vi.setSystemTime(at('16:05')); await tick();
      expect(H.sdm).toEqual([]);                                                                 // stays 76, no 78 coast
    });
  });
});
