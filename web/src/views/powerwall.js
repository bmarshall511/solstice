// Systems › Powerwall: the Rules card (approved mockup mockups/t-enhancements.html frame 5, as compact rows by mockup al frame 11); each
// row opens its rule well as a sheet.
// Data: GET /api/powerwall/rules (server/src/powerwall.ts). Suggest never writes; Apply (after a confirm) and Auto go through
// tesla/commands.ts, which checks the energy_cmds scope, the clamps in appliances/guards.ts and the hourly slot. Owner-only.
import { $, niceDate, toast } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { sheet, sheetHead, sheetFoot, modePill, seg, closeSheet } from './csheet.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { rulesMode } from '../lib/digest.js';
import { clock, dayOf, when } from '../lib/presence.js';
import { RULE, EXPORT, MODE, val, limits, pwResultText } from '../lib/pwrules.js';


export { RULE, EXPORT, MODE, val, limits };
const code = v => `<code style="font:11px 'JetBrains Mono'">${esc(v)}</code>`;
const teslaSteps = (id, v) => id === 'export' ? `In the Tesla app: Powerwall › Settings › Energy Exports › ${v === 'pv_only' ? 'Solar' : 'Everything'}.`
  : `In the Tesla app: Powerwall › Settings › Backup Reserve › ${v}%.`;
const autoWhen = { reserve: 'at the 5 PM check', storm: 'on the next 5-minute check', export: 'with tonight’s sync' };

/* skipping a suggestion is this device's own note: it hides that value for today, nothing is sent */
const skipKey = (id, v) => `solstice:pwskip:${id}:${v}:${dayOf(Date.now())}`;
export const skipped = (id, v) => { try { return localStorage.getItem(skipKey(id, v)) === '1'; } catch { return false; } };
export const skip = (id, v) => { try { localStorage.setItem(skipKey(id, v), '1'); } catch { /* storage off */ } };

/** One log row as the "last" line and the log timeline read it. */
function logText(l, withRule) {
  const who = l.result === 'sent' ? (l.source === 'owner' ? 'you applied' : 'auto') : '', t = pwResultText(l, clock(l.at));
  return withRule ? `${esc(RULE[l.rule]?.title ?? l.rule ?? l.command)} · ${esc(t)}${who ? ` <em>${who}</em>` : ''}` : esc(t.charAt(0).toUpperCase() + t.slice(1) + (who ? ` (${who})` : '') + '.');
}
const day = at => niceDate(dayOf(at));

/** A rule's suggestion as the rule sheet shows it: a mode line with its own Apply and Skip (or what Auto will do). */
function recHtml(r, cmds) {
  const s = r.suggestion ?? {}, v = s.value, reason = esc(s.reason ?? '');
  const line = (b, rest = '', acc = 'c-acc-batt', btns = '') => `<div class="c-modeline ${acc}"><p><b>${b}</b> ${rest}</p>${btns}</div>`;
  if (r.mode === 'off') return line('Off.', 'No suggestions and no pushes for this rule.', 'c-acc-mute');
  if (r.mode === 'auto') return s.action === 'set' ? line(`Auto: sets ${esc(val(s.command, v))} ${autoWhen[r.id]}.`, `${reason} Every change is logged.`) : line('Auto: no change.', reason);
  if (s.action !== 'set') return line(s.action === 'wait' ? 'Waiting.' : 'No change.', reason, 'c-acc-mute');
  if (skipped(r.id, v)) return line('Skipped for today.', reason, 'c-acc-mute');
  const head = r.id === 'reserve' ? `Suggest: ${esc(v)}% tonight.` : r.id === 'storm' ? `Suggest: reserve to ${esc(v)}%.` : `Suggest: ${esc(EXPORT[v] ?? v)} (${code(v)}).`;
  const apply = r.id === 'reserve' ? `Apply ${esc(v)}%` : r.id === 'storm' ? `Apply ${esc(v)}%` : `Apply ${esc(EXPORT[v] ?? v)}`;
  const skipL = r.id === 'export' ? `Keep ${esc(EXPORT[s.current] ?? s.current ?? 'as is')}` : RULE[r.id].skip;
  return `<div class="c-modeline c-acc-solar"><p><b>${head}</b> ${r.id === 'export' ? reason.replace(/\b(battery_ok|pv_only)\b/g, m => code(m)) : reason}</p>
    ${cmds ? '' : `<p class="c-fine" style="flex-basis:100%;margin:0">${esc(teslaSteps(r.id, v))}</p>`}
    ${cmds ? `<button class="c-btn sm pri c-acc-solar" data-apply="${r.id}">${apply}</button>` : ''}<button class="c-btn sm line" data-skip="${r.id}">${skipL}</button></div>`;
}

