// The Log sheet (approved mockup mockups/al-ia.html v2, frame 18): one timeline fed by the pool log, the AC log, the Powerwall rules
// log and the learning log. Pure helpers: merge, kind, fold repeats, filter, group by day, CSV. views/timeline.js draws it.
import { dayOf, clock } from './presence.js';
import { RULE, val, pwResultText } from './pwrules.js';

export const SOURCES = { pool: 'Pool Autopilot', ac: 'AC Autopilot', pw: 'Powerwall rules', learn: 'Learning' };
/** The filter pills, in order: [id, label]. Info also shows the warnings (refusals, failures). */
export const FILTERS = [['all', 'All'], ['wrote', 'Wrote'], ['you', 'You'], ['sugg', 'Suggested'], ['info', 'Info']];

/** What a pool / AC / learning log line is: Solstice wrote it, you did it, a suggestion, a warning, or information. */
export function logKind(text = '', delta = '') {
  const t = String(text), d = String(delta ?? '');
  if (d === 'refused' || d === 'error' || /^(Refused|Couldn|Failed)/.test(t)) return 'warn';
  if (d === 'you' || d === 'resumed' || /^(You|Someone)\b/.test(t)) return 'you';
  if (/^Suggest/.test(t)) return 'sugg';
  if (/^(Set |Tomorrow:|Wrote|Holding|Spare solar|No spare solar|Pre-cool|Clear-up done|Applied|Trimmed|AC trim|The last schedule write)/.test(t)) return 'wrote';
  return 'info';
}
/** A Powerwall rules log row → its timeline text, sub line and kind. */
export function pwEntry(l) {
  const v = val(l.command, l.value), noun = l.command === 'grid_import_export' ? 'export' : 'reserve', title = RULE[l.rule]?.title ?? 'Powerwall';
  if (l.result === 'sent') return { text: `Set ${noun} ${noun === 'export' ? `to ${v}` : v}`, sub: `${title}${l.source === 'owner' ? ' · you applied' : ''}`, kind: l.source === 'owner' ? 'you' : 'wrote' };
  if (l.result === 'suggested') return { text: `Suggested ${noun} ${v}${l.rule === 'storm' ? ' (storm)' : ''}`, sub: 'not applied', kind: 'sugg' };
  return { text: `${title}: ${pwResultText(l, l.at ? clock(l.at) : '—')}`, sub: SOURCES.pw, kind: l.result === 'unchanged' ? 'info' : 'warn' };
}

/** One source's rows → timeline entries, newest first, consecutive identical lines folded into one with `n` and the day range. */
function fromSource(src, rows) {
  const out = [];
  for (const r of rows ?? []) {
    const at = Number.isFinite(r.at) ? r.at : r.day ? Date.parse(`${r.day}T12:00:00Z`) : null; if (at == null) continue;
    const day = Number.isFinite(r.at) ? dayOf(r.at) : r.day;   // the instant decides the day (a row's own `day` can be its plan's date)
    const e = src === 'pw' ? { ...pwEntry(r) } : { text: String(r.text ?? ''), sub: SOURCES[src] + (r.delta && !['you', 'resumed'].includes(r.delta) ? ` · ${r.delta}` : ''), kind: src === 'learn' && logKind(r.text, r.delta) === 'you' ? 'info' : logKind(r.text, r.delta) };
    out.push({ at, day, src, timed: Number.isFinite(r.at), delta: r.delta ?? null, ...e, n: 1, from: day, to: day });
  }
  out.sort((a, b) => b.at - a.at);
  return foldRepeats(out);
}
/** Consecutive entries (newest first) with the same source and text become one entry: the newest, with `n` and from–to days. */
export function foldRepeats(entries) {
  const out = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last && last.src === e.src && last.text === e.text) { last.n += e.n ?? 1; last.from = e.from ?? e.day; continue; }
    out.push({ ...e, n: e.n ?? 1, from: e.from ?? e.day, to: e.to ?? e.day });
  }
  return out;
}
/** Merge the four logs: { pool, ac, pw, learn } (each the array its API returned), newest first. */
export function mergeLog(logs = {}) {
  return ['pool', 'ac', 'pw', 'learn'].flatMap(src => fromSource(src, logs[src])).sort((a, b) => b.at - a.at);
}
/** A guest's log (share links): Solstice's own writes, suggestions and notes only. Anything a person did, and any line about a hold,
 *  Away, a trip or Eco (they say whether someone is home), stays with the owner. */
const PRIVATE = /\b(hold|holding|held|away|vacation|trip|eco|home|someone|thermostat)\b/i;
export const guestSafe = entries => entries.filter(e => e.kind !== 'you' && !['hold', 'resumed', 'eco'].includes(e.delta) && !PRIVATE.test(`${e.text} ${e.sub ?? ''}`));
export const filterLog = (entries, f = 'all') => f === 'all' ? entries : entries.filter(e => f === 'info' ? e.kind === 'info' || e.kind === 'warn' : e.kind === f);
/** How many entries each filter shows (for the pills' labels and tests). */
export const filterCounts = entries => Object.fromEntries(FILTERS.map(([id]) => [id, filterLog(entries, id).length]));

const addDay = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dateWords = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
/** "Today · Wed Oct 7", "Yesterday · Tue Oct 6", "Sun Oct 4". */
export function dayLabel(day, today) {
  return day === today ? `Today · ${dateWords(day)}` : day === addDay(today, -1) ? `Yesterday · ${dateWords(day)}` : dateWords(day);
}
/** "Oct 4 – Oct 7" for a folded entry. */
export const rangeLabel = (from, to) => { const f = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }); return from === to ? f(to) : `${f(from)} – ${f(to)}`; };
/** Entries (newest first) → [{ day, label, items }] in the same order. */
export function groupByDay(entries, today) {
  const out = [];
  for (const e of entries) { const last = out.at(-1); if (last && last.day === e.day) last.items.push(e); else out.push({ day: e.day, label: dayLabel(e.day, today), items: [e] }); }
  return out;
}
/** The entry's time as the timeline prints it ("7:00 AM"); "—" when the row had only a day. */
export const timeOf = e => e.timed ? clock(e.at) : '—';

const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The entries as CSV (what Export saves on the device). */
export function timelineCsv(entries) {
  const rows = [['day', 'time', 'source', 'kind', 'text', 'detail', 'repeats', 'first day']];
  for (const e of entries) rows.push([e.day, timeOf(e), SOURCES[e.src] ?? e.src, e.kind, e.text, e.sub ?? '', e.n ?? 1, e.from ?? e.day]);
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
