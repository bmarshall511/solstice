import { $, niceDate } from '../lib/util.js';
import { api } from '../lib/api.js';
import { cBadge, badge, biasDir, sparkline, esc } from '../lib/conf.js';
import { icon } from '../lib/icons.js';
import { sheet, sheetHead, sheetFoot, closeSheet } from './csheet.js';

/*
 * "How well Solstice knows your home" (Systems › Home; approved mockups r-learning, then al frame 9): the model report from the
 * owner-only GET /api/models (server/src/learn/api.ts). The card shows the headline and the three models that most need data, as
 * compact rows (dormant ones dashed, with their `why`); "All models ›" opens the whole report as a sheet, and a row opens that
 * model's last 30 predicted-vs-actual days. Owner-only ([data-owner]); never fetched for a guest or the owner's guest preview.
 */
let timer;
const clockAt = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
const RANK = { dormant: 0, unscored: 1, learning: 2, estimated: 3, learned: 4, measured: 5 };
const ACC = id => /pool/.test(id) ? 'c-acc-pool' : /^ac|\.ac|ac\./.test(id) ? 'c-acc-ac' : /solar|pv/.test(id) ? 'c-acc-solar' : /soc|batt|pw/.test(id) ? 'c-acc-batt' : 'c-acc-home';

export function initLearn(S) {
  $('lrRows').onclick = e => { const r = e.target.closest('[data-model]'); if (!r) return; r.dataset.model === '*' ? openReport(S) : openModel(S, r.dataset.model); };
  clearInterval(timer);
  if (S.guest) { $('learnCard').hidden = true; return; }   // owner-only route: a guest (or the owner previewing) never asks
  const load = () => api.models().then(m => { S.models = m; drawLearn(S); S.onModels?.(); }).catch(e => console.warn('models', e.message));
  load(); timer = setInterval(load, 15 * 60_000);
}

/** One model as a compact row: label, its note (a dormant model's `why`), the tier badge. */
const modelRow = m => `<div class="c-sys compact ${ACC(m.id)}" role="button" tabindex="0" data-model="${esc(m.id)}"><span class="c-ic">${icon('chart')}</span>
  <div style="min-width:0"><div class="c-sys-top"><b>${esc(m.label)}</b></div><div class="c-sys-l">${esc(m.tier === 'dormant' ? (m.why ?? m.note) : m.note)}</div></div>
  <span class="c-end">${cBadge(m.tier, m)}<span class="c-chev">${icon('chev')}</span></span></div>`;

export function drawLearn(S) {
  const R = S.models, card = $('learnCard'); if (!R || !card) return;
  card.hidden = false;
  const s = R.summary;
  $('lrHead').innerHTML = `${badge('', `${s.learned} of ${s.active ?? s.total} learned${s.dormant ? ` · ${s.dormant} dormant` : ''}`)} ${esc(s.headline ?? '')}`;   // B2-9: dormant models leave the count
  const three = [...R.models].sort((a, b) => (RANK[a.tier] ?? 9) - (RANK[b.tier] ?? 9)).slice(0, 3);
  $('lrRows').innerHTML = three.map(modelRow).join('')
    + `<div class="c-sys compact c-acc-mute" role="button" tabindex="0" data-model="*" aria-haspopup="dialog"><span class="c-ic">${icon('bars')}</span><div style="min-width:0"><div class="c-sys-top"><b>All models</b></div><div class="c-sys-l">${R.models.length} models · the learning log</div></div><span class="c-chev">${icon('chev')}</span></div>`;
}

