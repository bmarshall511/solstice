import { $, niceDate } from '../lib/util.js';
import { api } from '../lib/api.js';
import { confChip, biasDir, sparkline, esc } from '../lib/conf.js';

/*
 * "How well Solstice knows your home" (Insights → Home, approved mockup r-learning): the model report from the owner-only
 * GET /api/models (server/src/learn/api.ts). It sits below Outage readiness and above Data health, is owner-only
 * ([data-owner], and never fetched for a guest or the owner's guest preview), and a tap on a row opens the shared sheet with
 * that model's last 30 predicted-vs-actual days.
 */
const MARKUP = `<div class="card" id="learnCard" data-owner hidden>
  <div class="mrhead"><b>How well Solstice knows your home</b><span class="badge g" id="lrBadge">—</span></div>
  <p class="headline" id="lrHead" hidden></p>
  <div class="lrows" id="lrRows"></div>
  <div id="lrAnom"></div>
  <div class="sect2" id="lrLogH" style="margin-top:16px">Learning log</div>
  <div class="tline" id="lrLog"></div>
  <p class="fine" id="lrRun" style="margin-top:10px"></p>
</div>`;

let timer, mounted = false;
const clockAt = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

export function initLearn(S) {
  if (!mounted) { const dh = $('dhList')?.closest('.card'); if (!dh) return; dh.insertAdjacentHTML('beforebegin', MARKUP); mounted = true;
    $('lrRows').onclick = e => { const r = e.target.closest('.lrow'); if (r) openModel(S, r.dataset.id); }; }
  clearInterval(timer);
  if (S.guest) { $('learnCard').hidden = true; return; }   // owner-only route: a guest (or the owner previewing) never asks
  const load = () => api.models().then(m => { S.models = m; drawLearn(S); S.onModels?.(); }).catch(e => console.warn('models', e.message));
  load(); timer = setInterval(load, 15 * 60_000);
}

export function drawLearn(S) {
  const R = S.models, card = $('learnCard'); if (!R || !card) return;
  card.hidden = false;
  const s = R.summary;
  $('lrBadge').textContent = `${s.learned} of ${s.total} learned`;
  $('lrHead').hidden = !s.headline; $('lrHead').textContent = s.headline ?? '';
  $('lrRows').innerHTML = R.models.map(m => {
    const dir = biasDir(m.bias), arrow = dir ? `<span class="bias ${dir}">${dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '→'}</span>` : '<span class="bias"></span>';
    return `<div class="lrow" data-id="${esc(m.id)}">
      <div class="lrow-top"><i class="dot ${esc(m.dot)}"></i><span class="lbl">${esc(m.label)}</span>${confChip(m.tier, m)}<span class="chev-r">›</span></div>
      <div class="lrow-mid">${m.spark?.length ? sparkline(m.spark, 58, 18) : '<span style="width:58px;flex:none"></span>'}${arrow}<span class="lnote">${esc(m.note)}</span></div>
      ${m.help ? `<div class="lhelp">What would help: ${esc(m.help)}</div>` : ''}
    </div>`;
  }).join('');
  const now = Date.now();
  $('lrAnom').innerHTML = (R.anomalies ?? []).map(a => { const d = Math.max(1, Math.round((now - a.openedAt) / 864e5));
    return `<div class="ins lanom" style="--c:var(--warn)"><div class="ic">⚠</div><div><b>${esc(a.title ?? a.kind)}</b> <time>· ${d} day${d === 1 ? '' : 's'}</time>${a.body ? `<p>${esc(a.body)}</p>` : ''}</div></div>`; }).join('');
  const log = (R.log ?? []).slice(0, 6);
  $('lrLogH').hidden = $('lrLog').hidden = !log.length;
  $('lrLog').innerHTML = log.map(l => `<div><i></i><span>${niceDate(l.day, { month: 'short', day: 'numeric' })}</span><p>${esc(l.text)}${l.delta ? ` <em>${esc(l.delta)}</em>` : ''}</p></div>`).join('');
  const r = R.lastRun;
  $('lrRun').textContent = r ? `Learning · last run ${clockAt(r.at)} · ${r.scored} model${r.scored === 1 ? '' : 's'} scored${r.errors?.length ? ` · ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}` : ''}` : 'Learning · not run yet (nightly, after the history sync)';
}

