import { $, niceDate, localDate, localHour, svgText, toast, hourLabel } from '../lib/util.js';
import { roofHours, sunSays } from '../lib/roofhours.js';
import { api } from '../lib/api.js';
import { WMO, WICON } from '../lib/weather.js';
import { veil, esc } from '../lib/frost.js';
import { badge } from '../lib/conf.js';
import { segSet } from './csheet.js';
import { kIndex, posOf, tint, rgba, tileStyle, deficit } from '../lib/panels.js';

let cleanings = [];
async function loadCleanings(S) { cleanings = (await api.events().catch(() => [])).filter(e => e.type === 'cleaned'); drawCleanLog(S); }
function drawCleanLog(S) {
  const last = cleanings[0];
  $('cleaned').outerHTML = last
    ? `<div id="cleaned" class="c-modeline c-acc-batt" style="width:100%"><p><b>Cleaning logged</b> · ${niceDate(last.day, { month: 'short', day: 'numeric' })}</p><button class="c-btn sm line" id="undoClean">Undo</button></div>`
    : `<button class="c-btn line block" id="cleaned">I cleaned the panels</button>`;
  if (last) $('undoClean').onclick = async () => { await api.deleteEvent(last.id); toast('↺', 'rgba(255,255,255,.12)', 'Cleaning removed', `The ${niceDate(last.day)} entry is gone.`); await loadCleanings(S); drawPerformance(S); loadSoiling(S); };
  else $('cleaned').onclick = async () => { await api.addEvent('cleaned', localDate()); toast('✓', 'rgba(78,240,166,.2)', 'Cleaning logged', 'The next 3 clear days set the new clean level. Tap Undo if that was a mistake.'); await loadCleanings(S); drawPerformance(S); loadSoiling(S); };
}

/** Daily solar vs what the day's sunlight should give (baseline yield learned from the same season last year). */
export function drawPerformance(S) {
  const K = S.baselineK ?? S.yieldK; if (!K || !S.daily || !S.gtiByDate) return;
  const rows = S.daily.filter(d => d.date < localDate() && S.gtiByDate[d.date] != null).slice(-30);
  if (!rows.length) return;
  const exp = r => K * S.gtiByDate[r.date], mx = Math.max(...rows.map(r => Math.max(r.solar, exp(r)))) * 1.08, bw = 327 / rows.length, H = 104, base = 112;
  // mockup al frame 10: gradient bars, a white "expected" cap on each, the days below the weather model in the warning colour, one direct label
  let o = `<defs><linearGradient id="prg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--solar)"/><stop offset="1" style="stop-color:var(--solar);stop-opacity:.2"/></linearGradient><linearGradient id="prw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--warn)"/><stop offset="1" style="stop-color:var(--warn);stop-opacity:.25"/></linearGradient></defs>`, firstLow = null;
  rows.forEach((r, i) => { const x = 2 + i * bw, w = Math.max(2, bw - 3.9), h1 = r.solar / mx * H, y2 = base - exp(r) / mx * H, ratio = r.solar / exp(r), low = S.gtiByDate[r.date] > 2.5 && ratio < .9;
    if (low && firstLow == null) firstLow = x + w / 2;
    o += `<rect x="${x.toFixed(1)}" y="${(base - h1).toFixed(1)}" width="${w.toFixed(1)}" height="${h1.toFixed(1)}" rx="3" fill="url(#${low ? 'prw' : 'prg'})"><title>${esc(r.date)}: ${r.solar.toFixed(1)} kWh · expected ${exp(r).toFixed(1)} (${Math.round(ratio * 100)}%)</title></rect>`
      + `<line x1="${(x - 1).toFixed(1)}" x2="${(x + w + 1).toFixed(1)}" y1="${y2.toFixed(1)}" y2="${y2.toFixed(1)}" style="stroke:var(--text)" stroke-opacity=".55" stroke-width="1.5" stroke-linecap="round"/>`; });
  if (firstLow != null) o += `<text class="d" x="${Math.min(200, Math.max(2, firstLow - 20)).toFixed(0)}" y="8">↓ below the weather model</text>`;
  o += `<text x="2" y="128">${niceDate(rows[0].date)}</text><text x="164" y="128" text-anchor="middle">${niceDate(rows[Math.floor(rows.length / 2)].date)}</text><text x="327" y="128" text-anchor="end">${niceDate(rows.at(-1).date)}</text>`;
  $('prChart').innerHTML = o;
  const clear = rows.filter(r => S.gtiByDate[r.date] > 4.5), ratio = clear.length ? clear.reduce((a, r) => a + r.solar / exp(r), 0) / clear.length : null;
  $('prTxt').innerHTML = ratio == null ? 'Not enough clear days yet to judge performance.'
    : `On clear days over the last month, the panels made <b>${Math.round(ratio * 100)}%</b> of what the same sunlight produced this time last year. ${ratio >= .95 ? "That's healthy, with no sign of lost output." : ratio >= .9 ? 'A little low. Worth watching.' : 'Noticeably low. Check the cleaning card below.'}`;
  drawWarranty(S);
}

