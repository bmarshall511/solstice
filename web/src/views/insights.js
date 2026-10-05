import { $, niceDate, localDate, addDays, svgText, path, ago, money, localHour } from '../lib/util.js';
import { api } from '../lib/api.js';
import { mountOutageCard } from './outage.js';
import { veil, esc } from '../lib/frost.js';
import { guestPlan } from './guest.js';

/* ---------- alert cards ---------- */
export function drawAlerts(S) {
  const cards = [], site = S.now?.site ?? {};
  const card = (c, icon, title, when, body, link) => cards.push(`<div class="card" style="--c:${c}"><div class="ins"><div class="ic">${icon}</div><div><b>${title}</b> <time>· ${when}</time><p>${body}</p></div></div>${link ?? ''}</div>`);
  // mockup ab: stored grid alerts, newest first (the feed is already newest first)
  for (const a of S.gridFeed ?? []) {
    const ev = a.data?.event, at = new Date(a.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const when = Date.now() - Date.parse(a.createdAt) < 864e5 ? at : `${new Date(a.createdAt).toLocaleDateString('en-US', { weekday: 'short' })} ${at}`;
    card(ev === 'back' ? 'var(--batt)' : ev === 'low' ? 'var(--solar)' : 'var(--out)', ev === 'low' ? '\u2193' : '\u26a1', esc(a.title), when, esc(a.body.replace(/ Tap for the outage view\.$/, '')));
  }
  if (S.now?.health?.stale) card('var(--warn)', '⏻', 'Tesla stopped reporting', S.now.health.lastLive ? ago(S.now.health.lastLive) : 'now', 'No live data for over 3 minutes. Check the gateway Wi-Fi, or open the Tesla app to see if it can reach your Powerwalls.');
  (S.nws ?? []).slice(0, 2).forEach(a => card('var(--out)', '⛈', esc(a.event), 'NWS', `${esc(a.headline)}${/hail/i.test(a.description ?? '') ? ' If hail hits, check the Panels tab afterwards for any drop in output.' : ''}${site.stormWatch ? ' Storm Watch will charge the Powerwalls ahead of it.' : ''}`));
  const bad = (S.reconcile ?? []).filter(r => r.checks.some(c => !c.ok)).at(-1);
  if (bad) card('var(--grid)', '≈', 'PEC bill doesn’t match Tesla', niceDate(bad.billDate, { month: 'short' }) + ' bill', bad.checks.filter(c => !c.ok).map(c => esc(c.detail)).join(' '), '<button class="link" data-go="v-hist" data-bills="1">Open bill check →</button>');
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
  res.forEach(p => { const flag = p === worst && worst.res > 12; o += `<circle cx="${X(p.t)}" cy="${Y(p.u)}" r="${flag ? 5 : 3}" fill="${flag ? '#ff7a66' : p.date >= recent ? 'rgba(108,196,255,.9)' : 'rgba(108,196,255,.3)'}"><title>${esc(p.date)}: ${p.u.toFixed(0)} kWh at ${Math.round(p.t)}°</title></circle>`; });
  o += svgText(30, 168, `daily high →  ·  home kWh/day ↑  ·  ${pts.length} hot days (bright = last 60)`, { size: 8.5, font: 'Manrope' });
  $('acChart').innerHTML = o;
  $('acTxt').innerHTML = `Each extra degree of daily high adds about <b style="color:var(--text)">${slope.toFixed(1)} kWh</b> a day, mostly air conditioning. That's about ${S.guest ? veil('$••') : S.tariff ? `$${(slope * 30 * S.tariff.importRateAllIn).toFixed(0)}` : '—'} a month per degree. ` +
    (worst.res > 12 ? `<b style="color:var(--warn)">${niceDate(worst.date)}</b> used ${Math.round(worst.res)} kWh more than normal for a ${Math.round(worst.t)}° day. That could be guests, laundry or the pool heater. If days like that become common, get the AC checked.` : 'Usage has tracked the temperature normally.');
}

/* ---------- overnight baseline ---------- */
/* ---------- mockup y: Where your energy goes ---------- */
const EG = { ac: ['AC', '#ff9e66'], alwaysOn: ['Always-on', '#c4a2ff'], big: ['Big loads', 'var(--solar)'], pool: ['Pool', '#6cc4ff'], other: ['Everything else', 'rgba(255,255,255,.35)'] };
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
  $('spDays').textContent = d.days; $('spSub').textContent = `days with spare solar · ${d.exportKwh.toLocaleString()} kWh sent to PEC`;
  $('spBars').innerHTML = d.months.map(m => `<div><em>${m.days || ''}</em><i class="${m.days ? '' : 'z'}" style="height:${m.days / top * 60}px"></i><small>${MON[+m.month.slice(5) - 1]}</small></div>`).join('');
  const best = [...d.months].filter(m => m.days).sort((a, b) => b.days - a.days).slice(0, 2).map(m => MONTH[+m.month.slice(5) - 1]);
  const n = d.now, h = localHour(), day = h >= 8 && h < 18;
  $('spNow').innerHTML = n?.spare ? `<i class="on"></i><span><b>Spare now.</b> Powerwalls ${n.soc}%, ${(n.exportW / 1000).toFixed(1)} kW going to PEC.</span>`
    : `<i></i><span><b>None now.</b>${n ? ` Powerwalls ${n.soc}%${day && n.surplusW <= 0 ? ', and the house is using all the solar' : ''}.` : ''}${best.length ? ` Spare solar shows up on mild sunny days, mostly ${best.join(' and ')}.` : ''}</span>`;
}
export function initBreakdown(S, every) {
  $('egCard').hidden = !!S.guest; if (S.guest) return;
  $('egRange').onclick = e => { const b = e.target.closest('button'); if (!b || b.dataset.r === eg.range) return; eg.range = b.dataset.r; loadBreakdown(); };
  $('egParts').onclick = e => { const p = e.target.closest('.part'); if (!p) return; eg.open.has(p.dataset.id) ? eg.open.delete(p.dataset.id) : eg.open.add(p.dataset.id); drawBreakdown(); };
  $('egParts').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.part')) { e.preventDefault(); e.target.closest('.part').click(); } };
  eg.timer ??= every(15 * 60_000, loadBreakdown);
}
async function loadBreakdown() {
  document.querySelectorAll('#egRange button').forEach(b => b.classList.toggle('on', b.dataset.r === eg.range));
  try { eg.data = await api.breakdown(eg.range); } catch (e) { $('egSub').textContent = `Couldn\u2019t load: ${e.message}`; return; }
  drawBreakdown();
}
function drawBreakdown() {
  const d = eg.data; if (!d) return;
  $('egTotal').textContent = Math.round(d.homeKwh);
  const n = d.range === 'week' ? 7 : 30;
  $('egSub').textContent = !d.days ? 'No full day with thermostat readings yet' : d.range === 'today' ? 'kWh so far today'
    : d.days < n ? `kWh a day \u00b7 ${d.days} day${d.days === 1 ? '' : 's'} with Nest data` : `kWh a day \u00b7 last ${n} days`;
  const sum = d.parts.reduce((a, p) => a + p.kwh, 0) || 1;
  $('egBar').innerHTML = d.parts.map(p => `<i style="background:${EG[p.id][1]};width:${p.kwh / sum * 100}%"></i>`).join('');
  const note = p => p.id === 'ac' ? (p.hours != null ? `Cooling ${p.hours} h${d.range === 'today' ? ' today' : ' a day'} \u00d7 ${p.kw.toFixed(1)} kW` : 'From the heat model')
    : p.id === 'alwaysOn' ? (p.kw != null ? `${p.kw.toFixed(2)} kW every hour, from the quietest stretch of each night` : 'Not enough night data yet')
    : p.id === 'big' ? `${d.range === 'today' ? `${d.bursts.length} bursts today` : `${p.perDay} bursts a day`}${p.minutes ? `, ${p.minutes[0] === p.minutes[1] ? p.minutes[0] : `${p.minutes[0]}\u2013${p.minutes[1]}`} min at about ${p.burstKw} kW` : ''}: looks like the water heater, dryer, oven or range`
    : p.id === 'pool' ? 'Pump, UV and extras' : 'Lights, stovetop, TVs, small appliances';
  $('egParts').innerHTML = d.parts.map(p => `<div class="part${eg.open.has(p.id) ? ' open' : ''}" data-id="${p.id}" role="button" tabindex="0" aria-expanded="${eg.open.has(p.id)}">
    <i class="dot" style="background:${EG[p.id][1]}"></i><b>${EG[p.id][0]}</b><span class="v">${p.kwh.toFixed(1)} kWh<em>${p.share}%</em></span>
    <small>${esc(note(p))}. <span class="conf ${p.conf === 'measured' ? 'm' : 'e'}">${p.conf}</span></small>${eg.open.has(p.id) ? detail(p, d) : ''}</div>`).join('');
}
function detail(p, d) {
  if (p.id === 'big') {
    if (d.range !== 'today') return `<div class="detail"><p class="fine">Switch to Today to see each burst.</p></div>`;
    const t0 = new Date(); t0.setHours(0, 0, 0, 0); const day = 864e5, x = ms => Math.max(0, Math.min(100, (ms - t0.getTime()) / day * 100));
    return `<div class="detail"><div class="eg-strip">${d.bursts.map(b => `<i style="left:${x(b.start)}%;width:${b.minutes / 1440 * 100}%"></i>`).join('')}
      <span class="ax" style="left:0;transform:none">12a</span><span class="ax" style="left:25%">6a</span><span class="ax" style="left:50%">12p</span><span class="ax" style="left:75%">6p</span><span class="ax" style="left:auto;right:0;transform:none">12a</span></div>
      <div class="eg-bursts">${d.bursts.map(b => `<b>${clk(b.start)}</b><span>${b.minutes} min \u00b7 ${b.kw} kW</span><em>${b.kwh} kWh</em>`).join('') || '<span style="grid-column:1/4">None yet today.</span>'}</div></div>`;
  }
  if (p.id === 'alwaysOn' && d.trend?.length) {
    const mx = Math.max(...d.trend.map(t => t.kw)) || 1, mon = m => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).replace(' ', " '");
    return `<div class="detail"><div class="eg-trend">${d.trend.map((t, i) => `<i class="${i === d.trend.length - 1 ? 'now' : ''}" style="height:${Math.max(8, t.kw / mx * 100)}%" title="${mon(t.month)}: ${t.kw} kW"></i>`).join('')}</div>
      <div class="eg-tlab"><span>${mon(d.trend[0].month)}</span><span>monthly \u00b7 lowest night</span><span>${mon(d.trend.at(-1).month)}</span></div>
      <p class="fine" style="margin-top:8px">A typical home\u2019s base is 0.3\u20130.6 kW. A fridge or freezer in a warm room runs more in summer.</p></div>`;
  }
  if (p.id === 'ac' || p.id === 'pool') return `<div class="detail"><p class="fine">Details on the ${p.id === 'ac' ? 'AC' : 'Pool'} card in Appliances.</p></div>`;
  return '';
}

