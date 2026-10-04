import { $, money, niceDate, localDate, localHour } from '../lib/util.js';
import { api } from '../lib/api.js';
import { createThermalTwin } from '../scenes/thermaltwin.js';
import { veil, nameStart } from '../lib/frost.js';
import { confChip, esc } from '../lib/conf.js';
import { presets, pickedEpoch, localInput, untilLabel, awayButton, awayLines, when } from '../lib/presence.js';

/* AC (Insights → Appliances): thermal twin with a day scrubber, today's plan vs Nest, Autopilot, Home/Away, and the Nest link. */
let twin = null, scrubT = null;
export const thermalTwin = () => twin;
const hm = h => `${Math.floor(h) % 12 || 12}${h % 1 ? ':' + String(Math.round((h % 1) * 60)).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`;

/** A simple indoor model for the scrubber: the house drifts toward outdoor at ~0.6°F/h per 10°F difference, the AC pulls it to the setpoint. */
function simulateDay(d, outdoor) {
  const st = d.state, steps = d.plan.steps, sp = h => [...steps].reverse().find(s => s.hour <= h)?.coolF ?? st?.coolF ?? 75;
  const out = []; let T = st?.indoorF ?? 75;
  for (let h = 0; h <= 24; h += .25) { const o = outdoor[Math.min(23, Math.floor(h))] ?? 90, set = sp(h); const drift = (o - T) * .06 * .25; T += drift; const cooling = T > set + .3; if (cooling) T = Math.max(set, T - .9 * .25); out.push({ h, T: Math.round(T * 10) / 10, set, cooling, o }); }
  return out;
}
export function drawAc(S) {
  const d = S.ac; if (!d) return;
  const linked = d.linked, st = d.state;
  $('acBadge').textContent = !d.configured ? 'Not set up' : linked ? 'Linked · Nest' : 'Not linked'; $('acBadge').className = 'badge' + (linked ? ' g' : '');
  $('acLink').hidden = linked; $('acPlan').hidden = !linked; $('acAuto').hidden = !linked;
  if (!twin) twin = createThermalTwin($('acTwin'));
  const wx = S.wx, today = localDate(), outdoor = Array(24).fill(d.outdoorF ?? 90);
  if (wx) wx.hourly.time.forEach((t, i) => { if (t.startsWith(today)) outdoor[+t.slice(11, 13)] = wx.hourly.temperature_2m[i]; });
  const sunH = Array(24).fill(0); if (wx) { const pk = Math.max(1, ...wx.hourly.global_tilted_irradiance); wx.hourly.time.forEach((t, i) => { if (t.startsWith(today)) sunH[+t.slice(11, 13)] = (wx.hourly.global_tilted_irradiance[i] ?? 0) / pk; }); }
  const sim = simulateDay(d, outdoor), now = localHour();
  const show = h => { const live = h == null; const hh = live ? now : h; const p = sim.reduce((a, x) => Math.abs(x.h - hh) < Math.abs(a.h - hh) ? x : a);
    const cooling = live && st ? st.hvac === 'COOLING' : p.cooling, heating = live && st ? st.hvac === 'HEATING' : false;
    twin.set({ indoorF: live && st?.indoorF != null ? st.indoorF : p.T, sun: sunH[Math.min(23, Math.floor(hh))], cooling, heating });
    const phase = d.plan.precool && hh >= d.plan.precoolFrom && hh < d.plan.precoolTo ? ' · pre-cool' : d.plan.precool && hh >= d.plan.coastFrom && hh < d.plan.coastTo ? ' · coast' : '';
    $('acHud').textContent = `${cooling ? `Cooling · ${d.learned.acKw.toFixed(1)} kW` : heating ? 'Heating' : 'Idle'} · set ${live && st?.coolF != null ? st.coolF : p.set}°${phase}`;
    $('acLab').innerHTML = `indoor ${(live && st?.indoorF != null ? st.indoorF : p.T).toFixed(1)}°<br>outdoor ${Math.round(p.o)}°<br>sun ${Math.round(sunH[Math.min(23, Math.floor(hh))] * 100)}%`;
    $('acScrubT').textContent = `${hm(Math.round(hh * 4) / 4)}${live ? ' · now' : ''}`; };
  const sc = $('acScrub'); sc.value = now; sc.oninput = () => { scrubT = +sc.value; show(Math.abs(scrubT - now) < .2 ? null : scrubT); }; show(null);
  const rt = d.runtime, source = d.learned.source ?? (d.learned.coolKw != null ? 'measured' : 'estimated'); // a guest's copy leaves out `source`; the server's own rule
  $('acStats').innerHTML = `<div class="stat"><small>Today</small><b>${d.todayKwh} kWh${d.shareOfHomePct != null ? ` · ${d.shareOfHomePct}%` : ''}</b></div><div class="stat"><small>Run time</small><b>${Math.floor(rt.minutes / 60)} h ${rt.minutes % 60} m${rt.duty != null ? ` · ${rt.duty}% duty` : ''}</b></div>
    <div class="stat"><small>AC draw · ${source}</small><b>${d.learned.acKw.toFixed(1)} kW${d.learned.samples ? ` · ${d.learned.samples} steps` : ''}</b></div><div class="stat"><small>Indoor · humidity</small><b>${st?.indoorF ?? '—'}° · ${st?.humidity ?? '—'}%</b></div>`;
  // t-enhancements frame 4: the control lights the presence in force (manual, then Nest Home/Away Assist); Away opens "Away until…"
  const pr = d.presence ?? { state: d.settings.presence, source: 'manual', since: null, until: null }, lit = pr.state ?? d.settings.presence;
  $('acPresence').innerHTML = `<button class="${lit === 'home' ? 'on' : ''}" data-p="home">Home</button><button class="${lit === 'away' ? 'on' : ''}" data-p="away">${lit === 'away' && pr.source === 'manual' && pr.until ? awayButton(pr.until) : `Away · ${d.settings.awayF}°`}</button>`;
  $('acPresence').onclick = async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.p === 'away' && !S.guest) return openAway(S);
    if (b.dataset.p === lit) return;
    await api.acSettings({ presence: b.dataset.p }).catch(err => alert(err.message)); await loadAc(S); };
  const src = presenceLine(pr); $('acPsrc').hidden = !src; $('acPsrc').innerHTML = src ? `<i></i><span>${src}</span>` : '';
  $('acNote').innerHTML = `${d.equipment.airHandler} · ${d.equipment.heat} · ${d.equipment.outdoor}. AC power is ${source === 'measured' ? 'measured from the step in Tesla’s home load when Nest starts and stops cooling' : 'estimated from your heat model until Nest has been sampled for a few days'}.${d.error ? ` <span style="color:var(--warn)">Last read failed: ${d.error}</span>` : ''}`;
  drawThermostat(S);
  if (!linked) { $('acLinkBtn').href = '/auth/google'; $('acLinkTxt').textContent = d.configured ? 'Sign in with Google and share the thermostat with Solstice.' : 'Google Device Access is not configured yet (NEST_PROJECT_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).'; return; }
  drawPlan(S, sim, outdoor, sunH); drawAuto(S);
}
function drawPlan(S, sim, outdoor, sunH) {
  const d = S.ac, P = d.plan, st = d.state, svg = $('acComfort'), X = h => 12 + h / 24 * 329, lo = Math.min(66, ...outdoor) - 2, hi = Math.max(100, ...outdoor) + 2, Y = t => 150 - (t - lo) / (hi - lo) * 130;
  const nest = st?.coolF ?? 75, plan = h => [...P.steps].reverse().find(s => s.hour <= h)?.coolF ?? nest;
  const step = (f, c, w) => { let p = ''; for (let h = 0; h < 24; h++) p += `${h ? 'L' : 'M'}${X(h)} ${Y(f(h))} L${X(h + 1)} ${Y(f(h))} `; return `<path d="${p}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"/>`; };
  let o = `<path d="M${X(0)},150 ${sunH.map((v, h) => `L${X(h)},${150 - v * 70}`).join(' ')} L${X(24)},150 Z" fill="rgba(255,193,94,.12)"/>`;
  if (P.precool) o += `<rect x="${X(P.precoolFrom)}" y="14" width="${X(P.precoolTo) - X(P.precoolFrom)}" height="136" fill="rgba(78,240,166,.06)"/><text x="${X((P.precoolFrom + P.precoolTo) / 2)}" y="24" text-anchor="middle" fill="#4ef0a6" font-size="9" font-family="Manrope">pre-cool</text><rect x="${X(P.coastFrom)}" y="14" width="${X(P.coastTo) - X(P.coastFrom)}" height="136" fill="rgba(108,196,255,.05)"/><text x="${X((P.coastFrom + P.coastTo) / 2)}" y="24" text-anchor="middle" fill="rgba(242,244,248,.6)" font-size="9" font-family="Manrope">coast</text>`;
  o += `<polyline points="${outdoor.map((v, h) => `${X(h)},${Y(v)}`).join(' ')}" fill="none" stroke="#ff9e66" stroke-width="1.5"/>` + step(() => nest, 'rgba(108,196,255,.6)', 1.5) + step(plan, '#4ef0a6', 2) + `<polyline points="${sim.map(p => `${X(p.h)},${Y(p.T)}`).join(' ')}" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.5"/>`;
  [70, 80, 90, 100].forEach(t => o += `<text x="4" y="${Y(t) + 3}" fill="rgba(242,244,248,.4)" font-size="8.5" font-family="JetBrains Mono">${t}°</text>`);
  [['12a', 0], ['6a', 6], ['12p', 12], ['6p', 18], ['12a', 24]].forEach(([l, h]) => o += `<text x="${X(h)}" y="164" text-anchor="middle" fill="rgba(242,244,248,.45)" font-size="9.5" font-family="JetBrains Mono">${l}</text>`);
  const nx = X(localHour()); o += `<line x1="${nx}" y1="14" x2="${nx}" y2="150" stroke="#fff" stroke-opacity=".5"/><circle cx="${nx}" cy="14" r="3" fill="#fff"/>`;
  svg.innerHTML = o;
  const b = d.settings.band;
  $('acBand').textContent = `Band ${b.homeLo}–${b.homeHi}°`;
  $('acBand').title = `${b.homeLo}°–${b.homeHi}° home · ${b.nightLo}°–${b.nightHi}° night · away ${d.settings.awayF}°`;
  $('acBand').onclick = () => { if (!S.guest) openBand(S); };
  // r-learning savings row: the plan's two kWh figures (learn/ac.ts), each with its confidence tier from plan.conf
  const sv = (label, v, tier) => `<div><small>${label}</small><b>${v == null ? '—' : `${Number(v).toFixed(1)} kWh`}</b><span>today's plan</span>${confChip(tier) && `<span style="margin-top:5px">${confChip(tier)}</span>`}</div>`;
  $('acDeltas').innerHTML = sv('kWh shifted onto solar', P.shiftedKwh, P.conf?.shiftedKwh) + sv('Evening kWh avoided', P.eveningAvoidedKwh, P.conf?.eveningAvoidedKwh) + `
    <div><small>Today</small><b>${Math.round(P.high)}°</b><span>${Number(P.sunKwhM2).toFixed(1)} kWh/m² sun<br>${P.precool ? 'pre-cool day' : 'hold the band'}</span></div><div><small>Warmest indoor</small><b>${Math.max(...P.steps.map(s => s.coolF))}°</b><span>${P.precool ? `${hm(P.coastFrom)}–${hm(P.coastTo)}` : 'all day'}</span></div>`;
  const why = P.why.map((w, i) => `<div><i>${['☀', '▮', '°', '⏱', '⚡'][i % 5]}</i><b>${i === 0 ? 'Today' : 'Also'}</b><p>${w}.</p></div>`).concat([
    `<div><i>°</i><b>Every degree counts</b><p>Your heat model says about ${(S.acSlope ?? 2.5).toFixed(1)} kWh a day per degree of daily high, so each degree of setpoint is worth roughly ${((S.acSlope ?? 2.5) * .6).toFixed(1)} kWh on a hot day.</p></div>`,
    `<div><i>⚡</i><b>Outage and grid mode</b><p>Storm Watch, an outage or an ERCOT conservation call: pre-cool, then hold ${d.settings.coastF}° to stretch backup hours.</p></div>`,
    `<div><i>🔥</i><b>Winter: keep the strips off</b><p>Electric strip heat draws 5–15 kW. Autopilot uses gentle setbacks only, because recovering from a deep one is exactly what stacks the strips.</p></div>`]);
  $('acWhy').innerHTML = why.join(''); $('acDots').innerHTML = why.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('');
  const rs = $('acWhy'); rs.onscroll = () => { const i = Math.round(rs.scrollLeft / (rs.children[0].offsetWidth + 10)); [...$('acDots').children].forEach((x, k) => x.classList.toggle('on', k === i)); };
  $('acSteps').innerHTML = P.steps.map(s => `<span>${hm(s.hour)} · ${s.why}</span><b>${s.coolF}°</b>`).join('');
  $('acActions').innerHTML = S.guest ? `<p class="fine" style="margin-top:12px;text-align:center">${nameStart(S.ownerName)} approves changes from their own devices.</p>` : d.applied?.approved ? `<p class="fine" style="margin-top:10px">Today's plan is approved: Solstice sets each step at its hour${d.applied.lastStepHour != null ? ` (last step ${hm(d.applied.lastStepHour)})` : ''}.</p>` : `<button class="primary" id="acApply">Apply today's plan to Nest</button><button class="link" id="acShow">Show the steps instead</button>`;
  const show = $('acShow'); if (show) show.onclick = () => { const el = $('acSteps'); el.style.display = el.style.display === 'none' ? 'grid' : 'none'; };
  const apply = $('acApply'); if (apply) apply.onclick = async () => { if (!confirm(`Let Solstice set the thermostat through today?\n\n${P.steps.map(s => `• ${hm(s.hour)}: ${s.coolF}° (${s.why})`).join('\n')}\n\nOnly the cooling setpoint changes, never outside ${d.settings.band.homeLo}–${Math.max(d.settings.band.homeHi, d.settings.awayF)}°, at most ${d.settings.maxStepF}° per step. Mark Away or change the mode in the Nest app at any time.`)) return; apply.textContent = 'Applying…'; try { await api.acApply(); await loadAc(S); } catch (e) { alert(e.message); apply.textContent = "Apply today's plan to Nest"; } };
}
function drawAuto(S) {
  const d = S.ac, s = d.settings;
  document.querySelectorAll('#acMode button').forEach(b => b.classList.toggle('on', b.dataset.m === s.autopilot));
  $('acAutoBadge').textContent = `Autopilot · ${{ off: 'Off', suggest: 'Suggest', auto: 'Auto' }[s.autopilot] ?? s.autopilot}`; $('acAutoBadge').className = `badge${s.autopilot === 'off' ? '' : ' g'}`;   // a guest's static badge
  $('acMode').onclick = async e => { const b = e.target.closest('button'); if (!b || b.dataset.m === s.autopilot) return; if (b.dataset.m === 'auto' && !confirm('Auto mode sets the cooling setpoint through each day without asking, always inside your comfort band. Turn it on?')) return; await api.acSettings({ autopilot: b.dataset.m }).catch(err => alert(err.message)); await loadAc(S); };
  // v-ac-control frame 3: a hold in force says so here too
  if (d.hold && s.autopilot !== 'off') $('acStatus').innerHTML = `<i class="hold-dot"></i><span><b>Holding your change until ${clk(d.hold.until)}.</b> Plan steps in that time are skipped, not stacked up.</span>`;
  else $('acStatus').innerHTML = `<i class="${s.autopilot === 'off' ? 'off' : ''}"></i><span>${s.autopilot === 'off' ? 'Off. Suggest plans each day and waits for you; Auto applies the steps itself.' : `${s.autopilot === 'auto' ? 'Applies' : 'Suggests'} each day's plan from the 6 AM forecast, samples Nest every 5 minutes, never leaves your comfort band, never touches heating mode`}</span></div>`;
  drawTrim(S);
  const P = d.plan, st = d.state, ring =(v, l, f, c) => { const C = 2 * Math.PI * 17; return `<div><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3.5"/><circle cx="22" cy="22" r="17" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${C * Math.max(0, Math.min(1, f))} ${C}" transform="rotate(-90 22 22)"/></svg><b>${v}</b><small>${l}</small></div>`; };
  const soc = S.live?.soc ?? null;
  $('acSignals').innerHTML = ring(`${Math.round(P.high)}°`, 'high', P.high / 105, '#ff9e66') + ring(P.sunKwhM2, 'sun', P.sunKwhM2 / 8, '#ffc15e') + ring(s.presence ?? '—', 'presence', s.presence === 'home' ? 1 : .2, '#4ef0a6') + ring(soc != null ? Math.round(soc) + '%' : '—', 'battery', (soc ?? 0) / 100, '#6cc4ff') + ring(st?.humidity != null ? st.humidity + '%' : '—', 'rh', (st?.humidity ?? 0) / 100, '#c4a2ff') + ring(S.ercot?.condition ?? '—', 'ercot', S.ercot?.eea ? .9 : .15, '#8d93a8');
  const days = d.week, X = i => 12 + i * 42; let o = ''; days.forEach((x, i) => { const px = X(i), tm = i === 0, hh = Math.max(4, (x.high - 70) / 35 * 56); o += `${tm ? `<rect x="${px - 2}" y="4" width="34" height="102" rx="8" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.1)"/>` : ''}<rect x="${px + 7}" y="${84 - hh}" width="16" height="${hh}" rx="4" fill="#ff9e66" opacity="${tm ? 1 : .7}"/>${x.precool ? `<rect x="${px + 7}" y="${84 - hh - 4 - x.depth * 6}" width="16" height="${x.depth * 6}" rx="3" fill="#4ef0a6"/>` : ''}<text x="${px + 15}" y="${84 - hh - 8 - (x.precool ? x.depth * 6 : 0)}" text-anchor="middle" fill="#f2f4f8" font-size="9.5" font-family="JetBrains Mono">${x.high}°</text><text x="${px + 15}" y="100" text-anchor="middle" fill="rgba(242,244,248,${tm ? .9 : .5})" font-size="9.5" font-family="Manrope">${new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</text>`; });
  $('acWeek').innerHTML = o;
  $('acTomorrow').textContent = days[1] ? `Tomorrow ${days[1].high}° · ${days[1].precool ? `pre-cool ${days[1].depth}°` : 'hold the band'}` : '';
  $('acLog').innerHTML = d.log.slice(0, 6).map(l => { const h = l.delta === 'hold' ? 'h' : ''; return `<div><i class="${h}"></i><span>${niceDate(l.day, { month: 'short', day: 'numeric' })}</span><p>${esc(l.text)}${l.delta ? `<em class="${h}">${esc(l.delta)}</em>` : ''}</p></div>`; }).join('') || `<div><i class="w"></i><span>—</span><p>No changes yet. Nest is sampled every 5 minutes to learn the AC's real draw.</p></div>`;
}
/** r-learning: today's learned trim ("trimmed because…", Undo for the owner) or the control-day note, under the Autopilot status. */
function drawTrim(S) {
  const P = S.ac.plan, t = P.trim, clk = h => `${Math.floor(h) % 12 || 12}${h % 1 ? ':' + String(Math.round(h % 1 * 60)).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
  let box = $('acTrim'); if (!box) { $('acStatus').insertAdjacentHTML('afterend', '<div class="trim" id="acTrim"></div>'); box = $('acTrim'); }
  const what = !t ? '' : t.what === 'coast' ? `Coast ${t.to < t.from ? 'shortened' : 'lengthened'} to ${clk(t.to)}` : `Pre-cool to ${t.to}° instead of ${t.from}°`;
  box.innerHTML = t ? `<div class="rec"><b>Trimmed from the last pre-cool days</b><br>${what} because ${esc(t.reason)}.${S.guest ? '' : '<button class="link" id="acUntrim" data-owner>Undo for today</button>'}</div>`
    : P.control ? `<div class="rec"><b>Control day</b><br>Holding the comfort band today, 1 in 5 hot, sunny days, so Solstice can measure what pre-cooling really saves.</div>` : '';
  box.hidden = !t && !P.control;
  const u = $('acUntrim'); if (u) u.onclick = async () => { u.disabled = true; u.textContent = 'Undoing…'; try { await api.acUntrim(); await loadAc(S); } catch (e) { alert(e.message); u.disabled = false; u.textContent = 'Undo for today'; } };
}
/* ---------- v-ac-control: the Thermostat card (owner only), the hold banner and the fan sheet ---------- */
const clk = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const deg = f => `${Math.round(f * 2) / 2}`;
/** Taps wait 1.5 s after the last one and then send once (Google allows 5 thermostat commands a minute). */
const SEND_AFTER_MS = 1500;
const ts = { timer: null, pending: null, pick: 'cool', line: null };
const MANUAL = { COOL: [65, 85], HEAT: [55, 80] };
function drawThermostat(S) {
  const d = S.ac, st = d.state, card = $('acTstat');
  card.hidden = !!S.guest || !d.linked || !st;
  if (card.hidden) return;
  $('tsBadge').textContent = `${st.name ?? 'Thermostat'} · ${st.online ? 'online' : 'offline'}`; $('tsBadge').className = `badge${st.online ? ' g' : ''}`;
  const p = ts.pending ?? { mode: st.mode, coolF: st.coolF, heatF: st.heatF }, mode = st.eco ? 'ECO' : p.mode;
  const v = $('tsVal'), k = mode === 'HEAT' ? 'heat' : mode === 'OFF' ? 'off' : 'cool';
  $('tsLabel').textContent = { COOL: 'Cool to', HEAT: 'Heat to', HEATCOOL: 'Keep between', OFF: 'Thermostat', ECO: 'Eco · Away' }[mode] ?? mode;
  v.className = k + (mode === 'HEATCOOL' ? ' rng' : '');
  v.innerHTML = mode === 'OFF' ? 'Off' : mode === 'ECO' ? `${st.ecoCoolF != null ? deg(st.ecoCoolF) : '—'}<sup>°</sup>`
    : mode === 'HEATCOOL' ? `<span data-end="heat" class="${ts.pick === 'heat' ? 'pick' : ''}">${p.heatF != null ? deg(p.heatF) : '—'}</span><span class="dash">–</span><span data-end="cool" class="${ts.pick === 'cool' ? 'pick' : ''}">${p.coolF != null ? deg(p.coolF) : '—'}</span><sup>°</sup>`
    : `${(mode === 'HEAT' ? p.heatF : p.coolF) != null ? deg(mode === 'HEAT' ? p.heatF : p.coolF) : '—'}<sup>°</sup>`;
  const line = $('tsLine');
  if (ts.line) { line.className = ts.line.cls; line.textContent = ts.line.text; }
  else { line.className = ''; line.textContent = `Indoor ${st.indoorF ?? '—'}° · ${st.humidity ?? '—'}% · ${String(st.hvac ?? 'off').toLowerCase()}`; }
  const canStep = mode === 'COOL' || mode === 'HEAT' || mode === 'HEATCOOL';
  ['tsDown', 'tsUp'].forEach(id => { $(id).style.visibility = canStep ? '' : 'hidden'; });
  document.querySelectorAll('#tsMode button').forEach(b => { const on = b.dataset.m === p.mode && !st.eco; b.className = on ? `on ${b.dataset.m === 'HEAT' ? 'heat' : b.dataset.m === 'OFF' ? 'off' : 'cool'}` : ''; b.setAttribute('aria-pressed', on); b.hidden = !!st.availableModes?.length && !st.availableModes.includes(b.dataset.m); });
  $('tsEco').classList.toggle('on', !!st.eco); $('tsEco').setAttribute('aria-pressed', !!st.eco);
  const fanLeft = st.fanTimer && st.fanUntil ? Math.max(0, Math.round((st.fanUntil - Date.now()) / 60_000)) : null;
  $('tsFan').classList.toggle('on', !!st.fanTimer); $('tsFan').setAttribute('aria-pressed', !!st.fanTimer);
  $('tsFanT').textContent = st.fanTimer ? (fanLeft != null ? (fanLeft >= 60 ? `${Math.floor(fanLeft / 60)} h ${fanLeft % 60} m left` : `${fanLeft} m left`) : 'on') : 'off';
  $('tsHold').innerHTML = holdHtml(d, mode);
  // frame 7: the same manual change on 4 of the last 7 days becomes a band suggestion (nothing changes unless tapped)
  const sg = d.suggestion, hr = sg ? `${Math.round(sg.hour) % 12 || 12} ${sg.hour < 12 ? 'AM' : 'PM'}` : '';
  $('tsSuggest').innerHTML = sg ? `<div class="rec learn"><b>You keep setting ${sg.f}° around ${hr}</b><br>${sg.days} of the last ${sg.of} ${sg.window === 'night' ? 'nights' : 'days'}. Make ${sg.f}° your ${sg.window === 'night' ? 'night' : 'daytime'} setpoint? Autopilot would plan ${sg.f}° ${sg.window === 'night' ? `from ${hm(d.settings.nightFrom)}` : 'through the day'} instead of ${sg.from}°, and you wouldn’t need to change it.
    <div class="row2"><button class="y" data-sg="accept">Make ${sg.f}° the ${sg.window === 'night' ? 'night' : 'daytime'} setpoint</button><button class="n" data-sg="dismiss">Not now</button></div></div>` : '';
  $('tsSuggest').onclick = async e => { const b = e.target.closest('[data-sg]'); if (!b) return; b.disabled = true; b.textContent = '…';
    try { S.ac = await api.acSuggestion(b.dataset.sg, sg.key); } catch (err) { alert(err.message); } drawAc(S); };
  // −/+ : one degree, sent once 1.5 s after the last tap
  const bump = dir => {
    const cur = ts.pending ?? { mode: st.mode, coolF: st.coolF, heatF: st.heatF }, n = { ...cur };
    const end = cur.mode === 'HEAT' ? 'heat' : cur.mode === 'HEATCOOL' ? ts.pick : 'cool', key = end === 'heat' ? 'heatF' : 'coolF', lim = MANUAL[end === 'heat' ? 'HEAT' : 'COOL'];
    if (n[key] == null) return;
    n[key] = Math.max(lim[0], Math.min(lim[1], Math.round(n[key]) + dir));
    if (cur.mode === 'HEATCOOL' && n.coolF - n.heatF < 3) return;   // Nest keeps them 3° apart
    ts.pending = n; ts.line = { cls: 'sending', text: `Sending ${cur.mode === 'HEATCOOL' ? `${n.heatF}–${n.coolF}` : n[key]}°…` }; drawThermostat(S);
    clearTimeout(ts.timer);
    ts.timer = setTimeout(() => send(S, cur.mode === 'HEATCOOL' ? { kind: 'range', heatF: n.heatF, coolF: n.coolF } : { kind: end, f: n[key] }), SEND_AFTER_MS);
  };
  $('tsDown').onclick = () => bump(-1); $('tsUp').onclick = () => bump(1);
  v.onclick = e => { const end = e.target.closest('[data-end]')?.dataset.end; if (end) { ts.pick = end; drawThermostat(S); } };
  $('tsMode').onclick = async e => { const b = e.target.closest('button'); if (!b || (b.dataset.m === st.mode && !st.eco)) return;
    const word = { COOL: 'Cool', HEAT: 'Heat', HEATCOOL: 'Heat · Cool', OFF: 'Off' }[b.dataset.m];
    if (!confirm(`Switch the thermostat to ${word}?${b.dataset.m !== 'COOL' ? '\n\nAC Autopilot pauses until it is back in Cool.' : ''}`)) return;
    await send(S, { kind: 'mode', mode: b.dataset.m }); };
  $('tsEco').onclick = () => send(S, { kind: 'eco', on: !st.eco });
  $('tsFan').onclick = () => openFan(S);
  const hb = $('tsHold');
  hb.onclick = async e => { const b = e.target.closest('[data-hold]'); if (!b) return; b.disabled = true; b.textContent = '…';
    try { S.ac = await api.acHold(b.dataset.hold); drawAc(S); } catch (err) { alert(err.message); drawAc(S); } };
}
/** The banner under the controls: a hold, Autopilot paused by the mode, or what Autopilot is doing. */
function holdHtml(d, mode) {
  const s = d.settings, h = d.hold;
  if (mode !== 'COOL') {
    const why = { HEAT: 'Autopilot only plans cooling. It starts again when the thermostat is back in Cool. Your heat setpoint is yours alone.',
      HEATCOOL: 'Autopilot plans a single cooling setpoint, so it waits until the thermostat is back in Cool. Tap a number to choose which end −/+ moves.',
      OFF: 'The thermostat is off. Solstice sends nothing until it is turned back on.',
      ECO: 'Nest is in Eco, so presence reads Away and Autopilot plans the away temperature. Tap Eco to turn it off.' }[mode] ?? '';
    return `<div class="hold paused"><div class="hh"><i></i><b>${mode === 'ECO' ? 'Away · Eco' : 'AC Autopilot paused'}</b><em>${{ HEAT: 'Heat', HEATCOOL: 'Heat · Cool', OFF: 'Off', ECO: 'Eco' }[mode] ?? ''}</em></div><p>${why}</p></div>`;
  }
  if (h) {
    const pct = Math.max(2, Math.min(100, (Date.now() - h.at) / (h.until - h.at) * 100)), what = h.mode === 'OFF' ? 'Off' : h.mode === 'HEAT' ? `heat ${h.heatF}°` : h.mode === 'HEATCOOL' ? `${h.heatF}–${h.coolF}°` : `${h.coolF}°`;
    return `<div class="hold"><div class="hh"><i></i><b>${h.by === 'app' ? `Holding your ${what}` : `Holding ${what} set at the thermostat`}</b><em>until ${clk(h.until)}</em></div>
      <p>${h.by === 'app' ? 'You set it here' : 'Changed at the thermostat'} at ${clk(h.at)}. Autopilot skips its steps until <b>${clk(h.until)}</b>: ${esc(h.why)}.</p>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row2"><button class="p" data-hold="resume">Resume now</button>${h.extended ? '' : '<button data-hold="morning">Hold until morning</button>'}</div></div>`;
  }
  const P = d.plan, now = localHour(), next = P.steps.filter(x => x.hour > now).slice(0, 2), cur = currentStepOf(P, now);
  const txt = s.autopilot === 'off' ? '<b>Autopilot · Off.</b> Solstice makes no thermostat changes.'
    : s.autopilot === 'suggest' && !d.applied?.approved ? '<b>Autopilot · Suggest.</b> Today’s plan is waiting for your approval below.'
    : `<b>Autopilot · ${s.autopilot === 'auto' ? 'Auto' : 'Suggest'}.</b> Following today’s plan: ${cur ? `${cur.coolF}° now` : 'nothing due now'}${next.map(x => `, ${x.coolF}° at ${x.hour % 12 || 12}${x.hour % 1 ? ':' + String(Math.round(x.hour % 1 * 60)).padStart(2, '0') : ''} ${x.hour < 12 ? 'AM' : 'PM'}`).join('')}.`;
  return `<div class="follow"><i class="${s.autopilot === 'off' ? 'off' : ''}"></i><span>${txt}</span></div>`;
}
const currentStepOf = (P, h) => [...P.steps].reverse().find(x => x.hour <= h) ?? P.steps[P.steps.length - 1];
async function send(S, cmd) {
  clearTimeout(ts.timer); ts.timer = null;
  try { S.ac = await api.acCommand(cmd); ts.pending = null; ts.line = { cls: 'ok', text: `Set · Nest confirmed ${clk(Date.now())}` }; }
  catch (e) { ts.pending = null; ts.line = { cls: 'err', text: e.message }; }
  drawAc(S);
  setTimeout(() => { ts.line = null; if (!ts.timer) drawThermostat(S); }, 6000);
}
/* frame 5: the comfort band sheet. Saving writes only Solstice's settings; the plan uses them from its next step. */
function openBand(S) {
  const s = S.ac.settings, v = { homeLo: s.band.homeLo, homeHi: s.band.homeHi, nightLo: s.band.nightLo, nightHi: s.band.nightHi, awayF: s.awayF, nightFrom: s.nightFrom, nightTo: s.nightTo };
  const hr = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`, LIM = { t: [65, 85], nightFrom: [18, 23], nightTo: [4, 11] };
  const row = (label, sub, a, b) => `<div class="brow"><span class="bt">${label}<small>${sub}</small></span><span class="stp"><button data-k="${a}" data-d="-1" aria-label="Lower">−</button><b id="bv_${a}"></b></span>${b ? `<span class="stp"><span class="to">to</span><b id="bv_${b}"></b><button data-k="${b}" data-d="1" aria-label="Higher">+</button></span>` : `<button class="stp-plus" data-k="${a}" data-d="1" aria-label="Higher" style="all:unset;cursor:pointer;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.08);font-size:16px">+</button>`}</div>`;
  $('sheetBody').innerHTML = `<div class="shead"><h4>Comfort band</h4><button class="x" id="bandX" aria-label="Close">✕</button></div>
    <p class="sub">Autopilot plans only inside these. Manual changes can go anywhere from 65° to 85°. Tap a number to choose which end −/+ moves.</p>
    <div class="bands" id="bands">${row('Home', `daytime, <span id="bsub_day"></span>`, 'homeLo', 'homeHi')}${row('Night', '<span id="bsub_night"></span>', 'nightLo', 'nightHi')}${row('Away', 'Nest Eco or Away until…', 'awayF')}${row('Night hours', 'when the night band starts and ends', 'nightFrom', 'nightTo')}</div>
    <button class="primary" id="bandGo">Save band</button>
    <p class="fine" style="text-align:center;margin-top:10px">Takes effect at the next plan step. A hold in force is left alone.</p>`;
  const draw = () => { Object.entries(v).forEach(([k, x]) => { $(`bv_${k}`).textContent = k === 'nightFrom' || k === 'nightTo' ? hr(x) : `${x}°`; });
    $('bsub_day').textContent = `${hr(v.nightTo)} – ${hr(v.nightFrom)}`; $('bsub_night').textContent = `${hr(v.nightFrom)} – ${hr(v.nightTo)}`; };
  // −/+ move the end of a pair you tapped last (default: − the low end, + the high end), so a band can widen and narrow
  const PAIRS = { homeLo: 'homeHi', homeHi: 'homeLo', nightLo: 'nightHi', nightHi: 'nightLo', nightFrom: 'nightTo', nightTo: 'nightFrom' }, picked = {};
  const pairOf = k => ['homeLo', 'homeHi'].includes(k) ? 'home' : ['nightLo', 'nightHi'].includes(k) ? 'night' : ['nightFrom', 'nightTo'].includes(k) ? 'hours' : k;
  $('bands').onclick = e => {
    const num = e.target.closest('b[id^="bv_"]');
    if (num) { const k = num.id.slice(3); if (PAIRS[k]) { picked[pairOf(k)] = k; document.querySelectorAll('#bands b').forEach(x => x.style.borderBottom = Object.values(picked).includes(x.id.slice(3)) ? '2px solid rgba(255,255,255,.4)' : ''); } return; }
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = picked[pairOf(b.dataset.k)] ?? b.dataset.k, d = +b.dataset.d, lim = LIM[k] ?? LIM.t;
    v[k] = Math.max(lim[0], Math.min(lim[1], v[k] + d));
    if (k === 'homeLo' && v.homeLo > v.homeHi) v.homeHi = v.homeLo; if (k === 'homeHi' && v.homeHi < v.homeLo) v.homeLo = v.homeHi;
    if (k === 'nightLo' && v.nightLo > v.nightHi) v.nightHi = v.nightLo; if (k === 'nightHi' && v.nightHi < v.nightLo) v.nightLo = v.nightHi;
    draw(); };
  $('bandX').onclick = () => $('phone').classList.remove('open');
  $('bandGo').onclick = async () => { const go = $('bandGo'); go.textContent = 'Saving…';
    try { await api.acSettings({ band: { homeLo: v.homeLo, homeHi: v.homeHi, nightLo: v.nightLo, nightHi: v.nightHi }, awayF: v.awayF, nightFrom: v.nightFrom, nightTo: v.nightTo }); $('phone').classList.remove('open'); await loadAc(S); }
    catch (e) { alert(e.message); go.textContent = 'Save band'; } };
  draw(); $('phone').classList.add('open');
}
const FAN = [[900, '15 m'], [1800, '30 m'], [3600, '1 h'], [7200, '2 h'], [14400, '4 h'], [28800, '8 h'], [43200, '12 h'], [0, 'Stop']];
function openFan(S) {
  let pick = 3600;
  $('sheetBody').innerHTML = `<div class="shead"><h4>Run the fan</h4><button class="x" id="fanX" aria-label="Close">✕</button></div>
    <p class="sub">Circulates air without cooling. Nest stops it on its own when the time is up.</p>
    <div class="fan" id="fanPick">${FAN.map(([s, l]) => `<button data-s="${s}" class="${s === pick ? 'on' : ''}">${l}</button>`).join('')}</div>
    <button class="primary" id="fanGo">Run for 1 h</button>`;
  const draw = () => { document.querySelectorAll('#fanPick button').forEach(b => b.classList.toggle('on', +b.dataset.s === pick)); $('fanGo').textContent = pick ? `Run for ${FAN.find(f => f[0] === pick)[1].replace(' m', ' min')}` : 'Stop the fan'; };
  $('fanPick').onclick = e => { const b = e.target.closest('button'); if (!b) return; pick = +b.dataset.s; draw(); };
  $('fanX').onclick = () => $('phone').classList.remove('open');
  $('fanGo').onclick = async () => { $('fanGo').textContent = 'Sending…'; await send(S, { kind: 'fan', seconds: pick }); $('phone').classList.remove('open'); };
  draw(); $('phone').classList.add('open');
}

let timer;
export function initAc(S) { loadAc(S); clearInterval(timer); timer = setInterval(() => loadAc(S), 3 * 60_000); }
async function loadAc(S) { S.ac = await api.ac().catch(e => ({ error: e.message, configured: false, linked: false })); if (S.ac.plan) drawAc(S); else { $('acBadge').textContent = 'Not set up'; $('acLink').hidden = false; $('acLinkTxt').textContent = S.ac.error ?? 'Nest is not configured.'; } S.onAc?.(); }

/* ---------- presence (t-enhancements frame 4): the line under Home/Away and the "Away until…" sheet ---------- */
const NEST_SAYS = pr => `<b>Nest says Away</b>${pr.since ? ` since ${when(pr.since)}` : ''} (Home/Away Assist)`;
/** The line under the control: Nest's Away, or the return time the owner set. Null when there is nothing to say. */
function presenceLine(pr) {
  if (pr.state !== 'away') return null;
  if (pr.source === 'nest') return `${NEST_SAYS(pr)}. Tap Away to add a return time, or Home if you are here.`;
  if (pr.source === 'manual' && pr.until) return `<b>Away until ${when(pr.until)}</b>${pr.since ? ` · you set it at ${when(pr.since)}` : ''}`;
  return null;
}
const MODE_WORD = { off: 'Off', suggest: 'Suggest', auto: 'Auto' };
function openAway(S) {
  const d = S.ac, pr = d.presence ?? {}, now = Date.now(), pre = presets(now);
  const pickDefault = localInput(now + 2 * 864e5).slice(0, 11) + '15:30';
  // no return time before (or none in force): "Until I'm back" is selected, so the old one-tap Away is one more tap
  const first = pr.state === 'away' && pr.source === 'manual' && pr.until ? pre[1] : pre[0];
  let sel = first.id, at = first.at;
  $('sheetBody').innerHTML = `<div class="shead"><h4>Away until…</h4><button class="x" id="awX" aria-label="Close">✕</button></div>
    <p class="sub">When should Solstice expect you back? It switches to Home at that time on its own, so a forgotten button never leaves the house warm.</p>
    ${pr.state === 'away' && pr.source === 'nest' ? `<div class="psrc" style="margin-top:10px"><i></i><span>${NEST_SAYS(pr)}</span></div>` : ''}
    <div class="aw-pre" id="awPre">
      ${pre.map(p => `<button data-t="${p.id}"><span class="rd"></span><span class="rt">${p.title}<small>${p.sub}</small></span></button>`).join('')}
      <div class="awb" role="button" tabindex="0" data-t="pick"><span class="rd"></span><span class="rt">Pick a time<small>up to 14 days ahead</small></span><span class="aw-pick"><input type="text" id="awPickT" readonly tabindex="-1" aria-hidden="true"><input type="datetime-local" id="awPick" aria-label="Return time" value="${pickDefault}"></span></div>
    </div>
    <div class="aw-do">
      <div style="--c:#ff9e66"><i>❄</i><span><b>AC Autopilot</b><span class="mode">${MODE_WORD[d.settings.autopilot] ?? '—'}</span><br><span id="awAc"></span></span></div>
      <div style="--c:var(--home)"><i>≈</i><span><b>Pool Autopilot</b><span class="mode">${MODE_WORD[S.pool?.autopilot?.mode] ?? '—'}</span><br><span id="awPool"></span></span></div>
    </div>
    <button class="primary" id="awGo">Away until</button>
    <p class="fine" style="text-align:center;margin-top:10px">If Nest reports Home before then, Solstice switches to Home and tells you.</p>`;
  const pick = $('awPick'), pickT = $('awPickT'), maxAt = now + 14 * 864e5;
  pick.min = localInput(now + 15 * 60_000); pick.max = localInput(maxAt);
  const draw = () => {
    if (sel === 'pick') at = pickedEpoch(pick.value);
    pickT.value = pickedEpoch(pick.value) ? untilLabel(pickedEpoch(pick.value), now) : '';
    document.querySelectorAll('#awPre [data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === sel));
    const open = sel === 'open', ok = open || (at != null && at > Date.now() && at <= maxAt);
    const lines = ok ? awayLines(at, Date.now(), { mode: d.settings.autopilot, approved: !!d.applied?.approved, awayF: d.settings.awayF, band: d.settings.band, maxStepF: d.settings.maxStepF }, { mode: S.pool?.autopilot?.mode }) : { ac: 'Pick a time in the next 14 days.', pool: '' };
    $('awAc').textContent = lines.ac; $('awPool').textContent = lines.pool;
    $('awGo').textContent = open ? 'Away' : ok ? `Away until ${untilLabel(at, Date.now())}` : 'Away until…'; $('awGo').disabled = !ok; $('awGo').style.opacity = ok ? '' : .5;
  };
  $('awPre').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; sel = b.dataset.t; if (sel !== 'pick') at = pre.find(p => p.id === sel).at; draw();
    if (sel === 'pick' && e.target !== pick) try { pick.showPicker?.(); } catch { /* not allowed here */ } };
  pick.oninput = pick.onchange = () => { sel = 'pick'; draw(); };
  $('awX').onclick = () => $('phone').classList.remove('open');
  $('awGo').onclick = async () => { const go = $('awGo'); if (go.disabled) return; go.textContent = 'Saving…';
    try { await api.setPresence('away', sel === 'open' ? null : at); $('phone').classList.remove('open'); await loadAc(S); } catch (e) { alert(e.message); draw(); } };
  draw(); $('phone').classList.add('open');
}
