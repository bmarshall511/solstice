// The PEC bill parser: design §8, cases 25–26. pdf.js is globally mocked in this project; parsePecText takes the
// layout text the PDF step produces. Until the pec.ts extraction (X1) lands this imports bills.js.
import { describe, it, expect } from 'vitest';
import { parsePecText } from '../../server/src/bills.js';
import { PEC_BILL, withoutLine, replaced } from '../fixtures/pec-bill.js';

describe('parsePecText', () => {
  it('25: reads dates, registers, total, charges, tariff and the comparison block', () => {
    const b = parsePecText(PEC_BILL);
    expect(b.utility).toBe('PEC');
    expect([b.billDate, b.dueDate]).toEqual(['2026-09-15', '2026-10-06']);
    expect(b.period).toEqual({ from: '2026-08-12', to: '2026-09-11', days: 30 });
    expect([b.deliveredKwh, b.receivedKwh, b.total]).toEqual([1200, 300, 137.39]);
    expect(b.charges).toEqual([
      { label: 'Service Availability Charge', kwh: null, rate: null, amount: 32.5 },
      { label: 'Energy Charge', kwh: 1200, rate: .072, amount: 86.4 },
      { label: 'Power Cost Recovery Charge', kwh: 1200, rate: .030346, amount: 36.42 },
      { label: 'Distributed Generation Credit', kwh: 300, rate: -.071921, amount: -21.58 },
      { label: 'Franchise Fee', kwh: null, rate: null, amount: 6.15 },
      { label: 'Paperless Billing Credit', kwh: null, rate: null, amount: -2.5 },
    ]);
    expect(b.meters).toEqual([
      { register: 'delivered', from: '2026-08-12', to: '2026-09-11', previous: 10000, present: 11200, kwh: 1200 },
      { register: 'received', from: '2026-08-12', to: '2026-09-11', previous: 5000, present: 5300, kwh: 300 },
    ]);
    expect(b.comparison).toEqual({ thisMonthKwh: 1200, lastMonthKwh: 1350, lastYearKwh: 1500, avgDailyKwh: 45, lastYearCost: 150.25, avgTempF: 88 });
    expect(b.checks).toEqual({ lineItemsSumToTotal: true, registersConsistent: true });
  });

  it('25: the derived tariff is exactly the fallback app.ts hard-codes', () => {
    expect(parsePecText(PEC_BILL).tariff).toEqual({ importRate: .102346, importRateAllIn: .1064, exportCredit: .071921, fixedMonthly: 32.5, discounts: -2.5, franchisePct: .0396 });
  });

  it('26: without the Delivered register it is not a PEC bill', () => {
    expect(() => parsePecText(withoutLine(/Delivered$/))).toThrow("Couldn't find the meter readings. Is this a PEC bill?");
  });
  it('26: without Current Charges there is no total', () => {
    expect(() => parsePecText(withoutLine(/^Current Charges/))).toThrow("Couldn't find the bill total.");
  });
  it('26: without a Bill Date the bill is dated by the end of its period', () => {
    const b = parsePecText(replaced('Bill Date:  09/15/2026', ''));
    expect(b.billDate).toBe('2026-09-11');
  });
  it('26: without a Received register nothing was sent', () => {
    expect(parsePecText(withoutLine(/Received$/)).receivedKwh).toBe(0);
  });
  it('26: an inconsistent register is flagged', () => {
    expect(parsePecText(replaced('10,000     11,200', '10,000     11,199')).checks?.registersConsistent).toBe(false);
  });
  it('26: line items must sum to the total within 2 cents', () => {
    expect(parsePecText(replaced('$137.39\n', '$137.40\n')).checks?.lineItemsSumToTotal).toBe(true);
    expect(parsePecText(replaced('$137.39\n', '$138.39\n')).checks?.lineItemsSumToTotal).toBe(false);
  });
});
