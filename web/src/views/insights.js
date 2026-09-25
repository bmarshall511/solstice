import { $, niceDate, localDate, addDays, svgText, path, ago, money } from '../lib/util.js';
import { api } from '../lib/api.js';
import { mountOutageCard } from './outage.js';
import { veil } from '../lib/frost.js';
import { guestPlan } from './guest.js';

/* ---------- alert cards ---------- */
export function drawAlerts(S) {
  const cards = [], site = S.now?.site ?? {};
  const card = (c, icon, title, when, body, link) => cards.push(`<div class="card" style="--c:${c}"><div class="ins"><div class="ic">${icon}</div><div><b>${title}</b> <time>· ${when}</time><p>${body}</p></div></div>${link ?? ''}</div>`);
  if (S.now?.health?.stale) card('var(--warn)', '⏻', 'Tesla stopped reporting', S.now.health.lastLive ? ago(S.now.health.lastLive) : 'now', 'No live data for over 3 minutes. Check the gateway Wi-Fi, or open the Tesla app to see if it can reach your Powerwalls.');
  (S.nws ?? []).slice(0, 2).forEach(a => card('var(--out)', '⛈', a.event, 'NWS', `${a.headline ?? ''}${/hail/i.test(a.description ?? '') ? ' If hail hits, check the Panels tab afterwards for any drop in output.' : ''}${site.stormWatch ? ' Storm Watch will charge the Powerwalls ahead of it.' : ''}`));
  const bad = (S.reconcile ?? []).filter(r => r.checks.some(c => !c.ok)).at(-1);
  if (bad) card('var(--grid)', '≈', 'PEC bill doesn’t match Tesla', niceDate(bad.billDate, { month: 'short' }) + ' bill', bad.checks.filter(c => !c.ok).map(c => c.detail).join(' '), '<button class="link" data-go="v-hist" data-bills="1">Open bill check →</button>');
  if (S.perf?.loss > .08) card('var(--warn)', '☀', `Solar output ${Math.round(S.perf.loss * 100)}% low`, 'last 7 clear days', 'Compared with the same sunlight this time last year. An even loss like this usually means dust or pollen.', '<button class="link" data-go="v-roof">See your panels →</button>');
  const N = S.overnight ?? [];
  if (N.length > 20) { const recent = N.slice(-7).reduce((a, n) => a + n.kw, 0) / 7, base = N.slice(-37, -7).map(n => n.kw).sort((a, b) => a - b), med = base[Math.floor(base.length / 2)];
    if (recent > med * 1.15 && recent - med > .15) card('var(--solar)', '◐', `Overnight usage up ${Math.round((recent / med - 1) * 100)}%`, '7 nights', `Your 1–5 AM average went from ${(med * 1000).toFixed(0)} W to ${(recent * 1000).toFixed(0)} W, about ${S.guest ? veil('$••') : S.tariff ? `$${((recent - med) * 24 * 30 * S.tariff.importRateAllIn / 6).toFixed(0)}` : '—'}/month if it's always-on. Nights are hotter too, so some of this may be AC.`); }
  if (S.pool?.extras?.lightReadings30d > 0) card('var(--solar)', '💡', 'Pool lights are 600 W of incandescent', 'from the plan', `The AmeriLite pool (500 W) and spa (100 W) lights cost about ${S.guest ? veil('$•.••') : S.tariff ? `$${(0.6 * S.tariff.importRateAllIn).toFixed(2)}` : '—'} an hour. LED replacements draw about a tenth of that and change colour.`);
  const D = (S.daily ?? []).slice(-30).filter(d => d.socMax != null);
  if (D.length > 10) { const full = D.filter(d => d.socMax >= 99).length;
    card('var(--batt)', '▮', full < 5 ? 'Your Powerwalls rarely fill up' : 'Powerwalls are cycling well', '30 days', full < 5
      ? `They reached 100% on only ${full} of the last ${D.length} days (typical peak ${Math.round(D.reduce((a, d) => a + d.socMax, 0) / D.length)}%). Your home uses most of the solar as it's made, so the batteries only store the small surplus. More panels would help them more than more batteries would.`
      : `They reached 100% on ${full} of the last ${D.length} days.`); }
  $('alerts').innerHTML = cards.join('');
  $('insDot').hidden = !cards.some(c => /--warn|--out|--grid/.test(c.slice(0, 60)));
}

