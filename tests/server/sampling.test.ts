// The 5-minute cron's sampling (server/src/appliances/sampling.ts; owner decisions Q17 and Q18): the Nest cadence table, the pool
// read schedule, and proof that no path reaches a real device. The database is an in-memory fake that throws on any query it does
// not expect; ScreenLogic's readPool answers from tests/fixtures (the real node-screenlogic is stubbed by tests/setup.ts to throw);
// Nest's reads and writes throw if called. Nothing here opens a connection to ScreenLogic, Nest, Google or Neon.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { poolSnapshot, readOnlyUnit } from '../fixtures/screenlogic.js';

const H = vi.hoisted(() => {
  const store = new Map<string, unknown>(), readings: unknown[][] = [];
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const counts = { q: 0, kvGet: 0, kvSet: 0 };
  const q = async (text: string, params: unknown[] = []): Promise<any[]> => {
    counts.q++;
    if (/^INSERT INTO kv .*ON CONFLICT \(key\) DO UPDATE SET value = excluded\.value\s+WHERE COALESCE\(\(kv\.value->>'at'\)::float8, 0\) < \$3 RETURNING key$/s.test(text)) {
      const key = String(params[0]), prev = store.get(key) as { at?: number } | null | undefined;
      if (prev && Number(prev.at ?? 0) >= Number(params[2])) return [];
      store.set(key, JSON.parse(String(params[1]))); return [{ key }];
    }
    if (/^INSERT INTO pool_readings/.test(text)) { readings.push(params); return []; }
    throw new Error(`unexpected query in sampling test: ${text.slice(0, 60)}`);
  };
  const kv = {
    get: async (k: string) => { counts.kvGet++; return clone(store.get(k)) as any; },
    set: async (k: string, v: unknown) => { counts.kvSet++; store.set(k, clone(v)); },
  };
  const S = { nestOn: true, nestLinked: true, poolOn: true, now: 0, read: null as null | (() => Promise<unknown>) };
  const reset = () => { store.clear(); readings.length = 0; Object.assign(counts, { q: 0, kvGet: 0, kvSet: 0 }); Object.assign(S, { nestOn: true, nestLinked: true, poolOn: true, now: 0, read: null }); };
  return { store, readings, counts, db: { q, one: async (t: string, p: unknown[] = []) => (await q(t, p))[0], kv, migrate: async () => {} }, S, reset };
});

