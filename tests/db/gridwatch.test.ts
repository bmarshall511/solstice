// Grid alerts (mockup ab, server/src/gridwatch.ts) on PGlite: live readings inserted directly, the outage estimate stubbed, no push
// subscriptions (so alerts are stored, nothing is sent). An outage from 15:42 to 21:52 CDT on 2026-10-15.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { gridWatch, hoursText, isDown } from '../../server/src/gridwatch.js';

const T = (hm: string) => Date.parse(`2026-10-15T${hm}:00-05:00`);
const EST = async () => ({ hours: 9, hoursNoAc: 12, drawKw: 2.1 });
const read = (site: string, hm: string, o: { up: boolean; soc: number; load?: number }) =>
  q(`INSERT INTO readings (site_id, ts, load_w, soc, grid_status, island_status) VALUES ($1, $2, $3, $4, $5, $6)`,
    [site, T(hm), o.load ?? 2100, o.soc, o.up ? 'Active' : 'Inactive', o.up ? 'on_grid' : 'off_grid']);
const alerts = (site: string) => q<{ kind: string; title: string; body: string }>(`SELECT kind, title, body FROM alerts WHERE site_id = $1 ORDER BY id`, [site]);

beforeAll(async () => { await migrate(); });
beforeEach(async () => { await kv.set('settings:owner', {}); });

describe('grid alerts', () => {
  it('GW-1 helpers: down means not Active or off-grid; hours read like the push', () => {
    expect([isDown({ grid_status: 'Active', island_status: 'on_grid' }), isDown({ grid_status: 'Inactive', island_status: 'off_grid' }), isDown({ grid_status: 'Active', island_status: 'off_grid_intentional' })]).toEqual([false, true, true]);
    expect([hoursText(.4), hoursText(4.3), hoursText(9.2), hoursText(13.6), hoursText(null)]).toEqual(['under 1 h', '4.5 h', '9 h', '14 h', null]);
  });
  it('GW-2 a reading older than 10 minutes never starts an outage', async () => {
    await read('g0', '15:42', { up: false, soc: 64 });
    expect(await gridWatch('g0', T('15:55'), EST)).toEqual({ skipped: 'no fresh reading' });
    expect(await alerts('g0')).toEqual([]);
  });
  it('GW-3 down → one push with the start, the charge and the estimate; the next ticks add nothing', async () => {
    await read('g', '15:37', { up: true, soc: 66 }); await read('g', '15:42', { up: false, soc: 64 });
    expect(await gridWatch('g', T('15:45'), EST)).toMatchObject({ event: 'down', since: T('15:42'), notified: true });
    await read('g', '15:47', { up: false, soc: 63 });
    expect(await gridWatch('g', T('15:50'), EST)).toMatchObject({ down: true });
    expect(await alerts('g')).toEqual([{ kind: 'grid', title: 'Grid down · on Powerwalls', body: 'Since 3:42 PM. Powerwalls 64%, about 9 h at 2.1 kW now; longer with the AC off. Tap for the outage view.' }]);
  });
  it('GW-4 below 30% while still down → one warning with the time left and what the AC buys', async () => {
    await read('g', '20:40', { up: false, soc: 29, load: 1600 });
    expect(await gridWatch('g', T('20:41'), async () => ({ hours: 4, hoursNoAc: 7, drawKw: 1.6 }))).toMatchObject({ event: 'low', soc: 29 });
    await read('g', '21:30', { up: false, soc: 22 });
    await gridWatch('g', T('21:31'), EST);
    const a = await alerts('g');
    expect(a).toHaveLength(2);
    expect(a[1]).toEqual({ kind: 'gridLow', title: 'Powerwalls at 29% · grid still down', body: 'About 4 h left at 1.6 kW. AC off adds about 3 h. Down since 3:42 PM.' });
  });
  it('GW-5 back → how long it was out and the lowest charge; the state clears', async () => {
    await read('g', '21:52', { up: true, soc: 22 });
    expect(await gridWatch('g', T('21:55'), EST)).toMatchObject({ event: 'back', since: T('15:42'), end: T('21:52') });
    expect((await alerts('g')).at(-1)).toEqual({ kind: 'grid', title: 'Grid is back', body: 'Out 6 h 10 m (3:42–9:52 PM). The Powerwalls carried the house down to 22%; they recharge from here.' });
    expect(await kv.get('g:grid:outage')).toBeNull();
    expect(await gridWatch('g', T('22:00'), EST)).toEqual({ down: false });
  });
  it('GW-6 the switches are independent: outage off silences down/back, lowBatt off silences the 30% warning', async () => {
    await kv.set('settings:owner', { alerts: { outage: false } });
    await read('s', '10:00', { up: true, soc: 40 }); await read('s', '10:05', { up: false, soc: 28 });
    await gridWatch('s', T('10:06'), EST);   // down: silenced
    await read('s', '10:10', { up: false, soc: 27 });
    await gridWatch('s', T('10:11'), EST);   // low: still sent
    expect((await alerts('s')).map(a => a.kind)).toEqual(['gridLow']);
  });
});
