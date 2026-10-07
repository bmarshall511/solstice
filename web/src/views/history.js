import { $, clamp, fmtDur, clock12, niceDate, localDate, addDays, svgText, path, money, money2, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { yearRingCard, yearModel } from '../scenes/yearring.js';
import { createFlowsCard, mountFlows } from '../scenes/flows.js';
import { veil, esc } from '../lib/frost.js';
import { lockBillCards } from './guest.js';
import { badge } from '../lib/conf.js';
import { jumpTarget, scrollFor } from '../lib/sysui.js';
import { tileDelta, sumUntil } from '../lib/nowui.js';
import { tileHtml, segSet, sheet, sheetHead, sheetFoot, closeSheet } from './csheet.js';

let range = 'day', day = null;

/* ---------- Day: radial 24h ---------- */
async function drawDay(S) {
  day ??= localDate();
  const d = await api.day(day), svg = $('hchart'), r0 = 62, rs = 88;
  svg.setAttribute('viewBox', '-165 -165 330 330'); svg.setAttribute('height', 310);
  $('dayLabel').textContent = (day === localDate() ? 'Today' : niceDate(day, { weekday: 'short', month: 'short', day: 'numeric' })) + ((S.daily ?? []).find(r => r.date === day)?.trip ? ' \u00b7 trip' : '');   // mockup ak: a trip day
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
  const t = d.totals, self = t.home ? Math.round(clamp(1 - t.import / t.home, 0, 1) * 100) : 0;
  o += svgText(0, -4, `${self}%`, { size: 28, fill: '#f2f4f8', anchor: 'middle', font: 'Manrope', weight: 300 }) + svgText(0, 15, 'solar + battery', { size: 10.5, fill: 'rgba(242,244,248,.5)', anchor: 'middle', font: 'Manrope' });
  svg.innerHTML = o;
  const f1 = v => v == null ? '—' : v.toFixed(1);
  $('hleg').innerHTML = `<span class="c-acc-solar"><i></i>Solar <b>${f1(t.solar)}</b></span><span class="c-acc-home"><i></i>Home <b>${f1(t.home)}</b></span><span class="c-acc-grid"><i></i>From PEC <b>${f1(t.import)}</b></span><span class="c-acc-batt"><i></i>Battery %</span>`;
  const rate = S.tariff?.importRateAllIn, credit = S.tariff?.exportCredit, today = localDate();
  // the comparison: today against yesterday at the same time; an earlier day against the day before it (both whole)
  const prev = day === today ? (S.yday?.date === addDays(today, -1) ? sumUntil(S.yday, (Date.now() - Date.parse(`${today}T00:00:00`)) / 36e5) : null) : (S.daily ?? []).find(r => r.date === addDays(day, -1)) ?? null;
  const week = (S.daily ?? []).filter(r => r.date <= day).slice(-7);
  S.histDay = { date: day, charge: t.charge, discharge: t.discharge };
  // B2-12: the server's peaks leave out Tesla's inflated solar buckets (a guest's hourly view has none)
  $('hstats').innerHTML = stat('hsSol', 'c-acc-solar', 'Solar produced', t.solar, `peak ${(d.peaks?.solarKw ?? Math.max(0, ...B.map(b => b.solar))).toFixed(1)} kW`, tileDelta(t.solar, prev?.solar ?? null, 'up'), week.map(r => r.solar))
    + stat('hsHome', 'c-acc-home', 'Home used', t.home, `${self}% from solar + battery`, tileDelta(t.home, prev?.home ?? null, 'down'), week.map(r => r.home))
    + stat('hsImp', 'c-acc-grid', 'Bought from PEC', t.import, S.guest ? `≈ ${veil('$•.••')}` : rate != null ? `≈ $${((t.import ?? 0) * rate).toFixed(2)}` : '', tileDelta(t.import, prev?.import ?? null, 'down'), week.map(r => r.import))
    + stat('hsExp', 'c-acc-batt', 'Sent to PEC', t.export, S.guest ? `≈ ${veil('$•.••')} credit` : credit != null && t.export ? `≈ $${((t.export ?? 0) * credit).toFixed(2)} credit` : '', tileDelta(t.export, prev?.export ?? null, 'up'), week.map(r => r.export));
  drawSocStats(S);
}
/** One History tile: kWh (MWh from 1,000), a note, the delta chip and the sparkline. */
const stat = (id, acc, label, v, note, chip, spark) => tileHtml({ id, acc, k: label, v: v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(1) : v.toFixed(1), unit: v >= 1000 ? 'MWh' : 'kWh', note, chip, spark });

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
    o += `<rect x="${x + bw * .12}" y="${H - 30 - h1}" width="${w}" height="${h1}" rx="${Math.min(4, w / 2)}" fill="#ffc15e"><title>${esc(r.date ?? r.month)}: solar ${r.solar.toFixed(0)} kWh</title></rect>`;
    o += `<rect x="${x + bw * .12 + w + 1.5}" y="${H - 30 - h2}" width="${w}" height="${h2}" rx="${Math.min(4, w / 2)}" fill="#6cc4ff" fill-opacity=".75"><title>home ${r.home.toFixed(0)} kWh</title></rect>`;
    if (outageDays.has(r.date ?? r.month)) o += `<circle cx="${x + bw / 2}" cy="${H - 34 - Math.max(h1, h2) - 8}" r="3.5" fill="#ff5a4e"/>`;
    o += svgText(x + bw / 2, H - 12, label(r, i), { size: 10, anchor: 'middle' }); });
  o += svgText(10, 8, range === 'year' ? 'kWh / month' : 'kWh / day', { font: 'Manrope' });
  svg.innerHTML = o;
  $('hleg').innerHTML = `<span class="c-acc-solar"><i></i>Solar</span><span class="c-acc-home"><i></i>Home</span><span class="c-acc-out"><i></i>Outage</span>`;
  const sum = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0), rate = S.tariff?.importRateAllIn, credit = S.tariff?.exportCredit;
  // the comparison: the same number of days just before (Week and Month); the year has none
  const n = rows.length, before = range === 'year' ? [] : (S.daily ?? []).slice(-2 * n, -n), was = k => before.length === n ? before.reduce((a, r) => a + (r[k] ?? 0), 0) : null;
  const ch = (k, better) => tileDelta(sum(k), was(k), better);
  $('hstats').innerHTML = stat('hsSol', 'c-acc-solar', 'Solar produced', sum('solar'), `${Math.round(sum('solar') / sum('home') * 100)}% of home use`, ch('solar', 'up'), rows.map(r => r.solar))
    + stat('hsHome', 'c-acc-home', 'Home used', sum('home'), `${(sum('home') / (range === 'year' ? 365 : rows.length)).toFixed(0)} kWh/day avg`, ch('home', 'down'), rows.map(r => r.home))
    + stat('hsImp', 'c-acc-grid', 'Bought from PEC', sum('import'), S.guest ? `≈ ${veil()}` : rate != null ? `≈ $${Math.round(sum('import') * rate)}` : '', ch('import', 'down'), rows.map(r => r.import))
    + stat('hsExp', 'c-acc-batt', 'Sent to PEC', sum('export'), S.guest ? `≈ ${veil()} credit` : credit != null ? `≈ $${Math.round(sum('export') * credit)} credit` : '', ch('export', 'up'), rows.map(r => r.export));
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
  segSet($('hseg'), 'day', 'data-r');
  drawHistoryChart(S); $('screen').scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- m-flows: "Where every kWh went", for Day and Month (scenes/flows.js). Mockup al frame 14: collapsed to one stacked bar
   (pool · AC · everything else) and "3D flow", which builds the Sankey scene only when asked. Owner only (/api/flows). ---------- */
