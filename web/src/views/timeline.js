// The Log sheet (approved mockup mockups/al-ia.html v2, frame 18): one timeline (component 7) fed by the pool log, the AC log, the
// Powerwall rules log and the learning log, opened from any Autopilot's Log row (and a Powerwall rule's sheet). Filter pills (All ·
// Wrote · You · Suggested · Info), sticky day labels, mono times, coloured dots, repeats folded into "×N". Export saves the entries
// shown as a CSV on this device (no route: nothing leaves the phone); it is the owner's only. Read-only otherwise.
import { $, localDate } from '../lib/util.js';
import { esc } from '../lib/conf.js';
import { mergeLog, filterLog, groupByDay, timeOf, rangeLabel, timelineCsv, FILTERS, SOURCES } from '../lib/timeline.js';
import { sheet, sheetHead, sheetFoot, closeSheet } from './csheet.js';

/** Open the log. `src` ('pool' | 'ac' | 'pw' | 'learn') narrows it to one system; the sheet can widen it again. */
export function openLog(S, { src = null } = {}) {
  let filter = 'all', only = src;
  const draw = () => {
    const logs = { pool: S.pool?.autopilot?.log, ac: S.ac?.log, pw: S.pwRules?.log, learn: S.models?.log };
    const all = mergeLog(only ? { [only]: logs[only] } : logs), shown = filterLog(all, filter), days = groupByDay(shown, localDate());
    const pills = FILTERS.map(([id, label]) => `<button class="c-fpill${id === 'all' ? '' : ` c-k-${id}`}${id === filter ? ' on' : ''}" data-fl="${id}" aria-pressed="${id === filter}">${id === 'all' ? '' : '<i></i>'}${label}</button>`).join('');
    const tl = days.map(g => `<div class="c-tl-day">${esc(g.label)}</div><div class="c-tl-g">${g.items.map(e => `<div class="c-tl-e c-k-${e.kind}"><time>${timeOf(e)}</time><i></i><p>${esc(e.text)}${e.n > 1 ? `<span class="c-tl-x">×${e.n}</span>` : ''}<small>${only && e.sub === SOURCES[e.src] && e.n === 1 ? '' : esc(e.sub)}${e.n > 1 ? `${e.sub ? ' · ' : ''}${rangeLabel(e.from, e.to)}` : ''}</small></p></div>`).join('')}</div>`).join('');
    const sub = only ? `${SOURCES[only]} only · <button class="c-btn sm line" data-wide style="margin-left:4px">All systems</button>` : '';
    sheet(`${sheetHead('Log', `<span class="c-badge">${esc(only ? SOURCES[only] : 'all systems')}</span>`)}${sub ? `<p class="c-sheet-sub" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${sub}</p>` : ''}
      <div class="c-fpills" style="margin-top:6px" role="group" aria-label="Show">${pills}</div>
      <div class="c-tl">${tl || `<p class="c-fine" style="text-align:center;margin:24px 0">${all.length ? 'Nothing of that kind in the log.' : 'Nothing logged yet. Every write, suggestion and change will be listed here.'}</p>`}</div>
      ${sheetFoot(S.guest || !shown.length ? '' : 'Export', 'Done')}`, { keepScroll: true });
    const body = $('sheetBody');
    body.querySelector('.c-fpills').onclick = e => { const b = e.target.closest('[data-fl]'); if (b) { filter = b.dataset.fl; draw(); } };
    body.querySelector('[data-wide]')?.addEventListener('click', () => { only = null; draw(); });
    body.querySelector('[data-f="pri"]').onclick = closeSheet;
    body.querySelector('[data-f="sec"]')?.addEventListener('click', () => save(shown));
  };
  draw();
}
/** Export: the entries shown, as a CSV the browser saves (built here, from what the sheet already holds). */
function save(entries) {
  const url = URL.createObjectURL(new Blob([timelineCsv(entries)], { type: 'text/csv' })), a = document.createElement('a');
  a.href = url; a.download = `solstice-log-${localDate()}.csv`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
