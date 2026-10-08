// The "Your week" card's text (approved mockup mockups/t-enhancements.html frame 1), from GET /api/digest (server/src/digest.ts).
// Pure: kWh and counts only, no dollar figure.
import { confText, modelOf, TIERS, esc } from './conf.js';

const MINUS = '−';
/** Whole kWh with thousands separators: 312, 1,204. */
export const kwh0 = v => v == null || !Number.isFinite(+v) ? '—' : Math.round(+v).toLocaleString('en-US');
/** A signed whole-number change: +18, −9, 0. */
export function delta0(v) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const n = Math.round(+v); return n > 0 ? `+${n.toLocaleString('en-US')}` : n < 0 ? `${MINUS}${Math.abs(n).toLocaleString('en-US')}` : '0';
}
const md = (day, wd = true) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...(wd ? { weekday: 'short' } : {}), month: 'short', day: 'numeric' }).replace(',', '');
const weekNo = week => +String(week).split('-W')[1];
/** "Week 39 · Mon Sep 21 – Sun Sep 27" */
export const weekLabel = d => `Week ${weekNo(d.week)} · ${md(d.from)} – ${md(d.to)}`;
/** The week before `d`, as a date the API accepts. */
export const prevWeekDate = d => new Date(Date.parse(d.from + 'T12:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);

/** The lead line: "<b>54%</b> of what the house used came from sunshine, up 6 points on the week before." */
export function leadHtml(d) {
  const p = d.totals?.sunsharePct; if (p == null) return 'Not enough data for this week yet.';
  const pts = d.vsLastWeek?.sunsharePts, n = pts == null ? null : Math.abs(pts);
  const tail = pts == null ? '.' : pts === 0 ? ', the same as the week before.' : `, ${pts > 0 ? 'up' : 'down'} ${n} point${n === 1 ? '' : 's'} on the week before.`;
  return `<b>${p}%</b> of what the house used came from sunshine${tail}`;
}

/** Which way is good for each figure: more solar, less bought; used only turns amber when it rose; sent stays neutral. */
export function deltaClass(key, v) {
  const n = Math.round(v ?? 0); if (!n) return '';
  if (key === 'solarKwh') return n > 0 ? 'up' : 'dn';
  if (key === 'importKwh') return n < 0 ? 'up' : 'dn';
  if (key === 'homeKwh') return n > 0 ? 'dn' : '';
  return '';
}
/** The four figure cells: [label, value, change text, class]. `vs` is "last wk" or "wk 37". */
export function gridCells(d, vs = 'last wk') {
  return [['Solar', 'solarKwh'], ['Used', 'homeKwh'], ['Bought from PEC', 'importKwh'], ['Sent to PEC', 'exportKwh']].map(([label, k]) => {
    const v = d.vsLastWeek?.[k];
    return [label, kwh0(d.totals?.[k]), v == null ? 'no week before' : `${delta0(v)} vs ${vs}`, v == null ? '' : deltaClass(k, v)];
  });
}
export const gridHtml = cells => cells.map(([l, v, t, c]) => `<div><small>${l}</small><b>${v} <small>kWh</small></b><em class="${c}">${t}</em></div>`).join('');

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const MODE = { off: 'Off', suggest: 'Suggest', auto: 'Auto' };
/** One line per Autopilot: [icon, colour, bold title, text]. `modes`: {pool, ac, powerwall} as the app knows them. */
export function autopilotLines(d, modes = {}) {
  const a = d.autopilot ?? {}, p = a.pool ?? {}, ac = a.ac ?? {}, pw = a.powerwall ?? {}, pwr = d.powerwall ?? {};
  const clamps = n => n ? `${plural(n, 'write')} refused by the safety clamps.` : 'None refused by the safety clamps.';
  const pool = modes.pool === 'auto' ? `Wrote ${plural(p.applied ?? 0, 'nightly plan')}.` : `${plural(p.suggested ?? 0, 'plan')} suggested, ${p.applied ?? 0} applied.`;
  const acT = `${plural(ac.set ?? 0, 'setpoint write')}. ${clamps(ac.refused ?? 0)}`;
  const full = pwr.daysWithData ? ` Powerwalls full ${pwr.fullDays} of ${pwr.daysWithData} days.` : '';
  const pwT = `${plural(pw.suggested ?? 0, 'suggestion')}, ${pw.sent ? `${pw.sent} applied` : 'not applied'}.${pw.scopeMissing ? ` ${pw.scopeMissing} waiting for the energy_cmds permission.` : ''}${full}`;
  return [
    ['≈', 'var(--home)', `Pool · ${MODE[modes.pool] ?? '—'}.`, pool + (p.refused ? ` ${clamps(p.refused)}` : '')],
    ['❄', '#ff9e66', `AC · ${MODE[modes.ac] ?? '—'}.`, acT],
    ['▮', 'var(--batt)', `Powerwall rules · ${modes.powerwall ?? '—'}.`, pwT],
  ];
}
/** The rules' mode word for the Powerwall line and the rules card badge: "Suggest", "Off", "2 in Auto". */
export function rulesMode(modes) {
  const m = Object.values(modes ?? {}); if (!m.length) return '—';
  if (m.every(x => x === m[0])) return MODE[m[0]] ?? m[0];
  const auto = m.filter(x => x === 'auto').length; return auto ? `${auto} in Auto` : 'Suggest';
}

/** "Worth a look: …" from the first open anomaly, or null. */
export function anomalyHtml(d) {
  const a = d.anomalies?.items?.[0]; if (!a) return null;
  const more = (d.anomalies.open ?? 1) - 1;
  return `<b>Worth a look:</b> ${esc(a.title)}${/[.!?]$/.test(a.title) ? '' : '.'}${more > 0 ? ` (+${more} more)` : ''}`;
}

/** Mockup am frame 7 (I-15): "<b>Strip heat:</b> 3 mornings · 31 kWh (2 after setbacks)." from the digest's `strip`, or null with none. */
export function stripHtml(d) {
  const w = d.strip; if (!w?.mornings) return null;
  return `<b>Strip heat:</b> ${w.mornings} morning${w.mornings === 1 ? '' : 's'} · ${kwh0(w.kwh)} kWh${w.setbacks ? ` (${w.setbacks} after setback${w.setbacks === 1 ? '' : 's'})` : ''}.`;
}

/** The learning badges: the four figures the week leaned on, each with its tier from the digest and the model report's text. */
export const DIGEST_MODELS = [['fc48.solar', 'solar model'], ['ac.shifted', 'AC'], ['pool.kwhDay', 'pump curve'], ['fc48.soc', '48 h forecast']];
export function badgesHtml(d, models) {
  return DIGEST_MODELS.map(([id, label]) => {
    const tier = d.confidence?.[id], text = confText(tier, modelOf(models, id));
    return text == null ? '' : `<span class="conf" data-t="${TIERS[tier]}">${esc(`${label} ${text}`)}</span>`;
  }).join('');
}
