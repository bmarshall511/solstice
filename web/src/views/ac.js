import { $, niceDate, localDate, localHour } from '../lib/util.js';
import { api } from '../lib/api.js';
import { every, stop } from '../lib/poll.js';
import { createThermalTwin } from '../scenes/thermaltwin.js';
import { nameStart } from '../lib/frost.js';
import { cBadge, badge, esc } from '../lib/conf.js';
import { when } from '../lib/presence.js';
import { gauge } from '../lib/sysui.js';
import { icon } from '../lib/icons.js';
import { nowPct, acBlocks, autopilotStage } from '../lib/nowui.js';
import { sysTop, planStrip, tileHtml, modePill, seg, segSet, sheet, sheetHead, sheetFoot, closeSheet } from './csheet.js';
import { mountAcPanel, redrawAcPanels } from './nowsheets.js';
import { stripCardHtml, stripShows } from '../lib/stripui.js';

/*
 * Systems › AC (approved mockup al frames 13, 13b): the live card over the thermal twin with today's scrubber, four tiles, the Thermostat
 * card (the AC sheet's component in place, views/nowsheets.js), the AC Autopilot disclosure (Nest vs Solstice, Today's plan, Why, Rules,
 * Log) and the Nest link. Writes are staged and go only through the routes that already existed.
 */
let twin = null, scrubT = null, panel = null, play = null;
export const thermalTwin = () => twin;
/** Leaving the AC page: free its WebGL context (main.js); the next draw while it is visible builds a new one. */
export function releaseThermalTwin() { twin?.dispose(); twin = null; stopPlay(); }
const hm = h => `${Math.floor(h) % 12 || 12}${h % 1 ? ':' + String(Math.round((h % 1) * 60)).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`;
const hm12 = h => `${Math.floor(h) % 12 || 12}${h % 1 ? ':' + String(Math.round(h % 1 * 60)).padStart(2, '0') : ''} ${h % 24 < 12 ? 'AM' : 'PM'}`;
const MODE_CLS = { auto: 'auto', suggest: 'suggest', off: 'off' };