/* ---------- what-if planner (server replays your real last 12 months) ---------- */
let t;
export function initPlanner(S) {
  const update = () => { clearTimeout(t); t = setTimeout(run, 180); };
  ['rPv', 'rPw', 'rUse'].forEach(id => $(id).addEventListener('input', update));
  update();
  async function run() {
    const q = { panels: +$('rPv').value, powerwalls: +$('rPw').value, extra: +$('rUse').value };
    $('aPv').textContent = '+' + q.panels; $('aPw').textContent = '+' + q.powerwalls; $('aUse').textContent = `+${q.extra} kWh`;
    const r = await api.whatif(q).catch(() => null); if (!r) return;
    if (S.guest) return guestPlan(S, r, q);   // no dollars for guests: the kWh-only planner (views/guest.js)
    $('aPvS').textContent = q.panels ? `${r.panels + q.panels} panels · roughly $${(q.panels * r.assumptions.panelW * 2.75 / 1000).toFixed(1)}k (assumes ${r.assumptions.panelW} W modules)` : `Today: ${r.panels} × ${r.panelWdc} W SunPower · ${r.kwpNow} kW DC`;
    $('aPwS').textContent = q.powerwalls ? `${2 + q.powerwalls} Powerwalls · ${27 + q.powerwalls * 13.5} kWh · roughly $${(q.powerwalls * 11.5).toFixed(1)}k` : 'Today: 2 × Powerwall 2 · 27 kWh';
    const B = r.baseline, U = r.upgraded, k = v => v >= 1000 ? (v / 1000).toFixed(1) + ' MWh' : Math.round(v) + ' kWh';
    const row = (label, a, b, f, better) => { const d = b - a, cls = Math.abs(d) < 1e-6 ? '' : (better === 'up' ? d > 0 : d < 0) ? 'up' : 'dn'; return `<span>${label}</span><span class="n">${f(a)}</span><b class="${cls}">${f(b)}</b>`; };
    $('planTiles').innerHTML = `<div class="stat"><small>Covered by solar + battery</small><b class="${U.selfPowered > B.selfPowered ? 'up' : ''}">${B.selfPowered}% → ${U.selfPowered}%</b></div><div class="stat"><small>PEC energy cost / yr</small><b class="${U.netCost < B.netCost ? 'up' : ''}">${money(B.netCost)} → ${money(U.netCost)}</b></div>
      <div class="stat"><small>Payback</small><b>${r.paybackYears ? r.paybackYears + ' yrs' : r.cost && r.savesPerYear != null ? 'never' : '—'}</b></div><div class="stat"><small>Days batteries full</small><b class="${U.batteryFullDays > B.batteryFullDays ? 'up' : ''}">${B.batteryFullDays} → ${U.batteryFullDays}</b></div>`;
    $('cmp').innerHTML = `<span class="hd">Last 12 months</span><span class="hd">As built</span><span class="hd">With it</span>` +
      row('Solar produced', B.solarKwh, U.solarKwh, k, 'up') + row('Covered by solar + battery', B.selfPowered, U.selfPowered, v => v + '%', 'up') +
      row('Bought from PEC', B.importKwh, U.importKwh, k, 'dn') + row('Sent to PEC', B.exportKwh, U.exportKwh, k, 'up') +
      row('PEC energy cost', B.netCost, U.netCost, money, 'dn') + row('Days batteries hit 100%', B.batteryFullDays, U.batteryFullDays, v => v, 'up') +
      `<span>Est. installed cost</span><span class="n">—</span><b>${r.cost ? '$' + (r.cost / 1000).toFixed(1) + 'k' : '—'}</b>` +
      `<span>Saves per year</span><span class="n">—</span><b class="${r.savesPerYear > 0 ? 'up' : ''}">${r.cost ? money(r.savesPerYear) : '—'}</b>` +
      `<span>Payback</span><span class="n">—</span><b>${r.paybackYears ? r.paybackYears + ' yrs' : r.cost && r.savesPerYear != null ? 'never' : '—'}</b>`;
    const pv = await api.whatif({ panels: 8, extra: q.extra }).catch(() => null), pw = await api.whatif({ powerwalls: 1, extra: q.extra }).catch(() => null);
    $('planRec').innerHTML = pv && pw ? `<b>For your home, panels beat batteries.</b> 8 more panels would save about ${money(pv.savesPerYear)} a year (${pv.paybackYears ?? '—'}-year payback). ` +
      `Another Powerwall would save about ${money(pw.savesPerYear)}, because today's batteries only reach full on ${pw.baseline.batteryFullDays} days a year, so there's rarely any surplus to store. ` +
      `Extra batteries would mainly buy outage time: about ${pw.backupHoursEvening.upgraded} h of evening backup instead of ${pw.backupHoursEvening.now} h.` : '';
    $('planFine').textContent = `Replays ${r.days} days of your real 5-minute data (as-built replay: ${k(B.importKwh)} bought vs ${k(r.actual.importKwh)} actually bought). Prices are placeholders: $2.75/W for panels, $11.5k per Powerwall, your PEC rate of ${r.assumptions.tariff ? `$${r.assumptions.tariff.importRateAllIn}/kWh and ${r.assumptions.tariff.exportCredit != null ? `$${r.assumptions.tariff.exportCredit}` : '—'}/kWh export credit` : '— (rate unknown)'}. No federal credit (it ended with 2025 installs).`;
    const s = r.system?.veiled ? null : r.system; // a guest gets { veiled: true }: no price, loan or payback
    $('sysPay').innerHTML = s ? `<b>Your system so far.</b> Without solar or Powerwalls, the last 12 months would have cost ${money(r.noSystem.netCost)} in PEC energy instead of ${money(B.netCost)}: it saves about ${money(s.savesPerYear)} a year. ` +
      `You paid $${(s.priceUsd / 1000).toFixed(1)}k${s.taxCreditPct ? ` before the ${s.taxCreditPct}% federal credit, about $${(s.netUsd / 1000).toFixed(1)}k after` : ''}${s.monthlyPayment ? `, financed over ${s.loanYears} years at ${s.loanRatePct}% (about $${s.monthlyPayment}/month)` : ''}. ` +
      (s.paybackYears ? `At today's rates that pays back in about ${s.paybackYears} years; it's ${s.yearsSinceInstall} years old now${s.paybackYears > s.yearsSinceInstall ? `, so roughly ${Math.max(0, Math.round((s.paybackYears - s.yearsSinceInstall) * 10) / 10)} years to go` : ' and already paid for itself in energy'}.` : '') : '';
  }
}