/** The whole report as a sheet: every model (the old rows, with the error sparkline and bias arrow), open anomalies, the log. */
function openReport(S) {
  const R = S.models; if (!R) return;
  const rows = R.models.map(m => {
    const dir = biasDir(m.bias), arrow = dir ? `<span class="bias ${dir}">${dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '→'}</span>` : '<span class="bias"></span>';
    return `<div class="lrow" data-model="${esc(m.id)}" role="button" tabindex="0">
      <div class="lrow-top"><i class="dot ${esc(m.dot)}"></i><span class="lbl">${esc(m.label)}</span>${cBadge(m.tier, m)}<span class="chev-r">›</span></div>
      <div class="lrow-mid">${m.spark?.length ? sparkline(m.spark, 58, 18) : '<span style="width:58px;flex:none"></span>'}${arrow}<span class="lnote">${esc(m.tier === 'dormant' ? (m.why ?? m.note) : m.note)}</span></div>
      ${m.help ? `<div class="lhelp">What would help: ${esc(m.help)}</div>` : ''}
    </div>`; }).join('');
  const now = Date.now();
  const anom = (R.anomalies ?? []).map(a => { const d = Math.max(1, Math.round((now - a.openedAt) / 864e5));
    return `<div class="c-check"><i class="todo" style="color:var(--warn)">!</i><span><b>${esc(a.title ?? a.kind)}</b> · ${d} day${d === 1 ? '' : 's'}${a.body ? `<br><span class="c-cap">${esc(a.body)}</span>` : ''}${a.detail?.action === 'open_panels' ? '<br><button class="c-btn sm line" data-solar>Systems › Solar</button>' : ''}</span></div>`; }).join('');
  const log = (R.log ?? []).slice(0, 6), r = R.lastRun;
  sheet(`${sheetHead('How well Solstice knows your home', badge('', `${R.summary.learned} of ${R.summary.active ?? R.summary.total} learned`), esc(R.summary.headline ?? 'Predictions are scored every night.'))}
    <div class="c-card lrep">${rows}</div>
    ${anom ? `<div class="c-lab">Open anomalies</div><div class="c-well">${anom}</div>` : ''}
    ${log.length ? `<div class="c-lab">Learning log</div><div class="c-card" style="padding:4px 14px">${log.map(l => `<div class="c-check" style="grid-template-columns:52px minmax(0,1fr)"><span class="c-num c-cap">${niceDate(l.day, { month: 'short', day: 'numeric' })}</span><span>${esc(l.text)}${l.delta ? ` <span class="c-cap">${esc(l.delta)}</span>` : ''}</span></div>`).join('')}</div>` : ''}
    <p class="c-fine">${r ? `Learning · last run ${clockAt(r.at)} · ${r.scored} model${r.scored === 1 ? '' : 's'} scored${r.errors?.length ? ` · ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}` : ''}` : 'Learning · not run yet (nightly, after the history sync)'}</p>
    ${sheetFoot('', 'Done', 'c-acc-batt')}`);
  const body = $('sheetBody');
  body.querySelector('[data-f="pri"]').onclick = closeSheet;
  body.querySelectorAll('.lrow[data-model]').forEach(x => x.onclick = () => openModel(S, x.dataset.model));
  body.querySelector('[data-solar]')?.addEventListener('click', () => { closeSheet(); S.nav?.sys('solar'); });
}

