// Vacation mode's watch, held pushes, guest links and the learning layer (mockup ak frames 1b, 4 and 7) on PGlite. Read-only: the
// watch reads what the app stored (kv nest:last, pool:last, readings, nest_readings); no push subscription exists, so nothing is sent.
//   VW-1 the pure pieces: a spell of readings, the load nobody planned (a water-heater burst is expected for 45 min), signs of anyone home
//   VW-2 alerts during a trip: too hot, damp for 6 h, the thermostat offline, the pump off in two scheduled reads; each once
//   VW-3 somebody at the thermostat: asked while away (not again once "someone's allowed"); near the arrival time it is you (welcome home)
//   VW-4 power use nobody planned: alerted once in 6 h; near the arrival time it is you; "Not back yet?" once, 2 h past the arrival time
//   VW-5 "Looks like you're away": 12 h of Nest Away and a quiet house, once per Away spell; not with activity; not when muted
//   VW-6 the water-test and panel pushes wait during a trip (kept in the feed, marked held) and arrive as one summary at the end
//   VW-7 guest links answer as turned off during a trip and for 24 h after it, then open again; the owner's list still shows them live
//   VW-8 the grid-down push says there is nothing to do during a trip
//   VW-9 which days are trip days for the learning layer (the profile route itself: VAC-6 in vacation.test.ts)
//   VW-10 I-15: strip heat holding the away setpoint (Nest HEATING) is not power use nobody planned, nor a sign of anyone home
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { spell, unexplained, activity, vacationWatch, detectAway, heldSummary } from '../../server/src/vacation/watch.js';
import { createTrip, endTrip, liveTrip, patchTripData, tripDaysOf } from '../../server/src/vacation/trip.js';
import { notify } from '../../server/src/notify.js';
import { createShare, findShare, listShares } from '../../server/src/share.js';
import { gridWatch } from '../../server/src/gridwatch.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';

const S = 's', MIN = 60_000, H = 3600_000;
const NOW = Date.parse('2026-10-16T14:00:00-05:00');
const alerts = async () => (await q<{ kind: string; title: string; data: any; pushed: number }>(`SELECT kind, title, data, pushed FROM alerts ORDER BY id`));
const nest = (o: Record<string, unknown> = {}) => kv.set('nest:last', { at: NOW, deviceId: 'd', name: 'Hallway', online: true, indoorF: 84, humidity: 55, mode: 'COOL', hvac: 'OFF', coolF: 85, heatF: null, eco: false, ecoCoolF: 82, ecoHeatF: 50, fanTimer: false, availableModes: [], ...o });
const live = (from: number, to: number, kw: (t: number) => number, every = 5) => Promise.all(Array.from({ length: Math.floor((to - from) / (every * MIN)) + 1 }, (_, i) => from + i * every * MIN)
  .map(t => q(`INSERT INTO readings (site_id, ts, load_w, solar_w, grid_w, soc, grid_status, island_status) VALUES ($1,$2,$3,0,0,80,'Active','on_grid') ON CONFLICT DO NOTHING`, [S, t, kw(t) * 1000])));
const trip = (o: { leaveAt?: number; backAt?: number | null } = {}) => createTrip(S, { leaveAt: o.leaveAt ?? NOW - 864e5, backAt: o.backAt === undefined ? NOW + 2 * 864e5 : o.backAt, detected: false }, o.leaveAt ?? NOW - 864e5);

beforeAll(async () => { await migrate(); });
beforeEach(async () => {
  for (const t of ['trips', 'alerts', 'readings', 'nest_readings', 'pool_readings', 'access_tokens', 'energy']) await q(`DELETE FROM ${t}`);
  await q('DELETE FROM kv'); await nest();
  await q(`INSERT INTO sites (id, name) VALUES ($1, 'Test') ON CONFLICT DO NOTHING`, [S]);
});