/** Measured output per unit of full sun against the SunPower 25-year power warranty (docs/system-specs.md). */
function drawWarranty(S) {
  const sp = S.now?.site?.solar; if (!sp) return;
  const y = S.yieldStc ?? S.yieldK, pct = y ? Math.round(y / sp.acKw * 100) : null;
  $('wrNow').textContent = y ? `${y.toFixed(2)} kW · ${pct}% of ${sp.acKw} kW AC` : '—';
  $('wrYear').textContent = `year ${sp.year} of ${sp.warranty.years}`;
  $('wrFloor').textContent = `≥ ${sp.warrantedDcPct}% DC · ${(sp.dcKw * sp.warrantedDcPct / 100).toFixed(2)} kW`;
  $('wrAc').textContent = `≥ ${sp.warranty.acFloorPct}% · ${(sp.acKw * sp.warranty.acFloorPct / 100).toFixed(2)} kW`;
  const w = pct == null ? '' : pct >= sp.warranty.acFloorPct ? ` Corrected to the warranty's 25 °C test conditions, full-sun output is ${pct >= sp.warrantedDcPct ? 'above' : 'within'} the warranted range: no sign of ageing beyond SunPower's ${sp.warranty.dcDeclinePctPerYear}% a year.`
    : pct >= 80 ? ` Corrected to the warranty's 25 °C test conditions, full-sun output sits a little under the ${sp.warranty.acFloorPct}% AC floor, but soiling, wiring and shading normally cost 5–10% that the warranty doesn't count, so this is what a healthy array looks like.`
    : ` Even corrected to the warranty's 25 °C test conditions, full-sun output is well below the ${sp.warranty.acFloorPct}% AC floor. If it stays there on clean, clear days, talk to SunPower.`;
  $('prTxt').innerHTML += w;
}

/* mockup ai: the Cleaning check from the server's clear-day comparison (server/src/soiling.ts): clean level after the last 5 mm rain or
   logged cleaning, the latest 3 clear days against it, hot panels allowed for. Reloaded when a cleaning is logged or undone. */
