// The owner's own pool commands (mockup w batch 1): guardOwnerPool, writeOwnerPool on a fake controller that keeps state (so the
// read-back is real), and poolCommand on PGlite (the reading, the remembered run time, the activity log). All data synthetic; nothing
// here opens a ScreenLogic session.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { guardOwnerPool, GuardRefusal } from '../../server/src/appliances/guards.js';
import { writeOwnerPool } from '../../server/src/appliances/screenlogic.js';
import { poolCommand, poolDetail, goalPatchError, recordReading } from '../../server/src/appliances/pool.js';

const NAMES: Array<[number, string, number]> = [[1, 'Spa', 1], [2, 'Air Blower', 0], [3, 'Pool Light', 7], [5, 'Waterfall', 13], [6, 'Pool', 2], [8, 'High Speed', 0]];
/** A fake controller with state: circuits on/off and egg timers, pump slots (Pool, High Speed, Waterfall, Spa, freeze 132). */
function fakeUnit(o: { ignore?: boolean; slowAck?: boolean } = {}) {
  const on = new Map(NAMES.map(([id]) => [id, id === 6])), egg = new Map(NAMES.map(([id]) => [id, 720]));
  const slots = [{ circuitId: 6, speed: 1500 }, { circuitId: 8, speed: 2400 }, { circuitId: 5, speed: 3400 }, { circuitId: 1, speed: 3190 }, { circuitId: 132, speed: 1000 }];
  const writes: string[] = [], spa = { setPoint: 98, heatMode: 0 };
  const ack = async () => { if (o.slowAck) throw new Error('time out waiting for response'); return { val: true }; };
  const c: any = {
    getVersionAsync: async () => ({ version: 'test' }),
    equipment: {
      getEquipmentStateAsync: async () => ({ airTemp: 70, freezeMode: 0, circuitArray: [...on].map(([id, s]) => ({ id, state: s ? 1 : 0 })), bodies: [{ id: 1, currentTemp: 75, setPoint: 89, heatMode: 0, heatStatus: 0 }, { id: 2, currentTemp: 89, ...spa, heatStatus: 0 }] }),
      getControllerConfigAsync: async () => ({ circuitArray: NAMES.map(([circuitId, name, fn]) => ({ circuitId, name, freeze: 0, function: fn, eggTimer: egg.get(circuitId) })) }),
      getEquipmentConfigurationAsync: async () => ({ pumps: [{ id: 1, type: 3, name: 'Pump', minSpeed: 450, maxSpeed: 3450, primingSpeed: 1000, circuits: [] }] }),
    },
    schedule: { getScheduleDataAsync: async () => ({ data: [] }) },
    pump: {
      getPumpStatusAsync: async () => ({ isRunning: true, pumpWatts: 300, pumpRPMs: 1500, pumpGPMs: 255, pumpCircuits: slots.map(s => ({ ...s, isRPMs: true })) }),
      setPumpSpeedAsync: async (_p: number, idx: number, rpm: number) => { writes.push(`speed slot ${idx} ${rpm}`); if (!o.ignore) slots[idx].speed = rpm; return ack(); },
    },
    bodies: {
      setSetPointAsync: async (i: number, f: number) => { writes.push(`setpoint ${i} ${f}`); if (!o.ignore) spa.setPoint = f; return ack(); },
      setHeatModeAsync: async (i: number, m: number) => { writes.push(`heat ${i} ${m}`); if (!o.ignore) spa.heatMode = m; return ack(); },
    },
    circuits: {
      setCircuitRuntimebyIdAsync: async (id: number, m: number) => { writes.push(`egg ${id} ${m}`); egg.set(id, m); return ack(); },
      setCircuitStateAsync: async (id: number, s: boolean) => { writes.push(`state ${id} ${s}`); if (!o.ignore) on.set(id, s); return ack(); },
    },
  };
  return { writes, egg, run: async <T>(fn: (c: any) => Promise<T>) => fn(c) };
}
const CTX = { circuits: NAMES.map(([id, name, fn]) => ({ id, name, function: fn })), pumpCircuits: [6, 8, 5, 1, 132], minRpm: 450, maxRpm: 3450, hasSpa: true };

