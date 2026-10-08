// I-22 load signatures on Systems › Home (approved mockup mockups/am-ideas.html frames 4–5): the "Big loads" disclosure, one row per
// cluster (name or signature, badge, kWh a day, how often and when, the 24-hour strip, a suggestion, Name it / Not one appliance or
// Rename), and the naming sheet. The sheet is staged: picking a pill or typing writes nothing; only the footer buttons write, and they
// write only Solstice's own label (POST /api/loads/label), never a device. Owner only: GET /api/loads has no guest view.
import { $ } from '../lib/util.js';
import { esc } from '../lib/conf.js';
import { api } from '../lib/api.js';
import { sheet, sheetHead, sheetFoot, closeSheet } from './csheet.js';

/** A named load's colour, the same in the stack and in its row (`hue` from the server: its rank among the named loads); unnamed ones wear Big loads' colour. */
export const LOAD_ACC = ['c-acc-warn', 'c-acc-vac', 'c-acc-out', 'c-acc-batt', 'c-acc-grid'];
export const accOf = hue => hue == null ? 'c-acc-solar' : LOAD_ACC[hue % LOAD_ACC.length];
/** Never "measured" (whole-house inference): learned → l, estimated → e, learning → the dashed u (mockup am frame 4). */
const BT = { learned: 'l', estimated: 'e', learning: 'u' };
export const loadBadge = b => `<span class="c-badge" data-t="${BT[b] ?? 'e'}">${esc(b in BT ? b : 'estimated')}</span>`;

const h12 = h => (h % 12) || 12, ap = h => (h % 24) < 12 ? 'AM' : 'PM';
/** When it runs, for the row: "4–7 PM", "10 AM–2 PM", "after 9 PM" or "day and night". */
export function whenText(w) {
  if (!w) return 'day and night';
  if (w.to === 0 && w.from >= 20) return `after ${h12(w.from)} ${ap(w.from)}`;
  return ap(w.from) === ap(w.to) ? `${h12(w.from)}–${h12(w.to)} ${ap(w.to)}` : `${h12(w.from)} ${ap(w.from)}–${h12(w.to)} ${ap(w.to)}`;
}
/** The same for the sheet's sentence: "between 4 and 7 PM". */
export function betweenText(w) {
  if (!w) return 'day and night';
  if (w.to === 0 && w.from >= 20) return `after ${h12(w.from)} ${ap(w.from)}`;
  return `between ${h12(w.from)}${ap(w.from) === ap(w.to) ? '' : ` ${ap(w.from)}`} and ${h12(w.to)} ${ap(w.to)}`;
}
/** "5× a day" or "4× a week" (`long`: "4 times a week"). */
export function freqText(perDay, long = false) {
  const day = perDay >= 1, n = day ? Math.round(perDay) : Math.max(1, Math.round(perDay * 7));
  return `${n}${long ? (n === 1 ? ' time' : ' times') : '×'} a ${day ? 'day' : 'week'}`;
}
export const loadTitle = c => c.name ? esc(c.name) : `${c.kw.toFixed(1)} kW · ${c.minutes} min`;
export const loadLine = c => c.name ? `${c.kw.toFixed(1)} kW · ${c.minutes} min · ${freqText(c.perDay)}, ${whenText(c.window)}` : `${freqText(c.perDay)}, ${whenText(c.window)}`;
/** The 24-hour strip (12a–12a): one cell an hour, brighter where more runs start, and its hour labels. */
export const dayStrip = (hist, { acc = '', tall = false } = {}) =>
  `<div class="c-day${acc ? ` ${acc}` : ''}"${tall ? ' style="height:20px"' : ''}>${(hist ?? Array(24).fill(0)).map(v => `<i style="--v:${v}"></i>`).join('')}</div>`
  + '<div class="c-dlab"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>';

/** One cluster's row in Big loads. */
export function loadRow(c) {
  const sig = esc(c.sig);
  const btns = c.name ? `<button class="c-btn sm line" data-ld="name" data-sig="${sig}">Rename</button>`
    : c.dismissed ? `<button class="c-btn sm line" data-ld="name" data-sig="${sig}">Name it</button>`
    : `<button class="c-btn sm pri c-acc-solar" data-ld="name" data-sig="${sig}">Name it</button><button class="c-btn sm line" data-ld="dismiss" data-sig="${sig}">Not one appliance</button>`;
  return `<div class="c-load ${accOf(c.hue)}"><div class="c-load-h"><b>${loadTitle(c)}</b>${loadBadge(c.badge)}<span class="f">${c.kwhPerDay.toFixed(1)} kWh/day</span></div>`
    + `<p>${loadLine(c)}</p>${dayStrip(c.hist)}${c.suggestion ? `<p class="s">${esc(c.suggestion.text)}</p>` : ''}<div class="c-btns">${btns}</div></div>`;
}
export const loadsFig = v => `${v?.clusters?.length ?? 0} found`;
export const loadsBody = v => v?.clusters?.length ? v.clusters.map(loadRow).join('')
  : '<p class="c-fine">Nothing repeats often enough yet. A load needs 8 runs on 4 days in the last 30 to show here.</p>';

