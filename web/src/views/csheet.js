// The shared bottom sheet in the component system's shape (approved mockup mockups/al-ia.html v2, component 11): a title row with a
// 44 px close, content, and a pinned glass footer whose primary names the exact write. It renders into the app's one #sheet, so the
// dialog semantics, the focus on open, Escape and the scrim (main.js) stay as they are; main.js gives #sheet the `is-c` look
// whenever the body is one of these.
import { $ } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { esc } from '../lib/conf.js';
import { sparkPaths } from '../lib/nowui.js';

export const closeSheet = () => $('phone').classList.remove('open');
/** Draw `html` as the sheet's body and open it (a redraw keeps the scroll position). */
export function sheet(html, { keepScroll = false } = {}) {
  const el = $('sheet'), top = keepScroll ? el.scrollTop : 0;
  $('sheetBody').innerHTML = `<div class="c-sbody">${html}</div>`;
  $('sheetBody').querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
  $('phone').classList.add('open');
  el.scrollTop = top;
}
const WORD = { auto: 'Auto', suggest: 'Suggest', off: 'Off', home: 'Home', away: 'Away', boost: 'Boost', clear: 'Clear-up' };
/** The small uppercase mode pill (not a control). */
export const modePill = m => m ? `<span class="c-mode ${esc(m)}">${WORD[m] ?? esc(m)}</span>` : '';
/** The title row and the sub line. */
export const sheetHead = (title, extra = '', sub = '') =>
  `<div class="c-sheet-h"><h4>${title}</h4>${extra}<button class="c-x" data-close aria-label="Close">${icon('x')}</button></div>${sub ? `<p class="c-sheet-sub">${sub}</p>` : ''}`;
/** The pinned footer: [secondary (line)] [primary (filled in the accent)]. Buttons carry data-f="sec" and data-f="pri". */
export const sheetFoot = (sec, pri, acc = 'c-acc-house', { del = false } = {}) =>
  `<div class="c-sheet-f">${sec ? `<button class="c-btn ${del ? 'del' : 'line'}" data-f="sec">${sec}</button>` : ''}<button class="c-btn pri ${acc}" data-f="pri">${pri}</button></div>`;
/** A sliding-pill segment. `opts` = [[value, label(html)], …]. */
export function seg(opts, cur, { cls = 'acc wide', acc = '', attr = 'data-v', label = '' } = {}) {
  const i = Math.max(0, opts.findIndex(o => o[0] === cur));
  return `<div class="c-seg ${cls} ${acc}" style="--n:${opts.length};--i:${i}" role="group"${label ? ` aria-label="${esc(label)}"` : ''}>${opts.map(([v, l, dis]) =>
    `<button ${attr}="${esc(v)}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}"${dis ? ' aria-disabled="true" style="opacity:.4"' : ''}>${l}</button>`).join('')}</div>`;
}
/** A compact system row (role=button unless `static`). */
export function sysRow({ acc, ic, title, mode = '', line = '', end = '', id = '', go = '', stat = false, chev = true }) {
  return `<div class="c-sys compact ${stat ? 'static ' : ''}${acc}"${stat ? '' : ' role="button" tabindex="0"'}${id ? ` id="${id}"` : ''}${go ? ` data-go2="${esc(go)}"` : ''}>
    <span class="c-ic">${icon(ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${title}</b>${mode}</div>${line ? `<div class="c-sys-l">${line}</div>` : ''}</div>${end || (stat || !chev ? '<span></span>' : `<span class="c-chev">${icon('chev')}</span>`)}</div>`;
}
/** A banner (component 9): lead icon or ring, title, one line, an optional bar, at most two buttons ([label, data-b key, primary?]). */
export function banner({ cls, ic = '', ring = null, title, line = '', bar = null, btns = [] }) {
  const lead = ring ? `<div class="c-ring c-acc-grid"><svg viewBox="0 0 40 40"><circle class="t" cx="20" cy="20" r="16"/><circle class="v" cx="20" cy="20" r="16" stroke-dasharray="${(ring.pct / 100 * 100.5).toFixed(1)} 100.5"/></svg><b>${ring.pct}%</b></div>`
    : `<span class="c-ic">${icon(ic)}</span>`;
  return `<div class="c-ban ${cls}">${lead}<b>${title}</b>${line ? `<p>${line}</p>` : '<p></p>'}${bar != null ? `<div class="c-bar"><i style="width:${Math.round(bar)}%"></i></div>` : ''}${btns.length ? `<div class="c-btns">${btns.slice(0, 2).map(([l, k, pri], i) => `<button class="c-btn ${pri ?? i === 0 ? 'pri' : 'line'}" data-b="${esc(k)}">${l}</button>`).join('')}</div>` : ''}</div>`;
}
/** Enter or Space on a role=button element clicks it (rows, disclosure headers, date cards). */
export function keyActivate(root = document) {
  root.addEventListener('keydown', e => {
    const t = e.target; if ((e.key !== 'Enter' && e.key !== ' ') || !t.matches?.('[role=button]:not(button)')) return;
    e.preventDefault(); t.click();
  });
}