describe('guardOwnerPool', () => {
  it('PC-1 the owner may switch the spa, lights and blower (Autopilot may not); never freeze protection; run times 1 min–12 h', () => {
    expect(guardOwnerPool({ kind: 'circuit', id: 1, on: true, minutes: 60 }, CTX).ok).toBe(true);
    expect(guardOwnerPool({ kind: 'circuit', id: 3, on: false }, CTX).ok).toBe(true);
    expect(guardOwnerPool({ kind: 'circuit', id: 132, on: true, minutes: 60 }, CTX)).toMatchObject({ ok: false, reason: 'freeze protection is never switched' });
    expect(guardOwnerPool({ kind: 'circuit', id: 9, on: true, minutes: 60 }, CTX).ok).toBe(false);
    expect(guardOwnerPool({ kind: 'circuit', id: 5, on: true }, CTX).ok).toBe(false);                    // on needs a run time
    expect(guardOwnerPool({ kind: 'circuit', id: 5, on: true, minutes: 721 }, CTX).ok).toBe(false);
  });
  it('PC-2 speeds: only circuits with a pump slot, whole RPM inside the pump range', () => {
    expect(guardOwnerPool({ kind: 'speed', id: 5, rpm: 3400 }, CTX).ok).toBe(true);
    expect(guardOwnerPool({ kind: 'speed', id: 3, rpm: 2000 }, CTX).ok).toBe(false);                     // a light has no pump speed
    expect(guardOwnerPool({ kind: 'speed', id: 6, rpm: 3500 }, CTX).ok).toBe(false);
    expect(guardOwnerPool({ kind: 'speed', id: 6, rpm: 1800.5 }, CTX).ok).toBe(false);
  });
});

describe('spa heat (batch 2)', () => {
  it('PC-9 the guard: 80–104° whole degrees when on; off needs no setpoint; no spa, no heat', () => {
    expect(guardOwnerPool({ kind: 'spaHeat', on: true, setF: 100 }, CTX).ok).toBe(true);
    expect(guardOwnerPool({ kind: 'spaHeat', on: false }, CTX).ok).toBe(true);
    for (const setF of [79, 105, 100.5, undefined]) expect(guardOwnerPool({ kind: 'spaHeat', on: true, setF }, CTX).ok, String(setF)).toBe(false);
    expect(guardOwnerPool({ kind: 'spaHeat', on: true, setF: 100 }, { ...CTX, hasSpa: false }).ok).toBe(false);
  });
  it('PC-10 on: the setpoint first, then the heater mode (3), on the spa body (index 1); off: mode 0 only', async () => {
    const u = fakeUnit(), snap = await writeOwnerPool({ kind: 'spaHeat', on: true, setF: 100 }, u.run, 0);
    expect(u.writes).toEqual(['setpoint 1 100', 'heat 1 3']);
    expect(snap.bodies[1]).toMatchObject({ setPoint: 100, heatMode: 3 });
    await writeOwnerPool({ kind: 'spaHeat', on: false }, u.run, 0);
    expect(u.writes.slice(2)).toEqual(['heat 1 0']);
  });
});

describe('writeOwnerPool (fake controller)', () => {
  it('PC-3 on: the egg timer is set to the run time before the circuit turns on, then read back', async () => {
    const u = fakeUnit(), snap = await writeOwnerPool({ kind: 'circuit', id: 5, on: true, minutes: 60 }, u.run, 0);
    expect(u.writes).toEqual(['egg 5 60', 'state 5 true']);
    expect(snap.circuits.find(c => c.id === 5)?.on).toBe(true);
  });
  it('PC-4 speed: written to the slot index, not the circuit id; a slow ack is not a failure when the read-back agrees', async () => {
    const u = fakeUnit({ slowAck: true }), snap = await writeOwnerPool({ kind: 'speed', id: 5, rpm: 3000 }, u.run, 0);
    expect(u.writes).toEqual(['speed slot 2 3000']);
    expect(snap.pump?.circuits.find(c => c.circuitId === 5)?.speed).toBe(3000);
  });
  it('PC-5 a refusal sends nothing; a change the controller never shows is an error', async () => {
    const u = fakeUnit();
    await expect(writeOwnerPool({ kind: 'circuit', id: 132, on: true, minutes: 60 }, u.run, 0)).rejects.toBeInstanceOf(GuardRefusal);
    expect(u.writes).toEqual([]);
    const stuck = fakeUnit({ ignore: true });
    await expect(writeOwnerPool({ kind: 'circuit', id: 2, on: true, minutes: 30 }, stuck.run, 0)).rejects.toThrow('did not confirm');
  });
});

