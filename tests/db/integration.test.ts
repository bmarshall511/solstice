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
import { syncSite } from '../../server/src/sync.js';
import { teslaFor, localDay } from '../../server/src/tesla/client.js';
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

  // BUG-7 · fixed: current.turnoverPerDay used the 120 GPM default whatever settings.designGpm said (latent: the default is
  // 120), so designGpm 100 reported 2 turnovers a day.
  it('BUG-7: the current schedule’s turnover uses settings.designGpm', async () => {
    const d = await poolDetail('p-gpm', { pool: { designGpm: 100 } }, RATE);
    expect(d.current.turnoverPerDay).toBe(1.67);
  });
  it('BUG-7 (fixed): designGpm 100 reports 1.67 turnovers; the 120 GPM default still reports 2', async () => {
    expect((await poolDetail('p-gpm', { pool: { designGpm: 100 } }, RATE)).current.turnoverPerDay).toBe(1.67);
    expect((await poolDetail('p-gpm', {}, RATE)).current.turnoverPerDay).toBe(2);
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
    // BUG-4 · fixed: months 3, 4, 6, 7, 9 and 10 (0-based) used to highlight the next season (April showed Jun–Aug, October
    // showed Dec–Feb). The flag now compares meteorological seasons.
    it('BUG-4: every month highlights its own season', () => {
      expect(labels).toEqual(['Dec–Feb', 'Dec–Feb', 'Mar–May', 'Mar–May', 'Mar–May', 'Jun–Aug', 'Jun–Aug', 'Jun–Aug', 'Sep–Nov', 'Sep–Nov', 'Sep–Nov', 'Dec–Feb']);
    });
    it('BUG-4 (fixed): April highlights Mar–May and October highlights Sep–Nov', () => {
      expect([labels[3], labels[9]]).toEqual(['Mar–May', 'Sep–Nov']);
    });
  });

  describe('the last evening of a month in production (UTC)', () => {
    // 2026-01-31 19:30 CST is already February in UTC. BUG-6 · fixed: poolDetail and pollenFor read new Date().getMonth(), so
    // from 18:00 CST (19:00 CDT) on the last day of every month the plan and the pollen signal used next month (February,
    // 'medium'). They now read the Chicago date.
    const at = Date.parse('2026-02-01T01:30:00Z');
    it('BUG-6: the plan month and pollen follow the Chicago date', async () => {
      vi.setSystemTime(at); await seedForecast();
      const d = await poolDetail('p-monthend', {}, RATE);
      expect(d.plan.month).toBe(0);
      expect((d.autopilot as any).signals.pollen).toBe('low');
    });
    it('BUG-6 (fixed): the plan says January with January pollen until Chicago midnight, then February', async () => {
      vi.setSystemTime(at); await seedForecast();
      expect(localDay()).toBe('2026-01-31');
      const d = await poolDetail('p-monthend', {}, RATE);
      expect(d.plan.month).toBe(0);
      expect((d.autopilot as any).signals.pollen).toBe('low');
      vi.setSystemTime(Date.parse('2026-02-01T06:30:00Z')); await seedForecast();   // 00:30 CST on February 1
      expect(localDay()).toBe('2026-02-01');
      const next = await poolDetail('p-monthend', {}, RATE);
      expect(next.plan.month).toBe(1);
      expect((next.autopilot as any).signals.pollen).toBe('medium');
    });
  });
});

/* ---------------------------------------------------------------- BUG-1 through the real code paths */
// Fixed: the predicates match numeric circuit ids through jsonb_array_elements_text. Before, none of the three signals fired
// (why [], 9 h, useDays 0, lightReadings30d 0).
describe('BUG-1: pool-use signals never fire (jsonb ?| on numeric circuit ids)', () => {
  beforeAll(async () => {
    // yesterday at noon: blower, pool light and pump on
    await recordReading('p-used', poolSnapshot(NOW - 864e5 - 3600e3, { on: [2, 3, 6] }));
  });
  const suggest = () => autopilot('p-used', { settings: POOL_DEFAULTS, mode: 'suggest', W: W0, rate: RATE, names: NAMES, snap: null, waterTemp: 88, currentHours: 9, act: false });

  it('BUG-1: yesterday’s use adds an hour to tomorrow’s plan', async () => {
    const a = await suggest();
    expect(a.tomorrow.why).toContain('+1 h: the pool was used yesterday');
    expect(a.tomorrow.plan.hours).toBe(10);
  });
  it('BUG-1: the use-days signal counts yesterday', async () => {
    expect((await suggest()).signals.useDays).toBe(1);
  });
  it('BUG-1: the pool-light readings are counted', async () => {
    const d = await poolDetail('p-used', {}, RATE);
    expect(d.extras.lightReadings30d).toBeGreaterThan(0);
  });
  it('BUG-1 (fixed): all three signals fire', async () => {
    const a = await suggest();
    expect([a.tomorrow.why, a.tomorrow.plan.hours, a.signals.useDays]).toEqual([['+1 h: the pool was used yesterday'], 10, 1]);
    expect((await poolDetail('p-used', {}, RATE)).extras.lightReadings30d).toBe(1);
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
  const T10 = Date.parse('2026-09-25T10:05:00-05:00'); // Friday 10:05 CDT: cooling season (5-minute Nest samples) and a pool read slot
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

  it('poolDetail: the UV lamp is counted once in today so far, however many readings saw it', async () => {
    // pump-only readings every 5 minutes 08:00–11:55 at exactly the model's 1,500 RPM watts, so the pump energy is unchanged;
    // they used to add the lamp again from the readings (+0.235 kWh: 2.0 instead of 1.8)
    for (let m = 8 * 60; m < 12 * 60; m += 5) {
      const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      await recordReading('p-uv', poolSnapshot(Date.parse(`2026-09-25T${hm}:00-05:00`), { watts: W0(1500) }));
    }
    await kv.set('p-uv:pool:last', poolSnapshot(NOW - 30_000));
    const d = await poolDetail('p-uv', {}, RATE);
    expect(d.todayKwh).toBe(1.8);                         // same as with no readings (p-today above)
    expect(d.extras.todayKwh).toBe(.24);                  // the readings' UV lamp still shows in the extras (47 × 5 min at 60 W)
  });
});
