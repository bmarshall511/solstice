import { db } from './db.ts';
import { listBills } from './bills.ts';

const addYears = (d: string, n: number) => `${+d.slice(0, 4) + n}${d.slice(4)}`;

/** Tesla-measured totals for a local date window [from, to). */
export function teslaTotals(from: string, to: string) {
  const t = db.prepare(`SELECT COUNT(DISTINCT substr(ts,1,10)) days, SUM(solar_wh) solar, SUM(home_wh) home, SUM(import_wh) imp,
    SUM(export_wh) exp, SUM(charge_wh) chg, SUM(discharge_wh) dis FROM energy WHERE substr(ts,1,10) >= ? AND substr(ts,1,10) < ?`).get(from, to) as Record<string, number | null>;
  const kwh = (wh: number | null) => (wh == null ? null : Math.round(wh / 100) / 10);
  return { days: t.days ?? 0, solarKwh: kwh(t.solar), homeKwh: kwh(t.home), importKwh: kwh(t.imp), exportKwh: kwh(t.exp), chargeKwh: kwh(t.chg), dischargeKwh: kwh(t.dis) };
}

/** Compare each bill's meter registers with Tesla's measured energy over the same dates, and with the same dates last year. */
export function reconcile() {
  return listBills().map(bill => {
    const tesla = teslaTotals(bill.period.from, bill.period.to);
    const lastYear = teslaTotals(addYears(bill.period.from, -1), addYears(bill.period.to, -1));
    const gap = (billed: number | null, measured: number | null) => (billed && measured != null ? Math.round((measured - billed) / billed * 1000) / 10 : null);
    const importGapPct = gap(bill.deliveredKwh, tesla.importKwh);
    const checks = [
      { id: 'meter', ok: importGapPct == null || Math.abs(importGapPct) <= 5, label: 'Meter matches Tesla',
        detail: tesla.importKwh == null ? 'No Tesla data for these dates yet.' : `PEC billed ${bill.deliveredKwh} kWh bought; Tesla measured ${Math.round(tesla.importKwh)} kWh (${importGapPct! > 0 ? '+' : ''}${importGapPct}%).` },
      { id: 'export', ok: tesla.exportKwh == null || Math.abs((tesla.exportKwh ?? 0) - bill.receivedKwh) <= Math.max(5, bill.receivedKwh * .05), label: 'Export credit complete',
        detail: `PEC credited ${bill.receivedKwh} kWh sent; Tesla measured ${tesla.exportKwh == null ? '—' : Math.round(tesla.exportKwh)} kWh.` },
      { id: 'math', ok: bill.checks?.lineItemsSumToTotal !== false, label: 'Bill adds up', detail: `Line items sum to $${bill.total.toFixed(2)}.` },
    ];
    return {
      billDate: bill.billDate, period: bill.period, total: bill.total, tariff: bill.tariff, charges: bill.charges,
      pec: { deliveredKwh: bill.deliveredKwh, receivedKwh: bill.receivedKwh, lastYearKwh: bill.comparison?.lastYearKwh ?? null },
      tesla, lastYear, coverage: Math.round(tesla.days / bill.period.days * 100) / 100, importGapPct, checks,
      solarShareOfHome: tesla.homeKwh ? Math.round((tesla.homeKwh - (tesla.importKwh ?? 0)) / tesla.homeKwh * 100) : null,
      withoutSolarCost: tesla.homeKwh != null && bill.tariff.fixedMonthly != null
        ? Math.round((bill.tariff.fixedMonthly + bill.tariff.discounts + tesla.homeKwh * bill.tariff.importRateAllIn) * 100) / 100 : null,
    };
  });
}
