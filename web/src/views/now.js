import { $, fmtDur, clock12, hourLabel, kwh, localHour, localDate, svgText, path } from '../lib/util.js';
import { WMO, WICON } from '../lib/weather.js';
import { forecast48 } from '../lib/model.js';
import { roadModel } from '../lib/road48data.js';
import { createRoad48, webgl2 } from '../scenes/road48.js';
import { veil } from '../lib/frost.js';
import { fc48Header } from '../lib/conf.js';

/** How the current flows split between sources and sinks (Tesla reports only the four totals). */
function splitFlows(r) {
  const solHome = Math.min(r.solarKw, r.homeKw), rem = r.solarKw - solHome;
  const solPw = r.batteryKw < 0 ? Math.min(rem, -r.batteryKw) : 0, solGrid = Math.max(0, rem - solPw);
  const pwHome = Math.max(0, r.batteryKw), gridHome = Math.max(0, r.homeKw - solHome - pwHome), gridPw = r.batteryKw < 0 ? Math.max(0, -r.batteryKw - solPw) : 0;
  return { solHome, solPw, solGrid, pwHome, gridHome, gridPw };
}

/* ---------- per-second render ---------- */
export function renderLive(S) {
  const r = S.live, site = S.now?.site ?? {}, out = S.outageActive;
  if (!r) return;
  const h = localHour();
  $('greet').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('soc').textContent = Math.round(r.soc);
  const cap = site.capacityKwh || 27, reserve = site.reservePct ?? 20, net = r.homeKw - r.solarKw;
  const toFull = r.batteryKw < -.05 ? (100 - r.soc) / 100 * cap / (-r.batteryKw * .95) : null;
  const toEmpty = r.batteryKw > .05 ? Math.max(0, r.soc - (out ? 0 : reserve)) / 100 * cap * .95 / r.batteryKw : null;
  $('battline').innerHTML = r.batteryKw < -.05 ? `<b>Charging ${(-r.batteryKw).toFixed(1)} kW</b> · full in ${fmtDur(toFull)}`
    : r.batteryKw > .05 ? `<b>Powering home · ${r.batteryKw.toFixed(1)} kW</b> · ${fmtDur(toEmpty)} to ${out ? 'empty' : 'reserve'}`
    : r.soc <= reserve + 1 ? `<b style="color:var(--mute)">At the ${reserve}% backup reserve</b>` : r.soc > 99 ? '<b>Full</b> · standing by' : '<b>Standing by</b>';

  // flows
  const f = splitFlows(r);
  if (!S.twinReplay) $('flowNote').textContent = out ? 'islanded · grid offline' : `live · ${new Date(r.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

  // one-sentence story
  const share = r.homeKw > 0 ? Math.min(1, f.solHome / r.homeKw) : 0;
  if (out) {
    $('story').innerHTML = net <= .05
      ? `<b>The grid is down. Your home isn't.</b> The sun is covering everything${r.batteryKw < -.05 ? ` and still charging the Powerwalls at ${(-r.batteryKw).toFixed(1)} kW` : ''}.`
      : `<b>The grid is down. Your home isn't.</b> Solar covers ${Math.round(share * 100)}% and the Powerwalls the rest, which is about <b>${fmtDur(r.soc / 100 * cap * .95 / net)}</b> at this rate.`;
  } else if (r.solarKw > .3) {
    $('story').innerHTML = share >= .99
      ? `<b>The sun is running your home.</b> ${r.batteryKw < -.05 ? `The extra ${(-r.batteryKw).toFixed(1)} kW is filling the Powerwalls.` : r.gridKw < -.05 ? `You're sending ${(-r.gridKw).toFixed(1)} kW to PEC.` : ''}`
      : `<b>Solar is covering ${Math.round(share * 100)}% of your home right now.</b> The rest (${(r.homeKw - f.solHome).toFixed(1)} kW) is coming from ${f.pwHome > .05 ? 'the Powerwalls' : 'PEC'}${f.pwHome > .05 && f.gridHome > .05 ? ' and PEC' : ''}.`;
  } else if (r.batteryKw > .05) {
    $('story').innerHTML = `<b>Your Powerwalls have the night shift.</b> They're covering ${Math.round(Math.min(1, r.batteryKw / r.homeKw) * 100)}% of the home's ${r.homeKw.toFixed(1)} kW.`;
  } else {
    $('story').innerHTML = `<b>Running on PEC</b> at ${r.gridKw.toFixed(1)} kW${r.soc <= reserve + 1 ? ` while the Powerwalls hold their ${reserve}% backup reserve` : ''}.`;
  }

  // Powerwall card
  $('pwPct').textContent = Math.round(r.soc) + '%';
  $('pwState').textContent = r.batteryKw < -.05 ? `Charging · ${(-r.batteryKw).toFixed(1)} kW` : r.batteryKw > .05 ? `${out ? 'Powering home' : 'Discharging'} · ${r.batteryKw.toFixed(1)} kW` : 'Idle';
  $('pwState').dataset.s = r.batteryKw < -.05 ? 'c' : r.batteryKw > .05 ? 'd' : 'i';
  $('pwStored').textContent = `≈ ${(r.soc / 100 * cap).toFixed(1)} of ${cap} kWh stored`;
  $('pwTTl').textContent = r.batteryKw > .05 ? (out ? 'Time to empty' : `Time to reserve (${reserve}%)`) : 'Time to full';
  $('pwTT').textContent = r.batteryKw < -.05 ? fmtDur(toFull) : r.batteryKw > .05 ? fmtDur(toEmpty) : r.soc > 99 ? 'Full' : '—';
  $('pwBackup').textContent = net <= .05 ? 'Solar covering it' : fmtDur(Math.max(0, r.soc) / 100 * cap * .95 / net);
  $('pwMode').textContent = out ? 'Backup (islanded)' : ({ autonomous: 'Time-Based Control', self_consumption: 'Self-Powered', backup: 'Backup-only' }[site.mode] ?? site.mode ?? '—');
  document.querySelectorAll('.pwu').forEach(el => { el.style.setProperty('--v', r.soc / 100); el.classList.toggle('chg', r.batteryKw < -.05); el.classList.toggle('dis', r.batteryKw > .05); });

  // outage banner / island
  document.body.classList.toggle('out', out);
  if (out) { const since = S.now?.outage?.since ?? S.previewSince ?? Date.now(); const t = fmtDur((Date.now() - since) / 36e5); $('outDur').textContent = t === '—' ? '0m' : t; $('islandT').textContent = $('outDur').textContent; }
}