/* ---------- outage readiness: the first card on Home, above Heat & your AC (views/outage.js, mockup n-outage) ---------- */
export const initOutage = S => mountOutageCard(S, $('ip-home'));

/* ---------- AC vs heat ---------- */
export function drawAC(S) {
  // cooling season only (highs ≥ 80°F): winter heating would muddy the AC relationship
  const pts = (S.daily ?? []).map(d => ({ date: d.date, t: S.highs?.[d.date], u: d.home })).filter(p => p.t != null && p.t >= 80 && p.u > 5 && p.date < localDate());
  if (pts.length < 10) return;
  const n = pts.length, mx = pts.reduce((a, p) => a + p.t, 0) / n, my = pts.reduce((a, p) => a + p.u, 0) / n;
  const slope = pts.reduce((a, p) => a + (p.t - mx) * (p.u - my), 0) / pts.reduce((a, p) => a + (p.t - mx) ** 2, 0), icpt = my - slope * mx;
  S.acSlope = slope;
  const tMin = Math.min(...pts.map(p => p.t)) - 2, tMax = Math.max(...pts.map(p => p.t)) + 2, uMin = Math.min(...pts.map(p => p.u)) - 5, uMax = Math.max(...pts.map(p => p.u)) + 5;
  const X = t => 30 + (t - tMin) / (tMax - tMin) * 272, Y = u => 140 - (u - uMin) / (uMax - uMin) * 128;
  let o = ''; [uMin, (uMin + uMax) / 2, uMax].forEach(u => o += `<line x1="30" x2="302" y1="${Y(u)}" y2="${Y(u)}" stroke="rgba(255,255,255,.06)"/>` + svgText(0, Y(u) + 3, Math.round(u), { size: 8.5 }));
  [Math.ceil(tMin / 5) * 5, Math.round((tMin + tMax) / 10) * 5, Math.floor(tMax / 5) * 5].forEach(t => o += svgText(X(t), 156, `${t}°`, { anchor: 'middle', size: 9 }));
  o += `<line x1="${X(tMin)}" y1="${Y(icpt + slope * tMin)}" x2="${X(tMax)}" y2="${Y(icpt + slope * tMax)}" stroke="#6cc4ff" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  const res = pts.map(p => ({ ...p, res: p.u - (icpt + slope * p.t) })), worst = res.reduce((a, b) => b.res > a.res ? b : a);
  const recent = addDays(localDate(), -60);
  res.forEach(p => { const flag = p === worst && worst.res > 12; o += `<circle cx="${X(p.t)}" cy="${Y(p.u)}" r="${flag ? 5 : 3}" fill="${flag ? '#ff7a66' : p.date >= recent ? 'rgba(108,196,255,.9)' : 'rgba(108,196,255,.3)'}"><title>${p.date}: ${p.u.toFixed(0)} kWh at ${Math.round(p.t)}°</title></circle>`; });
  o += svgText(30, 168, `daily high →  ·  home kWh/day ↑  ·  ${pts.length} hot days (bright = last 60)`, { size: 8.5, font: 'Manrope' });
  $('acChart').innerHTML = o;
  $('acTxt').innerHTML = `Each extra degree of daily high adds about <b style="color:var(--text)">${slope.toFixed(1)} kWh</b> a day, mostly air conditioning. That's about ${S.guest ? veil('$••') : S.tariff ? `$${(slope * 30 * S.tariff.importRateAllIn).toFixed(0)}` : '—'} a month per degree. ` +
    (worst.res > 12 ? `<b style="color:var(--warn)">${niceDate(worst.date)}</b> used ${Math.round(worst.res)} kWh more than normal for a ${Math.round(worst.t)}° day. That could be guests, laundry or the pool heater. If days like that become common, get the AC checked.` : 'Usage has tracked the temperature normally.');
}

