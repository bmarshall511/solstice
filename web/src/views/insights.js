import { $, niceDate, localDate, addDays, svgText, ago, money, localHour } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { cBadge, badge } from '../lib/conf.js';
import { sheet, sheetHead, sheetFoot, closeSheet, segSet } from './csheet.js';
import { api } from '../lib/api.js';
import { mountOutageCard } from './outage.js';
import { veil, esc } from '../lib/frost.js';
import { guestPlan } from './guest.js';
import { initLoads, loadLoads, accOf } from './loads.js';

/* ---------- Worth knowing (Systems › Home): a vertical, dated list, newest 3 and "All N ›" (October audit B7) ---------- */
let alertItems = [];
const whenOf = iso => { const t = Date.parse(iso), at = new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return Date.now() - t < 864e5 && new Date(t).getDate() === new Date().getDate() ? `Today ${at}` : `${new Date(t).toLocaleDateString('en-US', { weekday: 'short' })} ${at}`; };
export function drawAlerts(S) {
  const items = [], site = S.now?.site ?? {};
  const add = (acc, ic, title, when, body, link = null) => items.push({ acc, ic, title, when, body, link });
  // mockup ab: stored grid alerts, newest first (the feed is already newest first)
  for (const a of S.gridFeed ?? []) {
    const ev = a.data?.event;
    add(ev === 'back' ? 'c-acc-batt' : ev === 'low' ? 'c-acc-solar' : 'c-acc-out', ev === 'low' ? 'batt' : 'bolt', esc(a.title), whenOf(a.createdAt), esc(a.body.replace(/ Tap for the outage view\.$/, '')));
  }
  if (S.now?.health?.stale) add('c-acc-warn', 'tesla', 'Tesla stopped reporting', S.now.health.lastLive ? ago(S.now.health.lastLive) : 'now', 'No live data for over 3 minutes. Check the gateway Wi-Fi, or open the Tesla app to see if it can reach your Powerwalls.');
  (S.nws ?? []).slice(0, 2).forEach(a => add('c-acc-out', 'storm', esc(a.event), 'NWS', `${esc(a.headline)}${/hail/i.test(a.description ?? '') ? ' If hail hits, check Systems › Solar afterwards for any drop in output.' : ''}${site.stormWatch ? ' Storm Watch will charge the Powerwalls ahead of it.' : ''}`));
  const bad = (S.reconcile ?? []).filter(r => r.checks.some(c => !c.ok)).at(-1);
  if (bad) add('c-acc-grid', 'bill', 'PEC bill doesn’t match Tesla', niceDate(bad.billDate, { month: 'short' }) + ' bill', bad.checks.filter(c => !c.ok).map(c => esc(c.detail)).join(' '), ['Open bill check', 'v-hist', null, 'billSect']);
  if (S.perf?.loss > .08) add('c-acc-warn', 'sun', `Solar output ${Math.round(S.perf.loss * 100)}% low`, 'last 7 clear days', 'Compared with the same sunlight this time last year. An even loss like this usually means dust or pollen.', ['See your panels', 'v-sys', 'solar']);
  const N = S.overnight ?? [];
  if (N.length > 20) { const recent = N.slice(-7).reduce((a, n) => a + n.kw, 0) / 7, base = N.slice(-37, -7).map(n => n.kw).sort((a, b) => a - b), med = base[Math.floor(base.length / 2)];
    if (recent > med * 1.15 && recent - med > .15) add('c-acc-solar', 'moon', `Overnight usage up ${Math.round((recent / med - 1) * 100)}%`, '7 nights', `Your 1–5 AM average went from ${(med * 1000).toFixed(0)} W to ${(recent * 1000).toFixed(0)} W, about ${S.guest ? veil('$••') : S.tariff ? `$${((recent - med) * 24 * 30 * S.tariff.importRateAllIn / 6).toFixed(0)}` : '—'}/month if it's always-on. Nights are hotter too, so some of this may be AC.`); }
  if (S.pool?.extras?.lightReadings30d > 0) add('c-acc-solar', 'light', 'Pool lights are 600 W of incandescent', 'from the plan', `The AmeriLite pool (500 W) and spa (100 W) lights cost about ${S.guest ? veil('$•.••') : S.tariff ? `$${(0.6 * S.tariff.importRateAllIn).toFixed(2)}` : '—'} an hour. LED replacements draw about a tenth of that and change colour.`);
  const D = (S.daily ?? []).slice(-30).filter(d => d.socMax != null);
  if (D.length > 10) { const full = D.filter(d => d.socMax >= 99).length;
    add('c-acc-batt', 'batt', full < 5 ? 'Your Powerwalls rarely fill up' : 'Powerwalls are cycling well', '30 days', full < 5
      ? `They reached 100% on only ${full} of the last ${D.length} days (typical peak ${Math.round(D.reduce((a, d) => a + d.socMax, 0) / D.length)}%). Your home uses most of the solar as it's made, so the batteries only store the small surplus. More panels would help them more than more batteries would.`
      : `They reached 100% on ${full} of the last ${D.length} days.`); }
  alertItems = items;
  const row = (x, i) => `<div class="c-sys compact ${x.acc}" role="button" tabindex="0" data-alert="${i}"><span class="c-ic">${icon(x.ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${x.title}</b></div><div class="c-sys-l">${esc(x.when)} · ${x.body.replace(/<[^>]+>/g, '')}</div></div><span class="c-chev">${icon('chev')}</span></div>`;
  $('alertsCard').hidden = !items.length;
  $('alertsFig').textContent = items.length ? `${items.length}` : '';
  $('alerts').innerHTML = items.slice(0, 3).map(row).join('') + (items.length > 3 ? `<div class="c-sys compact c-acc-mute" role="button" tabindex="0" data-alert="all"><span class="c-ic">${icon('bell')}</span><div style="min-width:0"><div class="c-sys-top"><b>All ${items.length}</b></div></div><span class="c-chev">${icon('chev')}</span></div>` : '');
  $('alerts').onclick = e => { const r = /** @type {Element} */ (e.target).closest('[data-alert]'); if (r) openAlerts(S); };
  $('sysDot').hidden = !items.some(x => /out|warn|grid/.test(x.acc));
}
/** Every Worth knowing item in full, as a sheet; a link row goes where the old card's link went. */
function openAlerts(S) {
  sheet(`${sheetHead('Worth knowing', badge('', `${alertItems.length}`))}${alertItems.map((x, i) => `<div class="c-card ${x.acc}"><div class="c-head"><span class="c-ic" style="width:32px;height:32px;border-radius:10px">${icon(x.ic)}</span><h5>${x.title}</h5><span class="c-fig">${esc(x.when)}</span></div><p class="c-sum">${x.body}</p>${x.link ? `<div class="c-btns"><button class="c-btn line" data-link="${i}">${x.link[0]} ›</button></div>` : ''}</div>`).join('')}${sheetFoot('', 'Done')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
  $('sheetBody').querySelectorAll('[data-link]').forEach(b => b.onclick = () => { const [, v, seg, anchor] = alertItems[+b.dataset.link].link; closeSheet(); S.nav?.go(v, anchor, seg); });
}

/* ---------- what-if planner (server replays your real last 12 months), in a sheet from Systems › Home's "What if you added…" ---------- */
let t, plan = { panels: 8, powerwalls: 0, extra: 0 };
export function openPlanner(S) {
  const inst = S.now?.site?.installed ? niceDate(S.now.site.installed.slice(0, 10), { month: 'short', year: 'numeric' }) : null;
  sheet(`${sheetHead('What if you added…', '', 'Your last 12 months replayed with the change. The Day Ring’s “+8 panels” mode shows the same idea on today.')}
    <div class="c-card" id="planner">
      <div class="slider"><label>Solar panels <b id="aPv">+0</b></label><input type="range" id="rPv" min="0" max="20" step="2" value="${plan.panels}" aria-label="Solar panels to add"><small id="aPvS">—</small></div>
      <div class="slider"><label>Powerwalls <b id="aPw">+0</b></label><input type="range" id="rPw" min="0" max="2" step="1" value="${plan.powerwalls}" aria-label="Powerwalls to add"><small id="aPwS">—</small></div>
      <div class="slider"><label>New daily usage <b id="aUse">+0 kWh</b></label><input type="range" id="rUse" min="0" max="30" step="2" value="${plan.extra}" aria-label="New daily usage"><small>EV, pool heater, heat pump… (added 5–11 PM)</small></div>
      <div class="tiles" id="planTiles"></div>
      <div class="rec" id="planRec">Calculating…</div>
      <div class="c-btns"><button class="c-btn line block" id="planMore" aria-expanded="false">Full comparison table</button></div>
      <div class="cmp" id="cmp" hidden></div>
      <p class="c-fine" id="planFine" hidden></p>
    </div>
    <div class="c-card" id="sysPayCard"><div class="c-head"><h5>Your system so far</h5>${inst ? `<span class="c-fig">installed ${esc(inst)}</span>` : ''}</div><div class="rec" id="sysPay" style="margin-top:10px"></div></div>
    ${sheetFoot('', 'Done', 'c-acc-solar')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
  $('planMore').onclick = () => { const open = $('cmp').hidden; $('cmp').hidden = $('planFine').hidden = !open; $('planMore').setAttribute('aria-expanded', String(open)); };
  const update = () => { clearTimeout(t); t = setTimeout(run, 180); };
  ['rPv', 'rPw', 'rUse'].forEach(id => $(id).addEventListener('input', update));
  run();
  async function run() {
    if (!$('rPv')) return;   // the sheet was closed or replaced
    const q = { panels: +/** @type {HTMLInputElement} */ ($('rPv')).value, powerwalls: +/** @type {HTMLInputElement} */ ($('rPw')).value, extra: +/** @type {HTMLInputElement} */ ($('rUse')).value }; plan = q;
    $('aPv').textContent = '+' + q.panels; $('aPw').textContent = '+' + q.powerwalls; $('aUse').textContent = `+${q.extra} kWh`;
    const r = await api.whatif(q).catch(() => null); if (!r || !$('rPv')) return;
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
    if (!$('planRec')) return;
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
export const initOutage = S => mountOutageCard(S, $('sysOutageSlot'));

/* ---------- Heat & your AC (frame 9): every 80°F+ day as a dot, the fitted trend as a gradient line with its direct label ---------- */
export function drawAC(S) {
  // cooling season only (highs ≥ 80°F): winter heating would muddy the AC relationship
  const pts = (S.daily ?? []).map(d => ({ date: d.date, t: S.highs?.[d.date], u: d.home })).filter(p => p.t != null && p.t >= 80 && p.u > 5 && p.date < localDate());
  if (pts.length < 10) return;
  const n = pts.length, mx = pts.reduce((a, p) => a + p.t, 0) / n, my = pts.reduce((a, p) => a + p.u, 0) / n;
  const sxx = pts.reduce((a, p) => a + (p.t - mx) ** 2, 0); if (!(sxx > 0)) return;   // every hot day at one temperature: no trend to draw
  const slope = pts.reduce((a, p) => a + (p.t - mx) * (p.u - my), 0) / sxx, icpt = my - slope * mx;
  S.acSlope = slope;
  const tMin = Math.min(...pts.map(p => p.t)) - 1, tMax = Math.max(...pts.map(p => p.t)) + 1, uMin = Math.min(...pts.map(p => p.u)) - 4, uMax = Math.max(...pts.map(p => p.u)) + 4;
  const X = t => 16 + (t - tMin) / (tMax - tMin) * 300, Y = u => 128 - (u - uMin) / (uMax - uMin) * 104;
  const res = pts.map(p => ({ ...p, res: p.u - (icpt + slope * p.t) })), worst = res.reduce((a, b) => b.res > a.res ? b : a), recent = addDays(localDate(), -60);
  let o = `<defs><linearGradient id="hacg" x1="0" x2="1"><stop offset="0" style="stop-color:var(--ac);stop-opacity:.2"/><stop offset="1" style="stop-color:var(--ac)"/></linearGradient></defs>`;
  res.forEach(p => { const flag = p === worst && worst.res > 12;
    o += `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.u).toFixed(1)}" r="${flag ? 5 : 4}" style="fill:var(${flag ? '--out' : '--ac'})" fill-opacity="${flag ? .9 : p.date >= recent ? .7 : .35}"><title>${esc(p.date)}: ${p.u.toFixed(0)} kWh at ${Math.round(p.t)}°</title></circle>`; });
  o += `<path d="M${X(tMin).toFixed(1)} ${Y(icpt + slope * tMin).toFixed(1)} L${X(tMax).toFixed(1)} ${Y(icpt + slope * tMax).toFixed(1)}" stroke="url(#hacg)" stroke-width="2" stroke-linecap="round" fill="none"/>`;
  o += `<text x="0" y="10">home kWh a day</text><text x="16" y="146">${Math.round(tMin + 1)}°</text><text x="316" y="146" text-anchor="end">${Math.round(tMax - 1)}° high</text>`;
  o += `<text class="v" x="316" y="${Math.max(22, Y(icpt + slope * tMax) - 8).toFixed(0)}" text-anchor="end">${slope >= 0 ? '+' : ''}${slope.toFixed(1)} kWh per °F</text>`;
  $('acChart').innerHTML = o;
  $('acTxt').innerHTML = `Each extra degree of daily high adds about <b>${slope.toFixed(1)} kWh</b> a day, mostly air conditioning. That's about ${S.guest ? veil('$••') : S.tariff ? `$${(slope * 30 * S.tariff.importRateAllIn).toFixed(0)}` : '—'} a month per degree. ` +
    (worst.res > 12 ? `<b style="color:var(--warn)">${niceDate(worst.date)}</b> (the red dot) used ${Math.round(worst.res)} kWh more than normal for a ${Math.round(worst.t)}° day. That could be guests, laundry or the pool heater. If days like that become common, get the AC checked.` : 'Usage has tracked the temperature normally.') +
    ` ${pts.length} hot days; the brighter dots are the last 60.` + heatSentence(S.models?.home?.fit);
}
/** B2-8: the home model's heating term (learn/homeModel.ts), once the last year shows one. */
function heatSentence(f) {
  if (!(f?.c > 0)) return '';
  return ` In cold weather it works the other way: each degree the night's low falls below ${f.th}° adds about <b style="color:var(--text)">${f.c.toFixed(1)} kWh</b> a day for heating${f.year?.heatDays ? `, from ${f.year.heatDays} cold days in the last year` : ''}.`;
}

/* ---------- mockup y, restyled by mockup al frame 9: Where your energy goes ---------- */
const EG = { ac: ['AC', 'c-acc-ac'], alwaysOn: ['Always-on', 'c-acc-grid'], big: ['Big loads', 'c-acc-solar'], pool: ['Pool', 'c-acc-pool'], other: ['Everything else', 'c-acc-mute'] };
/** A part's label and colour; I-22: a named load (`load:<id>`) wears its own name and colour, Big loads says how many are unnamed. */
const egOf = p => p.id.startsWith('load:') ? [esc(p.name), accOf(p.hue)] : p.id === 'big' && p.unnamed > 0 ? [`Big loads \u00b7 ${p.unnamed} unnamed`, EG.big[1]] : EG[p.id];
const eg = { range: 'week', open: new Set(), data: null, timer: null };
const clk = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
/** Owner only (main.js boot): loads the card now and every 15 minutes while visible; the range switch reloads it. */
/* ---------- mockup ad: Spare solar (owner only) ---------- */
let spTimer = null;
export function initSpare(S, every) {
  $('spCard').hidden = !!S.guest; if (S.guest) return;
  spTimer ??= every(15 * 60_000, async () => { try { drawSpare(await api.spare()); } catch { /* keep the last */ } });
}
const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'], MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function drawSpare(d) {
  const top = Math.max(1, ...d.months.map(m => m.days));
  $('spDays').textContent = d.days; $('spSub').innerHTML = `days in the<br>last 12 months · ${d.exportKwh.toLocaleString()} kWh sent to PEC`;
  // mockup al frame 11: the shared bar chart, gradient bars with their values on top and the month under each
  const bw = 329 / Math.max(1, d.months.length);
  $('spBars').innerHTML = `<defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--batt)"/><stop offset="1" style="stop-color:var(--batt);stop-opacity:.25"/></linearGradient></defs>`
    + d.months.map((m, i) => { const x = i * bw + bw / 2, h = m.days ? Math.max(4, m.days / top * 78) : 2;
      return `<rect x="${(x - 9).toFixed(1)}" y="${(98 - h).toFixed(1)}" width="18" height="${h.toFixed(1)}" rx="5" ${m.days ? 'fill="url(#spg)"' : 'style="fill:var(--c-fill-2)"'}/>${m.days ? `<text class="v" x="${x.toFixed(1)}" y="${(92 - h).toFixed(1)}" text-anchor="middle">${m.days}</text>` : ''}<text x="${x.toFixed(1)}" y="112" text-anchor="middle">${MON[+m.month.slice(5) - 1]}</text>`; }).join('');
  const best = [...d.months].filter(m => m.days).sort((a, b) => b.days - a.days).slice(0, 2).map(m => MONTH[+m.month.slice(5) - 1]);
  const n = d.now, h = localHour(), day = h >= 8 && h < 18;
  $('spNow').innerHTML = n?.spare ? `<b style="color:var(--batt)">Spare now.</b> Powerwalls ${n.soc}%, ${(n.exportW / 1000).toFixed(1)} kW going to PEC.`
    : `<b>None now.</b>${n ? ` Powerwalls ${n.soc}%${day && n.surplusW <= 0 ? ', and the house is using all the solar' : ''}.` : ''}${best.length ? ` Spare solar shows up on mild sunny days, mostly ${best.join(' and ')}.` : ''}`;
}
/* ---------- mockup af: Powerwall capacity (owner only; recomputed nightly) ---------- */
let bcTimer = null;
export function initCapacity(S, every) {
  $('bcCard').hidden = !!S.guest; if (S.guest) return;
  // the install date comes from /api/now: until it has loaded, draw again shortly
  const load = async () => { if (S.guest) return;   /* owner previewing as a guest: no owner-only request */ try { drawCapacity(S, await api.capacity()); if (!S.now?.site) setTimeout(load, 5000); } catch { /* keep the last */ } };
  bcTimer ??= every(60 * 60_000, load);
}
function drawCapacity(S, c) {
  const site = S.now?.site ?? {}, name = c?.nameplateKwh || site.capacityKwh || 27;
  $('bcName').textContent = `${name} kWh`;
  const tag = t => { $('bcTag').innerHTML = cBadge(t); };
  if (!c?.measuredKwh) {
    tag('learning'); $('bcKwh').textContent = '—'; $('bcFill').style.width = '0';
    $('bcSub').textContent = `${c?.count ?? 0} of 5 discharges measured in the last 90 days`;
    $('bcTxt').textContent = 'Measured from evening discharges of 2 h or more that use 25% of the charge or more. Until there are 5 in 90 days, the estimates use the nameplate × 95%.';
  } else {
    const pct = Math.round(c.measuredKwh / name * 100);
    tag('measured'); $('bcKwh').textContent = c.measuredKwh.toFixed(1); $('bcFill').style.width = `${Math.min(100, c.measuredKwh / name * 100)}%`;
    $('bcSub').innerHTML = `of ${name} kWh · ${pct}%<br>what a full charge delivers`;
    const since = c.since ? new Date(`${c.since}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '', [lo, hi] = c.range ?? [];
    const inst = site.installed ? new Date(site.installed).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : null, n = site.batteries?.length;
    $('bcTxt').textContent = `From ${c.countAll} evening discharges since ${since} (each 2 h or longer, 25% of charge or more); the figure uses the last 90 days (${c.count}). `
      + (c.fade ? `${MONTH[+c.fade.month.slice(5) - 1]} measured ${c.fade.pct}% below the year: worth watching.` : lo != null ? `Steady: the monthly figures range ${lo.toFixed(1)}\u2013${hi.toFixed(1)} kWh.` : '')
      + (inst && n ? ` ${n === 2 ? 'Two' : n} ${esc(site.batteries[0].name)}${n > 1 ? 's' : ''} installed ${inst}.` : '');
  }
  $('bcMonths').innerHTML = (c?.months ?? []).map(m => `<div><i class="${m.n < 3 ? 'few' : ''}" style="height:${Math.min(60, Math.max(3, (m.kwh - 20) / 7 * 50))}px" title="${MONTH[+m.month.slice(5) - 1]}: ${m.kwh} kWh from ${m.n}"></i><small>${MON[+m.month.slice(5) - 1]}</small></div>`).join('');
}
export function initBreakdown(S, every) {
  $('egCard').hidden = !!S.guest; if (S.guest) return;
  $('egRange').onclick = e => { const b = /** @type {Element} */ (e.target).closest('button'); if (!b || b.dataset.r === eg.range) return; eg.range = b.dataset.r; loadBreakdown(); };
  $('egParts').onclick = e => { const p = /** @type {Element} */ (e.target).closest('.c-part[data-id]'); if (!p) return; eg.open.has(p.dataset.id) ? eg.open.delete(p.dataset.id) : eg.open.add(p.dataset.id); drawBreakdown(); };
  $('egParts').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && /** @type {Element} */ (e.target).closest('.c-part[data-id]')) { e.preventDefault(); /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest('.c-part')).click(); } };
  initLoads(S, loadBreakdown);   // I-22: the Big loads card under this one; a new name reloads the parts
  eg.timer ??= every(15 * 60_000, loadBreakdown);
}
async function loadBreakdown() {
  segSet($('egRange'), eg.range, 'data-r');
  loadLoads();
  try { eg.data = await api.breakdown(eg.range); } catch (e) { $('egSub').textContent = `Couldn\u2019t load: ${e.message}`; return; }
  drawBreakdown();
}
function drawBreakdown() {
  const d = eg.data; if (!d) return;
  $('egTotal').textContent = String(Math.round(d.homeKwh));
  const n = d.range === 'week' ? 7 : 30;
  $('egSub').textContent = !d.days ? 'No full day with thermostat readings yet' : d.range === 'today' ? 'kWh so far today'
    : d.days < n ? `kWh a day \u00b7 ${d.days} day${d.days === 1 ? '' : 's'} with Nest data` : `kWh a day \u00b7 last ${n} days`;
  const sum = d.parts.reduce((a, p) => a + p.kwh, 0) || 1;
  $('egBar').innerHTML = d.parts.map(p => `<i class="${egOf(p)[1]}" style="width:${p.kwh / sum * 100}%"></i>`).join('');
  const note = p => p.id === 'ac' ? (p.hours != null ? `Cooling ${p.hours} h${d.range === 'today' ? ' today' : ' a day'} \u00d7 ${p.kw.toFixed(1)} kW` : 'From the heat model')
    : p.id === 'alwaysOn' ? (p.kw != null ? `${p.kw.toFixed(2)} kW every hour, from the quietest stretch of each night` : 'Not enough night data yet')
    : p.id === 'big' ? `${d.range === 'today' ? `${d.bursts.length} bursts today` : `${p.perDay} bursts a day`}${p.minutes ? `, ${p.minutes[0] === p.minutes[1] ? p.minutes[0] : `${p.minutes[0]}\u2013${p.minutes[1]}`} min at about ${p.burstKw} kW` : ''}: looks like the water heater, dryer, oven or range`
    : p.id.startsWith('load:') ? `About ${p.kw.toFixed(1)} kW for ${p.minutes} min a run, the bursts that match the name you gave it`
    : p.id === 'pool' ? 'Pump, UV and extras' : 'Lights, stovetop, TVs, small appliances';
  // the overnight baseline lives in its own card for a guest; for the owner it opens under Always-on (moved, not redrawn)
  const night = $('nightBox'); if (night && night.parentElement !== $('nightCard')) $('nightCard').appendChild(night);
  $('egParts').innerHTML = d.parts.map(p => { const open = eg.open.has(p.id);
    return `<div class="c-part ${egOf(p)[1]}${open ? ' open' : ''}" data-id="${esc(p.id)}" role="button" tabindex="0" aria-expanded="${open}"><i></i><span>${egOf(p)[0]} ${cBadge(p.conf)}</span><b>${p.kwh.toFixed(1)} kWh<em>${p.share}%</em></b></div>`
      + (open ? `<div class="c-part-d"><p class="c-cap">${esc(note(p))}.</p>${detail(p, d)}</div>` : ''); }).join('');
  const slot = $('egParts').querySelector('[data-night]'); if (slot && night) slot.appendChild(night);
}
function detail(p, d) {
  if (p.id === 'big') {
    if (d.range !== 'today') return `<div class="detail"><p class="fine">Switch to Today to see each burst.</p></div>`;
    const t0 = new Date(); t0.setHours(0, 0, 0, 0); const day = 864e5, x = ms => Math.max(0, Math.min(100, (ms - t0.getTime()) / day * 100));
    return `<div class="detail"><div class="eg-strip">${d.bursts.map(b => `<i style="left:${x(b.start)}%;width:${b.minutes / 1440 * 100}%"></i>`).join('')}
      <span class="ax" style="left:0;transform:none">12a</span><span class="ax" style="left:25%">6a</span><span class="ax" style="left:50%">12p</span><span class="ax" style="left:75%">6p</span><span class="ax" style="left:auto;right:0;transform:none">12a</span></div>
      <div class="eg-bursts">${d.bursts.map(b => `<b>${clk(b.start)}</b><span>${b.minutes} min \u00b7 ${b.kw} kW</span><em>${b.kwh} kWh</em>`).join('') || '<span style="grid-column:1/4">None yet today.</span>'}</div></div>`;
  }
  if (p.id === 'alwaysOn') return `<div data-night></div>${trend(d)}`;
  if (p.id.startsWith('load:')) return '<p class="c-fine">Rename it under Big loads.</p>';
  if (p.id === 'ac' || p.id === 'pool') return `<p class="c-fine">Details on Systems › ${p.id === 'ac' ? 'AC' : 'Pool'}.</p>`;
  return '';
}
/** Always-on's monthly lowest-night trend (under the overnight baseline when the row is open). */
function trend(d) {
  if (d.trend?.length) {
    const mx = Math.max(...d.trend.map(t => t.kw)) || 1, mon = m => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).replace(' ', " '");
    return `<div class="detail"><div class="eg-trend">${d.trend.map((t, i) => `<i class="${i === d.trend.length - 1 ? 'now' : ''}" style="height:${Math.max(8, t.kw / mx * 100)}%" title="${mon(t.month)}: ${t.kw} kW"></i>`).join('')}</div>
      <div class="eg-tlab"><span>${mon(d.trend[0].month)}</span><span>monthly \u00b7 lowest night</span><span>${mon(d.trend.at(-1).month)}</span></div>
      <p class="fine" style="margin-top:8px">A typical home\u2019s base is 0.3\u20130.6 kW. A fridge or freezer in a warm room runs more in summer.</p></div>`;
  }
  return '';
}

export function drawOvernight(S) {
  const N = (S.overnight ?? []).filter(n => n.date < localDate()); if (N.length < 5) return;
  const mx = Math.max(...N.map(n => n.kw)) * 1.1, X = i => 8 + i / (N.length - 1) * 294, Y = v => 90 - v / mx * 80, w = Math.max(1, 294 / N.length - 1);
  // one stacked bar a night (mockup z): always-on, then AC and the pump on nights the Nest readings cover, then the rest
  let o = '';
  N.forEach((n, i) => {
    let y0 = 90; const x = (X(i) - w / 2).toFixed(1);
    const seg = (v, c) => { if (!(v > 0)) return; const h = v / mx * 80; o += `<rect x="${x}" y="${(y0 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${c}"/>`; y0 -= h; };
    const base = n.base ?? 0; seg(base, 'var(--grid)');
    if (n.split) { seg(n.ac, 'var(--ac)'); seg(n.pump, 'var(--home)'); }
    seg(n.kw - base - (n.split ? (n.ac ?? 0) + (n.pump ?? 0) : 0), 'var(--c-fill-2)');
  });
  const first = N.findIndex(n => n.split);
  if (first > 0) o += `<line x1="${X(first - .5)}" x2="${X(first - .5)}" y1="8" y2="90" stroke="rgba(255,255,255,.25)" stroke-dasharray="2 3"/>` + svgText(X(first - .5) - 3, 14, 'Nest from here', { size: 8.5, anchor: 'end' });
  o += svgText(X(0), 106, niceDate(N[0].date), { size: 9 }) + svgText(X(N.length - 1), 106, niceDate(N.at(-1).date), { size: 9, anchor: 'end' });
  $('nightChart').innerHTML = o;
  $('nightSub').textContent = `1–5 AM · ${N.length} nights`;
  $('nightKey').hidden = $('nightSum').hidden = false;
  const W = N.slice(-7), avg = (a, f) => { const v = a.map(f).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const kw = avg(W, n => n.kw), base = avg(W, n => n.base), sp = W.filter(n => n.split), ac = avg(sp, n => n.ac), pump = avg(sp, n => n.pump);
  const f = v => v == null ? '—' : v.toFixed(1);
  $('nightSum').innerHTML = [[base, 'always-on'], [ac, 'AC'], [pump, 'pool pump']].map(([v, l]) => `<div><b>${f(v)}</b><span>kW ${l}</span></div>`).join('');
  const parts = [base != null && `${f(base)} kW always-on (fridges, network, standby)`, ac >= .05 && `${f(ac)} kW AC`, pump >= .05 && `${f(pump)} kW the pool pump`].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const none = sp.length ? [ac === 0 && 'the AC', pump === 0 && 'the pool pump'].filter(Boolean) : [];   // a part under 0.05 kW that did run is just left out
  $('nightTxt').innerHTML = `Between 1 and 5 AM your home averaged <b>${f(kw)} kW</b> this week${list ? `: ${list}` : ''}.`
    + (none.length ? ` ${none.length === 2 ? "The AC and the pool pump didn’t run" : `${none[0][0].toUpperCase()}${none[0].slice(1)} didn’t run`}.` : '')
    + (base != null ? ' The always-on part is the same figure as in Where your energy goes.' : '')
    + (sp.length ? '' : ' The AC and the pump can’t be split out on nights without thermostat readings.');
}

/* ---------- data health ---------- */
/**
 * Is Tesla's backup_history refresh failing right now? The server retries it on every sync while it fails and only hourly once it
 * succeeds, so the latest sync's own errors say it; before the first sync answers, a stored error from the last 30 minutes does.
 * Returns the error message, or null.
 */
export function backupError(S) {
  if (S.syncInfo) return S.syncInfo.errors?.find(e => e.startsWith('lastBackups:'))?.slice(12).trim() ?? null;
  const e = S.now?.health?.errors?.lastBackups;
  return e && Date.now() - e.at < 30 * 60_000 ? e.message : null;
}
export const httpCode = message => /HTTP (\d{3})/.exec(message ?? '')?.[1] ?? null;

/** B2-11: the three crons' last runs (owner only: /api/now's health.crons), each with its slowest step. */
const secs = ms => ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
export function cronRows(c, now = Date.now()) {
  if (!c) return [];
  const slow = r => r.slowest ? ` · slowest ${esc(r.slowest.name)} ${secs(r.slowest.ms)} s` : '';
  const out = [];
  if (c.sync) out.push({ label: 'Nightly update', ok: c.sync.ok && now - c.sync.at < 26 * 3600e3 && c.sync.ms <= 50_000, v: `${clk(c.sync.at)} · ${secs(c.sync.ms)} s${slow(c.sync)}${c.sync.errors ? ` · ${c.sync.errors} error${c.sync.errors === 1 ? '' : 's'}` : ''}` });
  if (c.nest) out.push({ label: '5-minute checks', ok: c.nest.ok && now - c.nest.at < 20 * 60_000, v: `${ago(c.nest.at)}${slow(c.nest)}` });
  if (c.pool) out.push({ label: 'Pool plan', ok: c.pool.ok && now - c.pool.at < 26 * 3600e3, v: `${clk(c.pool.at)} ${c.pool.ok ? '✓' : '· failed'}` });
  return out;
}
/** The Data health rows ({ ok, label, v } with v as HTML) and the issue count: the Now Conditions sheet (mockup al frame 4) draws these;
 *  Settings › Connections shows the same services row by row. */
export function healthRows(S, status) {
  const h = S.now?.health ?? {}, row = (ok, label, v) => ({ ok, label, v });
  const errs = Object.entries(h.errors ?? {}).filter(([k, e]) => k !== 'lastBackups' && e && Date.now() - e.at < 30 * 60_000);
  const bk = backupError(S), code = httpCode(bk), p = S.pool, a = S.ac;
  const poolOk = !!p?.linked && !p.error, nestOk = !!a?.linked && !a.error, crons = cronRows(h.crons);
  const rows = [row(!h.stale, 'Tesla live status', h.lastLive ? ago(h.lastLive) : '—'), row(true, 'Energy history (5-min)', h.lastHistory ? ago(h.lastHistory) : '—'),
    row(!bk, 'Backup history (Tesla)', bk ? `${code ? code + ' · ' : ''}retrying` : 'ok'),
    row(!!status, 'History stored', status ? `${status.backfill.daysDone} days` : '—'), row(!!S.wx, 'Open-Meteo weather', S.wx ? 'live' : '—'), row(!!S.ercot, 'ERCOT grid status', S.ercot ? esc(S.ercot.condition) : '—'),
    row(poolOk, 'ScreenLogic', p?.snapshot?.at ? ago(p.snapshot.at) : p?.error ? 'read failed' : p ? 'not linked' : '—'),
    row(nestOk, 'Nest', a?.state?.at ? ago(a.state.at) : a?.error ? 'read failed' : a ? (a.configured ? 'not linked' : 'not set up') : '—'),
    ...crons.map(c => row(c.ok, c.label, c.v)),
    ...errs.map(([k, e]) => row(false, `${esc(k)} error`, esc(String(e.message ?? '').slice(0, 40))))];
  // issues: what used to turn the badge to "check" (Tesla stale, recent errors), plus the backup history, ScreenLogic and Nest once loaded
  const issues = (h.stale ? 1 : 0) + errs.length + (bk ? 1 : 0) + (p && !poolOk ? 1 : 0) + (a && !nestOk && (a.configured || a.error) ? 1 : 0) + crons.filter(c => !c.ok).length;
  return { rows, issues };
}
