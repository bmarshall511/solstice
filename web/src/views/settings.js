import { $, niceDate, ago } from '../lib/util.js';
import { api } from '../lib/api.js';
import { veil, esc } from '../lib/frost.js';
import { backupError, httpCode } from './insights.js';
import { detectPush, subscribePush, unsubscribePush } from '../lib/push.js';

const PREFS = [['outage', 'var(--out)', '⚡', 'Grid outage started or ended'], ['lowBatt', 'var(--solar)', '↓', 'Battery low during an outage', 'Below 30%'],
  ['solar', 'var(--warn)', '☀', 'Solar underperforming', '≥ 8% below baseline'], ['nws', 'var(--home)', '⛈', 'Severe weather (NWS)'], ['bill', 'var(--grid)', '≈', 'Bill doesn’t match Tesla', 'Gap over 5%'],
  ['baseline', 'var(--grid)', '◐', 'Overnight usage drift'], ['stale', 'var(--mute)', '⏻', 'Tesla stopped reporting', 'After 3 minutes']];
/* t-enhancements frame 3: the seven kinds the server's alerts feed and push add (server/src/notify.ts TOGGLES), same switches */
const NEW_PREFS = [['approval', 'var(--batt)', '✓', 'Waiting for your approval', 'Pool plan, AC pre-cool, Powerwall rule'], ['billDue', 'var(--solar)', '$', 'PEC bill due', '3 days before'],
  ['anomaly', 'var(--warn)', '!', 'Unusual usage', 'A day well above what its weather explains'], ['storm', 'var(--home)', '⛨', 'Storm preparation', 'Watch or Warning ahead, with the Powerwall step'],
  ['ercot', 'var(--grid)', '⌁', 'Grid stress (ERCOT)', 'Conservation call or EEA'], ['panel', 'var(--out)', '▦', 'Panel fault', 'From the PVS relay · a panel well below its neighbours'],
  ['digest', 'var(--batt)', '◷', 'Weekly digest', 'Monday 7 AM']];
let prefs = {};
/** The alert switches from the settings boot() already read (this module used to fetch them itself at load, before sign-in). */
export function applyAlertPrefs(alerts) { prefs = alerts ?? {}; document.querySelectorAll('[data-pref]').forEach(el => el.classList.toggle('on', prefs[el.dataset.pref] !== false)); }
const load = () => prefs;

/** Settings › Connections: Tesla (with the backup-history retry line), Open-Meteo, ScreenLogic and Nest. */
export function drawConnections(S) {
  const site = S.now?.site ?? {}, h = S.now?.health ?? {}, bk = backupError(S), code = httpCode(bk);
  const on = t => `<span style="color:var(--batt)">${t}</span>`, off = t => `<span style="color:var(--warn)">${t}</span>`;
  $('setTesla').textContent = `Solstice Home Energy · ${site.name ?? 'energy site'}`;
  $('setTeslaBk').textContent = bk ? `Tesla backup history · retrying${code ? ` (HTTP ${code})` : ''}` : ''; $('setTeslaBk').style.display = bk ? '' : 'none';
  $('setTeslaV').innerHTML = h.stale ? '<span style="color:var(--warn)">No data</span>' : `<span style="color:var(--batt)">Live</span>`;
  $('setWx').innerHTML = S.wx ? '<span style="color:var(--batt)">Live</span>' : '—';
  $('setZip').textContent = S.location?.zip ?? '—';
  const p = S.pool, a = S.ac, name = a?.state?.name ?? 'Thermostat';
  $('setPool').textContent = `pool & spa${p?.snapshot?.at ? ` · read ${ago(p.snapshot.at)}` : ''}`;
  $('setPoolV').innerHTML = !p ? '—' : p.error ? off('Read failed') : p.linked ? on('Linked') : off('Not linked');
  $('setNest').textContent = a?.state ? `${/thermostat/i.test(name) ? name : `${name} thermostat`} · sampled ${ago(a.state.at)}` : 'thermostat';
  const nest = !a ? '—' : a.error ? off('Read failed') : a.linked ? on('Linked') : off(a.configured ? 'Not linked' : 'Not set up');
  // Owner: Relink / Link through Google (the AC panel's Link Nest card only shows while unlinked). Guests keep the status text.
  const relink = a?.configured ? `<a class="link" data-owner href="/auth/google">${a.linked ? 'Relink' : 'Link'}</a>` : '';
  $('setNestV').innerHTML = !relink ? nest : a.error ? `${nest} ${relink}` : `<span data-guest>${nest}</span>${relink}`;
}

