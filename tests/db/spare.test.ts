// Spare solar (mockup ad, server/src/spare.ts) on PGlite: live readings inserted directly, the pool's last snapshot in kv, and a fake
// controller write that records what would be sent. Monday 2026-10-05, 13:40 CDT; the Pool program runs 07:00–19:00.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { spareNow, isSpare, spareHistory, spareWatch } from '../../server/src/spare.js';
import { spareSolarW } from '../../server/src/appliances/ac.js';
import { poolSnapshot } from '../fixtures/screenlogic.js';

const T = (hm: string, d = '2026-10-05') => Date.parse(`${d}T${hm}:00-05:00`);
const read = (site: string, hm: string, o: { soc: number; gridW: number; solarW?: number; loadW?: number }) =>
  q(`INSERT INTO readings (site_id, ts, solar_w, load_w, grid_w, soc, grid_status, island_status) VALUES ($1, $2, $3, $4, $5, $6, 'Active', 'on_grid') ON CONFLICT DO NOTHING`,
    [site, T(hm), o.solarW ?? 6000, o.loadW ?? 3700, o.gridW, o.soc]);
const SCHED = [{ id: 2, circuitId: 6, start: 420, stop: 1140, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 }];
const writes: any[] = [];
const fakeWrite = vi.fn(async (cmd: any) => { writes.push(cmd); return poolSnapshot(Date.now(), { on: cmd.on ? [6, cmd.id] : [6], schedules: SCHED }); });
const log = async (site: string) => (await kv.get<any[]>(`${site}:pool:autolog`) ?? []).map(l => l.text);

beforeAll(async () => { await migrate(); });
beforeEach(async () => { writes.length = 0; fakeWrite.mockClear(); await kv.set('settings:owner', { pool: { autopilot: 'auto' } }); });