/* ---------- things that change every few minutes ---------- */
export function renderStatic(S) {
  const site = S.now?.site ?? {}, today = S.now?.today ?? {};
  $('siteLine').textContent = S.guest ? `${S.ownerName}'s home` : `Home · ${site.batteryCount ?? 2} Powerwalls`;
  $('pwModel').textContent = site.batteries?.length ? `${site.batteries.length} × ${site.batteries[0].name} · ${site.capacityKwh} kWh` : '—';
  if (!$('pwUnits').children.length && site.batteries?.length)
    $('pwUnits').innerHTML = site.batteries.map((b, i) => `<div class="pwu"><i></i><b class="pwres" style="bottom:${site.reservePct ?? 20}%"></b><span>PW ${i + 1}</span><em>${b.kwh} kWh · ${b.kw} kW</em></div>`).join('');
  $('pwRes').textContent = `${site.reservePct ?? '—'}%`;
  $('pwStorm').textContent = S.live?.stormActive ? 'Active · charging for a storm' : site.stormWatch ? 'On · standing by' : 'Off';
  $('pwIn').textContent = today.charge != null ? `${today.charge.toFixed(1)} kWh` : '—';
  $('pwOut').textContent = today.discharge != null ? `${today.discharge.toFixed(1)} kWh` : '—';
  const d = S.daily?.at(-1);
  $('pwRange').textContent = d?.socMin != null ? `${Math.round(d.socMin)}% – ${Math.round(d.socMax)}%` : '—';

  // today's totals
  $('tSol').innerHTML = kwh(today.solar); $('tHome').innerHTML = kwh(today.home);
  $('tImp').innerHTML = kwh(today.import); $('tExp').innerHTML = kwh(today.export);
  const rate = S.tariff?.importRateAllIn, credit = S.tariff?.exportCredit;
  $('tSolE').textContent = S.yieldK && S.gtiToday != null ? `${Math.round(today.solar / (S.yieldK * S.gtiToday) * 100) || 0}% of what today's sun allows` : 'so far today';
  $('tSelf').textContent = today.home ? `${Math.round((1 - today.import / today.home) * 100)}% from solar + battery` : '—';
  $('tImpE').innerHTML = today.import != null ? S.guest ? `≈ ${veil('$•.••')} at PEC rates` : rate != null ? `≈ $${(today.import * rate).toFixed(2)} at PEC rates` : 'rate unknown' : '—';
  $('tExpE').innerHTML = today.export != null ? S.guest ? `≈ ${veil('$•.••')} credit` : credit != null ? `≈ $${(today.export * credit).toFixed(2)} credit` : 'rate unknown' : '—';

  // status chips
  const stale = S.now?.health?.stale;
  $('chipGw').innerHTML = stale ? '<i style="--c:var(--warn)"></i>Tesla not reporting' : '<i></i>Powerwalls online';
  $('chipStorm').innerHTML = S.live?.stormActive ? '<i style="--c:var(--solar)"></i>Storm Watch active' : `<i style="--c:rgba(242,244,248,.4);box-shadow:none"></i>Storm Watch ${site.stormWatch ? 'standby' : 'off'}`;
  if (S.ercot) { const e = S.ercot, bad = e.condition !== 'normal';
    $('chipErcot').className = 'chipx' + (bad ? ' alert' : ''); $('chipErcot').innerHTML = `<i style="--c:${bad ? 'var(--out)' : 'var(--batt)'}"></i>ERCOT ${bad ? e.title : 'normal'}${e.demandMw ? ` · ${Math.round(e.demandMw / e.capacityMw * 100)}% load` : ''}`; }
  if (S.nws) { const a = S.nws[0];
    $('chipNws').className = 'chipx' + (a ? ' alert' : ''); $('chipNws').innerHTML = a ? `<i style="--c:var(--out)"></i>${a.event}` : '<i style="--c:var(--batt)"></i>No weather alerts'; }
  $('synced').textContent = S.live ? new Date(S.live.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'connecting…';
  $('syncDot').style.background = stale ? 'var(--warn)' : '';
}

/* ---------- weather + 48h forecast ---------- */
let road = null, roadArgs = null;
export function renderWeather(S) {
  const w = S.wx; if (!w) return;
  const c = w.current, now = localDate(), h = Math.floor(localHour());
  $('wxtop').innerHTML = `<b>${Math.round(c.temperature_2m)}°</b>${WMO(c.weather_code)} · UV ${Math.round(w.daily.uv_index_max[w.daily.time.indexOf(now)] ?? 0)}`;
  const start = w.hourly.time.indexOf(`${now}T${String(h).padStart(2, '0')}:00`), box = $('wx12'); box.innerHTML = '';
  for (let i = start; i < start + 12 && i >= 0; i++) { const g = w.hourly.global_tilted_irradiance[i + 1] ?? 0, kw = S.yieldK ? g / 1000 * S.yieldK : 0, cd = w.hourly.weather_code[i], hh = +w.hourly.time[i].slice(11, 13);
    box.insertAdjacentHTML('beforeend', `<div class="${i === start ? 'now' : ''}"><span>${i === start ? 'Now' : hourLabel(hh)}</span><span class="ic">${WICON(cd, hh > 6 && hh < 20)}</span><span>${Math.round(w.hourly.temperature_2m[i])}°</span><i class="kb" style="height:${4 + kw * 4}px"></i><span class="kw">${kw.toFixed(1)}</span></div>`); }
  $('wx12s').textContent = 'kW expected from your panels';

  if (!S.live || !S.yieldK || !S.profile) return;
  const site = S.now.site, fc = forecast48({ w, startDate: now, startHour: h, soc0: S.live.soc, yieldK: S.yieldK, profile: S.profile,
    capKwh: site.capacityKwh || 27, maxKw: site.maxPowerKw || 10, reservePct: site.reservePct ?? 20 });
  const P = fc.points; if (!P.length) return;
  const maxKw = Math.max(4, ...P.map(p => Math.max(p.s, p.h))), X = k => 8 + k / 48 * 294, Yk = v => 118 - v / maxKw * 100, Ys = v => 118 - v * 100;
  let o = '';
  P.forEach(p => { const hh = +p.t.slice(11, 13); if (hh >= 20 || hh < 7) o += `<rect x="${X(p.k)}" y="14" width="${X(1) - X(0) + .5}" height="104" fill="rgba(255,255,255,.025)"/>`; });
  [0, 24, 48].forEach(k => o += `<line x1="${X(k)}" x2="${X(k)}" y1="14" y2="118" stroke="rgba(255,255,255,.1)"/>`);
  o += svgText(X(0), 134, 'now') + svgText(X(24), 134, '+24h', { anchor: 'middle' }) + svgText(X(48), 134, '+48h', { anchor: 'end' });
  o += `<path d="M${X(0)} 118${P.map(p => `L${X(p.k).toFixed(1)} ${Yk(p.s).toFixed(1)}`).join('')}L${X(P.at(-1).k)} 118Z" fill="rgba(255,193,94,.3)" stroke="#ffc15e" stroke-width="1.2"/>`;
  o += `<path d="${path(P.map(p => [X(p.k), Yk(p.h)]))}" fill="none" stroke="#6cc4ff" stroke-width="1.3" stroke-opacity=".8"/>`;
  o += `<path d="${path(P.map(p => [X(p.k), Ys(p.soc)]))}" fill="none" stroke="#4ef0a6" stroke-width="2.2" style="filter:drop-shadow(0 0 3px #4ef0a6)"/>`;
  o += `<line x1="8" x2="302" y1="${Ys((site.reservePct ?? 20) / 100)}" y2="${Ys((site.reservePct ?? 20) / 100)}" stroke="rgba(255,122,102,.6)" stroke-dasharray="3 3"/>`;
  const peakBatt = P.reduce((a, p) => p.soc > a.soc ? p : a, P[0]);
  o += `<circle cx="${X(peakBatt.k)}" cy="${Ys(peakBatt.soc)}" r="3.5" fill="#4ef0a6"/>${svgText(X(peakBatt.k), Ys(peakBatt.soc) - 7, Math.round(peakBatt.soc * 100) + '%', { anchor: 'middle', fill: '#4ef0a6' })}`;
  $('fc48').innerHTML = o;
  const when = t => `${new Date(t + ':00').toLocaleDateString('en-US', { weekday: 'short' })} ${clock12(+t.slice(11, 13))}`;
  const reserveHits = P.filter(p => p.soc <= (site.reservePct ?? 20) / 100 + .005);
  $('fcTxt').innerHTML = `${fc.full ? `Powerwalls should be <b style="color:var(--batt)">full by ${when(fc.full)}</b>. ` : `Powerwalls peak around <b style="color:var(--batt)">${Math.round(peakBatt.soc * 100)}%</b> (${when(peakBatt.t)}); your home uses most of the solar as it's made. `}` +
    `${reserveHits.length ? `They'll sit at the reserve for about ${reserveHits.length} of the next 48 hours, so ` : ''}you'll buy about <b style="color:var(--grid)">${Math.round(fc.importKwh)} kWh</b> from PEC over the next two days (${S.guest ? `≈ ${veil('$•••')}` : S.tariff ? `≈ $${(fc.importKwh * S.tariff.importRateAllIn).toFixed(0)}` : 'rate unknown'}).`;
  const fh = fc48Header(S.fcConf, S.models); if (fh) $('road48').closest('.card').querySelector('.h span').textContent = fh;   // r-learning: forecast confidence
  // the 3D road (scenes/road48.js, mockup l-forecast48) replaces the chart; the SVG above stays as the fallback without WebGL2
  const gl = webgl2(); $('fc48').style.display = gl ? '' : 'block'; $('road48').hidden = $('road48Tip').hidden = !gl;
  roadArgs = { fc, w, when, soc0: S.live.soc / 100, capKwh: site.capacityKwh || 27, maxKw: site.maxPowerKw || 10, reservePct: site.reservePct ?? 20 };
  if (gl) (road ??= createRoad48($('road48'), $('road48Tip'), { model: () => roadModel({ ...roadArgs, pool: S.pool, ac: S.ac }), calm: () => S.calm })).refresh();
  const rainy = w.daily.precipitation_probability_max.slice(w.daily.time.indexOf(now), w.daily.time.indexOf(now) + 3).reduce((a, b) => Math.max(a, b ?? 0), 0);
  $('wxSum').innerHTML = rainy > 40 ? `There's a ${rainy}% chance of rain in the next few days. Storm Watch will top up the Powerwalls if a storm is forecast.` : 'No storms expected, so Storm Watch stays on standby.';
}