export function drawSettings(S) {
  const site = S.now?.site ?? {}, t = S.tariff;
  drawConnections(S);
  const row = (c, i, title, sub, v) => `<div class="row" style="--c:${c}"><div class="ri">${i}</div><div class="rt">${title}${sub ? `<small>${sub}</small>` : ''}</div><div class="rv">${v}</div></div>`;
  $('sysGroup').innerHTML =
    row('var(--batt)', '▮', 'Powerwalls', `${site.batteries?.map(b => esc(b.name)).join(' + ') ?? ''}`, `${esc(site.capacityKwh ?? '—')} kWh · ${esc(site.maxPowerKw ?? '—')} kW`) +
    row('var(--solar)', '☀', 'Solar', site.solar ? `${esc(site.solar.panels)} × ${esc(site.solar.module)} · Enphase IQ7XS microinverters` : '30 panels', site.solar ? `${esc(site.solar.dcKw)} kW DC · ${esc(site.solar.acKw)} kW AC` : '—') +
    row('var(--warn)', '⛨', 'Backup reserve', 'Set in the Tesla app', `${esc(site.reservePct ?? '—')}%`) +
    row('var(--grid)', '⚙', 'Operating mode', site.mode === 'autonomous' ? 'Time-Based Control' : '', esc(site.mode ?? '—')) +
    row('var(--home)', '$', 'Utility', S.guest ? `${veil('$•.••••/kWh')} all-in · ${veil('$•.••••/kWh')} export credit` : t ? `$${t.importRateAllIn}/kWh all-in · ${t.exportCredit != null ? `$${t.exportCredit}` : '—'}/kWh export credit` : 'Add a bill to learn your rates', 'PEC') +
    row('var(--mute)', '⌂', 'Installed', S.guest ? '' : `Gateway firmware ${esc(site.firmware?.split(' ')[0] ?? '—')}`, site.installed ? niceDate(site.installed.slice(0, 10), { month: 'short', year: 'numeric' }) : '—');
  const prefs = load();
  $('alertPrefs').innerHTML = PREFS.map(([k, c, i, title, sub]) => `<div class="row" style="--c:${c}"><div class="ri">${i}</div><div class="rt">${title}${sub ? `<small>${sub}</small>` : ''}</div><div class="sw ${prefs[k] === false ? '' : 'on'}" data-pref="${k}"></div></div>`).join('');
  $('alertPrefsNew').innerHTML = NEW_PREFS.map(([k, c, i, title, sub]) => `<div class="row newk" style="--c:${c}"><div class="ri">${i}</div><div class="rt">${title}<span class="nbadge">new</span><small>${sub}</small></div><div class="sw ${prefs[k] === false ? '' : 'on'}" data-pref="${k}"></div></div>`).join('');
  if (!S.guest) drawPush();
  document.querySelectorAll('[data-pref]').forEach(el => el.onclick = () => { prefs[el.dataset.pref] = el.classList.toggle('on'); api.saveSettings({ alerts: prefs }).catch(() => {}); });
}

export async function openRawData() {
  $('sheetBody').innerHTML = '<h4>All data</h4><p class="sub">Loading…</p>';
  $('phone').classList.add('open');
  const [now, site] = await Promise.all([api.now(), api.site()]);
  $('sheetBody').innerHTML = `<h4>All data</h4><p class="sub">Exactly what Tesla returns for your site, and the latest reading Solstice stored.</p>
    <div class="sect" style="margin-top:14px">Latest reading · ${now.reading ? ago(now.reading.ts) : '—'}</div><div class="raw">${esc(JSON.stringify(now.reading, null, 2))}</div>
    <div class="sect">site_info</div><div class="raw">${esc(JSON.stringify(site.raw, null, 2))}</div>`;
}

/** Settings › Alerts › Push to this device: the switch and its line (mockup t-enhancements frame 3). */
let pushBusy = false;
export async function drawPush() {
  const sw = $('pushSw'), st = $('pushSt'); if (!sw || pushBusy) return;
  const { state, line: [text, cls, on, disabled] } = await detectPush().catch(() => ({ state: 'unsupported', line: ['This browser can’t receive push', 'st-warn', false, true] }));
  st.textContent = text; st.className = cls; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on));
  sw.style.opacity = disabled ? .35 : ''; sw.setAttribute('aria-disabled', String(disabled));
  sw.onclick = async () => {
    if (disabled || pushBusy) return;
    pushBusy = true; st.textContent = on ? 'Turning off…' : 'Asking iOS…';
    try { if (on) await unsubscribePush(); else await subscribePush(); }
    catch (e) { pushBusy = false; st.textContent = e.message; st.className = 'st-warn'; return; }
    pushBusy = false; drawPush();
  };
}
