// Now (approved mockup mockups/al-ia.html v2, frames 1, 2, 3 and 17): the greeting, the orb and story (unchanged), the Energy flow card's
// chrome, the Today metric tiles, the Powerwall disclosure and the Ahead card (12 h strip | 48 h road). The pills, banner slot and
// Autopilot hub are views/nowhub.js; the pure maths is lib/nowui.js.
import { $, clamp, fmtDur, clock12, hourLabel, localHour, localDate, addDays, svgText, path } from '../lib/util.js';
import { WMO } from '../lib/weather.js';
import { forecast48 } from '../lib/model.js';
import { roadModel } from '../lib/road48data.js';
import { createRoad48, webgl2 } from '../scenes/road48.js';
import { veil, esc } from '../lib/frost.js';
import { fc48Header, TIERS } from '../lib/conf.js';
import { sumUntil, tileDelta, sparkPaths, barHeights, peakToday, STALE_MS } from '../lib/nowui.js';
import { icon } from '../lib/icons.js';
import { drawPills } from './nowhub.js';

/** How the current flows split between sources and sinks (Tesla reports only the four totals). */
function splitFlows(r) {
  const solHome = Math.min(r.solarKw, r.homeKw), rem = r.solarKw - solHome;
  const solPw = r.batteryKw < 0 ? Math.min(rem, -r.batteryKw) : 0, solGrid = Math.max(0, rem - solPw);
  const pwHome = Math.max(0, r.batteryKw), gridHome = Math.max(0, r.homeKw - solHome - pwHome), gridPw = r.batteryKw < 0 ? Math.max(0, -r.batteryKw - solPw) : 0;
  return { solHome, solPw, solGrid, pwHome, gridHome, gridPw };
}
const set = (id, prop, v) => { const el = $(id); if (el && el[prop] !== v) el[prop] = v; };

