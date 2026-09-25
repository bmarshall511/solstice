// Autopilot, AC stepping and Tesla sync end to end on in-memory PGlite, with ScreenLogic, Nest and the Tesla client
// replaced by recorders (design §9, integration). Proves rule 4 as code: Suggest and Off never write to a device.
// The clock is faked (Date only); the Open-Meteo forecast is seeded in kv 'pool:forecast' so nothing is fetched.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { q, one, kv, migrate } from '../../server/src/db.js';
import { autopilot } from '../../server/src/appliances/autopilot.js';
import { poolDetail, powerModel, recordReading, measuredQuarters, POOL_DEFAULTS } from '../../server/src/appliances/pool.js';
import { cronTick } from '../../server/src/appliances/sampling.js';
import { acDetail, acTick } from '../../server/src/appliances/ac.js';
import { readPool, writePoolPlan } from '../../server/src/appliances/screenlogic.js';
import { readNest, setCool } from '../../server/src/appliances/nest.js';
import { syncSite, saveEnergyRows } from '../../server/src/sync.js';
import { teslaFor, localDay } from '../../server/src/tesla/client.js';
import { saveBill, parsePecText } from '../../server/src/bills.js';
import { runLearn } from '../../server/src/learn/nightly.js';
import { logPrediction, forgetWritten } from '../../server/src/learn/store.js';
import { untrim, learnAcKey, controlKey } from '../../server/src/learn/ac.js';
import { WX_KEY } from '../../server/src/learn/wx.js';
import { PEC_BILL } from '../fixtures/pec-bill.js';
import { BELL } from '../fixtures/forecast.js';
import { forecastDays, type Daily } from '../fixtures/forecast.js';
import { poolSnapshot, CIRCUITS } from '../fixtures/screenlogic.js';
import { nestState } from '../fixtures/nest.js';
import { energyBuckets, soePoints, liveStatus, siteInfo } from '../fixtures/tesla.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => true,
  readPool: vi.fn(),
  writePoolPlan: vi.fn(async () => ({ removed: [], added: [11, 12] })),
  withUnit: vi.fn(async () => { throw new Error('withUnit in integration test'); }),
}));
vi.mock(import('../../server/src/appliances/nest.js'), async importOriginal => {
  const real = await importOriginal();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in integration test`); });
  return { ...real, nestConfigured: () => true, nestLinked: vi.fn(async () => true), readNest: vi.fn(), setCool: vi.fn(async () => ({})),
    nestExchangeCode: blocked('nestExchangeCode'), setHeat: blocked('setHeat'), setMode: blocked('setMode'), setEco: blocked('setEco') };
});
vi.mock(import('../../server/src/tesla/client.js'), async importOriginal => ({ ...(await importOriginal()), teslaFor: vi.fn() }));
vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));
// Counts every round trip to PGlite, so the learning layer's nightly job can be held to its query budget.
const pg = vi.hoisted(() => ({ queries: 0 }));
vi.mock('@electric-sql/pglite', async importOriginal => {
  const real = await importOriginal<typeof import('@electric-sql/pglite')>();
  function PGlite(this: unknown, ...args: unknown[]) {
    const db = new (real.PGlite as any)(...args), query = db.query.bind(db);
    db.query = (...a: unknown[]) => { pg.queries++; return query(...a); };
    return db;
  }
  return { ...real, PGlite: PGlite as unknown as typeof real.PGlite };
});

const NOW = Date.parse('2026-09-25T18:00:00Z'); // Friday 13:00 CDT
const RATE = .1064, SLOPE = 2.5;
const W0 = powerModel([]);
const NAMES = new Map(CIRCUITS.map(c => [c.id, c.name]));
const seedForecast = (over?: Record<number, Partial<Daily>>) => kv.set('pool:forecast', { at: Date.now(), days: forecastDays(localDay(), over) });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await migrate();
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(async () => {
  vi.setSystemTime(NOW);
  vi.mocked(readPool).mockImplementation(async () => poolSnapshot(Date.now()));
  vi.mocked(readNest).mockImplementation(async () => nestState(Date.now()));
  vi.mocked(writePoolPlan).mockClear();
  vi.mocked(setCool).mockClear();
  await seedForecast();
});

/* ---------------------------------------------------------------- pool Autopilot */
describe('pool Autopilot', () => {
  const run = (site: string, mode: 'off' | 'suggest' | 'auto', act = true) =>
    autopilot(site, { settings: { ...POOL_DEFAULTS, autopilot: mode }, mode, W: W0, rate: RATE, names: NAMES, snap: poolSnapshot(Date.now()), waterTemp: 88, currentHours: 9, act });

  it('Suggest stores tomorrow’s plan for approval and never writes to ScreenLogic', async () => {
    const a = await run('p-suggest', 'suggest');
    expect(writePoolPlan).not.toHaveBeenCalled();
    expect(a.pending).toBe(true);
    expect(a.nextRunAt).toBe('2026-09-26T01:15:00.000Z');
    expect(a.tomorrow.date).toBe('2026-09-26');
    expect([a.tomorrow.plan.hours, a.tomorrow.plan.boostHours, a.tomorrow.plan.start, a.tomorrow.plan.stop]).toEqual([9, 1, 8, 17]);
    expect(a.log[0]).toEqual({ at: NOW, day: '2026-09-25', text: 'Suggested for tomorrow: 9 h + boost. season plan', delta: 'waiting for you' });
    const pending = await kv.get<any>('p-suggest:pool:pending');
    expect(pending.date).toBe('2026-09-26');
    expect(pending.plan.hours).toBe(9);
    expect(pending.why).toEqual([]);
    expect(a.week).toHaveLength(6);
    expect(a.signals).toEqual({ waterTemp: 88, sunKwhM2: 6, sunPct: 75, high: 90, heatDays: 0, rainPct: 0, rainMm: 0, rainYesterdayMm: 0, useDays: 0, pollen: 'low' });
  });

  it('Auto writes tomorrow’s plan once, replacing the pump programs, and skips an identical plan', async () => {
    await run('p-auto', 'auto');
    expect(writePoolPlan).toHaveBeenCalledTimes(1);
    expect(writePoolPlan).toHaveBeenCalledWith({
      pumpId: 1, speeds: [{ circuitId: 6, rpm: 1500 }, { circuitId: 8, rpm: 2400 }], replaceCircuits: [6, 8, 5],
      schedules: [{ circuitId: 6, start: 480, stop: 1020 }, { circuitId: 8, start: 720, stop: 780 }],
      // what the safety guard checks the write against: the fixture's circuits and pump slots, the pump's RPM range, and the
      // fixed managed circuits (Pool 6, High Speed 8, Waterfall 5)
      guard: { circuits: poolSnapshot(NOW).circuits, pumpCircuits: [6, 8, 5, 1, 132], minRpm: 450, maxRpm: 3450, managed: [6, 8, 5] },
    });
    const applied = await kv.get<any>('p-auto:pool:applied');
    expect(applied.plan).toMatchObject({ start: 8, stop: 17, boostAt: 12 });
    expect(applied.added).toEqual([11, 12]);
    const again = await run('p-auto', 'auto');
    expect(writePoolPlan).toHaveBeenCalledTimes(1);
    expect(again.log[0].text).toBe('Tomorrow: 9 h at 1,500 RPM + skim boost. season plan');
    expect(again.log[0].delta).toBe('2.7 kWh');
  });

  it('Off never writes and never suggests', async () => {
    const a = await run('p-off', 'off');
    expect(writePoolPlan).not.toHaveBeenCalled();
    expect(a.pending).toBe(false);
    expect(await kv.get('p-off:pool:pending')).toBeUndefined();
  });

  it('opening the pool page in Auto (act: false) never writes', async () => {
    await run('p-view', 'auto', false);
    const d = await poolDetail('p-view', { pool: { autopilot: 'auto' } }, RATE);
    expect(d.autopilot).toMatchObject({ mode: 'auto', pending: false });
    expect(writePoolPlan).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------- pool detail */
describe('poolDetail', () => {
  it('the current schedule counts pump programs only (not lights, not freeze protection)', async () => {
    vi.mocked(readPool).mockImplementation(async () => {
      const s = poolSnapshot(Date.now());
      s.schedules.push({ id: 4, circuitId: 132, start: 0, stop: 1440, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 });
      return s;
    });
    const d = await poolDetail('p-detail', {}, RATE);
    expect(d.current.schedules.map(s => s.circuitId)).toEqual([6, 8]);
    expect(d.current.schedules.map(s => s.name)).toEqual(['Pool', 'High Speed']);
    expect([d.current.hours, d.current.kwhPerDay]).toEqual([9, 2.7]); // 8 h at 1500 + 1 h at 2400 + 9 h of UV lamp
    expect(d.linked).toBe(true);
    expect(d.spaSession).toMatchObject({ spaTemp: 95, spaSet: 102, riseF: 7, heatMinutes: 11, propaneGal: .78, propaneUsd: 2.34, pumpWattsAtSpa: 2195, electricUsdPerHour: .36 });
  });

  // BUG-7 · today current.turnoverPerDay uses the 120 GPM default whatever settings.designGpm says (latent: the default is 120).
  it.fails('BUG-7: the current schedule’s turnover uses settings.designGpm', async () => {
    const d = await poolDetail('p-gpm', { pool: { designGpm: 100 } }, RATE);
    expect(d.current.turnoverPerDay).toBe(1.67);
  });
  it('BUG-7 (today): designGpm 100 still reports the 120 GPM turnover', async () => {
    const d = await poolDetail('p-gpm', { pool: { designGpm: 100 } }, RATE);
    expect(d.current.turnoverPerDay).toBe(2);
  });

  describe('the season table highlights the current season', () => {
    const labels: string[] = [];
    beforeAll(async () => {
      for (let m = 0; m < 12; m++) {
        vi.setSystemTime(Date.UTC(2026, m, 15, 17));
        await seedForecast();
        const d = await poolDetail('p-season', {}, RATE);
        labels.push(d.seasons.filter(s => s.current).map(s => s.label).join(','));
      }
    });
    // BUG-4 · today months 3, 4, 6, 7, 9 and 10 (0-based) highlight the next season: April shows Jun–Aug, October shows Dec–Feb.
    it.fails('BUG-4: every month highlights its own season', () => {
      expect(labels).toEqual(['Dec–Feb', 'Dec–Feb', 'Mar–May', 'Mar–May', 'Mar–May', 'Jun–Aug', 'Jun–Aug', 'Jun–Aug', 'Sep–Nov', 'Sep–Nov', 'Sep–Nov', 'Dec–Feb']);
    });
    it('BUG-4 (today): April highlights Jun–Aug and October highlights Dec–Feb', () => {
      expect([labels[3], labels[9]]).toEqual(['Jun–Aug', 'Dec–Feb']);
    });
  });

  describe('the last evening of a month in production (UTC)', () => {
    // 2026-01-31 19:30 CST is already February in UTC. BUG-6 · today poolDetail and pollenFor read new Date().getMonth(),
    // so from 18:00 CST (19:00 CDT) on the last day of every month the plan and the pollen signal use next month.
    const at = Date.parse('2026-02-01T01:30:00Z');
    it.fails('BUG-6: the plan month and pollen follow the Chicago date', async () => {
      vi.setSystemTime(at); await seedForecast();
      const d = await poolDetail('p-monthend', {}, RATE);
      expect(d.plan.month).toBe(0);
      expect((d.autopilot as any).signals.pollen).toBe('low');
    });
    it('BUG-6 (today): the plan says February with February pollen', async () => {
      vi.setSystemTime(at); await seedForecast();
      expect(localDay()).toBe('2026-01-31');
      const d = await poolDetail('p-monthend', {}, RATE);
      expect(d.plan.month).toBe(1);
      expect((d.autopilot as any).signals.pollen).toBe('medium');
    });
  });
});

/* ---------------------------------------------------------------- BUG-1 through the real code paths */
describe('BUG-1: pool-use signals never fire (jsonb ?| on numeric circuit ids)', () => {
  beforeAll(async () => {
    // yesterday at noon: blower, pool light and pump on
    await recordReading('p-used', poolSnapshot(NOW - 864e5 - 3600e3, { on: [2, 3, 6] }));
  });
  const suggest = () => autopilot('p-used', { settings: POOL_DEFAULTS, mode: 'suggest', W: W0, rate: RATE, names: NAMES, snap: null, waterTemp: 88, currentHours: 9, act: false });

  it.fails('BUG-1: yesterday’s use adds an hour to tomorrow’s plan', async () => {
    const a = await suggest();
    expect(a.tomorrow.why).toContain('+1 h: the pool was used yesterday');
    expect(a.tomorrow.plan.hours).toBe(10);
  });
  it.fails('BUG-1: the use-days signal counts yesterday', async () => {
    expect((await suggest()).signals.useDays).toBe(1);
  });
  it.fails('BUG-1: the pool-light readings are counted', async () => {
    const d = await poolDetail('p-used', {}, RATE);
    expect(d.extras.lightReadings30d).toBeGreaterThan(0);
  });
  it('BUG-1 (today): none of the three signals fire', async () => {
    const a = await suggest();
    expect([a.tomorrow.why, a.tomorrow.plan.hours, a.signals.useDays]).toEqual([[], 9, 0]);
    expect((await poolDetail('p-used', {}, RATE)).extras.lightReadings30d).toBe(0);
  });
});

/* ---------------------------------------------------------------- AC Autopilot */
describe('AC Autopilot (acTick)', () => {
  const approve = (site: string) => kv.set(`${site}:ac:plan`, { date: '2026-09-25', approved: true, lastStepHour: null });
  const tick = (site: string, settings: Record<string, any> = {}) => acTick(site, settings, RATE, SLOPE);
  const nest = (o: Parameters<typeof nestState>[1]) => vi.mocked(readNest).mockImplementation(async () => nestState(Date.now(), o));

  it('acDetail: today’s plan pre-cools at 11:00 and exposes the fields the view reads', async () => {
    const d = await acDetail('ac-detail', {}, RATE, SLOPE, { fresh: true });
    expect([d.configured, d.linked]).toEqual([true, true]);
    expect(d.plan.steps.map(s => [s.hour, s.coolF])).toEqual([[7, 76], [11, 74], [15, 78], [19, 76], [22, 76]]);
    expect(d.currentStep).toMatchObject({ hour: 11, coolF: 74 });
    expect(Object.keys(d.learned)).toEqual(['coolKw', 'heatKw', 'samples', 'heatSamples', 'acKw', 'source']);
    expect(d.learned).toMatchObject({ coolKw: null, samples: 0, acKw: 3.25, source: 'estimated' });
    expect(await one(`SELECT COUNT(*)::int n FROM nest_readings WHERE site_id = 'ac-detail'`)).toEqual({ n: 1 });
  });

  it('an approved plan steps the setpoint by at most 2° toward the plan, then records the step', async () => {
    await approve('ac-step');
    nest({ coolF: 80 });
    expect(await tick('ac-step')).toEqual({ sampled: true, applied: true });
    expect(setCool).toHaveBeenCalledTimes(1);
    expect(setCool).toHaveBeenLastCalledWith('dev-test', 78, 'suggest');
    expect(await kv.get('ac-step:ac:plan')).toEqual({ date: '2026-09-25', approved: true, lastStepHour: null });
    expect((await kv.get<any[]>('ac-step:ac:log'))?.[0]).toEqual({ at: NOW, day: '2026-09-25', text: 'Set 78° (pre-cool on solar surplus)', delta: 'stepping' });

    vi.setSystemTime(NOW + 30 * 60_000); // the safety guard allows one setpoint write per 30 minutes (13:30 is still the 11:00 step)
    nest({ coolF: 76 });
    await tick('ac-step');
    expect(setCool).toHaveBeenCalledTimes(2);
    expect(setCool).toHaveBeenLastCalledWith('dev-test', 74, 'suggest');
    expect(await kv.get('ac-step:ac:plan')).toEqual({ date: '2026-09-25', approved: true, lastStepHour: 11 });

    nest({ coolF: 74 });
    await tick('ac-step');
    expect(setCool).toHaveBeenCalledTimes(2);
  });

  it('Suggest without an approval never writes to Nest', async () => {
    nest({ coolF: 80 });
    expect(await tick('ac-suggest', { ac: { autopilot: 'suggest' } })).toEqual({ sampled: true, applied: false });
    expect(setCool).not.toHaveBeenCalled();
  });
  it('Off without an approval never writes to Nest', async () => {
    nest({ coolF: 80 });
    await tick('ac-off', { ac: { autopilot: 'off' } });
    expect(setCool).not.toHaveBeenCalled();
  });
  it('Auto applies the step without an approval', async () => {
    nest({ coolF: 80 });
    expect(await tick('ac-auto', { ac: { autopilot: 'auto' } })).toEqual({ sampled: true, applied: true });
    expect(setCool).toHaveBeenCalledWith('dev-test', 78, 'auto');
  });
  // Changed by the safety clamps (guards.ts): with no current setpoint the 2° step limit can't be checked, so the write is
  // refused and logged instead of going straight to the target (before the clamps it set 74° and recorded lastStepHour 11).
  it('with no cool setpoint reported, the write is refused and logged, and the step stays due', async () => {
    await approve('ac-null');
    nest({ coolF: null });
    await tick('ac-null');
    expect(setCool).not.toHaveBeenCalled();
    expect(await kv.get('ac-null:ac:plan')).toMatchObject({ lastStepHour: null });
    expect((await kv.get<any[]>('ac-null:ac:log'))?.[0]).toMatchObject({ at: NOW, day: '2026-09-25', delta: 'refused' });
    expect((await kv.get<any[]>('ac-null:ac:log'))?.[0].text).toContain("the thermostat's current setpoint is unknown");
  });
  it('marked away in Auto steps up toward the away setpoint, 2° at a time', async () => {
    nest({ coolF: 76 });
    await tick('ac-away', { ac: { autopilot: 'auto', presence: 'away' } });
    expect(setCool).toHaveBeenCalledWith('dev-test', 78, 'auto');
  });
  it('an approved plan does nothing while the thermostat is heating', async () => {
    await approve('ac-heat');
    nest({ mode: 'HEAT', coolF: 80 });
    await tick('ac-heat');
    expect(setCool).not.toHaveBeenCalled();
  });

  // BUG-5 · fixed by the safety clamps (guards.ts AUTOPILOT_OFF; the owner decided on 2026-09-25 that Off means no writes to
  // Nest at all). Before the fix, Off still applied a plan approved earlier the same day and set 78°.
  it('BUG-5: Off stops a plan that was approved today', async () => {
    await approve('ac-off-approved');
    nest({ coolF: 80 });
    await tick('ac-off-approved', { ac: { autopilot: 'off' } });
    expect(setCool).not.toHaveBeenCalled();
  });
  it('BUG-5 (fixed): Off with an approved plan logs the refusal once, however often the cron ticks', async () => {
    await approve('ac-off-approved-2');
    nest({ coolF: 80 });
    await tick('ac-off-approved-2', { ac: { autopilot: 'off' } });
    await tick('ac-off-approved-2', { ac: { autopilot: 'off' } });
    expect(setCool).not.toHaveBeenCalled();
    const log = await kv.get<any[]>('ac-off-approved-2:ac:log');
    expect(log).toHaveLength(1);
    expect(log![0]).toMatchObject({ at: NOW, day: '2026-09-25', delta: 'refused' });
    expect(log![0].text).toContain('autopilot_off');
  });
});

/* ---------------------------------------------------------------- Tesla sync */
describe('syncSite with a fake Tesla client', () => {
  const fake = () => ({
    products: vi.fn(async () => []), calendar: vi.fn(),
    liveStatus: vi.fn(async () => liveStatus(new Date().toISOString())),
    siteInfo: vi.fn(async () => siteInfo(localDay())),
    energy: vi.fn(async (_site: string, start: string, _end: string) => ({ time_series: energyBuckets(start.slice(0, 10), start.slice(19)) })),
    soe: vi.fn(async (_site: string, start: string, _end: string) => ({ time_series: soePoints(start.slice(0, 10), start.slice(19)) })),
    backups: vi.fn(async (): Promise<{ events?: Array<{ timestamp: string; duration: number }> }> => ({ events: [] })),
  });
  let tesla: ReturnType<typeof fake>;
  const addSite = async (id: string, info?: object) => {
    const [a] = await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'test-access', 'test-refresh', 0) RETURNING id`);
    await q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info, info_at) VALUES ($1, NULL, $2, 'Test Site', $3, $4)`,
      [id, a.id, info ? JSON.stringify(info) : null, info ? new Date().toISOString() : null]);
  };
  beforeEach(() => { tesla = fake(); vi.mocked(teslaFor).mockReturnValue(tesla as any); });

  it('pulls live status, site info and today’s buckets; a 504 from backup history is recorded and stored outages are kept', async () => {
    await addSite('sync');
    await q(`INSERT INTO backup_events VALUES ('sync', '2026-08-01T14:00:00-05:00', $1, 300)`, [Date.parse('2026-08-01T14:00:00-05:00')]);
    tesla.backups.mockRejectedValueOnce(new Error('Tesla /api/1/energy_sites/sync/calendar_history → HTTP 504:'));
    const r = await syncSite('sync');
    expect(r.done).toEqual(['siteInfo', 'lastHistory']);
    expect(r.errors).toEqual(['lastBackups: Tesla /api/1/energy_sites/sync/calendar_history → HTTP 504:']);
    expect([r.filled, r.remaining]).toEqual([0, 0]);
    expect(tesla.energy).toHaveBeenCalledWith('sync', '2026-09-25T00:00:00-05:00', '2026-09-25T13:00:00-05:00');
    expect(await q(`SELECT hour, home_wh FROM energy WHERE site_id = 'sync' ORDER BY epoch`)).toEqual(
      [100, 95, 110, 110, 90, 100].map(home_wh => ({ hour: 0, home_wh })));
    expect(await one(`SELECT COUNT(*)::int n FROM soe WHERE site_id = 'sync'`)).toEqual({ n: 2 });
    expect(await one(`SELECT COUNT(*)::int n FROM readings WHERE site_id = 'sync'`)).toEqual({ n: 1 });
    expect(await kv.get('sync:error:lastBackups')).toEqual({ at: NOW, message: 'Tesla /api/1/energy_sites/sync/calendar_history → HTTP 504:' });
    expect(await q(`SELECT ts, duration_s FROM backup_events WHERE site_id = 'sync'`)).toEqual([{ ts: '2026-08-01T14:00:00-05:00', duration_s: 300 }]);
  });

  it('fetches nothing when everything is fresh', async () => {
    await addSite('fresh', siteInfo('2026-09-25'));
    await q(`INSERT INTO readings (site_id, ts) VALUES ('fresh', $1)`, [NOW - 10_000]);
    await kv.set('fresh:lastHistory', NOW - 60_000);
    await kv.set('fresh:lastBackups', NOW - 60_000);
    const r = await syncSite('fresh');
    expect(r).toMatchObject({ done: [], errors: [], filled: 0 });
    for (const m of Object.values(tesla)) expect(m).not.toHaveBeenCalled();
  });

  describe('day windows across DST', () => {
    const windowFor = async (site: string, now: string, day: string) => {
      vi.setSystemTime(Date.parse(now));
      await addSite(site, siteInfo(day));   // installed on `day`, so the backfill fetches exactly that day
      await syncSite(site);
      const call = tesla.energy.mock.calls.find(c => c[1].startsWith(day));
      return { start: call?.[1], end: call?.[2] };
    };
    // BUG-9 · fixed by dayWindow() (tesla/client.ts): a day ends one second before the next local midnight. Before the fix a
    // day ended at start + 24 h − 1 s: 22:59:59 CST on 2026-11-01 (23:00–23:59 never fetched) and 00:59:59 on 2026-03-09.
    it('BUG-9: the fall-back day (2026-11-01) is fetched to 23:59:59', async () => {
      expect(await windowFor('dst-fall', '2026-11-02T18:00:00Z', '2026-11-01')).toEqual({ start: '2026-11-01T00:00:00-05:00', end: '2026-11-01T23:59:59-06:00' });
    });
    it('BUG-9: the spring-forward day (2026-03-08) ends at its own midnight', async () => {
      expect(await windowFor('dst-spring', '2026-03-09T18:00:00Z', '2026-03-08')).toEqual({ start: '2026-03-08T00:00:00-06:00', end: '2026-03-08T23:59:59-05:00' });
    });
    it('BUG-9 (fixed): the DST windows are 25 h − 1 s and 23 h − 1 s long', async () => {
      const hours = (w: { start?: string; end?: string }) => (Date.parse(w.end!) - Date.parse(w.start!) + 1000) / 3600e3;
      expect(hours(await windowFor('dst-fall-2', '2026-11-02T18:00:00Z', '2026-11-01'))).toBe(25);
      expect(hours(await windowFor('dst-spring-2', '2026-03-09T18:00:00Z', '2026-03-08'))).toBe(23);
    });
  });
});

/* ---------------------------------------------------------------- the 5-minute cron's sampling and the 15-minute pool energy */
describe('cron sampling and 15-minute pool energy on PGlite (Q17, Q18, Q23)', () => {
  const T10 = Date.parse('2026-09-25T10:00:00-05:00'); // Friday 10:00 CDT: cooling season, 5-minute Nest samples
  const tick = (t: number) => { vi.setSystemTime(t + 2_000); return cronTick(t, { sites: async () => ['cron-s'], acTick: id => acTick(id, {}, RATE, SLOPE) }); };

  it('a due tick claims its slots in kv, samples Nest through acTick and stores a pool reading; a repeat invocation skips both', async () => {
    vi.mocked(readPool).mockClear();
    await kv.set('cron-s:pool:last', poolSnapshot(T10 - 3600e3));      // the fixture's schedule: Pool 8a–5p, High Speed 12p–1p
    expect(await tick(T10)).toEqual({ 'cron-s': { nest: { every: 5, tick: { sampled: true, applied: false } },
      pool: { read: true, at: T10 + 2_000, running: true, rpm: 1500, watts: 153 } } });
    expect(await kv.get('cron-s:nest:sampledAt')).toEqual({ at: T10 });
    expect(await kv.get('cron-s:pool:readAt')).toEqual({ at: T10 });
    expect(await one(`SELECT COUNT(*)::int n FROM nest_readings WHERE site_id = 'cron-s'`)).toEqual({ n: 1 });
    expect(await one(`SELECT day, hour, running, watts, rpm FROM pool_readings WHERE site_id = 'cron-s'`)).toEqual({ day: '2026-09-25', hour: 10, running: true, watts: 153, rpm: 1500 });
    expect(await tick(T10 + 30_000)).toEqual({ 'cron-s': { nest: { skipped: 'already sampled', every: 5 }, pool: { skipped: 'already read' } } });
    expect(await tick(T10 + 5 * 60_000)).toMatchObject({ 'cron-s': { nest: { every: 5, tick: { sampled: true } }, pool: { skipped: 'not due' } } });
    expect(await one(`SELECT COUNT(*)::int n FROM nest_readings WHERE site_id = 'cron-s'`)).toEqual({ n: 2 });
    expect(readPool).toHaveBeenCalledTimes(1);
    expect(writePoolPlan).not.toHaveBeenCalled();
    expect(setCool).not.toHaveBeenCalled();
  });

  it('measuredQuarters averages a day’s readings into Chicago quarter-hours, 0 W with the pump off', async () => {
    const t = (hm: string) => Date.parse(`2026-09-25T${hm}:00-05:00`);
    await recordReading('mq', poolSnapshot(t('10:01'), { watts: 150 }));
    await recordReading('mq', poolSnapshot(t('10:09'), { watts: 160 }));
    await recordReading('mq', poolSnapshot(t('10:15'), { running: false, watts: 0, rpm: 0 }));
    await recordReading('mq', poolSnapshot(t('14:30'), { rpm: 2400, watts: 780 }));
    const m = await measuredQuarters('mq', '2026-09-25');
    expect(m).toHaveLength(96);
    expect([m[39], m[40], m[41], m[58]]).toEqual([null, 155, 0, 780]);
    expect(m.filter(v => v != null)).toHaveLength(3);
  });

  it('poolDetail: today so far is integrated per quarter-hour, with a measured quarter-hour in place of the model', async () => {
    await kv.set('p-today:pool:last', poolSnapshot(NOW - 30_000));      // fresh, so poolDetail does not read
    expect((await poolDetail('p-today', {}, RATE)).todayKwh).toBe(1.8);  // 08:00–12:59 from the model + UV: 1.762 kWh
    await recordReading('p-today', poolSnapshot(Date.parse('2026-09-25T12:05:00-05:00'), { rpm: 2400, watts: 300 }));
    await kv.set('p-today:pool:last', poolSnapshot(NOW - 30_000));
    expect((await poolDetail('p-today', {}, RATE)).todayKwh).toBe(1.6);  // the 12:00 quarter-hour measured at 300 W: 1.638 kWh
  });
});

/* ---------------------------------------------------------------- learning layer (server/src/learn): hooks, control days, trims, nightly */
describe('learning layer: prediction hooks, control days and trims on PGlite', () => {
  const settingsAuto = { ac: { autopilot: 'auto' } };
  const nest = (o: Parameters<typeof nestState>[1]) => vi.mocked(readNest).mockImplementation(async () => nestState(Date.now(), o));
  const preds = (site: string) => q<{ model: string; target_day: string; predicted: number; unit: string; inputs: Record<string, any> }>(
    `SELECT model, target_day, predicted, unit, inputs FROM predictions WHERE site_id = $1 ORDER BY model`, [site]);
  beforeEach(() => forgetWritten());

  it('the pool cron logs tomorrow’s kWh with the schedule it assumes (Auto); Off logs nothing', async () => {
    await autopilot('lp-pool', { settings: { ...POOL_DEFAULTS, autopilot: 'auto' }, mode: 'auto', W: W0, rate: RATE, names: NAMES, snap: poolSnapshot(Date.now()), waterTemp: 88, currentHours: 9, act: true });
    const [p] = await preds('lp-pool');
    expect(p).toMatchObject({ model: 'pool.kwhDay', target_day: '2026-09-26', unit: 'kWh' });
    expect(p.inputs).toMatchObject({ mode: 'auto', hours: 9, boostHours: 1, sched: [[480, 1020, 1500], [720, 780, 2400]], uvKwh: .54, waterTemp: 88 });
    expect(Object.keys(p.inputs).filter(k => /rate|cost|usd|price/i.test(k))).toEqual([]);
    await autopilot('lp-pool-off', { settings: { ...POOL_DEFAULTS, autopilot: 'off' }, mode: 'off', W: W0, rate: RATE, names: NAMES, snap: poolSnapshot(Date.now()), waterTemp: 88, currentHours: 9, act: true });
    expect(await preds('lp-pool-off')).toEqual([]);
    await kv.set('lp-pool:pool:last', poolSnapshot(NOW - 30_000));
    expect((await poolDetail('lp-pool', {}, RATE)).conf).toEqual({ kwhPerDay: 'unscored' });
  });

  it('an eligible AC day logs both savings once, with conf; a re-read inserts nothing', async () => {
    const d = await acDetail('lp-ac', {}, RATE, SLOPE);
    expect([d.plan.precool, d.plan.control, d.plan.shiftedKwh, d.plan.eveningAvoidedKwh, d.plan.trim]).toEqual([true, false, 1.7, 1.7, null]);
    expect(d.plan.conf).toEqual({ shiftedKwh: 'estimated', eveningAvoidedKwh: 'estimated' });
    forgetWritten(); // a new instance: the database's unique key still keeps the first prediction
    await acDetail('lp-ac', {}, RATE, SLOPE);
    const p = await preds('lp-ac');
    expect(p.map(x => [x.model, x.target_day, x.predicted])).toEqual([['ac.eveningAvoided', '2026-09-25', 1.7], ['ac.shifted', '2026-09-25', 1.7]]);
    expect(p[0].inputs).toMatchObject({ high: 90, precool: true, control: false, mid: 76, depth: 2, from: 11, to: 15, coastFrom: 15, coastTo: 19, coastF: 78, trim: null });
  });

  it('the 5th eligible day is a control day: the plain comfort band, control: true on the prediction, the same all day', async () => {
    await kv.set(controlKey('lp-ctl'), { count: 4, days: {} });
    const d = await acDetail('lp-ctl', {}, RATE, SLOPE);
    expect(d.plan.steps.map(s => [s.hour, s.coolF])).toEqual([[7, 76], [21, 76], [22, 76]]);
    expect([d.plan.precool, d.plan.control, d.plan.shiftedKwh, d.plan.eveningAvoidedKwh]).toEqual([false, true, 0, 0]);
    expect(d.plan.why[0]).toContain('Control day');
    expect(await kv.get(controlKey('lp-ctl'))).toEqual({ count: 5, days: { '2026-09-25': true } });
    const p = await preds('lp-ctl');
    expect(p.map(x => [x.model, x.predicted, x.inputs.control, x.inputs.precool, x.inputs.from, x.inputs.coastTo])).toEqual([['ac.eveningAvoided', 0, true, false, 11, 19], ['ac.shifted', 0, true, false, 11, 19]]);
    expect((await acDetail('lp-ctl', {}, RATE, SLOPE)).plan.control).toBe(true);     // decided once for the day
    expect(await kv.get(controlKey('lp-ctl'))).toEqual({ count: 5, days: { '2026-09-25': true } });
    nest({ coolF: 74 });
    await acTick('lp-ctl', settingsAuto, RATE, SLOPE);                                  // 13:00: the control plan says 76°, so Auto steps up
    expect(setCool).toHaveBeenLastCalledWith('dev-test', 76, 'auto');
  });

  it('a learned coast trim applies automatically with its reason; acTick writes the trimmed step through the guard; untrim undoes it', async () => {
    const trim = { what: 'coast', amount: -30, unit: 'min', reason: 'the house reached 78° early', day: '2026-09-25' };
    for (const site of ['lp-trim', 'lp-plain']) await kv.set(learnAcKey(site), { at: NOW, day: '2026-09-25', trim: site === 'lp-trim' ? trim : null, measured: null, warmupFPerH: 2, coolKw: null });
    const d = await acDetail('lp-trim', {}, RATE, SLOPE);
    expect(d.plan.steps.map(s => [s.hour, s.coolF])).toEqual([[7, 76], [11, 74], [15, 78], [18.5, 76], [22, 76]]);
    expect([d.plan.coastTo, d.plan.trim]).toEqual([18.5, { what: 'coast', amount: -30, unit: 'min', reason: 'the house reached 78° early', warmupFPerH: null, from: 19, to: 18.5 }]);
    expect(d.plan.why.at(-1)).toBe('Trimmed: coast ends at 6:30 PM instead of 7 PM, because the house reached 78° early');
    expect([d.plan.shiftedKwh, d.plan.eveningAvoidedKwh]).toEqual([1.7, 1.5]);
    // 18:40: the trimmed plan is back to 76°, the untrimmed one still coasting at 78°; the thermostat reads 78°
    vi.setSystemTime(Date.parse('2026-09-25T18:40:00-05:00'));
    await seedForecast();
    nest({ coolF: 78 });
    await acTick('lp-plain', settingsAuto, RATE, SLOPE);
    expect(setCool).not.toHaveBeenCalled();
    await acTick('lp-trim', settingsAuto, RATE, SLOPE);
    expect(setCool).toHaveBeenCalledWith('dev-test', 76, 'auto');
    expect((await kv.get<any[]>('lp-trim:ac:log'))?.[0]).toMatchObject({ text: 'Set 76° (evening, comfort band)' });
    // undo: the trim is marked undone and logged; the plan runs untrimmed
    expect(await untrim('lp-trim', '2026-09-25')).toMatchObject({ what: 'coast', undone: true });
    const u = await acDetail('lp-trim', {}, RATE, SLOPE);
    expect([u.plan.coastTo, u.plan.trim, u.plan.why.at(-1)]).toEqual([19, null, 'Today’s learned trim was undone, so the plan runs untrimmed']);
    expect((await kv.get<any[]>('lp-trim:ac:log'))?.[0]).toMatchObject({ text: 'Undid today’s learned trim (coast -30 min)', delta: 'undone' });
    expect(await untrim('lp-plain', '2026-09-25')).toBeNull();
  });

  it('a depth trim still reaches the thermostat 2° at a time, once per 30 minutes, and not at all with Autopilot Off', async () => {
    await kv.set(learnAcKey('lp-depth'), { at: NOW, day: '2026-09-25', trim: { what: 'depth', amount: 1, unit: '°F', reason: 'flat out', day: '2026-09-25' }, measured: null, warmupFPerH: null, coolKw: null });
    expect((await acDetail('lp-depth', {}, RATE, SLOPE)).plan.steps[1]).toMatchObject({ hour: 11, coolF: 75 });
    nest({ coolF: 78 });
    await acTick('lp-depth', { ac: { autopilot: 'off' } }, RATE, SLOPE);
    expect(setCool).not.toHaveBeenCalled();
    await acTick('lp-depth', settingsAuto, RATE, SLOPE);
    expect(setCool).toHaveBeenLastCalledWith('dev-test', 76, 'auto');                // the guard's 2° step toward 75°
    await kv.set('nest:setpointWrite:dev-test', { at: Date.now(), f: 76 });           // what the real setCool records
    nest({ coolF: 76 });
    await acTick('lp-depth', settingsAuto, RATE, SLOPE);
    expect(setCool).toHaveBeenCalledTimes(1);                                         // one write per 30 minutes
    vi.setSystemTime(NOW + 31 * 60_000);
    await acTick('lp-depth', settingsAuto, RATE, SLOPE);
    expect(setCool).toHaveBeenLastCalledWith('dev-test', 75, 'auto');
    await kv.set('nest:setpointWrite:dev-test', null);
  });
});

describe('learning layer: the nightly job on seeded PGlite data', () => {
  const S = 'learn', RUN = Date.parse('2026-09-25T05:20:00-05:00'); // the nightly sync cron (10:15 UTC) runs the job right after the sync
  const day0 = '2026-08-21', days = Array.from({ length: 35 }, (_, i) => new Date(Date.parse(day0 + 'T12:00:00Z') + i * 864e5).toISOString().slice(0, 10)); // … 2026-09-24
  const ts = (d: string, h: number, m = 0) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`;
  // 5-minute energy (integer Wh so float4 sums are exact): solar = the BELL fixture × 80 Wh, home 1.5 kW (0.48 kW 1–5 AM), 0.24 kW bought 18–24
  const energyDay = (d: string, skipHours: number[] = [], toHour = 24) => Array.from({ length: toHour * 12 }, (_, i) => {
    const h = Math.floor(i / 12), t = ts(d, h, (i % 12) * 5);
    return skipHours.includes(h) ? null : { ts: t, epoch: Date.parse(t), day: d, hour: h, solar: BELL[h] * 80, home: h >= 1 && h <= 4 ? 40 : 125, imp: h >= 18 ? 20 : 0, exp: 0, chg: 0, dis: 0 };
  }).filter(r => r != null);
  // Nest every 10 minutes 10:00–21:00. Pre-cool days: 74° from 11 to 16 with the AC on half the time, then the coast warming at `rate` °F/h
  // to 78°. Control days: 76° all day, the AC on a third of the time. Plain days: 76°, idle.
  const nestDay = (d: string, kind: 'pre' | 'control' | 'plain', rate = 1) => Array.from({ length: 67 }, (_, i) => {
    const h = 10 + i / 6, at = Date.parse(ts(d, Math.floor(h), Math.round((h % 1) * 60)));
    if (kind === 'plain') return { at, h, indoor: 76, hvac: 'OFF', cool: 76 };
    if (kind === 'control') return { at, h, indoor: 76, hvac: h >= 11 && h < 20 && i % 3 === 0 ? 'COOLING' : 'OFF', cool: 76 };
    if (h < 11) return { at, h, indoor: 76, hvac: 'OFF', cool: 76 };
    if (h < 16) return { at, h, indoor: Math.max(74, 76 - (h - 11)), hvac: i % 2 ? 'COOLING' : 'OFF', cool: 74 };
    const f = Math.min(78, 74 + rate * (h - 16));
    return { at, h, indoor: Math.round(f * 100) / 100, hvac: f >= 78 ? 'COOLING' : 'OFF', cool: h < 20 ? 78 : 76 };
  }).map(r => ({ ...r, d, hour: Math.floor(r.h + 1e-9) }));
  const AC_DAYS: Array<[string, 'pre' | 'control', number]> = [['2026-09-16', 'pre', 1], ['2026-09-17', 'control', 0], ['2026-09-18', 'pre', 1], ['2026-09-19', 'pre', 2],
    ['2026-09-20', 'control', 0], ['2026-09-21', 'pre', 2], ['2026-09-23', 'pre', 1]];
  const metric = async (day: string, m: string) => (await one<{ value: number }>(`SELECT value FROM daily_metrics WHERE site_id = $1 AND day = $2 AND metric = $3`, [S, day, m]))?.value;

  beforeAll(async () => {
    vi.setSystemTime(RUN);
    const [a] = await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at) VALUES (NULL, 'test-access', 'test-refresh', 0) RETURNING id`);
    await q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info) VALUES ($1, NULL, $2, 'Test Site', $3)`, [S, a.id, JSON.stringify(siteInfo('2026-01-10'))]);
    await saveEnergyRows(S, [...days.flatMap(d => energyDay(d, d === '2026-09-24' ? [5, 6] : [])), ...energyDay('2026-09-25', [], 5), ...energyDay('2026-09-25', [], 6).slice(60, 63)]);
    // battery % every 15 minutes: 40 + 2 × hour
    const soe = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].flatMap(d => Array.from({ length: d === '2026-09-25' ? 22 : 96 }, (_, i) => ({ t: ts(d, Math.floor(i / 4), (i % 4) * 15), d, h: Math.floor(i / 4) })));
    await q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::smallint[], $6::real[])`,
      [S, soe.map(x => x.t), soe.map(x => Date.parse(x.t)), soe.map(x => x.d), soe.map(x => x.h), soe.map(x => 40 + 2 * x.h)]);
    const nr = [...AC_DAYS.map(([d, k, r]) => nestDay(d, k, r)), nestDay('2026-09-22', 'plain'), nestDay('2026-09-24', 'plain')].flat();
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco)
      SELECT $1, t, d, h, f, 45, 'COOL', hv, c, NULL, false FROM unnest($2::bigint[], $3::text[], $4::smallint[], $5::real[], $6::text[], $7::real[]) u(t, d, h, f, hv, c)`,
      [S, nr.map(r => r.at), nr.map(r => r.d), nr.map(r => r.hour), nr.map(r => r.indoor), nr.map(r => r.hvac), nr.map(r => r.cool)]);
    // pool: clean-filter days at 150 W; the last three days at 125 W (1,500 RPM) and 700 W in the 2,400 RPM boost hour; overnight checks with the pump off
    const pool = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-22', '2026-09-23', '2026-09-24'].flatMap(d => [
      { t: Date.parse(ts(d, 2, 1)), d, h: 2, run: false, w: 0, rpm: 0 }, { t: Date.parse(ts(d, 5, 1)), d, h: 5, run: false, w: 0, rpm: 0 },
      ...Array.from({ length: 36 }, (_, i) => { const h = 10 + Math.floor(i / 4), boost = h === 14; return { t: Date.parse(ts(d, h, (i % 4) * 15 + 1)), d, h, run: true,
        w: boost ? 700 : d >= '2026-09-22' ? 125 : 150, rpm: boost ? 2400 : 1500 }; })]);
    await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::smallint[], $5::boolean[], $6::real[], $7::real[])`,
      [S, pool.map(p => p.t), pool.map(p => p.d), pool.map(p => p.h), pool.map(p => p.run), pool.map(p => p.w), pool.map(p => p.rpm)]);
    // the newest bill ends 2026-09-10, so the current cycle runs to 2026-10-10
    await saveBill(S, { ...parsePecText(PEC_BILL), billDate: '2026-09-12', period: { from: '2026-08-11', to: '2026-09-10', days: 31 } });
    // Open-Meteo on the panel plane: the BELL × 125 W/m² every day (5.25 kWh/m²), 90° afternoons, no rain
    const wxDays = Array.from({ length: 34 }, (_, i) => new Date(Date.parse('2026-08-25T12:00:00Z') + i * 864e5).toISOString().slice(0, 10)); // … 2026-09-27
    const time = wxDays.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
    await kv.set(WX_KEY, { at: RUN, w: { hourly: { time, global_tilted_irradiance: time.map(t => BELL[+t.slice(11, 13)] * 125), temperature_2m: time.map(t => +t.slice(11, 13) >= 12 && +t.slice(11, 13) < 19 ? 90 : 80) },
      daily: { time: wxDays, temperature_2m_max: wxDays.map(() => 95), precipitation_sum: wxDays.map(() => 0) } } });
    // predictions made earlier: yesterday's forecast hours, the pool plan, tonight's always-on, a finished billing cycle, the AC days
    const made = (d: string, h: number, m = 15) => Date.parse(ts(d, h, m));
    await logPrediction(S, [
      { model: 'fc48.solar', day: '2026-09-24', hour: 12, horizon: 7, value: 6.76, madeAt: made('2026-09-24', 5) },
      { model: 'fc48.solar', day: '2026-09-24', hour: 12, horizon: 1, value: 99, madeAt: made('2026-09-24', 12, 30) }, // made after the hour began: never scored
      { model: 'fc48.home', day: '2026-09-24', hour: 12, horizon: 7, value: 1.5, madeAt: made('2026-09-24', 5) },
      { model: 'fc48.soc', day: '2026-09-24', hour: 12, horizon: 7, value: 70, madeAt: made('2026-09-24', 5) },
      { model: 'pool.kwhDay', day: '2026-09-24', value: 2.3, madeAt: made('2026-09-23', 20), inputs: { sched: [[600, 1140, 1500], [840, 900, 2400]], uvKwh: .54 } },
      { model: 'home.alwaysOn', day: '2026-09-24', value: .6, madeAt: made('2026-09-23', 5) },
      { model: 'bill.cycleImport', day: '2026-09-24', horizon: 5, value: 40, madeAt: made('2026-09-19', 5), inputs: { from: '2026-08-25', to: '2026-09-24' } },
      ...AC_DAYS.flatMap(([d, k]) => (['ac.shifted', 'ac.eveningAvoided'] as const).map(model => ({ model, day: d, value: k === 'pre' ? (model === 'ac.shifted' ? 2.1 : 1.7) : 0, madeAt: made(d, 7),
        inputs: { high: 95, sunKwhM2: 6, precool: k === 'pre', control: k === 'control', mid: 76, depth: 2, from: 11, to: 16, coastFrom: 16, coastTo: 20, coastF: 78, acKw: 3 } }))),
    ]);
  });

  it('scores yesterday’s predictions into daily_metrics with exact arithmetic, and updates model_scores', async () => {
    pg.queries = 0;
    const r = await runLearn(S, { now: RUN });
    const queries = pg.queries;
    expect(r.errors).toEqual([]);
    expect(r.scored.sort()).toEqual(['ac.eveningAvoided', 'ac.shifted', 'bill.cycleImport', 'fc48.home', 'fc48.soc', 'fc48.solar', 'home.alwaysOn', 'pool.kwhDay']);
    // 48-hour forecast, 12:00 yesterday: 6.76 predicted vs 5.76 kWh made (the 12:30 prediction is not scored)
    expect(await metric('2026-09-24', 'score:fc48.solar:pred')).toBeCloseTo(6.76, 6);
    expect(await metric('2026-09-24', 'score:fc48.solar:actual')).toBeCloseTo(5.76, 6);
    expect(await metric('2026-09-24', 'score:fc48.solar:ape')).toBeCloseTo(1 / 5.76, 6);
    expect(await metric('2026-09-24', 'score:fc48.solar:n')).toBe(1);
    expect(await metric('2026-09-24', 'score:fc48.solar:abs@h7-24')).toBeCloseTo(1, 6);
    expect(await metric('2026-09-24', 'score:fc48.home:abs')).toBe(0);
    expect(await metric('2026-09-24', 'score:fc48.soc:err')).toBe(6);                  // 70 predicted, 64% measured
    // pool: 32 quarter-hours at 125 W + 4 at 700 W + the plan's 0.54 kWh of UV = 2.24 kWh, every scheduled quarter-hour covered
    expect(await metric('2026-09-24', 'pool.coverage')).toBe(1);
    expect(await metric('2026-09-24', 'score:pool.kwhDay:actual')).toBeCloseTo(2.24, 6);
    expect(await metric('2026-09-24', 'score:pool.kwhDay:ape')).toBeCloseTo(.06 / 2.24, 6);
    // always-on: 0.48 kW from 1 to 5 AM (no AC then); 0.6 predicted
    expect(await metric('2026-09-24', 'home.alwaysOn_kw')).toBeCloseTo(.48, 6);
    expect(await metric('2026-09-24', 'score:home.alwaysOn:ape')).toBeCloseTo(.25, 6);
    // a billing cycle that ended yesterday: 31 days × 1.44 kWh bought
    expect(await metric('2026-09-24', 'score:bill.cycleImport:actual')).toBeCloseTo(44.64, 4);
    // AC on 2026-09-23 against the two control days: 7.5 − 5 = 2.5 kWh shifted; 4 − 0 = 4 kWh avoided in the evening
    expect(await metric('2026-09-23', 'score:ac.shifted:actual')).toBeCloseTo(2.5, 6);
    expect(await metric('2026-09-23', 'score:ac.eveningAvoided:actual')).toBeCloseTo(4, 6);
    const ms = await q<{ window: string; n: number; mae: number; mape: number; bias: number; last_day: string }>(
      `SELECT "window", n, mae, mape, bias, last_day FROM model_scores WHERE site_id = $1 AND model = 'fc48.solar' ORDER BY "window"`, [S]);
    expect(ms.map(x => x.window)).toEqual(['30d', '365d', '7d']);
    expect(ms[0]).toMatchObject({ n: 1, last_day: '2026-09-24' });
    expect([ms[0].mae, ms[0].mape, ms[0].bias]).toEqual([expect.closeTo(1, 6), expect.closeTo(1 / 5.76, 6), expect.closeTo(1 / 5.76, 6)]);
    expect(await one(`SELECT COUNT(*)::int n FROM model_scores WHERE site_id = $1`, [S])).toEqual({ n: 24 }); // 8 models × 3 windows
    expect(r.tiers).toMatchObject({ 'fc48.solar': 'learning', 'ac.shifted': 'measured', 'ac.eveningAvoided': 'measured' });
    // budget: a fixed number of round trips, no per-model or per-row queries
    expect(r.queries).toBeLessThanOrEqual(24);
    expect(queries).toBeLessThanOrEqual(26);
    expect(r.ms).toBeLessThan(5000);
    console.info(`[learning] nightly job on seeded data: ${queries} PGlite round trips (${r.queries} counted by the job), ${r.ms} ms`);
  });

  it('measured AC savings from control days, and today’s trim from the last three pre-cool days, left for the plan in kv', async () => {
    const ac = await kv.get<any>(learnAcKey(S));
    expect(ac.measured).toEqual({ measured: true, shiftedKwh: 2.5, eveningAvoidedKwh: 1.6, precoolDays: 5, controlDays: 2 });
    expect(ac.trim).toEqual({ what: 'coast', amount: -30, unit: 'min', warmupFPerH: 2, day: '2026-09-25',
      reason: 'the house reached 78° by 6 PM on Sep 19 and 6 PM on Sep 21, over an hour before the coast ended (warming about 2 °F an hour)' });
  });

  it('opens the anomalies that fire (a short energy day, the pump drawing less), and today’s predictions are logged', async () => {
    const open = await q<{ kind: string; day: string; severity: string; detail: any }>(`SELECT kind, day, severity, detail FROM anomalies WHERE site_id = $1 AND resolved_at IS NULL ORDER BY kind`, [S]);
    expect(open.map(a => [a.kind, a.day, a.severity])).toEqual([['data.gap.energy', '2026-09-24', 'warn'], ['pump.below_baseline@1500', '2026-09-24', 'warn']]);
    expect(open[1].detail).toMatchObject({ expected: 150, measured: 125, action: 'filter_cleaned', persisted: '3 of the last 3 covered days' });
    const p = await q<{ model: string; n: number }>(`SELECT model, COUNT(*)::int n FROM predictions WHERE site_id = $1 AND made_at = $2 GROUP BY model ORDER BY model`, [S, RUN]);
    expect(p).toEqual([{ model: 'bill.cycleImport', n: 1 }, { model: 'fc48.home', n: 48 }, { model: 'fc48.soc', n: 48 }, { model: 'fc48.solar', n: 48 }, { model: 'home.alwaysOn', n: 1 }]);
    const first = await one<{ target_day: string; target_hour: number; inputs: any }>(`SELECT target_day, target_hour, inputs FROM predictions WHERE site_id = $1 AND model = 'fc48.soc' AND made_at = $2 AND horizon = 1`, [S, RUN]);
    expect(first).toEqual({ target_day: '2026-09-25', target_hour: 6, inputs: { k: 1, yieldK: 7.68, soc0: 50, capKwh: 27, maxKw: 10, reservePct: 20, startHour: 5 } });
    expect(await one(`SELECT target_day, horizon, predicted, inputs FROM predictions WHERE site_id = $1 AND model = 'bill.cycleImport' AND made_at = $2`, [S, RUN]))
      .toEqual({ target_day: '2026-10-10', horizon: 15, predicted: 44.6, inputs: { from: '2026-09-10', to: '2026-10-10', elapsedDays: 15, importSoFar: 21.6, exportSoFar: 0 } });
    expect(await one(`SELECT target_day, predicted FROM predictions WHERE site_id = $1 AND model = 'home.alwaysOn' AND made_at = $2`, [S, RUN])).toEqual({ target_day: '2026-09-26', predicted: .48 });
    const last = await kv.get<any>(`${S}:learn:last`);
    expect(last).toMatchObject({ at: RUN, predicted: 146, anomalies: { opened: ['pump.below_baseline@1500', 'data.gap.energy'], resolved: [], open: 2 } });
    expect((await kv.get<any[]>(`${S}:learn:log`))?.map(e => e.delta)).toEqual(expect.arrayContaining(['−30 min', 'measured', 'warn']));
  });

  it('a rerun is idempotent; once the day is complete the gap resolves and the pump anomaly stays open (one row)', async () => {
    await saveEnergyRows(S, energyDay('2026-09-24').filter(r => r.hour === 5 || r.hour === 6));
    const r = await runLearn(S, { now: RUN + 60_000 });
    expect([r.errors, r.predicted, r.anomalies.opened, r.anomalies.resolved]).toEqual([[], 0, [], ['data.gap.energy']]);
    const rows = await q<{ kind: string; open: boolean }>(`SELECT kind, resolved_at IS NULL AS open FROM anomalies WHERE site_id = $1 ORDER BY kind`, [S]);
    expect(rows).toEqual([{ kind: 'data.gap.energy', open: false }, { kind: 'pump.below_baseline@1500', open: true }]);
    expect(await metric('2026-09-24', 'energy.buckets')).toBe(288);
    expect(await metric('2026-09-24', 'score:fc48.solar:ape')).toBeCloseTo(1 / 5.76, 6);
  });

  it('the pump anomaly resolves after three covered days back within 5% of the clean baseline, and a new firing opens a new row', async () => {
    const ins = (d: string, w: number) => q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) SELECT $1, t, $2, 12, true, $3, 1500 FROM unnest($4::bigint[]) t`,
      [S, d, w, Array.from({ length: 5 }, (_, i) => Date.parse(ts(d, 12, i * 5)))]);
    for (const d of ['2026-09-25', '2026-09-26', '2026-09-27']) await ins(d, 149);
    vi.setSystemTime(Date.parse('2026-09-28T05:20:00-05:00'));
    const r = await runLearn(S, { now: Date.now() });
    expect(r.anomalies.resolved).toContain('pump.below_baseline@1500');
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30']) await ins(d, 120);
    vi.setSystemTime(Date.parse('2026-10-01T05:20:00-05:00'));
    const r2 = await runLearn(S, { now: Date.now() });
    expect(r2.anomalies.opened).toContain('pump.below_baseline@1500');
    expect(await q(`SELECT day, resolved_at IS NULL AS open FROM anomalies WHERE site_id = $1 AND kind = 'pump.below_baseline@1500' ORDER BY id`, [S]))
      .toEqual([{ day: '2026-09-24', open: false }, { day: '2026-09-30', open: true }]);
  });
});
