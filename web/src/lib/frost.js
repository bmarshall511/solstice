// The Frost language for guests (share view, mockups/q-share.html; docs/audit-designs/share-view.md §4): veils in place of
// dollar values and locked cards over deterministic skeletons. The server never sends a guest a dollar value or a rate, so
// a veil is a decoy of the slot's shape, never a filter over real text; skeletons are fixed patterns, not data.
import { $ } from './util.js';

/** HTML-escape text that came from a person (link labels, the name shown on invites). */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** While the Frost wipe is running, new veils wait (paused) until the clearing frost uncovers them. */
let hold = false;
export const holdVeils = on => { hold = on; };
/** A veil: the frosted "$•••" pill in the slot's shape: money '$•••', cents '$•.••', monthly '$•••/mo', yearly '$•,•••',
 *  rate '$•.••••/kWh', payback '•• yrs'. */
export const veil = (shape = '$•••') => `<data class="veil${hold ? ' wait' : ''}">${shape}</data>`;

/** "The owner" at the start of a sentence, "the owner" inside one; any other name as the owner typed it (escaped). */
export const nameStart = name => esc(name || 'The owner');
export const nameMidText = name => (!name || name === 'The owner' ? 'the owner' : name);
export const nameMid = name => esc(nameMidText(name));

const LOCK = '<svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="#f2f4f8" stroke-width="1.5"><rect x="1" y="6" width="10" height="7" rx="2"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2"/></svg>';
const saved = new WeakMap();
/** Lock a card: its title stays, the body becomes a skeleton under frosted glass with "Private to {name}" and one reason.
 *  The owner's markup is kept, so unlockCards() can put it back when the owner leaves the preview. */
export function lockCard(card, { title, sub, body, reason, name }) {
  if (!card) return;
  const h = card.querySelector(':scope > .h');                 // the owner's title (and subtitle) unless told otherwise
  title ??= h?.querySelector('b')?.innerHTML ?? ''; sub ??= h?.querySelector('span')?.innerHTML ?? '';
  if (!saved.has(card)) saved.set(card, card.innerHTML);
  card.classList.add('locked'); card.dataset.frost = '1';
  card.innerHTML = `<div class="h"><b>${title}</b><span>${sub}</span></div>${body}<div class="lock"><i>${LOCK}</i><b>Private to ${nameMid(name)}</b>${reason}</div>`;
}
/** Put every locked card back as the owner's card (their views then redraw into it). */
export function unlockCards() {
  document.querySelectorAll('.card[data-frost]').forEach(card => {
    if (saved.has(card)) card.innerHTML = saved.get(card);
    saved.delete(card); card.classList.remove('locked'); delete card.dataset.frost;
  });
}

/* ---------- deterministic skeletons (fixed patterns at the owner card's size, never derived from data) ---------- */
const K = 'rgba(255,255,255,.16)';
export const skWaterfall = () => `<svg class="mini" viewBox="0 0 310 190" aria-hidden="true">${[[70, 118, 180], [92, 196, 102], [104, 164, 32], [72, 150, 14], [52, 118, 64]].map(([lw, x, w], i) => {
  const y = 8 + i * 36; return `<rect x="0" y="${y + 8}" width="${lw}" height="9" rx="4.5" fill="${K}"/><rect x="${x}" y="${y + 4}" width="${w}" height="16" rx="4" fill="${K}"/><rect x="${x + w + 5}" y="${y + 8}" width="26" height="8" rx="4" fill="rgba(255,255,255,.1)"/>`; }).join('')}</svg>`;
export const skCycle = pct => `<div class="cyc"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(0)}%;background:rgba(255,255,255,.22)"></i></div><div class="cycl"><span class="skl" style="width:40px"></span><span class="skl" style="width:34px"></span><span class="skl" style="width:40px"></span></div>
  <div class="kv"><span><i class="skl" style="width:62%"></i></span><b><i class="skl" style="width:58px"></i></b><span><i class="skl" style="width:54%"></i></span><b><i class="skl" style="width:44px"></i></b>
  <span><i class="skl" style="width:40%"></i></span><b><i class="skl" style="width:52px"></i></b><span><i class="skl" style="width:58%"></i></span><b><i class="skl" style="width:90px"></i></b></div>`;
export const skMonthly = () => `<svg class="mini" viewBox="0 0 310 130" aria-hidden="true">${[[70, 22], [66, 18], [74, 26], [82, 34], [90, 40], [96, 44], [98, 46], [94, 42], [84, 32], [72, 24], [66, 20], [70, 22]].map(([a, b], i) => {
  const x = 6 + i * 25.5; return `<rect x="${x}" y="${104 - a}" width="19" height="${a}" rx="5" fill="rgba(255,255,255,.13)"/><rect x="${x + 4}" y="${104 - b}" width="11" height="${b}" rx="3" fill="${K}"/><rect x="${x + 6}" y="114" width="7" height="7" rx="3.5" fill="rgba(255,255,255,.1)"/>`; }).join('')}</svg>
  <div class="legend" style="justify-content:flex-start"><span class="skl" style="width:80px"></span><span class="skl" style="width:150px"></span></div><span class="skl" style="width:130px;height:36px;border-radius:999px;margin-top:12px"></span>`;
export const skLines = () => `<div class="rec" style="margin-top:10px">${[92, 84, 96, 70, 88, 40].map((w, i) => `<span class="skl" style="width:${w}%${i ? ';margin-top:9px' : ''}"></span>`).join('')}</div>`;

/** One explanation for every veil and locked card: tap it, get the privacy toast. */
export function explainOnTap(toast, name) {
  document.addEventListener('click', e => {
    if (!e.target.closest('.veil, .card.locked')) return;
    toast('🔒', 'rgba(255,255,255,.14)', `Private to ${nameMidText(name())}`, `Dollar amounts, bills and controls stay with ${nameMidText(name())}.`);   // toast() sets text, not HTML
  });
}
/** The card around an element, found once (a locked card loses its inner ids). */
const cards = {};
export const cardOf = id => (cards[id] ??= $(id)?.closest('.card') ?? null);
