// B2-14: three small fixes, each pinned. Synthetic data only, PGlite.
//   L-33 pool lights / blower / UV integrated over the real gap between reads (at most 60 min), not 10 minutes
//   L-23 the billing-cycle projection: complete days only, from the day after the bill, over the bill's own length
//   L-26 the trip report: savings may be negative; the empty-house AC holds the Nest's real Eco setpoint
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { poolKwhBetween, CIRCUIT_HOLD_MS } from '../../server/src/appliances/pool.js';
import { daySpans } from '../../server/src/flows.js';
import { cycleProjection } from '../../server/src/learn/nightly.js';
import { buildReport, ecoCoolF, type ReportInput } from '../../server/src/vacation/report.js';
import { localAt, addDays, localMidnight } from '../../server/src/tesla/client.js';

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({ configured: () => false, readPool: vi.fn(), writePoolPlan: vi.fn(), withUnit: vi.fn() }));
beforeAll(migrate);

describe('L-33: pool lights over the real read gap', () => {
  it('SF-1 lights on 20:00–23:00 outside pump hours, read hourly: 3 h counted (it was 30 min); a longer gap stops at 60 min', async () => {
    const D = '2026-09-15', loads = { '3': 500 };
    // hourly reads at :05, the pump off, the lights (circuit 3) on from the 20:05 read to the 23:05 one
    const reads = [19, 20, 21, 22, 23].map(h => ({ ts: localAt(D, h) + 5 * 60_000, h, on: h >= 20 && h < 23 }));
    for (const r of reads) await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm, circuits) VALUES ('pf', $1, $2, $3, false, 0, 0, $4)`, [r.ts, D, r.h, JSON.stringify(r.on ? [3] : [])]);
    const spans = daySpans(D, D, localMidnight(addDays(D, 1)).getTime() + 1);
    expect(CIRCUIT_HOLD_MS).toBe(3600e3);
    expect((await poolKwhBetween('pf', spans, { pool: { loads, uv: false } })).kwh).toBe(1.5);   // 3 h × 0.5 kW
    // a read missed at 21:05: the 20:05 reading holds for at most 60 min, so 2 h of the 3 count
    await q(`DELETE FROM pool_readings WHERE site_id = 'pf' AND hour = 21`);
    expect((await poolKwhBetween('pf', spans, { pool: { loads, uv: false } })).kwh).toBe(1);
  });
});

describe('L-23: the billing-cycle projection', () => {
  const bill = { to: '2026-09-10', days: 30 };
  const daily = Array.from({ length: 12 }, (_, i) => ({ day: addDays('2026-09-10', i), imp: 10, exp: 1 }));   // 9/10 (the old cycle) … 9/21
  it('SF-2 day 1 after the bill: no complete day, no projection (it used to read the old day plus today\'s part)', () => {
    expect(cycleProjection(bill, daily, '2026-09-11')).toEqual({ why: 'the cycle has no complete day yet' });
  });
  it('SF-3 complete days only, from the day after the bill, over the bill\'s own 30 days', () => {
    const p = cycleProjection(bill, [...daily, { day: '2026-09-15', imp: 99, exp: 0 }].filter((r, i, a) => a.findIndex(x => x.day === r.day) === i), '2026-09-15') as any;
    // 9/11–9/14 complete: 4 days × 10 kWh; today's 9/15 isn't counted
    expect(p).toEqual({ model: 'bill.cycleImport', day: '2026-10-10', horizon: 25, value: 300, inputs: { from: '2026-09-11', to: '2026-10-10', elapsedDays: 4, importSoFar: 40, exportSoFar: 4 } });
    expect((cycleProjection({ to: '2026-09-10', days: 0 }, daily, '2026-09-15') as any).value).toBe(310);   // no parsed length: 31 days
    expect(cycleProjection(bill, daily, '2026-10-12')).toEqual({ why: 'the cycle has ended; waiting for its bill' });
  });
});

describe('L-26: the trip report counterfactual', () => {
  const T0 = localAt('2026-07-01', 0), END = T0 + 2 * 864e5;
  const temps: Record<string, number> = {};
  for (let t = T0; t < END; t += 3600e3) temps[new Date(t).toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 13).replace(' ', 'T')] = 95;
  const base = (o: Partial<ReportInput> = {}): ReportInput => ({ from: T0, to: END, energy: Array.from({ length: 576 }, (_, i) => ({ epoch: T0 + i * 300_000, homeWh: 100 })),
    nest: [], pool: [], acKw: 3, uv: false, temps, model: { k: .1, delta: 9, days: 10 }, poolNormalKwhDay: 2, homeFit: null, highs: {}, homeBaseKw: null,
    trip: { backAt: END, data: {} }, alerts: 0, ...o });
  it('SF-4 the empty-house AC holds the Nest\'s Eco setpoint; 82° only when it isn\'t known', () => {
    const at82 = buildReport(base()), at78 = buildReport(base({ ecoF: 78 }));
    const ac = (r: ReturnType<typeof buildReport>) => r.parts.find(p => p.id === 'ac')!.empty;
    expect(ac(at82)).toBeCloseTo(.1 * (95 - 73) * 48, 0);                                   // k × (95 − (82 − 9)) × 48 h
    expect(ac(at78)).toBeCloseTo(.1 * (95 - 69) * 48, 0);
    expect([at82.ecoCoolF, at78.ecoCoolF]).toEqual([82, 78]);
  });
  it('SF-5 savings can be negative: Vacation mode used more than the empty house would have (it was floored at 0)', () => {
    // a cool trip (no AC either way); the pool's normal plan is 4 kWh a day, or 0 (it would have been off)
    const cool = Object.fromEntries(Object.keys(temps).map(k => [k, 60]));
    const r = buildReport(base({ temps: cool, pool: [{ ts: T0, running: true, watts: 1000 }, { ts: T0 + 20 * 60_000, running: false, watts: 0 }] }));
    expect(r.parts.find(p => p.id === 'pool')).toMatchObject({ used: .3, empty: 4 });
    const energy = Array.from({ length: 576 }, (_, i) => ({ epoch: T0 + i * 300_000, homeWh: i % 2 ? 100 : 200 }));   // so "everything else" has room
    const big = buildReport(base({ temps: cool, energy, poolNormalKwhDay: 0, pool: [{ ts: T0, running: true, watts: 1000 }, { ts: T0 + 20 * 60_000, running: false, watts: 0 }] }));
    expect(big.parts.find(p => p.id === 'pool')).toMatchObject({ used: .3, empty: 0 });       // was max(used, normal) = 0.3
    expect(big.savedKwh).toBe(-.3);                                                         // the pool's 20 minutes, which an empty house wouldn't have run
    expect(big.savedKwh).toBeCloseTo(big.emptyKwh - big.usedKwh, 1);
  });
  it('SF-6 the Eco setpoint comes from kv nest:last, when sane', async () => {
    await kv.set('nest:last', { ecoCoolF: 79.7 }); expect(await ecoCoolF()).toBe(79.5);
    await kv.set('nest:last', { ecoCoolF: null }); expect(await ecoCoolF()).toBeNull();
    await kv.set('nest:last', { ecoCoolF: 140 }); expect(await ecoCoolF()).toBeNull();
    await kv.set('nest:last', null);
  });
});