let flowsCard = null, flowsView = null, flowsSeq = 0, flowsOpen = false;
async function drawFlows(S) {
  const today = localDate(), date = range === 'day' ? day ?? today : today, key = `${range}|${date}`, seq = ++flowsSeq, box = $('flowSum');
  box.hidden = S.guest || (range !== 'day' && range !== 'month');
  if (box.hidden) { flowsView?.dispose(); flowsView = null; return; }
  const hit = (S.flowsCache ??= {})[key], fresh = hit && (Date.now() - hit.at < 5 * 60e3 || (range === 'day' && date < today));
  let data;
  try { data = fresh ? hit.data : (S.flowsCache[key] = { at: Date.now(), data: await api.flows(range, date) }).data; }
  catch (e) { if (seq === flowsSeq) { $('flowFig').textContent = '—'; $('flowDl').innerHTML = '<span>Could not load where the energy went.</span>'; } return; }
  if (seq !== flowsSeq) return;
  const H = data.home ?? {}, pool = H.pool?.kwh ?? 0, ac = H.ac?.kwh ?? 0, rest = H.rest ?? 0, tot = (data.totals?.home ?? pool + ac + rest) || 1, f1 = v => (Math.round(v * 10) / 10).toFixed(1);
  $('flowFig').textContent = `${f1(data.totals?.home ?? pool + ac + rest)} kWh`;
  $('flowStack').innerHTML = [['c-acc-pool', pool], ['c-acc-ac', ac], ['c-acc-mute', rest]].map(([c, v]) => v > 0 ? `<i class="${c}" style="width:${(v / tot * 100).toFixed(1)}%"></i>` : '').join('');
  $('flowDl').innerHTML = `<span class="c-acc-pool"><i></i>Pool <b>${f1(pool)}</b></span><span class="c-acc-ac"><i></i>AC <b>${f1(ac)}</b></span><span class="c-acc-mute"><i></i>Everything else <b>${f1(rest)}</b></span>`;
  if (!flowsOpen) { flowsView?.dispose(); flowsView = null; return; }
  if (flowsView?.alive() && flowsView.key === key && flowsView.data === data) return;   // already showing it
  flowsCard ??= $('flowHost').appendChild(createFlowsCard());
  const sel = flowsView?.key === key ? flowsView.sel() : null;
  flowsView?.dispose();
  flowsView = Object.assign(mountFlows(flowsCard, data, { title: range === 'month' ? 'Last 30 days' : date === today ? 'Today' : niceDate(date, { weekday: 'short', month: 'short', day: 'numeric' }), today, calm: () => S.calm, sel }), { key, data });
}

