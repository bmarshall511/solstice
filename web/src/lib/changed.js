// I-18 "What changed" (approved mockup mockups/am-ideas.html frames 1, 2, 3 and 8), from GET /api/changed (server/src/learn/changed.ts).
// Pure: the change waterfall (.c-wf), the cards' sentences, and the Now morning line. kWh only, no dollar figure. The server sends
// numbers; every word is built here.
import { esc, badge } from './conf.js';

const MINUS = '−';
/** Row labels, by part id. `home` and `solar` are the bought waterfall's two rows. */
export const LABEL = { weather: 'Weather', ac: 'AC beyond the weather', pool: 'Pool', alwaysOn: 'Always-on', trip: 'Trip', unexplained: 'Unexplained',
  other: 'Everything else', home: 'Used more', solar: 'Solar & Powerwalls covered more' };
/** Each part's accent (the c-acc-* the mockup gives its row). */
export const ACC = { weather: 'c-acc-out', ac: 'c-acc-ac', pool: 'c-acc-pool', alwaysOn: 'c-acc-grid', trip: 'c-acc-vac', unexplained: 'c-acc-mute',
  other: 'c-acc-mute', home: 'c-acc-home', solar: 'c-acc-solar' };
/** "+3.8", "−0.2", "0.0" */
export function signed1(v) {
  const n = Math.round((+v || 0) * 10) / 10;
  return n > 0 ? `+${n.toFixed(1)}` : n < 0 ? `${MINUS}${Math.abs(n).toFixed(1)}` : '0.0';
}
const abs1 = v => Math.abs(Math.round(v * 10) / 10).toFixed(1);
const r0 = v => Math.round(v);
const weekdayOf = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });

/**
 * The change waterfall (component c-wf): one row per part, its bar from the centre line (right for more, left for less; the largest
 * part reaches 46% of the track), its badge, and the total row. The parts are the server's, which add up to `total`.
 */
export function wfHtml(parts, total, totalLabel, labels = LABEL) {
  const max = Math.max(0.1, ...parts.map(p => Math.abs(p.kwh)));
  const rows = parts.map(p => {
    const cls = p.kwh < 0 ? 'neg' : 'pos', w = Math.round(Math.abs(p.kwh) / max * 46);
    return `<div class="c-wf-r ${ACC[p.id] ?? 'c-acc-mute'}"><span class="c-wf-l">${esc(labels[p.id] ?? p.id)}${p.conf ? badge(p.conf) : ''}</span>`
      + `<span class="c-wf-t">${Math.round(p.kwh * 10) ? `<i class="${cls}" style="width:${w}%"></i>` : ''}</span><b class="${cls}">${signed1(p.kwh)}</b></div>`;
  }).join('');
  return `<div class="c-wf">${rows}<div class="c-wf-r c-wf-tot"><span class="c-wf-l">${esc(totalLabel)}</span><span class="c-wf-t"></span><b>${signed1(total)} kWh</b></div></div>`;
}

/** "vs a typical Tuesday" (the same weekday), "vs a typical day" (the last 7 days), "vs last week". */
export const vsText = c => c.scope === 'week' ? 'vs last week' : c.baseline?.kind === 'weekday' ? `vs a typical ${weekdayOf(c.date)}` : 'vs a typical day';
const typical = c => c.scope === 'week' ? 'last week' : c.baseline?.kind === 'weekday' ? `a typical ${weekdayOf(c.date)}` : 'a typical day';

/** The part that explains most of the change: the largest with the change's sign (null when the change is under 0.5 kWh). */
export function leadPart(c) {
  const H = c?.home; if (!H || Math.abs(H.delta) < .5) return null;
  return H.parts.filter(p => Math.sign(p.kwh) === Math.sign(H.delta)).sort((a, b) => Math.abs(b.kwh) - Math.abs(a.kwh))[0] ?? null;
}
const hotter = c => c.wx != null && c.wx.high > c.wx.baseHigh;
/** What the weather part was: the heat, the cold (heating), cooler or milder weather. */
const weatherWord = (c, v) => v > 0 ? (hotter(c) || !c.wx ? 'heat' : 'cold') : (hotter(c) ? 'milder weather' : 'cooler weather');