const span = (a, b) => a.slice(0, 7) === b.slice(0, 7) ? `${MON3(a)}–${+b.slice(8)}` : `${MON3(a)}–${MON3(b)}`;   // Jul 20–26 · Jul 30–Aug 2
const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`, MON3 = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
async function loadSoiling(S) { try { S.soiling = await api.soiling(); } catch { /* keep the last */ } drawCleaning(S); }
const pm = s => s?.lossSd ? ` ± ${s.lossSd}%` : '';   // B2-13: the day-to-day noise band ("5.5% ± 1.2% below clean")
function drawCleaning(S) {
  const s = S.soiling; if (s === undefined) return;
  const loss = s?.lossPct ?? null, score = s?.score ?? 0;
  S.dust = { score: loss == null ? 0 : score, loss: loss == null ? null : loss / 100 };   // the Live roof's dust veil
  const r = 34, C = 2 * Math.PI * r, col = s?.state === 'dusty' || s?.state === 'getting' ? 'var(--solar)' : 'var(--batt)';
  $('cleanRing').innerHTML = `<circle cx="42" cy="42" r="${r}" fill="none" style="stroke:var(--c-fill-2)" stroke-width="7"/><circle cx="42" cy="42" r="${r}" fill="none" style="stroke:${col}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C * score / 100} ${C}" transform="rotate(-90 42 42)"/>
    <text x="42" y="44" text-anchor="middle" style="fill:var(--text)" font-size="20" font-family="Manrope" font-weight="300">${loss == null ? '—' : score}</text><text x="42" y="58" text-anchor="middle" style="fill:var(--mute)" font-size="8.5" font-family="Manrope">dust score</text>`;
  const st = s?.state ?? 'measuring', word = !s ? 'waiting' : st === 'dusty' ? 'Dusty' : st === 'getting' ? 'Getting dusty' : st === 'clean' ? 'Clean' : s.resetOn ? 'Clean' : 'measuring';
  $('cleanBadge').outerHTML = badge(st === 'dusty' || st === 'getting' ? 'estimated' : word === 'Clean' ? 'learned' : 'unscored', word, 'id="cleanBadge"');
  $('cleanFig').textContent = loss == null ? '—' : loss < .5 ? 'on par' : `${loss}%${pm(s)}`;
  $('clLoss').textContent = loss == null ? '—' : loss < .5 ? 'on par' : `−${loss}%`;
  $('clRef').textContent = !s ? '—' : s.ref ? `${span(s.ref.from, s.ref.to)}, after the ${s.ref.after === 'cleaning' ? 'cleaning' : s.ref.after === 'rain' ? 'rain' : 'first clear days'}` : `after ${3 - Math.min(2, s.clearSince)} more clear day${3 - s.clearSince === 1 ? '' : 's'}`;
  $('clRain').textContent = !s ? '—' : s.lastRain ? `${s.lastRain.daysAgo === 0 ? 'today' : `${s.lastRain.daysAgo} day${s.lastRain.daysAgo === 1 ? '' : 's'} ago`} · ${Math.round(s.lastRain.mm)} mm` : 'none in 3 months';
  $('clNext').textContent = !s ? '—' : s.nextRain ? `${new Date(`${s.nextRain.day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${Math.round(s.nextRain.mm)} mm` : 'none in the forecast';
  $('clCost').innerHTML = s?.kwhPerDay ? `≈ ${s.kwhPerDay.toFixed(1)} kWh/day · ${S.guest ? veil('$••/mo') : `${s.dollarsPerMonth != null ? `$${s.dollarsPerMonth}` : '—'}/mo`}` : '—';
  const washed = s?.resetBy === 'rain' ? `The ${s.lastRain ? MON3(s.lastRain.day) : ''} rain washed the panels.` : s?.resetBy === 'cleaning' ? `You logged a cleaning on ${MON3(s.resetOn)}.` : '';
  $('cleanTxt').innerHTML = !s ? 'Solstice needs the weather history to compare against; it arrives with the nightly update.'
    : !s.ref ? `${washed} The next ${3 - Math.min(2, s.clearSince)} clear day${3 - s.clearSince === 1 ? '' : 's'} set the new clean level; after that each clear day is compared with it.`
    : loss == null ? `${washed} The clean level is set; a few more clear days and Solstice compares them with it.`
    : st === 'dusty' ? `On clear days the panels are running about <b>${loss}%${pm(s)} below</b> clean${s.kwhPerDay ? `, about ${s.kwhPerDay.toFixed(1)} kWh a day` : ''}. ${s.nextRain ? `About ${Math.round(s.nextRain.mm)} mm of rain is forecast ${new Date(`${s.nextRain.day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })}, which should wash them; if it doesn't come, a rinse` : 'A rinse'} from the ground, early or late in the day, brings it back.`
    : st === 'getting' ? `On clear days the panels are running about <b>${loss}%${pm(s)} below</b> clean. Worth watching; rain of 5 mm or more usually brings it back.`
    : `The panels are producing what they did when clean for the same sunlight. No cleaning needed.`;
  drawCleanChart(s);
}
function drawCleanChart(s) {
  const svg = $('clChart'), key = $('clKey'), pts = s?.points ?? [];
  svg.hidden = key.hidden = !pts.length; if (!pts.length) return;
  const t0 = Date.parse(`${pts[0].day}T12:00:00Z`), t1 = Date.parse(`${localDate()}T12:00:00Z`), span = Math.max(1, (t1 - t0) / 864e5);
  const ys = pts.map(p => p.y), lo = Math.floor(Math.min(...ys, s.ref?.y ?? 99) * 2) / 2 - .5, hi = Math.ceil(Math.max(...ys, s.ref?.y ?? 0) * 2) / 2 + .2;
  const X = d => 26 + (Date.parse(`${d}T12:00:00Z`) - t0) / 864e5 / span * 296, Y = v => 112 - (v - lo) / (hi - lo) * 100;
  let o = '';
  for (let v = Math.ceil(lo); v <= hi; v++) o += `<line x1="26" x2="322" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.06)"/><text x="2" y="${Y(v) + 3}" fill="rgba(242,244,248,.45)" font-size="9" font-family="JetBrains Mono">${v}</text>`;
  for (let d = new Date(t0); d.getTime() <= t1; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDate() === 1) { const iso = d.toISOString().slice(0, 10); o += `<text x="${X(iso)}" y="134" fill="rgba(242,244,248,.45)" font-size="9" font-family="JetBrains Mono">${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</text>`; }
  (s.rains ?? []).filter(r => r.day >= pts[0].day && r.day < localDate()).forEach(r => o += `<rect x="${X(r.day) - 1.5}" y="${112 - Math.min(40, r.mm)}" width="3" height="${Math.min(40, r.mm)}" style="fill:var(--home)" fill-opacity=".7"><title>${md(r.day)}: ${Math.round(r.mm)} mm</title></rect>`);
  if (s.ref) o += `<line x1="${X(s.ref.from)}" x2="${X(pts.at(-1).day > s.ref.to ? pts.at(-1).day : s.ref.to)}" y1="${Y(s.ref.y)}" y2="${Y(s.ref.y)}" style="stroke:var(--batt)" stroke-width="2"/>`;
  pts.forEach(p => o += `<circle cx="${X(p.day)}" cy="${Y(p.y)}" r="3" style="fill:var(--solar)" fill-opacity=".9"><title>${md(p.day)}: ${p.y}</title></circle>`);
  svg.innerHTML = o;
}

export function initPanels(S, roof) {
  loadCleanings(S).then(() => drawPerformance(S)); loadSoiling(S); initPerPanel(S, roof);
  // mockup al frame 10: Output · Per panel · Hour bars is one sliding segment (it was two chips)
  $('roofSeg').onclick = e => { const b = /** @type {Element} */ (e.target).closest('[data-r]'); if (!b || b.getAttribute('aria-disabled') === 'true') return; setRoof(S, roof, b.dataset.r); };
  setRoof(S, roof, 'out');
}
function setRoof(S, roof, mode) {
  segSet($('roofSeg'), mode, 'data-r');
  const bars = mode === 'bars'; S.roofBars = bars; roof?.setBars(bars);
  if ((mode === 'pp') !== ppOn) setOn(mode === 'pp');
  $('roofBarsKey').classList.toggle('on', bars); $('roofOutKey').hidden = mode !== 'out';
}

/** Per-frame roof HUD text (the scene itself lives in scenes/roof.js). */
export function roofHud(S, info, now) {
  const w = S.wx, i = w ? w.hourly.time.indexOf(`${localDate(now)}T${String(new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' })).padStart(2, '0')}:00`) : -1;
  const cc = i >= 0 ? w.hourly.cloud_cover[i] : null, code = i >= 0 ? w.hourly.weather_code[i] : 0, temp = i >= 0 ? w.hourly.temperature_2m[i] : null;
  const hours = roofHours(S.today, w, S.yieldK, localDate(now)), ss = sunSays(hours, localHour(now), S.live?.solarKw);   // mockup p-roof-veil
  S.roofInfo = { el: info.el, az: info.az, inc: info.inc, ss };
  // mockup al frame 10: one glass call-out (component 13 .c-flab): the time and the sun's angle, the output now, then the weather and the model
  const t = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), kw = S.live?.solarKw;
  const head = info.el > 0 ? `${t} · sun hits the panels at ${Math.round(info.inc)}°` : `${t} · sun down`;
  const big = `${kw != null ? kw.toFixed(1) : '—'}<i>kW</i>${ss && !ss.flat ? ` · ${ss.pct}%` : ''}`;
  const say = !ss ? '' : ss.flat ? `<br><span class="x">flat-topping</span> at the microinverters' 9.45 kW` : `<br>sun says ${ss.sunKw.toFixed(1)} kW · panels <span class="x">${ss.panelKw.toFixed(1)} kW</span>`;
  $('roofHud').innerHTML = `<small>${head}</small><b>${big}</b><em>${info.el > 0 ? `${info.el.toFixed(0)}° up, ${info.az.toFixed(0)}° · ` : ''}${WICON(code, info.el > 0)} ${WMO(code)}${cc != null ? ` · ${cc}% cloud` : ''}${temp != null ? ` · ${Math.round(temp)}°` : ''}${say}${ppHud()}</em>`;
  return { cc: cc == null ? .1 : cc / 100, code, hours };
}

