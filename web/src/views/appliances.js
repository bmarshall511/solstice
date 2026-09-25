import { $, money } from '../lib/util.js';
import { api } from '../lib/api.js';

/*
 * Appliances (Insights): the big loads, one at a time. Each gets the same cards: live, what today's schedule costs,
 * a smarter schedule for the season, and a season plan. Pool pump first; AC plugs into the same slots.
 */
const hm = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`; };
const COLORS = { pool: 'var(--home)', high: 'var(--warn)', water: 'var(--grid)' };
const colorFor = n => /high|boost/i.test(n) ? COLORS.high : /water|fall|feature/i.test(n) ? COLORS.water : COLORS.pool;
const timeline = (scheds, solarKw, maxRpm) => {
  const peak = Math.max(.1, ...solarKw), pts = solarKw.map((v, i) => `${i / 23 * 353},${60 - v / peak * 50}`).join(' ');
  const bars = scheds.map(s => { const w = ((s.stop > s.start ? s.stop - s.start : 1440 - s.start + s.stop) / 1440 * 100), h = 8 + s.rpm / maxRpm * 44;
    return `<div class="bar" style="left:${s.start / 1440 * 100}%;width:${w}%;height:${h}px;background:${colorFor(s.name)}" title="${s.name} · ${s.rpm} RPM · ${hm(s.start)}–${hm(s.stop)}"></div>`; }).join('');
  return `<div class="tl"><svg class="sun" viewBox="0 0 353 74" preserveAspectRatio="none"><polyline points="0,60 ${pts} 353,60" fill="rgba(255,193,94,.10)" stroke="rgba(255,193,94,.35)" stroke-width="1"/></svg>${bars}
    ${[0, 6, 12, 18].map(h => `<div class="lbl" style="left:${h / 24 * 100}%">${h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : h - 12 + 'p'}</div>`).join('')}<div class="lbl" style="right:0">12a</div></div>`;
};
const legend = scheds => `<div class="legend" style="justify-content:flex-start">${[...new Map(scheds.map(s => [s.name, s])).values()].map(s => `<span><i style="background:${colorFor(s.name)}"></i>${s.name} ${s.rpm.toLocaleString()}</span>`).join('')}<span><i style="background:rgba(255,193,94,.5)"></i>Your solar</span></div>`;

/** Power ring: watts against the pump's full-speed draw, RPM as the inner arc. */
const gauge = (watts, rpm, maxW = 2900, maxRpm = 3450) => {
  const r1 = 40, r2 = 31, C1 = 2 * Math.PI * r1, C2 = 2 * Math.PI * r2, fw = Math.min(1, watts / maxW), fr = Math.min(1, rpm / maxRpm);
  const col = fw > .5 ? '#ff7a66' : fw > .2 ? '#ffc15e' : '#4ef0a6';
  return `<svg width="100" height="100" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${r1}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7"/>
    <circle cx="50" cy="50" r="${r1}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C1 * fw} ${C1}" transform="rotate(-90 50 50)"/>
    <circle cx="50" cy="50" r="${r2}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="4"/>
    <circle cx="50" cy="50" r="${r2}" fill="none" stroke="rgba(108,196,255,.8)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C2 * fr} ${C2}" transform="rotate(-90 50 50)"/>
    <text x="50" y="48" text-anchor="middle" fill="#f2f4f8" font-size="19" font-family="Manrope" font-weight="300">${Math.round(watts)}</text>
    <text x="50" y="61" text-anchor="middle" fill="rgba(242,244,248,.5)" font-size="8.5" font-family="Manrope">watts</text>
    <text x="50" y="72" text-anchor="middle" fill="rgba(108,196,255,.9)" font-size="8" font-family="JetBrains Mono">${rpm ? rpm.toLocaleString() + ' rpm' : 'off'}</text></svg>`;
};

/** Speed → watts curve with the program speeds marked, measured points as dots and the live operating point. */
const curveChart = (model, programs, live) => {
  const W = 310, H = 130, x = r => 14 + (r - 450) / 3000 * (W - 28), y = w => H - 22 - w / 3000 * (H - 40);
  const pts = []; for (let r = 450; r <= 3450; r += 50) { const lo = model.curve.filter(c => c.rpm <= r).at(-1) ?? model.curve[0], hi = model.curve.find(c => c.rpm >= r) ?? model.curve.at(-1);
    const w = lo === hi || hi.rpm === lo.rpm ? lo.watts : lo.watts * (r / lo.rpm) ** (Math.log(hi.watts / lo.watts) / Math.log(hi.rpm / lo.rpm)); pts.push(`${x(r)},${y(w)}`); }
  const wAt = r => { const lo = model.curve.filter(c => c.rpm <= r).at(-1) ?? model.curve[0], hi = model.curve.find(c => c.rpm >= r) ?? model.curve.at(-1); return lo === hi || hi.rpm === lo.rpm ? lo.watts : lo.watts * (r / lo.rpm) ** (Math.log(hi.watts / lo.watts) / Math.log(hi.rpm / lo.rpm)); };
  const marks = [...new Map(programs.map(p => [p.rpm, p])).values()].map(p => `<line x1="${x(p.rpm)}" y1="${y(wAt(p.rpm))}" x2="${x(p.rpm)}" y2="${H - 22}" stroke="${colorFor(p.name)}" stroke-dasharray="2 3" opacity=".7"/><circle cx="${x(p.rpm)}" cy="${y(wAt(p.rpm))}" r="3.5" fill="${colorFor(p.name)}"/>
    <text x="${x(p.rpm)}" y="${H - 11}" text-anchor="middle" fill="rgba(242,244,248,.55)" font-size="8.5" font-family="JetBrains Mono">${p.rpm}</text>`).join('');
  const meas = model.measured.map(m => `<circle cx="${x(m.rpm)}" cy="${y(m.watts)}" r="3" fill="none" stroke="#fff" stroke-width="1.5"/>`).join('');
  const now = live?.running ? `<circle cx="${x(live.rpm)}" cy="${y(live.watts)}" r="6" fill="rgba(78,240,166,.25)"/><circle cx="${x(live.rpm)}" cy="${y(live.watts)}" r="3" fill="#4ef0a6"/>` : '';
  return `<svg class="mini" viewBox="0 0 ${W} ${H}">${[1000, 2000, 3000].map(w => `<line x1="14" x2="${W - 14}" y1="${y(w)}" y2="${y(w)}" stroke="rgba(255,255,255,.07)"/><text x="${W - 12}" y="${y(w) + 3}" fill="rgba(242,244,248,.4)" font-size="8" font-family="JetBrains Mono">${w / 1000}kW</text>`).join('')}
    <polyline points="${pts.join(' ')}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.5"/>${marks}${meas}${now}</svg>`;
};

/** kWh/day per season as bars, current season highlighted. */
const seasonBars = seasons => { const mx = Math.max(.1, ...seasons.map(s => s.kwhPerDay));
  return `<svg class="mini" viewBox="0 0 310 90">${seasons.map((s, i) => { const x = 20 + i * 72, h = s.kwhPerDay / mx * 50;
    return `<rect x="${x}" y="${66 - h}" width="48" height="${h}" rx="4" fill="${s.current ? 'var(--solar)' : 'rgba(255,255,255,.18)'}"/><text x="${x + 24}" y="${60 - h}" text-anchor="middle" fill="#f2f4f8" font-size="10" font-family="JetBrains Mono">${s.kwhPerDay}</text><text x="${x + 24}" y="80" text-anchor="middle" fill="rgba(242,244,248,.5)" font-size="9" font-family="Manrope">${s.label}</text>`; }).join('')}</svg>`; };

let timer;
export function initAppliances(S) { load(S); clearInterval(timer); timer = setInterval(() => load(S), 3 * 60_000); }
async function load(S) {
  const list = await api.appliances().catch(() => null); if (!list) return;
  $('applStrip').innerHTML = list.map(a => `<div class="app ${a.status === 'coming' ? 'dim' : 'on'}" data-appl="${a.id}"><i></i>${a.name}${a.status === 'coming' ? ' · coming' : a.watts != null ? ` · ${a.watts} W` : ''}</div>`).join('');
  const d = await api.pool().catch(e => ({ error: e.message })); S.pool = d;
  drawPool(S);
}

export function drawPool(S) {
  const d = S.pool; if (!d) return;
  const L = d.live, sp = d.settings, maxRpm = 3450;
  ['poolNow', 'poolPlan', 'poolSeason'].forEach(id => $(id).hidden = !(d.linked || L));
  if (!d.linked && !L) { $('poolLive').innerHTML = `<div class="h"><b>Pool pump</b><span class="badge">Not linked</span></div><p>${d.error ?? 'Add the ScreenLogic system name and password to link the pool.'}</p>`; return; }
  $('poolLive').innerHTML = `<div class="h"><b>Pool pump</b><span class="badge g">Linked · ScreenLogic</span></div>
    <div class="cleanrow">${gauge(L?.watts ?? 0, L?.rpm ?? 0)}<p><b style="color:var(--text)">${L ? (L.running ? `${L.on.filter(n => !/light/i.test(n)).join(' + ') || 'Running'}` : 'Off') : '—'}</b>${L?.freezeMode ? ' · freeze mode' : ''}<br>${L?.running ? `Drawing ${Math.round(L.watts)} W at ${L.rpm.toLocaleString()} RPM, about ${Math.round(45 * L.rpm / 1500)} GPM.` : 'The pump is idle.'} Outer ring is power against full speed (2.9 kW), inner ring is speed.</p></div>
    <div class="two">
      <div class="stat"><small>Water · air</small><b>${L ? `${L.waterTemp}° · ${L.airTemp}°` : '—'}</b></div>
      <div class="stat"><small>Today so far</small><b>${d.todayKwh} kWh · $${d.todayCost.toFixed(2)}</b></div>
      <div class="stat"><small>Share of home today</small><b>${d.shareOfHomePct != null ? d.shareOfHomePct + '%' : '—'}</b></div>
      <div class="stat"><small>Measured speeds</small><b>${d.model.measured.length ? d.model.measured.map(m => `${m.rpm}→${Math.round(m.watts)}W`).join(' · ') : 'learning'}</b></div>
    </div>
    <p>IntelliFlo VSF on a Quad D.E. 80 filter, ${sp.gallons.toLocaleString()} gallons. Freeze protection (2,400 RPM) is never touched.${d.error ? ` <span style="color:var(--warn)">Last read failed: ${d.error}</span>` : ''}</p>`;

  const C = d.current;
  $('poolNow').innerHTML = `<div class="h"><b>Your schedule today</b><span class="badge${C.kwhPerDay > 8 ? '' : ' g'}">≈ ${C.kwhPerDay} kWh · ${money(C.costPerMonth)}/mo</span></div>
    ${timeline(C.schedules, d.solarKw, maxRpm)}${legend(C.schedules)}
    <div class="kv">${C.byProgram.map(p => `<span>${p.name}, ${p.rpm.toLocaleString()} RPM, ${hm(p.start)}–${hm(p.stop)}</span><b${p.kwhPerDay > 5 ? ' style="color:var(--warn)"' : ''}>${p.kwhPerDay} kWh/day</b>`).join('')}
      <span>Water turned over</span><b>${C.turnoverPerDay}× a day</b><span>Runs while the sun is up</span><b>${C.onSolarPct}%</b></div>
    ${curveChart(d.model, C.schedules, L)}
    <div class="legend" style="justify-content:flex-start"><span><i style="background:#4ef0a6"></i>Right now</span><span><i style="background:rgba(255,255,255,.55)"></i>Speed → watts</span><span><i style="border:1.5px solid #fff;background:none"></i>Measured</span></div>
    <p>${C.schedules.length ? 'When two pump programs overlap, the controller runs the faster one. Pump power rises with roughly the cube of speed, so a program at 3,400 RPM costs about ten times one at 1,800.' : 'No pump schedules on the controller.'}</p>`;

  const P = d.plan, month = new Date().toLocaleDateString('en-US', { month: 'long' });
  const saves = C.costPerMonth - P.costPerMonth, applied = d.applied;
  $('poolPlan').innerHTML = `<div class="h"><b>Smarter for ${month}</b><span class="badge g">≈ ${P.kwhPerDay} kWh · ${money(P.costPerMonth)}/mo</span></div>
    ${timeline(P.schedules, d.solarKw, maxRpm)}${legend(P.schedules)}
    <div class="cmp"><span class="hd">Per day</span><span class="hd">Now</span><span class="hd">Smarter</span>
      <span>Hours running</span><span class="n">${C.hours} h</span><b>${P.hours + P.boostHours} h</b>
      <span>Water turned over</span><span class="n">${C.turnoverPerDay}×</span><b>${P.turnoverPerDay}×</b>
      <span>Electricity</span><span class="n">${C.kwhPerDay} kWh</span><b class="${P.kwhPerDay < C.kwhPerDay ? 'up' : ''}">${P.kwhPerDay} kWh</b>
      <span>Cost per month</span><span class="n">${money(C.costPerMonth)}</span><b class="${saves > 0 ? 'up' : ''}">${money(P.costPerMonth)}</b>
      <span>On solar</span><span class="n">${C.onSolarPct}%</span><b class="up">${P.onSolarPct}%</b></div>
    <div class="rec"><b>Water is ${P.waterTemp}°F${P.waterTemp >= 80 ? ' and the pool is in daily use' : P.waterTemp < 60 ? ' and the pool is resting for winter' : ''}</b>, so ${P.turnovers >= 1 ? `${P.turnovers === 1 ? 'one full turnover' : P.turnovers + ' turnovers'} a day` : 'a partial turnover a day'} at low speed keeps it clear. ${P.schedules.map(s => s.why[0].toUpperCase() + s.why.slice(1)).join('. ')}. The waterfall stays a manual feature: run it when you're outside and its ${sp.featureCircuits.length ? 'egg timer' : 'timer'} shuts it off. Nothing overnight, so your Powerwalls stay fuller for the evening. Your robot cleaner doesn't need the pump, so there's no high-speed cleaning window.</div>
    <div class="kv" id="poolSteps" style="display:none">${P.schedules.map(s => `<span>${s.name} · speed</span><b>${s.rpm.toLocaleString()} RPM</b><span>${s.name} · schedule</span><b>${hm(s.start)}–${hm(s.stop)} every day</b>`).join('')}<span>Waterfall, High Speed (old)</span><b>remove their schedules</b></div>
    ${applied ? `<p class="fine" style="margin-top:10px">Applied to ScreenLogic ${new Date(applied.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. <button class="link" id="poolRestore" style="margin:0 0 0 6px;padding:4px 10px">Restore the previous schedule</button></p>`
      : `<a class="primary" id="poolApply">Apply to ScreenLogic</a><button class="link" id="poolShow">Show me the settings instead</button>`}
    <p class="fine">Estimates use ${d.model.measured.length ? 'this pump’s measured watts' : 'Pentair’s IntelliFlo curve'} and your PEC rate of $${d.rate}/kWh. Flow is estimated at ${Math.round(45 * sp.filterRpm / 1500)} GPM at ${sp.filterRpm.toLocaleString()} RPM (this pump has no flow meter).</p>`;
  const show = $('poolShow'); if (show) show.onclick = () => { const el = $('poolSteps'); el.style.display = el.style.display === 'none' ? 'grid' : 'none'; };
  const apply = $('poolApply'); if (apply) apply.onclick = async () => {
    if (!confirm(`Rewrite the pump schedules on ScreenLogic?\n\n${P.schedules.map(s => `• ${s.name}: ${s.rpm} RPM, ${hm(s.start)}–${hm(s.stop)} daily`).join('\n')}\n• Remove the old Waterfall / High Speed / Pool schedules\n\nLights, spa and freeze protection are untouched. You can restore the previous schedule afterwards.`)) return;
    apply.textContent = 'Applying…';
    try { await api.poolApply(); S.pool = await api.pool(); drawPool(S); } catch (e) { alert(`Couldn’t apply: ${e.message}`); apply.textContent = 'Apply to ScreenLogic'; }
  };
  const restore = $('poolRestore'); if (restore) restore.onclick = async () => {
    if (!confirm('Put back the schedules and speeds that were there before Solstice changed them?')) return;
    restore.textContent = 'Restoring…';
    try { await api.poolRestore(); S.pool = await api.pool(); drawPool(S); } catch (e) { alert(`Couldn’t restore: ${e.message}`); }
  };

  $('poolSeason').innerHTML = `<div class="h"><b>Season plan</b><span>follows the water temperature</span></div>
    ${seasonBars(d.seasons)}
    <div class="season"><span class="hd">When</span><span class="hd">Filtration</span><span class="hd">kWh/d</span><span class="hd">$/mo</span>
    ${d.seasons.map(s => `<span class="${s.current ? 'cur' : ''}">${s.label}</span><span class="${s.current ? 'cur' : ''}">${s.rpm.toLocaleString()} RPM · ${s.hours} h${s.boostHours ? ' + 1 h boost' : ''} · water ~${s.waterTemp}°</span><b>${s.kwhPerDay}</b><b>${money(s.costPerMonth)}</b>`).join('')}</div>
    <p>Rule of thumb built in: about one hour of filtration per 10°F of water temperature, at least one turnover a day, more when it's warm. Solstice re-plans from the live water temperature and tells you when the season's plan changes; it never rewrites ScreenLogic on its own.</p>`;
}
