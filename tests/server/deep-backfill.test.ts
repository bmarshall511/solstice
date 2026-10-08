// I-16 deep history back-fill (server/src/deepBackfill.ts): night window, 3 days a tick, cursor, install-date stop, empty days,
// DST days, the done flag keeping idle ticks off the database, the 429 rest, the status numbers, and syncSite's 400-day window.
//
// Self-contained like sync-window.test.ts: the real db.ts on its own in-memory PGlite (every call counted), and a fake `teslaFor`,
// so nothing reaches the network or Neon. All data and dates are synthetic.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { EnergyBucket } from '../../server/src/tesla/client.js';

const fake = vi.hoisted(() => {
  process.env.DATABASE_URL = 'pglite:memory://';
  const state = {
    calls: [] as Array<{ kind: 'energy' | 'soe'; day: string }>,
    count: {} as Record<string, number>,          // buckets Tesla returns for a day; default is the whole window
    fail: new Map<string, string>(),              // day → error message Tesla answers with
    installed: {} as Record<string, string>,
    db: 0,                                        // database calls made through db.ts's exports
  };
  const bucket = (timestamp: string): EnergyBucket => ({
    timestamp, solar_energy_exported: 60, battery_energy_exported: 5,
    consumer_energy_imported_from_solar: 20, battery_energy_imported_from_solar: 30, grid_energy_exported_from_solar: 10,
    consumer_energy_imported_from_battery: 5, grid_energy_exported_from_battery: 0,
    consumer_energy_imported_from_grid: 15, battery_energy_imported_from_grid: 2,
  });
  return { state, bucket };
});

vi.mock('../../server/src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/db.js')>();
  const count = <F extends (...a: any[]) => any>(f: F) => ((...a: Parameters<F>) => { fake.state.db++; return f(...a); }) as F;
  return { ...real, q: count(real.q), one: count(real.one),
    kv: { get: count(real.kv.get), set: count(real.kv.set), claim: count(real.kv.claim) } };
});
vi.mock('../../server/src/tesla/client.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../server/src/tesla/client.js')>();
  const series = (start: string, end: string) => {
    const day = start.slice(0, 10), out: string[] = [], stop = Math.min(Date.parse(end), real.localMidnight(real.addDays(day, 1)).getTime() - 1);
    for (let t = real.localMidnight(day).getTime(); t <= stop; t += 300_000) if (t >= Date.parse(start)) out.push(real.rfc3339(new Date(t)));
    return out.slice(0, fake.state.count[day] ?? out.length);
  };
  const teslaFor = () => ({
    energy: async (_s: string, start: string, end: string) => {
      const day = start.slice(0, 10); fake.state.calls.push({ kind: 'energy', day });
      const err = fake.state.fail.get(day); if (err) throw new Error(err);
      return { time_series: series(start, end).map(fake.bucket) };
    },
    soe: async (_s: string, start: string, end: string) => {
      fake.state.calls.push({ kind: 'soe', day: start.slice(0, 10) });
      return { time_series: series(start, end).filter((_, i) => i % 3 === 0).map(timestamp => ({ timestamp, soe: 80 })) };
    },
    liveStatus: async () => ({ solar_power: 0, battery_power: 0, grid_power: 0, load_power: 0, percentage_charged: 80,
      grid_status: 'Active', island_status: 'on_grid', storm_mode_active: false, timestamp: new Date().toISOString() }),
    siteInfo: async (site: string) => ({ site_name: 'Test', installation_date: fake.state.installed[site] }),
    backups: async () => ({ events: [] }),
  });
  return { ...real, teslaFor };
});

import { q, one, kv, migrate } from '../../server/src/db.js';
import { addDays } from '../../server/src/tesla/client.js';
import { config } from '../../server/src/config.js';
import { syncSite } from '../../server/src/sync.js';
import { deepTick, deepStatus, deepDue, notePass, resetDeepCache, inDeepWindow, deepKey, deepDoneKey, DEEP_BACKOFF_MS, type DeepState } from '../../server/src/deepBackfill.js';