/** The owner's sentence under the Used waterfall (frame 1, and frame 2 for a week). */
export function usedSum(c) {
  const H = c?.home; if (!H) return '';
  const lead = leadPart(c); if (!lead) return `About the same as ${typical(c)}.`;
  const most = Math.abs(lead.kwh) >= .5 * Math.abs(H.delta), more = lead.kwh > 0, a = abs1(lead.kwh), week = c.scope === 'week';
  const pre = most ? 'Most of it was' : 'The biggest part was';
  let s;
  if (lead.id === 'weather') {
    if (week) {
      const adj = more ? (hotter(c) || !c.wx ? 'hotter' : 'colder') : (hotter(c) ? 'milder' : 'cooler');
      s = `A ${adj} week${c.wx ? ` (avg high ${r0(c.wx.high)}° vs ${r0(c.wx.baseHigh)}°)` : ''} explains ${most ? 'most of it' : 'the biggest part'}.`;
    } else s = `${pre} the ${weatherWord(c, lead.kwh)}${c.wx ? `: a ${r0(c.wx.high)}° high against ${r0(c.wx.baseHigh)}° on ${typical(c)}` : ''}.`;
  } else if (lead.id === 'ac') s = `${pre} the AC, ${a} kWh ${more ? 'more' : 'less'} than the weather explains.`;
  else if (lead.id === 'pool') s = `${pre} the pool, ${a} kWh ${more ? 'more' : 'less'}.`;
  else if (lead.id === 'alwaysOn') s = `${pre} the always-on load, ${a} kWh ${more ? 'higher' : 'lower'}.`;
  else if (lead.id === 'trip') s = more ? `${pre} last week’s trip: the house was empty then.` : `${pre} the trip: the house was empty.`;
  else s = `${pre} use the models can’t place.`;
  const pool = H.parts.find(p => p.id === 'pool');
  if (!week && lead.id !== 'pool' && pool && Math.abs(pool.kwh) >= .5) s += ` The pool ran ${abs1(pool.kwh)} kWh ${pool.kwh > 0 ? 'longer' : 'shorter'}.`;
  return s;
}
/** A guest's short sentence (frame 8): "Mostly the heat." */
export function guestSum(c) {
  const lead = leadPart(c); if (!c?.home) return ''; if (!lead) return `About the same as ${typical(c)}.`;
  return `Mostly ${lead.id === 'weather' ? `the ${weatherWord(c, lead.kwh)}` : lead.id === 'pool' ? 'the pool' : 'everything else'}.`;
}
/** How the sun compared: normal within 10% of the baseline, else strong or weak. */
export function sunWord(c) {
  const s = c?.import?.solar; if (!s || !(s.base > 0)) return null;
  const k = s.obs / s.base; return k > 1.1 ? 'strong' : k < .9 ? 'weak' : 'normal';
}
/** The sentence under the bought waterfall: "Sun was normal (54 kWh made); solar and the Powerwalls covered 1.9 kWh more." */
export function boughtSum(c) {
  const I = c?.import; if (!I) return '';
  const w = sunWord(c), s = I.solar, cov = -(I.parts.find(p => p.id === 'solar')?.kwh ?? 0);
  const sun = w == null ? '' : w === 'normal' ? `Sun was normal (${r0(s.obs)} kWh made)` : `Sun was ${w} (${r0(s.obs)} kWh made, ${r0(s.base)} typical)`;
  const tail = Math.abs(cov) < .1 ? 'solar and the Powerwalls covered the same' : `solar and the Powerwalls covered ${abs1(cov)} kWh ${cov > 0 ? 'more' : 'less'}`;
  return sun ? `${sun}; ${tail}.` : `${tail[0].toUpperCase()}${tail.slice(1)}.`;
}
/** Frame 1's fine print: what "typical" was. */
export function fineText(c) {
  const n = c?.baseline?.days ?? 0;
  const what = c?.baseline?.kind === 'weekday' ? `${n === 4 ? 'the last 4' : `${n} of the last 4`} ${weekdayOf(c.date)}s at home` : `the last ${n} day${n === 1 ? '' : 's'} at home`;
  return `Typical = ${what} (trip days left out). Parts add up to the change exactly; what the models can’t place is “Unexplained”.`;
}