/* ---------- the naming sheet (frame 5) ---------- */
export const CHOICES = ['Oven', 'Range', 'Dishwasher', 'Dryer', 'Water heater', 'EV / tool charger', 'Other…'];
export const OTHER = 'Other…';
/** The sheet's first state: the current name, else the suggestion, else nothing picked. */
export function sheetState(c) {
  if (c.name) return CHOICES.includes(c.name) && c.name !== OTHER ? { choice: c.name, other: '' } : { choice: OTHER, other: c.name };
  return { choice: c.suggestion?.name && CHOICES.includes(c.suggestion.name) ? c.suggestion.name : null, other: '' };
}
/** The name the primary would save, or null (nothing picked, or Other… with an empty or too-long field). */
export function stagedName(st) {
  const n = st.choice === OTHER ? String(st.other ?? '').trim().replace(/\s+/g, ' ') : st.choice;
  return n && [...n].length <= 24 ? n : null;
}
export function nameSheetHtml(c, st) {
  const acc = accOf(c.hue), name = stagedName(st);
  const sub = `About ${c.kw.toFixed(1)} kW for ${c.minutes} minutes, ${freqText(c.perDay, true)}, ${betweenText(c.window)}.`;
  const foot = sheetFoot('Not one appliance', name ? `Save "${esc(name)}"` : 'Save', acc).replace('data-f="pri"', `data-f="pri"${name ? '' : ' disabled'}`);
  return sheetHead('Name this load', '', sub)
    + dayStrip(c.hist, { acc, tall: true })
    + '<div class="c-lab">What is it?</div>'
    + `<div class="c-fpills" role="group" aria-label="What is it?">${CHOICES.map(n => `<button class="c-fpill${n === st.choice ? ' on' : ''}" data-pick="${esc(n)}" aria-pressed="${n === st.choice}">${esc(n)}</button>`).join('')}</div>`
    + (st.choice === OTHER ? `<label class="c-field">Name<input class="c-input" id="ldOther" maxlength="24" autocomplete="off" placeholder="e.g. Kiln" value="${esc(st.other)}"></label>` : '')
    + `<p class="c-fine">Solstice tracks it under this name from now on, and it gets its own part in Where your energy goes. Names stay owner-only.</p>`
    + (st.err ? `<p class="c-fine" role="alert" style="color:var(--out)">${esc(st.err)}</p>` : '')
    + foot;
}

/* ---------- wiring ---------- */
const ld = { data: null, onChange: null };
/** Owner only (insights.js initBreakdown): the card loads with the breakdown; `onChange` reloads the breakdown after a name changes. */
export function initLoads(S, onChange) {
  const card = $('ldCard'); if (!card) return; card.hidden = !!S.guest; if (S.guest) return;
  ld.onChange = onChange;
  $('ldBody').onclick = e => {
    const b = e.target.closest('button[data-ld]'); if (!b) return;
    const c = ld.data?.clusters?.find(x => x.sig === b.dataset.sig); if (!c) return;
    if (b.dataset.ld === 'name') openNameSheet(c);
    else write(b, { sig: c.sig, dismissed: true });
  };
}
export async function loadLoads() {
  if (!$('ldCard') || $('ldCard').hidden) return;
  try { ld.data = await api.loads(); } catch (e) { $('ldFig').textContent = '—'; $('ldBody').innerHTML = `<p class="c-fine">Couldn’t load: ${esc(e.message)}</p>`; return; }
  drawLoads();
}
function drawLoads() { $('ldFig').textContent = loadsFig(ld.data); $('ldBody').innerHTML = loadsBody(ld.data); }
async function write(btn, body) {
  btn.disabled = true;
  try { ld.data = await api.labelLoad(body); drawLoads(); ld.onChange?.(); return null; }
  catch (e) { btn.disabled = false; return e.message; }
}
function openNameSheet(c) {
  const st = sheetState(c);
  const draw = (keep = false) => {
    sheet(nameSheetHtml(c, st), { keepScroll: keep });
    const box = $('sheetBody'), pri = box.querySelector('[data-f="pri"]'), sec = box.querySelector('[data-f="sec"]'), other = box.querySelector('#ldOther');
    box.querySelectorAll('[data-pick]').forEach(p => p.onclick = () => { st.choice = p.dataset.pick; st.err = null; draw(true); if (st.choice === OTHER) box.querySelector('#ldOther')?.focus(); });
    if (other) other.oninput = () => { st.other = other.value; const n = stagedName(st); pri.disabled = !n; pri.textContent = n ? `Save "${n}"` : 'Save'; };
    pri.onclick = async () => { const n = stagedName(st); if (!n) return; const err = await write(pri, { sig: c.sig, name: n }); if (err) { st.err = err; draw(true); } else closeSheet(); };
    sec.onclick = async () => { const err = await write(sec, { sig: c.sig, dismissed: true }); if (err) { st.err = err; draw(true); } else closeSheet(); };
  };
  draw();
}
