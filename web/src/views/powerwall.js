// Insights › Home: the "Powerwall rules" card, directly below Outage readiness (approved mockup mockups/t-enhancements.html frame 5).
// Data: GET /api/powerwall/rules (server/src/powerwall.ts). Suggest never writes; Apply (after a confirm) and Auto go through
// tesla/commands.ts, which checks the energy_cmds scope, the clamps in appliances/guards.ts and the hourly slot. Owner-only.
import { $, niceDate, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { rulesMode } from '../lib/digest.js';
import { clock, dayOf, when } from '../lib/presence.js';

const MARKUP = `<div class="card pwr" id="pwr" data-owner>
  <div class="h"><b>Powerwall rules</b><span class="badge g" id="pwrBadge">—</span></div>
  <div class="cur" id="pwrCur"></div>
  <div id="pwrScope"></div>
  <div id="pwrRules"><p class="fine" style="margin-top:12px">Loading…</p></div>
  <div class="sect" style="margin:16px 2px 4px;font-size:11px">Powerwall log</div>
  <div class="tline" id="pwrLog"></div>
</div>`;

const RULE = {
  reserve: { title: 'Reserve for tonight', sub: 'how much to keep for an outage overnight', skip: 'Not tonight' },
  storm: { title: 'Storm Watch prep', sub: 'fill the Powerwalls before bad weather', skip: 'Skip' },
  export: { title: 'Export rule', sub: 'what the Powerwalls may send to PEC' },
};
const EXPORT = { battery_ok: 'Everything', pv_only: 'Solar only', never: 'Never' };
const MODE = { autonomous: 'Time-Based Control', self_consumption: 'Self-Powered', backup: 'Backup-only' };
const code = v => `<code style="font:11px 'JetBrains Mono'">${esc(v)}</code>`;
const val = (command, v) => v == null ? '—' : command === 'grid_import_export' ? (EXPORT[v] ?? String(v)) : `${v}%`;
const limits = (id, floor) => ({
  reserve: ['10–100%', 'one change an hour', 'never below 20% in a storm', `not below your ${floor}% floor`],
  storm: ['100% for a Warning or active Storm Watch', '50% for a Watch', 'back to the old reserve after', 'one change an hour'],
  export: ['battery_ok ↔ pv_only only', 'never "never"', 'mode never changed', 'one change an hour'],
})[id];
const teslaSteps = (id, v) => id === 'export' ? `In the Tesla app: Powerwall › Settings › Energy Exports › ${v === 'pv_only' ? 'Solar' : 'Everything'}.`
  : `In the Tesla app: Powerwall › Settings › Backup Reserve › ${v}%.`;
const autoWhen = { reserve: 'at the 5 PM check', storm: 'on the next 5-minute check', export: 'with tonight’s sync' };

/* skipping a suggestion is this device's own note: it hides that value for today, nothing is sent */
const skipKey = (id, v) => `solstice:pwskip:${id}:${v}:${dayOf(Date.now())}`;
const skipped = (id, v) => { try { return localStorage.getItem(skipKey(id, v)) === '1'; } catch { return false; } };
const skip = (id, v) => { try { localStorage.setItem(skipKey(id, v), '1'); } catch { /* storage off */ } };

/** One log row as the "last" line and the log timeline read it. */
function logText(l, withRule) {
  const v = val(l.command, l.value), at = clock(l.at), who = l.result === 'sent' ? (l.source === 'owner' ? 'you applied' : 'auto') : '';
  const t = { sent: `set ${v} at ${at}`, suggested: `suggested ${v} · not applied`, refused: `${v} refused: ${l.reason ?? ''}`, scope_missing: `${v} not sent: energy_cmds missing`,
    unchanged: `no change: ${l.reason ?? ''}`, error: `${v} failed: ${l.reason ?? ''}`, no_account: 'not sent: no Tesla account' }[l.result] ?? `${l.result} ${v}`;
  return withRule ? `${esc(RULE[l.rule]?.title ?? l.rule ?? l.command)} · ${esc(t)}${who ? ` <em>${who}</em>` : ''}` : esc(t.charAt(0).toUpperCase() + t.slice(1) + (who ? ` (${who})` : '') + '.');
}
const day = at => niceDate(dayOf(at));

function recHtml(r, cmds, floor) {
  const s = r.suggestion ?? {}, v = s.value, reason = esc(s.reason ?? '');
  if (r.mode === 'off') return `<div class="rec none"><b>Off.</b> No suggestions and no pushes for this rule.</div>`;
  if (r.mode === 'auto') return s.action === 'set' ? `<div class="rec auto"><b>Auto: sets ${esc(val(s.command, v))} ${autoWhen[r.id]}.</b> ${reason} Every change is logged below.</div>`
    : `<div class="rec auto"><b>Auto: no change.</b> ${reason}</div>`;
  if (s.action !== 'set') return `<div class="rec none"><b>${s.action === 'wait' ? 'Waiting.' : 'No change.'}</b> ${reason}</div>`;
  if (skipped(r.id, v)) return `<div class="rec none"><b>Skipped for today.</b> ${reason}</div>`;
  const head = r.id === 'reserve' ? `Suggest: ${esc(v)}% tonight.` : r.id === 'storm' ? `Suggest: reserve to ${esc(v)}%.` : `Suggest: ${esc(EXPORT[v] ?? v)} (${code(v)}).`;
  const apply = r.id === 'reserve' ? `Apply ${esc(v)}%` : r.id === 'storm' ? `Apply: ${esc(v)}%` : `Apply ${esc(EXPORT[v] ?? v)}`;
  const skipL = r.id === 'export' ? `Keep ${esc(EXPORT[s.current] ?? s.current ?? 'as is')}` : RULE[r.id].skip;
  return `<div class="rec"><b>${head}</b> ${r.id === 'export' ? reason.replace(/\b(battery_ok|pv_only)\b/g, m => code(m)) : reason}
    ${cmds ? '' : `<p class="fine" style="margin-top:8px">${esc(teslaSteps(r.id, v))}</p>`}
    <div class="row2"><button class="apply" data-apply="${r.id}">${apply}</button><button class="skip" data-skip="${r.id}">${skipL}</button></div></div>`;
}

export function drawPowerwallRules(S) {
  const P = S.pwRules, card = $('pwr'); if (!P || !card) return;
  const cmds = !!P.scope?.energyCmds, site = S.now?.site ?? {}, exp = P.rules.find(r => r.id === 'export')?.suggestion?.current;
  const modes = Object.fromEntries(P.rules.map(r => [r.id, r.mode])), word = rulesMode(modes);
  $('pwrBadge').textContent = /in Auto/.test(word) ? word : `${P.rules.length} rules · ${word}`; $('pwrBadge').className = `badge${word === 'Off' ? '' : ' g'}`;
  $('pwrCur').innerHTML = `<span>reserve <b>${esc(site.reservePct ?? P.rules.find(r => r.id === 'reserve')?.suggestion?.current ?? '—')}%</b></span><span>export <b>${esc(EXPORT[exp] ?? exp ?? '—')}</b></span>` +
    `<span>Storm Watch <b>${site.stormWatch == null ? '—' : site.stormWatch ? 'on' : 'off'}</b></span><span>mode <b>${esc(MODE[site.mode] ?? site.mode ?? '—')}</b></span>`;
  $('pwrScope').innerHTML = cmds
    ? `<div class="scope"><b>Solstice can change these settings.</b> Tesla granted the energy commands permission (<code style="font:10.5px 'JetBrains Mono'">energy_cmds</code>). Suggest shows a change and waits for you. Auto makes it, inside the limits shown under each rule.</div>`
    : `<div class="scope miss"><b>Solstice can read these settings but can't change them yet.</b> It needs Tesla's energy commands permission (<code style="font:10.5px 'JetBrains Mono'">energy_cmds</code>). Reconnect once in your own browser and approve the new permission. Until then each rule shows its steps in the Tesla app.<br><a class="link" href="/auth/login">Re-connect Tesla ›</a></div>`;
  card.classList.toggle('nocmd', !cmds);
  $('pwrRules').innerHTML = P.rules.filter(r => RULE[r.id]).map(r => {
    const last = P.log.find(l => l.rule === r.id);
    return `<div class="rule" data-rule="${r.id}">
      <div class="rh"><b>${RULE[r.id].title}<small>${r.id === 'storm' && P.trip && r.mode === 'suggest' ? `Suggest · acts on its own ${P.trip.backAt ? `until ${esc(when(P.trip.backAt))} ` : ''}(trip)` : RULE[r.id].sub}</small></b><span class="seg2">${['off', 'suggest', 'auto'].map(m => `<button data-m="${m}" class="${r.mode === m ? 'on' : ''}"${m === 'auto' && !cmds ? ' style="opacity:.35"' : ''}>${{ off: 'Off', suggest: 'Suggest', auto: 'Auto' }[m]}</button>`).join('')}</span></div>
      ${recHtml(r, cmds, P.floorPct)}
      <div class="last"><span>${last ? day(last.at) : '—'}</span><p>${last ? logText(last, false) : 'Never changed by Solstice.'}</p></div>
      <div class="rules">${limits(r.id, P.floorPct).map(x => `<span>${esc(x)}</span>`).join('')}</div>
    </div>`; }).join('');
  $('pwrLog').innerHTML = P.log.slice(0, 6).map(l => `<div><i class="${l.result === 'sent' ? '' : 'w'}"></i><span>${day(l.at)}</span><p>${logText(l, true)}</p></div>`).join('')
    || '<div><i class="w"></i><span>—</span><p>No Powerwall changes yet. Every suggestion and change will be listed here.</p></div>';

  $('pwrRules').onclick = async e => {
    const el = e.target.closest('button'); if (!el) return;
    const ruleEl = el.closest('.rule'), id = ruleEl?.dataset.rule, r = P.rules.find(x => x.id === id); if (!r) return;
    if (el.dataset.m) {
      const m = el.dataset.m; if (m === r.mode) return;
      if (m === 'auto' && !cmds) return alert('Auto needs Tesla’s energy commands permission (energy_cmds). Re-connect Tesla first.');
      if (m === 'auto' && !confirm(`Let Solstice make the ${RULE[id].title.toLowerCase()} change itself?\n\nLimits: ${limits(id, P.floorPct).join(' · ')}.\n\nEvery change is logged, and the operating mode and grid charging are never changed.`)) return;
      await api.pwRuleMode(id, m).catch(err => alert(err.message)); return loadPowerwallRules(S);
    }
    if (el.dataset.skip) { skip(id, r.suggestion?.value); return drawPowerwallRules(S); }
    if (el.dataset.apply) {
      if (!cmds) return;
      const s = r.suggestion, q = s.command === 'grid_import_export' ? `Set the grid export rule to ${EXPORT[s.value] ?? s.value} (${s.value})?` : `Set the backup reserve to ${s.value}%?`;
      if (!confirm(`${q}\n\n${s.reason}\n\nOnly this setting changes, at most once an hour. The old value is kept in the Powerwall log.`)) return;
      el.textContent = 'Applying…';
      try { await api.pwApply(id); toast('✓', 'rgba(78,240,166,.2)', `${RULE[id].title}: ${val(s.command, s.value)}`, 'Sent to your Powerwalls.'); }
      catch { toast('!', 'rgba(255,90,78,.25)', 'Not applied', 'The Powerwall log says why.'); }
      return loadPowerwallRules(S);
    }
  };
}

export async function loadPowerwallRules(S) {
  if (S.guest || !$('pwr')) return;
  S.pwRules = await api.pwRules();
  drawPowerwallRules(S);
}

/** Put the card directly below Outage readiness (views/outage.js mounts that first card on Insights › Home). */
export function mountPowerwallRules() {
  const home = $('ip-home'), outage = home.querySelector('.card.outage');
  if (outage) outage.insertAdjacentHTML('afterend', MARKUP); else home.insertAdjacentHTML('afterbegin', MARKUP);
}