/** A simple indoor model for the scrubber: the house drifts toward outdoor at ~0.6°F/h per 10°F difference, the AC pulls it to the setpoint. */
function simulateDay(d, outdoor) {
  const st = d.state, steps = d.plan.steps, sp = h => [...steps].reverse().find(s => s.hour <= h)?.coolF ?? st?.coolF ?? 75;
  const out = []; let T = st?.indoorF ?? 75;
  for (let h = 0; h <= 24; h += .25) { const o = outdoor[Math.min(23, Math.floor(h))] ?? 90, set = sp(h); const drift = (o - T) * .06 * .25; T += drift; const cooling = T > set + .3; if (cooling) T = Math.max(set, T - .9 * .25); out.push({ h, T: Math.round(T * 10) / 10, set, cooling, o }); }
  return out;
}
const stopPlay = () => { clearInterval(play); play = null; $('acPlay')?.classList.remove('playing'); };
export function drawAc(S) {
  const d = S.ac; if (!d) return;
  const linked = d.linked, st = d.state;
  $('acLink').hidden = linked; $('acAuto').hidden = !linked || !d.plan;
  drawAcSys(S);
  if (!S.guest && !panel && $('acPanel')) panel = mountAcPanel(S, $('acPanel')); else redrawAcPanels();   // the AC sheet's component, in place
  drawThermostat(S);
  drawStrip(S);
  if (!d.plan) return;
  if (!twin && $('acTwin').offsetParent) twin = createThermalTwin($('acTwin'));   // only while it can be seen
  const wx = S.wx, today = localDate(), outdoor = Array(24).fill(d.outdoorF ?? 90);
  if (wx) wx.hourly.time.forEach((t, i) => { if (t.startsWith(today)) outdoor[+t.slice(11, 13)] = wx.hourly.temperature_2m[i]; });
  const sunH = Array(24).fill(0); if (wx) { const pk = Math.max(1, ...wx.hourly.global_tilted_irradiance); wx.hourly.time.forEach((t, i) => { if (t.startsWith(today)) sunH[+t.slice(11, 13)] = (wx.hourly.global_tilted_irradiance[i] ?? 0) / pk; }); }
  const sim = simulateDay(d, outdoor), now = localHour();
  const show = h => { const live = h == null; const hh = live ? now : h; const p = sim.reduce((a, x) => Math.abs(x.h - hh) < Math.abs(a.h - hh) ? x : a);
    const cooling = live && st ? st.hvac === 'COOLING' : p.cooling, heating = live && st ? st.hvac === 'HEATING' : false;
    twin?.set({ indoorF: live && st?.indoorF != null ? st.indoorF : p.T, sun: sunH[Math.min(23, Math.floor(hh))], cooling, heating });
    const phase = d.plan.precool && hh >= d.plan.precoolFrom && hh < d.plan.precoolTo ? ' · pre-cool' : d.plan.precool && hh >= d.plan.coastFrom && hh < d.plan.coastTo ? ' · coast' : '';
    $('acHud').textContent = `${cooling ? `Cooling · ${d.learned.acKw.toFixed(1)} kW` : heating ? 'Heating' : 'Idle'} · set ${live && st?.coolF != null ? st.coolF : p.set}°${phase}`;
    $('acLab').innerHTML = `indoor ${(live && st?.indoorF != null ? st.indoorF : p.T).toFixed(1)}°<br>outdoor ${Math.round(p.o)}°<br>sun ${Math.round(sunH[Math.min(23, Math.floor(hh))] * 100)}%`;
    $('acScrubT').textContent = live ? new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : hm12(Math.round(hh * 4) / 4); };
  const sc = $('acScrub'); if (scrubT == null) sc.value = now;
  sc.oninput = () => { stopPlay(); scrubT = +sc.value; show(Math.abs(scrubT - now) < .2 ? null : scrubT); }; show(scrubT == null || Math.abs(scrubT - now) < .2 ? null : scrubT);
  // ▶ plays today's plan from midnight to midnight in about eight seconds (calm: steps through it), then returns to now
  $('acPlay').onclick = () => { if (play) { stopPlay(); scrubT = null; sc.value = now; return show(null); }
    $('acPlay').classList.add('playing'); let h = 0;
    play = setInterval(() => { h += S.calm ? 1 : .25; if (h > 24) { stopPlay(); scrubT = null; sc.value = now; return show(null); } scrubT = h; sc.value = h; show(h); }, S.calm ? 330 : 80); };
  drawAcTiles(S);
  const source = d.learned.source ?? (d.learned.coolKw != null ? 'measured' : 'estimated');   // a guest's copy leaves out `source`; the server's own rule
  $('acNote').innerHTML = `${esc(d.equipment.airHandler)} · ${esc(d.equipment.heat)} · ${esc(d.equipment.outdoor)}. AC power is ${source === 'measured' ? 'measured from the step in Tesla’s home load when Nest starts and stops cooling' : 'estimated from your heat model until Nest has been sampled for a few days'}.${d.error ? ` <span style="color:var(--warn)">Last read failed: ${esc(d.error)}</span>` : ''}`;
  if (!linked) { $('acLinkBtn').href = '/auth/google'; $('acLinkTxt').textContent = d.configured ? 'Sign in with Google and share the thermostat with Solstice.' : 'Google Device Access is not configured yet (NEST_PROJECT_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).'; return; }
  drawPlan(S, sim, outdoor, sunH); drawAuto(S);
}
/** The AC system card: Autopilot's mode, inside now, the setpoint and humidity, the comfort band and Solstice's writes on the strip. */
function drawAcSys(S) {
  const d = S.ac, st = d.state, s = d.settings ?? {};
  if (!d.linked || !st) { $('acSys').innerHTML = sysTop({ ic: 'ac', title: 'AC', value: '—', line: d.configured === false ? 'Nest not set up' : 'Nest not linked', plan: planStrip(nowPct(localHour()), [], [], true) }); return; }
  const mode = st.eco ? 'ECO' : st.mode, deg = v => (v == null ? null : Math.round(v)), cf = deg(st.coolF), hf = deg(st.heatF);
  // a guest gets no thermostat setpoint (only the plan's step, S-03), so a missing one reads as the mode alone, never "0°"
  const verb = { COOL: cf != null ? `Cool to ${cf}°` : 'Cooling', HEAT: hf != null ? `Heat to ${hf}°` : 'Heating', HEATCOOL: hf != null && cf != null ? `${hf}–${cf}°` : cf != null ? `Cool to ${cf}°` : 'Heat · Cool', OFF: 'Thermostat off', ECO: 'Eco · Away' }[mode] ?? mode;
  const hv = String(st.hvac ?? 'off').toLowerCase(), ab = s.autopilot === 'off' ? { blocks: [], ticks: [] } : acBlocks(d.plan?.steps, s.nightFrom, s.nightTo);
  $('acSys').innerHTML = sysTop({ ic: 'ac', title: 'AC', mode: modePill(MODE_CLS[s.autopilot]), value: st.indoorF != null ? `${st.indoorF}°` : '—',
    line: `${verb} · ${hv === 'off' ? 'idle' : hv}${st.humidity != null ? ` · ${st.humidity}% humidity` : ''}`, plan: planStrip(nowPct(localHour()), ab.blocks, ab.ticks, true) });
}
/** AC today, run time, the AC's draw (measured or estimated) and indoor; today's hours from /api/appliances/day for the sparklines. */
function drawAcTiles(S) {
  const d = S.ac, st = d.state, rt = d.runtime ?? { minutes: 0, duty: null }, A = S.applDay?.date === localDate() ? S.applDay : null;
  const hours = (A?.hours ?? []).filter(h => h.hour <= localHour()), source = d.learned.source ?? (d.learned.coolKw != null ? 'measured' : 'estimated');
  $('acTiles').innerHTML = tileHtml({ id: 'aTileE', acc: 'c-acc-ac', k: 'AC today', v: d.todayKwh ?? '—', unit: 'kWh', chip: d.shareOfHomePct != null ? { t: 'flat', text: `${d.shareOfHomePct}% of home` } : null, spark: hours.map(h => h.ac?.kwh ?? 0) })
    + tileHtml({ id: 'aTileR', acc: 'c-acc-ac', k: 'Run time', v: `${Math.floor(rt.minutes / 60)}h ${rt.minutes % 60}m`, chip: rt.duty != null ? { t: 'flat', text: `${rt.duty}% duty` } : null, spark: hours.map(h => h.ac?.on ? 1 : 0) })
    + tileHtml({ id: 'aTileD', acc: 'c-acc-ac', k: 'AC draw', badge: cBadge(source), v: d.learned.acKw.toFixed(1), unit: 'kW', chip: d.learned.samples ? { t: 'flat', text: `${d.learned.samples} steps` } : null })
    + tileHtml({ id: 'aTileI', acc: 'c-acc-home', k: 'Indoor', v: st?.indoorF != null ? `${st.indoorF}°` : '—', chip: st?.humidity != null ? { t: 'flat', text: `${st.humidity}% humidity` } : null, spark: hours.map(h => h.ac?.indoorF ?? null) });
}