/** The rule's row title and line on Systems › Powerwall (mockup al frame 11): "Reserve 20%" · "never changed by Solstice". */
function ruleRow(r, P, site) {
  const last = P.log.find(l => l.rule === r.id), s = r.suggestion ?? {}, sg = r.mode === 'suggest' && s.action === 'set' && !skipped(r.id, s.value);
  const title = r.id === 'reserve' ? `Reserve ${esc(site.reservePct ?? s.current ?? '—')}%` : RULE[r.id].title;
  const line = sg ? `${r.id === 'export' ? `Suggests ${esc(EXPORT[s.value] ?? s.value)}` : `Suggests ${esc(s.value)}%`} · waiting for you`
    : r.id === 'export' ? esc((EXPORT[s.current] ?? s.current ?? '—').toString().toLowerCase())
    : r.id === 'storm' ? (P.trip && r.mode === 'suggest' ? `acts on its own ${P.trip.backAt ? `until ${esc(when(P.trip.backAt))} ` : ''}(trip)` : s.action === 'set' ? esc(s.reason ?? 'storm ahead') : 'no storm expected')
    : last ? esc(logText(last, false)) : 'never changed by Solstice';
  const acc = { reserve: 'c-acc-batt', storm: 'c-acc-solar', export: 'c-acc-home' }[r.id], ic = { reserve: 'batt', storm: 'storm', export: 'bolt' }[r.id];
  return `<div class="c-sys compact ${acc}" role="button" tabindex="0" data-rule="${r.id}" aria-haspopup="dialog"><span class="c-ic">${icon(ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${title}</b>${modePill(r.mode)}</div><div class="c-sys-l">${line}</div></div><span class="c-chev">${icon('chev')}</span></div>`;
}

export function drawPowerwallRules(S) {
  const P = S.pwRules, card = $('sysRules'); if (!P || !card) return;
  const cmds = !!P.scope?.energyCmds, site = S.now?.site ?? {};
  const modes = Object.fromEntries(P.rules.map(r => [r.id, r.mode])), word = rulesMode(modes);
  $('pwrFig').textContent = /in Auto/.test(word) ? word : `${P.rules.filter(r => RULE[r.id]).length} · ${word}`;
  $('pwrRows').innerHTML = P.rules.filter(r => RULE[r.id]).map(r => ruleRow(r, P, site)).join('');
  $('pwrScope').innerHTML = cmds ? '' : `<p class="c-fine" style="padding:0 16px 14px;margin-top:4px">Solstice can read these settings but can't change them yet: it needs Tesla's energy commands permission (<code style="font:10.5px var(--c-mono)">energy_cmds</code>). Reconnect once in your own browser and approve it; until then each rule shows its steps in the Tesla app. <a class="c-btn sm line" href="/auth/login" style="margin-top:8px">Re-connect Tesla</a></p>`;
  $('pwrRows').onclick = e => { const row = /** @type {Element} */ (e.target).closest('[data-rule]'); if (row) openRuleSheet(S, row.dataset.rule); };
}

