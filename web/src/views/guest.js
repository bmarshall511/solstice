// What a guest sees where the owner sees dollars (share view, mockups/q-share.html frames 2 and 4). Everything here is built
// from data a guest already receives (kWh, %, dates); dollar slots are veils and money-only cards are locked.
import { $, niceDate, localDate } from '../lib/util.js';
import { api } from '../lib/api.js';
import { veil, lockCard, cardOf, skWaterfall, skCycle, skMonthly, skLines, nameMid } from '../lib/frost.js';

const n0 = v => Math.round(v).toLocaleString('en-US');

/** A guest's bill skeleton (month, period, kWh bought and sent, whether the meter matched Tesla), filled in with Tesla's
 *  own kWh for the same dates from /api/daily, so the bill check and the meter chart read as they do for the owner. */
export function fillGuestBill(row, daily) {
  if (!Array.isArray(daily) || !row.period?.from || !row.period?.to) return row;
  const sum = (from, to) => {
    const d = daily.filter(x => x.date >= from && x.date < to); if (!d.length) return null;
    const t = k => Math.round(d.reduce((a, x) => a + (x[k] ?? 0), 0) * 10) / 10;
    return { days: d.length, solarKwh: t('solar'), homeKwh: t('home'), importKwh: t('import'), exportKwh: t('export'), chargeKwh: t('charge'), dischargeKwh: t('discharge') };
  };
  const tesla = sum(row.period.from, row.period.to); if (!tesla) return row;
  const yearAgo = d => `${+d.slice(0, 4) - 1}${d.slice(4)}`, ly = sum(yearAgo(row.period.from), yearAgo(row.period.to));
  const billed = row.pec.deliveredKwh, sent = row.pec.receivedKwh ?? 0;
  const gap = billed && tesla.importKwh != null ? Math.round((tesla.importKwh - billed) / billed * 1000) / 10 : null;
  return { ...row, tesla,
    lastYear: ly && ly.days >= (row.period.days ?? 0) - 1 ? ly : null,          // only a whole year-ago window compares
    coverage: row.period.days ? Math.round(tesla.days / row.period.days * 100) / 100 : 1, importGapPct: gap,
    solarShareOfHome: tesla.homeKwh ? Math.round((tesla.homeKwh - tesla.importKwh) / tesla.homeKwh * 100) : null,
    checks: [
      { id: 'meter', ok: row.checks.find(c => c.id === 'meter')?.ok ?? true, label: 'Meter matches Tesla',
        detail: gap == null ? '' : `PEC billed ${n0(billed)} kWh and Tesla measured ${n0(tesla.importKwh)} kWh, ${Math.abs(gap)}% apart.` },
      { id: 'export', ok: Math.abs(tesla.exportKwh - sent) <= Math.max(5, sent * .05), label: 'Export credit applied',
        detail: `${n0(sent)} kWh sent on the bill, ${n0(tesla.exportKwh)} kWh measured by Tesla.` },
    ] };
}

/** History: the three money cards, locked at the owner card's height. */
export function lockBillCards(S, last) {
  const name = S.ownerName, el = last ? Math.max(1, (Date.parse(localDate()) - Date.parse(last.period.to)) / 864e5) : 0;
  lockCard(cardOf('waterfall'), { sub: last ? `${niceDate(last.period.from)} – ${niceDate(last.period.to)}` : '', body: skWaterfall(), reason: `Bill dollars stay with ${nameMid(name)}.`, name });
  lockCard(cardOf('cycBar'), { sub: last ? `day ${Math.round(el)} of ~31` : '', body: skCycle(el / 31 * 100), reason: `The projected bill stays with ${nameMid(name)}.`, name });
  lockCard(cardOf('billChart'), { sub: 'Tesla usage × PEC rates', body: skMonthly(), reason: `Monthly dollars stay with ${nameMid(name)}.`, name });
}

/** Insights › Planner for a guest: the sliders still replay a year of real data on the server, so kWh, coverage, full-battery
 *  days and backup hours stay; every cost is veiled, the recommendation is the kWh-only version and "Your system so far" is locked. */