export function drawOvernight(S) {
  const N = (S.overnight ?? []).filter(n => n.date < localDate()); if (N.length < 5) return;
  const mx = Math.max(...N.map(n => n.kw)) * 1.1, X = i => 8 + i / (N.length - 1) * 294, Y = v => 90 - v / mx * 80, w = Math.max(1, 294 / N.length - 1);
  // one stacked bar a night (mockup z): always-on, then AC and the pump on nights the Nest readings cover, then the rest
  let o = '';
  N.forEach((n, i) => {
    let y0 = 90; const x = (X(i) - w / 2).toFixed(1);
    const seg = (v, c) => { if (!(v > 0)) return; const h = v / mx * 80; o += `<rect x="${x}" y="${(y0 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${c}"/>`; y0 -= h; };
    const base = n.base ?? 0; seg(base, '#c4a2ff');
    if (n.split) { seg(n.ac, '#f4a46e'); seg(n.pump, '#7cc4ff'); }
    seg(n.kw - base - (n.split ? (n.ac ?? 0) + (n.pump ?? 0) : 0), 'rgba(255,255,255,.22)');
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
  $('nightTxt').innerHTML = `Between 1 and 5 AM your home averaged <b style="color:var(--text)">${f(kw)} kW</b> this week${list ? `: ${list}` : ''}.`
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

export function drawHealth(S, status) {
  const h = S.now?.health ?? {}, row = (ok, label, v) => `<div class="health"><i style="${ok ? '' : 'background:var(--warn);box-shadow:0 0 8px var(--warn)'}"></i>${label}<b>${v}</b></div>`;
  const errs = Object.entries(h.errors ?? {}).filter(([k, e]) => k !== 'lastBackups' && e && Date.now() - e.at < 30 * 60_000);
  const bk = backupError(S), code = httpCode(bk), p = S.pool, a = S.ac;
  const poolOk = !!p?.linked && !p.error, nestOk = !!a?.linked && !a.error;
  $('dhList').innerHTML = row(!h.stale, 'Tesla live status', h.lastLive ? ago(h.lastLive) : '—') + row(true, 'Energy history (5-min)', h.lastHistory ? ago(h.lastHistory) : '—') +
    row(!bk, 'Backup history (Tesla)', bk ? `${code ? code + ' · ' : ''}retrying` : 'ok') +
    row(!!status, 'History stored', status ? `${status.backfill.daysDone} days` : '—') + row(!!S.wx, 'Open-Meteo weather', S.wx ? 'live' : '—') + row(!!S.ercot, 'ERCOT grid status', S.ercot ? esc(S.ercot.condition) : '—') +
    row(poolOk, 'ScreenLogic', p?.snapshot?.at ? ago(p.snapshot.at) : p?.error ? 'read failed' : p ? 'not linked' : '—') +
    row(nestOk, 'Nest', a?.state?.at ? ago(a.state.at) : a?.error ? 'read failed' : a ? (a.configured ? 'not linked' : 'not set up') : '—') +
    errs.map(([k, e]) => row(false, `${esc(k)} error`, esc(String(e.message ?? '').slice(0, 40)))).join('');
  // issues: what used to turn the badge to "check" (Tesla stale, recent errors), plus the backup history, ScreenLogic and Nest once loaded
  const n = (h.stale ? 1 : 0) + errs.length + (bk ? 1 : 0) + (p && !poolOk ? 1 : 0) + (a && !nestOk && (a.configured || a.error) ? 1 : 0);
  $('dhBadge').textContent = n ? `${n} issue${n === 1 ? '' : 's'}` : 'all good'; $('dhBadge').className = 'badge' + (n ? '' : ' g');
}