/** One rule's well as a sheet: its mode (staged until the footer sends it), the suggestion with Apply / Skip, the last change, the limits. */
export function openRuleSheet(S, id) {
  let staged = null, sending = false;
  const draw = () => {
    const P = S.pwRules, r = P?.rules.find(x => x.id === id); if (!r) return;
    const cmds = !!P.scope?.energyCmds, last = P.log.find(l => l.rule === id), m = staged ?? r.mode;
    const scope = cmds ? '' : '<p class="c-fine">Solstice can read this setting but can’t change it yet: it needs Tesla’s energy commands permission. Until then the suggestion shows its steps in the Tesla app.</p>';
    sheet(`${sheetHead(esc(RULE[id].title), modePill(r.mode), esc(id === 'storm' && P.trip && r.mode === 'suggest' ? `Suggest · acts on its own ${P.trip.backAt ? `until ${when(P.trip.backAt)} ` : ''}(trip)` : RULE[id].sub))}
      ${seg([['off', 'Off'], ['suggest', 'Suggest'], ['auto', 'Auto', !cmds]], m, { acc: 'c-acc-batt', attr: 'data-m', label: `${RULE[id].title} mode` })}
      ${recHtml(r, cmds)}
      <div class="c-lab">Last change</div><div class="c-well" style="margin-top:0"><p class="c-sum" style="margin:0"><span class="c-num c-cap">${last ? day(last.at) : '—'}</span> · ${last ? logText(last, false) : 'Never changed by Solstice.'}</p></div>
      <div class="c-lab">Limits</div><div class="c-chips" style="margin-top:0">${limits(id, P.floorPct).map(x => `<span>${esc(x)}</span>`).join('')}</div>
      ${scope}
      ${staged ? sheetFoot('Cancel', `Set ${RULE[id].title.toLowerCase()} to ${{ off: 'Off', suggest: 'Suggest', auto: 'Auto' }[staged]}`, 'c-acc-batt') : sheetFoot('Log', 'Done', 'c-acc-batt')}`, { keepScroll: true });
    const body = $('sheetBody'), pri = body.querySelector('[data-f="pri"]'), sec = body.querySelector('[data-f="sec"]');
    body.querySelector('[data-m]')?.parentElement.addEventListener('click', e => { const b = /** @type {Element} */ (e.target).closest('[data-m]'); if (!b) return;
      if (b.getAttribute('aria-disabled') === 'true') return alert('Auto needs Tesla’s energy commands permission (energy_cmds). Re-connect Tesla first.');
      staged = b.dataset.m === r.mode ? null : b.dataset.m; draw(); });
    body.querySelector('[data-apply]')?.addEventListener('click', async e => { await applyRule(S, id, e.currentTarget); S.redrawNow?.(); draw(); });
    body.querySelector('[data-skip]')?.addEventListener('click', () => { skip(id, r.suggestion?.value); S.redrawNow?.(); drawPowerwallRules(S); draw(); });
    if (!staged) { pri.onclick = closeSheet; sec.onclick = () => S.openLog?.({ src: 'pw' }); return; }
    sec.onclick = () => { staged = null; draw(); };
    pri.onclick = async () => { if (sending) return; sending = true; pri.textContent = 'Saving…'; await setRuleMode(S, id, staged); sending = false; staged = null; draw(); S.redrawNow?.(); };
  };
  draw();
}

/** A rule's mode (the card's and the Now sheet's): Auto asks first and needs energy_cmds. Resolves true when it was sent. */
export async function setRuleMode(S, id, m) {
  const P = S.pwRules, r = P?.rules.find(x => x.id === id), cmds = !!P?.scope?.energyCmds; if (!r || m === r.mode) return false;
  if (m === 'auto' && !cmds) { alert('Auto needs Tesla’s energy commands permission (energy_cmds). Re-connect Tesla first.'); return false; }
  if (m === 'auto' && !confirm(`Let Solstice make the ${RULE[id].title.toLowerCase()} change itself?\n\nLimits: ${limits(id, P.floorPct).join(' · ')}.\n\nEvery change is logged, and the operating mode and grid charging are never changed.`)) return false;
  await api.pwRuleMode(id, m).catch(err => alert(err.message)); await loadPowerwallRules(S); return true;
}
/** Apply a waiting suggestion (after the same confirm as before). */
export async function applyRule(S, id, btn) {
  const P = S.pwRules, r = P?.rules.find(x => x.id === id); if (!r || !P.scope?.energyCmds) return;
  const s = r.suggestion, q = s.command === 'grid_import_export' ? `Set the grid export rule to ${EXPORT[s.value] ?? s.value} (${s.value})?` : `Set the backup reserve to ${s.value}%?`;
  if (!confirm(`${q}\n\n${s.reason}\n\nOnly this setting changes, at most once an hour. The old value is kept in the Powerwall log.`)) return;
  if (btn) btn.textContent = 'Applying…';
  try { await api.pwApply(id); toast('✓', 'rgba(78,240,166,.2)', `${RULE[id].title}: ${val(s.command, s.value)}`, 'Sent to your Powerwalls.'); }
  catch { toast('!', 'rgba(255,90,78,.25)', 'Not applied', 'The Powerwall log says why.'); }
  return loadPowerwallRules(S);
}
/** The first suggestion waiting for the owner (a rule in Suggest with a change to make, not skipped today), or null. */
export function waitingSuggestion(P) {
  return P?.rules.find(r => RULE[r.id] && r.mode === 'suggest' && r.suggestion?.action === 'set' && !skipped(r.id, r.suggestion.value)) ?? null;
}

export async function loadPowerwallRules(S) {
  if (S.guest || !$('sysRules')) return;
  S.pwRules = await api.pwRules();
  drawPowerwallRules(S); S.redrawNow?.();
}

/** The rules card is static markup on Systems › Powerwall now (mockup al frame 11); kept for main.js's call. */
export function mountPowerwallRules() {}
