// Powerwall capacity measured from discharges (mockup af, server/src/capacity.ts): synthetic 5-minute buckets and battery % on PGlite.
import { describe, it, expect, beforeAll } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { measurements, summarize, modelKwh, refreshCapacity, capacityOf, type Bucket, type SoePoint } from '../../server/src/capacity.js';
import { usableKwh } from '../../server/src/outage.js';

const T = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`), NOW = T('2026-10-05', '01:00');
/** An evening discharge: `hours` at `kw` from `from`, the charge falling from s0 so that a full charge delivers `full` kWh. */
function evening(day: string, o: { from?: string; hours: number; kw: number; s0: number; full: number }) {
  const t0 = T(day, o.from ?? '18:00'), n = o.hours * 12, b: Bucket[] = [], s: SoePoint[] = [];
  for (let i = 0; i < n; i++) b.push({ epoch: t0 + i * 300e3, charge: 0, discharge: o.kw * 1000 / 12 });
  for (let i = 0; i <= n; i += 3) s.push({ epoch: t0 + i * 300e3, soe: o.s0 - (o.kw * i / 12) / o.full * 100 });
  return { b, s };
}
const join = (xs: Array<{ b: Bucket[]; s: SoePoint[] }>) => ({ b: xs.flatMap(x => x.b).sort((a, c) => a.epoch - c.epoch), s: xs.flatMap(x => x.s).sort((a, c) => a.epoch - c.epoch) });

beforeAll(async () => { await migrate(); });

describe('capacity', () => {
  it('BC-1 a 4 h discharge at 2 kW using 33.3 points of charge measures 24 kWh a full charge', () => {
    const { b, s } = evening('2026-10-01', { hours: 4, kw: 2, s0: 90, full: 24 });
    expect(measurements(b, s)).toMatchObject([{ day: '2026-10-01', hours: 4, kwh: 8, drop: 33.3, fullKwh: 24 }]);
  });
  it('BC-2 too short, too shallow, or interrupted by charging: not measured', () => {
    expect(measurements(...Object.values(evening('2026-10-01', { hours: 1.5, kw: 5, s0: 90, full: 24 })) as [Bucket[], SoePoint[]])).toEqual([]);     // 1.5 h
    expect(measurements(...Object.values(evening('2026-10-01', { hours: 3, kw: 1, s0: 90, full: 24 })) as [Bucket[], SoePoint[]])).toEqual([]);       // 12.5 points
    const { b, s } = evening('2026-10-01', { hours: 4, kw: 2, s0: 90, full: 24 });
    b[24] = { ...b[24], charge: 300, discharge: 0 };                                                                                                     // 2 h in, a charging bucket
    expect(measurements(b, s)).toEqual([]);
  });
  it('BC-3 pooled over 90 days once there are 5; months pooled; nameplate until then; models get measured ÷ 95%', () => {
    const days = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'], ms = measurements(...Object.values(join(days.map(d => evening(d, { hours: 4, kw: 2, s0: 90, full: 24 })))) as [Bucket[], SoePoint[]]);
    const four = summarize(ms, 27, NOW);
    expect([four.measuredKwh, four.count, modelKwh(four, 27)]).toEqual([null, 4, 27]);
    const five = summarize([...ms, ...measurements(...Object.values(evening('2026-10-02', { hours: 6, kw: 2, s0: 95, full: 25 })) as [Bucket[], SoePoint[]])], 27, NOW);
    expect(five.measuredKwh).toBe(24.3);                                                     // (8 × 4 + 12) / (33.3 × 4 + 48) × 100: the long one weighs more
    expect(five.months).toEqual([{ month: '2026-09', kwh: 24, n: 4 }, { month: '2026-10', kwh: 25, n: 1 }]);
    expect(five.range).toEqual([24, 24]);                                                       // a month with fewer than 3 measurements stays out of the range
    expect(modelKwh(five, 27)).toBe(25.58);
    expect(usableKwh(100, modelKwh(five, 27))).toBeCloseTo(24.3, 1);                         // a full charge in the outage view = the measured figure
  });
  it('BC-4 a month 5% or more below the year shows a fade note (3 or more measurements that month)', () => {
    const year = ['2026-06-02', '2026-06-09', '2026-06-16', '2026-07-01', '2026-07-08', '2026-07-15', '2026-08-01', '2026-08-08'].map(d => evening(d, { hours: 4, kw: 2, s0: 90, full: 25 }));
    const late = ['2026-09-01', '2026-09-08', '2026-09-15'].map(d => evening(d, { hours: 4, kw: 2, s0: 90, full: 22.5 }));
    const c = summarize(measurements(...Object.values(join([...year, ...late])) as [Bucket[], SoePoint[]]), 27, NOW);
    expect(c.fade).toEqual({ month: '2026-09', pct: 7 });                                     // the year (24.26, September included) vs 22.5
  });
  it('BC-5 nightly: reads energy and soe, stores the summary in kv', async () => {
    const d = join(['2026-09-20', '2026-09-23', '2026-09-26', '2026-09-29', '2026-10-02'].map(x => evening(x, { hours: 4, kw: 2, s0: 90, full: 24 })));
    await q(`INSERT INTO sites (id, name, info) VALUES ('cap', 'Home', '{"nameplate_energy": 27000}'::jsonb) ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, charge_wh, discharge_wh) SELECT 'cap', e::text, e, '2026-10-01', 18, 0, w FROM unnest($1::bigint[], $2::real[]) AS u(e, w)`, [d.b.map(x => x.epoch), d.b.map(x => x.discharge)]);
    await q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) SELECT 'cap', e::text, e, '2026-10-01', 18, v FROM unnest($1::bigint[], $2::real[]) AS u(e, v)`, [d.s.map(x => x.epoch), d.s.map(x => x.soe)]);
    expect(await refreshCapacity('cap', NOW)).toEqual({ measuredKwh: 24, count: 5, countAll: 5 });
    expect((await capacityOf('cap'))?.nameplateKwh).toBe(27);
    expect(await capacityOf('none')).toBeNull();
  });
});
