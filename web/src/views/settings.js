import { $, niceDate, ago } from '../lib/util.js';
import { api } from '../lib/api.js';

const PREFS = [['outage', 'var(--out)', '⚡', 'Grid outage started or ended'], ['lowBatt', 'var(--solar)', '↓', 'Battery low during an outage', 'Below 30%'],
  ['solar', 'var(--warn)', '☀', 'Solar underperforming', '≥ 8% below baseline'], ['nws', 'var(--home)', '⛈', 'Severe weather (NWS)'], ['bill', 'var(--grid)', '≈', 'Bill doesn’t match Tesla', 'Gap over 5%'],
  ['baseline', 'var(--grid)', '◐', 'Overnight usage drift'], ['stale', 'var(--mute)', '⏻', 'Tesla stopped reporting', 'After 3 minutes']];
let prefs = {};
api.settings().then(p => { prefs = p.alerts ?? {}; document.querySelectorAll('[data-pref]').forEach(el => el.classList.toggle('on', prefs[el.dataset.pref] !== false)); }).catch(() => {});
const load = () => prefs;

export function drawSettings(S) {
  const site = S.now?.site ?? {}, h = S.now?.health ?? {}, t = S.tariff;
  $('setTesla').textContent = `Solstice Home Energy · ${site.name ?? 'energy site'}`;
  $('setTeslaV').innerHTML = h.stale ? '<span style="color:var(--warn)">No data</span>' : `<span style="color:var(--batt)">Live</span>`;
  $('setWx').innerHTML = S.wx ? '<span style="color:var(--batt)">Live</span>' : '—';
  const row = (c, i, title, sub, v) => `<div class="row" style="--c:${c}"><div class="ri">${i}</div><div class="rt">${title}${sub ? `<small>${sub}</small>` : ''}</div><div class="rv">${v}</div></div>`;
  $('sysGroup').innerHTML =
    row('var(--batt)', '▮', 'Powerwalls', `${site.batteries?.map(b => b.name).join(' + ') ?? ''}`, `${site.capacityKwh ?? '—'} kWh · ${site.maxPowerKw ?? '—'} kW`) +
    row('var(--solar)', '☀', 'Solar', site.solar ? `${site.solar.panels} × ${site.solar.module} · Enphase IQ7XS microinverters` : '30 panels', site.solar ? `${site.solar.dcKw} kW DC · ${site.solar.acKw} kW AC` : '—') +
    row('var(--warn)', '⛨', 'Backup reserve', 'Set in the Tesla app', `${site.reservePct ?? '—'}%`) +
    row('var(--grid)', '⚙', 'Operating mode', site.mode === 'autonomous' ? 'Time-Based Control' : '', site.mode ?? '—') +
    row('var(--home)', '$', 'Utility', t ? `$${t.importRateAllIn}/kWh all-in · ${t.exportCredit != null ? `$${t.exportCredit}` : '—'}/kWh export credit` : 'Add a bill to learn your rates', 'PEC') +
    row('var(--mute)', '⌂', 'Installed', `Gateway firmware ${site.firmware?.split(' ')[0] ?? '—'}`, site.installed ? niceDate(site.installed.slice(0, 10), { month: 'short', year: 'numeric' }) : '—');
  const prefs = load();
  $('alertPrefs').innerHTML = PREFS.map(([k, c, i, title, sub]) => `<div class="row" style="--c:${c}"><div class="ri">${i}</div><div class="rt">${title}${sub ? `<small>${sub}</small>` : ''}</div><div class="sw ${prefs[k] === false ? '' : 'on'}" data-pref="${k}"></div></div>`).join('');
  document.querySelectorAll('[data-pref]').forEach(el => el.onclick = () => { prefs[el.dataset.pref] = el.classList.toggle('on'); api.saveSettings({ alerts: prefs }).catch(() => {}); });
}

export async function openRawData() {
  $('sheetBody').innerHTML = '<h4>All data</h4><p class="sub">Loading…</p>';
  $('phone').classList.add('open');
  const [now, site] = await Promise.all([api.now(), api.site()]);
  $('sheetBody').innerHTML = `<h4>All data</h4><p class="sub">Exactly what Tesla returns for your site, and the latest reading Solstice stored.</p>
    <div class="sect" style="margin-top:14px">Latest reading · ${now.reading ? ago(now.reading.ts) : '—'}</div><div class="raw">${JSON.stringify(now.reading, null, 2)}</div>
    <div class="sect">site_info</div><div class="raw">${JSON.stringify(site.raw, null, 2).replace(/</g, '&lt;')}</div>`;
}
