import { $, niceDate, ago, localDate } from '../lib/util.js';
import { api } from '../lib/api.js';
import { veil, esc } from '../lib/frost.js';
import { badge } from '../lib/conf.js';
import { icon } from '../lib/icons.js';
import { ALERTS, ALERT_GROUPS, isNew, groupIsNew, groupState, toggleGroup, isOn } from '../lib/alertgroups.js';
import { backupError, httpCode, cronRows } from './insights.js';
import { detectPush, subscribePush, unsubscribePush } from '../lib/push.js';
import { sheet, sheetHead, sheetFoot, closeSheet } from './csheet.js';

/*
 * Settings (approved mockup mockups/al-ia.html v2, frame 15): every row the compact system row. Connections carries what Data health
 * showed (each service's age under its name, a Live / Linked badge, Relink where it exists, PEC bills, All data); Your system is a
 * key-value list; Alerts is Push to this device, then five groups with a switch, "N of M on" and the group's switches in place.
 */
let prefs = {};
const openGroups = new Set();
/** The alert switches from the settings boot() already read (this module used to fetch them itself at load, before sign-in). */
export function applyAlertPrefs(alerts) { prefs = alerts ?? {}; drawAlertGroups(); }

const row = ({ acc, ic, title, line = '', end = '', id = '', attrs = '', button = false }) => `<div class="c-sys compact ${acc}${button ? '' : ' static bar'}"${button ? ' role="button" tabindex="0"' : ''}${id ? ` id="${id}"` : ''}${attrs ? ` ${attrs}` : ''}>
  <span class="c-ic">${icon(ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${title}</b></div>${line ? `<div class="c-sys-l">${line}</div>` : ''}</div>${end || '<span></span>'}</div>`;
const chev = `<span class="c-chev">${icon('chev')}</span>`;
const ageShort = ms => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; };

/** Settings › Connections, with Data health folded in (mockup al frame 15; the Conditions sheet keeps the full list too). */
let connKey = '';
export function drawConnections(S) {
  const site = S.now?.site ?? {}, h = S.now?.health ?? {}, bk = backupError(S), code = httpCode(bk), st = S.status;
  const p = S.pool, a = S.ac, name = a?.state?.name ?? 'Thermostat', pv = S.pvs, e = S.ercot, crons = cronRows(h.crons);
  const errs = Object.entries(h.errors ?? {}).filter(([k, x]) => k !== 'lastBackups' && x && Date.now() - x.at < 30 * 60_000);
  const tesla = `${h.lastLive ? `live ${ageShort(h.lastLive)}` : 'live —'} · history ${h.lastHistory ? ageShort(h.lastHistory) : '—'} · backups ${bk ? `retrying${code ? ` (HTTP ${code})` : ''}` : 'ok'}${st ? ` · ${st.backfill.daysDone} days stored` : ''}`;
  const relink = a?.configured && !S.guest ? `<a class="c-btn sm line" href="/auth/google" data-owner>${a.linked ? 'Relink' : 'Link'}</a>` : '';
  const nestLine = !a ? 'thermostat' : a.error ? 'read failed' : a.linked ? `${esc(/thermostat/i.test(name) ? name : `${name} thermostat`)}${a.state ? ` · ${ageShort(a.state.at)} ago` : ''}` : a.configured ? 'not linked' : 'not set up';
  const silent = pv?.relay?.silent, heard = pv?.relay?.heardAt ?? pv?.relay?.lastPoll;
  const jobsBad = crons.filter(c => !c.ok).length;
  const dp = st?.backfill?.deep;   // I-16: the back-fill to the install date (owner only; a guest's /api/status has no deep)
  const html = [
    row({ acc: 'c-acc-out', ic: 'tesla', title: 'Tesla Fleet API', line: tesla, end: h.stale ? badge('estimated', 'No data') : badge('live', 'Live') }),
    // mockup am frame 9: "History back to Dec 2020 · 612 of 1,668 days", with a progress bar until it is complete
    dp?.daysTotal ? row({ acc: 'c-acc-out', ic: 'data', title: `History back to ${niceDate(dp.from, { month: 'short', year: 'numeric' })}`,
      line: dp.done ? 'complete' : `${dp.daysDone.toLocaleString('en-US')} of ${dp.daysTotal.toLocaleString('en-US')} days<div class="c-bar c-acc-batt" style="margin-top:6px"><i style="width:${Math.min(100, Math.round(dp.daysDone / dp.daysTotal * 100))}%"></i></div>`,
      end: dp.done ? badge('learned', 'Complete') : badge('', 'Filling') }) : '',
    row({ acc: 'c-acc-home', ic: 'cloud', title: 'Open-Meteo', line: `${S.location?.zip ? `${esc(S.location.zip)} · ` : ''}tilt 27° · facing 244°`, end: S.wx ? badge('live', 'Live') : badge('', '—') }),
    row({ acc: 'c-acc-pool', ic: 'pool', title: 'Pentair ScreenLogic', line: `pool & spa${p?.snapshot?.at ? ` · ${ageShort(p.snapshot.at)} ago` : ''}`, end: !p ? badge('', '—') : p.error ? badge('estimated', 'Read failed') : p.linked ? badge('learned', 'Linked') : badge('', 'Not linked') }),
    row({ acc: 'c-acc-ac', ic: 'ac', title: 'Google Nest', line: nestLine, end: relink || (!a ? badge('', '—') : a.error ? badge('estimated', 'Read failed') : a.linked ? badge('learned', 'Linked') : badge('', a.configured ? 'Not linked' : 'Not set up')) }),
    pv?.relay ? row({ acc: 'c-acc-vac', ic: 'relay', title: 'PVS relay', line: heard ? `${silent ? 'silent · last heard' : ''} ${ageShort(Date.parse(heard))} ago`.trim() : 'per-panel readings', end: silent ? badge('estimated', 'Silent') : badge('live', 'Live') }) : '',
    row({ acc: 'c-acc-grid', ic: 'tower', title: 'ERCOT grid status', line: e ? esc(e.condition === 'normal' ? 'normal' : e.title || e.condition) : 'checking…', end: e ? badge(e.condition === 'normal' ? 'live' : 'estimated', e.condition === 'normal' ? 'Live' : 'Alert') : badge('', '—') }),
    crons.length ? row({ acc: 'c-acc-mute', ic: 'clock', title: 'Solstice’s own jobs', line: crons.map(c => `${esc(c.label)} ${c.v}`).join(' · '), end: jobsBad ? badge('estimated', `${jobsBad} to check`) : badge('learned', 'all good') }) : '',
    ...errs.map(([k, x]) => row({ acc: 'c-acc-out', ic: 'bolt', title: `${esc(k)} error`, line: esc(String(x.message ?? '').slice(0, 80)), end: badge('estimated', ageShort(x.at)) })),
    row({ acc: 'c-acc-solar', ic: 'bill', title: 'PEC bills', line: esc(S.billsLine ?? 'Add this month’s bill'), end: chev, button: true, attrs: S.guest ? '' : 'data-addbill="1"' }),
    row({ acc: 'c-acc-grid', ic: 'data', title: 'All data', line: 'raw live status and site info', end: chev, button: true, id: 'openData' }),
  ].join('');
  if (html !== connKey) { connKey = html; $('connCard').innerHTML = html; }
}

