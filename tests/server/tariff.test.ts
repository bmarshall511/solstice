// The learned tariff (server/src/tariff.ts): rates come only from parsed bills, never from a built-in fallback. With no bill,
// every cost is null while the kWh figures stay the same: the what-if replay's cost, the pool plan and the AC plan.
// Pure: listBills is replaced with an in-memory list, so nothing here touches the database. The rates below are round
// placeholders, not PEC's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bill, Tariff } from '../../server/src/bills.js';

const store = vi.hoisted(() => ({ bills: [] as Array<Pick<Bill, 'billDate' | 'tariff'>> }));
vi.mock('../../server/src/bills.js', () => ({ listBills: vi.fn(async () => store.bills) }));

import { currentTariff, latestTariff, usd, netEnergyCost, NO_TARIFF } from '../../server/src/tariff.js';
import { planFor as poolPlan, powerModel, type PoolSettings } from '../../server/src/appliances/pool.js';
import { planFor as acPlan, type AcSettings } from '../../server/src/appliances/ac.js';

const tariff = (importRateAllIn: number, exportCredit: number | null = .05): Tariff =>
  ({ importRate: importRateAllIn, importRateAllIn, exportCredit, fixedMonthly: 30, discounts: 0, franchisePct: null });
const OLD = tariff(.1), NEW = tariff(.2, .04);

beforeEach(() => { store.bills = []; });

describe('currentTariff: the rate is learned from the newest parsed bill', () => {
  it('is null when no bill has been parsed (no built-in rate)', async () => {
    expect(await currentTariff('s')).toBeNull();
    expect(latestTariff([])).toBeNull();
    expect(NO_TARIFF).toBe('no bill parsed');
  });

  it('the newest bill wins (bills are listed oldest first)', async () => {
    store.bills = [{ billDate: '2026-07-15', tariff: OLD }, { billDate: '2026-08-15', tariff: NEW }];
    expect(await currentTariff('s')).toEqual(NEW);
  });

  it('a newest bill saved without rates falls back to the previous parsed bill, never to a constant', async () => {
    store.bills = [{ billDate: '2026-07-15', tariff: OLD }, { billDate: '2026-08-15', tariff: null }];
    expect(await currentTariff('s')).toEqual(OLD);
    store.bills = [{ billDate: '2026-08-15', tariff: null }];
    expect(await currentTariff('s')).toBeNull();
  });

  it('ignores a tariff without a usable import rate', async () => {
    store.bills = [{ billDate: '2026-07-15', tariff: OLD }, { billDate: '2026-08-15', tariff: tariff(0) }];
    expect(await currentTariff('s')).toEqual(OLD);
  });
});

describe('costs are null without a tariff, kWh unchanged', () => {
  it('usd: dollars at a learned rate, null when the rate is unknown', () => {
    expect(usd(10, null)).toBeNull();
    expect(usd(10, undefined, true)).toBeNull();
    expect(usd(12.4, .1)).toBe(1);
    expect(usd(1.234, .1, true)).toBe(.12);
  });

  it('/api/whatif replay cost (netEnergyCost): null with no tariff; imports less the export credit otherwise', () => {
    expect(netEnergyCost(null, 1200, 300)).toBeNull();
    expect(netEnergyCost(OLD, 1200, 300)).toBe(105);           // 1200 × 0.10 − 300 × 0.05
    expect(netEnergyCost(tariff(.1, null), 1200, 300)).toBe(120); // a bill with no export-credit line credits nothing
  });

  // POOL_DEFAULTS is module-private until design X2 exports it; these are the same values.
  const POOL: PoolSettings = { gallons: 14995, spaGallons: 1000, designGpm: 120, filterRpm: 1500, boostRpm: 2400, poolCircuit: 6, boostCircuit: 8, featureCircuits: [5],
    autopilot: 'suggest', uv: true, heaterBtu: 400_000, propaneUsdPerGal: 3, loads: { '2': 1100, '3': 500, '4': 100 } };
  const BELL = [0, 0, 0, 0, 0, 0, 0, .5, 1.5, 3, 4.5, 5.5, 6, 6, 5.5, 4.5, 3, 1.5, .5, 0, 0, 0, 0, 0];

  it('pool plan: costPerMonth is null, every kWh figure is what it is with a rate', () => {
    const p = (rate: number | null) => poolPlan({ waterTemp: 88, solarKw: BELL, settings: POOL, W: powerModel([]), rate, month: 8, names: new Map() });
    const known = p(.1), unknown = p(null);
    expect(unknown.costPerMonth).toBeNull();
    expect(known.costPerMonth).toBeGreaterThan(0);
    expect(unknown.kwhPerDay).toBeGreaterThan(0);
    expect(unknown).toEqual({ ...known, costPerMonth: null });
  });

  // AC DEFAULTS is module-private until design X13 exports it; these are the same values.
  const AC: AcSettings = { band: { homeLo: 74, homeHi: 78, nightLo: 74, nightHi: 76 }, awayF: 80, nightFrom: 22, nightTo: 7, precoolDepth: 2, coastF: 78, maxStepF: 2,
    humidityCap: 60, autopilot: 'suggest', presence: 'home' };
  const sun13 = Array.from({ length: 24 }, (_, h) => Math.max(0, 1 - Math.abs(h - 13) / 7));
  const ac = (rate: number | null, settings: AcSettings = AC) =>
    acPlan({ date: '2026-07-15', high: 96, sunKwhM2: 6, hourlySun: sun13, settings, acKw: 2, slope: 2.5, rate, humidity: null });

  it('AC plan: costSavedMonth is null, kwhSaved and the steps are unchanged', () => {
    const known = ac(.1), unknown = ac(null);
    expect(unknown.kwhSaved).toBeGreaterThan(0);
    expect(unknown.costSavedMonth).toBeNull();
    expect(known.costSavedMonth).toBe(Math.round(known.kwhSaved * 30.4 * .1));
    expect(unknown).toEqual({ ...known, costSavedMonth: null });
  });

  it('AC plan while away: no saving, and no dollar figure without a rate', () => {
    const away = { ...AC, presence: 'away' as const };
    expect([ac(null, away).kwhSaved, ac(null, away).costSavedMonth]).toEqual([0, null]);
    expect(ac(.1, away).costSavedMonth).toBe(0);
  });
});
