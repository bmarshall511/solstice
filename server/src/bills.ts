import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import { db } from './db.ts';

export type Charge = { label: string; kwh: number | null; rate: number | null; amount: number };
export type Bill = {
  utility: string; billDate: string; dueDate: string | null;
  period: { from: string; to: string; days: number };
  deliveredKwh: number; receivedKwh: number; total: number;
  charges: Charge[];
  meters?: Array<Record<string, unknown>>;
  tariff: { importRate: number; importRateAllIn: number; exportCredit: number | null; fixedMonthly: number | null; discounts: number; franchisePct: number | null };
  comparison?: { thisMonthKwh: number | null; lastMonthKwh: number | null; lastYearKwh: number | null; avgDailyKwh: number | null; lastYearCost: number | null; avgTempF: number | null };
  checks?: { lineItemsSumToTotal: boolean; registersConsistent: boolean };
  source?: string;
};

const money = (s?: string) => (s == null ? null : Number(s.replace(/[$,]/g, '')));
const num = (s?: string) => (s == null ? null : Number(s.replace(/,/g, '')));
const isoDate = (s?: string) => { if (!s) return null; const [m, d, y] = s.split('/'); return `${y.length === 2 ? '20' + y : y}-${m}-${d}`; };

/** Parse the text of a PEC bill (pdftotext -layout). */
export function parsePecText(text: string): Bill {
  const lines = text.split('\n');
  const find = (re: RegExp) => { for (const l of lines) { const m = l.match(re); if (m) return m; } return null; };

  const meters: Array<{ from: string; to: string; days: number; previous: number; present: number; multiplier: number; kwh: number; register: string }> = [];
  for (const l of lines) {
    const m = l.match(/^\s*(\d+)\s+(\d\d\/\d\d\/\d\d)\s+(\d\d\/\d\d\/\d\d)\s+(\d+)\s+([\d,]+)\s+([\d,]+)\s+(\d+)\s+([\d,]+)\s+(Delivered|Received)/);
    if (m) meters.push({ from: isoDate(m[2])!, to: isoDate(m[3])!, days: +m[4], previous: num(m[5])!, present: num(m[6])!, multiplier: +m[7], kwh: num(m[8])!, register: m[9].toLowerCase() });
  }
  const delivered = meters.find(m => m.register === 'delivered'), received = meters.find(m => m.register === 'received');
  if (!delivered) throw new Error("Couldn't find the meter readings. Is this a PEC bill?");

  const charges: Charge[] = [];
  for (const l of lines) {
    const m = l.match(/([A-Z][A-Za-z .&-]+?(?:Charge|Credit|Fee))\s+(?:([\d,]+) kWh @ (-?\$[\d.]+)\s+)?(-?\$[\d,]+\.\d\d)\s*$/);
    if (m) charges.push({ label: m[1].trim(), kwh: num(m[2]), rate: money(m[3]), amount: money(m[4])! });
  }
  const total = money(find(/Current Charges\s+(-?\$[\d,]+\.\d\d)/)?.[1]);
  if (total == null) throw new Error("Couldn't find the bill total.");

  const per = charges.filter(c => c.rate != null && c.rate > 0);
  const fee = charges.find(c => /Franchise Fee/.test(c.label));
  const preFee = charges.filter(c => c.amount > 0 && c !== fee).reduce((a, c) => a + c.amount, 0);
  const credit = charges.find(c => c.rate != null && c.rate < 0);
  const importRate = +per.reduce((a, c) => a + (c.rate ?? 0), 0).toFixed(6);
  const franchisePct = fee && preFee ? +(fee.amount / preFee).toFixed(4) : null;

  let comparison: Bill['comparison'];
  const i = lines.findIndex(l => /Total energy use\s+Total energy use/.test(l));
  if (i >= 0) {
    const pair = lines.slice(i + 1, i + 10).map(l => l.match(/([\d,]{3,})\s+([\d,]{3,})\s*$/)).find(Boolean);
    const j = lines.findIndex((l, k) => k > i + 3 && /this month last year/.test(l));
    const ly = j >= 0 ? lines.slice(j + 1, j + 10).map(l => l.match(/([\d,]{3,})\s+(\d{1,3})\s*$/)).find(Boolean) : null;
    const lyD = j >= 0 ? lines.slice(j + 1, j + 14).map(l => l.match(/\$([\d,.]+)\s+(\d{1,3})\D?\s*$/)).find(Boolean) : null;
    comparison = { thisMonthKwh: num(pair?.[1]), lastMonthKwh: num(pair?.[2]), lastYearKwh: num(ly?.[1]), avgDailyKwh: ly ? +ly[2] : null, lastYearCost: money(lyD?.[1]), avgTempF: lyD ? +lyD[2] : null };
  }

  const sum = +charges.reduce((a, c) => a + c.amount, 0).toFixed(2);
  return {
    utility: 'PEC',
    billDate: isoDate(find(/Bill Date:\s+(\d\d\/\d\d\/\d{4})/)?.[1]) ?? delivered.to,
    dueDate: isoDate(find(/(?:Bank Draft on|Due Date:?)\s+(\d\d\/\d\d\/\d{4})/i)?.[1]),
    period: { from: delivered.from, to: delivered.to, days: delivered.days },
    deliveredKwh: delivered.kwh, receivedKwh: received?.kwh ?? 0, total, charges,
    meters: meters.map(({ register, from, to, previous, present, kwh }) => ({ register, from, to, previous, present, kwh })),
    tariff: { importRate, importRateAllIn: franchisePct != null ? +(importRate * (1 + franchisePct)).toFixed(5) : importRate,
      exportCredit: credit ? -(credit.rate ?? 0) : null, fixedMonthly: charges.find(c => /Service Availability/.test(c.label))?.amount ?? null,
      discounts: charges.filter(c => c.rate == null && c.amount < 0).reduce((a, c) => a + c.amount, 0), franchisePct },
    comparison,
    checks: { lineItemsSumToTotal: Math.abs(sum - total) < 0.02, registersConsistent: meters.every(m => (m.present - m.previous) * m.multiplier === m.kwh) },
  };
}

export function parsePecPdf(pdf: Buffer): Bill {
  const dir = mkdtempSync(join(tmpdir(), 'solstice-bill-'));
  try {
    const file = join(dir, 'bill.pdf');
    writeFileSync(file, pdf);
    let text: string;
    try { text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { throw new Error("That file doesn't look like a PDF. Download the bill as a PDF from SmartHub or myPEC.com."); }
    return parsePecText(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function saveBill(bill: Bill) {
  db.prepare(`INSERT OR REPLACE INTO bills VALUES (?,?,?,?,?,?,?,?)`).run(
    bill.billDate, bill.period.from, bill.period.to, bill.deliveredKwh, bill.receivedKwh, bill.total, JSON.stringify(bill), Date.now());
}

export function listBills(): Bill[] {
  return (db.prepare('SELECT raw FROM bills ORDER BY bill_date').all() as Array<{ raw: string }>).map(r => JSON.parse(r.raw) as Bill);
}

/** One-time import of bills parsed by scripts/parse-pec-bill.mjs into data/bills/. */
export function importBillFiles() {
  if (!existsSync(config.billsDir)) return;
  const have = new Set(listBills().map(b => b.billDate));
  for (const f of readdirSync(config.billsDir).filter(f => f.endsWith('.json'))) {
    const bill = JSON.parse(readFileSync(config.billsDir + f, 'utf8')) as Bill;
    if (!have.has(bill.billDate)) saveBill(bill);
  }
}
