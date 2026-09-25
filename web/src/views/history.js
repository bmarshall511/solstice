import { $, fmtDur, clock12, niceDate, localDate, addDays, svgText, path, money, money2, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { yearRingCard, yearModel } from '../scenes/yearring.js';
import { createFlowsCard, mountFlows } from '../scenes/flows.js';
import { veil } from '../lib/frost.js';
import { lockBillCards } from './guest.js';

let range = 'day', day = null;

/* ---------- Day: radial 24h ---------- */
async function drawDay(S) {
  day ??= localDate();
  const d = await api.day(day), svg = $('hchart'), r0 = 62, rs = 88;
  svg.setAttribute('viewBox', '-165 -165 330 330'); svg.setAttribute('height', 310);
  $('dayLabel').textContent = day === localDate() ? 'Today' : niceDate(day, { weekday: 'short', month: 'short', day: 'numeric' });
  $('dayNext').disabled = day >= localDate();
  const pol = (h, r) => { const a = h / 24 * Math.PI * 2 - Math.PI / 2; return [Math.cos(a) * r, Math.sin(a) * r]; };
  const B = d.buckets, maxKw = Math.max(6, ...B.map(b => Math.max(b.solar, b.home)));
  let o = `<circle r="${r0}" fill="none" stroke="rgba(255,255,255,.08)"/><circle r="${r0 + rs}" fill="none" stroke="rgba(255,255,255,.05)" stroke-dasharray="2 4"/>`;
  for (let h = 0; h < 24; h++) { const [x1, y1] = pol(h, r0 - 4), [x2, y2] = pol(h, r0 - (h % 6 ? 7 : 12)); o += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,${h % 6 ? .15 : .4})"/>`; }
  [0, 6, 12, 18].forEach(h => { const [x, y] = pol(h, r0 - 24); o += svgText(x, y + 4, ['12a', '6a', '12p', '6p'][h / 6], { size: 10, anchor: 'middle' }); });
  const area = (key, color, op) => { if (!B.length) return ''; const pts = B.map(b => pol(b.t + 1 / 24, r0 + b[key] / maxKw * rs)), back = B.slice().reverse().map(b => pol(b.t + 1 / 24, r0));
    return `<path d="${path([...pts, ...back])}Z" fill="${color}" fill-opacity="${op}" stroke="${color}" stroke-width="1.2"/>`; };
  o += area('home', '#6cc4ff', .18) + area('solar', '#ffc15e', .38);
  if (d.soe.length) o += `<path d="${path(d.soe.map(p => pol(p.t, r0 + p.soc / 100 * rs)))}" fill="none" stroke="#4ef0a6" stroke-width="2" style="filter:drop-shadow(0 0 4px #4ef0a6)"/>`;
  const t = d.totals, self = t.home ? Math.round((1 - t.import / t.home) * 100) : 0;
  o += svgText(0, -4, `${self}%`, { size: 28, fill: '#f2f4f8', anchor: 'middle', font: 'Manrope', weight: 300 }) + svgText(0, 15, 'solar + battery', { size: 10.5, fill: 'rgba(242,244,248,.5)', anchor: 'middle', font: 'Manrope' });
  svg.innerHTML = o;
  $('hleg').innerHTML = `<span><i style="background:var(--solar)"></i>Solar kW</span><span><i style="background:var(--home)"></i>Home kW</span><span><i style="background:var(--batt)"></i>Battery %</span>`;
  const rate = S.tariff?.importRateAllIn;
  $('hstats').innerHTML = stat('Solar', t.solar, `peak ${Math.max(0, ...B.map(b => b.solar)).toFixed(1)} kW`) + stat('Home', t.home, `peak ${Math.max(0, ...B.map(b => b.home)).toFixed(1)} kW`) +
    stat('Bought from PEC', t.import, S.guest ? `≈ ${veil('$•.••')}` : rate != null ? `≈ $${((t.import ?? 0) * rate).toFixed(2)}` : 'rate unknown') + stat('Powerwall', t.discharge, `out · ${(t.charge ?? 0).toFixed(1)} in`);
}
const stat = (label, v, sub) => `<div class="stat"><span>${label}</span><b>${v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(1) + '<small>MWh</small>' : v.toFixed(1) + '<small>kWh</small>'}</b><em>${sub}</em></div>`;

/* ---------- Week / Month / Year bars ---------- */
async function drawBars(S) {
  const svg = $('hchart'), W = 330, H = 230; svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
  let rows, label;
  if (range === 'year') { rows = (S.monthly ?? await api.monthly(13)).slice(-12); label = r => new Date(r.month + '-15').toLocaleDateString('en-US', { month: 'narrow' }); }
  else { const n = range === 'week' ? 7 : 30; rows = (S.daily ?? []).slice(-n); label = (r, i) => range === 'week' ? niceDate(r.date, { weekday: 'short' }) : i % 5 === 0 ? String(+r.date.slice(8)) : ''; }
  const mx = Math.max(1, ...rows.map(r => Math.max(r.solar, r.home))) * 1.08, bw = (W - 20) / rows.length;
  const outageDays = new Set((S.outages ?? []).map(o => range === 'year' ? o.ts.slice(0, 7) : o.ts.slice(0, 10)));
  let o = '';
  [0, .5, 1].forEach(t => o += `<line x1="10" x2="${W - 10}" y1="${10 + (H - 40) * (1 - t)}" y2="${10 + (H - 40) * (1 - t)}" stroke="rgba(255,255,255,.06)"/>`);
  rows.forEach((r, i) => { const x = 10 + i * bw, h1 = r.solar / mx * (H - 40), h2 = r.home / mx * (H - 40), w = Math.max(2, bw * .36);
    o += `<rect x="${x + bw * .12}" y="${H - 30 - h1}" width="${w}" height="${h1}" rx="${Math.min(4, w / 2)}" fill="#ffc15e"><title>${r.date ?? r.month}: solar ${r.solar.toFixed(0)} kWh</title></rect>`;
    o += `<rect x="${x + bw * .12 + w + 1.5}" y="${H - 30 - h2}" width="${w}" height="${h2}" rx="${Math.min(4, w / 2)}" fill="#6cc4ff" fill-opacity=".75"><title>home ${r.home.toFixed(0)} kWh</title></rect>`;
    if (outageDays.has(r.date ?? r.month)) o += `<circle cx="${x + bw / 2}" cy="${H - 34 - Math.max(h1, h2) - 8}" r="3.5" fill="#ff5a4e"/>`;
    o += svgText(x + bw / 2, H - 12, label(r, i), { size: 10, anchor: 'middle' }); });
  o += svgText(10, 8, range === 'year' ? 'kWh / month' : 'kWh / day', { font: 'Manrope' });
  svg.innerHTML = o;
  $('hleg').innerHTML = `<span><i style="background:var(--solar)"></i>Solar</span><span><i style="background:var(--home)"></i>Home</span><span><i style="background:var(--out)"></i>Outage</span>`;
  const sum = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0), rate = S.tariff?.importRateAllIn, credit = S.tariff?.exportCredit;
  $('hstats').innerHTML = stat('Solar', sum('solar'), `${Math.round(sum('solar') / sum('home') * 100)}% of home use`) + stat('Home', sum('home'), `${(sum('home') / (range === 'year' ? 365 : rows.length)).toFixed(0)} kWh/day avg`) +
    stat('Bought from PEC', sum('import'), S.guest ? `≈ ${veil()}` : rate != null ? `≈ $${Math.round(sum('import') * rate)}` : 'rate unknown') + stat('Sent to PEC', sum('export'), S.guest ? `≈ ${veil()} credit` : credit != null ? `≈ $${Math.round(sum('export') * credit)} credit` : 'rate unknown');
}