/** A metric tile (component 1): label (+ badge), value and unit, an optional note line, a delta or note chip, a 7-value sparkline. */
export function tileHtml({ id = '', acc, k, v, unit = '', note = '', chip = null, spark = null, badge = '' }) {
  const sp = spark ? sparkPaths(spark) : null, gid = `sg-${id || Math.random().toString(36).slice(2, 8)}`;
  return `<div class="c-tile ${acc}"${id ? ` id="${id}"` : ''}><div class="c-tile-k">${k}${badge}</div><div class="c-tile-v"><b>${v}</b>${unit ? `<small>${unit}</small>` : ''}</div>${note ? `<div class="c-tile-n">${note}</div>` : ''}${chip ? `<span class="c-delta" data-t="${chip.t ?? 'flat'}">${chip.text}</span>` : ''}${sp
    ? `<svg class="c-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:currentColor;stop-opacity:.38"/><stop offset="1" style="stop-color:currentColor;stop-opacity:0"/></linearGradient></defs><path d="${sp.area}" fill="url(#${gid})"/><path d="${sp.line}" fill="none" stroke="currentColor" stroke-width="1.7" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg>`
    : '<span class="c-spark"></span>'}</div>`;
}
/** A 24-hour plan strip (12a–12a) with its blocks, write ticks and the now tick; `lab` adds the hour labels under it. */
export const planStrip = (nowP, blocks = [], ticks = [], lab = false) => `<div class="c-plan" style="--now:${nowP}%">${blocks.map(b => `<i class="${b.cls ?? ''}" style="left:${b.left}%;width:${b.width}%"></i>`).join('')}${ticks.map(x => `<u style="left:${x}%"></u>`).join('')}<s></s></div>${lab ? '<div class="c-plan-lab"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>' : ''}`;
/** A system card's top (component 2, static): icon, title, mode pill, live value, line and an optional strip. */
export const sysTop = ({ ic, title, mode = '', value = '', line = '', plan = '' }) =>
  `<span class="c-ic">${icon(ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${title}</b>${mode}${value !== '' ? `<span class="c-sys-v">${value}</span>` : ''}</div>${line ? `<div class="c-sys-l">${line}</div>` : ''}${plan}</div><span></span>`;
/** A segment's sliding pill follows its `on` button. */
export function segSet(el, v, attr = 'data-v') {
  if (!el) return; const bs = [...el.querySelectorAll(`[${attr}]`)], i = Math.max(0, bs.findIndex(b => b.getAttribute(attr) === v));
  el.style.setProperty('--i', i); bs.forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-pressed', String(k === i)); });
}
/**
 * Disclosure cards and their rows (component 6), by delegation under `root`: a `.c-disc-h` opens its card's `.c-disc-body`; a row
 * `[data-row]` inside `.c-rows` opens the `.c-inner` right after it. Cards marked `data-own` handle their own header.
 */
export function wireDisclosures(root) {
  root.addEventListener('click', e => {
    const h = e.target.closest('.c-disc-h');
    if (h && !e.target.closest('button,a,input')) { const card = h.closest('.c-disc'); if (!card || card.hasAttribute('data-own')) return;
      const open = !card.classList.contains('expanded'); card.classList.toggle('expanded', open); h.setAttribute('aria-expanded', String(open));
      const body = card.querySelector(':scope > .c-disc-body'); if (body) body.hidden = !open; card.dispatchEvent(new CustomEvent('disc', { detail: open })); return; }
    const r = e.target.closest('.c-rows > [data-row]');
    if (r && !e.target.closest('button:not([data-row]),a,input')) { const inner = r.nextElementSibling; if (!inner?.classList.contains('c-inner')) return;
      const open = !r.classList.contains('c-open'); r.classList.toggle('c-open', open); inner.classList.toggle('c-open', open); inner.hidden = !open; r.setAttribute('aria-expanded', String(open)); }
  });
}