vi.mock('../../server/src/db.js', () => H.db);
vi.mock('../../server/src/appliances/screenlogic.js', () => ({
  configured: () => H.S.poolOn,
  readPool: vi.fn(async () => { if (!H.S.read) throw new Error('no fake read set'); return H.S.read(); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan must never run from the cron'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit must never run from the cron'); }),
}));
vi.mock('../../server/src/appliances/nest.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/appliances/nest.js')>();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} must never run in the sampling test`); });
  return { ...real, nestConfigured: () => H.S.nestOn, nestLinked: vi.fn(async () => H.S.nestLinked),
    readNest: blocked('readNest'), setCool: blocked('setCool'), setHeat: blocked('setHeat'), setMode: blocked('setMode'), setEco: blocked('setEco') };
});

import {
  nestDue, nestInterval, poolDue, poolReadMinutes, tickMayBeDue, nestTick, poolTick, cronTick, nestSampleKey, poolReadKey, COOLING_MONTHS,
} from '../../server/src/appliances/sampling.js';
import { readPool, writePoolPlan, withUnit } from '../../server/src/appliances/screenlogic.js';
import { readNest, setCool, setHeat, setMode, setEco } from '../../server/src/appliances/nest.js';

const MIN = 60_000;
/** A Chicago wall-clock time: '2026-07-15 10:05' in CDT (−05:00) from March 8 to November 1, CST (−06:00) otherwise. */
const at = (local: string) => {
  const [d, t] = local.split(' '), cdt = d >= '2026-03-08' && d < '2026-11-01';
  return Date.parse(`${d}T${t.length === 5 ? t + ':00' : t}${cdt ? '-05:00' : '-06:00'}`);
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Every 5-minute cron tick of a Chicago day (288). */
const ticks = (day: string) => Array.from({ length: 288 }, (_, i) => at(`${day} ${hhmm(i * 5)}`));
const minuteOf = (ts: number) => { const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts); return s; };

// The pump schedule applied on 2026-09-24 (CLAUDE.md): Pool 10a–7p @1500, High Speed 2p–3p @2400.
const CURRENT = [
  { id: 1, circuitId: 6, start: 600, stop: 1140, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
  { id: 2, circuitId: 8, start: 840, stop: 900, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
];

let logs: Record<'debug' | 'log' | 'info' | 'warn' | 'error', ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  H.reset();
  vi.mocked(readPool).mockClear();
  logs = { debug: vi.spyOn(console, 'debug').mockImplementation(() => {}), log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}), warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}) };
});
afterEach(() => {
  vi.restoreAllMocks();
  // no path in this file may reach a device, whatever the test did
  for (const f of [writePoolPlan, withUnit, readNest, setCool, setHeat, setMode, setEco]) expect(f).not.toHaveBeenCalled();
});

/* ---------------------------------------------------------------- Q17: the Nest cadence */
describe('Q17 Nest cadence: 5 min 10:00–22:00 in cooling season (May–October), 15 min otherwise', () => {
  it('cooling season is May–October by Chicago calendar month', () => {
    expect(COOLING_MONTHS).toEqual([5, 6, 7, 8, 9, 10]);
  });

  // [Chicago time, minutes between samples, sample on a fresh slot?]
  const TABLE: Array<[string, 5 | 15, boolean]> = [
    // cooling season (July, CDT)
    ['2026-07-15 00:00', 15, true], ['2026-07-15 00:05', 15, false], ['2026-07-15 00:10', 15, false], ['2026-07-15 00:15', 15, true],
    ['2026-07-15 02:00', 15, true], ['2026-07-15 09:45', 15, true], ['2026-07-15 09:50', 15, false], ['2026-07-15 09:55', 15, false],
    ['2026-07-15 10:00', 5, true], ['2026-07-15 10:05', 5, true], ['2026-07-15 10:10', 5, true], ['2026-07-15 13:20', 5, true],
    ['2026-07-15 21:50', 5, true], ['2026-07-15 21:55', 5, true], ['2026-07-15 22:00', 15, true], ['2026-07-15 22:05', 15, false],
    ['2026-07-15 22:10', 15, false], ['2026-07-15 22:15', 15, true], ['2026-07-15 23:55', 15, false],
    // off season (January, CST)
    ['2026-01-15 00:00', 15, true], ['2026-01-15 00:05', 15, false], ['2026-01-15 10:00', 15, true], ['2026-01-15 10:05', 15, false],
    ['2026-01-15 10:10', 15, false], ['2026-01-15 10:15', 15, true], ['2026-01-15 13:20', 15, false], ['2026-01-15 13:30', 15, true],
    ['2026-01-15 21:55', 15, false], ['2026-01-15 22:00', 15, true],
    // season edges (noon + 5 min)
    ['2026-04-30 12:05', 15, false], ['2026-05-01 12:05', 5, true], ['2026-10-31 12:05', 5, true], ['2026-11-01 12:05', 15, false],
    // a late cron tick still counts for its slot until the next tick is due
    ['2026-01-15 10:15:40', 15, true], ['2026-01-15 10:19:59', 15, true], ['2026-07-15 10:04:59', 5, true],
  ];
  it.each(TABLE)('%s → every %i min, sample: %s', (local, every, sample) => {
    const t = at(local);
    expect(nestInterval(t)).toBe(every);
    expect(nestDue(t, null)).toBe(sample);                    // nothing sampled yet
    expect(nestDue(t, t - 5 * MIN)).toBe(sample);             // the previous tick sampled (an earlier slot)
    expect(nestDue(t, t)).toBe(false);                        // this slot is already sampled
    expect(tickMayBeDue(t) || !sample).toBe(true);            // a due tick is never cut off by the no-database pre-check
  });

  it('a whole day through nestTick: 192 samples in cooling season (144 + 48), 96 otherwise (was 288); acTick runs on each one', async () => {
    for (const [day, want, wantDaytime] of [['2026-07-15', 192, 144], ['2026-01-15', 96, 48]] as const) {
      H.reset();
      const acTick = vi.fn(async () => ({ sampled: true }));
      const sampled: string[] = [];
      for (const t of ticks(day)) { const r = await nestTick('s', t, acTick); if ('tick' in r) sampled.push(minuteOf(t)); }
      expect(sampled).toHaveLength(want);
      expect(acTick).toHaveBeenCalledTimes(want);
      expect(sampled.filter(m => m >= '10:00' && m < '22:00')).toHaveLength(wantDaytime);
      expect(sampled.filter(m => m < '10:00' || m >= '22:00').every(m => Number(m.slice(3)) % 15 === 0)).toBe(true);
      expect(H.store.get(nestSampleKey('s'))).toEqual({ at: ticks(day).at(-1)! - 10 * MIN }); // last sample 23:45
    }
  });

  it('overlapping invocations of one tick sample once (the slot is claimed in kv)', async () => {
    const acTick = vi.fn(async () => ({ sampled: true })), t = at('2026-07-15 10:05');
    const [a, b] = await Promise.all([nestTick('s', t, acTick), nestTick('s', t + 20_000, acTick)]);
    expect(acTick).toHaveBeenCalledTimes(1);
    expect([a, b]).toContainEqual({ skipped: 'already sampled', every: 5 });
  });

  it('not linked or not configured: no sample and no claim', async () => {
    const acTick = vi.fn(async () => ({}));
    H.S.nestLinked = false;
    expect(await nestTick('s', at('2026-07-15 10:00'), acTick)).toEqual({ skipped: 'nest not linked' });
    H.S.nestOn = false;
    expect(await nestTick('s', at('2026-07-15 10:00'), acTick)).toEqual({ skipped: 'nest not configured' });
    expect(acTick).not.toHaveBeenCalled();
    expect(H.store.has(nestSampleKey('s'))).toBe(false);
  });

  it('a failing acTick is logged as an error and does not stop the tick', async () => {
    const r = await nestTick('s', at('2026-07-15 10:00'), async () => { throw new Error('SDM 429'); });
    expect(r).toEqual({ every: 5, error: 'SDM 429' });
    expect(logs.error).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------------------- Q18: pool reads */
describe('Q18 pool reads: every 15 min of scheduled pump hours plus 02:00 and 05:00', () => {
  const expected = ['02:00', '05:00', ...Array.from({ length: 36 }, (_, i) => hhmm(600 + i * 15))];

  it('the current schedule (Pool 10a–7p, High Speed 2p–3p) reads 38 times a day', () => {
    const m = poolReadMinutes(CURRENT).map(hhmm);
    expect(m).toEqual(expected);
    expect(m).toHaveLength(38);
    expect(m.at(-1)).toBe('18:45');
  });

  it('poolDue: only on the quarter-hour tick, only once per quarter-hour', () => {
    const sched = Array.from({ length: 96 }, (_, i) => i >= 40 && i < 76);
    expect(poolDue(at('2026-07-15 10:00'), sched, null)).toBe(true);
    expect(poolDue(at('2026-07-15 10:05'), sched, null)).toBe(false);
    expect(poolDue(at('2026-07-15 10:15'), sched, at('2026-07-15 10:00'))).toBe(true);
    expect(poolDue(at('2026-07-15 10:15'), sched, at('2026-07-15 10:15:02'))).toBe(false);
    expect(poolDue(at('2026-07-15 19:00'), sched, null)).toBe(false);
    expect(poolDue(at('2026-07-15 02:00'), null, null)).toBe(true);
    expect(poolDue(at('2026-07-15 03:00'), null, null)).toBe(false);
  });

  /** Run every tick of a day through poolTick; readPool answers with the fixture snapshot at the tick's time. */
  const day = async (d: string, schedules = CURRENT) => {
    H.S.read = async () => poolSnapshot(H.S.now, { schedules });
    const reads: string[] = [];
    for (const t of ticks(d)) { H.S.now = t + 3_000; const r = await poolTick('s', t); if ('read' in r && r.read) reads.push(minuteOf(t)); }
    return reads;
  };

  it('a whole day through poolTick: 38 reads, all stored in pool_readings; the first read of the day learns the schedule', async () => {
    const reads = await day('2026-09-26');         // nothing cached: the 02:00 check reads, and its snapshot carries the schedule
    expect(reads).toEqual(expected);
    expect(readPool).toHaveBeenCalledTimes(38);
    expect(H.readings).toHaveLength(38);
    const [, , dayCol, hour, running, watts, rpm] = H.readings[2];   // 10:00
    expect([dayCol, hour, running, watts, rpm]).toEqual(['2026-09-26', 10, true, 153, 1500]);
  });

  it('light and freeze-protection schedules do not count as pump hours (fixture: Pool 8a–5p, High Speed 12p–1p, light 7p–10p)', async () => {
    const s = poolSnapshot(0).schedules.concat({ id: 4, circuitId: 132, start: 0, stop: 1440, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 });
    const reads = await day('2026-01-15', s);
    expect(reads).toEqual(['02:00', '05:00', ...Array.from({ length: 36 }, (_, i) => hhmm(480 + i * 15))]);
  });

  it('right after Autopilot applied a plan (pool:last cleared) the applied plan’s schedule is used', async () => {
    H.store.set('s:pool:last', null);
    H.store.set('s:pool:applied', { plan: { schedules: CURRENT.map(({ circuitId, start, stop }) => ({ circuitId, start, stop })) } });
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT });
    H.S.now = at('2026-09-26 10:00:03');
    expect(await poolTick('s', at('2026-09-26 10:00'))).toMatchObject({ read: true, rpm: 1500, watts: 153 });
  });

  it('with no schedule known, only the overnight checks read', async () => {
    H.S.read = async () => { throw new Error('unreachable'); };  // every read fails, so the schedule is never learned
    for (const t of ticks('2026-09-26')) await poolTick('s', t);
    expect(vi.mocked(readPool).mock.calls).toHaveLength(2);
    expect(logs.warn).toHaveBeenCalledTimes(2);
  });

  it('a failed read is logged once and skipped: no retry in the tick, nor in a second invocation for the same quarter-hour', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 09:30'), { schedules: CURRENT }));
    H.S.read = async () => { throw new Error('ScreenLogic: timeout'); };
    expect(await poolTick('s', at('2026-09-26 10:00'))).toEqual({ read: false, error: 'ScreenLogic: timeout' });
    expect(await poolTick('s', at('2026-09-26 10:00:40'))).toEqual({ skipped: 'already tried' });
    expect(await poolTick('s', at('2026-09-26 10:05'))).toEqual({ skipped: 'not due' });
    expect(readPool).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(String(logs.warn.mock.calls[0][0])).toContain('ScreenLogic: timeout');
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT });
    H.S.now = at('2026-09-26 10:15:02');
    expect(await poolTick('s', at('2026-09-26 10:15'))).toMatchObject({ read: true });  // the next quarter-hour tries again
  });

  it('a reading the app took earlier in the quarter-hour counts', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 10:15:30'), { schedules: CURRENT }));
    expect(await poolTick('s', at('2026-09-26 10:15:45'))).toEqual({ skipped: 'already read' });
    expect(readPool).not.toHaveBeenCalled();
    expect(H.store.has(poolReadKey('s'))).toBe(false);
  });

  it('not configured: nothing read, nothing queried', async () => {
    H.S.poolOn = false;
    expect(await poolTick('s', at('2026-09-26 10:00'))).toEqual({ skipped: 'pool not configured' });
    expect(H.counts).toEqual({ q: 0, kvGet: 0, kvSet: 0 });
  });
});

/* ---------------------------------------------------------------- the cron tick */
describe('cronTick', () => {
  const run = (t: number) => {
    const sites = vi.fn(async () => ['s']), acTick = vi.fn(async () => ({ sampled: true }));
    return { sites, acTick, go: () => cronTick(t, { sites, acTick }) };
  };

  it('a tick with nothing due answers without the database, a device or any log above debug', async () => {
    const c = run(at('2026-01-15 10:05'));
    expect(await c.go()).toEqual({ skipped: 'not due' });
    expect(c.sites).not.toHaveBeenCalled();
    expect(c.acTick).not.toHaveBeenCalled();
    expect(readPool).not.toHaveBeenCalled();
    expect(H.counts).toEqual({ q: 0, kvGet: 0, kvSet: 0 });
    expect(logs.debug).toHaveBeenCalledTimes(1);
    for (const k of ['log', 'info', 'warn', 'error'] as const) expect(logs[k]).not.toHaveBeenCalled();
  });

  it('nothing configured: skipped before the clock is even checked', async () => {
    H.S.nestOn = false; H.S.poolOn = false;
    expect(await run(at('2026-07-15 10:00')).go()).toEqual({ skipped: 'nest and pool not configured' });
    expect(H.counts).toEqual({ q: 0, kvGet: 0, kvSet: 0 });
  });

  it('a due tick samples Nest (with acTick) and reads the pool side by side', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-07-15 09:30'), { schedules: CURRENT }));
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT }); H.S.now = at('2026-07-15 10:00:02');
    const c = run(at('2026-07-15 10:00'));
    expect(await c.go()).toEqual({ s: { nest: { every: 5, tick: { sampled: true } }, pool: { read: true, at: at('2026-07-15 10:00:02'), running: true, rpm: 1500, watts: 153 } } });
    expect(c.acTick).toHaveBeenCalledWith('s');
  });

  it('a whole cooling-season day: 192 acTicks, 38 pool reads, and every skipped tick logs at debug only', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-07-15 00:00') - 30 * MIN, { schedules: CURRENT }));
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT });
    const acTick = vi.fn(async () => ({ sampled: true }));
    let quiet = 0;
    for (const t of ticks('2026-07-15')) {
      H.S.now = t + 2_000;
      const r = await cronTick(t, { sites: async () => ['s'], acTick });
      if ('skipped' in r) quiet++;
    }
    expect(acTick).toHaveBeenCalledTimes(192);
    expect(readPool).toHaveBeenCalledTimes(38);
    expect(quiet).toBe(288 - 192);                 // ticks with nothing due answer before the database
    for (const k of ['log', 'info', 'warn', 'error'] as const) expect(logs[k]).not.toHaveBeenCalled();
    expect(logs.debug.mock.calls.length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- no path reaches a real device */
describe('no path reaches a real device', () => {
  it('readPool (the real one) with no fake session hits the node-screenlogic stub, which throws; poolTick logs it and moves on', async () => {
    const real = await vi.importActual<typeof import('../../server/src/appliances/screenlogic.js')>('../../server/src/appliances/screenlogic.js');
    await expect(real.readPool()).rejects.toThrow('node-screenlogic is blocked in tests');
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 09:30'), { schedules: CURRENT }));
    H.S.read = () => real.readPool();
    const r = await poolTick('s', at('2026-09-26 10:00'));
    expect(r).toEqual({ read: false, error: 'node-screenlogic is blocked in tests' });
    expect(H.readings).toHaveLength(0);
  });

  it('readPool only reads: every session call is a get…Async, made with the 8000 ms netTimeout', async () => {
    const real = await vi.importActual<typeof import('../../server/src/appliances/screenlogic.js')>('../../server/src/appliances/screenlogic.js');
    const unit = readOnlyUnit();
    const snap = await real.readPool(unit.run as any);
    expect(unit.calls.map(c => c.path).sort()).toEqual(['equipment.getControllerConfigAsync', 'equipment.getEquipmentConfigurationAsync',
      'equipment.getEquipmentStateAsync', 'getVersionAsync', 'pump.getPumpStatusAsync', 'schedule.getScheduleDataAsync']);
    expect(unit.calls.every(c => c.netTimeout === 8000)).toBe(true);
    expect(snap.pump).toMatchObject({ id: 1, running: true, watts: 153, rpm: 1500, gpm: null });
    expect(snap.schedules.map(s => [s.circuitId, s.start, s.stop])).toEqual([[6, 600, 1140], [8, 840, 900]]);
    expect(poolReadMinutes(snap.schedules)).toHaveLength(38);
  });

  it('the read-only fake refuses anything that is not a read', async () => {
    const unit = readOnlyUnit();
    await expect(unit.conn.pump.setPumpSpeedAsync(1, 0, 1500, true)).rejects.toThrow('not a read');
    await expect(unit.conn.schedule.deleteScheduleEventByIdAsync(1)).rejects.toThrow('not a read');
  });
});
