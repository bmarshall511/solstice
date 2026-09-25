// The PEC tariff behind every dollar figure. It is learned only from parsed bills: there is no built-in rate, so until a bill
// has been parsed every cost is null (the kWh figures stay) and the app shows the rate as unknown.
import { listBills, type Bill, type Tariff } from './bills.js';

/** Sent with null costs so the client can say why. */
export const NO_TARIFF = 'no bill parsed';

/** The tariff of the newest bill that carries one (bills are listed oldest first), or null when none does. */
export function latestTariff(bills: ReadonlyArray<Pick<Bill, 'tariff'>>): Tariff | null {
  for (let i = bills.length - 1; i >= 0; i--) {
    const t = bills[i].tariff;
    if (t && Number.isFinite(t.importRateAllIn) && t.importRateAllIn > 0) return t;
  }
  return null;
}

/** The one source of rates for a site: the tariff learned from its newest parsed bill, or null. */
export const currentTariff = async (siteId: string): Promise<Tariff | null> => latestTariff(await listBills(siteId));

/** Dollars for `kwh` at `rate` (whole dollars, or to the cent), or null when the rate is unknown. */
export function usd(kwh: number, rate: number | null | undefined, cents = false): number | null {
  if (rate == null) return null;
  return cents ? Math.round(kwh * rate * 100) / 100 : Math.round(kwh * rate);
}

/** Net PEC energy cost in whole dollars: imports at the all-in rate less the export credit; null without a tariff. */
export function netEnergyCost(tariff: Pick<Tariff, 'importRateAllIn' | 'exportCredit'> | null, importKwh: number, exportKwh: number): number | null {
  return tariff ? Math.round(importKwh * tariff.importRateAllIn - exportKwh * (tariff.exportCredit ?? 0)) : null;
}