/* ================================================================================================================================
 * Per panel (approved mockup u-panels): the Live roof's "Per panel" chip, tint layer, HUD line and pinned readout, and the Panel
 * health card between Performance vs sunlight and Cleaning check. Data: GET /api/pvs/panels (by roof position; guests get it too).
 * ================================================================================================================================ */
let PD = null, layer = null, ppOn = false, phMore = false, selId = null, pendingSel = new URLSearchParams(location.search).get('panel');
const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
const byId = id => PD?.panels.find(p => p.id === id) ?? null;
const pAt = k => { const { row, col } = posOf(k); return byId(`r${row}c${col}`); };
const f = (v, d) => v == null ? '—' : Number(v).toFixed(d);

function initPerPanel(S, roof) {
  layer = roof?.perPanel ?? null;
  if (layer) layer.onPick = k => select(k == null ? null : pAt(k)?.id ?? null);
  $('phBody').addEventListener('click', e => { const t = /** @type {Element} */ (e.target).closest('[data-show]'); if (t) showOnRoof(t.dataset.show); });
  const load = () => api.pvsPanels().then(d => { PD = S.pvs = d; applyPanels(); }).catch(e => { console.warn('pvs/panels', e.message); });
  load(); setInterval(load, 5 * 60_000);
}

/** The HUD's extra line while Per panel is on: "N of 30 reporting · weakest Row r · c at NN%". */
function ppHud() {
  if (!ppOn || !PD) return '';
  const w = PD.now.weakest;
  return `<br><span class="pp">${PD.reporting} of ${PD.layout.expected} reporting${w ? ` · weakest <span class="c">${esc(w.name)}</span> at ${Math.round(w.pct)}%` : ''}</span>`;
}

