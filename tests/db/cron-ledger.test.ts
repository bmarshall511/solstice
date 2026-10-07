// B2-11 (idea I-09): the cron run ledger (server/src/cronLedger.ts) and the three watchdog alerts, with fake clocks, on PGlite.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { ledger, markOf, slowest, cronAlerts, cronWatch, cronHealth, cronKey, type CronRecord } from '../../server/src/cronLedger.js';
import { fiveMinuteWatch, fiveMinuteSteps } from '../../server/src/watch.js';

beforeAll(migrate);
afterEach(() => { vi.useRealTimers(); });
const rec = (at: number, ms = 1000, steps: CronRecord['steps'] = { a: 10 }, ok = true): CronRecord => ({ at, ms, steps, ok, errors: [] });
const T = (s: string) => Date.parse(s);   // instants written with their Chicago offset

describe('the ledger', () => {
  it('CL-1 times steps, adds up repeats, marks errors (returned or thrown, passed through) and skips, and writes kv cron:<name>:last', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'], now: T('2026-10-07T05:15:00-05:00') });
    const L = ledger('sync');
    expect(await L.step('sync', async () => { vi.advanceTimersByTime(3000); return { days: 1 }; })).toEqual({ days: 1 });
    await L.step('sync', async () => { vi.advanceTimersByTime(1000); return {}; });             // a second site: the same step adds up
    expect(await L.step('learn', async () => { vi.advanceTimersByTime(500); return { errors: ['rules: boom'] }; })).toEqual({ errors: ['rules: boom'] });
    await expect(L.step('prune', async () => { throw new Error('disk'); })).rejects.toThrow('disk');
    L.mark('pvsPrune', 'skipped');
    const r = await L.finish();
    expect(r).toEqual({ at: T('2026-10-07T05:15:00-05:00'), ms: 4500, steps: { sync: 4000, learn: 'error', prune: 'error', pvsPrune: 'skipped' }, ok: false, errors: ['learn: rules: boom', 'prune: disk'] });
    expect(await kv.get(cronKey('sync'))).toEqual(r);
    expect(slowest(r)).toEqual({ name: 'sync', ms: 4000 });
  });
  it('CL-2 what a step result means', () => {
    expect([markOf({ ok: 1 }, 12.4), markOf({ error: 'x' }, 1), markOf({ skipped: 'out of time' }, 1), markOf({ storm: { error: 'nws' } }, 1), markOf({ errors: [] }, 3), markOf(null, 2)])
      .toEqual([12, 'error', 'skipped', 'error', 3, 2]);
  });
  it('CL-3 the 5-minute watch reports each step to the ledger; /api/now health gets the slim records', async () => {
    const seen: string[] = [], saved = { ...fiveMinuteSteps };
    for (const k of Object.keys(fiveMinuteSteps)) delete fiveMinuteSteps[k];
    fiveMinuteSteps.one = async () => ({ fine: true }); fiveMinuteSteps.two = async () => { throw new Error('nope'); };
    try { await fiveMinuteWatch('s', Date.now(), (n, ms, r) => seen.push(`${n}:${markOf(r, ms) === 'error' ? 'error' : 'ms'}`)); }
    finally { for (const k of Object.keys(fiveMinuteSteps)) delete fiveMinuteSteps[k]; Object.assign(fiveMinuteSteps, saved); }
    expect(seen).toEqual(['one:ms', 'two:error']);
    await kv.set(cronKey('nest'), rec(5, 900, { 'watch.storm': 700, sampling: 150 }));
    await kv.set(cronKey('pool'), null);
    expect(await cronHealth()).toMatchObject({ nest: { at: 5, ms: 900, ok: true, slowest: { name: 'watch.storm', ms: 700 }, errors: 0 }, pool: null });
  });
});

describe('the watchdog alerts (pure, fake clocks)', () => {
  it('CL-4 the 5-minute tick silent for 20 minutes', () => {
    const now = T('2026-10-07T14:30:00-05:00');
    expect(cronAlerts({ nest: rec(now - 15 * 60_000) }, now)).toEqual([]);
    expect(cronAlerts({ nest: rec(now - 25 * 60_000) }, now)).toEqual([expect.objectContaining({ key: 'cron:nest:silent:2026-10-07', title: 'The 5-minute checks went quiet', data: { minutes: 25 } })]);
    expect(cronAlerts({}, now)).toEqual([]);                                                       // no record yet: nothing to judge
  });
  it('CL-5 the pool plan missed by 21:00 Chicago (CDT and CST)', () => {
    const yesterday = rec(T('2026-10-06T20:15:00-05:00')), today = rec(T('2026-10-07T20:15:00-05:00'));
    expect(cronAlerts({ pool: yesterday }, T('2026-10-07T20:55:00-05:00'))).toEqual([]);
    expect(cronAlerts({ pool: yesterday }, T('2026-10-07T21:05:00-05:00')).map(a => a.key)).toEqual(['cron:pool:missed:2026-10-07']);
    expect(cronAlerts({ pool: today }, T('2026-10-07T21:05:00-05:00'))).toEqual([]);
    expect(cronAlerts({ pool: rec(T('2026-12-01T19:15:00-06:00')) }, T('2026-12-02T21:00:00-06:00')).map(a => a.key)).toEqual(['cron:pool:missed:2026-12-02']);
  });
  it('CL-6 a nightly over 50 s, flagged for a day', () => {
    const at = T('2026-10-07T05:15:00-05:00');
    expect(cronAlerts({ sync: rec(at, 48_000) }, at + 3600e3)).toEqual([]);
    expect(cronAlerts({ sync: rec(at, 52_000, { learn: 30_000, sync: 20_000 }) }, at + 3600e3)).toEqual([expect.objectContaining({ key: 'cron:sync:slow:2026-10-07',
      body: expect.stringContaining('took 52 s of the 60 s Vercel allows (slowest: learn, 30 s)') })]);
    expect(cronAlerts({ sync: rec(at, 52_000) }, at + 25 * 3600e3)).toEqual([]);                    // a day later it has had its say
    expect(cronAlerts({ sync: rec(at, 52_000), nest: rec(at) }, at + 3600e3, ['nest']).map(a => a.key)).toEqual(['cron:nest:silent:2026-10-07']);   // the nightly checks only the tick
  });
});

describe('the watch step (PGlite)', () => {
  it('CL-7 pushes once per kind per day, however many ticks see it', async () => {
    await q(`DELETE FROM alerts`);
    await kv.set(cronKey('pool'), rec(T('2026-10-06T20:15:00-05:00')));
    await kv.set(cronKey('nest'), rec(T('2026-10-07T21:00:00-05:00')));
    await kv.set(cronKey('sync'), null);
    expect(await cronWatch('s', T('2026-10-07T21:05:00-05:00'))).toEqual({ alerts: ['pool:missed'] });
    await cronWatch('s', T('2026-10-07T21:10:00-05:00'));
    await kv.set(cronKey('nest'), rec(T('2026-10-07T21:00:00-05:00')));
    await cronWatch('s', T('2026-10-07T21:40:00-05:00'));                                          // + the tick went quiet
    expect((await q<{ title: string }>(`SELECT title FROM alerts WHERE site_id = 's' ORDER BY id`)).map(a => a.title))
      .toEqual(['Tonight’s pool plan didn’t run', 'The 5-minute checks went quiet']);
  });
});
