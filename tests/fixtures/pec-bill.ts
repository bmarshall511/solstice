// A synthetic PEC bill in the shape `pdftotext -layout` (and server/src/pdf.ts) produce. Hand-written: PEC's published
// tariff numbers (0.072 energy + 0.030346 PCRF, 0.071921 DG credit, 32.50 service availability, 3.96 % franchise fee),
// meter 12345678, round usage. No service address, no account number, no name.
export const PEC_BILL = [
  'Pedernales Electric Cooperative                 Bill Date:  09/15/2026',
  '                                                 Due Date: 10/06/2026',
  '',
  'Meter        From       To        Days   Previous   Present   Mult   Usage    Register',
  '12345678     08/12/26   09/11/26   30     10,000     11,200    1      1,200    Delivered',
  '12345678     08/12/26   09/11/26   30     5,000      5,300     1      300      Received',
  '',
  'Service Availability Charge                                   $32.50',
  'Energy Charge                     1,200 kWh @ $0.072000       $86.40',
  'Power Cost Recovery Charge        1,200 kWh @ $0.030346       $36.42',
  'Distributed Generation Credit       300 kWh @ -$0.071921     -$21.58',
  'Franchise Fee                                                  $6.15',
  'Paperless Billing Credit                                      -$2.50',
  'Current Charges                                              $137.39',
  '',
  'Total energy use      Total energy use',
  '   1,200      1,350',
  '   $137.39    $151.20',
  'Average temperature',
  'This month vs. this month last year',
  '   1,500     45',
  '   $150.25   88°',
  ' kWh/Day',
].join('\n');

/** The bill with every line matching `re` removed. */
export const withoutLine = (re: RegExp, text = PEC_BILL) => text.split('\n').filter(l => !re.test(l)).join('\n');
/** The bill with one literal substring replaced (throws if it is not there, so a typo can't make a mutation a no-op). */
export const replaced = (from: string, to: string, text = PEC_BILL) => {
  if (!text.includes(from)) throw new Error(`fixture has no "${from}"`);
  return text.replace(from, to);
};