function setOn(on) {
  ppOn = !!on;
  if (ppOn && $('roofSeg').querySelector('.on')?.dataset.r !== 'pp') { segSet($('roofSeg'), 'pp', 'data-r'); $('roofBarsKey').classList.remove('on'); $('roofOutKey').hidden = true; }
  if (!ppOn && $('roofSeg').querySelector('.on')?.dataset.r === 'pp') { segSet($('roofSeg'), 'out', 'data-r'); $('roofOutKey').hidden = false; }
  $('roofPPKey').classList.toggle('on', ppOn);
  layer?.setOn(ppOn); if (!ppOn) select(null);
}

function applyPanels() {
  const has = !!PD?.panels?.length;
  const b = $('roofPP'), off = !has || PD.sunDown; $('panelHealth').hidden = !has;
  // no per-panel data, or the sun down (array median under 20 W): the segment's Per panel greys out and says so
  b.setAttribute('aria-disabled', String(off)); b.style.opacity = off ? '0.45' : ''; b.querySelector('span').textContent = has && PD.sunDown ? 'sun down' : 'Per panel';
  if (!has) { setOn(false); return; }
  if (PD.sunDown && ppOn && selId == null) setOn(false);
  const ratios = Array(30).fill(null), flags = Array(30).fill(false);
  for (const p of PD.panels) { const k = kIndex(p.row, p.col); ratios[k] = p.pctNow == null ? null : p.pctNow / 100; flags[k] = p.flagged; }
  layer?.setTints(ratios, flags);
  drawHealth();
  if (pendingSel && byId(pendingSel)) { const id = pendingSel; pendingSel = null; showOnRoof(id, false); }
  else if (selId) select(selId);
}