describe('spare solar', () => {
  it('SP-1 spare = Powerwalls at 95%+ and at least 1 kW out to PEC over 15 minutes (0.3 kW keeps it going)', async () => {
    for (const [hm, soc, g] of [['13:30', 97, -2300], ['13:35', 98, -2200]] as const) await read('a', hm, { soc, gridW: g });
    const s = await spareNow('a', T('13:40'));
    expect(s).toMatchObject({ exportW: 2250, soc: 98, full: true });
    expect([isSpare(s), isSpare({ ...s!, exportW: 500 }), isSpare({ ...s!, exportW: 500 }, 300), isSpare({ ...s!, full: false })]).toEqual([true, false, true, false]);
  });
  it('SP-2 AC pre-cool: solar minus home only counts while the Powerwalls are full', async () => {
    for (const hm of ['13:30', '13:35']) await read('b', hm, { soc: 70, gridW: 0, solarW: 6000, loadW: 3000 });
    expect(await spareSolarW('b', false, 2.7, T('13:40'))).toBe(0);           // 3 kW "surplus" is charging the Powerwalls
    expect(await spareSolarW('b', true, 2.7, T('13:40'))).toBe(0);            // no add-back of the AC either
    for (const hm of ['13:30', '13:35']) await read('c', hm, { soc: 97, gridW: -3000, solarW: 6000, loadW: 3000 });
    expect(await spareSolarW('c', false, 2.7, T('13:40'))).toBe(3000);
  });
  it('SP-3 Auto: the pool speeds up while spare, renews near the end of its hour, and ends when the export stops', async () => {
    await kv.set('d:pool:last', poolSnapshot(T('13:35'), { schedules: SCHED }));
    for (const hm of ['13:30', '13:35']) await read('d', hm, { soc: 98, gridW: -2300 });
    expect(await spareWatch('d', T('13:40'), fakeWrite)).toMatchObject({ started: true, exportW: 2300 });
    expect(writes).toEqual([{ kind: 'circuit', id: 8, on: true, minutes: 60 }]);
    expect((await log('d'))[0]).toBe('Spare solar: Pool up to 2,400 RPM while the Powerwalls are full and 2.3 kW goes to PEC. Counts toward today\'s turnovers.');
    for (const hm of ['13:45', '13:50']) await read('d', hm, { soc: 99, gridW: -2000 });
    expect(await spareWatch('d', T('13:55'), fakeWrite)).toEqual({ running: true });
    for (const hm of ['14:25', '14:30', '14:35']) await read('d', hm, { soc: 99, gridW: -1500 });
    expect(await spareWatch('d', T('14:35'), fakeWrite)).toEqual({ renewed: true });      // 5 min left on its timer
    for (const hm of ['15:00', '15:05', '15:10']) await read('d', hm, { soc: 96, gridW: 200 });
    expect(await spareWatch('d', T('15:10'), fakeWrite)).toMatchObject({ ended: true });
    expect(writes.at(-1)).toEqual({ kind: 'circuit', id: 8, on: false });
    expect((await log('d'))[0]).toMatch(/^Spare solar ended: back to 1,500 RPM after 1 h 30 m \(about \d+(\.\d)? kWh used here instead of sent out\)$/);
  });
  it('SP-4 Suggest notes it once a day and writes nothing; Off does nothing', async () => {
    await kv.set('settings:owner', { pool: { autopilot: 'suggest' } });
    await kv.set('e:pool:last', poolSnapshot(T('13:35'), { schedules: SCHED }));
    for (const hm of ['13:30', '13:35']) await read('e', hm, { soc: 98, gridW: -2300 });
    expect(await spareWatch('e', T('13:40'), fakeWrite)).toMatchObject({ noted: true });
    await read('e', '13:40', { soc: 98, gridW: -2300 });
    expect(await spareWatch('e', T('13:45'), fakeWrite)).toEqual({ spare: true, mode: 'suggest' });
    expect((await log('e'))).toEqual(['Spare solar now (2.3 kW to PEC): in Auto the pool would speed up to 2,400 RPM']);
    await kv.set('settings:owner', { pool: { autopilot: 'off' } });
    await read('e', '13:45', { soc: 98, gridW: -2300 });
    expect(await spareWatch('e', T('13:50'), fakeWrite)).toEqual({ spare: true, mode: 'off' });
    expect(writes).toEqual([]);
  });
  it('SP-5 never during a Clear-up, an owner boost, or outside the Pool program', async () => {
    for (const hm of ['13:30', '13:35']) await read('f', hm, { soc: 98, gridW: -2300 });
    await kv.set('f:pool:last', poolSnapshot(T('13:35'), { schedules: SCHED, on: [6, 8] }));
    expect(await spareWatch('f', T('13:40'), fakeWrite)).toEqual({ skipped: 'boost already on' });
    await kv.set('f:pool:last', poolSnapshot(T('13:35'), { schedules: [{ ...SCHED[0], start: 900, stop: 1140 }] }));
    expect(await spareWatch('f', T('13:40'), fakeWrite)).toEqual({ skipped: 'pool program not running' });
    await kv.set('f:pool:clearup', { startedAt: 0, until: T('20:15', '2026-10-07'), days: 2, rpm: 2000 });
    expect(await spareWatch('f', T('13:40'), fakeWrite)).toEqual({ skipped: 'clear-up' });
    expect(writes).toEqual([]);
  });
  it('SP-6 the card: days with spare solar (95%+ or over 2 kWh out) and kWh out, by month', async () => {
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, export_wh) VALUES ('h', '2026-03-10T12:00:00-05:00', 1, '2026-03-10', 12, 3000), ('h', '2026-03-11T12:00:00-05:00', 2, '2026-03-11', 12, 500), ('h', '2026-07-01T12:00:00-05:00', 3, '2026-07-01', 12, 100)`);
    await q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) VALUES ('h', '2026-03-11T12:00:00-05:00', 2, '2026-03-11', 12, 99)`);
    const d = await spareHistory('h', T('13:40'));
    expect(d.months).toEqual([{ month: '2026-03', days: 2, exportKwh: 4 }, { month: '2026-07', days: 0, exportKwh: 0 }]);
    expect([d.days, d.exportKwh, d.now]).toEqual([2, 4, null]);
  });
});