// a synthetic "today"; the deep range ends 401 days back: 2025-08-19
const TODAY = '2026-09-24', THROUGH = '2025-08-19';
const at = (hhmm: string, day = TODAY) => Date.parse(`${day}T${hhmm}:00-05:00`);   // CDT
const NIGHT = at('02:00');
const FAR = Number.MAX_SAFE_INTEGER;   // stopAt: no time budget pressure
const tick = (site: string, now = NIGHT, stopAt = FAR) => deepTick(site, now, { stopAt }) as Promise<Record<string, any>>;
const energyDays = () => fake.state.calls.filter(c => c.kind === 'energy').map(c => c.day);
const counts = async (site: string) => Object.fromEntries((await q<{ day: string; n: number }>(
  `SELECT day, COUNT(*)::int n FROM energy WHERE site_id = $1 GROUP BY day ORDER BY day`, [site])).map(r => [r.day, r.n]));
async function addSite(id: string, installed: string) {
  fake.state.installed[id] = installed;
  const a = await one<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'x', 'x', 0) RETURNING id`);
  await q(`INSERT INTO sites (id, tesla_account_id, name, info, info_at) VALUES ($1, $2, 'Test', $3, now())`,
    [id, a!.id, JSON.stringify({ installation_date: `${installed}T09:00:00-06:00` })]);
}
/** Let the per-tick claim lapse (ticks are 5 minutes apart in production). */
const nextTick = (site: string) => q(`DELETE FROM kv WHERE key = $1`, [`${site}:backfill:deep:claim`]);
async function runToDone(site: string, max = 100) {
  for (let i = 0; i < max; i++) { await nextTick(site); const r = await tick(site); if (r.done || r.skipped === 'done') return i + 1; }
  throw new Error('never finished');
}

beforeAll(async () => { await migrate(); vi.stubGlobal('fetch', () => { throw new Error('network in test'); }); });
beforeEach(() => {
  fake.state.calls.length = 0; fake.state.count = {}; fake.state.fail.clear(); fake.state.db = 0;
  resetDeepCache();
  vi.useFakeTimers({ toFake: ['Date'], now: NIGHT });
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('night window', () => {
  it('runs only 01:30–06:00 Chicago, and outside it touches neither the database nor Tesla', async () => {
    expect([at('01:29'), at('01:30'), at('05:59'), at('06:00'), at('13:00')].map(inDeepWindow)).toEqual([false, true, true, false, false]);
    expect(inDeepWindow(Date.parse('2026-01-15T02:00:00-06:00'))).toBe(true);   // CST too
    await addSite('win', addDays(THROUGH, -10));
    fake.state.db = 0;
    for (const t of [at('01:29'), at('06:00'), at('13:00')]) expect(await tick('win', t)).toEqual({ skipped: 'outside 01:30–06:00' });
    expect(fake.state.db).toBe(0);
    expect(fake.state.calls).toEqual([]);
    expect(deepDue(at('13:00'))).toBe(false);
  });
});

describe('fetching', () => {
  it('pulls at most 3 days a tick, newest missing first, and the cursor resumes where it stopped', async () => {
    await addSite('cur', addDays(THROUGH, -20));
    const r1 = await tick('cur');
    expect(r1.filled).toEqual([THROUGH, addDays(THROUGH, -1), addDays(THROUGH, -2)]);
    expect(energyDays()).toEqual(r1.filled);
    expect(fake.state.calls.filter(c => c.kind === 'soe').map(c => c.day)).toEqual(r1.filled);   // battery % with every day
    expect((await kv.get<DeepState>(deepKey('cur')))!.cursor).toBe(addDays(THROUGH, -3));
    fake.state.calls.length = 0; await nextTick('cur');
    expect((await tick('cur')).filled).toEqual([addDays(THROUGH, -3), addDays(THROUGH, -4), addDays(THROUGH, -5)]);
    // no day inside syncSite's 400-day window is asked for
    expect(Object.keys(await counts('cur')).every(d => d <= THROUGH)).toBe(true);
  });

  it('a second tick in the same 5 minutes leaves the work to the first (claim)', async () => {
    await addSite('claim', addDays(THROUGH, -20));
    await tick('claim'); fake.state.calls.length = 0;
    expect(await tick('claim')).toEqual({ skipped: 'already running' });
    expect(fake.state.calls).toEqual([]);
  });

  it('starts no day without 13 s left before the stop', async () => {
    await addSite('budget', addDays(THROUGH, -20));
    const r = await tick('budget', NIGHT, Date.now() + 12_000);
    expect(r.filled).toEqual([]); expect(fake.state.calls).toEqual([]);
  });

  it('is idempotent: a reset cursor skips what is stored and the rows stay the same', async () => {
    await addSite('idem', addDays(THROUGH, -20));
    await tick('idem'); await nextTick('idem'); await tick('idem');
    const before = await counts('idem');
    await q(`DELETE FROM kv WHERE key = $1`, [deepKey('idem')]); await nextTick('idem');
    fake.state.calls.length = 0;
    const r = await tick('idem');
    expect(r.filled).toEqual([addDays(THROUGH, -6), addDays(THROUGH, -7), addDays(THROUGH, -8)]);   // the six stored days are skipped
    const after = await counts('idem');
    for (const d of Object.keys(before)) expect(after[d]).toBe(before[d]);
    expect(Object.values(after).every(n => n === 288)).toBe(true);
  });

  it('stops at the install date, sets the done flag, and finished ticks never touch the database again', async () => {
    const installed = addDays(THROUGH, -7);
    await addSite('stop', installed);
    expect(await runToDone('stop')).toBe(3);   // 8 days: 3 + 3 + 2
    const days = Object.keys(await counts('stop'));
    expect(days[0]).toBe(installed); expect(days.at(-1)).toBe(THROUGH); expect(days).toHaveLength(8);
    expect(energyDays().every(d => d >= installed)).toBe(true);
    expect(await kv.get(deepDoneKey('stop'))).toMatchObject({ from: installed, through: THROUGH });
    fake.state.db = 0; fake.state.calls.length = 0;
    await nextTick('stop');   // (one query, before the count)
    fake.state.db = 0;
    expect(await tick('stop')).toEqual({ skipped: 'done' });
    expect(fake.state.db).toBe(0);                 // cached on this instance
    resetDeepCache();
    expect(await tick('stop')).toEqual({ skipped: 'done' });
    expect(fake.state.db).toBe(1);                 // a cold instance reads the flag once
    expect(await tick('stop')).toEqual({ skipped: 'done' });
    expect(fake.state.db).toBe(1);
    expect(fake.state.calls).toEqual([]);
    // the handler skips the step (and its site list) once a pass found every site done
    expect(deepDue(NIGHT)).toBe(true);
    notePass({ stop: { skipped: 'done' } });
    expect(deepDue(NIGHT)).toBe(false);
    notePass({ stop: { skipped: 'done' }, other: { filled: [] } });
    expect(deepDue(NIGHT)).toBe(true);
  });

  it('records days Tesla answers empty (before production), never marks them synced and never asks again', async () => {
    const installed = addDays(THROUGH, -5);
    await addSite('pto', installed);
    for (let i = 0; i < 3; i++) fake.state.count[addDays(installed, i)] = 0;   // the three oldest days: nothing yet
    await runToDone('pto');
    const st = (await kv.get<DeepState>(deepKey('pto')))!;
    expect(st.empty).toEqual([installed, addDays(installed, 1), addDays(installed, 2)]);
    expect((await q(`SELECT day FROM synced_days WHERE site_id = 'pto' AND day < $1`, [addDays(installed, 3)]))).toEqual([]);
    expect(Object.keys(await counts('pto'))).toEqual([addDays(installed, 3), addDays(installed, 4), THROUGH]);
    // a re-run from scratch (done flag gone, cursor reset) asks Tesla for none of them again
    await q(`DELETE FROM kv WHERE key = $1`, [deepDoneKey('pto')]); resetDeepCache();
    await kv.set(deepKey('pto'), { ...st, cursor: undefined });
    fake.state.calls.length = 0; await nextTick('pto');
    expect(await tick('pto')).toMatchObject({ done: true });
    expect(fake.state.calls).toEqual([]);
    expect(await deepStatus('pto', NIGHT)).toEqual({ from: installed, through: THROUGH, daysDone: 6, daysTotal: 6, done: true });
  });

  it('stores the DST days with their 276 and 300 buckets, local timestamps and Chicago hours', async () => {
    await addSite('dst', '2024-11-01');
    for (const day of ['2024-11-04', '2025-03-10']) {
      await kv.set(deepKey('dst'), { cursor: day }); await nextTick('dst');
      await tick('dst');
    }
    const c = await counts('dst');
    expect(c['2024-11-03']).toBe(300);   // fall back: 25 hours
    expect(c['2025-03-09']).toBe(276);   // spring forward: 23 hours
    expect(c['2024-11-02']).toBe(288);
    const marks = Object.fromEntries((await q<{ day: string; buckets: number }>(`SELECT day, buckets FROM synced_days WHERE site_id = 'dst'`)).map(r => [r.day, r.buckets]));
    expect([marks['2024-11-03'], marks['2025-03-09']]).toEqual([300, 276]);
    const fall = await q<{ ts: string; hour: number }>(`SELECT ts, hour FROM energy WHERE site_id = 'dst' AND day = '2024-11-03' ORDER BY epoch`);
    expect(fall[0].ts).toBe('2024-11-03T00:00:00-05:00');
    expect(fall.at(-1)!.ts).toBe('2024-11-03T23:55:00-06:00');
    expect(fall.filter(r => r.hour === 1)).toHaveLength(24);   // the repeated 01:00 hour
    const spring = await q<{ hour: number }>(`SELECT DISTINCT hour FROM energy WHERE site_id = 'dst' AND day = '2025-03-09'`);
    expect(spring.map(r => r.hour)).not.toContain(2);
  });
});

describe('Tesla errors', () => {
  it('rests 30 minutes after a 429 (past the client\'s own retries), then picks up the same day', async () => {
    await addSite('rate', addDays(THROUGH, -20));
    fake.state.fail.set(addDays(THROUGH, -1), 'Tesla /api/1/energy_sites/rate/calendar_history → HTTP 429: rate limited');
    const r = await tick('rate');
    expect(r.filled).toEqual([THROUGH]);
    expect(r.backoffUntil).toBe(NIGHT + DEEP_BACKOFF_MS);
    expect(r.error).toBeUndefined();   // not a fault: the ledger doesn't mark the cron red
    fake.state.calls.length = 0; fake.state.fail.clear(); await nextTick('rate');
    expect(await tick('rate', NIGHT + 10 * 60_000)).toMatchObject({ skipped: 'tesla back-off' });
    expect(fake.state.calls).toEqual([]);
    await nextTick('rate');
    vi.setSystemTime(NIGHT + DEEP_BACKOFF_MS);
    expect((await tick('rate', NIGHT + DEEP_BACKOFF_MS)).filled).toEqual([addDays(THROUGH, -1), addDays(THROUGH, -2), addDays(THROUGH, -3)]);
  });

  it('another error stops the tick; after 3 tries the day is passed over so it cannot block the rest', async () => {
    await addSite('bad', addDays(THROUGH, -20));
    fake.state.fail.set(THROUGH, 'Tesla calendar_history → HTTP 504');
    for (let i = 1; i <= 3; i++) {
      await nextTick('bad');
      const r = await tick('bad');
      expect(r.error).toMatch(/504/); expect(r.filled).toEqual([]);
    }
    await nextTick('bad');
    expect((await tick('bad')).filled).toEqual([addDays(THROUGH, -1), addDays(THROUGH, -2), addDays(THROUGH, -3)]);
    expect((await kv.get<DeepState>(deepKey('bad')))!.skipped).toEqual([THROUGH]);
  });
});

describe('status and the normal window', () => {
  it('deepStatus counts stored days in the deep range only', async () => {
    const installed = addDays(THROUGH, -9);
    await addSite('stat', installed);
    expect(await deepStatus('stat', NIGHT)).toEqual({ from: installed, through: THROUGH, daysDone: 0, daysTotal: 10, done: false });
    await tick('stat');
    expect(await deepStatus('stat', NIGHT)).toEqual({ from: installed, through: THROUGH, daysDone: 3, daysTotal: 10, done: false });
  });

  it('a site installed inside the 400 days has nothing to back-fill and is done at once', async () => {
    await addSite('young', addDays(TODAY, -100));
    expect(await tick('young')).toMatchObject({ done: true });
    expect(fake.state.calls).toEqual([]);
    expect(await deepStatus('young', NIGHT)).toMatchObject({ daysDone: 0, daysTotal: 0, done: true });
  });

  it('syncSite keeps its 400-day window: it never asks for a day of the deep range', async () => {
    expect(config.backfillDays).toBe(400);
    await addSite('sync', '2019-06-01');
    // the window is stored except its two oldest days, so the sync has just those (and today) to fetch
    const stored = Array.from({ length: 398 }, (_, i) => addDays(TODAY, -1 - i));
    await q(`INSERT INTO synced_days (site_id, kind, day, buckets) SELECT 'sync', 'day', d, 288 FROM unnest($1::text[]) d`, [stored]);
    const r = await syncSite('sync', 60_000);
    expect(r.remaining).toBe(0);
    expect(energyDays().sort()).toEqual([addDays(TODAY, -400), addDays(TODAY, -399), TODAY]);
    expect(energyDays().filter(d => d <= THROUGH)).toEqual([]);
  });
});
