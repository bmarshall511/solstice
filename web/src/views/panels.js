import { $, niceDate, localDate, svgText, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { WMO, WICON } from '../lib/weather.js';

let cleanings = [];
const cleanedOn = () => cleanings[0]?.day ?? null;
async function loadCleanings(S) { cleanings = (await api.events().catch(() => [])).filter(e => e.type === 'cleaned'); drawCleanLog(S); }
function drawCleanLog(S) {
  const last = cleanings[0];
  $('cleaned').outerHTML = last
    ? `<div id="cleaned" class="kv" style="margin-top:12px"><span>Last cleaning logged</span><b>${niceDate(last.day, { month: 'short', day: 'numeric' })} <button class="link" id="undoClean" style="margin:0 0 0 8px;padding:4px 10px">Undo</button></b></div>`
    : `<button class="link" id="cleaned">✓ I cleaned the panels</button>`;
  if (last) $('undoClean').onclick = async () => { await api.deleteEvent(last.id); toast('↺', 'rgba(255,255,255,.12)', 'Cleaning removed', `The ${niceDate(last.day)} entry is gone.`); await loadCleanings(S); drawPerformance(S); };
  else $('cleaned').onclick = async () => { await api.addEvent('cleaned', localDate()); toast('✓', 'rgba(78,240,166,.2)', 'Cleaning logged', 'Solstice will compare the next sunny days against last year. Tap Undo if that was a mistake.'); await loadCleanings(S); drawPerformance(S); };
}

/** Daily solar vs what the day's sunlight should give (baseline yield learned from the same season last year). */
export function drawPerformance(S) {
  const K = S.baselineK ?? S.yieldK; if (!K || !S.daily || !S.gtiByDate) return;
  const rows = S.daily.filter(d => d.date < localDate() && S.gtiByDate[d.date] != null).slice(-30);
  if (!rows.length) return;
  const exp = r => K * S.gtiByDate[r.date], mx = Math.max(...rows.map(r => Math.max(r.solar, exp(r)))) * 1.08, bw = 290 / rows.length;
  let o = '';
  rows.forEach((r, i) => { const x = 14 + i * bw, h1 = r.solar / mx * 110, h2 = exp(r) / mx * 110, ratio = r.solar / exp(r), low = S.gtiByDate[r.date] > 2.5 && ratio < .9;
    o += `<rect x="${x}" y="${120 - h2}" width="${bw - 2}" height="${h2}" rx="2" fill="rgba(255,255,255,.12)"/><rect x="${x + 1}" y="${120 - h1}" width="${bw - 4}" height="${h1}" rx="2" fill="${low ? '#ff7a66' : '#ffc15e'}"><title>${r.date}: ${r.solar.toFixed(1)} kWh · expected ${exp(r).toFixed(1)} (${Math.round(ratio * 100)}%)</title></rect>`;
    if (i % 7 === 0) o += svgText(x + bw / 2, 136, niceDate(r.date), { anchor: 'middle', size: 9 }); });
  $('prChart').innerHTML = o;
  const clear = rows.filter(r => S.gtiByDate[r.date] > 4.5), ratio = clear.length ? clear.reduce((a, r) => a + r.solar / exp(r), 0) / clear.length : null;
  $('prTxt').innerHTML = ratio == null ? 'Not enough clear days yet to judge performance.'
    : `On clear days over the last month, the panels made <b style="color:var(--text)">${Math.round(ratio * 100)}%</b> of what the same sunlight produced this time last year. ${ratio >= .95 ? "That's healthy, with no sign of lost output." : ratio >= .9 ? 'A little low. Worth watching.' : 'Noticeably low. Check the cleaning card below.'}`;
  drawWarranty(S);
  drawCleaning(S, rows, exp);
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

function drawCleaning(S, rows, exp) {
  const cleaned = cleanedOn(), after = cleaned ? rows.filter(r => r.date > cleaned) : rows;
  const clear = after.filter(r => S.gtiByDate[r.date] > 4.5).slice(-7);
  const ratio = clear.length ? clear.reduce((a, r) => a + r.solar / exp(r), 0) / clear.length : null;
  const loss = ratio == null ? null : Math.max(0, 1 - ratio), score = loss == null ? 0 : Math.round(Math.min(100, loss / .15 * 100));
  const r = 34, C = 2 * Math.PI * r, col = score > 60 ? '#ff7a66' : score > 35 ? '#ffc15e' : '#4ef0a6';
  $('cleanRing').innerHTML = `<circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7"/><circle cx="42" cy="42" r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C * score / 100} ${C}" transform="rotate(-90 42 42)"/>
    <text x="42" y="44" text-anchor="middle" fill="#f2f4f8" font-size="20" font-family="Manrope" font-weight="300">${loss == null ? '—' : score}</text><text x="42" y="58" text-anchor="middle" fill="rgba(242,244,248,.5)" font-size="8.5" font-family="Manrope">dust score</text>`;
  $('cleanBadge').textContent = loss == null ? 'waiting' : score > 60 ? 'Likely dusty' : score > 35 ? 'Getting dusty' : 'Clean';
  $('cleanBadge').className = 'badge' + (score > 35 ? '' : ' g');
  $('clLoss').textContent = loss == null ? '—' : loss < .02 ? 'on par' : `−${Math.round(loss * 100)}%`;
  const avgSolar = rows.slice(-14).reduce((a, r) => a + r.solar, 0) / Math.min(14, rows.length), lostKwh = loss ? avgSolar * loss / (1 - loss) : 0;
  $('clCost').textContent = loss ? `≈ ${lostKwh.toFixed(1)} kWh/day · $${(lostKwh * 30 * (S.tariff?.importRateAllIn ?? .1064)).toFixed(0)}/mo` : '—';
  const w = S.wx, today = localDate();
  if (w) { const t = w.daily.time, p = w.daily.precipitation_sum, pp = w.daily.precipitation_probability_max, ti = t.indexOf(today);
    let li = -1; for (let i = ti - 1; i >= 0; i--) if ((p[i] ?? 0) >= 2) { li = i; break; }
    let ni = -1; for (let i = ti; i < t.length; i++) if ((pp[i] ?? 0) >= 50) { ni = i; break; }
    $('clRain').textContent = li < 0 ? '30+ days ago' : `${ti - li} days ago · ${p[li].toFixed(0)} mm`;
    $('clNext').textContent = ni < 0 ? 'none in the forecast' : `${niceDate(t[ni], { weekday: 'short', month: 'short', day: 'numeric' })} · ${pp[ni]}%`; }
  $('cleanTxt').innerHTML = loss == null ? 'Solstice needs a few clear days to compare against.'
    : cleaned && after.length < 3 ? `You logged a cleaning on ${niceDate(cleaned)}. Solstice is measuring the next few sunny days against last year's baseline.`
    : score > 35 ? `On clear days the panels are running about <b style="color:var(--text)">${Math.round(loss * 100)}% below</b> last year's output for the same sunlight. When the loss is spread evenly across days like this, it's usually dust or pollen.`
    : `The panels are producing what last year's baseline says they should for this much sunlight. No cleaning needed.`;
}

export function initPanels(S) { loadCleanings(S).then(() => drawPerformance(S)); }

/** Per-frame roof HUD text (the scene itself lives in scenes/roof.js). */
export function roofHud(S, info, now) {
  const w = S.wx, i = w ? w.hourly.time.indexOf(`${localDate(now)}T${String(new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' })).padStart(2, '0')}:00`) : -1;
  const cc = i >= 0 ? w.hourly.cloud_cover[i] : null, code = i >= 0 ? w.hourly.weather_code[i] : 0, temp = i >= 0 ? w.hourly.temperature_2m[i] : null;
  $('roofHud').innerHTML = `${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${info.el > 0 ? `☀ ${info.el.toFixed(0)}° up, ${info.az.toFixed(0)}°` : '☾ sun down'}<br>${WICON(code, info.el > 0)} ${WMO(code)}${cc != null ? ` · ${cc}% cloud` : ''}${temp != null ? ` · ${Math.round(temp)}°` : ''}${info.el > 0 ? `<br>sun hits the panels at ${Math.round(info.inc)}°` : ''}`;
  return { cc: cc == null ? .1 : cc / 100, code };
}