export async function drawHistoryChart(S) {
  $('dayNav').hidden = range !== 'day';
  $('hdate').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  try { range === 'day' ? await drawDay(S) : await drawBars(S); } catch (e) { $('hchart').innerHTML = svgText(0, 0, 'Could not load history', { anchor: 'middle' }); }
  try { drawYearRing(S); } catch (e) { console.error(e); }
  drawFlows(S);
}

/* ---------- Year: the year ring card (mockup o-year-ring), Year range only ---------- */
let ring = null, ringHistory = null; // ringHistory: api.daily(800) for last year's ghost, fetched once when the card first builds (not in the 5-min refresh)
function drawYearRing(S) {
  $('yrCard').hidden = range !== 'year';
  if (range !== 'year') return ring?.hide();
  ring ??= yearRingCard({ el: $('yr'), labs: $('yrLabs'), read: $('yrRead'), stats: $('yrStats'), note: $('yrNote'), calm: () => S.calm, highs: () => S.highs, onOpen: date => showDay(S, date) });
  const show = () => ring.show(yearModel({ daily: S.daily ?? [], history: ringHistory ?? [], today: localDate(), outages: S.outages ?? [] }));
  if (!ringHistory && S.daily) { ringHistory = []; api.daily(800).then(r => { ringHistory = r; if (range === 'year') show(); }, () => { ringHistory = null; }); }
  show();
}