/* ---------- AC Autopilot: today's chart with direct labels, the plan's steps and figures, why, the mode (staged) ---------- */
function drawPlan(S, sim, outdoor, sunH) {
  const d = S.ac, P = d.plan, st = d.state, svg = $('acComfort'), X = h => h / 24 * 303, lo = Math.min(66, ...outdoor) - 2, hi = Math.max(100, ...outdoor) + 2, Y = t => 128 - (t - lo) / (hi - lo) * 112;
  const nest = st?.coolF ?? 75, plan = h => [...P.steps].reverse().find(s => s.hour <= h)?.coolF ?? nest;
  const step = (f, style, extra = '') => { let p = ''; for (let h = 0; h < 24; h++) p += `${h ? 'L' : 'M'}${X(h).toFixed(1)} ${Y(f(h)).toFixed(1)} L${X(h + 1).toFixed(1)} ${Y(f(h)).toFixed(1)} `; return `<path d="${p}" fill="none" style="${style}" ${extra}/>`; };
  let o = `<defs><linearGradient id="acsg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--solar);stop-opacity:.35"/><stop offset="1" style="stop-color:var(--solar);stop-opacity:0"/></linearGradient></defs>`;
  o += `<path d="M${X(0)},128 ${sunH.map((v, h) => `L${X(h).toFixed(1)},${(128 - v * 70).toFixed(1)}`).join(' ')} L${X(24)},128 Z" fill="url(#acsg)"/>`;
  if (P.precool) o += `<rect x="${X(P.precoolFrom)}" y="14" width="${X(P.precoolTo) - X(P.precoolFrom)}" height="114" style="fill:var(--batt)" fill-opacity=".07"/><text x="${X((P.precoolFrom + P.precoolTo) / 2)}" y="24" text-anchor="middle" style="fill:var(--batt)">pre-cool</text><rect x="${X(P.coastFrom)}" y="14" width="${X(P.coastTo) - X(P.coastFrom)}" height="114" style="fill:var(--home)" fill-opacity=".06"/><text x="${X((P.coastFrom + P.coastTo) / 2)}" y="24" text-anchor="middle" class="d">coast</text>`;
  o += `<polyline points="${outdoor.map((v, h) => `${X(h).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}" fill="none" style="stroke:var(--ac)" stroke-width="2" stroke-linecap="round"/>`
    + step(() => nest, 'stroke:var(--home)', 'stroke-width="1.6" stroke-dasharray="4 3"') + step(plan, 'stroke:var(--batt)', 'stroke-width="2.2" stroke-linecap="round"')
    + `<polyline points="${sim.map(p => `${X(p.h).toFixed(1)},${Y(p.T).toFixed(1)}`).join(' ')}" fill="none" style="stroke:var(--text)" stroke-width="1.8" stroke-linecap="round"/>`;
  const nx = X(localHour()), hiH = outdoor.indexOf(Math.max(...outdoor)), lab = (x, y, t, style, cls = '') => `<text x="${Math.max(2, Math.min(301, x)).toFixed(0)}" y="${y.toFixed(0)}"${cls ? ` class="${cls}"` : ''}${style ? ` style="${style}"` : ''}${x > 240 ? ' text-anchor="end"' : ''}>${t}</text>`;
  o += `<line x1="${nx}" y1="0" x2="${nx}" y2="128" style="stroke:var(--text)" stroke-opacity=".4" stroke-dasharray="2 3"/>` + lab(nx + 4, 10, 'now', '', 'v')
    + lab(X(hiH), Math.max(12, Y(Math.max(...outdoor)) - 6), `outdoor ${Math.round(Math.max(...outdoor))}°`, 'fill:var(--ac)')
    + lab(4, Math.max(12, Y(plan(1)) - 8), `Solstice ${plan(localHour())}°`, 'fill:var(--batt)') + lab(4, Math.min(124, Y(nest) + 14), 'Nest', 'fill:var(--home)')
    + lab(236, Math.min(124, Y(sim.at(-12)?.T ?? nest) + 14), 'indoor', '', 'd') + lab(X(13), 120, 'solar', 'fill:var(--solar)')
    + '<text x="0" y="146">12a</text><text x="152" y="146" text-anchor="middle">12p</text><text x="303" y="146" text-anchor="end">12a</text>';
  svg.innerHTML = o;
  // Today's plan: the steps on a line, then the plan's figures (r-learning: the two kWh with their confidence badges)
  $('acPlanLine').textContent = `${P.steps.length} write${P.steps.length === 1 ? '' : 's'}${P.precool ? ' · pre-cool day' : ''}`;
  $('acSteps').innerHTML = P.steps.map(s => `<div title="${esc(s.why)}"><i></i><time>${hm12(s.hour).replace(':00', '')}</time><b>${s.coolF}°</b></div>`).join('');
  const sv = (label, v, tier) => `<div><b>${v == null ? '—' : `${Number(v).toFixed(1)}`}</b><span>${label}</span>${cBadge(tier) && `<span style="margin-top:5px">${cBadge(tier)}</span>`}</div>`;
  $('acDeltas').innerHTML = sv('kWh shifted onto solar', P.shiftedKwh, P.conf?.shiftedKwh) + sv('evening kWh avoided', P.eveningAvoidedKwh, P.conf?.eveningAvoidedKwh)
    + `<div><b>${Math.round(P.high)}°</b><span>${Number(P.sunKwhM2).toFixed(1)} kWh/m² sun · ${P.precool ? 'pre-cool day' : 'hold the band'}</span></div><div><b>${Math.max(...P.steps.map(s => s.coolF))}°</b><span>warmest indoor · ${P.precool ? `${hm(P.coastFrom)}–${hm(P.coastTo)}` : 'all day'}</span></div>`;
  $('acActions').innerHTML = S.guest ? `<p class="c-fine" style="text-align:center">${nameStart(S.ownerName)} approves changes from their own devices.</p>`
    : d.applied?.approved ? `<p class="c-fine">Today's plan is approved: Solstice sets each step at its hour${d.applied.lastStepHour != null ? ` (last step ${hm(d.applied.lastStepHour)})` : ''}.</p>`
    : `<div class="c-btns"><button class="c-btn pri c-acc-batt block" id="acApply">Apply today’s plan to Nest</button></div><p class="c-fine">Suggest mode: the plan waits for you. Each step’s reason is on its time above.</p>`;
  const apply = $('acApply'); if (apply) apply.onclick = async () => { if (!confirm(`Let Solstice set the thermostat through today?\n\n${P.steps.map(s => `• ${hm(s.hour)}: ${s.coolF}° (${s.why})`).join('\n')}\n\nOnly the cooling setpoint changes, never outside ${d.settings.band.homeLo}–${Math.max(d.settings.band.homeHi, d.settings.awayF)}°, at most ${d.settings.maxStepF}° per step. Mark Away or change the mode in the Nest app at any time.`)) return; apply.textContent = 'Applying…'; try { await api.acApply(); await loadAc(S); } catch (e) { alert(e.message); apply.textContent = 'Apply today’s plan to Nest'; } };
  // Why: the reasons as a list (they were a sideways carousel), after the signals and the week
  const why = P.why.map((w, i) => [i === 0 ? 'Today' : 'Also', `${esc(w)}.`]).concat([
    ['Every degree counts', `Your heat model says about ${(S.acSlope ?? 2.5).toFixed(1)} kWh a day per degree of daily high, so each degree of setpoint is worth roughly ${((S.acSlope ?? 2.5) * .6).toFixed(1)} kWh on a hot day.`],
    ['Outage and grid mode', `Storm Watch, an outage or an ERCOT conservation call: pre-cool, then hold ${d.settings.coastF}° to stretch backup hours.`],
    ['Winter: keep the strips off', 'Electric strip heat draws 5–15 kW. Autopilot uses gentle setbacks only, because recovering from a deep one is exactly what stacks the strips.']]);
  $('acWhy').innerHTML = why.map(([b, p]) => `<div class="c-check" style="grid-template-columns:minmax(0,1fr)"><span><b>${b}.</b> ${p}</span></div>`).join('');
}
const apStage = { m: null, sending: false };
function drawAuto(S) {
  const d = S.ac, s = d.settings, P = d.plan, st = d.state, m = apStage.m ?? s.autopilot;
  $('acAutoBadge').innerHTML = modePill(MODE_CLS[s.autopilot]);
  const temps = [...new Set(P.steps.map(x => x.hour))].slice(0, 3).map(h => P.steps.find(x => x.hour === h).coolF);
  $('acFig').textContent = temps.map(t => `${t}°`).join(' · ');
  $('acSum').textContent = `Today: ${P.precool ? `pre-cool to ${Math.min(...P.steps.map(x => x.coolF))}°` : 'hold the band'} · ${P.high >= 95 ? 'hot' : P.high >= 88 ? 'warm' : 'mild'} day (high ${Math.round(P.high)}°) · ${P.precool ? `coast ${hm(P.coastFrom)}–${hm(P.coastTo)}` : 'no pre-cool'}`;
  $('acMode').innerHTML = seg([['off', 'Off'], ['suggest', 'Suggest'], ['auto', 'Auto']], m, { acc: 'c-acc-batt', attr: 'data-ap', label: 'AC Autopilot' })
    + (apStage.m && apStage.m !== s.autopilot ? `<div class="c-btns c-stagerow"><button class="c-btn line" data-aps="cancel">Cancel</button><button class="c-btn pri c-acc-batt" data-aps="send">${apStage.sending ? 'Saving…' : autopilotStage('AC', apStage.m)}</button></div>` : '');
  $('acMode').onclick = async e => {
    const b = e.target.closest('[data-ap]'); if (b) { apStage.m = b.dataset.ap === s.autopilot ? null : b.dataset.ap; return drawAuto(S); }
    const x = e.target.closest('[data-aps]'); if (!x || apStage.sending) return;
    if (x.dataset.aps === 'cancel') { apStage.m = null; return drawAuto(S); }
    if (apStage.m === 'auto' && !confirm('Auto mode sets the cooling setpoint through each day without asking, always inside your comfort band. Turn it on?')) return;
    if (apStage.m === 'off' && !confirm('Turn AC Autopilot off?\n\nSolstice stops changing the thermostat. Nest keeps the setpoint it has now.')) return;
    apStage.sending = true; drawAuto(S);
    await api.acSettings({ autopilot: apStage.m }).catch(err => alert(err.message)); apStage.sending = false; apStage.m = null; await loadAc(S);
  };
  // v-ac-control frame 3: a hold in force says so here too
  $('acStatus').textContent = d.hold && s.autopilot !== 'off' ? `Holding your change until ${clk(d.hold.until)}; plan steps in that time are skipped, not stacked up.`
    : s.autopilot === 'off' ? 'Off. Suggest plans each day and waits for you; Auto applies the steps itself.'
    : `${s.autopilot === 'auto' ? 'Applies' : 'Suggests'} each day’s plan from the 6 AM forecast, samples Nest every 5 minutes, never leaves your comfort band, never touches heating mode.`;
  drawTrim(S);
  const soc = S.live?.soc ?? null;
  $('acWhyLine').textContent = `6 signals · high ${Math.round(P.high)}°`;
  $('acSignals').innerHTML = gauge(`${Math.round(P.high)}°`, 'high', P.high / 105, 'c-acc-ac') + gauge(esc(P.sunKwhM2), 'sun', P.sunKwhM2 / 8, 'c-acc-solar') + gauge(S.guest ? '—' : esc(s.presence ?? '—'), 'presence', S.guest ? 0 : s.presence === 'home' ? 1 : .2, 'c-acc-vac')
    + gauge(soc != null ? Math.round(soc) + '%' : '—', 'battery', (soc ?? 0) / 100, 'c-acc-batt') + gauge(st?.humidity != null ? st.humidity + '%' : '—', 'RH', (st?.humidity ?? 0) / 100, 'c-acc-home') + gauge(esc(S.ercot?.condition ?? '—'), 'ERCOT', S.ercot?.eea ? .9 : .15, 'c-acc-grid');
  // the next 7 days: each high as a gradient bar with its value on top, the pre-cool depth in green on a pre-cool day
  const days = d.week, X = i => 18 + i * 43;
  let o = `<defs><linearGradient id="acwg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--ac)"/><stop offset="1" style="stop-color:var(--ac);stop-opacity:.2"/></linearGradient></defs>`;
  days.forEach((x, i) => { const cx = X(i), hh = Math.max(4, (x.high - 70) / 35 * 70);
    o += `<rect x="${cx - 13}" y="${92 - hh}" width="26" height="${hh}" rx="6" fill="url(#acwg)"/>` + (x.precool ? `<rect x="${cx - 13}" y="${92 - Math.max(8, x.depth * 7)}" width="26" height="${Math.max(8, x.depth * 7)}" rx="5" style="fill:var(--batt)"/><text x="${cx}" y="${92 - hh / 2}" text-anchor="middle" style="fill:var(--batt)">pre-cool</text>` : '')
      + `<text class="v" x="${cx}" y="${88 - hh}" text-anchor="middle">${x.high}°</text><text x="${cx}" y="108" text-anchor="middle">${new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</text>`; });
  $('acWeek').innerHTML = o;
  $('acTomorrow').textContent = days[1] ? `tomorrow ${days[1].high}° · ${days[1].precool ? `pre-cool ${days[1].depth}°` : 'hold the band'}` : '';
  const last = d.log?.[0];
  $('acLogLine').textContent = last ? `last: ${niceDate(last.day, { month: 'short', day: 'numeric' })}${Number.isFinite(last.at) ? ` · ${clk(last.at)}` : ''} · opens the timeline` : 'nothing yet · Nest is sampled every 5 minutes';
  $('acLogRow').onclick = () => S.openLog?.({ src: 'ac' });
}
/** r-learning: today's learned trim (Undo inline, owner only) or the control-day note, under the chart. */
function drawTrim(S) {
  const P = S.ac.plan, t = P.trim, box = $('acTrim');
  const what = !t ? '' : t.what === 'coast' ? `coast ${t.to < t.from ? 'ends earlier' : 'runs longer'}, to ${hm12(t.to)}` : `pre-cool to ${t.to}° instead of ${t.from}°`;
  box.innerHTML = t ? `<div class="c-modeline c-acc-batt"><p><b>Trim today</b> · ${what} · ${esc(t.reason)}</p>${S.guest ? '' : '<button class="c-btn sm line" id="acUntrim">Undo</button>'}</div>`
    : P.control ? '<div class="c-modeline c-acc-batt"><p><b>Control day</b> · holding the comfort band today, 1 in 5 hot, sunny days, so Solstice can measure what pre-cooling really saves</p></div>' : '';
  const u = $('acUntrim'); if (u) u.onclick = async () => { u.disabled = true; u.textContent = 'Undoing…'; try { await api.acUntrim(); await loadAc(S); } catch (e) { alert(e.message); u.disabled = false; u.textContent = 'Undo'; } };
}
/* ---------- mockup am frame 6 (I-15): the Strip heat card under the Thermostat (owner only; Nov–Mar or after heating; no buttons) ---------- */
function drawStrip(S) {
  const card = $('acStrip'); if (!card) return;
  card.hidden = !!S.guest || !stripShows(S.acStrip, location.search);
  if (!card.hidden) card.innerHTML = stripCardHtml(S.acStrip);
}
/* ---------- the Thermostat card (owner only): the panel is the AC sheet's component; this adds the badge, presence, suggestions ---------- */
const clk = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
function drawThermostat(S) {
  const d = S.ac, st = d.state, card = $('acTstat');
  card.hidden = !!S.guest || !d.linked || !st;
  if (card.hidden) return;
  freshAc(S);   // mockup x: the badge carries the age of the last Nest sample
  const pr = d.presence ?? { state: d.settings.presence }, src = presenceLine(pr);
  $('acPsrc').hidden = !src; $('acPsrc').innerHTML = src ?? '';
  // frame 7 (mockup ag): changes the same way in the same part of the day on 4 of the last 7 days suggest moving that target 1° (nothing changes unless tapped)
  const sg = d.suggestion, nightSg = sg?.window === 'night';
  $('tsSuggest').innerHTML = sg ? `<div class="c-ban amber"><span class="c-ic">${icon('sliders')}</span><b>You keep setting it ${sg.f > sg.from ? 'warmer' : 'cooler'} ${nightSg ? 'at night' : 'during the day'}</b><p>${sg.days} of the last ${sg.of} ${nightSg ? 'nights' : 'days'}. Make ${sg.f}° the ${nightSg ? 'night' : 'day'} target? Autopilot would aim for ${sg.f}° instead of ${sg.from}°.</p>
    <div class="c-btns"><button class="c-btn pri" data-sg="accept">Make it ${sg.f}°</button><button class="c-btn line" data-sg="dismiss">Not now</button></div></div>` : '';
  $('tsSuggest').onclick = async e => { const b = e.target.closest('[data-sg]'); if (!b) return; b.disabled = true; b.textContent = '…';
    try { S.ac = await api.acSuggestion(b.dataset.sg, sg.key); } catch (err) { alert(err.message); } drawAc(S); };
  // mockup ae: what Solstice is learning from your changes (owner only)
  const ch = d.changes;
  $('tsLearn').innerHTML = !S.guest && ch?.recent?.length ? `<div class="c-card flush" style="margin-top:12px"><div class="c-sys compact c-acc-grid" role="button" tabindex="0" id="tsLearnBtn"><span class="c-ic">${icon('chart')}</span><div style="min-width:0"><div class="c-sys-top"><b>Learning from ${ch.recent.length} change${ch.recent.length === 1 ? '' : 's'}</b></div><div class="c-sys-l">this week · toward a new target</div></div><span class="c-chev">${icon('chev')}</span></div></div>` : '';
  if ($('tsLearnBtn')) $('tsLearnBtn').onclick = () => openChanges(ch);
}
/** "Hallway · 4 min" (live); amber "Nest · 26 min ago" past 20 minutes (Nest is sampled every 5–15); "offline" when Nest says so. */
const NEST_STALE_MS = 20 * 60_000;
export function freshAc(S) {
  const st = S.ac?.state, b = $('tsBadge'); if (!st || !b || $('acTstat').hidden) return;
  const age = Date.now() - st.at, t = age < 60_000 ? 'just now' : age < 3600_000 ? `${Math.floor(age / 60_000)} min` : `${Math.floor(age / 3600_000)} h`;
  const html = !st.online ? badge('', `${st.name ?? 'Thermostat'} · offline`) : age > NEST_STALE_MS ? badge('estimated', `Nest · ${t} ago`) : badge('live', `Linked · ${t}`);
  if (b.innerHTML !== html) b.innerHTML = html;
}