/** The tap-through: last 30 predicted-vs-actual days, bias, error by window. */
function openModel(S, id) {
  const m = S.models?.models.find(x => x.id === id); if (!m) return;
  const u = m.abs ? ` ${m.unit}` : '%', f = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v}${u}`;
  const pairs = (m.days ?? []).filter(d => d.p != null && d.a != null);
  let body;
  if (m.tier === 'measured') body = `<p class="sub">A direct reading — no model to score.</p>${m.note ? `<p class="sub">${esc(m.note)}</p>` : ''}`;
  else if (!pairs.length) body = `<p class="sub">Not enough scored samples yet.</p><p style="font-size:13px;color:var(--dim);line-height:1.55;margin-top:10px">${esc(m.help ?? 'No predictions have been scored against an actual reading in the last 14 days.')}</p>`;
  else {
    const vals = pairs.flatMap(p => [p.p, p.a]), lo = Math.min(...vals) * .9, hi = Math.max(...vals) * 1.08 || 1, w = 300, h = 170, pad = 28;
    const X = v => pad + (v - lo) / (hi - lo || 1) * (w - pad - 10), Y = v => h - 14 - (v - lo) / (hi - lo || 1) * (h - 24);
    let o = `<line x1="${X(lo)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}" stroke="rgba(255,255,255,.18)" stroke-dasharray="3 4"/>`;
    pairs.forEach(p => o += `<circle cx="${X(p.p).toFixed(1)}" cy="${Y(p.a).toFixed(1)}" r="2.6" fill="rgba(78,240,166,.85)"/>`);
    o += `<text x="${pad}" y="${h - 2}" font-size="8.5" fill="rgba(242,244,248,.4)" font-family="JetBrains Mono">predicted →</text><text x="4" y="${(Y(lo) + Y(hi)) / 2}" font-size="8.5" fill="rgba(242,244,248,.4)" font-family="JetBrains Mono" transform="rotate(-90 4 ${(Y(lo) + Y(hi)) / 2})" text-anchor="middle">actual ${esc(m.unit)}</text>`;
    const win = Object.entries(m.scores ?? {}).filter(([, s]) => s).map(([w, s]) => `<span>${w} · n=${s.n}</span><b>${m.abs ? (s.mae == null ? '—' : `±${Math.round(s.mae * 10) / 10}${u}`) : (s.mape == null ? '—' : `±${Math.round(s.mape * 1000) / 10}%`)}</b>`).join('');
    body = `<p class="sub">Last ${pairs.length} predicted-vs-actual days, in ${esc(m.unit)}.</p><div class="scatter"><svg viewBox="0 0 ${w} ${h}">${o}</svg></div>
      <div class="kv" style="margin-top:8px"><span>Error</span><b>${m.abs ? (m.mae == null ? '—' : `±${m.mae}${u}`) : (m.mape == null ? '—' : `±${m.mape}%`)}</b><span>Bias</span><b>${f(m.bias)}</b>
      <span>Days scored</span><b>${m.n}${m.n < m.need ? ` of ${m.need}` : ""}</b>${win}</div>${m.help ? `<p class="fine" style="margin-top:10px">What would help: ${esc(m.help)}</p>` : ''}`;
  }
  $('sheetBody').innerHTML = `<div class="shead"><h4>${esc(m.label)}</h4><button class="x" id="sheetX">✕</button></div>${body}`;
  $('phone').classList.add('open');
  $('sheetX').onclick = () => $('phone').classList.remove('open');
}
