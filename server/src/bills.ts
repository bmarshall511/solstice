import { pdfToLayoutText } from './pdf.js';
import { q } from './db.js';

export type Charge = { label: string; kwh: number | null; rate: number | null; amount: number };
/** The rates read off a bill. The only source of rates in the app (see tariff.ts). */
export type Tariff = { importRate: number; importRateAllIn: number; exportCredit: number | null; fixedMonthly: number | null; discounts: number; franchisePct: number | null };
export type Bill = {
  utility: string; billDate: string; dueDate: string | null;
  period: { from: string; to: string; days: number };
  deliveredKwh: number; receivedKwh: number; total: number;
  charges: Charge[];
  meters?: Array<Record<string, unknown>>;
  tariff: Tariff | null; // null for a bill saved without parsed rates
  comparison?: { thisMonthKwh: number | null; lastMonthKwh: number | null; lastYearKwh: number | null; avgDailyKwh: number | null; lastYearCost: number | null; avgTempF: number | null };
  checks?: { lineItemsSumToTotal: boolean; registersConsistent: boolean };
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
    const m = l.match(/([A-Z][A-Za-z .&-]+?(?:Charge|Credit|Fee))\s+(?:([\d,]+)\s*kWh\s*@\s*(-?\$[\d.]+)\s+)?(-?\$[\d,]+\.\d\d)\s*$/);
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
    // the "last year" kWh and average daily use sit on the line just above the "kWh/Day" label
    const unit = j >= 0 ? lines.findIndex((l, k) => k > j && /kWh\/Day/.test(l)) : -1;
    const ly = unit > 0 ? lines.slice(j + 1, unit).reverse().map(l => l.match(/([\d,]{3,})\s+(\d{1,3})\s*$/)).find(Boolean) : null;
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

/** Read a PEC bill PDF with pure JS (works on Vercel; no poppler needed). */
export async function parsePecPdf(pdf: Uint8Array): Promise<Bill> {
  let text: string;
  try { text = await pdfToLayoutText(pdf); }
  catch { throw new Error("That file doesn't look like a PDF. Download the bill as a PDF from SmartHub or myPEC.com."); }
  return parsePecText(text);
}

/** Copy only the listed keys that are present (never adds a key, so stored shapes stay as they were). */
const pick = <T extends object>(o: T | null | undefined, keys: Array<keyof T>): T => (o == null ? o : Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]))) as T;

/** The only fields a bill keeps. Anything else a PDF, an old import or a request body carried (the PEC account number,
 *  the source file name, meter numbers) is dropped before a bill is stored, and again whenever one is read back. */
export function toStoredBill(b: Bill): Bill {
  return {
    utility: b.utility, billDate: b.billDate, dueDate: b.dueDate ?? null,
    period: pick(b.period, ['from', 'to', 'days']),
    deliveredKwh: b.deliveredKwh, receivedKwh: b.receivedKwh, total: b.total,
    charges: (b.charges ?? []).map(c => pick(c, ['label', 'kwh', 'rate', 'amount'])),
    tariff: pick(b.tariff, ['importRate', 'importRateAllIn', 'exportCredit', 'fixedMonthly', 'discounts', 'franchisePct']),
    ...(b.comparison ? { comparison: pick(b.comparison, ['thisMonthKwh', 'lastMonthKwh', 'lastYearKwh', 'avgDailyKwh', 'lastYearCost', 'avgTempF']) } : {}),
    ...(b.checks ? { checks: pick(b.checks, ['lineItemsSumToTotal', 'registersConsistent']) } : {}),
    ...(Array.isArray(b.meters) ? { meters: b.meters.map(m => pick(m, ['register', 'from', 'to', 'previous', 'present', 'kwh'])) } : {}),
  };
}

export async function saveBill(siteId: string, input: Bill) {
  const bill = toStoredBill(input);
  await q(`INSERT INTO bills (site_id, bill_date, period_from, period_to, delivered_kwh, received_kwh, total, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (site_id, bill_date) DO UPDATE SET period_from=excluded.period_from, period_to=excluded.period_to, delivered_kwh=excluded.delivered_kwh,
      received_kwh=excluded.received_kwh, total=excluded.total, raw=excluded.raw`,
    [siteId, bill.billDate, bill.period.from, bill.period.to, bill.deliveredKwh, bill.receivedKwh, bill.total, JSON.stringify(bill)]);
}

export async function listBills(siteId: string): Promise<Bill[]> {
  return (await q<{ raw: Bill }>('SELECT raw FROM bills WHERE site_id = $1 ORDER BY bill_date', [siteId])).map(r => toStoredBill(r.raw));
}