/* ---------- per-second render ---------- */
export function renderLive(S) {
  const r = S.live, site = S.now?.site ?? {}, out = S.outageActive;
  if (!r) return;
  const h = localHour();
  set('greet', 'textContent', h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');
  set('soc', 'textContent', String(Math.round(r.soc)));
  // mockup af: the estimates use the measured capacity (modelKwh, so cap × 95% is what a full charge delivers); "stored" stays on the nameplate
  const cap = site.capacityKwh || 27, mcap = site.modelKwh || cap, reserve = site.reservePct ?? 20, net = r.homeKw - r.solarKw;
  const toFull = r.batteryKw < -.05 ? (100 - r.soc) / 100 * mcap / (-r.batteryKw * .95) : null;
  const toEmpty = r.batteryKw > .05 ? Math.max(0, r.soc - (out ? 0 : reserve)) / 100 * mcap * .95 / r.batteryKw : null;
  set('battline', 'innerHTML', r.batteryKw < -.05 ? `<b>Charging ${(-r.batteryKw).toFixed(1)} kW</b> · full in ${fmtDur(toFull)}`
    : r.batteryKw > .05 ? `<b>Powering home · ${r.batteryKw.toFixed(1)} kW</b> · ${fmtDur(toEmpty)} to ${out ? 'empty' : 'reserve'}`
    : r.soc <= reserve + 1 ? `<b style="color:var(--mute)">At the ${reserve}% backup reserve</b>` : r.soc > 99 ? '<b>Full</b> · standing by' : '<b>Standing by</b>');

  // flows: the badge's words (home.js writes them while the twin runs) and its colour
  const f = splitFlows(r), stale = readingStale(S);
  if (!S.twinReplay) set('flowNote', 'textContent', out ? 'islanded · grid offline' : `${stale ? 'as of' : 'live ·'} ${clockOf(r.ts)}`);   // mockup x
  const fn = $('flowNote'); if (fn) { const t = S.twinReplay ? '' : out ? 'sim' : stale ? 'e' : 'live'; if (fn.dataset.t !== t) fn.dataset.t = t; }

  // one-sentence story
  const share = r.homeKw > 0 ? Math.min(1, f.solHome / r.homeKw) : 0;
  let story;
  if (out) {
    story = net <= .05
      ? `<b>The grid is down. Your home isn't.</b> The sun is covering everything${r.batteryKw < -.05 ? ` and still charging the Powerwalls at ${(-r.batteryKw).toFixed(1)} kW` : ''}.`
      : `<b>The grid is down. Your home isn't.</b> Solar covers ${Math.round(share * 100)}% and the Powerwalls the rest, which is about <b>${fmtDur(r.soc / 100 * mcap * .95 / net)}</b> at this rate.`;
  } else if (r.solarKw > .3) {
    story = share >= .99
      ? `<b>The sun is running your home.</b> ${r.batteryKw < -.05 ? `The extra ${(-r.batteryKw).toFixed(1)} kW is filling the Powerwalls.` : r.gridKw < -.05 ? `You're sending ${(-r.gridKw).toFixed(1)} kW to PEC.` : ''}`
      : `<b>Solar is covering ${Math.round(share * 100)}% of your home right now.</b> The rest (${(r.homeKw - f.solHome).toFixed(1)} kW) is coming from ${f.pwHome > .05 ? 'the Powerwalls' : 'PEC'}${f.pwHome > .05 && f.gridHome > .05 ? ' and PEC' : ''}.`;
  } else if (r.batteryKw > .05) {
    story = `<b>Your Powerwalls have the night shift.</b> They're covering ${Math.round(Math.min(1, r.batteryKw / r.homeKw) * 100)}% of the home's ${r.homeKw.toFixed(1)} kW.`;
  } else {
    story = `<b>Running on PEC</b> at ${r.gridKw.toFixed(1)} kW${r.soc <= reserve + 1 ? ` while the Powerwalls hold their ${reserve}% backup reserve` : ''}.`;
  }
  set('story', 'innerHTML', story);

  // the Powerwall disclosure (frame 2): badge, figure, one line, the charge bar with the reserve tick and today's forecast peak dashed
  const soc = Math.round(r.soc), st = $('pwState');
  set('pwPct', 'textContent', `${soc}%`);
  st.hidden = false;
  set('pwState', 'textContent', r.batteryKw < -.05 ? 'Charging' : r.batteryKw > .05 ? (out ? 'Powering home' : 'Discharging') : 'Idle');
  const t = r.batteryKw < -.05 ? 'l' : r.batteryKw > .05 ? 'e' : ''; if (st.dataset.t !== t) { if (t) st.dataset.t = t; else delete st.dataset.t; }
  set('pwSum', 'textContent', `≈ ${(r.soc / 100 * cap).toFixed(1)} of ${cap} kWh · reserve ${reserve}% · Storm Watch ${r.stormActive ? 'active' : site.stormWatch ? 'standby' : 'off'}`);
  const pk = peakToday(S.fc48?.points, localDate(), r.soc), m = $('pwMeter'), [u, i, s] = [m.querySelector('u'), m.querySelector('i'), m.querySelector('s')];
  i.style.width = `${clamp(r.soc, 0, 100)}%`; s.hidden = false; s.style.left = `${reserve}%`;
  u.hidden = !pk; if (pk) { u.style.left = `${clamp(r.soc, 0, 100)}%`; u.style.width = `${Math.max(0, pk.pct - r.soc)}%`; }
  const lab = [['0%', 0], ...(pk && Math.abs(pk.pct - reserve) < 24 ? [] : [[`reserve ${reserve}%`, reserve]]), ...(pk ? [[`~${pk.pct}% by ${clock12(pk.hour).replace(':00', '')}`, pk.pct]] : []), ...(pk && pk.pct > 78 ? [] : [['100%', 100]])];
  set('pwMeterLab', 'innerHTML', lab.map(([l, x]) => `<span style="left:${x}%">${l}</span>`).join(''));
  set('pwTTl', 'textContent', r.batteryKw > .05 ? (out ? 'Time to empty' : `Time to reserve (${reserve}%)`) : 'Time to full');
  set('pwTT', 'textContent', r.batteryKw < -.05 ? fmtDur(toFull) : r.batteryKw > .05 ? fmtDur(toEmpty) : r.soc > 99 ? 'Full' : 'Standing by');
  set('pwBackup', 'textContent', net <= .05 ? 'Solar covering it' : fmtDur(Math.max(0, r.soc) / 100 * mcap * .95 / net));
  set('pwMode', 'textContent', out ? 'Backup (islanded)' : ({ autonomous: 'Time-Based Control', self_consumption: 'Self-Powered', backup: 'Backup-only' }[site.mode] ?? site.mode ?? '—'));
  document.querySelectorAll('.pwu').forEach(el => { el.style.setProperty('--v', r.soc / 100); el.classList.toggle('chg', r.batteryKw < -.05); el.classList.toggle('dis', r.batteryKw > .05); });

  // outage: the island and the body class (the banner itself is in the banner slot)
  document.body.classList.toggle('out', out);
  if (out) { const since = S.now?.outage?.since ?? S.previewSince ?? Date.now(); const d = fmtDur((Date.now() - since) / 36e5); set('islandT', 'textContent', d === '—' ? '0m' : d); }
}

/* ---------- things that change every few minutes ---------- */
export function renderStatic(S) {
  const site = S.now?.site ?? {}, today = S.now?.today ?? {};
  set('siteLine', 'textContent', S.guest ? `${S.ownerName}'s home` : `Home · ${site.batteryCount ?? 2} Powerwalls`);
  set('pwModel', 'textContent', site.batteries?.length ? `${site.batteries.length} × ${site.batteries[0].name} · ${site.capacityKwh} kWh` : '');
  if (!$('pwUnits').children.length && site.batteries?.length)
    $('pwUnits').innerHTML = site.batteries.map((b, i) => `<div class="pwu"><i></i><b class="pwres" style="bottom:${site.reservePct ?? 20}%"></b><span>PW ${i + 1}</span><em>${esc(b.kwh)} kWh · ${esc(b.kw)} kW</em></div>`).join('');
  set('pwRes', 'textContent', `${site.reservePct ?? '—'}%`);
  set('pwStorm', 'textContent', S.live?.stormActive ? 'Active · charging for a storm' : site.stormWatch ? 'On · standing by' : 'Off');
  set('pwIn', 'textContent', today.charge != null ? `${today.charge.toFixed(1)} kWh` : '—');
  set('pwOut', 'textContent', today.discharge != null ? `${today.discharge.toFixed(1)} kWh` : '—');
  const d = S.daily?.at(-1);
  set('pwRange', 'textContent', d?.socMin != null ? `${Math.round(d.socMin)}% – ${Math.round(d.socMax)}%` : '—');
  drawTiles(S);
  freshness(S);   // the Status pill, the greeting's time and the flow badge (mockup x; also every second from main.js)
  S.redrawNow?.();
}

/* ---------- Today: four metric tiles (frame 2) ---------- */
const TILES = [['tileSol', 'Solar produced', 'solar', 'up'], ['tileHome', 'Home used', 'home', 'down'], ['tileImp', 'Bought from PEC', 'import', 'down'], ['tileExp', 'Sent to PEC', 'export', 'up']];
let tileKey = '';
export function drawTiles(S) {
  const today = S.now?.today; if (!today) return;
  const now = localDate(), y = S.yday?.date === addDays(now, -1) ? sumUntil(S.yday, localHour()) : null;
  const week = (S.daily ?? []).filter(x => x.date < now).slice(-7);
  const rate = S.tariff?.importRateAllIn, credit = S.tariff?.exportCredit;
  const note = {
    solar: S.yieldK && S.gtiToday != null && today.solar >= .5 ? `${Math.round(today.solar / (S.yieldK * S.gtiToday) * 100) || 0}% of what today's sun allows` : 'so far today',
    home: today.home ? `${Math.round(clamp(1 - today.import / today.home, 0, 1) * 100)}% from solar + battery` : '',
    // the existing rule: dollars only for the owner and only when the newest bill gave a rate
    import: !S.guest && rate != null && today.import != null ? `≈ $${(today.import * rate).toFixed(2)} at PEC rates` : '',
    export: !S.guest && credit != null && today.export != null ? `≈ $${(today.export * credit).toFixed(2)} credit` : '',
  };
  const html = TILES.map(([id, title, k, better]) => {
    const v = today[k], dl = tileDelta(v, y?.[k] ?? null, better), sp = sparkPaths(week.map(x => x[k]));
    return [id, `<div class="c-tile-k">${title}</div><div class="c-tile-v"><b>${v != null ? (Math.round(v * 10) / 10).toFixed(1) : '—'}</b><small>kWh</small></div>${note[k] ? `<div class="c-tile-n">${note[k]}</div>` : ''}${dl ? `<span class="c-delta" data-t="${dl.t}" aria-label="${esc(dl.text)} against the same time yesterday">${dl.text}</span>` : ''}${sp ? `<svg class="c-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="sg-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:currentColor;stop-opacity:.38"/><stop offset="1" style="stop-color:currentColor;stop-opacity:0"/></linearGradient></defs><path d="${sp.area}" fill="url(#sg-${id})"/><path d="${sp.line}" fill="none" stroke="currentColor" stroke-width="1.7" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg>` : '<span class="c-spark"></span>'}`];
  });
  const key = html.map(x => x[1]).join(''); if (key === tileKey) return; tileKey = key;
  html.forEach(([id, h]) => { $(id).innerHTML = h; });
}

/* ---------- mockup x: how old the live reading is, every second ---------- */
/** The newest reading is 3 minutes old or more, or Solstice can't be reached (every writer of the Now status lines uses this). */
const readingStale = S => !!S.nowOffline || !S.live || Date.now() - S.live.ts >= STALE_MS;
const clockOf = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const ageText = ms => ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3600_000)} h ago`;
/** The Status pill, the greeting's time, the flow card's badge and the dimming, from the newest reading's own timestamp. */
export function freshness(S) {
  const r = S.live, offline = !!S.nowOffline || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const age = r ? Date.now() - r.ts : null, stale = offline || age == null || age >= STALE_MS;
  drawPills(S);
  const syn = $('synced'), txt = !r ? (offline ? 'offline' : null) : offline ? `offline · ${clockOf(r.ts)}` : stale ? `as of ${clockOf(r.ts)}` : clockOf(r.ts);
  if (txt != null && syn.textContent !== txt) syn.textContent = txt;   // until then the skeleton stays
  syn.classList.toggle('asof', !!r && stale);
  $('syncDot').style.background = offline || (r && stale) ? 'var(--solar)' : '';
  if (r && stale && !S.twinReplay && !S.outageActive) { set('flowNote', 'textContent', `as of ${clockOf(r.ts)}`); $('flowNote').classList.add('asof'); }
  else if (!r && offline) { set('flowNote', 'textContent', 'offline'); $('flowNote').classList.add('asof'); }   // no reading yet, and none coming
  else if (!stale) $('flowNote').classList.remove('asof');
  document.querySelector('.orbwrap')?.classList.toggle('dimmed', !!r && stale);
  $('house')?.classList.toggle('dimmed', !!r && stale);
}

/* ---------- Ahead: the 12-hour strip and the 48-hour road (frames 2 and 3) ---------- */
const wxIcon = (code, day) => icon(code === 0 ? (day ? 'sun' : 'moon') : code <= 2 ? (day ? 'sun' : 'moon') : code >= 95 ? 'storm' : code >= 51 && code <= 82 ? 'rain' : 'cloud');
let road = null, roadArgs = null;
export function renderWeather(S) {
  const w = S.wx; if (!w) return;
  const c = w.current, now = localDate(), h = Math.floor(localHour());
  $('wxtop').innerHTML = `<b>${Math.round(c.temperature_2m)}°</b>${WMO(c.weather_code)} · UV ${Math.round(w.daily.uv_index_max[w.daily.time.indexOf(now)] ?? 0)}`;
  const start = w.hourly.time.indexOf(`${now}T${String(h).padStart(2, '0')}:00`);
  if (start >= 0) {
    const idx = Array.from({ length: 12 }, (_, k) => start + k).filter(i => i < w.hourly.time.length);
    const kws = idx.map(i => S.yieldK ? (w.hourly.global_tilted_irradiance[i + 1] ?? 0) / 1000 * S.yieldK : 0), hs = barHeights(kws);
    $('wx12').innerHTML = idx.map((i, k) => { const hh = +w.hourly.time[i].slice(11, 13);
      return `<div class="${k === 0 ? 'now' : ''}"><span class="k">${S.yieldK ? kws[k].toFixed(1) : '—'}</span><span class="b" style="height:${hs[k]}px"></span>${wxIcon(w.hourly.weather_code[i], hh > 6 && hh < 20)}<span class="t">${Math.round(w.hourly.temperature_2m[i])}°</span><span class="h">${k === 0 ? 'Now' : hourLabel(hh)}</span></div>`; }).join('');
  }
  const rainy = w.daily.precipitation_probability_max.slice(w.daily.time.indexOf(now), w.daily.time.indexOf(now) + 3).reduce((a, b) => Math.max(a, b ?? 0), 0);
  S.wxStorm = rainy > 40 ? `${rainy}% chance of rain in the next few days` : 'no storms expected';   // the Conditions sheet's Storm Watch row

  if (!S.live || !S.yieldK || !S.profile) return;
  const site = S.now.site, fc = forecast48({ w, startDate: now, startHour: h, soc0: S.live.soc, yieldK: S.yieldK, profile: S.profile,
    capKwh: site.modelKwh || site.capacityKwh || 27, maxKw: site.maxPowerKw || 10, reservePct: site.reservePct ?? 20, dayScale: S.profileScale, correction: S.fcCorrection });
  const P = fc.points; if (!P.length) return;
  S.fc48 = fc;   // the Powerwall card's forecast peak and the hub's charging window
  const peakBatt = P.reduce((a, p) => p.soc > a.soc ? p : a, P[0]);
  const when = t => `${new Date(t + ':00').toLocaleDateString('en-US', { weekday: 'short' })} ${clock12(+t.slice(11, 13))}`;
  const reserveHits = P.filter(p => p.soc <= (site.reservePct ?? 20) / 100 + .005);
  $('fcTxt').innerHTML = `${fc.full ? `Powerwalls should be <b style="color:var(--batt)">full by ${when(fc.full)}</b>. ` : `Powerwalls peak around <b style="color:var(--batt)">${Math.round(peakBatt.soc * 100)}%</b> (${when(peakBatt.t)}); your home uses most of the solar as it's made. `}` +
    `${reserveHits.length ? `They'll sit at the reserve for about ${reserveHits.length} of the next 48 hours, so ` : ''}you'll buy about <b style="color:var(--grid)">${Math.round(fc.importKwh)} kWh</b> from PEC over the next two days (${S.guest ? `≈ ${veil('$•••')}` : S.tariff ? `≈ $${(fc.importKwh * S.tariff.importRateAllIn).toFixed(0)}` : 'rate unknown'}).`;
  // r-learning: forecast accuracy as one fine-print line with the solar forecast's confidence badge
  const fh = fc48Header(S.fcConf, S.models), tier = S.fcConf?.['fc48.solar'];
  $('fcAcc').hidden = !fh;
  if (fh) $('fcAcc').innerHTML = `${esc(fh.replace(/^forecast · /, 'forecast accuracy · '))}${tier && fh.includes('±') ? ` <span class="c-badge" data-t="${TIERS[tier] === 'n' ? 'u' : TIERS[tier] ?? 'u'}" style="margin-left:4px">${esc(tier)}</span>` : ''}`;
  // the fallback chart (no WebGL2) and the 3D road's data; the road itself is built on the first tap of 48 h
  drawFallback(S, fc);
  roadArgs = { fc, w, when, soc0: S.live.soc / 100, capKwh: site.modelKwh || site.capacityKwh || 27, maxKw: site.maxPowerKw || 10, reservePct: site.reservePct ?? 20 };
  if (road) road.refresh(); else if (S.ahead48 && webgl2()) (road = createRoad48($('road48'), $('road48Tip'), { model: () => roadModel({ ...roadArgs, pool: S.pool, ac: S.ac }), calm: () => S.calm }))?.refresh();
}
function drawFallback(S, fc) {
  const P = fc.points, site = S.now.site;
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
}
/** The 12 h | 48 h segment: the 12-hour strip by default; 48 h shows the road (built on its first tap; the SVG without WebGL2). */
export function initAhead(S) {
  const segEl = $('aheadSeg');
  segEl.onclick = e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const k48 = b.dataset.a === '48';
    segEl.style.setProperty('--i', k48 ? 1 : 0);
    segEl.querySelectorAll('button').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    $('ah12').hidden = k48; $('ah48').hidden = !k48; S.ahead48 = k48;
    if (!k48) return;
    const gl = webgl2(); $('fc48').style.display = gl ? '' : 'block'; $('road48').hidden = $('road48Tip').hidden = !gl;
    if (gl && roadArgs) (road ??= createRoad48($('road48'), $('road48Tip'), { model: () => roadModel({ ...roadArgs, pool: S.pool, ac: S.ac }), calm: () => S.calm })).refresh();
    else if (gl && !roadArgs) $('road48Tip').innerHTML = '<span class="ph">Waiting for the forecast…</span>';
  };
}
/** The Powerwall disclosure: tap (or Enter/Space) opens the existing rows. */
export function initPwDisc() {
  const h = $('pwDiscH'), card = $('pwDisc');
  h.onclick = () => { const open = !card.classList.contains('expanded'); card.classList.toggle('expanded', open); h.setAttribute('aria-expanded', String(open)); $('pwBody').hidden = !open; };
}
