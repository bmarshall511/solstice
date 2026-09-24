import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { config } from './config.ts';
import { db } from './db.ts';
import { localMidnight } from './tesla/client.ts';

type Bill = {
  billDate: string; total: number; deliveredKwh: number; receivedKwh: number;
  period: { from: string; to: string; days: number };
  tariff: { importRateAllIn: number; exportCredit: number | null; fixedMonthly: number | null };
  comparison?: { lastYearKwh: number | null };
};

export function loadBills(): Bill[] {
  if (!existsSync(config.billsDir)) return [];
  return readdirSync(config.billsDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(config.billsDir + f, 'utf8')) as Bill)
    .sort((a, b) => a.billDate.localeCompare(b.billDate));
}

/** Compare each bill's meter registers with Tesla's measured energy over the same dates. */
export function reconcile() {
  return loadBills().map(bill => {
    // PEC reads the meter on the "from" and "to" dates; treat the window as [from 00:00, to 00:00) local time.
    const start = localMidnight(bill.period.from).getTime(), end = localMidnight(bill.period.to).getTime();
    const t = db.prepare(`SELECT COUNT(*) buckets, COUNT(DISTINCT substr(ts,1,10)) days, SUM(solar_wh) solar, SUM(home_wh) home, SUM(import_wh) imp,
      SUM(export_wh) exp, SUM(charge_wh) chg, SUM(discharge_wh) dis FROM energy WHERE epoch >= ? AND epoch < ?`).get(start, end) as Record<string, number>;
    const kwh = (wh: number | null) => wh == null ? null : Math.round(wh / 100) / 10;
    const coverage = t.days / bill.period.days;
    const gap = (a: number | null, b: number | null) => a && b != null ? Math.round((b - a) / a * 1000) / 10 : null;
    const tesla = { solarKwh: kwh(t.solar), homeKwh: kwh(t.home), importKwh: kwh(t.imp), exportKwh: kwh(t.exp), chargeKwh: kwh(t.chg), dischargeKwh: kwh(t.dis) };
    return {
      billDate: bill.billDate, period: bill.period, total: bill.total,
      pec: { deliveredKwh: bill.deliveredKwh, receivedKwh: bill.receivedKwh, lastYearKwh: bill.comparison?.lastYearKwh ?? null },
      tesla, coverage: Math.round(coverage * 100) / 100,
      importGapPct: gap(bill.deliveredKwh, tesla.importKwh),
      exportGapPct: gap(bill.receivedKwh || null, tesla.exportKwh),
      solarShareOfHome: tesla.homeKwh ? Math.round((tesla.homeKwh - (tesla.importKwh ?? 0)) / tesla.homeKwh * 100) : null,
      withoutSolarCost: tesla.homeKwh != null && bill.tariff.fixedMonthly != null
        ? Math.round((bill.tariff.fixedMonthly + tesla.homeKwh * bill.tariff.importRateAllIn) * 100) / 100 : null,
    };
  });
}