/** The tap-through: last 30 predicted-vs-actual days, bias, error by window. */
/* mockup ah: how the home-use forecast predicts: each day's kWh against its high, the fitted line, tomorrow, and the last 4 days old vs new */
const DOW = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
function homeHow(H) {
  const f = H.fit, pts = f.points, hs = pts.map(p => p.high).concat(H.tomorrow ? [H.tomorrow.high] : []), ks = pts.map(p => p.kwh).concat(H.tomorrow ? [H.tomorrow.kwh] : []);
  const tc = f.tc ?? 70, t0 = Math.min(tc, Math.floor(Math.min(...hs) / 5) * 5), t1 = Math.max(t0 + 15, Math.ceil(Math.max(...hs) / 5) * 5), k0 = Math.floor(Math.min(...ks) / 10) * 10, k1 = Math.ceil(Math.max(...ks) / 10) * 10 || 1;
  const X = t => 30 + (t - t0) / (t1 - t0) * 290, Y = k => 130 - (k - k0) / (k1 - k0 || 1) * 115, line = t => f.a + f.b * Math.max(0, t - tc);   // B2-8: the cooling part against the high (the heating part follows the low)
  let o = '';
  for (let t = Math.ceil(t0 / 10) * 10; t <= t1; t += 10) o += `<text x="${X(t)}" y="146" text-anchor="middle" fill="rgba(242,244,248,.45)" font-size="9" font-family="JetBrains Mono">${t}°</text>`;
  [k0, (k0 + k1) / 2, k1].forEach(k => o += `<line x1="30" x2="320" y1="${Y(k)}" y2="${Y(k)}" stroke="rgba(255,255,255,.06)"/><text x="2" y="${Y(k) + 3}" fill="rgba(242,244,248,.45)" font-size="9" font-family="JetBrains Mono">${Math.round(k)}</text>`);
  o += `<polyline points="${[t0, Math.max(t0, tc), t1].map(t => `${X(t)},${Y(line(t))}`).join(' ')}" fill="none" stroke="#4ef0a6" stroke-width="2"/>`;
  pts.forEach(p => o += `<circle cx="${X(p.high)}" cy="${Y(p.kwh)}" r="3.5" fill="#ffd27a" fill-opacity=".85"><title>${p.day.slice(5)}: ${Math.round(p.high)}°, ${p.kwh} kWh</title></circle>`);
  if (H.tomorrow) o += `<circle cx="${X(H.tomorrow.high)}" cy="${Y(H.tomorrow.kwh)}" r="5" fill="none" stroke="#fff" stroke-width="1.5"/><text x="${X(H.tomorrow.high) - 8}" y="${Y(H.tomorrow.kwh) - 9}" text-anchor="end" fill="#fff" font-size="9.5" font-family="Manrope">tomorrow</text>`;
  o += `<text x="320" y="12" text-anchor="end" fill="rgba(242,244,248,.45)" font-size="9" font-family="Manrope">kWh a day vs the day's high</text>`;
  const chk = (H.check ?? []).filter(c => c.new != null);
  return `<div class="ah-h">How it predicts</div><svg viewBox="0 0 330 150" style="width:100%;margin-top:8px">${o}</svg>
    <p class="ah-line">From your last ${f.year ? `year (${f.year.n} days) for the weather and your last ${f.n || pts.length} days for the level` : `${f.n} days`}: <b>${Math.round(f.a)} kWh a day${f.b > 0 ? `, plus ${f.b.toFixed(1)} kWh for every degree` : ''}</b>${f.b > 0 ? ` the forecast high is above ${tc}°` : ' (it hasn’t tracked the heat lately)'}${f.c > 0 ? `, <b>plus ${f.c.toFixed(1)} kWh for every degree</b> the night’s low is below ${f.th}° (heating)` : ''}.${H.tomorrow ? ` Tomorrow’s forecast ${Math.round(H.tomorrow.high)}° → <b>${Math.round(H.tomorrow.kwh)} kWh</b>, spread over the hours the way your recent days ran.` : ''}</p>
    ${chk.length ? `<div class="ah-h">The last ${chk.length} days, old vs new</div><div class="ah-tbl"><span class="hd">Day</span><span class="hd">Used</span><span class="hd">Old</span><span class="hd">New</span>
      ${chk.map(c => `<span>${DOW(c.day)} ${+c.day.slice(5, 7)}/${+c.day.slice(8)} · ${Math.round(c.high)}°</span><span>${Math.round(c.used)}</span><span class="old">${Math.round(c.old)}</span><span class="nw">${Math.round(c.new)}</span>`).join('')}</div>` : ''}`;
}
function openModel(S, id) {
  const m = S.models?.models.find(x => x.id === id); if (!m) return;
  const u = m.abs ? ` ${esc(m.unit)}` : '%', f = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v}${u}`;
  const pairs = (m.days ?? []).filter(d => d.p != null && d.a != null);
  let body;
  if (m.tier === 'dormant') body = `<p class="sub">${esc(m.why)}</p>`;   // B2-9
  else if (m.tier === 'measured') body = `<p class="sub">A direct reading — no model to score.</p>${m.note ? `<p class="sub">${esc(m.note)}</p>` : ''}`;
  else if (!pairs.length) body = `<p class="sub">Not enough scored samples yet.</p><p style="font-size:13px;color:var(--dim);line-height:1.55;margin-top:10px">${esc(m.why ?? m.help ?? 'No predictions have been scored against an actual reading in the last 14 days.')}</p>`;
  else {
    const vals = pairs.flatMap(p => [p.p, p.a]), lo = Math.min(...vals) * .9, hi = Math.max(...vals) * 1.08 || 1, w = 300, h = 170, pad = 28;
    const X = v => pad + (v - lo) / (hi - lo || 1) * (w - pad - 10), Y = v => h - 14 - (v - lo) / (hi - lo || 1) * (h - 24);
    let o = `<line x1="${X(lo)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}" stroke="rgba(255,255,255,.18)" stroke-dasharray="3 4"/>`;
    pairs.forEach(p => o += `<circle cx="${X(p.p).toFixed(1)}" cy="${Y(p.a).toFixed(1)}" r="2.6" fill="rgba(78,240,166,.85)"/>`);
    o += `<text x="${pad}" y="${h - 2}" font-size="8.5" fill="rgba(242,244,248,.4)" font-family="JetBrains Mono">predicted →</text><text x="4" y="${(Y(lo) + Y(hi)) / 2}" font-size="8.5" fill="rgba(242,244,248,.4)" font-family="JetBrains Mono" transform="rotate(-90 4 ${(Y(lo) + Y(hi)) / 2})" text-anchor="middle">actual ${esc(m.unit)}</text>`;
    const win = Object.entries(m.scores ?? {}).filter(([, s]) => s).map(([w, s]) => `<span>${esc(w)} · n=${esc(s.n)}</span><b>${m.abs ? (s.mae == null ? '—' : `±${Math.round(s.mae * 10) / 10}${u}`) : (s.mape == null ? '—' : `±${Math.round(s.mape * 1000) / 10}%`)}</b>`).join('');
    body = `<p class="sub">Last ${pairs.length} predicted-vs-actual days, in ${esc(m.unit)}.</p><div class="scatter"><svg viewBox="0 0 ${w} ${h}">${o}</svg></div>
      <div class="kv" style="margin-top:8px"><span>Error</span><b>${m.abs ? (m.mae == null ? '—' : `±${m.mae}${u}`) : (m.mape == null ? '—' : `±${m.mape}%`)}</b><span>Bias</span><b>${f(m.bias)}</b>
      <span>Days scored</span><b>${m.n}${m.n < m.need ? ` of ${m.need}` : ""}</b>${win}</div>${m.help ? `<p class="fine" style="margin-top:10px">What would help: ${esc(m.help)}</p>` : ''}`;
  }
  if (id === 'fc48.home' && S.models.home?.fit) body += homeHow(S.models.home);   // mockup ah
  sheet(`${sheetHead(esc(m.label), cBadge(m.tier, m))}${body}${sheetFoot('All models', 'Done', 'c-acc-batt')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
  $('sheetBody').querySelector('[data-f="sec"]').onclick = () => openReport(S);
}
