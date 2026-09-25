import { $, money, money2, niceDate } from '../lib/util.js';
import { api } from '../lib/api.js';
import { createPoolTwin } from '../scenes/pooltwin.js';

/*
 * Appliances (Insights): the big loads, one at a time. Pool pump first: the flow twin, the schedule dial
 * (now vs recommended), Autopilot, and the season chips. AC (Nest) plugs into the same slots next.
 */
const hm = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`; };
const colorFor = n => /high|boost/i.test(n) ? '#ff7a66' : /water|fall|feature/i.test(n) ? '#c4a2ff' : '#6cc4ff';
const CIRCUITS = [['Pool', 'pool'], ['Spa', 'spa'], ['Waterfall', 'waterfall'], ['Jets', 'jets'], ['Air Blower', 'blower'], ['Pool Light', 'lights'], ['Spa Light', 'lights']];

let twin = null, timer, schMode = 'rec';
export function initAppliances(S) { load(S); clearInterval(timer); timer = setInterval(() => load(S), 3 * 60_000); }
export const poolTwin = () => twin;

async function load(S) {
  const list = await api.appliances().catch(() => null);
  if (list) { const cur = document.querySelector('#applStrip .app.on')?.dataset.id ?? 'pool'; $('applStrip').innerHTML = list.map(a => `<div class="app ${a.status === 'coming' ? 'dim' : a.id === cur ? 'on' : ''}" data-id="${a.id}"><i></i>${a.name}${a.status === 'coming' ? ` · ${a.source}, next` : a.watts != null ? ` · ${Math.round(a.watts)} W` : ''}</div>`).join(''); }
  const d = await api.pool().catch(e => ({ error: e.message })); S.pool = d;
  drawPool(S); S.onPool?.();
}

/** The flow twin's state from the ScreenLogic snapshot. */
function twinState(d) {
  const L = d.live, on = new Set(L?.on ?? []), snap = d.snapshot;
  const st = { pool: false, spa: false, waterfall: false, jets: false, blower: false, heater: false, lights: false, rpm: L?.rpm ?? 0, watts: L?.watts ?? 0,
    poolTemp: snap?.bodies?.[0]?.temp ?? null, spaTemp: snap?.bodies?.[1]?.temp ?? null, spaSet: snap?.bodies?.[1]?.setPoint ?? null };
  CIRCUITS.forEach(([name, key]) => { if (on.has(name)) st[key] = true; });
  st.heater = !!snap?.bodies?.some(b => b.heating);
  if (!L?.running) { st.pool = st.spa = st.waterfall = st.jets = st.blower = false; }
  return st;
}

export function drawPool(S) {
  const d = S.pool; if (!d) return;
  const L = d.live, sp = d.settings, linked = d.linked || !!L;
  ['poolSched', 'poolAuto', 'poolSeason', 'poolSeasonNote'].forEach(id => $(id).hidden = !linked);
  $('poolBadge').textContent = linked ? 'Linked · ScreenLogic' : 'Not linked'; $('poolBadge').className = 'badge' + (linked ? ' g' : '');
  if (!linked) { $('poolHud').textContent = d.error ?? 'Add the ScreenLogic system name and password to link the pool.'; return; }
  if (!twin) twin = createPoolTwin($('poolTwin'));
  const st = twinState(d); twin.set(st);
  const running = L?.running, names = (L?.on ?? []).filter(n => !/light/i.test(n));
  const ex = d.extras ?? { nowW: 0, todayKwh: 0 };
  $('poolHud').innerHTML = `${running ? (names.join(' + ') || 'Running') + ` · ${L.rpm.toLocaleString()} RPM · ${Math.round(L.watts)} W` : 'Pump off'}${ex.nowW ? ` · +${ex.nowW} W ${[st.blower ? 'blower' : '', st.lights ? 'lights' : '', running && d.settings.uv ? 'UV' : ''].filter(Boolean).join('/')}` : ''}${st.heater ? ' · heater' : ''}${L?.freezeMode ? ' · freeze mode' : ''}`;
  $('poolCirc').innerHTML = [['Pool', st.pool], ['Spa', st.spa], ['Sheer descent', st.waterfall], ['Jets', st.jets], ['Air blower', st.blower], ['Heater', st.heater], ['Lights', st.lights]].map(([n, on]) => `<span class="${on ? 'on' : ''}">${n}</span>`).join('');
  const ss = d.spaSession;
  $('poolStats').innerHTML = `<div class="stat"><small>Pump</small><b>${running ? `${Math.round(L.watts)} W · ${L.rpm.toLocaleString()} rpm` : 'off'}</b></div><div class="stat"><small>Today</small><b>${d.todayKwh} kWh${d.shareOfHomePct != null ? ` · ${d.shareOfHomePct}%` : ''}</b></div>
    <div class="stat"><small>Pool · spa · air</small><b>${st.poolTemp ?? '—'}° · ${st.spaTemp ?? '—'}° · ${L?.airTemp ?? '—'}°</b></div><div class="stat"><small>Turnover</small><b>${d.current.turnoverPerDay}× a day</b></div>`
    + (ss && ss.riseF != null ? `<div class="stat" style="grid-column:1/-1"><small>Spa session · ${ss.spaTemp}° → ${ss.spaSet}°</small><b>${ss.riseF ? `${ss.heatMinutes} min of propane · ${ss.propaneGal} gal ≈ $${ss.propaneUsd.toFixed(2)}` : 'already at temperature'} · then ${money2(ss.electricUsdPerHour)}/h pump + blower</b></div>` : '');
  $('poolNote').innerHTML = `IntelliFlo VSF on a Quad D.E. 80 filter, ${sp.gallons.toLocaleString()} gal. Streams follow the water: skimmer → pump → filter → heater → returns; green is the spa loop, purple the sheer-descent feed. Speed follows the pump's RPM. Lights are 500 W + 100 W incandescent, the blower 1.1 kW, the UV lamp ~60 W while the pump runs.${d.model.measured.length ? ` Measured: ${d.model.measured.map(m => `${m.rpm}→${Math.round(m.watts)} W`).join(', ')}.` : ''}${d.error ? ` <span style="color:var(--warn)">Last read failed: ${d.error}</span>` : ''}`;
  drawDial(S); drawAutopilot(S);
  $('poolSeason').innerHTML = d.seasons.map(s => `<div class="${s.current ? 'cur' : ''}"><b>${s.kwhPerDay}</b>${s.label}</div>`).join('');
}