export function drawSettings(S) {
  const site = S.now?.site ?? {}, t = S.tariff, sp = site.solar;
  drawConnections(S);
  const kv = [['Powerwalls', `${esc(site.capacityKwh ?? '—')} kWh · ${esc(site.maxPowerKw ?? '—')} kW`], ['Batteries', site.batteries?.length ? `${site.batteries.length} × ${esc(site.batteries[0].name)}` : '—'],
    ['Solar', sp ? `${esc(sp.dcKw)} kW DC · ${esc(sp.acKw)} AC` : '—'], ['Panels', sp ? `${esc(sp.panels)} × ${esc(sp.panelWdc)} W` : '—'], ...(sp?.microinverter ? [['Microinverters', 'Enphase IQ7XS']] : []),
    ['Mode', site.mode === 'autonomous' ? 'Time-Based Control' : esc(site.mode ?? '—')], ['Utility', 'PEC'],
    ['Rate, all-in', S.guest ? veil('$•.••••/kWh') : t ? `$${t.importRateAllIn}/kWh` : 'add a bill'], ['Export credit', S.guest ? veil('$•.••••/kWh') : t?.exportCredit != null ? `$${t.exportCredit}/kWh` : '—'],
    ['Installed', site.installed ? niceDate(site.installed.slice(0, 10), { month: 'short', year: 'numeric' }) : '—'], ...(S.guest ? [] : [['Gateway firmware', esc(site.firmware?.split(' ')[0] ?? '—')]])];
  $('sysGroup').innerHTML = kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  $('reserveVal').textContent = `${site.reservePct ?? '—'}%`;
  $('reserveRow').onclick = () => S.nav?.sys('powerwall', 'sysRules');
  drawAlertGroups();
  if (!S.guest) drawPush();
}