export function initHistory(S) {
  $('hseg').onclick = e => { const b = e.target.closest('[data-r]'); if (!b) return; segSet($('hseg'), b.dataset.r, 'data-r'); range = b.dataset.r; drawHistoryChart(S); };
  // mockup al frame 14: the jump chips scroll to their section
  $('hjumps').onclick = e => { const b = e.target.closest('[data-j]'), el = b && $(jumpTarget(b.dataset.j)); if (!el) return;
    const sc = $('screen'); sc.scrollTo({ top: scrollFor(el.getBoundingClientRect().top, sc.getBoundingClientRect().top, sc.scrollTop, 12), behavior: S.calm ? 'auto' : 'smooth' }); };
  $('flow3d').onclick = () => { flowsOpen = !flowsOpen; $('flowHost').hidden = !flowsOpen; $('flow3d').setAttribute('aria-expanded', String(flowsOpen)); $('flow3d').textContent = flowsOpen ? 'Hide the 3D flow' : '3D flow'; drawFlows(S); };
  $('billSeg').onclick = e => { const b = e.target.closest('[data-b]'); if (!b) return; segSet($('billSeg'), b.dataset.b, 'data-b'); document.querySelectorAll('#billAnalysis [data-pane]').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.b; }); };
  $('recAll').onclick = () => openRecords(S); $('outAll').onclick = () => openOutages(S); $('billAll').onclick = () => openBills(S);
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
  rows.forEach((r, d) => r.forEach((v, h) => { if (v == null) return; o += `<rect x="${22 + h * 11.9}" y="${4 + d * ch}" width="11.4" height="${Math.max(1, ch - .6)}" rx="1.2" fill="${v <= reserve + .5 ? '#ff7a66' : col(v)}"><title>${esc(G.dates[d])} ${clock12(h)}: ${Math.round(v)}%</title></rect>`; }));
  [0, 6, 12, 18].forEach(h => o += svgText(22 + h * 11.9, 188, ['12a', '6a', '12p', '6p'][h / 6], { size: 9 }));
  o += svgText(0, 12, niceDate(G.dates[0]).split(' ')[1], { size: 8.5 }) + svgText(0, 180, 'today', { size: 8.5 });
  $('socHeat').innerHTML = o;
  drawSocStats(S);
}
/** Charge level's rows (mockup al frame 14): reserve, the shown day's range and in/out, then the 30-day figures. */
function drawSocStats(S) {
  const reserve = S.now?.site?.reservePct ?? 20, days = (S.daily ?? []).slice(-30).filter(d => d.socMax != null), shown = day ?? localDate();
  const dd = (S.daily ?? []).find(d => d.date === shown), hd = S.histDay?.date === shown ? S.histDay : null, f1 = v => v == null ? '—' : v.toFixed(1);
  const rows = [['Reserve', `${reserve}%`], [`${shown === localDate() ? 'Today' : niceDate(shown, { weekday: 'short', month: 'short', day: 'numeric' })}’s range`, dd?.socMin != null ? `${Math.round(dd.socMin)}–${Math.round(dd.socMax)}%` : '—'],
    ['Charged · discharged', hd ? `${f1(hd.charge)} · ${f1(hd.discharge)} kWh` : dd ? `${f1(dd.charge)} · ${f1(dd.discharge)} kWh` : '—']];
  if (days.length) {
    const full = days.filter(d => d.socMax >= 99).length, atRes = days.filter(d => d.socMin <= reserve + .5).length, avgMax = days.reduce((a, d) => a + d.socMax, 0) / days.length;
    const cyc = days.reduce((a, d) => a + (d.discharge ?? 0), 0) / days.length / (S.now?.site?.measuredKwh || S.now?.site?.capacityKwh || 27);   // mockup af: a cycle = what a full charge really delivers
    rows.push(['Reached 100%', `${full} of ${days.length} days`], ['Typical daily peak', `${Math.round(avgMax)}%`], [`Hit the ${reserve}% reserve`, `${atRes} of ${days.length} days`], ['Cycles per day · 30 days', cyc.toFixed(2)]);
  } else rows.push(['Battery history', 'backfilling from Tesla']);
  $('socStats').innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
}