/* ---------- 24-hour dial: now vs recommended ---------- */
function drawDial(S) {
  const d = S.pool, C = d.current, P = d.plan, sp = d.settings, svg = $('dial24'), cx = 160, cy = 160;
  const A = h => h / 24 * Math.PI * 2 + Math.PI / 2, pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const arc = (r, m0, m1) => { const h0 = m0 / 60, h1 = m1 / 60; const [x0, y0] = pt(r, A(h0)), [x1, y1] = pt(r, A(h1)); return `M${x0} ${y0} A${r} ${r} 0 ${h1 - h0 > 12 ? 1 : 0} 1 ${x1} ${y1}`; };
  const sunH = d.solarKw.map((v, i) => [v, i]).filter(([v]) => v > .3).map(([, i]) => i), sun0 = sunH[0] ?? 7, sun1 = (sunH.at(-1) ?? 18) + 1;
  let o = `<defs><filter id="dgl"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="dsun" x1="0" x2="1"><stop offset="0" stop-color="#ffc15e" stop-opacity=".1"/><stop offset=".5" stop-color="#ffc15e" stop-opacity=".9"/><stop offset="1" stop-color="#ffc15e" stop-opacity=".1"/></linearGradient></defs>`;
  for (let h = 0; h < 24; h++) { const [x0, y0] = pt(140, A(h)), [x1, y1] = pt(h % 6 ? 144 : 150, A(h)); o += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="rgba(255,255,255,${h % 6 ? .12 : .35})"/>`; }
  [['12a', 0], ['6a', 6], ['12p', 12], ['6p', 18]].forEach(([l, h]) => { const [x, y] = pt(128, A(h)); o += `<text x="${x}" y="${y + 3.5}" text-anchor="middle" fill="rgba(242,244,248,.5)" font-size="10" font-family="JetBrains Mono">${l}</text>`; });
  o += `<path d="${arc(150, sun0 * 60, sun1 * 60)}" fill="none" stroke="url(#dsun)" stroke-width="5" stroke-linecap="round"/>`;
  o += `<circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="18"/><circle cx="${cx}" cy="${cy}" r="88" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="18"/>`;
  const seg = (r, s, cls) => `<path class="${cls}" d="${arc(r, s.start, s.stop)}" fill="none" stroke="${colorFor(s.name)}" stroke-width="${8 + s.rpm / 3450 * 12}" stroke-linecap="round" filter="url(#dgl)" style="transition:opacity .5s"><title>${s.name} · ${s.rpm.toLocaleString()} RPM · ${hm(s.start)}–${hm(s.stop)}</title></path>`;
  C.schedules.forEach(s => o += seg(112, s, 'dn')); P.schedules.forEach(s => o += seg(88, s, 'dr'));
  const nowH = new Date().getHours() + new Date().getMinutes() / 60, [mx, my] = pt(104, A(nowH)), [mx2, my2] = pt(158, A(nowH)); o += `<line x1="${mx}" y1="${my}" x2="${mx2}" y2="${my2}" stroke="#fff" stroke-opacity=".6" stroke-width="1.5"/><circle cx="${mx2}" cy="${my2}" r="3" fill="#fff"/>`;
  svg.innerHTML = o;
  const set = m => { schMode = m; svg.querySelectorAll('.dn').forEach(p => p.style.opacity = m === 'rec' ? 0 : m === 'both' ? .55 : .95); svg.querySelectorAll('.dr').forEach(p => p.style.opacity = m === 'now' ? 0 : .95);
    $('dcLbl').textContent = m === 'now' ? 'Now' : m === 'rec' ? 'Recommended' : 'Now → Recommended';
    $('dcKwh').innerHTML = m === 'now' ? `${C.kwhPerDay} <i>kWh/day</i>` : m === 'rec' ? `${P.kwhPerDay} <i>kWh/day</i>` : `${C.kwhPerDay} → ${P.kwhPerDay} <i>kWh/day</i>`;
    $('dcSub').textContent = m === 'now' ? `${C.hours} h · ${money(C.costPerMonth)}/mo · ${C.onSolarPct}% on solar` : m === 'rec' ? `${P.hours + P.boostHours} h · ${money(P.costPerMonth)}/mo · ${P.onSolarPct}% on solar` : 'outer: now · inner: recommended';
    $('schNow').hidden = m !== 'now'; $('schRec').hidden = m === 'now'; document.querySelectorAll('#schMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); };
  $('schMode').onclick = e => { const b = e.target.closest('button'); if (b) set(b.dataset.m); };
  // Now: what each program costs
  $('schNow').innerHTML = `<div class="kv" style="margin-top:10px">${C.byProgram.map(p => `<span>${p.name} · ${p.rpm.toLocaleString()} RPM · ${hm(p.start)}–${hm(p.stop)}</span><b${p.kwhPerDay > 5 ? ' style="color:var(--warn)"' : ''}>${p.kwhPerDay} kWh</b>`).join('')}<span>Total per day</span><b>${C.kwhPerDay} kWh · ${money2(d.rate == null ? null : C.kwhPerDay * d.rate)}</b></div>
    <p>${C.schedules.length ? 'When two pump programs overlap, the controller runs the faster one. Switch to <b style="color:var(--text)">Recommended</b> to see the fix.' : 'No pump schedules on the controller.'}</p>`;
  // Recommended: deltas, reasons, apply
  const dk = C.kwhPerDay - P.kwhPerDay, dc = C.costPerMonth == null || P.costPerMonth == null ? null : C.costPerMonth - P.costPerMonth, topNow = Math.max(0, ...C.schedules.map(s => s.rpm)), topRec = Math.max(0, ...P.schedules.map(s => s.rpm));
  $('schDeltas').innerHTML = `<div><small>Electricity</small><b>${dk >= 0 ? '−' : '+'}${Math.abs(dk).toFixed(dk % 1 ? 1 : 0)} kWh</b><span>per day</span></div><div><small>Cost</small><b>${dc == null ? '—' : `${dc >= 0 ? '−' : '+'}$${Math.abs(dc)}`}</b><span>per month</span></div>
    <div><small>Turnover</small><b>${C.turnoverPerDay}× → ${P.turnoverPerDay}×</b><span>${P.turnoverPerDay >= 1 ? 'still one a day' : 'partial in winter'}</span></div><div><small>Top speed</small><b>${topNow.toLocaleString()} → ${topRec.toLocaleString()}</b><span>RPM</span></div>`;
  const Wc = d.model.curve, wAt = r => Wc.reduce((a, c) => Math.abs(c.rpm - r) < Math.abs(a.rpm - r) ? c : a).watts;
  const why = [['⚡', 'Speed³', `Power rises with the cube of RPM. ${topNow ? `${topNow.toLocaleString()} RPM draws ${(wAt(topNow) / 1000).toFixed(1)} kW, ` : ''}${sp.filterRpm.toLocaleString()} RPM draws ${(wAt(sp.filterRpm) / 1000).toFixed(2)} kW.`],
    ['↻', P.turnovers >= 1 ? 'One turnover' : 'A partial turnover', `${sp.gallons.toLocaleString()} gal at ~${Math.round(sp.designGpm * sp.filterRpm / 3450)} GPM is ${(sp.gallons / (sp.designGpm * sp.filterRpm / 3450 * 60)).toFixed(1)} h. At ${P.waterTemp}°F you get ${P.hours} h.${C.turnoverPerDay > 2 ? ` Today's schedule does it ${C.turnoverPerDay} times.` : ''}`],
    ['☀', 'Under the sun', `${hm(P.start * 60)}–${hm(P.stop * 60)} sits inside your solar curve, so the pump runs on free power and the Powerwalls reach evening fuller. Nothing overnight.`],
    ['✦', 'Still clean', `${P.boostHours ? `A 1 h skim boost at ${hm(P.boostAt * 60)} for surface debris; ` : 'No boost needed; '}the robot handles the floor; the D.E. filter runs at lower pressure.`],
    ['💧', 'UV works on flow', `Your Ultra UV unit only sanitizes water passing through it, so hours of steady flow do more than short fast runs, and chlorine demand stays lower. It draws about 60 W while the pump runs (${P.uvKwh ?? 0} kWh a day).`],
    ['🔒', 'Untouched', 'Freeze protection, spa, heater and lights. The waterfall stays a manual feature with its timer.']];
  $('schWhy').innerHTML = why.map(([i, b, p]) => `<div><i>${i}</i><b>${b}</b><p>${p}</p></div>`).join('');
  $('schDots').innerHTML = why.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('');
  const rs = $('schWhy'); rs.onscroll = () => { const i = Math.round(rs.scrollLeft / (rs.children[0].offsetWidth + 10)); [...$('schDots').children].forEach((x, k) => x.classList.toggle('on', k === i)); };
  $('schSteps').innerHTML = P.schedules.map(s => `<span>${s.name} · speed</span><b>${s.rpm.toLocaleString()} RPM</b><span>${s.name} · schedule</span><b>${hm(s.start)}–${hm(s.stop)} every day</b>`).join('') + `<span>Other pump schedules</span><b>remove</b>`;
  const applied = d.applied;
  $('schActions').innerHTML = applied ? `<p class="fine" style="margin-top:10px">Applied to ScreenLogic ${new Date(applied.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. <button class="link" id="poolRestore" style="margin:0 0 0 6px;padding:4px 10px">Restore the previous schedule</button></p>`
    : `<button class="primary" id="poolApply">Apply to ScreenLogic</button><button class="link" id="poolShow">Show the settings instead</button>`;
  const show = $('poolShow'); if (show) show.onclick = () => { const el = $('schSteps'); el.style.display = el.style.display === 'none' ? 'grid' : 'none'; };
  const apply = $('poolApply'); if (apply) apply.onclick = async () => {
    if (!confirm(`Rewrite the pump schedules on ScreenLogic?\n\n${P.schedules.map(s => `• ${s.name}: ${s.rpm} RPM, ${hm(s.start)}–${hm(s.stop)} daily`).join('\n')}\n• Remove the other pump schedules\n\nLights, spa, heater and freeze protection are untouched. You can restore the previous schedule afterwards.`)) return;
    apply.textContent = 'Applying…'; try { await api.poolApply(); await load(S); } catch (e) { alert(`Couldn’t apply: ${e.message}`); apply.textContent = 'Apply to ScreenLogic'; } };
  const restore = $('poolRestore'); if (restore) restore.onclick = async () => { if (!confirm('Put back the schedules and speeds that were there before Solstice changed them?')) return; restore.textContent = 'Restoring…'; try { await api.poolRestore(); await load(S); } catch (e) { alert(`Couldn’t restore: ${e.message}`); } };
  set(schMode);
}

/* ---------- Autopilot ---------- */
function drawAutopilot(S) {
  const d = S.pool, a = d.autopilot; if (!a || a.error) { $('autoStatus').innerHTML = `<i class="off"></i><span>${a?.error ?? 'Autopilot unavailable'}</span>`; return; }
  document.querySelectorAll('#autoMode button').forEach(b => b.classList.toggle('on', b.dataset.m === a.mode));
  $('autoMode').onclick = async e => { const b = e.target.closest('button'); if (!b || b.dataset.m === a.mode) return;
    if (b.dataset.m === 'auto' && !confirm('Auto mode writes tomorrow’s schedule to ScreenLogic every evening without asking. Spa, heater, lights and freeze protection are never touched. Turn it on?')) return;
    await api.poolAutopilot(b.dataset.m).catch(err => alert(err.message)); await load(S); };
  const next = new Date(a.nextRunAt), last = a.log[0];
  $('autoStatus').innerHTML = `<i class="${a.mode === 'off' ? 'off' : ''}"></i><span>${a.mode === 'off' ? 'Off. Turn on Suggest to get a plan for tomorrow each evening, or Auto to have it applied.' : `${a.mode === 'auto' ? 'Writes' : 'Suggests'} tomorrow's plan tonight at <b>${next.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</b>${last ? ` · last ${niceDate(last.day, { month: 'short', day: 'numeric' })}` : ''} · never touches spa, heater, lights or freeze protection`}</span>`;
  const g = a.signals, ring = (v, l, f, c) => { const C = 2 * Math.PI * 17; return `<div><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3.5"/><circle cx="22" cy="22" r="17" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${C * Math.max(0, Math.min(1, f))} ${C}" transform="rotate(-90 22 22)"/></svg><b>${v}</b><small>${l}</small></div>`; };
  $('autoSignals').innerHTML = ring(`${g.waterTemp}°`, 'water', g.waterTemp / 100, '#6cc4ff') + ring(g.sunKwhM2, 'sun', g.sunPct / 100, '#ffc15e') + ring(`${g.high}°`, 'high', g.high / 105, '#ff9e66') + ring(`${g.rainPct}%`, 'rain', g.rainPct / 100, '#c4a2ff') + ring(`${g.useDays}/7`, 'use days', g.useDays / 7, '#4ef0a6') + ring(g.pollen, 'pollen', g.pollen === 'high' ? .9 : g.pollen === 'medium' ? .5 : .15, '#8d93a8');
  const T = a.tomorrow; $('autoTomorrow').textContent = `Tomorrow ${T.plan.hours} h${T.plan.boostHours ? ' + boost' : ''}${T.why.length ? ' · ' + T.why[0].split(':')[0] : ''}`;
  const days = a.week, X = i => 12 + i * 42, mxSun = Math.max(1, ...days.map(x => x.sunKwhM2));
  let o = `<defs><linearGradient id="asg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc15e" stop-opacity=".45"/><stop offset="1" stop-color="#ffc15e" stop-opacity="0"/></linearGradient></defs>`;
  const Y = v => 88 - v / mxSun * 38, pts = days.map((x, i) => `${X(i) + 15},${Y(x.sunKwhM2)}`); if (days.length) o += `<path d="M${X(0) + 15},84 L${pts.join(' L')} L${X(days.length - 1) + 15},84 Z" fill="url(#asg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="#ffc15e" stroke-opacity=".7" stroke-width="1.5"/>`;
  days.forEach((x, i) => { const px = X(i), hh = x.hours / 12 * 56, tm = i === 0; o += `${tm ? `<rect x="${px - 2}" y="4" width="34" height="102" rx="8" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.1)"/>` : ''}<rect x="${px + 7}" y="${84 - hh}" width="16" height="${hh}" rx="4" fill="#6cc4ff" opacity="${tm ? 1 : .75}"/>${x.boost ? `<circle cx="${px + 15}" cy="${84 - hh - 6}" r="3" fill="#ff7a66"/>` : ''}<text x="${px + 15}" y="${84 - hh - (x.boost ? 14 : 6)}" text-anchor="middle" fill="#f2f4f8" font-size="9.5" font-family="JetBrains Mono">${x.hours}h</text><text x="${px + 15}" y="100" text-anchor="middle" fill="rgba(242,244,248,${tm ? .9 : .5})" font-size="9.5" font-family="Manrope">${new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</text>${x.rainPct >= 60 ? `<text x="${px + 15}" y="${84 - hh - 18 - (x.boost ? 8 : 0)}" text-anchor="middle" fill="#c4a2ff" font-size="9" font-family="Manrope">rain</text>` : ''}`; });
  $('autoWeek').innerHTML = o;
  $('autoPending').innerHTML = a.pending && d.pending ? `<div class="rec" style="margin-top:12px"><b>Suggested for ${niceDate(d.pending.date, { weekday: 'long' })}:</b> ${d.pending.plan.hours} h at ${d.settings.filterRpm.toLocaleString()} RPM, ${hm(d.pending.plan.start * 60)}–${hm(d.pending.plan.stop * 60)}${d.pending.plan.boostHours ? `, skim boost at ${hm(d.pending.plan.boostAt * 60)}` : ''}. ${d.pending.why.join('; ') || 'Season plan.'}<button class="primary" id="applyTomorrow" style="margin-top:10px">Apply tomorrow’s plan</button></div>` : '';
  const at = $('applyTomorrow'); if (at) at.onclick = async () => { at.textContent = 'Applying…'; try { await api.poolApplyTomorrow(); await load(S); } catch (e) { alert(e.message); at.textContent = 'Apply tomorrow’s plan'; } };
  $('autoLog').innerHTML = (a.log.length ? a.log.slice(0, 6).map(l => `<div><i></i><span>${niceDate(l.day, { month: 'short', day: 'numeric' })}</span><p>${l.text}${l.delta ? `<em>${l.delta}</em>` : ''}</p></div>`).join('') : '')
    + `<div><i class="w"></i><span>filter</span><p>About ${a.filterHours} run hours since ${a.filterCleanedOn ? `the D.E. cleaning on ${niceDate(a.filterCleanedOn)}` : 'Solstice started counting'}. <button class="link" id="logClean" style="margin:4px 0 0;padding:4px 10px">I cleaned the filter</button></p></div>`;
  $('logClean').onclick = async () => { await api.addEvent('filter_cleaned', new Date().toLocaleDateString('en-CA')); await load(S); };
}
