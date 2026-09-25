import { $, money, niceDate, localDate, localHour } from '../lib/util.js';
import { api } from '../lib/api.js';
import { createThermalTwin } from '../scenes/thermaltwin.js';

/* AC (Insights → Appliances): thermal twin with a day scrubber, today's plan vs Nest, Autopilot, Home/Away, and the Nest link. */
let twin = null, scrubT = null;
export const thermalTwin = () => twin;
const hm = h => `${Math.floor(h) % 12 || 12}${h % 1 ? ':' + String(Math.round((h % 1) * 60)).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`;

/** A simple indoor model for the scrubber: the house drifts toward outdoor at ~0.6°F/h per 10°F difference, the AC pulls it to the setpoint. */
function simulateDay(d, outdoor) {
  const st = d.state, steps = d.plan.steps, sp = h => [...steps].reverse().find(s => s.hour <= h)?.coolF ?? st?.coolF ?? 75;
  const out = [], sun = d.week?.[0] ? null : null; let T = st?.indoorF ?? 75;
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
  const rt = d.runtime;
  $('acStats').innerHTML = `<div class="stat"><small>Today</small><b>${d.todayKwh} kWh${d.shareOfHomePct != null ? ` · ${d.shareOfHomePct}%` : ''}</b></div><div class="stat"><small>Run time</small><b>${Math.floor(rt.minutes / 60)} h ${rt.minutes % 60} m${rt.duty != null ? ` · ${rt.duty}% duty` : ''}</b></div>
    <div class="stat"><small>AC draw · ${d.learned.source}</small><b>${d.learned.acKw.toFixed(1)} kW${d.learned.samples ? ` · ${d.learned.samples} steps` : ''}</b></div><div class="stat"><small>Indoor · humidity</small><b>${st?.indoorF ?? '—'}° · ${st?.humidity ?? '—'}%</b></div>`;
  $('acPresence').innerHTML = `<button class="${d.settings.presence === 'home' ? 'on' : ''}" data-p="home">Home</button><button class="${d.settings.presence === 'away' ? 'on' : ''}" data-p="away">Away · ${d.settings.awayF}°</button>`;
  $('acPresence').onclick = async e => { const b = e.target.closest('button'); if (!b || b.dataset.p === d.settings.presence) return; await api.acSettings({ presence: b.dataset.p }).catch(err => alert(err.message)); await loadAc(S); };
  $('acNote').innerHTML = `${d.equipment.airHandler} · ${d.equipment.heat} · ${d.equipment.outdoor}. AC power is ${d.learned.source === 'measured' ? 'measured from the step in Tesla’s home load when Nest starts and stops cooling' : 'estimated from your heat model until Nest has been sampled for a few days'}.${d.error ? ` <span style="color:var(--warn)">Last read failed: ${d.error}</span>` : ''}`;
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
  $('acBand').textContent = `${b.homeLo}°–${b.homeHi}° home · ${b.nightLo}°–${b.nightHi}° night · away ${d.settings.awayF}°`;
  $('acDeltas').innerHTML = `<div><small>AC electricity</small><b>${P.kwhSaved ? '−' + P.kwhSaved + ' kWh' : '0 kWh'}</b><span>per day</span></div><div><small>Cost</small><b>${P.costSavedMonth ? '−' + money(P.costSavedMonth) : '$0'}</b><span>per month</span></div>
    <div><small>Today</small><b>${Math.round(P.high)}° · ${Number(P.sunKwhM2).toFixed(1)} kWh/m²</b><span>${P.precool ? 'pre-cool day' : 'hold the band'}</span></div><div><small>Warmest indoor</small><b>${Math.max(...P.steps.map(s => s.coolF))}°</b><span>${P.precool ? `${hm(P.coastFrom)}–${hm(P.coastTo)}` : 'all day'}</span></div>`;
  const why = P.why.map((w, i) => `<div><i>${['☀', '▮', '°', '⏱', '⚡'][i % 5]}</i><b>${i === 0 ? 'Today' : 'Also'}</b><p>${w}.</p></div>`).concat([
    `<div><i>°</i><b>Every degree counts</b><p>Your heat model says about ${(S.acSlope ?? 2.5).toFixed(1)} kWh a day per degree of daily high, so each degree of setpoint is worth roughly ${((S.acSlope ?? 2.5) * .6).toFixed(1)} kWh on a hot day.</p></div>`,
    `<div><i>⚡</i><b>Outage and grid mode</b><p>Storm Watch, an outage or an ERCOT conservation call: pre-cool, then hold ${d.settings.coastF}° to stretch backup hours.</p></div>`,
    `<div><i>🔥</i><b>Winter: keep the strips off</b><p>Electric strip heat draws 5–15 kW. Autopilot uses gentle setbacks only, because recovering from a deep one is exactly what stacks the strips.</p></div>`]);
  $('acWhy').innerHTML = why.join(''); $('acDots').innerHTML = why.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('');
  const rs = $('acWhy'); rs.onscroll = () => { const i = Math.round(rs.scrollLeft / (rs.children[0].offsetWidth + 10)); [...$('acDots').children].forEach((x, k) => x.classList.toggle('on', k === i)); };
  $('acSteps').innerHTML = P.steps.map(s => `<span>${hm(s.hour)} · ${s.why}</span><b>${s.coolF}°</b>`).join('');
  $('acActions').innerHTML = d.applied?.approved ? `<p class="fine" style="margin-top:10px">Today's plan is approved: Solstice sets each step at its hour${d.applied.lastStepHour != null ? ` (last step ${hm(d.applied.lastStepHour)})` : ''}.</p>` : `<button class="primary" id="acApply">Apply today's plan to Nest</button><button class="link" id="acShow">Show the steps instead</button>`;
  const show = $('acShow'); if (show) show.onclick = () => { const el = $('acSteps'); el.style.display = el.style.display === 'none' ? 'grid' : 'none'; };
  const apply = $('acApply'); if (apply) apply.onclick = async () => { if (!confirm(`Let Solstice set the thermostat through today?\n\n${P.steps.map(s => `• ${hm(s.hour)}: ${s.coolF}° (${s.why})`).join('\n')}\n\nOnly the cooling setpoint changes, never outside ${d.settings.band.homeLo}–${Math.max(d.settings.band.homeHi, d.settings.awayF)}°, at most ${d.settings.maxStepF}° per step. Mark Away or change the mode in the Nest app at any time.`)) return; apply.textContent = 'Applying…'; try { await api.acApply(); await loadAc(S); } catch (e) { alert(e.message); apply.textContent = "Apply today's plan to Nest"; } };
}
function drawAuto(S) {
  const d = S.ac, s = d.settings;
  document.querySelectorAll('#acMode button').forEach(b => b.classList.toggle('on', b.dataset.m === s.autopilot));
  $('acMode').onclick = async e => { const b = e.target.closest('button'); if (!b || b.dataset.m === s.autopilot) return; if (b.dataset.m === 'auto' && !confirm('Auto mode sets the cooling setpoint through each day without asking, always inside your comfort band. Turn it on?')) return; await api.acSettings({ autopilot: b.dataset.m }).catch(err => alert(err.message)); await loadAc(S); };
  $('acStatus').innerHTML = `<i class="${s.autopilot === 'off' ? 'off' : ''}"></i><span>${s.autopilot === 'off' ? 'Off. Suggest plans each day and waits for you; Auto applies the steps itself.' : `${s.autopilot === 'auto' ? 'Applies' : 'Suggests'} each day's plan from the 6 AM forecast, samples Nest every 5 minutes, never leaves your comfort band, never touches heating mode`}</span></div>`;
  const P = d.plan, st = d.state, ring = (v, l, f, c) => { const C = 2 * Math.PI * 17; return `<div><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3.5"/><circle cx="22" cy="22" r="17" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${C * Math.max(0, Math.min(1, f))} ${C}" transform="rotate(-90 22 22)"/></svg><b>${v}</b><small>${l}</small></div>`; };
  const soc = S.live?.soc ?? null;
  $('acSignals').innerHTML = ring(`${Math.round(P.high)}°`, 'high', P.high / 105, '#ff9e66') + ring(P.sunKwhM2, 'sun', P.sunKwhM2 / 8, '#ffc15e') + ring(s.presence, 'presence', s.presence === 'home' ? 1 : .2, '#4ef0a6') + ring(soc != null ? Math.round(soc) + '%' : '—', 'powerwall', (soc ?? 0) / 100, '#6cc4ff') + ring(st?.humidity != null ? st.humidity + '%' : '—', 'humidity', (st?.humidity ?? 0) / 100, '#c4a2ff') + ring(S.ercot?.condition ?? '—', 'ercot', S.ercot?.eea ? .9 : .15, '#8d93a8');
  const days = d.week, X = i => 12 + i * 42; let o = ''; days.forEach((x, i) => { const px = X(i), tm = i === 0, hh = Math.max(4, (x.high - 70) / 35 * 56); o += `${tm ? `<rect x="${px - 2}" y="4" width="34" height="102" rx="8" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.1)"/>` : ''}<rect x="${px + 7}" y="${84 - hh}" width="16" height="${hh}" rx="4" fill="#ff9e66" opacity="${tm ? 1 : .7}"/>${x.precool ? `<rect x="${px + 7}" y="${84 - hh - 4 - x.depth * 6}" width="16" height="${x.depth * 6}" rx="3" fill="#4ef0a6"/>` : ''}<text x="${px + 15}" y="${84 - hh - 8 - (x.precool ? x.depth * 6 : 0)}" text-anchor="middle" fill="#f2f4f8" font-size="9.5" font-family="JetBrains Mono">${x.high}°</text><text x="${px + 15}" y="100" text-anchor="middle" fill="rgba(242,244,248,${tm ? .9 : .5})" font-size="9.5" font-family="Manrope">${new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</text>`; });
  $('acWeek').innerHTML = o;
  $('acTomorrow').textContent = days[1] ? `Tomorrow ${days[1].high}° · ${days[1].precool ? `pre-cool ${days[1].depth}°` : 'hold the band'}` : '';
  $('acLog').innerHTML = d.log.slice(0, 6).map(l => `<div><i></i><span>${niceDate(l.day, { month: 'short', day: 'numeric' })}</span><p>${l.text}${l.delta ? `<em>${l.delta}</em>` : ''}</p></div>`).join('') || `<div><i class="w"></i><span>—</span><p>No changes yet. Nest is sampled every 5 minutes to learn the AC's real draw.</p></div>`;
}
let timer;
export function initAc(S) { loadAc(S); clearInterval(timer); timer = setInterval(() => loadAc(S), 3 * 60_000); }
export async function loadAc(S) { S.ac = await api.ac().catch(e => ({ error: e.message, configured: false, linked: false })); if (S.ac.plan) drawAc(S); else { $('acBadge').textContent = 'Not set up'; $('acLink').hidden = false; $('acLinkTxt').textContent = S.ac.error ?? 'Nest is not configured.'; } }