/* ---------- records ---------- */
export function drawRecords(S) {
  const R = S.records; if (!R?.totals) return;
  const d = x => niceDate(x, { month: 'short', day: 'numeric', year: 'numeric' });
  // mockup al frame 14: two tiles, the rest behind "All records"
  $('records').innerHTML = tileHtml({ id: 'recSol', acc: 'c-acc-solar', k: 'Best solar day', v: R.bestSolarDay.kwh, unit: 'kWh', chip: { t: 'flat', text: niceDate(R.bestSolarDay.date, { month: 'short', day: 'numeric' }) } })
    + tileHtml({ id: 'recUse', acc: 'c-acc-home', k: 'Highest use', v: R.biggestUsageDay.kwh, unit: 'kWh', chip: { t: 'flat', text: niceDate(R.biggestUsageDay.date, { month: 'short', day: 'numeric' }) } });
  S.recordRows = [['Best solar day', `${R.bestSolarDay.kwh} kWh`, d(R.bestSolarDay.date)], ['Biggest usage day', `${R.biggestUsageDay.kwh} kWh`, d(R.biggestUsageDay.date)], ['Lowest PEC day', `${R.lowestImportDay.kwh} kWh`, d(R.lowestImportDay.date)],
    ['Solar produced', `${(R.totals.solar / 1000).toFixed(1)} MWh`, `since ${niceDate(R.totals.since, { month: 'short', year: 'numeric' })}`],
    ['Longest outage', R.longestOutage ? fmtDur(R.longestOutage.duration_s / 3600) : '—', R.longestOutage ? d(R.longestOutage.ts.slice(0, 10)) : ''], ['CO₂ avoided', `${(R.totals.solar * .37 / 1000).toFixed(1)} t`, 'at ERCOT’s average mix']];
  $('recAll').textContent = `All ${S.recordRows.length}`;
}
function openRecords(S) {
  const rows = S.recordRows ?? [];
  sheet(`${sheetHead('Records', '', S.records?.totals ? `since ${niceDate(S.records.totals.since, { month: 'short', year: 'numeric' })}` : '')}<div class="c-card"><div class="c-kv">${rows.map(([a, b, c]) => `<span>${a}${c ? `<br><small class="c-cap">${c}</small>` : ''}</span><b>${b}</b>`).join('')}</div></div>${sheetFoot('', 'Done')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
}

/* ---------- outages ---------- */
const outRow = o => { const d = new Date(o.ts);
  return `<div class="c-tl-e c-k-warn"><time>${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</time><i></i><p>Grid down · Powerwalls carried the house<small>${d.toLocaleDateString('en-US', { weekday: 'short' })}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${fmtDur(o.duration_s / 3600)}</small></p></div>`; };
export function drawOutages(S) {
  const O = S.outages ?? [], yearAgo = addDays(localDate(), -365), recent = O.filter(o => o.ts.slice(0, 10) >= yearAgo);
  // mockup al frame 14: the newest three on the timeline, every one (with the 12-month strip) behind "All"
  $('outBadge').innerHTML = badge('', `${recent.length} in 12 months`);
  $('outList').innerHTML = O.length ? `<div class="c-tl-g">${O.slice(0, 3).map(outRow).join('')}</div>` : '<p class="c-sum">No outages on record.</p>';
  $('outAll').textContent = `All ${O.length}`; $('outAll').parentElement.hidden = O.length <= 3;
}
function openOutages(S) {
  const O = S.outages ?? [], yearAgo = addDays(localDate(), -365), recent = O.filter(o => o.ts.slice(0, 10) >= yearAgo), total = recent.reduce((a, o) => a + o.duration_s, 0) / 3600;
  const months = Array.from({ length: 12 }, (_, i) => addDays(yearAgo, i * 30.4).slice(0, 7));
  let s = '<line x1="6" x2="304" y1="28" y2="28" style="stroke:var(--c-line)"/>';
  months.forEach((m, i) => s += svgText(6 + i * 24.8 + 12, 58, new Date(m + '-15').toLocaleDateString('en-US', { month: 'narrow' }), { anchor: 'middle' }));
  recent.forEach(o => { const f = (Date.parse(o.ts) - Date.parse(yearAgo)) / (365 * 864e5), r = 3 + Math.sqrt(o.duration_s / 3600) * 5;
    s += `<circle cx="${6 + f * 298}" cy="28" r="${r}" style="fill:var(--out);stroke:var(--out)" fill-opacity=".3"><title>${esc(o.ts.slice(0, 16).replace('T', ' '))} · ${fmtDur(o.duration_s / 3600)}</title></circle>`; });
  sheet(`${sheetHead(recent.length ? 'Your home stayed on' : 'No outages this year', badge('', `${recent.length} in 12 months`))}
    <p class="c-sheet-sub">${recent.length ? `The grid dropped ${recent.length} time${recent.length > 1 ? 's' : ''} in the last 12 months, ${fmtDur(total)} in total. Your Powerwalls took over each time.` : 'Tesla has no grid outages on record for the last 12 months.'}</p>
    <svg class="mini" viewBox="0 0 310 64" aria-label="Outages over the last 12 months">${s}</svg>
    <div class="c-tl"><div class="c-tl-g">${O.map(outRow).join('')}</div></div>${sheetFoot('', 'Done', 'c-acc-out')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
}

/* ---------- bills ---------- */
/** Your bills (mockup al frame 14): the newest three as rows with the check's badge and the amount; "All" lists every one. */
const billRows = (S, R) => R.map(r => { const ok = r.checks.every(c => c.ok);
  return `<div class="c-part c-acc-grid"${S.guest ? '' : ` role="button" tabindex="0" data-bill="${esc(r.billDate)}"`}><i></i><span>${niceDate(r.billDate, { month: 'long' })}${r.billDate.slice(0, 4) !== localDate().slice(0, 4) ? ` ${r.billDate.slice(0, 4)}` : ''} ${ok ? badge('', 'matches Tesla') : badge('estimated', 'check')}</span><b>${S.guest ? veil() : money2(r.total)}</b></div>`; }).join('');
function drawBillList(S) {
  const R = (S.reconcile ?? []).slice().reverse();
  $('billCount').textContent = `${R.length} saved`;
  $('billList').innerHTML = R.length ? billRows(S, R.slice(0, 3)) : '<p class="c-sum">No bills yet.</p>';
  $('billAll').textContent = `All ${R.length}`; $('billAll').hidden = R.length <= 3;
  $('billList').onclick = e => { const el = e.target.closest('[data-bill]'); if (el) openBillDetail(S, R.find(r => r.billDate === el.dataset.bill)); };
}
function openBills(S) {
  const R = (S.reconcile ?? []).slice().reverse();
  sheet(`${sheetHead('Your bills', '', `${R.length} saved · PEC`)}<div class="c-card" style="padding:4px 16px"><div class="c-parts" style="margin:0">${billRows(S, R)}</div></div>${sheetFoot(S.guest ? '' : 'Add a PEC bill', 'Done', 'c-acc-grid')}`);
  const body = $('sheetBody');
  body.querySelector('[data-f="pri"]').onclick = closeSheet;
  body.querySelector('[data-f="sec"]')?.setAttribute('data-addbill', '1');   // main.js's document listener opens the bill sheet
  body.querySelectorAll('[data-bill]').forEach(el => el.onclick = () => openBillDetail(S, R.find(r => r.billDate === el.dataset.bill)));
}

/** One bill's sheet in the component system (mockup al, component 11): its lines as a key/value card, Remove this bill as the
 *  pinned footer's one write. */
export function billDetailHtml(r) {
  return `${sheetHead(`${niceDate(r.billDate, { month: 'long', year: 'numeric' })} bill`, '', `${niceDate(r.period.from)} – ${niceDate(r.period.to)} · ${r.period.days} days`)}
    <div class="c-card" style="padding:4px 16px"><div class="c-kv">
      <span>Bought from PEC</span><b>${r.pec.deliveredKwh.toLocaleString()} kWh</b><span>Sent to PEC</span><b>${esc(r.pec.receivedKwh)} kWh</b>
      <span>Tesla measured bought / sent</span><b>${r.tesla.importKwh == null ? '—' : Math.round(r.tesla.importKwh).toLocaleString()} / ${r.tesla.exportKwh == null ? '—' : Math.round(r.tesla.exportKwh)} kWh</b>
      ${r.charges.map(c => `<span>${esc(c.label)}${c.kwh ? ` · ${c.kwh.toLocaleString()} kWh @ $${esc(c.rate)}` : ''}</span><b>${money2(c.amount)}</b>`).join('')}
      <span><b style="color:var(--text)">Total</b></span><b>${money2(r.total)}</b></div></div>
    ${sheetFoot('', 'Remove this bill', 'c-acc-out')}`;
}
function openBillDetail(S, r) {
  sheet(billDetailHtml(r));
  $('sheetBody').querySelector('[data-f="pri"]').onclick = async () => {
    if (!confirm(`Remove the ${niceDate(r.billDate, { month: 'long', year: 'numeric' })} bill? You can add it again from the PDF.`)) return;
    await api.deleteBill(r.billDate);
    closeSheet();
    toast('✓', 'rgba(255,255,255,.12)', 'Bill removed', `${niceDate(r.billDate, { month: 'long', year: 'numeric' })} · ${money2(r.total)}`);
    S.reconcile = await api.reconcile(); S.tariff = S.reconcile.findLast(x => x.tariff?.importRateAllIn > 0)?.tariff ?? null; drawBills(S);
  };
}

export function drawBills(S) {
  drawBillList(S);
  const R = S.reconcile ?? [], last = R.at(-1);
  if (!last) { $('billBadge').innerHTML = ''; $('billChecks').innerHTML = '<p class="c-sum">No PEC bills yet. Add one to compare it with Tesla.</p>'; return; }
  const cov = last.coverage < .95 ? `<p class="c-fine" style="color:var(--warn)">Tesla has only ${Math.round(last.coverage * 100)}% of this period stored so far.</p>` : '';
  const yoy = last.lastYear?.homeKwh ? (() => { const h = last.tesla.homeKwh, ph = last.lastYear.homeKwh, s = last.tesla.solarKwh, ps = last.lastYear.solarKwh;
    return `<div class="c-check"><i class="${Math.abs(h / ph - 1) > .1 ? 'todo' : ''}">${Math.abs(h / ph - 1) > .1 ? '!' : '✓'}</i><div><b>Versus the same dates last year:</b> home use ${h >= ph ? '+' : ''}${Math.round((h / ph - 1) * 100)}%, solar ${s >= ps ? '+' : ''}${Math.round((s / ps - 1) * 100)}%, bought from PEC ${last.tesla.importKwh >= last.lastYear.importKwh ? '+' : ''}${Math.round((last.tesla.importKwh / last.lastYear.importKwh - 1) * 100)}%.</div></div>`; })() : '';
  const good = last.checks.every(c => c.ok);
  $('billBadge').innerHTML = good ? badge('learned', 'all good') : badge('estimated', 'look at this');
  $('billChecks').innerHTML = `<p class="c-cap" style="margin-top:2px">${niceDate(last.billDate, { month: 'long' })} bill · ${niceDate(last.period.from)} – ${niceDate(last.period.to)}</p>
    <div style="margin-top:4px">${last.checks.map(c => `<div class="c-check"><i class="${c.ok ? '' : 'todo'}"${c.ok ? '' : ' style="color:var(--warn)"'}>${c.ok ? '✓' : '!'}</i><div><b>${esc(c.label)}.</b> ${esc(c.detail)}</div></div>`).join('')}${yoy}</div>${cov}
    <div class="c-kv"><span>Total</span><b>${S.guest ? veil() : money2(last.total)}</b>
    <span>Your rate, all-in</span><b>${S.guest ? veil('$•.••••/kWh') : last.tariff ? `$${last.tariff.importRateAllIn.toFixed(4)}/kWh` : '—'}</b><span>Solar + Powerwall covered</span><b>${last.solarShareOfHome ?? '—'}% of home use</b>
    <span>Without solar it would have been</span><b>${S.guest ? veil() : money2(last.withoutSolarCost)}</b></div>`;

  // meter vs Tesla per bill
  const mx = Math.max(1, ...R.flatMap(r => [r.pec.deliveredKwh, r.tesla.importKwh ?? 0])) * 1.1, bw = Math.min(46, 280 / R.length);
  let s = '';
  R.forEach((r, i) => { const x = 26 + i * (bw + 8), h1 = r.pec.deliveredKwh / mx * 100, h2 = (r.tesla.importKwh ?? 0) / mx * 100, bad = r.importGapPct != null && Math.abs(r.importGapPct) > 5;
    s += `<rect x="${x}" y="${112 - h1}" width="${bw}" height="${h1}" rx="5" style="fill:var(${bad ? '--out' : '--grid'})" fill-opacity=".32"/><rect x="${x + bw * .28}" y="${112 - h2}" width="${bw * .44}" height="${h2}" rx="3" style="fill:var(--home)"/>`;
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
    b += `<rect x="${x}" y="${104 - h1}" width="19" height="${h1}" rx="5" fill="rgba(255,255,255,.13)"><title>${esc(m.month)}: without solar $${wo.toFixed(0)}</title></rect><rect x="${x + 4}" y="${104 - h2}" width="11" height="${h2}" rx="3" fill="#ffc15e"><title>paid ≈ $${paid.toFixed(0)}</title></rect>` +
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
        <tr><td>Bought from PEC</td><td>${bill.deliveredKwh.toLocaleString()} kWh</td></tr><tr><td>Sent to PEC</td><td>${esc(bill.receivedKwh)} kWh</td></tr>
        ${bill.charges.map(c => `<tr><td>${esc(c.label)}${c.kwh ? ` · ${c.kwh.toLocaleString()} kWh @ $${esc(c.rate)}` : ''}</td><td>${money2(c.amount)}</td></tr>`).join('')}
        <tr><td><b style="color:var(--text)">Total</b></td><td><b>${money2(bill.total)}</b></td></tr></table>
        <p class="${ok ? 'sub' : 'err'}">${ok ? '✓ The line items add up and the meter readings are consistent.' : "⚠ Some numbers didn't add up. Check them against the PDF before saving."}</p>
        <div class="row2"><button class="ghost" id="billCancel">Cancel</button><button class="primary" id="billSave" style="margin-top:0">Save bill</button></div>`;
      $('billCancel').onclick = () => $('phone').classList.remove('open');
      $('billSave').onclick = async () => { await api.saveBill(bill); $('phone').classList.remove('open'); toast('$', 'rgba(255,193,94,.2)', 'Bill saved', `${niceDate(bill.billDate, { month: 'long' })} · ${money2(bill.total)}. Checking it against Tesla now`); refresh(); };
    } catch (e) { $('billPreview').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  $('billFile').onchange = e => e.target.files[0] && handle(e.target.files[0]);
  const drop = $('drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('hot'); };
  drop.ondragleave = () => drop.classList.remove('hot');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hot'); const f = e.dataTransfer.files[0]; if (f) handle(f); };
}
