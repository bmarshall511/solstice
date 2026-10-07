// The shared bottom sheet in the component system's shape (approved mockup mockups/al-ia.html v2, component 11): a title row with a
// 44 px close, content, and a pinned glass footer whose primary names the exact write. It renders into the app's one #sheet, so the
// dialog semantics, the focus on open, Escape and the scrim (main.js) stay as they are; main.js gives #sheet the `is-c` look
// whenever the body is one of these.
import { $ } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { esc } from '../lib/conf.js';

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