/** Open one date in the Day view ("Open this day →" on the year ring). */
export function showDay(S, date) {
  day = date; range = 'day';
  document.querySelectorAll('#hseg button').forEach(x => x.classList.toggle('on', x.dataset.r === 'day'));
  drawHistoryChart(S); $('screen').scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- m-flows: "Where every kWh went", after the totals, for Day and Month (scenes/flows.js) ---------- */
let flowsCard = null, flowsView = null, flowsSeq = 0;
async function drawFlows(S) {
  const today = localDate(), date = range === 'day' ? day ?? today : today, key = `${range}|${date}`, seq = ++flowsSeq;
  if (!flowsCard) { flowsCard = createFlowsCard(); $('hstats').after(flowsCard); }
  flowsCard.hidden = S.guest || (range !== 'day' && range !== 'month');   // owner-only (/api/flows): never a guest's
  if (flowsCard.hidden) { flowsView?.dispose(); flowsView = null; return; }
  const hit = (S.flowsCache ??= {})[key], fresh = hit && (Date.now() - hit.at < 5 * 60e3 || (range === 'day' && date < today));
  if (fresh && flowsView?.alive() && flowsView.key === key && flowsView.data === hit.data) return;   // already showing it
  try {
    const data = fresh ? hit.data : (S.flowsCache[key] = { at: Date.now(), data: await api.flows(range, date) }).data;
    if (seq !== flowsSeq) return;
    const sel = flowsView?.key === key ? flowsView.sel() : null;
    flowsView?.dispose();
    flowsView = Object.assign(mountFlows(flowsCard, data, { title: range === 'month' ? 'Last 30 days' : date === today ? 'Today' : niceDate(date, { weekday: 'short', month: 'short', day: 'numeric' }), today, calm: () => S.calm, sel }), { key, data });
  } catch (e) { if (seq === flowsSeq) { flowsView?.dispose(); flowsView = null; flowsCard.querySelector('.landtip').textContent = 'Could not load where the energy went.'; } }
}

export function initHistory(S) {
  document.querySelectorAll('#hseg button').forEach(b => b.onclick = () => { document.querySelectorAll('#hseg button').forEach(x => x.classList.toggle('on', x === b)); range = b.dataset.r; drawHistoryChart(S); });
  $('dayPrev').onclick = () => { day = addDays(day ?? localDate(), -1); drawDay(S); drawFlows(S); };
  $('dayNext').onclick = () => { if (day < localDate()) { day = addDays(day, 1); drawDay(S); drawFlows(S); } };
}

/* ---------- landscape data: hourly solar + each day's ratio to what its sunlight should give ---------- */
export function landscapeData(S) {
  if (!S.gridDays) return null;
  const ratios = S.gridDays.dates.map((d, i) => { const g = S.gtiByDate?.[d], sol = S.gridDays.solar[i].reduce((a, v) => a + (v ?? 0), 0);
    return S.yieldK && g > 2.5 && d < localDate() ? sol / (S.yieldK * g) : null; });
  return { dates: S.gridDays.dates, solar: S.gridDays.solar, ratios };
}

/* ---------- Powerwall charge heatmap + stats ---------- */
export function drawSocHeat(S) {
  const G = S.gridDays; if (!G) return;
  const reserve = S.now?.site?.reservePct ?? 20, rows = G.soc, D = rows.length, ch = 176 / D;
  const col = v => { const st = [[16, 21, 31], [29, 92, 74], [78, 240, 166], [217, 255, 240]], t = Math.max(0, Math.min(.999, v / 100)) * 3, i = Math.floor(t), f = t - i; return `rgb(${st[i].map((c, j) => Math.round(c + (st[i + 1][j] - c) * f)).join(',')})`; };
  let o = '';
  rows.forEach((r, d) => r.forEach((v, h) => { if (v == null) return; o += `<rect x="${22 + h * 11.9}" y="${4 + d * ch}" width="11.4" height="${Math.max(1, ch - .6)}" rx="1.2" fill="${v <= reserve + .5 ? '#ff7a66' : col(v)}"><title>${G.dates[d]} ${clock12(h)}: ${Math.round(v)}%</title></rect>`; }));
  [0, 6, 12, 18].forEach(h => o += svgText(22 + h * 11.9, 188, ['12a', '6a', '12p', '6p'][h / 6], { size: 9 }));
  o += svgText(0, 12, niceDate(G.dates[0]).split(' ')[1], { size: 8.5 }) + svgText(0, 180, 'today', { size: 8.5 });
  $('socHeat').innerHTML = o;
  const days = (S.daily ?? []).slice(-30).filter(d => d.socMax != null);
  if (!days.length) { $('socStats').innerHTML = '<div><span>Battery history</span><b>loading…</b><em>backfilling from Tesla</em></div>'; return; }
  const full = days.filter(d => d.socMax >= 99).length, atRes = days.filter(d => d.socMin <= reserve + .5).length, avgMax = days.reduce((a, d) => a + d.socMax, 0) / days.length;
  const cyc = days.reduce((a, d) => a + (d.discharge ?? 0), 0) / days.length / (S.now?.site?.capacityKwh || 27);
  $('socStats').innerHTML = `<div><span>Reached 100%</span><b>${full} of ${days.length}</b><em>days</em></div><div><span>Typical daily peak</span><b>${Math.round(avgMax)}%</b><em>average high</em></div>
    <div><span>Hit the ${reserve}% reserve</span><b>${atRes} of ${days.length}</b><em>days</em></div><div><span>Cycles per day</span><b>${cyc.toFixed(2)}</b><em>30-day average</em></div>`;
}

/* ---------- records ---------- */
export function drawRecords(S) {
  const R = S.records; if (!R) return;
  $('recSince').textContent = `since ${niceDate(R.totals.since, { month: 'short', year: 'numeric' })}`;
  const cell = (label, v, sub) => `<div><span>${label}</span><b>${v}</b><em>${sub}</em></div>`;
  $('records').innerHTML = cell('Best solar day', `${R.bestSolarDay.kwh} kWh`, niceDate(R.bestSolarDay.date, { month: 'short', day: 'numeric', year: 'numeric' })) +
    cell('Biggest usage day', `${R.biggestUsageDay.kwh} kWh`, niceDate(R.biggestUsageDay.date, { month: 'short', day: 'numeric', year: 'numeric' })) +
    cell('Lowest PEC day', `${R.lowestImportDay.kwh} kWh`, niceDate(R.lowestImportDay.date, { month: 'short', day: 'numeric', year: 'numeric' })) +
    cell('Solar produced', `${(R.totals.solar / 1000).toFixed(1)} MWh`, `since ${niceDate(R.totals.since, { month: 'short', year: 'numeric' })}`) +
    cell('Longest outage', R.longestOutage ? fmtDur(R.longestOutage.duration_s / 3600) : '—', R.longestOutage ? niceDate(R.longestOutage.ts.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' }) : '') +
    cell('CO₂ avoided', `${(R.totals.solar * .37 / 1000).toFixed(1)} t`, 'at ERCOT’s average mix');
}

/* ---------- outages ---------- */
export function drawOutages(S) {
  const O = S.outages ?? [], yearAgo = addDays(localDate(), -365), recent = O.filter(o => o.ts.slice(0, 10) >= yearAgo);
  const total = recent.reduce((a, o) => a + o.duration_s, 0) / 3600;
  $('outTitle').textContent = recent.length ? 'Your home stayed on' : 'No outages this year';
  $('outBadge').textContent = `${recent.length} in 12 months`;
  $('outText').textContent = recent.length ? `The grid dropped ${recent.length} time${recent.length > 1 ? 's' : ''} in the last 12 months, ${fmtDur(total)} in total. Your Powerwalls took over each time.` : 'Tesla has no grid outages on record for the last 12 months.';
  const months = Array.from({ length: 12 }, (_, i) => addDays(yearAgo, i * 30.4).slice(0, 7));
  let s = '<line x1="6" x2="304" y1="28" y2="28" stroke="rgba(255,255,255,.1)"/>';
  months.forEach((m, i) => s += svgText(6 + i * 24.8 + 12, 58, new Date(m + '-15').toLocaleDateString('en-US', { month: 'narrow' }), { anchor: 'middle' }));
  recent.forEach(o => { const f = (Date.parse(o.ts) - Date.parse(yearAgo)) / (365 * 864e5), r = 3 + Math.sqrt(o.duration_s / 3600) * 5;
    s += `<circle cx="${6 + f * 298}" cy="28" r="${r}" fill="#ff5a4e" fill-opacity=".3" stroke="#ff5a4e"><title>${o.ts.slice(0, 16).replace('T', ' ')} · ${fmtDur(o.duration_s / 3600)}</title></circle>`; });
  $('outStrip').innerHTML = s;
  $('outList').innerHTML = O.slice(0, 8).map(o => { const d = new Date(o.ts);
    return `<div class="ev"><div class="d">${d.toLocaleDateString('en-US', { month: 'short' })}<b>${d.getDate()}</b></div><div class="m"><b>${d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric' })}</b><br>${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · Powerwalls kept the home running</div><div class="t">${fmtDur(o.duration_s / 3600)}</div></div>`; }).join('') || '<div class="empty">No outages on record.</div>';
}

/* ---------- bills ---------- */
/** Every saved bill, newest first; tap one for details and to remove it. */
function drawBillList(S) {
  const R = (S.reconcile ?? []).slice().reverse();
  $('billCount').textContent = `${R.length} saved`;
  $('billList').innerHTML = R.length ? R.map(r => { const ok = r.checks.every(c => c.ok);
    if (S.guest) return `<div class="bill" style="cursor:default"><div class="bm"><b>${niceDate(r.billDate, { month: 'long', year: 'numeric' })}</b><br>${niceDate(r.period.from)} – ${niceDate(r.period.to)} · ${r.pec.deliveredKwh.toLocaleString()} kWh bought · ${(r.pec.receivedKwh ?? 0).toLocaleString()} sent</div>
      <div class="bt">${veil()}<small style="color:${ok ? 'var(--batt)' : 'var(--warn)'}">${ok ? '✓ matches Tesla' : '! check'}</small></div></div>`;   // no detail sheet for a guest
    return `<div class="bill" data-bill="${r.billDate}"><div class="bm"><b>${niceDate(r.billDate, { month: 'long', year: 'numeric' })}</b><br>${niceDate(r.period.from)} – ${niceDate(r.period.to)} · ${r.pec.deliveredKwh.toLocaleString()} kWh bought</div>
      <div class="bt">${money2(r.total)}<small style="color:${ok ? 'var(--batt)' : 'var(--warn)'}">${ok ? '✓ matches Tesla' : '! check'}</small></div></div>`; }).join('')
    : '<div class="empty">No bills yet.</div>';
  document.querySelectorAll('[data-bill]').forEach(el => el.onclick = () => openBillDetail(S, R.find(r => r.billDate === el.dataset.bill)));
}

function openBillDetail(S, r) {
  $('sheetBody').innerHTML = `<div class="shead"><h4>${niceDate(r.billDate, { month: 'long', year: 'numeric' })} bill</h4><button class="x" id="sheetX" aria-label="Close">×</button></div>
    <p class="sub">${niceDate(r.period.from)} – ${niceDate(r.period.to)} · ${r.period.days} days</p>
    <table class="btable">
      <tr><td>Bought from PEC</td><td>${r.pec.deliveredKwh.toLocaleString()} kWh</td></tr><tr><td>Sent to PEC</td><td>${r.pec.receivedKwh} kWh</td></tr>
      <tr><td>Tesla measured bought / sent</td><td>${r.tesla.importKwh == null ? '—' : Math.round(r.tesla.importKwh).toLocaleString()} / ${r.tesla.exportKwh == null ? '—' : Math.round(r.tesla.exportKwh)} kWh</td></tr>
      ${r.charges.map(c => `<tr><td>${c.label}${c.kwh ? ` · ${c.kwh.toLocaleString()} kWh @ $${c.rate}` : ''}</td><td>${money2(c.amount)}</td></tr>`).join('')}
      <tr><td><b style="color:var(--text)">Total</b></td><td><b>${money2(r.total)}</b></td></tr></table>
    <button class="danger" id="billRemove">Remove this bill</button>`;
  $('phone').classList.add('open');
  $('sheetX').onclick = () => $('phone').classList.remove('open');
  $('billRemove').onclick = async () => {
    if (!confirm(`Remove the ${niceDate(r.billDate, { month: 'long', year: 'numeric' })} bill? You can add it again from the PDF.`)) return;
    await api.deleteBill(r.billDate);
    $('phone').classList.remove('open');
    toast('✓', 'rgba(255,255,255,.12)', 'Bill removed', `${niceDate(r.billDate, { month: 'long', year: 'numeric' })} · ${money2(r.total)}`);
    S.reconcile = await api.reconcile(); S.tariff = S.reconcile.findLast(x => x.tariff?.importRateAllIn > 0)?.tariff ?? null; drawBills(S);
  };
}

export function drawBills(S) {
  drawBillList(S);
  const R = S.reconcile ?? [], last = R.at(-1);
  if (!last) { $('billChecks').innerHTML = '<div class="card"><div class="empty">No PEC bills yet. Add one to compare it with Tesla.</div></div>'; return; }
  const cov = last.coverage < .95 ? `<div class="flag">Tesla has only ${Math.round(last.coverage * 100)}% of this period stored so far.</div>` : '';
  const yoy = last.lastYear?.homeKwh ? (() => { const h = last.tesla.homeKwh, ph = last.lastYear.homeKwh, s = last.tesla.solarKwh, ps = last.lastYear.solarKwh;
    return `<div class="check"><i class="${Math.abs(h / ph - 1) > .1 ? 'wa' : 'ok'}">${Math.abs(h / ph - 1) > .1 ? '!' : '✓'}</i><div><b>Versus the same dates last year:</b> home use ${h >= ph ? '+' : ''}${Math.round((h / ph - 1) * 100)}%, solar ${s >= ps ? '+' : ''}${Math.round((s / ps - 1) * 100)}%, bought from PEC ${last.tesla.importKwh >= last.lastYear.importKwh ? '+' : ''}${Math.round((last.tesla.importKwh / last.lastYear.importKwh - 1) * 100)}%.</div></div>`; })() : '';
  $('billChecks').innerHTML = `<div class="card"><div class="h"><b>${niceDate(last.billDate, { month: 'long' })} bill check</b><span class="badge ${last.checks.every(c => c.ok) ? 'g' : ''}">${last.checks.every(c => c.ok) ? 'all good' : 'look at this'}</span></div>
    <div style="margin-top:8px">${last.checks.map(c => `<div class="check"><i class="${c.ok ? 'ok' : 'al'}">${c.ok ? '✓' : '!'}</i><div><b>${c.label}.</b> ${c.detail}</div></div>`).join('')}${yoy}</div>${cov}
    <div class="kv"><span>${niceDate(last.period.from)} – ${niceDate(last.period.to)} · total</span><b>${S.guest ? veil() : money2(last.total)}</b>
    <span>Your rate, all-in</span><b>${S.guest ? veil('$•.••••/kWh') : last.tariff ? `$${last.tariff.importRateAllIn.toFixed(4)}/kWh` : '—'}</b><span>Solar + Powerwall covered</span><b style="color:var(--batt)">${last.solarShareOfHome ?? '—'}% of home use</b>
    <span>Without solar it would have been</span><b>${S.guest ? veil() : money2(last.withoutSolarCost)}</b></div></div>`;

  // meter vs Tesla per bill
  const mx = Math.max(1, ...R.flatMap(r => [r.pec.deliveredKwh, r.tesla.importKwh ?? 0])) * 1.1, bw = Math.min(46, 280 / R.length);
  let s = '';
  R.forEach((r, i) => { const x = 26 + i * (bw + 8), h1 = r.pec.deliveredKwh / mx * 100, h2 = (r.tesla.importKwh ?? 0) / mx * 100, bad = r.importGapPct != null && Math.abs(r.importGapPct) > 5;
    s += `<rect x="${x}" y="${112 - h1}" width="${bw}" height="${h1}" rx="5" fill="${bad ? 'rgba(255,90,78,.35)' : 'rgba(196,162,255,.28)'}"/><rect x="${x + bw * .28}" y="${112 - h2}" width="${bw * .44}" height="${h2}" rx="3" fill="#c4a2ff"/>`;
    s += svgText(x + bw / 2, 108 - Math.max(h1, h2), r.importGapPct == null ? '' : `${r.importGapPct > 0 ? '+' : ''}${r.importGapPct}%`, { anchor: 'middle', fill: bad ? '#ff8a80' : 'rgba(242,244,248,.6)', size: 9 });
    s += svgText(x + bw / 2, 128, niceDate(r.billDate, { month: 'short' }), { anchor: 'middle' }); });
  s += svgText(26, 146, 'Within ±5% means PEC billed what Tesla measured.', { size: 9, font: 'Manrope' });
  $('meterChart').innerHTML = s;
  if (S.guest) return lockBillCards(S, last);   // the three money cards: locked for guests (views/guest.js)

  // waterfall for the latest bill
  const t = last.tesla, bt = last.tariff, T = S.tariff, rate = T?.importRateAllIn, fixed = (T?.fixedMonthly ?? 0) + (T?.discounts ?? 0);
  if (t.homeKwh != null && bt) { // this bill's own rates; a bill saved without rates gets no waterfall
    const direct = Math.max(0, t.homeKwh - t.importKwh - (t.dischargeKwh ?? 0));
    const steps = [['Without solar', last.withoutSolarCost, 'base'], ['Solar used directly', -direct * bt.importRateAllIn], ['Powerwall at night', -(t.dischargeKwh ?? 0) * bt.importRateAllIn], ['Export credit', -(t.exportKwh ?? 0) * (bt.exportCredit ?? 0)], ['PEC bill', last.total, 'end']];
    const top = Math.max(...steps.map(s => Math.abs(s[1]))) * 1.05, X = v => 118 + v / top * 180; let w = '', run = 0;
    steps.forEach(([label, v, kind], i) => { const y = 8 + i * 36; let a, b, c;
      if (kind === 'base') { a = 0; b = v; run = v; c = 'rgba(255,255,255,.25)'; } else if (kind === 'end') { a = 0; b = v; c = '#4ef0a6'; } else { a = run + v; b = run; run += v; c = '#ffc15e'; }
      w += svgText(0, y + 15, label, { size: 11, fill: 'rgba(242,244,248,.7)', font: 'Manrope' }) + `<rect x="${X(Math.min(a, b))}" y="${y + 4}" width="${Math.max(2, Math.abs(X(b) - X(a)))}" height="16" rx="4" fill="${c}"/>`;
      const right = X(Math.max(a, b)) > 250; w += svgText(right ? X(Math.min(a, b)) - 5 : X(Math.max(a, b)) + 4, y + 16, `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(0)}`, { size: 10.5, fill: '#f2f4f8', anchor: right ? 'end' : 'start' }); });
    $('waterfall').innerHTML = w;
    $('wfNote').textContent = `${niceDate(last.period.from)} – ${niceDate(last.period.to)}`;
  } else $('waterfall').innerHTML = '';

  // this billing cycle
  const from = last.period.to, to = addDays(from, 31), today = localDate(), el = Math.max(1, (Date.parse(today) - Date.parse(from)) / 864e5);
  const soFar = (S.daily ?? []).filter(d => d.date >= from && d.date <= today), imp = soFar.reduce((a, d) => a + d.import, 0), exp = soFar.reduce((a, d) => a + d.export, 0);
  const proj = rate != null ? fixed + (imp * rate - exp * (T.exportCredit ?? 0)) * 31 / el : null;
  const lyImp = (S.daily ?? []).filter(d => d.date >= addDays(from, -365) && d.date <= addDays(today, -365)).reduce((a, d) => a + d.import, 0);
  $('cycBar').style.width = Math.min(100, el / 31 * 100) + '%'; $('cycFrom').textContent = niceDate(from); $('cycTo').textContent = niceDate(to);
  $('cycNote').textContent = `day ${Math.round(el)} of ~31`;
  $('cycKv').innerHTML = `<span>Bought from PEC so far</span><b>${Math.round(imp)} kWh</b><span>Sent to PEC so far</span><b>${Math.round(exp)} kWh</b>
    <span>Projected bill</span><b>${money(proj)}</b><span>Same dates last year</span><b>${lyImp ? `${Math.round(lyImp)} kWh bought` : '—'}</b>`;

  // monthly estimated cost
  const M = rate != null ? (S.monthly ?? []).slice(-12) : [], top = Math.max(1, ...M.map(m => fixed + m.home * rate)) * 1.05; // no rate: no dollar bars
  let b = '';
  M.forEach((m, i) => { const x = 6 + i * 25.5, wo = fixed + m.home * rate, paid = fixed + m.import * rate - m.export * (T.exportCredit ?? 0), h1 = wo / top * 98, h2 = Math.max(0, paid) / top * 98;
    b += `<rect x="${x}" y="${104 - h1}" width="19" height="${h1}" rx="5" fill="rgba(255,255,255,.13)"><title>${m.month}: without solar $${wo.toFixed(0)}</title></rect><rect x="${x + 4}" y="${104 - h2}" width="11" height="${h2}" rx="3" fill="#ffc15e"><title>paid ≈ $${paid.toFixed(0)}</title></rect>` +
      svgText(x + 9.5, 120, new Date(m.month + '-15').toLocaleDateString('en-US', { month: 'narrow' }), { anchor: 'middle' }); });
  $('billChart').innerHTML = b;
}

/* ---------- add-a-bill sheet ---------- */
export function openBillSheet(S, refresh) {
  const body = $('sheetBody');
  body.innerHTML = `<div class="shead"><h4>Add a PEC bill</h4><button class="x" id="sheetX" aria-label="Close">×</button></div>
    <p class="sub">Download the bill PDF from SmartHub or myPEC.com and drop it here. Solstice reads the numbers from it and keeps only those. The PDF itself isn't stored.</p>
    <label class="drop" id="drop"><b>Drop the bill PDF</b> or tap to choose<input type="file" accept="application/pdf" id="billFile" hidden></label>
    <div id="billPreview"></div>`;
  $('phone').classList.add('open');
  $('sheetX').onclick = () => $('phone').classList.remove('open');
  const handle = async file => {
    $('billPreview').innerHTML = '<p class="sub">Reading the bill…</p>';
    try {
      const bill = await api.parseBill(file);
      const ok = bill.checks?.lineItemsSumToTotal && bill.checks?.registersConsistent;
      $('billPreview').innerHTML = `<table class="btable">
        <tr><td>Billing period</td><td>${niceDate(bill.period.from)} – ${niceDate(bill.period.to)} (${bill.period.days} days)</td></tr>
        <tr><td>Bought from PEC</td><td>${bill.deliveredKwh.toLocaleString()} kWh</td></tr><tr><td>Sent to PEC</td><td>${bill.receivedKwh} kWh</td></tr>
        ${bill.charges.map(c => `<tr><td>${c.label}${c.kwh ? ` · ${c.kwh.toLocaleString()} kWh @ $${c.rate}` : ''}</td><td>${money2(c.amount)}</td></tr>`).join('')}
        <tr><td><b style="color:var(--text)">Total</b></td><td><b>${money2(bill.total)}</b></td></tr></table>
        <p class="${ok ? 'sub' : 'err'}">${ok ? '✓ The line items add up and the meter readings are consistent.' : "⚠ Some numbers didn't add up. Check them against the PDF before saving."}</p>
        <div class="row2"><button class="ghost" id="billCancel">Cancel</button><button class="primary" id="billSave" style="margin-top:0">Save bill</button></div>`;
      $('billCancel').onclick = () => $('phone').classList.remove('open');
      $('billSave').onclick = async () => { await api.saveBill(bill); $('phone').classList.remove('open'); toast('$', 'rgba(255,193,94,.2)', 'Bill saved', `${niceDate(bill.billDate, { month: 'long' })} · ${money2(bill.total)}. Checking it against Tesla now`); refresh(); };
    } catch (e) { $('billPreview').innerHTML = `<p class="err">${e.message}</p>`; }
  };
  $('billFile').onchange = e => e.target.files[0] && handle(e.target.files[0]);
  const drop = $('drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('hot'); };
  drop.ondragleave = () => drop.classList.remove('hot');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hot'); const f = e.dataTransfer.files[0]; if (f) handle(f); };
}