describe('poolCommand (PGlite)', () => {
  beforeAll(async () => { await migrate(); });
  it('PC-6 stores the confirmed reading, remembers the run time per circuit and logs the change in plain words', async () => {
    const u = fakeUnit();
    await poolCommand('pc', { kind: 'circuit', id: 5, on: true, minutes: 120 }, u.run);
    await poolCommand('pc', { kind: 'speed', id: 5, rpm: 3000 }, u.run);
    await poolCommand('pc', { kind: 'circuit', id: 5, on: false }, u.run);
    expect(await kv.get('pc:pool:runFor')).toEqual({ 5: 120 });
    expect((await kv.get<any[]>('pc:pool:autolog'))!.map(l => l.text)).toEqual(['You turned Waterfall off', 'You set Waterfall to 3,000 RPM', 'You turned Waterfall on for 2 h']);
    expect((await q(`SELECT COUNT(*)::int n FROM pool_readings WHERE site_id = 'pc'`))[0].n).toBeGreaterThan(0);
  });
  it('PC-7 a refusal is logged and nothing is stored', async () => {
    await expect(poolCommand('pr', { kind: 'speed', id: 6, rpm: 9000 }, fakeUnit().run)).rejects.toBeInstanceOf(GuardRefusal);
    expect((await kv.get<any[]>('pr:pool:autolog'))![0]).toMatchObject({ delta: 'refused' });
    expect(await kv.get('pr:pool:runFor')).toBeUndefined();
  });
  it('PC-8 without ScreenLogic credentials on the server the command fails at once, before any session', async () => {
    const { PoolUnavailable } = await import('../../server/src/appliances/pool.js');
    const saved = process.env.SCREENLOGIC_SYSTEM; delete process.env.SCREENLOGIC_SYSTEM;
    try { await expect(poolCommand('nu', { kind: 'circuit', id: 4, on: true, minutes: 30 })).rejects.toBeInstanceOf(PoolUnavailable); }
    finally { if (saved !== undefined) process.env.SCREENLOGIC_SYSTEM = saved; }
  });
  it('PC-11 the time each app-started circuit turns itself off is kept until it is turned off (the Boost button), and spa heat is logged', async () => {
    const u = fakeUnit(), t0 = Date.now();
    await poolCommand('pb', { kind: 'circuit', id: 8, on: true, minutes: 120 }, u.run);
    const until = (await kv.get<Record<string, number>>('pb:pool:until'))![8];
    expect(until).toBeGreaterThanOrEqual(t0 + 120 * 60_000); expect(until).toBeLessThan(t0 + 121 * 60_000);
    await poolCommand('pb', { kind: 'circuit', id: 8, on: false }, u.run);
    expect(await kv.get('pb:pool:until')).toEqual({});
    await poolCommand('pb', { kind: 'spaHeat', on: true, setF: 101 }, u.run);
    expect((await kv.get<any[]>('pb:pool:autolog'))![0].text).toBe('You set spa heat to 101°');
  });
  it('PC-12 the goal patch: 1–4 turnovers in half steps, 0–3 whole skim hours', () => {
    expect(goalPatchError({ turnoverGoal: 3 })).toBeNull();
    expect(goalPatchError({ turnoverGoal: 2.5, skimHours: 0 })).toBeNull();
    for (const b of [{ turnoverGoal: 4.5 }, { turnoverGoal: 2.25 }, { turnoverGoal: '3' }, { skimHours: 1.5 }, { skimHours: 4 }, {}, null]) expect(goalPatchError(b), JSON.stringify(b)).not.toBeNull();
  });
  it('PC-13 the ring: water moved today comes from the readings (a run read at 2,000 RPM), not from the schedule', async () => {
    const { localDay, localMidnight } = await import('../../server/src/tesla/client.js');
    const t0 = localMidnight(localDay()).getTime(), snap = (await writeOwnerPool({ kind: 'speed', id: 8, rpm: 2400 }, fakeUnit().run, 0));
    // two hours at 2,000 RPM from midnight, read every 15 minutes: 2 h × gpmAt(2000) = 2 × 69.57 × 60 = 8,348 gal = 0.56 of 14,995
    for (let k = 0; k < 8; k++) await recordReading('pw', { ...snap, at: t0 + k * 900_000 + 60_000, pump: { ...snap.pump!, running: true, rpm: 2000, watts: 370 }, schedules: [] });
    vi.setSystemTime(t0 + 3 * 3600e3);   // 03:00: the 02:00–03:00 quarters have no read, so they count as off
    const d = await poolDetail('pw', {}, null);
    expect(d.water).toMatchObject({ goal: 3, skimHours: 1, movedTurnovers: .56, projectedTurnovers: .56, gallons: 14995 });   // no schedule left today
    vi.useRealTimers();
  });
});