/* ---------- the cards ---------- */
/** History › Day: What changed (frame 1; frame 8 for a guest: no segment, no fine print). `view`: 'home' (Used) or 'import' (Bought). */
export function dayCardHtml(c, { view = 'home', guest = false } = {}) {
  const head = `<div class="c-head"><h5>What changed</h5><span class="c-fig">${esc(vsText(c))}</span></div>`;
  if (guest) return `${head}${wfHtml(c.home.parts, c.home.delta, 'Used vs typical')}<div class="c-sum">${esc(guestSum(c))}</div>`;
  const imp = view === 'import';
  const seg = `<div class="c-seg sm" style="--n:2;--i:${imp ? 1 : 0};margin-top:10px" role="group" aria-label="Used or bought">`
    + `<button class="${imp ? '' : 'on'}" data-c="home" aria-pressed="${!imp}">Used</button><button class="${imp ? 'on' : ''}" data-c="import" aria-pressed="${imp}">Bought</button></div>`;
  const wf = imp ? wfHtml(c.import.parts, c.import.delta, 'Bought vs typical') : wfHtml(c.home.parts, c.home.delta, 'Used vs typical');
  return `${head}${seg}${wf}<div class="c-sum">${esc(imp ? boughtSum(c) : usedSum(c))}</div><p class="c-fine">${esc(fineText(c))}</p>`;
}
/** History › Day: Bought from PEC (frame 1's second card, owner only). */
export const buyCardHtml = c => `<div class="c-head"><h5>Bought from PEC</h5><span class="c-fig">${signed1(c.import.delta)} kWh</span></div>`
  + `${wfHtml(c.import.parts, c.import.delta, 'Bought vs typical', { ...LABEL, home: 'Used more (above)' })}<div class="c-sum">${esc(boughtSum(c))}</div>`;
const arrow = v => { const n = Math.round(v); return n > 0 ? `▲ ${n}` : n < 0 ? `▼ ${Math.abs(n)}` : '='; };
/** History › Week (frame 2): the week's figures and its waterfall against the week before. */
export function weekCardHtml(c, { guest = false } = {}) {
  const H = c.home, I = c.import, share = H.obs > 0 ? Math.max(0, Math.min(100, Math.round((1 - I.obs / H.obs) * 100))) : null;
  const mon = new Date(c.date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `<div class="c-head"><h5>Week of ${esc(mon)}</h5><span class="c-fig">${r0(H.obs)} kWh used</span></div>`
    + `<div class="c-kv" style="margin-top:10px"><span>Used</span><b>${r0(H.obs)} kWh · ${arrow(H.delta)}</b><span>Bought</span><b>${r0(I.obs)} kWh · ${arrow(I.delta)}</b><span>Sunshare</span><b>${share ?? '—'}%</b></div>`
    + `${wfHtml(H.parts, H.delta, 'Used vs last week')}<div class="c-sum">${esc(guest ? guestSum(c) : usedSum(c))}</div>`;
}

/* ---------- Now: the morning line (frame 3) ---------- */
export const MORNING_FROM = 6, MORNING_TO = 11, MORNING_MIN_KWH = 2, DISMISS_KEY = 'solstice:changed:dismissed';
const PHRASE = {
  weather: (c, v) => v > 0 ? (hotter(c) || !c.wx ? 'hotter' : 'colder') : (hotter(c) ? 'milder' : 'cooler'),
  ac: (c, v) => v > 0 ? 'more AC' : 'less AC', pool: (c, v) => v > 0 ? 'a longer pool run' : 'a shorter pool run',
  alwaysOn: (c, v) => v > 0 ? 'a higher always-on' : 'a lower always-on', trip: () => 'the trip',
};
/**
 * The banner from yesterday's answer, or null: only 06:00–11:00 (Chicago, `hour`), only for yesterday, not after Dismiss today, and
 * not when the kWh bought moved by under 2 kWh either way. "Why" opens History › Day for yesterday.
 */
export function morningBanner(c, { hour, today, dismissed = null }) {
  if (!c?.home || !c.import || hour < MORNING_FROM || hour >= MORNING_TO || dismissed === today) return null;
  const y = new Date(Date.parse(today + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  if (c.date !== y || c.scope !== 'day') return null;
  const d = c.import.delta; if (Math.abs(d) < MORNING_MIN_KWH) return null;
  const top = c.home.parts.filter(p => PHRASE[p.id] && Math.sign(p.kwh) === Math.sign(d) && Math.abs(p.kwh) >= .5)
    .sort((a, b) => Math.abs(b.kwh) - Math.abs(a.kwh)).slice(0, 2).map(p => `${PHRASE[p.id](c, p.kwh)} (${signed1(p.kwh)})`);
  const sun = sunWord(c), bits = [top.join(' and '), sun ? `sun was ${sun}` : ''].filter(Boolean).join(' · ');
  return { kind: 'changed', cls: 'plain', ic: 'bill', title: `Yesterday: ${abs1(d)} kWh ${d > 0 ? 'more' : 'less'} bought`,
    line: esc(bits ? bits[0].toUpperCase() + bits.slice(1) : ''), btns: [['Why', 'chg-why', false], ['Dismiss', 'chg-dismiss', false]] };
}