/* ---------- overnight baseline ---------- */
export function drawOvernight(S) {
  const N = (S.overnight ?? []).filter(n => n.date < localDate()); if (N.length < 5) return;
  const mx = Math.max(...N.map(n => n.kw)) * 1.1, X = i => 8 + i / (N.length - 1) * 294, Y = v => 90 - v / mx * 80;
  let o = `<path d="${path(N.map((n, i) => [X(i), Y(n.kw)]))}" fill="none" stroke="#c4a2ff" stroke-width="1.8"/>`;
  o += svgText(X(0), 106, niceDate(N[0].date), { size: 9 }) + svgText(X(N.length - 1), 106, niceDate(N.at(-1).date), { size: 9, anchor: 'end' });
  const min = Math.min(...N.map(n => n.kw)); o += `<line x1="8" x2="302" y1="${Y(min)}" y2="${Y(min)}" stroke="rgba(255,255,255,.15)" stroke-dasharray="3 3"/>` + svgText(302, Y(min) - 4, `lowest ${(min * 1000).toFixed(0)} W`, { size: 9, anchor: 'end' });
  $('nightChart').innerHTML = o;
  const last7 = N.slice(-7).reduce((a, n) => a + n.kw, 0) / Math.min(7, N.length);
  $('nightTxt').innerHTML = `Between 1 and 5 AM your home averages <b style="color:var(--text)">${last7.toFixed(1)} kW</b> this week. The lowest night recently was ${(min * 1000).toFixed(0)} W, which is roughly your always-on load (fridges, pool pump, network, standby). The rest is overnight AC.`;
}

/* ---------- data health ---------- */
export function drawHealth(S, status) {
  const h = S.now?.health ?? {}, row = (ok, label, v) => `<div class="health"><i style="${ok ? '' : 'background:var(--warn);box-shadow:0 0 8px var(--warn)'}"></i>${label}<b>${v}</b></div>`;
  const errs = Object.entries(h.errors ?? {}).filter(([, e]) => e && Date.now() - e.at < 30 * 60_000);
  $('dhList').innerHTML = row(!h.stale, 'Tesla live status', h.lastLive ? ago(h.lastLive) : '—') + row(true, 'Energy history (5-min)', h.lastHistory ? ago(h.lastHistory) : '—') +
    row(!!status, 'History stored', status ? `${status.backfill.daysDone} days` : '—') + row(!!S.wx, 'Open-Meteo weather', S.wx ? 'live' : '—') + row(!!S.ercot, 'ERCOT grid status', S.ercot ? S.ercot.condition : '—') +
    errs.map(([k, e]) => row(false, `${k} error`, e.message.slice(0, 40))).join('');
  $('dhBadge').textContent = h.stale || errs.length ? 'check' : 'all good'; $('dhBadge').className = 'badge' + (h.stale || errs.length ? '' : ' g');
}