describe('pure', () => {
  it('VW-1 a spell, the load nobody planned, signs of anyone home', () => {
    const rows = (v: number, hours: number) => Array.from({ length: hours * 4 + 1 }, (_, i) => ({ ts: NOW - hours * H + i * 15 * MIN, v }));
    expect(spell(rows(70, 6), NOW, 6 * H, r => r.v > 65)).toBe(true);
    expect(spell(rows(70, 5), NOW, 6 * H, r => r.v > 65)).toBe(false);
    const w = (kw: number) => [{ ts: NOW - 10 * MIN, loadKw: kw }, { ts: NOW - 5 * MIN, loadKw: kw }, { ts: NOW, loadKw: kw }];
    const o = { now: NOW, baseKw: .5, acKw: 2.6, cooling: false, poolKw: .1, since: null };
    expect(unexplained(w(3), o)).toEqual({ kw: 2.4, over: true, wh: false });
    expect(unexplained(w(5.2), o)).toEqual({ kw: 4.6, over: true, wh: true });                       // a water-heater-sized burst
    expect(unexplained(w(5.2), { ...o, since: NOW - 50 * MIN })).toMatchObject({ wh: false });       // …that has run 50 min is not
    expect(unexplained(w(3.6), { ...o, cooling: true })).toMatchObject({ over: false });             // the AC
    expect(unexplained(w(3), o.now ? { ...o, now: NOW + H } : o)).toBeNull();                        // no readings in the window
    const day = [.6, .6, 2.5, .6, .6, 3.4, 3.4, .6].map((loadKw, i) => ({ ts: i, loadKw, cooling: i === 5 || i === 6 }));
    expect(activity(day)).toBe(1);                                                                     // the AC's own step doesn't count
  });
});