export async function guestPlan(S, r, q) {
  const B = r.baseline, U = r.upgraded, k = v => (v >= 1000 ? (v / 1000).toFixed(1) + ' MWh' : Math.round(v) + ' kWh');
  $('aPvS').innerHTML = q.panels ? `${r.panels + q.panels} panels · roughly ${veil('$•.•k')} (assumes ${r.assumptions.panelW} W modules)` : `Today: ${r.panels} × ${r.panelWdc} W SunPower · ${r.kwpNow} kW DC`;
  $('aPwS').innerHTML = q.powerwalls ? `${2 + q.powerwalls} Powerwalls · ${27 + q.powerwalls * 13.5} kWh · roughly ${veil('$••.•k')}` : 'Today: 2 × Powerwall 2 · 27 kWh';
  const row = (label, a, b, f, better) => { const d = b - a, cls = Math.abs(d) < 1e-6 ? '' : (better === 'up' ? d > 0 : d < 0) ? 'up' : 'dn'; return `<span>${label}</span><span class="n">${f(a)}</span><b class="${cls}">${f(b)}</b>`; };
  $('planTiles').innerHTML = `<div class="stat"><small>Covered by solar + battery</small><b class="${U.selfPowered > B.selfPowered ? 'up' : ''}">${B.selfPowered}% → ${U.selfPowered}%</b></div><div class="stat"><small>PEC energy cost / yr</small><b>${veil('$•,•••')} → ${veil('$•,•••')}</b></div>
    <div class="stat"><small>Payback</small><b>${veil('•• yrs')}</b></div><div class="stat"><small>Days batteries full</small><b class="${U.batteryFullDays > B.batteryFullDays ? 'up' : ''}">${B.batteryFullDays} → ${U.batteryFullDays}</b></div>`;
  $('cmp').innerHTML = `<span class="hd">Last 12 months</span><span class="hd">As built</span><span class="hd">With it</span>` +
    row('Solar produced', B.solarKwh, U.solarKwh, k, 'up') + row('Covered by solar + battery', B.selfPowered, U.selfPowered, v => v + '%', 'up') +
    row('Bought from PEC', B.importKwh, U.importKwh, k, 'dn') + row('Sent to PEC', B.exportKwh, U.exportKwh, k, 'up') +
    `<span>PEC energy cost</span><span class="n">${veil('$•,•••')}</span><b>${veil('$•,•••')}</b>` + row('Days batteries hit 100%', B.batteryFullDays, U.batteryFullDays, v => v, 'up') +
    `<span>Est. installed cost</span><span class="n">—</span><b>${q.panels || q.powerwalls ? veil('$•.•k') : '—'}</b>` +
    `<span>Saves per year</span><span class="n">—</span><b>${veil('$•••')}</b><span>Payback</span><span class="n">—</span><b>${veil('•• yrs')}</b>`;
  $('planFine').innerHTML = `Replays ${r.days} days of real 5-minute data. Hardware prices are generic placeholders (${veil('$•.••')}/W for panels, ${veil('$••.•k')} per Powerwall). The PEC rate is private to ${nameMid(S.ownerName)}, so cost rows are veiled.`;
  lockCard(cardOf('sysPay'), { body: skLines(), reason: `What the system cost and saves stays with ${nameMid(S.ownerName)}.`, name: S.ownerName });
  const [pv, pw] = await Promise.all([api.whatif({ panels: 8, extra: q.extra }), api.whatif({ powerwalls: 1, extra: q.extra })]).catch(() => [null, null]);
  $('planRec').innerHTML = pv && pw ? `<b>For this home, panels beat batteries.</b> 8 more panels would cover ${pv.upgraded.selfPowered}% of home use instead of ${pv.baseline.selfPowered}%, ` +
    `and cut about ${n0(Math.round((pv.baseline.importKwh - pv.upgraded.importKwh) / 100) * 100)} kWh a year from PEC. Another Powerwall adds little, because today's batteries only reach full on ${pw.baseline.batteryFullDays} days a year, so there's rarely any surplus to store. ` +
    `Extra batteries would mainly buy outage time: about ${pw.backupHoursEvening.upgraded} h of evening backup instead of ${pw.backupHoursEvening.now} h.` : '';
}
