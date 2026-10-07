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
    if (/FROM trips WHERE site_id = \$1 AND state IN \('planned', 'active'\)/.test(text)) return [];   // Vacation mode: no trip (an outside run asks)
    throw new Error(`unexpected query in sampling test: ${text.slice(0, 60)}`);
  };
  const kv = {
    get: async (k: string) => { counts.kvGet++; return clone(store.get(k)) as any; },
    set: async (k: string, v: unknown) => { counts.kvSet++; store.set(k, clone(v)); },
  };
  const S = { nestOn: true, nestLinked: true, poolOn: true, now: 0, read: null as null | (() => Promise<unknown>), trip: null as null | { id: number } };
  const reset = () => { store.clear(); readings.length = 0; Object.assign(counts, { q: 0, kvGet: 0, kvSet: 0 }); Object.assign(S, { nestOn: true, nestLinked: true, poolOn: true, now: 0, read: null, trip: null }); };
  return { store, readings, counts, db: { q, one: async (t: string, p: unknown[] = []) => (await q(t, p))[0], kv, migrate: async () => {} }, S, reset };
});

vi.mock('../../server/src/db.js', () => H.db);
vi.mock('../../server/src/appliances/screenlogic.js', () => ({
  configured: () => H.S.poolOn,
  readPool: vi.fn(async () => { if (!H.S.read) throw new Error('no fake read set'); return H.S.read(); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan must never run from the cron'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit must never run from the cron'); }),
}));
// Vacation mode: a trip under way when H.S.trip is set; the trip's outside-run line and push (tripOutsideRun) are recorded, not sent
vi.mock('../../server/src/vacation/pool.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/vacation/pool.js')>();
  return { ...real, awayNow: vi.fn(async () => H.S.trip), tripOutsideRun: vi.fn(async () => {}) };
});
vi.mock('../../server/src/appliances/nest.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/appliances/nest.js')>();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} must never run in the sampling test`); });
  return { ...real, nestConfigured: () => H.S.nestOn, nestLinked: vi.fn(async () => H.S.nestLinked),
    readNest: blocked('readNest'), setCool: blocked('setCool'), ownerCommand: blocked('ownerCommand') };
});

import {
  nestDue, nestInterval, poolDue, poolReadMinutes, tickMayBeDue, nestTick, poolTick, cronTick, nestSampleKey, poolReadKey, COOLING_MONTHS,
} from '../../server/src/appliances/sampling.js';
import { readPool, writePoolPlan, withUnit } from '../../server/src/appliances/screenlogic.js';
import { readNest, setCool, ownerCommand } from '../../server/src/appliances/nest.js';
import { tripOutsideRun } from '../../server/src/vacation/pool.js';

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
  for (const f of [writePoolPlan, withUnit, readNest, setCool, ownerCommand]) expect(f).not.toHaveBeenCalled();
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
// Reads sit 5 minutes into each quarter-hour (:05, :20, :35, :50), clear of the pump priming when a schedule starts or changes
// speed on the quarter-hour; they used to land on :00, :15, :30 and :45, with the overnight checks at 02:00 and 05:00.
describe('Q18 pool reads: every 15 min of scheduled pump hours at :05/:20/:35/:50, plus HH:05 of every other hour', () => {
  /** Reads for pump hours [from, to) in minutes: every quarter-hour inside, and HH:05 of each hour outside (runs started elsewhere, the overnight checks). */
  const readsFor = (from: number, to: number) => Array.from({ length: 96 }, (_, i) => i * 15 + 5).filter(m => (m >= from && m < to) || m % 60 === 5).map(hhmm);
  const expected = readsFor(600, 1140);   // Pool 10a–7p (High Speed 2p–3p sits inside): 36 + 15 hourly = 51

  it('the current schedule (Pool 10a–7p, High Speed 2p–3p) reads 51 times a day, never on the quarter-hour', () => {
    const m = poolReadMinutes(CURRENT).map(hhmm);
    expect(m).toEqual(expected);
    expect(m).toHaveLength(51);
    expect(m.slice(9, 12)).toEqual(['09:05', '10:05', '10:20']);   // hourly before the program, then every quarter-hour          // 5 minutes after the Pool program starts
    expect(m).toContain('14:05');                               // 5 minutes after High Speed starts
    expect(m.slice(-6)).toEqual(['18:50', '19:05', '20:05', '21:05', '22:05', '23:05']);
    expect(m.every(x => Number(x.slice(3)) % 15 === 5)).toBe(true);
  });

  it('poolDue: only on the :05/:20/:35/:50 tick, only once per slot', () => {
    const sched = Array.from({ length: 96 }, (_, i) => i >= 40 && i < 76);
    expect(poolDue(at('2026-07-15 10:00'), sched, null)).toBe(false);
    expect(poolDue(at('2026-07-15 10:05'), sched, null)).toBe(true);
    expect(poolDue(at('2026-07-15 10:10'), sched, null)).toBe(false);
    expect(poolDue(at('2026-07-15 10:15'), sched, null)).toBe(false);
    expect(poolDue(at('2026-07-15 10:20'), sched, at('2026-07-15 10:05'))).toBe(true);
    expect(poolDue(at('2026-07-15 10:20'), sched, at('2026-07-15 10:20:02'))).toBe(false);
    expect(poolDue(at('2026-07-15 09:50'), sched, null)).toBe(false);   // before the Pool program starts
    expect(poolDue(at('2026-07-15 18:50'), sched, null)).toBe(true);
    expect(poolDue(at('2026-07-15 19:05'), sched, null)).toBe(true);    // the hourly read outside the schedule
    expect(poolDue(at('2026-07-15 19:20'), sched, null)).toBe(false);
    expect(poolDue(at('2026-07-15 02:00'), null, null)).toBe(false);
    expect(poolDue(at('2026-07-15 02:05'), null, null)).toBe(true);
    expect(poolDue(at('2026-07-15 05:05'), null, null)).toBe(true);
    expect(poolDue(at('2026-07-15 03:05'), null, null)).toBe(true);
    expect(poolDue(at('2026-07-15 03:20'), null, null)).toBe(false);
  });

  /** Run every tick of a day through poolTick; readPool answers with the fixture snapshot at the tick's time. */
  const day = async (d: string, schedules = CURRENT) => {
    H.S.read = async () => poolSnapshot(H.S.now, { schedules });
    const reads: string[] = [];
    for (const t of ticks(d)) { H.S.now = t + 3_000; const r = await poolTick('s', t); if ('read' in r && r.read) reads.push(minuteOf(t)); }
    return reads;
  };

  it('a whole day through poolTick: 51 reads, all stored in pool_readings; the first read of the day learns the schedule', async () => {
    const reads = await day('2026-09-26');         // nothing cached: the 00:05 read's snapshot carries the schedule
    expect(reads).toEqual(expected);
    expect(readPool).toHaveBeenCalledTimes(51);
    expect(H.readings).toHaveLength(51);
    const [, , dayCol, hour, running, watts, rpm] = H.readings[10];   // 10:05
    expect([dayCol, hour, running, watts, rpm]).toEqual(['2026-09-26', 10, true, 153, 1500]);
  });

  it('light and freeze-protection schedules do not count as pump hours (fixture: Pool 8a–5p, High Speed 12p–1p, light 7p–10p)', async () => {
    const s = poolSnapshot(0).schedules.concat({ id: 4, circuitId: 132, start: 0, stop: 1440, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 });
    const reads = await day('2026-01-15', s);
    expect(reads).toEqual(readsFor(480, 1020));   // Pool 8a–5p; the light and freeze programs add nothing
  });

  it('a run outside the schedule during the controller\'s freeze protection is not taken for somebody\'s run; the same run otherwise is', async () => {
    const run = (freezeMode: boolean) => async () => ({ ...poolSnapshot(H.S.now, { schedules: CURRENT, running: true, rpm: 1000, watts: 45 }), freezeMode });
    H.S.read = run(true); H.S.now = at('2026-01-15 02:05') + 3_000;
    expect(await poolTick('s', at('2026-01-15 02:05'))).toMatchObject({ read: true, running: true });
    expect(H.store.get('s:pool:outsideRuns')).toBeUndefined();
    H.S.read = run(false); H.S.now = at('2026-01-15 03:05') + 3_000;
    expect(await poolTick('s', at('2026-01-15 03:05'))).toMatchObject({ read: true, running: true });
    expect(H.store.get('s:pool:outsideRuns')).toHaveLength(1);
  });

  it('isRunning at 0 RPM / 0 W outside the schedule (the IntelliFlo at night, seen 2026-10-07) is no outside run and no trip push; 1750 RPM / 240 W is', async () => {
    vi.mocked(tripOutsideRun).mockClear();
    const read = (rpm: number, watts: number) => async () => poolSnapshot(H.S.now, { schedules: CURRENT, running: true, rpm, watts });
    const tick = (t: string) => { H.S.now = at(t) + 3_000; return poolTick('s', at(t)); };
    H.S.read = read(0, 0);
    expect(await tick('2026-10-07 00:05')).toMatchObject({ read: true, running: true, rpm: 0, watts: 0 });
    expect(H.readings[0].slice(4, 7)).toEqual([true, 0, 0]);             // pool_readings keeps the raw read
    H.S.trip = { id: 7 };
    expect(await tick('2026-10-07 02:05')).toMatchObject({ read: true, running: true, rpm: 0 });
    expect(H.store.get('s:pool:outsideRuns')).toBeUndefined();
    expect(tripOutsideRun).not.toHaveBeenCalled();                       // no "started outside the plan" push during a trip
    H.S.read = read(1750, 240);
    expect(await tick('2026-10-07 03:05')).toMatchObject({ read: true, rpm: 1750, watts: 240 });
    expect(tripOutsideRun).toHaveBeenCalledTimes(1);                     // a real run during a trip still goes to the trip
    H.S.trip = null;
    expect(await tick('2026-10-07 04:05')).toMatchObject({ read: true, rpm: 1750 });
    expect(H.store.get('s:pool:outsideRuns')).toHaveLength(1);           // and, with no trip, to the pool's learning as before
  });

  it('a run covered by a run-once (egg-timer) schedule on the controller is recorded as such, not as somebody at the panel; during a trip the trip hears which', async () => {
    vi.mocked(tripOutsideRun).mockClear();
    const once = [{ id: 9, circuitId: 6, start: 5 * 60 + 30, stop: 7 * 60, dayMask: 0, flags: 0, heatCmd: 4, heatSetPoint: 70 }];   // Pool 05:30–07:00 once
    H.S.read = async () => ({ ...poolSnapshot(H.S.now, { schedules: CURRENT, running: true, rpm: 1750, watts: 240 }), runOnce: once });
    H.S.now = at('2026-10-07 05:05') + 3_000; await poolTick('s', at('2026-10-07 05:05'));   // the first read: the schedule comes from this snapshot
    expect(H.store.get('s:pool:outsideRuns')).toBeUndefined();                                 // 05:05 is outside the run-once window, and no schedule was known yet
    H.S.now = at('2026-10-07 06:05') + 3_000; await poolTick('s', at('2026-10-07 06:05'));
    expect(H.store.get('s:pool:outsideRuns')).toMatchObject([{ source: 'runOnce' }]);
    H.S.trip = { id: 7 };
    H.S.now = at('2026-10-08 03:05') + 3_000; await poolTick('s', at('2026-10-08 03:05'));   // 03:05: the run-once window doesn't cover it
    expect(vi.mocked(tripOutsideRun).mock.calls[0][3]).toEqual({ runOnce: false });
    H.S.now = at('2026-10-08 06:05') + 3_000; await poolTick('s', at('2026-10-08 06:05'));
    expect(vi.mocked(tripOutsideRun).mock.calls[1][3]).toEqual({ runOnce: true });
    H.S.trip = null;
  });

  it('right after Autopilot applied a plan (pool:last cleared) the applied plan’s schedule is used', async () => {
    H.store.set('s:pool:last', null);
    H.store.set('s:pool:applied', { plan: { schedules: CURRENT.map(({ circuitId, start, stop }) => ({ circuitId, start, stop })) } });
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT });
    H.S.now = at('2026-09-26 10:05:03');
    expect(await poolTick('s', at('2026-09-26 10:05'))).toMatchObject({ read: true, rpm: 1500, watts: 153 });
  });

  it('with no schedule known, only the hourly reads happen (24)', async () => {
    H.S.read = async () => { throw new Error('unreachable'); };  // every read fails, so the schedule is never learned
    for (const t of ticks('2026-09-26')) await poolTick('s', t);
    expect(vi.mocked(readPool).mock.calls).toHaveLength(24);
    expect(logs.warn).toHaveBeenCalledTimes(24);
  });

  it('a failed read is logged once and skipped: no retry in the tick, nor in a second invocation for the same slot', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 09:30'), { schedules: CURRENT }));
    H.S.read = async () => { throw new Error('ScreenLogic: timeout'); };
    expect(await poolTick('s', at('2026-09-26 10:05'))).toEqual({ read: false, error: 'ScreenLogic: timeout' });
    expect(await poolTick('s', at('2026-09-26 10:05:40'))).toEqual({ skipped: 'already tried' });
    expect(await poolTick('s', at('2026-09-26 10:10'))).toEqual({ skipped: 'not due' });
    expect(readPool).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(String(logs.warn.mock.calls[0][0])).toContain('ScreenLogic: timeout');
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT });
    H.S.now = at('2026-09-26 10:20:02');
    expect(await poolTick('s', at('2026-09-26 10:20'))).toMatchObject({ read: true });  // the next slot tries again
  });

  it('a reading the app took earlier in the slot counts; one taken before the slot started does not', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 10:20:30'), { schedules: CURRENT }));
    expect(await poolTick('s', at('2026-09-26 10:20:45'))).toEqual({ skipped: 'already read' });
    expect(readPool).not.toHaveBeenCalled();
    expect(H.store.has(poolReadKey('s'))).toBe(false);
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 10:17'), { schedules: CURRENT }));   // before the 10:20 slot
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT }); H.S.now = at('2026-09-26 10:20:03');
    expect(await poolTick('s', at('2026-09-26 10:20'))).toMatchObject({ read: true });
  });

  it('not configured: nothing read, nothing queried', async () => {
    H.S.poolOn = false;
    expect(await poolTick('s', at('2026-09-26 10:05'))).toEqual({ skipped: 'pool not configured' });
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
    const c = run(at('2026-01-15 10:10'));      // off season: Nest samples at :00/:15/:30/:45, the pool reads at :05/:20/:35/:50
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
    H.S.read = async () => poolSnapshot(H.S.now, { schedules: CURRENT }); H.S.now = at('2026-07-15 10:05:02');
    const c = run(at('2026-07-15 10:05'));
    expect(await c.go()).toEqual({ s: { nest: { every: 5, tick: { sampled: true } }, pool: { read: true, at: at('2026-07-15 10:05:02'), running: true, rpm: 1500, watts: 153 } } });
    expect(c.acTick).toHaveBeenCalledWith('s');
  });

  it('a whole cooling-season day: 192 acTicks, 51 pool reads, and every skipped tick logs at debug only', async () => {
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
    expect(readPool).toHaveBeenCalledTimes(51);
    // ticks with nothing due answer before the database: outside 10:00–22:00 Nest samples at :00/:15/:30/:45 and the pool slots
    // are :05/:20/:35/:50, so 4 of every 12 ticks there are quiet (it was 288 − 192 = 96 when both used the quarter-hour)
    expect(quiet).toBe(48);
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
    const r = await poolTick('s', at('2026-09-26 10:05'));
    expect(r).toEqual({ read: false, error: 'node-screenlogic is blocked in tests' });
    expect(H.readings).toHaveLength(0);
  });

  it('readPool only reads: every session call is a get…Async, made with the 8000 ms netTimeout', async () => {
    const real = await vi.importActual<typeof import('../../server/src/appliances/screenlogic.js')>('../../server/src/appliances/screenlogic.js');
    const unit = readOnlyUnit();
    const snap = await real.readPool(unit.run as any);
    expect(unit.calls.map(c => c.path).sort()).toEqual(['equipment.getControllerConfigAsync', 'equipment.getEquipmentConfigurationAsync',
      'equipment.getEquipmentStateAsync', 'getVersionAsync', 'pump.getPumpStatusAsync', 'schedule.getScheduleDataAsync', 'schedule.getScheduleDataAsync']);   // recurring (0) and run-once (1)
    expect(snap.runOnce).toEqual([]);                                     // none set on the fake controller
    // the real controller answered the run-once query with its recurring programs (2026-10-07): those ids are not run-once schedules
    const unit2 = readOnlyUnit({ 'schedule.getScheduleDataAsync:1': { data: [
      { scheduleId: 1, circuitId: 6, startTime: '1000', stopTime: '1900', dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
      { scheduleId: 9, circuitId: 6, startTime: '0530', stopTime: '0700', dayMask: 0, flags: 0, heatCmd: 4, heatSetPoint: 70 }] } });
    const snap2 = await real.readPool(unit2.run as any);
    expect(snap2.runOnce).toEqual([expect.objectContaining({ id: 9, circuitId: 6, start: 330, stop: 420 })]);
    expect(unit.calls.every(c => c.netTimeout === 8000)).toBe(true);
    expect(snap.pump).toMatchObject({ id: 1, running: true, watts: 153, rpm: 1500, gpm: null });
    expect(snap.schedules.map(s => [s.circuitId, s.start, s.stop])).toEqual([[6, 600, 1140], [8, 840, 900]]);
    expect(poolReadMinutes(snap.schedules)).toHaveLength(51);
  });

  it('the read-only fake refuses anything that is not a read', async () => {
    const unit = readOnlyUnit();
    await expect(unit.conn.pump.setPumpSpeedAsync(1, 0, 1500, true)).rejects.toThrow('not a read');
    await expect(unit.conn.schedule.deleteScheduleEventByIdAsync(1)).rejects.toThrow('not a read');
  });
});

/* ---------------------------------------------------------------- C-01: a session that never answers */
/**
 * Fake node-screenlogic classes (no sockets): the dispatcher, or the unit, never answers. The unit behaves like the library on a
 * refused connection: every second its socket errors and reconnectAsync opens a new connection, forever.
 */
function silentController(stage: 'dispatcher' | 'unit') {
  const seen = { gwDestroyed: 0, unitDestroyed: 0, unitConnects: 0, units: 0 };
  class FakeRemoteLogin {
    _client = { destroy: () => { seen.gwDestroyed++; }, removeAllListeners: () => {} };
    constructor(_name: string) {}
    connectAsync() { return stage === 'dispatcher' ? new Promise(() => {}) : Promise.resolve({ gatewayFound: true, ipAddr: '192.0.2.1', port: 80 }); }
    closeAsync() { return Promise.resolve(true); }
    removeAllListeners() {}
  }
  class FakeUnit {
    client: any = null;
    reconnectAsync = async () => { await this.connectAsync(); };   // as in node-screenlogic: the 'error' handler reconnects
    constructor() { seen.units++; }
    init() {}
    connectAsync() {
      seen.unitConnects++;
      const t = setTimeout(() => { this.client = null; void this.reconnectAsync(); }, 1_000);   // ECONNREFUSED a second later
      this.client = { destroy: () => { clearTimeout(t); seen.unitDestroyed++; }, removeAllListeners: () => {} };
      return new Promise(() => {});
    }
    closeAsync() { return Promise.resolve(true); }
    removeAllListeners() {}
  }
  return { lib: { RemoteLogin: FakeRemoteLogin, UnitConnection: FakeUnit } as any, seen };
}

describe('C-01: a ScreenLogic session has one overall deadline', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const real = () => vi.importActual<typeof import('../../server/src/appliances/screenlogic.js')>('../../server/src/appliances/screenlogic.js');

  it('a dispatcher that never answers: readPool rejects at 20 s, not before, and its socket is destroyed', async () => {
    const sl = await real(), fake = silentController('dispatcher');
    let settled: string | null = null;
    const p = sl.readPool((fn, ms) => sl.withUnit(fn, ms, fake.lib)).then(() => 'resolved', (e: Error) => e.message).then(r => { settled = r; });
    await vi.advanceTimersByTimeAsync(19_900);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(settled).toBe('ScreenLogic: no answer within 20 s');
    expect(fake.seen.gwDestroyed).toBe(1);
    expect(fake.seen.units).toBe(0);   // the unit was never reached
  });

  it('a unit that refuses: readPool rejects at 20 s and the reconnect loop stops', async () => {
    const sl = await real(), fake = silentController('unit');
    const p = sl.readPool((fn, ms) => sl.withUnit(fn, ms, fake.lib)).then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toBe('ScreenLogic: no answer within 20 s');
    expect(fake.seen.unitConnects).toBeGreaterThan(10);   // the library kept reconnecting until the deadline
    expect(fake.seen.unitDestroyed).toBe(1);
    const n = fake.seen.unitConnects;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.seen.unitConnects).toBe(n);              // and not once after it
  });

  it('writes get 40 s', async () => {
    const sl = await real(), fake = silentController('dispatcher');
    const p = sl.withUnit(async () => 'done', sl.WRITE_DEADLINE_MS, fake.lib).then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toBe('ScreenLogic: no answer within 40 s');
  });

  it('cronTick with a silent controller: the Nest half is done and the tick returns once the pool read gives up', async () => {
    const sl = await real(), fake = silentController('unit');
    H.store.set('s:pool:last', poolSnapshot(at('2026-07-15 09:30'), { schedules: CURRENT }));
    H.S.read = () => sl.readPool((fn, ms) => sl.withUnit(fn, ms, fake.lib));
    const acTick = vi.fn(async () => ({ sampled: true }));
    let out: unknown = null;
    const p = cronTick(at('2026-07-15 10:05'), { sites: async () => ['s'], acTick }).then(r => { out = r; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acTick).toHaveBeenCalledWith('s');   // the Nest sample ran without waiting for the pool
    await vi.advanceTimersByTimeAsync(19_000);
    await p;
    expect(out).toEqual({ s: { nest: { every: 5, tick: { sampled: true } }, pool: { read: false, error: 'ScreenLogic: no answer within 20 s' } } });
    expect(H.readings).toHaveLength(0);
  });

  it('cronTick: a pool half that throws outside the read is reported, not thrown', async () => {
    vi.useRealTimers();
    const get = H.db.kv.get;
    vi.spyOn(H.db.kv, 'get').mockImplementation(async (k: string) => { if (k === 's:pool:last') throw new Error('database hiccup'); return get(k); });
    const acTick = vi.fn(async () => ({ sampled: true }));
    expect(await cronTick(at('2026-07-15 10:05'), { sites: async () => ['s'], acTick }))
      .toEqual({ s: { nest: { every: 5, tick: { sampled: true } }, pool: { read: false, error: 'database hiccup' } } });
  });
});

/* ---------------------------------------------------------------- C-09: a failed pump-status read is unknown, not "off" */
describe('C-09: a failed pump-status read', () => {
  const real = () => vi.importActual<typeof import('../../server/src/appliances/screenlogic.js')>('../../server/src/appliances/screenlogic.js');
  /** The read-only fake, with the pump-status request timing out. */
  const noStatus = () => {
    const unit = readOnlyUnit();
    const conn = new Proxy(unit.conn, { get: (t, k) => k === 'pump' ? { getPumpStatusAsync: async () => { throw new Error('time out waiting for pump status'); } } : t[k] });
    return { run: async <T>(fn: (c: any) => Promise<T>) => fn(conn) };
  };
  const unknownSnap = (at: number) => { const s = poolSnapshot(at, { schedules: CURRENT }); s.pump = { ...s.pump!, running: null, watts: null, rpm: null, status: 'unknown' }; return s; };

  it('readPool marks the pump unknown with running, watts and rpm null; the circuits come from the configuration', async () => {
    const sl = await real();
    const snap = await sl.readPool(noStatus().run as any);
    expect(snap.pump).toMatchObject({ id: 1, status: 'unknown', running: null, watts: null, rpm: null, gpm: null });
    expect((await sl.readPool(readOnlyUnit().run as any)).pump).not.toHaveProperty('status');   // a good read has none
  });
  it('pumpRunning: unknown is never a run', async () => {
    const { pumpRunning } = await import('../../server/src/appliances/pool.js');
    expect(pumpRunning({ running: true, rpm: 1500, watts: 150, status: 'unknown' })).toBe(false);
    expect(pumpRunning({ running: null, rpm: null, watts: null })).toBe(false);
    expect(pumpRunning({ running: true, rpm: 1500, watts: 150 })).toBe(true);
  });
  it('poolTick in pump hours: no pool_readings row, the time is kept, pool:last still updates', async () => {
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 09:30'), { schedules: CURRENT }));
    H.S.now = at('2026-09-26 10:05:02'); H.S.read = async () => unknownSnap(H.S.now);
    expect(await poolTick('s', at('2026-09-26 10:05'))).toEqual({ read: true, at: H.S.now, running: null, rpm: null, watts: null });
    expect(H.readings).toHaveLength(0);
    expect(H.store.get('s:pool:statusUnknownAt')).toBe(H.S.now);
    expect((H.store.get('s:pool:last') as any).pump.status).toBe('unknown');
  });
  it('poolTick outside pump hours: an unknown read is not an outside run', async () => {
    vi.mocked(tripOutsideRun).mockClear();
    H.store.set('s:pool:last', poolSnapshot(at('2026-09-26 05:30'), { schedules: CURRENT }));
    H.S.read = async () => { const s = unknownSnap(H.S.now); s.pump!.running = true; return s; };   // even with a stray flag
    H.S.trip = { id: 1 }; H.S.now = at('2026-09-26 06:05:02');
    expect(await poolTick('s', at('2026-09-26 06:05'))).toMatchObject({ read: true });
    expect(tripOutsideRun).not.toHaveBeenCalled();                       // no trip push
    H.S.trip = null; H.S.now = at('2026-09-26 07:05:02');
    expect(await poolTick('s', at('2026-09-26 07:05'))).toMatchObject({ read: true });
    expect(H.store.get('s:pool:outsideRuns')).toBeUndefined();           // nor the pool's learning
  });
});