/* mockup ae: the "Your changes" sheet: the patterns building toward a suggestion and the changes they come from */
const dayTime = ms => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(',', '');
export const dotsHtml = (n, need) => `<div class="ae-dots">${Array.from({ length: need }, (_, i) => `<i class="${i < n ? 'on' : 'need'}"></i>`).join('')}</div>`;
function openChanges(ch) {
  const list = xs => xs.length < 2 ? `${xs[0]}°` : `${xs.slice(0, -1).map(x => `${x}°`).join(', ')} and ${xs.at(-1)}°`;   // mockup ag: one pattern per part of the day and direction
  const pats = ch.patterns.map(p => { const set = p.set ?? [p.f]; return `<div class="ae-pat"><div class="t">${p.window === 'night' ? 'Nights' : 'Days'}: ${p.dir > 0 ? 'warmer' : 'cooler'} than the plan<span>${Math.min(p.days, p.need)} of ${p.need}</span></div>
    <p>You set ${list(set)} when it planned ${p.planF}°.${set.length > 1 ? ` ${set.length === 2 ? 'Both' : 'All'} count: the same direction in the same part of the day.` : ''}</p>${dotsHtml(p.days, p.need)}</div>`; }).join('');
  $('sheetBody').innerHTML = `<div class="shead"><h4>Your changes</h4><button class="x" id="chX" aria-label="Close">✕</button></div>
    <p class="sub">Thermostat · last 7 days</p>${pats || '<p class="fine" style="margin-top:10px">No pattern yet: a change warmer or cooler than both the plan and your target starts one.</p>'}
    <div class="ae-chg">${ch.recent.map(r => `<div><em>${dayTime(r.at)}</em><b>Set ${r.coolF}° ${r.by === 'app' ? 'in the app' : 'at the thermostat'}</b><span>plan ${r.planF}°</span></div>`).join('')}</div>
    <p class="fine" style="margin-top:12px">After warmer (or cooler) changes on 4 of 7 days, Solstice suggests moving that target 1°. It never changes it by itself.</p>`;
  $('chX').onclick = () => $('phone').classList.remove('open');
  $('phone').classList.add('open');
}
/* ---------- mockup ag: Comfort targets (owner only) ---------- */
const hr12 = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const isNightAt = (h, s) => h >= s.nightFrom || h < s.nightTo;
/** The hours of a hot, sunny day under `v`, as [from, to, °F, kind] runs (the plan's own pre-cool window when today has one). */
function hotDay(v, P) {
  const pf = P?.precool ? P.precoolFrom : 11, pt = P?.precool ? P.precoolTo : 16, ct = Math.min(21, pt + 4), out = [];
  for (let h = 0; h < 24; h++) {
    const [f, k] = isNightAt(h, v) ? [v.nightF, 'n'] : v.precoolDepth && h >= pf && h < pt ? [v.dayF - v.precoolDepth, 'p'] : v.precoolDepth && v.driftF && h >= pt && h < ct ? [v.dayF + v.driftF, 'c'] : [v.dayF, 'd'];
    const last = out.at(-1); if (last && last[2] === f && last[3] === k) last[1] = h + 1; else out.push([h, h + 1, f, k]);
  }
  return out;
}
const DAYC = { n: '#b8a6ff', d: '#ffd27a', p: '#7cc4ff', c: '#ffb08a' };
/* the Comfort sheet. Saving writes only Solstice's settings; the plan uses them from its next step. */
/** The Comfort sheet in the component system (mockup al, component 11): stepper rows in a card, the night hours as two buttons,
 *  pre-cool and drift as small sliding segments, Save in the pinned footer. `v` is the staged settings. */