/* ---------- Alerts: five groups (lib/alertgroups.js), each a row with its switch and "N of M on"; the chevron opens its switches ---------- */
const sw = (on, attrs, label) => `<button class="c-swb" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${attrs}><span class="c-sw${on ? ' on' : ''}"></span></button>`;
function drawAlertGroups() {
  const box = $('alertPrefs'); if (!box) return;
  const today = localDate();
  box.innerHTML = ALERT_GROUPS.map(g => { const st = groupState(g, prefs), open = openGroups.has(g.id);
    return `<div class="c-sys compact ${g.acc}${open ? ' c-open' : ''}" role="button" tabindex="0" data-group="${g.id}" aria-expanded="${open}"><span class="c-ic">${icon(g.ic)}</span>
      <div style="min-width:0"><div class="c-sys-top"><b>${g.title}</b>${groupIsNew(g, today) ? badge('new') : ''}</div><div class="c-sys-l">${st.line}${open ? ' · open' : ''}</div></div>
      <span class="c-end">${sw(st.any, `data-gsw="${g.id}"`, `${g.title}: all on or off`)}<span class="c-chev">${icon('chev')}</span></span></div>
      <div class="c-inner c-open alert-in"${open ? '' : ' hidden'}>${g.keys.map(k => `<div class="c-stepper alert-sw" role="switch" tabindex="0" aria-checked="${isOn(prefs, k)}" data-pref="${k}"><div>${esc(ALERTS[k][0])}${isNew(k, today) ? ` ${badge('new')}` : ''}${ALERTS[k][1] ? `<small>${esc(ALERTS[k][1])}</small>` : ''}</div><span class="c-sw${isOn(prefs, k) ? ' on' : ''}"></span></div>`).join('')}</div>`; }).join('');
  $('pushNew').innerHTML = isNew('push', today) ? badge('new') : '';
}
const savePrefs = () => api.saveSettings({ alerts: prefs }).catch(() => {});
/** Wired once (main.js): taps on a group row open it, its switch sets the group, an alert's row sets that alert. */
export function initAlertGroups() {
  const box = $('alertPrefs'); if (!box) return;
  box.onclick = e => {
    const gs = /** @type {Element} */ (e.target).closest('[data-gsw]'); if (gs) { e.stopPropagation(); prefs = toggleGroup(prefs, ALERT_GROUPS.find(g => g.id === gs.dataset.gsw)); savePrefs(); return drawAlertGroups(); }
    const k = /** @type {Element} */ (e.target).closest('[data-pref]'); if (k) { prefs = { ...prefs, [k.dataset.pref]: !isOn(prefs, k.dataset.pref) }; savePrefs(); return drawAlertGroups(); }
    const g = /** @type {Element} */ (e.target).closest('[data-group]'); if (g) { openGroups.has(g.dataset.group) ? openGroups.delete(g.dataset.group) : openGroups.add(g.dataset.group); drawAlertGroups(); }
  };
  box.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && /** @type {Element} */ (e.target).matches('[data-pref],[data-group]')) { e.preventDefault(); /** @type {HTMLElement} */ (e.target).click(); } };
}

export async function openRawData() {
  sheet(`${sheetHead('All data', '', 'Loading…')}${sheetFoot('', 'Done')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
  const [now, site] = await Promise.all([api.now(), api.site()]);
  sheet(`${sheetHead('All data', '', 'Exactly what Tesla returns for your site, and the latest reading Solstice stored.')}
    <div class="c-lab">Latest reading · ${now.reading ? ago(now.reading.ts) : '—'}</div><div class="raw">${esc(JSON.stringify(now.reading, null, 2))}</div>
    <div class="c-lab">site_info</div><div class="raw">${esc(JSON.stringify(site.raw, null, 2))}</div>${sheetFoot('', 'Done')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
}

/** Settings › Alerts › Push to this device: the row is the switch, with its line (mockup t-enhancements frame 3). */
let pushBusy = false;
export async function drawPush() {
  const sw = $('pushSw'), st = $('pushSt'); if (!sw || pushBusy) return;
  const { state, line: [text, cls, on, disabled] } = /** @type {{ state: string, line: [string, string, boolean, boolean] }} */ (await detectPush().catch(() => ({ state: 'unsupported', line: ['This browser can’t receive push', 'st-warn', false, true] })));
  st.textContent = text; st.className = cls; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on));
  sw.style.opacity = disabled ? '0.35' : ''; sw.setAttribute('aria-disabled', String(disabled));
  sw.onclick = async () => {
    if (disabled || pushBusy) return;
    pushBusy = true; st.textContent = on ? 'Turning off…' : 'Asking iOS…';
    try { if (on) await unsubscribePush(); else await subscribePush(); }
    catch (e) { pushBusy = false; st.textContent = e.message; st.className = 'st-warn'; return; }
    pushBusy = false; drawPush();
  };
}
