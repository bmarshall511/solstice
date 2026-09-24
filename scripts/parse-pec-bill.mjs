// Parse a Pedernales Electric Cooperative (PEC) bill PDF into structured JSON.
// Usage: node scripts/parse-pec-bill.mjs <bill.pdf> [...more.pdf]   → writes data/bills/<bill-date>.json
// Requires `pdftotext` (poppler). Everything stays on this machine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const money = s => s == null ? null : Number(s.replace(/[$,]/g, ''));
const num = s => s == null ? null : Number(s.replace(/,/g, ''));
const isoDate = s => { if (!s) return null; const [m, d, y] = s.split('/'); return `${y.length === 2 ? '20' + y : y}-${m}-${d}`; };

export function parsePecBill(text) {
  const lines = text.split('\n');
  const find = re => { for (const l of lines) { const m = l.match(re); if (m) return m; } return null; };

  const bill = {
    utility: 'PEC',
    billDate: isoDate(find(/Bill Date:\s+(\d\d\/\d\d\/\d{4})/)?.[1]),
    dueDate: isoDate(find(/(?:Bank Draft on|Due Date:?)\s+(\d\d\/\d\d\/\d{4})/i)?.[1]),
    account: find(/Account #:\s+(\d+)/)?.[1] ?? null,
    meters: [], charges: [], total: null,
  };

  // Meter register lines: meter, from, to, days, previous, present, multiplier, usage, Delivered|Received
  for (const l of lines) {
    const m = l.match(/^\s*(\d+)\s+(\d\d\/\d\d\/\d\d)\s+(\d\d\/\d\d\/\d\d)\s+(\d+)\s+([\d,]+)\s+([\d,]+)\s+(\d+)\s+([\d,]+)\s+(Delivered|Received)/);
    if (m) bill.meters.push({ meter: m[1], from: isoDate(m[2]), to: isoDate(m[3]), days: +m[4], previous: num(m[5]), present: num(m[6]),
      multiplier: +m[7], kwh: num(m[8]), register: m[9].toLowerCase() });
  }
  const reg = r => bill.meters.find(x => x.register === r);
  bill.period = reg('delivered') ? { from: reg('delivered').from, to: reg('delivered').to, days: reg('delivered').days } : null;
  bill.deliveredKwh = reg('delivered')?.kwh ?? null;   // bought from PEC
  bill.receivedKwh = reg('received')?.kwh ?? null;     // sent to PEC

  // Line items (right-hand column): "<Label …Charge|Credit|Fee>  [<n> kWh @ $rate]  $amount"
  for (const l of lines) {
    const m = l.match(/([A-Z][A-Za-z .&-]+?(?:Charge|Credit|Fee))\s+(?:([\d,]+) kWh @ (-?\$[\d.]+)\s+)?(-?\$[\d,]+\.\d\d)\s*$/);
    if (m) bill.charges.push({ label: m[1].trim(), kwh: num(m[2]), rate: money(m[3]), amount: money(m[4]) });
  }
  bill.total = money(find(/Current Charges\s+(-?\$[\d,]+\.\d\d)/)?.[1]);

  // Derived tariff: per-kWh import price, export credit, fixed charge, franchise %
  const per = bill.charges.filter(c => c.rate != null && c.rate > 0);
  const fee = bill.charges.find(c => /Franchise Fee/.test(c.label));
  const preFee = bill.charges.filter(c => c.amount > 0 && c !== fee).reduce((a, c) => a + c.amount, 0);
  bill.tariff = {
    importRate: +per.reduce((a, c) => a + c.rate, 0).toFixed(6),
    exportCredit: bill.charges.find(c => c.rate != null && c.rate < 0) ? -bill.charges.find(c => c.rate != null && c.rate < 0).rate : null,
    fixedMonthly: bill.charges.find(c => /Service Availability/.test(c.label))?.amount ?? null,
    discounts: bill.charges.filter(c => c.rate == null && c.amount < 0).reduce((a, c) => a + c.amount, 0),
    franchisePct: fee && preFee ? +(fee.amount / preFee).toFixed(4) : null,
  };
  bill.tariff.importRateAllIn = bill.tariff.franchisePct != null ? +(bill.tariff.importRate * (1 + bill.tariff.franchisePct)).toFixed(5) : bill.tariff.importRate;

  // Front-page comparison block (best effort)
  const i = lines.findIndex(l => /Total energy use\s+Total energy use/.test(l));
  if (i >= 0) {
    const pair = lines.slice(i + 1, i + 10).map(l => l.match(/([\d,]{3,})\s+([\d,]{3,})\s*$/)).find(Boolean);
    const dollars = lines.slice(i + 1, i + 12).map(l => l.match(/\$([\d,.]+)\s+\$([\d,.]+)\s*$/)).find(Boolean);
    const j = lines.findIndex((l, k) => k > i + 3 && /this month last year/.test(l));
    const ly = j >= 0 ? lines.slice(j + 1, j + 10).map(l => l.match(/([\d,]{3,})\s+(\d{1,3})\s*$/)).find(Boolean) : null;
    const lyD = j >= 0 ? lines.slice(j + 1, j + 14).map(l => l.match(/\$([\d,.]+)\s+(\d{1,3})\D?\s*$/)).find(Boolean) : null;
    bill.comparison = { thisMonthKwh: num(pair?.[1]), lastMonthKwh: num(pair?.[2]), thisMonthCost: money(dollars?.[1]), lastMonthCost: money(dollars?.[2]),
      lastYearKwh: num(ly?.[1]), avgDailyKwh: ly ? +ly[2] : null, lastYearCost: money(lyD?.[1]), avgTempF: lyD ? +lyD[2] : null };
  }

  // Self-checks
  const sum = +bill.charges.reduce((a, c) => a + c.amount, 0).toFixed(2);
  bill.checks = {
    lineItemsSumToTotal: bill.total != null && Math.abs(sum - bill.total) < .02,
    registersConsistent: bill.meters.every(m => (m.present - m.previous) * m.multiplier === m.kwh),
  };
  return bill;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(new URL('../data/bills/', import.meta.url), { recursive: true });
  for (const f of process.argv.slice(2)) {
    const bill = parsePecBill(execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }));
    bill.source = basename(f);
    const out = new URL(`../data/bills/${bill.billDate}.json`, import.meta.url);
    writeFileSync(out, JSON.stringify(bill, null, 2));
    console.log(`${bill.billDate}  ${bill.period?.from}→${bill.period?.to}  bought ${bill.deliveredKwh} kWh · sent ${bill.receivedKwh} kWh · $${bill.total}` +
      `  | import $${bill.tariff.importRateAllIn}/kWh all-in · export credit $${bill.tariff.exportCredit} · fixed $${bill.tariff.fixedMonthly}` +
      `  | checks ${JSON.stringify(bill.checks)}`);
  }
}