export function comfortHtml(v) {
  const row = (label, sub, ctl) => `<div class="c-stepper"><div>${label}<small>${sub}</small></div>${ctl}</div>`;
  const stepr = k => `<button class="c-step" data-k="${k}" data-d="-1" aria-label="Lower">−</button><b id="cv_${k}"></b><button class="c-step" data-k="${k}" data-d="1" aria-label="Higher">+</button>`;
  const chips = (k, opts, label) => `<span data-c="${k}">${seg(opts.map(o => [o, o ? `${o}°` : 'Off']), v[k], { cls: 'sm', acc: 'c-acc-ac', label })}</span>`;
  return `${sheetHead('Comfort', '', 'What Autopilot aims for. Your changes at the thermostat or in the app still go anywhere from 65° to 85°.')}
    <div class="c-card" id="cmRows" style="padding:4px 16px">${row('Day', '<span id="cs_day"></span>', stepr('dayF'))}${row('Night', '<span id="cs_night"></span>', stepr('nightF'))}
      ${row('Night hours', 'when night starts and ends', '<button class="c-btn sm line c-num" data-h="nightFrom" id="cv_nightFrom" aria-label="Night starts"></button><span class="c-cap">–</span><button class="c-btn sm line c-num" data-h="nightTo" id="cv_nightTo" aria-label="Night ends"></button>')}
      ${row('Pre-cool', 'on hot, sunny days, while solar covers it', chips('precoolDepth', [0, 1, 2, 3], 'Pre-cool'))}${row('Evening drift', 'after pre-cooling, on the Powerwalls', chips('driftF', [0, 1, 2], 'Evening drift'))}
      ${row('Away', 'while marked away', stepr('awayF'))}</div>
    <p class="c-sheet-sub" style="margin-top:14px">A hot, sunny day with these settings:</p>
    <div class="ag-day" id="cmDay"></div><div class="ag-dlab"><span style="left:0">12a</span><span style="left:25%">6a</span><span style="left:50%">12p</span><span style="left:75%">6p</span><span style="left:100%">12a</span></div>
    <p class="c-fine" style="text-align:center">Takes effect at the next plan step. A hold in force is left alone.</p>
    ${sheetFoot('', 'Save', 'c-acc-ac')}`;
}
export function openComfort(S) {
  const s = S.ac.settings, v = { dayF: s.dayF, nightF: s.nightF, precoolDepth: s.precoolDepth, driftF: s.driftF, awayF: s.awayF, nightFrom: s.nightFrom, nightTo: s.nightTo };
  const HOURS = { nightFrom: [18, 23], nightTo: [4, 11] };
  sheet(comfortHtml(v));
  const body = $('sheetBody'), go = body.querySelector('[data-f="pri"]');
  const draw = () => {
    ['dayF', 'nightF', 'awayF'].forEach(k => $(`cv_${k}`).textContent = `${v[k]}°`);
    $('cv_nightFrom').textContent = hr12(v.nightFrom); $('cv_nightTo').textContent = hr12(v.nightTo);
    $('cs_day').textContent = `${hr12(v.nightTo)} – ${hr12(v.nightFrom)}`; $('cs_night').textContent = `${hr12(v.nightFrom)} – ${hr12(v.nightTo)}`;
    body.querySelectorAll('#cmRows [data-c]').forEach(w => segSet(w.firstElementChild, String(v[w.dataset.c])));
    $('cmDay').innerHTML = hotDay(v, S.ac.plan).map(([a, b, f, k]) => `<i style="flex:${b - a};background:${DAYC[k]}">${b - a >= 2 ? f : ''}</i>`).join('');
  };
  $('cmRows').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k) { const k = b.dataset.k; v[k] = Math.max(65, Math.min(85, v[k] + +b.dataset.d)); }
    else if (b.dataset.h) { const k = b.dataset.h, [lo, hi] = HOURS[k]; v[k] = v[k] >= hi ? lo : v[k] + 1; }   // each tap moves an hour later, wrapping
    else if (b.dataset.v != null) v[b.closest('[data-c]').dataset.c] = +b.dataset.v;
    // pre-cool and drift may not leave 65–85° (the server checks the same)
    v.precoolDepth = Math.min(v.precoolDepth, v.dayF - 65); v.driftF = Math.min(v.driftF, 85 - v.dayF);
    draw(); };
  go.onclick = async () => { go.textContent = 'Saving…';
    try { await api.acSettings(v); closeSheet(); await loadAc(S); }
    catch (e) { alert(e.message); go.textContent = 'Save'; } };
  draw();
}
/* "Too cold" (dir +1) / "Too warm" (dir −1): the target for this part of the day, or just for now */
export function openNudge(S, dir) {
  const d = S.ac, s = d.settings, st = d.state;
  if (!st || st.mode !== 'COOL' || st.coolF == null) return alert('The thermostat isn’t cooling right now, so there is nothing to nudge.');
  const h = localHour(), night = isNightAt(h, s), t = night ? s.nightF : s.dayF, aim = [...d.plan.steps].reverse().find(x => x.hour <= h)?.coolF ?? t;
  const set = Math.round(st.coolF) + dir, next = d.plan.steps.find(x => x.hour > h), word = night ? 'night' : 'day';
  let keep = true;
  $('sheetBody').innerHTML = `<div class="shead"><h4>${dir > 0 ? 'Warmer' : 'Cooler'} by 1°</h4><button class="x" id="ngX" aria-label="Close">✕</button></div>
    <p class="sub">It's ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. Autopilot is aiming for ${aim}°.</p>
    <button class="ag-opt" data-keep="1"><b>Make ${t + dir}° the ${word} target</b><p>From now on, every ${word === 'night' ? 'night' : 'day'}. Nest goes to ${aim + dir}° now (one step).</p></button>
    <button class="ag-opt" data-keep="0"><b>Just for now</b><p>${set}° until ${next ? `the next plan step at ${hr12(Math.floor(next.hour))}` : 'the morning step'}, then back to the plan. Same as changing it at the thermostat.</p></button>
    <button class="primary" id="ngGo"></button>`;
  const draw = () => { document.querySelectorAll('.ag-opt').forEach(b => b.classList.toggle('pick', (b.dataset.keep === '1') === keep)); $('ngGo').textContent = keep ? `Make it ${t + dir}°` : `Set ${set}° for now`; };
  document.querySelectorAll('.ag-opt').forEach(b => b.onclick = () => { keep = b.dataset.keep === '1'; draw(); });
  $('ngX').onclick = () => $('phone').classList.remove('open');
  $('ngGo').onclick = async () => { const go = $('ngGo'); go.textContent = 'Sending…';
    try { S.ac = await api.acNudge(dir, keep); $('phone').classList.remove('open'); drawAc(S); }
    catch (e) { alert(e.message); draw(); } };
  draw(); $('phone').classList.add('open');
}
let timer;
/** Started by main.js once the role is known (and again when it changes); every 3 minutes while the tab is visible. */
export function initAc(S) { stop(timer); timer = every(3 * 60_000, () => loadAc(S)); S.reloadAc = () => loadAc(S); }
// a failed refresh keeps the last good plan and reading, with the failure in the card's note, instead of showing "Not set up"
export async function loadAc(S) { const strip = S.guest ? null : api.acStrip().catch(() => S.acStrip ?? null); S.ac = await api.ac().catch(e => S.ac?.plan ? { ...S.ac, error: e.message } : { error: e.message, configured: false, linked: false }); S.acStrip = await strip; if (S.ac.plan) drawAc(S); else { drawAcSys(S); $('acAuto').hidden = true; $('acLink').hidden = false; $('acLinkTxt').textContent = S.ac.error ?? 'Nest is not configured.'; } S.onAc?.(); }

/* ---------- presence (t-enhancements frame 4): the line under the Thermostat card's Away row ---------- */
const NEST_SAYS = pr => `<b>Nest says Away</b>${pr.since ? ` since ${when(pr.since)}` : ''} (Home/Away Assist)`;
/** The line under the control: Nest's Away, or the return time the owner set. Null when there is nothing to say. */
function presenceLine(pr) {
  if (pr.state !== 'away') return null;
  if (pr.source === 'vacation') return `<b>Vacation mode</b>${pr.until ? ` · back ${when(pr.until)}` : ''}`;
  if (pr.source === 'nest') return `${NEST_SAYS(pr)}. Tap Away to add a return time.`;
  if (pr.source === 'manual' && pr.until) return `<b>Away until ${when(pr.until)}</b>${pr.since ? ` · you set it at ${when(pr.since)}` : ''}`;
  return null;
}