describe('during a trip', () => {
  it('VW-2 too hot, damp, offline, pump off: each once', async () => {
    await trip(); await nest({ indoorF: 89 });
    for (let t = NOW - 6 * H; t <= NOW; t += 15 * MIN) await q(`INSERT INTO nest_readings (site_id, ts, day, hour, humidity) VALUES ($1,$2,'2026-10-16',12,68)`, [S, t]);
    await kv.set('s:pool:last', poolSnapshot(NOW, { running: false, schedules: [{ id: 1, circuitId: 6, start: 600, stop: 1140, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 }] }));
    for (const t of [NOW - 20 * MIN, NOW - 5 * MIN]) await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ($1,$2,'2026-10-16',13,false,0,0)`, [S, t]);
    const r = await vacationWatch(S, NOW);
    expect(r).toMatchObject({ temp: true, damp: true, pump: true });
    expect((await alerts()).map(a => [a.kind, a.title])).toEqual([['vacation', 'Inside is 89°'], ['vacation', 'The house is staying damp'], ['vacation', 'The pool pump didn’t run']]);
    await vacationWatch(S, NOW + 5 * MIN);
    expect(await alerts()).toHaveLength(3);
    await kv.set('nest:tokens', { refresh_token: 'x' }); await nest({ at: NOW - 2 * H });
    expect(await vacationWatch(S, NOW + 10 * MIN)).toMatchObject({ offline: true });
  });

  it('VW-2b two scheduled reads whose pump status failed are unknown: no "the pool pump didn\'t run" (code review C-09)', async () => {
    const { recordReading } = await import('../../server/src/appliances/pool.js');
    await trip();
    const unknown = (at: number) => { const s = poolSnapshot(at, { schedules: [{ id: 1, circuitId: 6, start: 600, stop: 1140, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 }] });
      s.pump = { ...s.pump!, running: null, watts: null, rpm: null, status: 'unknown' }; return s; };
    for (const t of [NOW - 20 * MIN, NOW - 5 * MIN]) await recordReading(S, unknown(t));
    expect(await q('SELECT 1 FROM pool_readings')).toEqual([]);
    expect(await vacationWatch(S, NOW)).not.toHaveProperty('pump');
    expect((await alerts()).filter(a => a.title === 'The pool pump didn’t run')).toEqual([]);
  });

  it('VW-3 somebody at the thermostat: asked while away, not once allowed; near the arrival time it is you', async () => {
    const t = await trip(), ended: string[] = [], end = async (_s: string, text: string) => { ended.push(text); };
    await kv.set('s:ac:hold', { at: NOW - 2 * MIN, by: 'wall', mode: 'COOL', coolF: 74, heatF: null, until: NOW + 2 * H, why: '' });
    expect(await vacationWatch(S, NOW, end)).toMatchObject({ wall: true });
    expect((await alerts()).at(-1)).toMatchObject({ title: 'Someone set the thermostat to 74°', data: { ask: 'wall' } });
    await patchTripData(t.id, { watch: { ...((await liveTrip(S))!.data.watch as object), allowedDay: '2026-10-16' } });
    await kv.set('s:ac:hold', { at: NOW + MIN, by: 'wall', mode: 'COOL', coolF: 73, heatF: null, until: NOW + 2 * H, why: '' });
    expect(await vacationWatch(S, NOW + 5 * MIN, end)).not.toHaveProperty('wall');
    expect((await liveTrip(S))!.data.log!.map(l => l.text)).toContain('Someone set the thermostat to 73° at 2:01 PM');
    // the arrival time has come: the next change is you
    await q('DELETE FROM trips'); await trip({ backAt: NOW - 30 * MIN });
    await kv.set('s:ac:hold', { at: NOW + 6 * MIN, by: 'wall', mode: 'COOL', coolF: 75, heatF: null, until: NOW + 2 * H, why: '' });
    expect(await vacationWatch(S, NOW + 10 * MIN, end)).toMatchObject({ ended: 'thermostat' });
    expect(ended).toEqual(['Welcome home: someone set the thermostat to 75° at 2:06 PM']);
  });

  it('VW-4 power use nobody planned, once in 6 h; near the arrival time it is you; "Not back yet?" once', async () => {
    await trip(); await live(NOW - 24 * H, NOW - H, () => .5); await live(NOW - 20 * MIN, NOW, () => 3.1);
    expect(await vacationWatch(S, NOW)).toMatchObject({ load: true });
    expect((await alerts()).at(-1)).toMatchObject({ title: 'Power use nobody planned', data: { kw: 2.6 } });
    await live(NOW, NOW + 10 * MIN, () => 3.1);
    expect(await vacationWatch(S, NOW + 10 * MIN)).not.toHaveProperty('load');
    const ended: string[] = [];
    await q('DELETE FROM trips'); await trip({ backAt: NOW - H });
    expect(await vacationWatch(S, NOW + 10 * MIN, async (_s, text) => { ended.push(text); })).toMatchObject({ ended: 'load' });
    await q('DELETE FROM readings'); await q('DELETE FROM trips'); await q('DELETE FROM alerts'); await trip({ backAt: NOW - 3 * H });
    expect(await vacationWatch(S, NOW)).toMatchObject({ phase: 'late', late: true });
    expect(await vacationWatch(S, NOW + 5 * MIN)).not.toHaveProperty('late');
    expect((await alerts()).map(a => a.title)).toEqual(['Not back yet?']);
  });
});

describe('heating while away (I-15)', () => {
  it('VW-10 strips holding the away setpoint are not "power use nobody planned"; a strip stage switching on is not activity', async () => {
    const o = { now: NOW, baseKw: .5, acKw: 2.6, cooling: false, poolKw: 0, since: null };
    const w = (kw: number) => [{ ts: NOW - 10 * MIN, loadKw: kw }, { ts: NOW - 5 * MIN, loadKw: kw }, { ts: NOW, loadKw: kw }];
    expect(unexplained(w(13.5), o)).toMatchObject({ over: true });                                   // before: compressor + two strip stages fired the alert
    expect(unexplained(w(13.5), { ...o, heating: true, heatKw: 14 })).toMatchObject({ kw: 0, over: false });
    expect(unexplained(w(17.5), { ...o, heating: true, heatKw: 14 })).toMatchObject({ kw: 3, over: true });   // more than the heating can draw still counts
    expect(activity([.6, 4, 8.8, 13.6, .6].map((loadKw, i) => ({ ts: i, loadKw, cooling: false, heating: i >= 1 && i <= 3 })))).toBe(0);
    // the watch itself: Nest says HEATING at 55°, the strips run 15 minutes during the trip, no alert
    await trip(); await nest({ mode: 'HEAT', hvac: 'HEATING', heatF: 55, coolF: null, indoorF: 55 });
    await live(NOW - 24 * H, NOW - H, () => .5); await live(NOW - 20 * MIN, NOW, () => 13.5);
    const r = await vacationWatch(S, NOW);
    expect(r).not.toHaveProperty('load');
    expect((await alerts()).filter(a => a.title === 'Power use nobody planned')).toEqual([]);
    // with the same load and Nest idle it is still caught
    await nest({ mode: 'HEAT', hvac: 'OFF', heatF: 55, coolF: null, indoorF: 55 });
    expect(await vacationWatch(S, NOW + 5 * MIN)).toMatchObject({ load: true });
  });
});

describe('detection, held pushes, guests, the grid push', () => {
  it('VW-5 "Looks like you\'re away": 12 h of Away and a quiet house, once per spell; not with activity; not when muted', async () => {
    await nest({ eco: true });
    for (let t = NOW - 13 * H; t <= NOW; t += 15 * MIN) await q(`INSERT INTO nest_readings (site_id, ts, day, hour, eco, hvac) VALUES ($1,$2,'2026-10-16',12,true,'OFF')`, [S, t]);
    await live(NOW - 12 * H, NOW, () => .55);
    expect(await detectAway(S, NOW)).toMatchObject({ notified: true });
    expect(await detectAway(S, NOW + 5 * MIN)).toMatchObject({ notified: false });
    expect((await alerts())).toEqual([expect.objectContaining({ kind: 'vacation', title: 'Looks like you’re away', data: expect.objectContaining({ ask: 'detect' }) })]);
    await q('DELETE FROM alerts'); await q('DELETE FROM readings');
    await live(NOW - 12 * H, NOW, t => (Math.floor(t / H) % 3 === 0 && (t / MIN) % 60 < 20) ? 2.5 : .55);   // a kettle, an oven: someone's home
    expect(await detectAway(S, NOW)).toMatchObject({ away: true, activity: expect.any(Number) });
    expect(await alerts()).toEqual([]);
    await kv.set('s:vacation:snooze', NOW + H);
    expect(await detectAway(S, NOW)).toEqual({ snoozed: true });
  });

  it('VW-6 the water-test and panel pushes wait during a trip and arrive as one summary', async () => {
    const t = await trip();
    expect(await notify(S, 'poolTest', 'Time to test the pool', 'x', {}, { now: NOW })).toMatchObject({ stored: true, held: true, pushed: 0 });
    expect(await notify(S, 'panel', 'The PVS relay has gone quiet', 'x', {}, { now: NOW })).toMatchObject({ held: true });
    expect(await notify(S, 'storm', 'Tornado Warning', 'x', {}, { now: NOW })).not.toHaveProperty('held');
    const done = (await endTrip(S, 'you', NOW + H))!;
    expect(await heldSummary(S, done, NOW + H)).toEqual({ held: 2, notified: true });
    expect((await alerts()).at(-1)).toMatchObject({ kind: 'vacation', title: 'While you were away' });
    expect(t.id).toBe(done.id);
  });

  it('VW-7 guest links answer as turned off during a trip and for 24 h after, then open again', async () => {
    const { token } = await createShare('Mum', 'never');
    expect((await findShare(token))!.state).toBe('active');
    await trip({ leaveAt: Date.now() - H, backAt: Date.now() + 864e5 });
    expect((await findShare(token))!.state).toBe('revoked');
    expect((await listShares())[0].state).toBe('active');                                  // the owner's list is the truth
    await endTrip(S, 'you', Date.now() - 23 * H);
    expect((await findShare(token))!.state).toBe('revoked');
    await q(`UPDATE trips SET ended_at = $1`, [Date.now() - 25 * H]);
    expect((await findShare(token))!.state).toBe('active');
  });

  it('VW-8 the grid-down push during a trip', async () => {
    await trip({ leaveAt: Date.now() - H, backAt: Date.now() + 864e5 });
    await q(`INSERT INTO readings (site_id, ts, load_w, soc, grid_status, island_status) VALUES ($1, $2, 500, 86, 'Inactive', 'off_grid')`, [S, Date.now() - MIN]);
    await gridWatch(S, Date.now(), async () => ({ hours: 40, hoursNoAc: 40, drawKw: .5 }));
    expect((await alerts()).at(-1)).toMatchObject({ kind: 'grid', title: 'Grid down · house on Powerwalls' });
    expect((await q(`SELECT body FROM alerts WHERE kind = 'grid'`))[0].body).toMatch(/about 40 h at the empty house's 0\.5 kW, longer with the sun\. Nothing to do; Solstice will tell you when the grid is back\.$/);
  });
});

describe('the learning layer', () => {
  it('VW-9 trip days: the days a trip covered 4 h or more, for the profile, the always-on watch and the rules to leave out', () => {
    const trips = tripDaysOf([{ state: 'ended', startedAt: Date.parse('2026-10-08T00:00:00-05:00'), endedAt: Date.parse('2026-10-09T23:59:00-05:00') }], '2026-10-02', '2026-10-16');
    expect([...trips]).toEqual(['2026-10-08', '2026-10-09']);
  });
});