function select(id) {
  const p = id ? byId(id) : null; selId = p ? p.id : null;
  document.querySelectorAll('#phBody .tile.sel').forEach(t => t.classList.remove('sel'));
  if (!p) { layer?.select(null); return; }
  $('phBody').querySelector(`.tile[data-show="${p.id}"]`)?.classList.add('sel');
  layer?.select(kIndex(p.row, p.col)); layer?.setReadout(readout(p));
}

/** Tile or "Show on the Live roof": Per panel on, scroll up to the roof, that panel selected (frame 2). */
function showOnRoof(id, smooth = true) {
  if (!ppOn) setOn(true);
  select(id);
  const sc = $('screen'), roofEl = $('roof');
  if (sc && roofEl && $('v-sys')?.classList.contains('on') && !$('sp-solar').hidden) sc.scrollTo({ top: roofEl.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 60, behavior: smooth ? 'smooth' : 'auto' });
}

/** The Chicago UTC offset at an instant, as "-05:00". */
function offset(ms) { const n = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'longOffset' }).formatToParts(new Date(ms)).find(x => x.type === 'timeZoneName').value.replace('GMT', ''); return n || '+00:00'; }

/** The pinned readout (frame 2): name, age, AC and DC kW now, heat sink, kWh today, share, and today's 5-minute sparkline vs the median panel. */
function readout(p) {
  const stale = p.ageS != null && p.ageS > 900;
  const ag = p.at == null ? 'no reading today' : stale ? `${f(p.kw, 2)} kW · ${Math.round(p.ageS / 60)} min ago` : `now · ${clock(Date.parse(p.at))}`;
  // sparkline: the day's producing window (first to last 5-minute bucket with the median panel above zero), in whole hours
  const T = PD.times, M = PD.medianSeries, on = M.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
  const mid0 = T.length ? Date.parse(`${PD.date}T00:00:00${offset(T[0])}`) : 0, hr = t => (t - mid0) / 36e5;
  const h0 = on.length ? Math.floor(hr(T[on[0]])) : 7, h1 = on.length ? Math.max(h0 + 12, Math.ceil(hr(T[on.at(-1)] + 3e5))) : 19;   // the whole producing day, even at 2 PM
  const W = 118, Hh = 50, top = Math.max(.05, ...M.filter(v => v != null), ...p.spark.filter(v => v != null)) * 1.1;
  const x = t => ((hr(t) - h0) / (h1 - h0) * W).toFixed(1), y = v => (Hh - 2 - v / top * (Hh - 4)).toFixed(1);
  const line = s => { let d = '', pen = false; s.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(T[i])} ${y(v)}`; pen = true; }); return d; };
  const nowX = PD.today ? x(Date.parse(PD.at)) : null, mid = Math.round((h0 + h1) / 2);
  return `<div class="rh"><b>${esc(p.name)}</b><span class="ag">${ag}</span><button data-x="1" aria-label="Close">✕</button></div>
    <div class="rb"><div class="rg"><span>AC out</span><b>${f(p.kw, 3)} kW${p.pctNow != null ? ` <em>${Math.round(p.pctNow)}%</em>` : ''}</b>
      <span>DC in</span><b>${f(p.kwDc, 3)} kW</b>
      <span>Heat sink</span><b>${f(p.tempC, 0)} °C</b>
      <span>Today</span><b>${f(p.kwh, 2)} kWh</b>
      <span>Share</span><b>${f(p.sharePct, 1)}% <em>of array</em></b></div>
    <div><svg class="sp" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none"><path d="${line(M)}" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>
      <path d="${line(p.spark)}" fill="none" stroke="#ffc15e" stroke-width="1.5" vector-effect="non-scaling-stroke"/>${nowX != null && +nowX <= W ? `<line x1="${nowX}" x2="${nowX}" y1="0" y2="${Hh}" stroke="rgba(255,255,255,.25)" vector-effect="non-scaling-stroke"/>` : ''}</svg>
    <div class="sx"><span>${hourLabel(h0)}</span><span>${hourLabel(mid)}</span><span>${hourLabel(h1)}</span></div><div class="sk"><i></i>panel <i class="d"></i>median</div></div></div>`;
}

/** The Panel health card (frames 3 and 4). */
function drawHealth() {
  const el = $('phBody'), D = PD, flagged = D.anomalies ?? [], miss = D.notReporting ?? [];
  const med = D.totals.medianKwh, time = clock(Date.parse(D.at)), exp = D.layout.expected;
  const sub = flagged.length ? `today · ${niceDate(D.date)}, ${time} · ${D.reporting} of ${exp} reporting` : `today · ${time}`;
  let rows = '';
  for (let row = 1; row <= 3; row++) {
    rows += `<div class="rn">${row}</div><div class="tr">`;
    for (let col = 1; col <= 10; col++) {
      const id = `r${row}c${col}`, p = byId(id);
      if (!p || !p.reporting) { rows += `<button class="tile miss" data-show="${id}" title="Row ${row} · ${col} · not reporting">—</button>`; continue; }
      const r = p.pctToday == null ? null : p.pctToday / 100;
      rows += `<button class="tile${p.flagged ? ' flag' : ''}" data-show="${id}" style="${p.flagged ? '' : tileStyle(r)}" title="${esc(p.name)} · ${f(p.kwh, 2)} kWh${r != null ? ` · ${Math.round(r * 100)}% of median` : ''}">${f(p.kwh, 2)}</button>`;
    }
    rows += '</div>';
  }
  const loRow = (x, i) => { const p = byId(x.id), r = x.pct / 100, red = p?.flagged, t = tint(r);
    return `<div class="lo${i ? '' : ' first'}"><span class="nm">${esc(x.name)}</span><span class="bar"><i style="width:${Math.min(100, r / 1.1 * 100)}%;background:${red ? 'var(--out)' : t?.side ? rgba(t.rgb, 1) : 'rgba(242,244,248,.45)'}"></i><s style="left:${100 / 1.1}%"></s></span>
      <span class="kw">${f(x.kwh, 2)} kWh</span><span class="df${red ? ' r' : ''}">${deficit(x.pct)}</span></div>`; };
  const flagHtml = a => { const p = byId(a.id), al = D.alerts?.[a.kind];
    const conv = p?.kw != null && p?.kwDc > .01 ? Math.round(p.kw / p.kwDc * 100) : null;
    // the last 7 days as the mockup shows them: the nightly's producing days, ending with today's share so far
    const today = { day: D.date, pct: Math.round(p?.pctToday ?? NaN), label: `${niceDate(D.date, { weekday: 'short' }).slice(0, 2)} ${+D.date.slice(8)}` };
    const shown = D.today && p?.pctToday != null && a.days.at(-1)?.day !== D.date ? [...a.days.slice(-6), today] : a.days;
    return `<div class="flagbox"><div class="ft"><b>${esc(a.name)}</b><span>${p?.pctToday != null ? `${Math.round(p.pctToday)}%` : '—'}</span></div>
      <p>Consistently low for ${shown.filter(d => d.pct < 85).length} days: shade, soiling or a failing microinverter.</p>
      <div class="d7">${shown.map(d => `<div class="${d.pct < 85 ? 'l' : ''}">${esc(d.pct)}<small>${esc(d.label ?? niceDate(d.day))}</small></div>`).join('')}</div>
      <div class="kv">
        <span>Today</span><b>${f(p?.kwh, 2)} kWh · median ${f(med, 2)}</b>
        ${!D.sunDown && p?.kw != null ? `<span>Now, DC in → AC</span><b>${f(p.kwDc, 3)} → ${f(p.kw, 3)} kW</b>
        <span>Median DC in</span><b>${f(D.now.medianKwDc, 3)} kW</b>
        <span>Conversion</span><b>${conv ?? '—'}% · others ${D.now.medianConvPct != null ? Math.round(D.now.medianConvPct) : '—'}%</b>` : ''}
        <span>Flagged</span><b>${niceDate(a.day)}${al ? ` · ${al.pushed ? 'push sent' : 'in the feed'}` : ''}</b>
      </div>
      ${a.diag ? `<p class="why"><b>${esc(a.diag.lead)}</b>${esc(a.diag.text)}</p>` : ''}
      <button class="link" style="margin-top:10px" data-show="${esc(a.id)}">Show on the Live roof</button></div>`; };
  const nrHtml = D.relay.silent
    ? `<div class="nr"><i></i><div><b>Relay last heard ${clock(Date.parse(D.relay.heardAt ?? D.relay.lastPoll))}</b><small>No per-panel readings for ${D.relay.silentMin ?? Math.round(D.relay.ageS / 60)} min of daylight. ${esc(D.relay.note ?? 'The Mac running the PVS relay may be asleep or off the network')}; no single panel is to blame.</small></div></div>`
    : miss.map(m => { const due = m.pushAt && Date.parse(m.pushAt) > Date.parse(D.at);
      return `<div class="nr"><i></i><div><b>${esc(m.name)} · no reading for ${m.silentMin} min</b><small>${m.at ? `Last seen ${clock(Date.parse(m.at))} at ${f(m.lastKw, 2)} kW, with ${f(m.kwh, 2)} kWh so far. ` : 'No reading today. '}Its neighbours are still producing, so this is the panel's microinverter or its link to the PVS, not the relay.${m.pushAt ? (due ? ` If it is still silent at ${clock(Date.parse(m.pushAt))}, a Panel fault push goes out.` : ` A Panel fault push went out at ${clock(Date.parse(m.pushAt))}.`) : ''}</small></div></div>`; }).join('');
  // mockup al frame 10: a disclosure. Header: the flags badge and "reporting / expected"; one line: the spread; opened: the grid, any
  // flagged panel, then "Lowest three" opens the rest (the totals, the lowest three, silent panels, the source line)
  $('phBadge').innerHTML = flagged.length ? badge('estimated', `${flagged.length} to check`) : badge('learned', 'no flags');
  $('phFig').textContent = `${D.reporting} / ${exp}`;
  $('phSum').textContent = D.totals.spread ? `Array today: spread ${Math.round(D.totals.spread.loPct)}%–${Math.round(D.totals.spread.hiPct)}% of the panel average` : sub;
  el.innerHTML = `${flagged.length ? `<p class="c-fine" style="margin-top:0">${sub}</p>` : ''}
    <div class="gridw"><span></span><div class="edge"><span>ridge</span><span>kWh today</span></div>${rows}<div class="cn">${Array.from({ length: 10 }, (_, i) => `<span>${i + 1}</span>`).join('')}</div>
      <span></span><div class="edge"><span>eave · north</span><span>south</span></div></div>
    <div class="legend"><span>vs median panel</span><span>−15%</span><span class="dramp"></span><span>+10%</span>${D.panels.some(p => !p.reporting) ? '<span><i class="hx"></i>no reading</span>' : ''}${flagged.length ? '<span><i class="rx"></i>flagged</span>' : ''}</div>
    ${flagged.map(flagHtml).join('')}
    <div class="c-btns"><button class="c-btn line block" id="phMore" aria-expanded="${phMore}">${phMore ? 'Fewer details' : 'Lowest three'}</button></div>
    <div id="phMoreBody"${phMore ? '' : ' hidden'}>
    <div class="c-kv">
      <span>Array today · ${D.reporting} of ${exp}</span><b>${f(D.totals.kwh, 1)} kWh</b>
      <span>Median panel</span><b>${f(med, 2)} kWh</b>
      <span>Spread, lowest → highest</span><b>${D.totals.spread ? `${Math.round(D.totals.spread.loPct)}% → ${Math.round(D.totals.spread.hiPct)}%` : '—'}</b>
      <span>Hottest heat sink today</span><b>${D.totals.hottest ? `${esc(D.totals.hottest.name)} · ${Math.round(D.totals.hottest.tempC)} °C` : '—'}</b>
    </div>
    <div class="sub">Lowest three</div>${D.lowest.map(loRow).join('')}
    ${nrHtml}
    <p class="c-fine">${D.since ? `Since ${niceDate(D.since)} · per-panel data starts the day the PVS relay was installed (${D.days} day${D.days === 1 ? '' : 's'} so far). ` : ''}Tap a tile to find it on the Live roof.</p></div>`;
  $('phMore').onclick = () => { phMore = !phMore; drawHealth(); };
  if (selId) el.querySelector(`.tile[data-show="${selId}"]`)?.classList.add('sel');
}
