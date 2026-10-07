// The pool water log (approved mockup aj; server/src/appliances/poolTests.ts): the Water card under the pool's live card, the "Log a
// test" sheet, the 30-day history sheet and, after a hazy/cloudy/green test, the offer of the existing Clear-up (never started here).
// Owner only. Ranges only color the values; nothing here says what to add.
import { $, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { openClearUp } from './appliances.js';
import { badge } from '../lib/conf.js';
import { banner, sheet, sheetHead, sheetFoot, seg, segSet, closeSheet } from './csheet.js';

const W = { data: null, timer: null };
const FIELDS = [['fc', 'Free chlorine', 'ppm', .5, [0, 20], true], ['ph', 'pH', '', .1, [6.4, 8.6], true], ['cc', 'Combined chlorine', 'ppm · optional', .5, [0, 5]],
  ['ta', 'Alkalinity', 'ppm · optional', 10, [0, 300]], ['cya', 'CYA (stabilizer)', 'ppm · optional', 10, [0, 200]], ['ch', 'Calcium hardness', 'ppm · optional', 25, [0, 1000]]];
const CLAR = [['clear', 'Clear'], ['hazy', 'Hazy'], ['cloudy', 'Cloudy'], ['green', 'Green']];
const ADD = [['liquid', 'Liquid chlorine'], ['tablets', 'Tablets'], ['shock', 'Shock'], ['acid', 'Acid'], ['other', 'Other']];
const SRC = [['kit', 'Drop kit'], ['store', 'Pool store']];
const fmt = (k, v) => v == null ? '—' : k === 'ph' ? v.toFixed(1) : k === 'fc' || k === 'cc' ? v.toFixed(1) : String(Math.round(v));
const ago = ms => { const d = Math.floor((Date.now() - ms) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const shortDay = day => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function initWater(S, every) {
  $('pwCard').hidden = !!S.guest; if (S.guest) return;
  W.timer ??= every(15 * 60_000, load);
  async function load() { try { W.data = await api.poolWater(); draw(S); } catch { /* keep the last */ } }
}
function draw(S) {
  const d = W.data; if (!d) return;
  const t = d.last, st = d.status ?? {};
  const off = t ? ['fc', 'ph', 'ta', 'cya'].filter(k => st[k] && st[k] !== 'ok').length : 0;
  // mockup al frame 12: one row (title, the in-range badge, one line with the latest values), Log a test at its end; the row opens the history
  $('pwBadge').innerHTML = !t ? '' : off ? badge('estimated', `${off} to watch`) : badge('learned', 'in range');
  const water = d.waterF != null ? ` · water ${Math.round(d.waterF)}°` : '';
  const vals = t ? [['fc', 'FC'], ['ph', 'pH'], ['ta', 'TA'], ['cya', 'CYA']].filter(([k]) => t[k] != null).map(([k, l]) => `${l} ${fmt(k, t[k])}`).join(' · ') : '';
  $('pwLine').innerHTML = t ? `${CLAR.find(c => c[0] === t.clarity)[1]} · tested ${ago(t.at)}${d.overdue ? ' · <b style="color:var(--solar)">due</b>' : ''}${vals ? ` · ${vals}` : ''}` : `no tests yet${water}`;
  // tablets raise CYA: past 50, chlorine needs to run higher (the common guideline is at least ~7.5% of CYA)
  $('pwNote').hidden = !(d.cya != null && d.cya > 50);
  $('pwNote').textContent = d.cya > 50 ? `CYA ${d.cya}: tablets add stabilizer, so chlorine needs to run higher; the usual minimum is about ${d.fcMin} ppm at this level.` : '';
  // mockup aj frame 4: a hazy/cloudy/green test in the last 2 days offers the Clear-up (never starts it here)
  const cu = S.pool?.clearUp, offer = t && t.clarity !== 'clear' && Date.now() - t.at < 2 * 864e5 && !cu && S.pool?.clearUpRates?.length;
  $('pwOffer').innerHTML = offer ? banner({ cls: 'blue', ic: 'pool', title: `${CLAR.find(c => c[0] === t.clarity)[1]} water logged`, line: 'Start a Clear-up? Autopilot holds the plan while it runs and goes back to it afterwards.', btns: [['Start Clear-up', 'cu'], ['Not now', 'no']] }) + '<div style="height:14px"></div>' : '';
  if (offer) { $('pwOffer').querySelector('[data-b="cu"]').onclick = () => openClearUp(S); $('pwOffer').querySelector('[data-b="no"]').onclick = () => { $('pwOffer').innerHTML = ''; }; }
  $('pwLog').onclick = e => { e.stopPropagation(); openLog(S); };
  $('pwVals').onclick = () => openHistory(S);
}

/** The "Log a test" sheet in the component system (mockup al, component 11): steppers in a card, the water and the source as
 *  sliding segments, Added today as toggle pills, Save test in the pinned footer. `v` is the staged test. */
export function logTestHtml(v, now, waterF = null) {
  return `${sheetHead('Log a test', '', `Today, ${now}${waterF != null ? ` · water ${Math.round(waterF)}° (from the controller)` : ''}`)}
    <div class="c-card" id="plRows" style="padding:4px 16px">${FIELDS.map(([k, l, u]) => `<div class="c-stepper"><div>${l}${u ? `<small>${u}</small>` : ''}</div><button class="c-step" data-k="${k}" data-d="-1" aria-label="Lower">−</button><b id="pv_${k}"></b><button class="c-step" data-k="${k}" data-d="1" aria-label="Higher">+</button></div>`).join('')}</div>
    <div class="c-lab">The water</div><div id="plClar">${seg(CLAR, v.clarity, { acc: 'c-acc-pool', attr: 'data-c', label: 'The water' })}</div>
    <div class="c-lab">Added today</div><div class="c-fpills" id="plAdd" role="group" aria-label="Added today">${ADD.map(([k, l]) => `<button class="c-fpill" data-a="${k}" aria-pressed="${v.added.includes(k)}">${l}</button>`).join('')}</div>
    <div class="c-lab">Tested with</div><div id="plSrc">${seg(SRC, v.source, { acc: 'c-acc-pool', attr: 'data-s', label: 'Tested with' })}</div>
    <p class="c-fine" style="text-align:center">Chlorine and pH start at your last test. Leave the optional ones at "—".</p>
    ${sheetFoot('', 'Save test', 'c-acc-pool')}`;
}
function openLog(S) {
  const last = W.data?.last, v = { fc: last?.fc ?? 3, ph: last?.ph ?? 7.5, cc: null, ta: null, cya: null, ch: null, clarity: 'clear', added: [], source: last?.source ?? 'kit' };
  const now = new Date().toLocaleString('en-US', { weekday: undefined, hour: 'numeric', minute: '2-digit' });
  sheet(logTestHtml(v, now, W.data?.waterF));
  const body = $('sheetBody'), go = body.querySelector('[data-f="pri"]');
  const drawS = () => {
    FIELDS.forEach(([k]) => { const b = $(`pv_${k}`); b.textContent = fmt(k, v[k]); b.classList.toggle('off', v[k] == null); });
    segSet($('plClar').firstElementChild, v.clarity, 'data-c');
    body.querySelectorAll('#plAdd button').forEach(b => { const on = v.added.includes(b.dataset.a); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    segSet($('plSrc').firstElementChild, v.source, 'data-s');
  };
  $('plRows').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return;
    const [k, , , step, [lo, hi], req] = FIELDS.find(f => f[0] === b.dataset.k), d = +b.dataset.d;
    // an optional value starts at the middle of its usual range the first time it's tapped; − from its lowest goes back to "—"
    const start = { cc: 0, ta: 100, cya: 40, ch: 300 }[k];
    if (v[k] == null) v[k] = start; else if (!req && d < 0 && v[k] <= lo) v[k] = null; else v[k] = Math.round(Math.max(lo, Math.min(hi, v[k] + d * step)) / step) * step;
    if (v[k] != null) v[k] = +v[k].toFixed(1);
    drawS(); };
  $('plClar').onclick = e => { const b = e.target.closest('[data-c]'); if (b) { v.clarity = b.dataset.c; drawS(); } };
  $('plAdd').onclick = e => { const b = e.target.closest('[data-a]'); if (!b) return; v.added = v.added.includes(b.dataset.a) ? v.added.filter(a => a !== b.dataset.a) : [...v.added, b.dataset.a]; drawS(); };
  $('plSrc').onclick = e => { const b = e.target.closest('[data-s]'); if (b) { v.source = b.dataset.s; drawS(); } };
  go.onclick = async () => { go.textContent = 'Saving…';
    try { W.data = await api.addPoolTest(v); closeSheet(); draw(S); toast('✓', 'rgba(78,240,166,.2)', 'Test logged', 'Tap the values on the Water card to see the history.'); }
    catch (e) { alert(e.message); go.textContent = 'Save test'; } };
  drawS();
}

function openHistory(S) {
  const d = W.data; if (!d) return;
  const tests = [...d.tests].reverse().filter(t => Date.now() - t.at < 31 * 864e5), f = d.findings;
  const t0 = Date.now() - 30 * 864e5, X = ms => 24 + (ms - t0) / (30 * 864e5) * 298, Yc = v => 120 - Math.min(v, 6) / 6 * 100, Yp = v => 120 - (Math.max(6.8, Math.min(8.2, v)) - 6.8) / 1.4 * 100;
  let o = '';
  Object.entries(d.pumpHours).forEach(([day, h]) => { const ms = Date.parse(`${day}T12:00:00`); if (ms >= t0) o += `<rect x="${X(ms) - 3}" y="${120 - h / 24 * 60}" width="6" height="${h / 24 * 60}" fill="rgba(108,196,255,.25)"><title>${shortDay(day)}: ${h} h of pump</title></rect>`; });
  o += `<rect x="24" y="${Yc(4)}" width="298" height="${Yc(d.fcMin) - Yc(4)}" fill="rgba(78,240,166,.06)"/>`;
  if (tests.length) {
    o += `<polyline points="${tests.map(t => `${X(t.at)},${Yc(t.fc)}`).join(' ')}" fill="none" stroke="#4ef0a6" stroke-width="2"/>` + tests.map(t => `<circle cx="${X(t.at)}" cy="${Yc(t.fc)}" r="3" fill="#4ef0a6"><title>${shortDay(t.day)}: FC ${t.fc}</title></circle>`).join('');
    o += `<polyline points="${tests.map(t => `${X(t.at)},${Yp(t.ph)}`).join(' ')}" fill="none" stroke="#c4a2ff" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  }
  [[0, 'start'], [15, 'middle'], [30, 'end']].forEach(([i, a]) => o += `<text x="${X(t0 + i * 864e5)}" y="140" text-anchor="${a}" fill="rgba(242,244,248,.45)" font-size="9" font-family="JetBrains Mono">${new Date(t0 + i * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>`);
  [0, 2, 4, 6].forEach(v => o += `<text x="2" y="${Yc(v) + 3}" fill="rgba(242,244,248,.45)" font-size="9" font-family="JetBrains Mono">${v}</text>`);
  const find = !f ? `Findings appear after ${6} tests over two weeks (${d.tests.length} so far).`
    : [f.use ? `Between tests, chlorine fell about <b style="color:var(--text)">${f.use.ppmPerDay} ppm a day</b>${f.use.waterF ? ` at ${f.use.waterF[0] === f.use.waterF[1] ? f.use.waterF[0] : `${f.use.waterF[0]}–${f.use.waterF[1]}`}°` : ''} (${f.use.n} stretches).` : '',
       f.hazy ? `Hazy tests followed weeks averaging <b style="color:var(--text)">${f.hazy.hazyHours} h</b> of pump a day; clear ones ${f.hazy.clearHours} h.` : ''].filter(Boolean).join(' ') || 'Not enough comparable tests yet.';
  $('sheetBody').innerHTML = `<div class="shead"><h4>Water · last 30 days</h4><button class="x" id="phX" aria-label="Close">✕</button></div>
    <p class="sub">Your tests against the pump's hours</p>
    <svg viewBox="0 0 330 150" style="width:100%;margin-top:10px">${o}</svg>
    <div class="sl-key"><span><i style="background:#4ef0a6"></i>free chlorine</span><span><i style="background:#c4a2ff"></i>pH</span><span><i style="background:rgba(108,196,255,.6)"></i>pump hours</span></div>
    <p class="sub" style="margin-top:10px">${find}</p>
    <div class="pw-tl">${d.tests.slice(0, 12).map(t => `<div><em>${shortDay(t.day)}</em><span><b>${fmt('fc', t.fc)} · ${fmt('ph', t.ph)}</b>${t.ta != null ? ` · TA ${t.ta}` : ''}${t.cya != null ? ` · CYA ${t.cya}` : ''} · ${t.clarity}${t.added.length ? ` · ${t.added.map(a => ADD.find(x => x[0] === a)[1].toLowerCase()).join(', ')}` : ''}${t.source === 'store' ? ' · pool store' : ''}</span><button class="link" data-del="${t.id}" aria-label="Delete this test">✕</button></div>`).join('') || '<p class="fine">No tests yet.</p>'}</div>`;
  $('phX').onclick = () => $('phone').classList.remove('open');
  $('sheetBody').querySelector('.pw-tl').onclick = async e => { const b = e.target.closest('[data-del]'); if (!b || !confirm('Delete this test?')) return;
    W.data = await api.deletePoolTest(+b.dataset.del); draw(S); openHistory(S); };
  $('phone').classList.add('open');
}
