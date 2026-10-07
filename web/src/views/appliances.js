import { $, money, money2, niceDate, localHour } from '../lib/util.js';
import { api } from '../lib/api.js';
import { poolBackLabel } from '../lib/vacation.js';
import { every, stop } from '../lib/poll.js';
import { createPoolTwin } from '../scenes/pooltwin.js';
import { veil, nameStart, esc } from '../lib/frost.js';
import { confChip, modelOf } from '../lib/conf.js';

/*
 * Appliances (Insights): the big loads, one at a time. Pool pump first: the flow twin, the schedule dial
 * (now vs recommended), Autopilot, and the season chips. AC (Nest) plugs into the same slots next.
 */
const hm = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`; };
const colorFor = n => /high|boost/i.test(n) ? '#ff7a66' : /water|fall|feature/i.test(n) ? '#c4a2ff' : '#6cc4ff';
const CIRCUITS = [['Pool', 'pool'], ['Spa', 'spa'], ['Waterfall', 'waterfall'], ['Jets', 'jets'], ['Air Blower', 'blower'], ['Pool Light', 'lights'], ['Spa Light', 'lights']];

let twin = null, timer;
/** Started by main.js once the role is known (and again when it changes); every 3 minutes while the tab is visible. */
export function initAppliances(S) { stop(timer); timer = every(3 * 60_000, () => load(S)); }
export const poolTwin = () => twin;
/** Leaving the Pool card: free its WebGL context (main.js); the next draw while it is visible builds a new one. */
export function releasePoolTwin() { twin?.dispose(); twin = null; }

async function load(S) {
  const list = await api.appliances().catch(() => null);
  if (list) { const cur = document.querySelector('#applStrip .app.on')?.dataset.id ?? 'pool'; $('applStrip').innerHTML = list.map(a => `<div class="app ${a.status === 'coming' ? 'dim' : a.id === cur ? 'on' : ''}" data-id="${esc(a.id)}"><i></i>${esc(a.name)}${a.status === 'coming' ? ` · ${esc(a.source ?? '—')}, next` : a.watts != null ? ` · ${Math.round(a.watts)} W` : ''}</div>`).join(''); }
  // a failed refresh keeps the last good reading on screen, with the failure in the card's note, instead of flipping to "Not linked"
  const d = await api.pool().catch(e => S.pool?.current ? { ...S.pool, error: e.message } : { error: e.message }); S.pool = d;
  drawPool(S); S.onPool?.();
}

/* ---------- mockup x: the badge carries the age of the last controller read ---------- */
const POOL_STALE_MS = 20 * 60_000;
const ageText = ms => ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3600_000)} h ago`;
/** Whether the pump is scheduled to run at this minute of the Chicago day (a stop before the start wraps midnight). */
const scheduledNow = d => { const m = Math.floor(localHour() * 60); return (d.current?.schedules ?? []).some(s => s.stop > s.start ? m >= s.start && m < s.stop : m >= s.start || m < s.stop); };
/** "Linked · 2 min ago" (green); amber "Read 34 min ago" past 20 minutes while the pump is scheduled; the age in grey otherwise. */
export function freshPool(S) {
  const d = S.pool, at = d?.live?.at ?? d?.snapshot?.at, b = $('poolBadge');
  if (!d || !(d.linked || d.live) || !at) return;
  const age = Date.now() - at, sched = scheduledNow(d);
  if (sched && age > POOL_STALE_MS) { b.className = 'badge a'; b.textContent = `Read ${ageText(age)}`; return; }
  b.className = sched ? 'badge g' : 'badge n'; b.innerHTML = `Linked \u00b7 <small>${ageText(age)}</small>`;
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
  if (!linked) { $('poolBadge').textContent = 'Not linked'; $('poolBadge').className = 'badge'; } else freshPool(S);
  if (!linked) { $('poolHud').textContent = d.error ?? 'Add the ScreenLogic system name and password to link the pool.'; return; }
  if (!twin && $('poolTwin').offsetParent) twin = createPoolTwin($('poolTwin'));   // only while it can be seen (WebGL contexts are scarce on iOS)
  const st = twinState(d); twin?.set(st);
  const running = L?.running, names = (L?.on ?? []).filter(n => !/light/i.test(n));
  const ex = d.extras ?? { nowW: 0, todayKwh: 0 };
  $('poolHud').innerHTML = `${running ? (names.map(esc).join(' + ') || 'Running') + ` · ${L.rpm.toLocaleString()} RPM · ${Math.round(L.watts)} W` : 'Pump off'}${ex.nowW ? ` · +${ex.nowW} W ${[st.blower ? 'blower' : '', st.lights ? 'lights' : '', running && d.settings.uv ? 'UV' : ''].filter(Boolean).join('/')}` : ''}${st.heater ? ' · heater' : ''}${L?.freezeMode ? ' · freeze mode' : ''}`;
  $('poolCirc').innerHTML = [['Pool', st.pool], ['Spa', st.spa], ['Sheer descent', st.waterfall], ['Jets', st.jets], ['Air blower', st.blower], ['Heater', st.heater], ['Lights', st.lights]].map(([n, on]) => `<span class="${on ? 'on' : ''}">${n}</span>`).join('');
  drawControls(S);
  const ss = d.spaSession;
  $('poolStats').innerHTML = `<div class="stat"><small>Pump</small><b>${running ? `${Math.round(L.watts)} W · ${L.rpm.toLocaleString()} rpm` : 'off'}</b></div><div class="stat"><small>Today</small><b>${d.todayKwh} kWh${d.shareOfHomePct != null ? ` · ${d.shareOfHomePct}%` : ''}</b></div>
    <div class="stat"><small>Pool · spa · air</small><b>${st.poolTemp ?? '—'}° · ${st.spaTemp ?? '—'}° · ${L?.airTemp ?? '—'}°</b></div><div class="stat"><small>Turnover</small><b>${d.current.turnoverPerDay}× a day</b></div>`
    + (ss && ss.riseF != null ? `<div class="stat" style="grid-column:1/-1"><small>Spa session · ${ss.spaTemp}° → ${ss.spaSet}°</small><b>${ss.riseF ? `${ss.heatMinutes} min of propane · ${ss.propaneGal} gal ≈ ${S.guest ? veil('$•.••') : money2(ss.propaneUsd)}` : 'already at temperature'} · then ${S.guest ? veil('$•.••/h') : `${money2(ss.electricUsdPerHour)}/h`} pump + blower</b></div>` : '');
  $('poolNote').innerHTML = `IntelliFlo VSF on a Quad D.E. 80 filter, ${sp.gallons.toLocaleString()} gal. Streams follow the water: skimmer → pump → filter → heater → returns; green is the spa loop, purple the sheer-descent feed. Speed follows the pump's RPM. Lights are 500 W + 100 W incandescent, the blower 1.1 kW, the UV lamp ~60 W while the pump runs.${d.model.measured.length ? ` Measured: ${d.model.measured.map(m => `${m.rpm}→${Math.round(m.watts)} W`).join(', ')}.` : ''}${d.error ? ` <span style="color:var(--warn)">Last read failed: ${esc(d.error)}</span>` : ''}`;
  drawPlanner(S); drawAutopilot(S);
  $('poolSeason').innerHTML = d.seasons.map(s => `<div class="${s.current ? 'cur' : ''}"><b>${esc(s.kwhPerDay)}</b>${esc(s.label)}</div>`).join('');
}

/* ---------- mockup w frames 1–2: the switches (owner only; guests keep the chips above) and each circuit's sheet ---------- */
const ORDER = ['Pool', 'High Speed', 'Waterfall', 'Jets', 'Air Blower', 'Spa', 'Pool Light', 'Spa Light'];
const RUNS = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h']], LONG_RUN = [720, '12 h'];
const runLabel = m => m % 60 ? `${m} min` : `${m / 60} h`;
const clockAt = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const pc = { sending: new Set(), err: null };
const speedsOf = snap => new Map((snap?.pump?.circuits ?? []).map(c => [c.circuitId, c.speed]));
const isSpa = c => c.function === 1 || /^spa$/i.test(c.name);
function drawControls(S) {
  const d = S.pool, snap = d.snapshot, box = $('poolCtl'); if (!box) return;
  if (S.guest || !snap?.circuits?.length) { box.innerHTML = ''; return; }
  const speeds = speedsOf(snap), rank = c => { const i = ORDER.indexOf(c.name); return i < 0 ? 99 + c.id : i; };
  box.innerHTML = [...snap.circuits].sort((a, b) => rank(a) - rank(b)).map(c => {
    const busy = pc.sending.has(c.id), rpm = speeds.get(c.id), spaT = snap.bodies?.[1]?.temp;
    const sub = busy ? 'sending…' : `${c.on ? 'on' : 'off'}${isSpa(c) ? (spaT != null ? ` · ${spaT}°` : '') : rpm ? ` · ${rpm.toLocaleString()} RPM` : ''}`;
    return `<button class="pc${c.on ? ' on' : ''}${busy ? ' send' : ''}" data-id="${c.id}" aria-pressed="${c.on}"><i></i><b>${esc(c.name)}</b><em data-more aria-label="${esc(c.name)} settings">›</em><small>${sub}</small></button>`;
  }).join('') + (pc.err ? `<p class="fine pc-err">${esc(pc.err)}</p>` : '');
  drawBoost(S);
  let press = null;
  box.onpointerdown = e => { const b = e.target.closest('.pc'); if (!b) return; press = setTimeout(() => { press = 'long'; openCircuit(S, +b.dataset.id); }, 550); };
  box.onpointerup = box.onpointerleave = () => { if (press && press !== 'long') clearTimeout(press); };
  box.onclick = e => {
    const b = e.target.closest('.pc'); if (!b) return;
    if (press === 'long') { press = null; return; }
    const id = +b.dataset.id; if (e.target.closest('[data-more]')) return openCircuit(S, id);
    const c = snap.circuits.find(x => x.id === id); if (!c || pc.sending.has(id)) return;   // one command per circuit at a time
    poolSend(S, c.on ? { kind: 'circuit', id, on: false } : { kind: 'circuit', id, on: true, minutes: d.runFor?.[id] ?? 60 });
  };
}
/* frame 3: Boost runs the boost circuit (High Speed) for 1–4 h on its timer; while it runs the button shows the time left and ends it */
const boostId = S => S.pool?.settings?.boostCircuit ?? 8;
const leftText = ms => { const m = Math.max(1, Math.round(ms / 60_000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`; };
function drawBoost(S) {
  const d = S.pool, row = $('poolBoost'), id = boostId(S), c = d.snapshot?.circuits.find(x => x.id === id); if (!row) return;
  if (S.guest || !c) { row.innerHTML = ''; return; }
  const busy = pc.sending.has(id), until = d.until?.[id], cu = d.clearUp;
  row.innerHTML = (busy ? `<button class="send" disabled>Sending\u2026</button>`
    : c.on ? `<button class="on" id="pcBoost">Boosting <small id="pcBoostLeft">${until ? `${leftText(until - Date.now())} left \u00b7 ` : ''}End</small></button>`
    : `<button id="pcBoost">Boost <small>1\u20134 h</small></button>`)
    + (pc.clearBusy ? `<button class="send" disabled>Sending\u2026</button>` : cu ? `<button class="cu" id="pcClear">Clear-up <small>day ${cu.day} of ${cu.days}</small></button>` : `<button id="pcClear">Clear-up <small>1\u20133 days</small></button>`);
  if ($('pcBoost')) $('pcBoost').onclick = () => c.on ? poolSend(S, { kind: 'circuit', id, on: false }) : openBoost(S);
  if ($('pcClear')) $('pcClear').onclick = () => cu ? $('poolSched').scrollIntoView({ behavior: 'smooth', block: 'start' }) : openClearUp(S);
}
/** The Boost button's time left, on the 1 s tick. */
export function tickBoost(S) { const u = S.pool?.until?.[boostId(S)], el = $('pcBoostLeft'); if (el && u) el.textContent = `${leftText(u - Date.now())} left \u00b7 End`; }
function openBoost(S) {
  const d = S.pool, id = boostId(S), snap = d.snapshot, c = snap.circuits.find(x => x.id === id), rpm0 = speedsOf(snap).get(id);
  const lim = { min: snap.pump?.minRpm ?? 450, max: snap.pump?.maxRpm ?? 3450 }, hours = [60, 120, 180, 240];
  let pick = hours.includes(d.runFor?.[id]) ? d.runFor[id] : 60, rpm = rpm0;
  $('sheetBody').innerHTML = `<div class="shead"><h4>Boost</h4><button class="x" id="pcX" aria-label="Close">\u2715</button></div>
    <p class="sub">${esc(c.name)} on top of the schedule, for skimming and mixing chemicals</p>
    <div class="pc-lbl">For</div><div class="pc-runs" id="pcRuns">${hours.map(m => `<button data-m="${m}">${m / 60} h</button>`).join('')}</div>
    ${rpm0 != null ? `<div class="pc-rpm"><div class="bt">Speed<small>${esc(c.name)}'s saved speed</small></div><div class="stp"><button id="pcDn" aria-label="Slower">\u2212</button><b id="pcRpm"></b><button id="pcUp" aria-label="Faster">+</button></div></div>` : ''}
    <button class="primary" id="pcGo"></button>`;
  const draw = () => { document.querySelectorAll('#pcRuns button').forEach(b => b.classList.toggle('on', +b.dataset.m === pick)); if ($('pcRpm')) $('pcRpm').textContent = rpm.toLocaleString(); $('pcGo').textContent = `Boost until ${clockAt(Date.now() + pick * 60_000)}`; };
  $('pcRuns').onclick = e => { const b = e.target.closest('button'); if (!b) return; pick = +b.dataset.m; draw(); };
  if ($('pcDn')) { const step = dv => { rpm = Math.max(lim.min, Math.min(lim.max, Math.round((rpm + dv) / 50) * 50)); draw(); }; $('pcDn').onclick = () => step(-50); $('pcUp').onclick = () => step(50); }
  $('pcX').onclick = () => $('phone').classList.remove('open');
  $('pcGo').onclick = () => { $('phone').classList.remove('open'); poolSend(S, ...(rpm0 != null && rpm !== rpm0 ? [{ kind: 'speed', id, rpm }] : []), { kind: 'circuit', id, on: true, minutes: pick }); };
  draw(); $('phone').classList.add('open');
}
/* mockup ae: the pool learns from your changes — two suggestions (skim hour, goal) and the "Your changes" sheet */
const hr12 = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
function drawPoolLearning(S) {
  const box = $('plLearn'), c = S.pool.changes, sp = S.pool.settings; if (!box) return;
  if (S.guest || !c) { box.innerHTML = ''; return; }
  const skimNow = sp.skimAt != null ? hr12(sp.skimAt) : (S.pool.plan?.boostAt != null ? hr12(S.pool.plan.boostAt) : 'the sunniest hour');
  box.innerHTML = c.suggestions.map(g => g.kind === 'skim'
    ? `<div class="rec learn"><b>You boost around ${hr12(g.hour)}</b><br>On ${g.days} of the last ${g.of} days, an hour or more. Move the daily skim hour from ${skimNow} to ${hr12(g.hour)}?
       <div class="row2"><button class="y" data-ps="accept" data-k="${g.key}">Move the skim to ${hr12(g.hour)}</button><button class="n" data-ps="dismiss" data-k="${g.key}">Not now</button></div></div>`
    : `<div class="rec learn"><b>You keep adding pump time</b><br>About ${Math.round(g.extraMin / 30) / 2} h extra on ${g.days} of the last ${g.of} days (boosts and runs from the app or the Pentair app). Raise the goal from ${sp.turnoverGoal} to ${g.to} turnovers a day?
       <div class="row2"><button class="y" data-ps="accept" data-k="${g.key}">Raise to ${g.to}</button><button class="n" data-ps="dismiss" data-k="${g.key}">Not now</button></div></div>`).join('')
    + (c.recent.length ? `<button class="ae-line" id="plLearnBtn"><i></i><span><b>Learning from ${c.recent.length} change${c.recent.length === 1 ? '' : 's'}</b> this week</span><em>›</em></button>` : '');
  box.onclick = async e => {
    if (e.target.closest('#plLearnBtn')) return openPoolChanges(S);
    const b = e.target.closest('[data-ps]'); if (!b) return; b.disabled = true; b.textContent = '…';
    try { S.pool = await api.poolSuggestion(b.dataset.ps, b.dataset.k); } catch (err) { alert(err.message); } drawPool(S);
  };
}
function openPoolChanges(S) {
  const c = S.pool.changes, p = c.patterns, dt = ms => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(',', '');
  const dots = (n, need) => `<div class="ae-dots">${Array.from({ length: need }, (_, i) => `<i class="${i < n ? 'on' : 'need'}"></i>`).join('')}</div>`;
  const what = r => r.kind === 'boost' ? `Boost for ${r.minutes >= 60 ? `${Math.round(r.minutes / 30) / 2} h` : `${r.minutes} min`}` : r.kind === 'run' ? `Pool on for ${r.minutes >= 60 ? `${Math.round(r.minutes / 30) / 2} h` : `${r.minutes} min`}` : r.kind === 'runOnce' ? 'Run-once schedule on the controller' : 'Pump running outside the schedule';
  $('sheetBody').innerHTML = `<div class="shead"><h4>Your changes</h4><button class="x" id="pchX" aria-label="Close">✕</button></div>
    <p class="sub">Pool · last 7 days</p>
    ${p.skim && p.skim.days >= 2 ? `<div class="ae-pat"><div class="t">Boosts around ${hr12(p.skim.hour)}<span>${Math.min(p.skim.days, p.skim.need)} of ${p.skim.need}</span></div><p>Toward moving the daily skim hour there.</p>${dots(p.skim.days, p.skim.need)}</div>` : ''}
    ${p.goal.days >= 2 ? `<div class="ae-pat"><div class="t">Extra pump time<span>${Math.min(p.goal.days, p.goal.need)} of ${p.goal.need}</span></div><p>Days with an hour or more beyond the plan (about ${Math.round(p.goal.extraMin / 30) / 2} h). Toward raising the goal.</p>${dots(p.goal.days, p.goal.need)}</div>` : ''}
    <div class="ae-chg">${c.recent.map(r => `<div><em>${dt(r.at)}</em><b>${what(r)}</b><span>${r.kind === 'outside' || r.kind === 'runOnce' ? 'seen' : 'app'}</span></div>`).join('')}</div>
    <p class="fine" style="margin-top:12px">After the same kind of change on 4 of 7 days, Solstice suggests a change to the planner. It never changes it by itself.</p>`;
  $('pchX').onclick = () => $('phone').classList.remove('open');
  $('phone').classList.add('open');
}

/* frame 7: the schedule editor — Pool and High Speed runs; saving writes them and moves Autopilot from Auto to Suggest */
const toTime = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromTime = v => { const [h, m] = String(v).split(':').map(Number); return h * 60 + m; };
function openEditor(S) {
  const d = S.pool, sp = d.settings, P = sp.poolCircuit ?? 6, B = sp.boostCircuit ?? 8, snap = d.snapshot;
  if (d.clearUp) { pc.err = 'A Clear-up is running; end it first to edit the schedule.'; drawControls(S); return; }
  const names = { [P]: snap?.circuits.find(c => c.id === P)?.name ?? 'Pool', [B]: snap?.circuits.find(c => c.id === B)?.name ?? 'High Speed' };
  const speeds0 = speedsOf(snap), speeds = { [P]: speeds0.get(P) ?? 1800, [B]: speeds0.get(B) ?? 2400 }, lim = { min: snap?.pump?.minRpm ?? 450, max: snap?.pump?.maxRpm ?? 3450 };
  const runs = d.current.schedules.filter(x => x.circuitId === P || x.circuitId === B).map(x => ({ circuitId: x.circuitId, start: x.start, stop: x.stop }));
  let sel = runs.length ? 0 : -1;
  const color = c => c === B ? PL_COLOR.skim : PL_COLOR.pool;
  const draw = () => {
    const r = runs[sel];
    $('sheetBody').innerHTML = `<div class="shead"><h4>Pump schedule</h4><button class="x" id="seX" aria-label="Close">\u2715</button></div>
      <p class="sub">What the controller runs every day</p>
      <div class="se-list">${runs.map((x, i) => `<button class="se-row${i === sel ? ' on' : ''}" data-i="${i}"><i style="background:${color(x.circuitId)}"></i><b>${esc(names[x.circuitId])}</b><em>\u203a</em><small>${hm(x.start)} \u2013 ${hm(x.stop)} \u00b7 ${speeds[x.circuitId].toLocaleString()}</small></button>`).join('')}</div>
      ${runs.length < 6 ? '<button class="se-add" id="seAdd">+ Add a run</button>' : ''}
      ${r ? `<div class="pc-lbl">Editing ${esc(names[r.circuitId])}</div>
        <div class="seg2 wide" id="seCirc" style="display:flex;margin-top:10px">${[P, B].map(c => `<button data-c="${c}" style="flex:1;text-align:center" class="${c === r.circuitId ? 'on' : ''}">${esc(names[c])}</button>`).join('')}</div>
        <div class="se-time"><label><small>Start</small><input type="time" step="900" id="seStart" value="${toTime(r.start)}"></label><label><small>Stop</small><input type="time" step="900" id="seStop" value="${toTime(r.stop === 1439 ? 1440 : r.stop)}"></label></div>
        <div class="pc-rpm"><div class="bt">Speed<small>${esc(names[r.circuitId])}'s saved speed</small></div><div class="stp"><button id="seDn" aria-label="Slower">\u2212</button><b>${speeds[r.circuitId].toLocaleString()}</b><button id="seUp" aria-label="Faster">+</button></div></div>` : ''}
      <button class="primary" id="seGo" style="width:100%;box-sizing:border-box;margin-top:14px;background:var(--batt);color:#04140c">Save to the controller</button>
      ${r ? '<button class="link" id="seDel">Delete this run</button>' : ''}
      <p class="fine" id="seNote" style="margin-top:10px">Saving keeps your schedule: Autopilot switches to Suggest and offers its plan instead of writing over yours. ${esc(names[P])} and ${esc(names[B])} only (Waterfall is a switch only). New runs are added before old ones are removed.</p>`;
    document.querySelectorAll('.se-row').forEach(b => b.onclick = () => { sel = +b.dataset.i; draw(); });
    $('seX').onclick = () => $('phone').classList.remove('open');
    if ($('seAdd')) $('seAdd').onclick = () => { runs.push({ circuitId: P, start: 600, stop: 900 }); sel = runs.length - 1; draw(); };
    if (r) {
      $('seCirc').onclick = e => { const b = e.target.closest('button'); if (!b) return; r.circuitId = +b.dataset.c; draw(); };
      const q15 = v => Math.round(v / 15) * 15;
      $('seStart').onchange = e => { r.start = q15(fromTime(e.target.value)) % 1440; draw(); };
      $('seStop').onchange = e => { const m = q15(fromTime(e.target.value)); r.stop = m === 0 || m >= 1440 ? 1439 : m; draw(); };
      const step = dv => { speeds[r.circuitId] = Math.max(lim.min, Math.min(lim.max, Math.round((speeds[r.circuitId] + dv) / 50) * 50)); draw(); };
      $('seDn').onclick = () => step(-50); $('seUp').onclick = () => step(50);
      $('seDel').onclick = () => { runs.splice(sel, 1); sel = Math.min(sel, runs.length - 1); save(); };
    }
    $('seGo').onclick = save;
  };
  const save = async () => {
    const bad = runs.find(x => x.start === x.stop); if (bad) { $('seNote').textContent = 'A run needs a stop after its start.'; return; }
    const used = [...new Set(runs.map(x => x.circuitId))], body = { schedules: runs, speeds: used.filter(c => speeds[c] !== speeds0.get(c)).map(c => ({ circuitId: c, rpm: speeds[c] })) };
    $('seGo').textContent = 'Saving\u2026';
    try { S.pool = await api.poolSchedule(body); $('phone').classList.remove('open'); drawPool(S); }
    catch (e) { $('seGo').textContent = 'Save to the controller'; $('seNote').textContent = `Couldn\u2019t save: ${e.message}`; }
  };
  draw(); $('phone').classList.add('open');
}

/* frame 6: Clear-up — the Pool circuit all day for 1–3 days, then back to the planner by itself; only End now ends it early */
const endsLabel = ms => `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })} ${clockAt(ms)}`;
const poolRunAfter = t => { const d = new Date(t); d.setUTCHours(1, 15, 0, 0); if (d.getTime() < t) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); };   // as the server
async function clearUpSend(S, body) {
  pc.clearBusy = true; pc.err = null; drawControls(S);
  try { S.pool = await api.poolClearUp(body); } catch (e) { pc.err = `Clear-up: ${e.message}`; }
  pc.clearBusy = false; drawPool(S);
}
export function openClearUp(S) {   // also offered after a hazy test (water.js, mockup aj)
  const d = S.pool, rates = d.clearUpRates ?? []; if (!rates.length) return;
  let days = 2, rpm = 2000;
  $('sheetBody').innerHTML = `<div class="shead"><h4>Clear-up</h4><button class="x" id="pcX" aria-label="Close">\u2715</button></div>
    <p class="sub">Pool runs around the clock to clear cloudy water, then goes back to the planner by itself</p>
    <div class="pc-lbl">For</div><div class="pc-runs" id="pcDays" style="grid-template-columns:repeat(3,1fr)">${[1, 2, 3].map(n => `<button data-n="${n}">${n} day${n > 1 ? 's' : ''}</button>`).join('')}</div>
    <div class="pc-rpm"><div class="bt">Speed<small id="pcTurn"></small></div><div class="stp"><button id="pcDn" aria-label="Slower">\u2212</button><b id="pcRpm"></b><button id="pcUp" aria-label="Faster">+</button></div></div>
    <div class="pc-nums" id="pcNums"></div>
    <button class="primary" id="pcGo">Start Clear-up</button>`;
  const draw = () => {
    const r = rates.find(x => x.rpm === rpm) ?? rates[0], end = poolRunAfter(Date.now() + days * 864e5);
    document.querySelectorAll('#pcDays button').forEach(b => b.classList.toggle('on', +b.dataset.n === days));
    $('pcRpm').textContent = rpm.toLocaleString(); $('pcTurn').textContent = `about ${r.turnovers} turnovers a day`;
    $('pcNums').innerHTML = `<div><b>24 h</b><span>pump a day</span></div><div><b>${r.kwhPerDay}</b><span>kWh a day</span></div><div><b>${new Date(end).toLocaleDateString('en-US', { weekday: 'short' })}</b><span>ends ${clockAt(end)}</span></div>`;
  };
  $('pcDays').onclick = e => { const b = e.target.closest('button'); if (!b) return; days = +b.dataset.n; draw(); };
  const lo = rates[0].rpm, hi = rates.at(-1).rpm;
  $('pcDn').onclick = () => { rpm = Math.max(lo, rpm - 50); draw(); }; $('pcUp').onclick = () => { rpm = Math.min(hi, rpm + 50); draw(); };
  $('pcX').onclick = () => $('phone').classList.remove('open');
  $('pcGo').onclick = () => { $('phone').classList.remove('open'); clearUpSend(S, { action: 'start', days, rpm }); };
  draw(); $('phone').classList.add('open');
}
/** Mockup ak frame 7: the banner on the planner while a trip's pool plan is on (Pool Autopilot plans trip days at the trip goal). */
function tripBanner(S) {
  const v = S.vac, t = v?.trip, ap = S.pool?.autopilot; if (!t || !ap?.week?.some(w => w.trip)) return '';
  const why = ap.tomorrow?.why?.[0] ?? '', waits = /^Vacation: the trip plan waits/.test(why), goal = /^Vacation: ([\d.]+ turnovers?)/.exec(why)?.[1], p = ap.tomorrow?.plan;
  const until = t.backAt ? poolBackLabel(t.backAt) : null;
  if (waits) return `<div class="pl-clear vtrip"><div class="hh"><i></i><b>Trip plan waits</b><em>${until ? `until ${esc(until)}` : ''}</em></div><p>${esc(why.replace(/^Vacation: /, '').replace(/^the trip plan waits/, 'The trip plan waits'))}. The normal plan runs until a clear test.</p></div>`;
  return `<div class="pl-clear vtrip"><div class="hh"><i></i><b>Trip plan · ${esc(goal ?? 'trip goal')} a day</b><em>${until ? `until ${esc(until)}` : 'until you’re back'}</em></div>
    <p>${p ? `${p.hours} h at ${p.rpm.toLocaleString()} RPM. ` : ''}Your goal of ${S.pool.settings?.turnoverGoal ?? 3} comes back the evening before you do.</p></div>`;
}
/** The banner on the planner while a Clear-up runs (and its badge). */
function drawClearBanner(S) {
  const cu = S.pool.clearUp, box = $('plClear'); if (!box) return;
  $('plMode').className = cu ? 'badge cu' : 'badge g';
  if (cu) $('plMode').textContent = 'Clear-up';
  if (!cu) { box.innerHTML = tripBanner(S); return; }
  const f = Math.min(1, Math.max(0, (Date.now() - cu.startedAt) / (cu.until - cu.startedAt)));
  box.innerHTML = `<div class="pl-clear"><div class="hh"><i></i><b>Clear-up \u00b7 day ${cu.day} of ${cu.days}</b><em>ends ${endsLabel(cu.until)}</em></div>
    <p>Pool on all day at ${cu.rpm.toLocaleString()} RPM. The planner and Autopilot leave the schedule alone until it ends, then the next evening plan takes over. Brush the walls and backwash the DE filter when the pressure climbs.</p>
    <div class="bar"><i style="width:${Math.round(f * 100)}%"></i></div>
    ${S.guest ? '' : `<div class="row2" data-owner><button id="cuMore">Add a day</button><button id="cuEnd">End now</button></div>`}</div>`;
  if ($('cuMore')) { $('cuMore').onclick = () => clearUpSend(S, { action: 'extend' }); $('cuEnd').onclick = () => { if (confirm('End the Clear-up now? The planner\u2019s schedule goes back on the controller.')) clearUpSend(S, { action: 'end' }); }; }
}
/** Send one or more commands for a circuit in order; the tile says "sending…" until the controller's read-back answers. */
async function poolSend(S, ...cmds) {
  const id = cmds.find(c => c.id != null)?.id ?? 1, name = S.pool.snapshot?.circuits.find(c => c.id === id)?.name ?? 'Pool';
  pc.sending.add(id); pc.err = null; drawControls(S);
  try { for (const c of cmds) S.pool = await api.poolCommand(c); }
  catch (e) { pc.err = `${name}: ${e.message}`; }
  pc.sending.delete(id); drawPool(S);
}
function openCircuit(S, id) {
  const d = S.pool, snap = d.snapshot, c = snap?.circuits.find(x => x.id === id); if (!c || S.guest) return;
  const rpm0 = speedsOf(snap).get(id), lim = { min: snap.pump?.minRpm ?? 450, max: snap.pump?.maxRpm ?? 3450 };
  const runs = /light/i.test(c.name) || isSpa(c) ? [...RUNS, LONG_RUN] : RUNS, sched = (d.current?.schedules ?? []).filter(x => x.circuitId === id);
  let pick = d.runFor?.[id] ?? 60, rpm = rpm0;
  if (!runs.some(r => r[0] === pick)) pick = 60;
  // frame 4: the spa's heat (heater mode 3 = on, 0 = off) and setpoint 80–104°; the heater only runs while the Spa circuit is on
  const body = isSpa(c) ? snap.bodies?.[1] : null, heat0 = body?.heatMode === 3, set0 = Math.min(104, Math.max(80, body?.setPoint || 100));
  let heat = heat0, setF = set0;
  $('sheetBody').innerHTML = `<div class="shead"><h4>${esc(c.name)}</h4><button class="x" id="pcX" aria-label="Close">✕</button></div>
    <p class="sub">${c.on ? 'On' : 'Off'} · ${sched.length ? `on schedule ${sched.map(x => `${hm(x.start)}–${hm(x.stop)}`).join(', ')}` : 'not on any schedule'}</p>
    ${body ? `<div class="pc-heat"><div class="pc-lbl">Spa heat</div><div class="seg2 wide" id="pcHeat"><button data-h="0">Off</button><button data-h="1">On</button></div>
      <div class="tstat" id="pcDial"><div class="dial"><button class="step" id="pcHdn" aria-label="Cooler">\u2212</button><div class="sp"><small>Heat to</small><b class="heat" id="pcSet"></b><span>${body.heating ? 'heating now' : 'heater off now'}</span></div><button class="step" id="pcHup" aria-label="Warmer">+</button></div></div></div>` : ''}
    <div id="pcRun"${c.on ? ' hidden' : ''}><div class="pc-lbl">Run for</div><div class="pc-runs${runs.length > 4 ? ' five' : ''}" id="pcRuns">${runs.map(([m, l]) => `<button data-m="${m}">${l}</button>`).join('')}</div></div>
    ${!body && rpm0 != null ? `<div class="pc-rpm"><div class="bt">Speed<small>whenever ${esc(c.name)} runs · ${lim.min.toLocaleString()}–${lim.max.toLocaleString()}</small></div><div class="stp"><button id="pcDn" aria-label="Slower">−</button><b id="pcRpm"></b><button id="pcUp" aria-label="Faster">+</button></div></div>` : ''}
    <button class="primary" id="pcGo"></button>${c.on ? '<button class="link" id="pcOff" hidden>Turn off</button>' : ''}
    <p class="fine" id="pcNote" style="margin-top:10px"></p>`;
  const draw = () => {
    document.querySelectorAll('#pcRuns button').forEach(b => b.classList.toggle('on', +b.dataset.m === pick));
    if ($('pcRpm')) $('pcRpm').textContent = rpm.toLocaleString();
    const sped = rpm0 != null && rpm !== rpm0, heated = !!body && (heat !== heat0 || (heat && setF !== set0));
    if (body) { document.querySelectorAll('#pcHeat button').forEach(b => b.classList.toggle('on', +b.dataset.h === +heat)); $('pcDial').hidden = !heat; $('pcSet').innerHTML = `${setF}<sup>\u00b0</sup>`; }
    $('pcGo').textContent = c.on ? (heated ? (heat ? `Save heat \u00b7 ${setF}\u00b0` : 'Turn spa heat off') : sped ? `Save ${rpm.toLocaleString()} RPM` : 'Turn off')
      : body ? `Spa on${heat ? ` \u00b7 heat to ${setF}\u00b0` : ''} for ${runLabel(pick)}` : `Turn on for ${runLabel(pick)}`;
    if ($('pcOff')) $('pcOff').hidden = !(sped || heated);
    $('pcNote').textContent = body ? `The heater only runs while the Spa circuit is on. Setpoint 80\u2013104\u00b0. Autopilot never touches the spa, its heat, the lights or the heater; only you do.`
      : c.on ? (sped ? `The new speed applies now and whenever ${c.name} runs, schedules included.` : '')
      : `Turns itself off at ${clockAt(Date.now() + pick * 60_000)} (the controller's own timer, so it stops even if Solstice is offline).`;
  };
  const step = dv => { rpm = Math.max(lim.min, Math.min(lim.max, Math.round((rpm + dv) / 50) * 50)); draw(); };
  if ($('pcRuns')) $('pcRuns').onclick = e => { const b = e.target.closest('button'); if (!b) return; pick = +b.dataset.m; draw(); };
  if ($('pcDn')) { $('pcDn').onclick = () => step(-50); $('pcUp').onclick = () => step(50); }
  if (body) {
    $('pcHeat').onclick = e => { const b = e.target.closest('button'); if (!b) return; heat = b.dataset.h === '1'; draw(); };
    $('pcHdn').onclick = () => { setF = Math.max(80, setF - 1); draw(); }; $('pcHup').onclick = () => { setF = Math.min(104, setF + 1); draw(); };
  }
  $('pcX').onclick = () => $('phone').classList.remove('open');
  const close = () => $('phone').classList.remove('open');
  $('pcGo').onclick = () => {
    const sped = rpm0 != null && rpm !== rpm0, heated = !!body && (heat !== heat0 || (heat && setF !== set0));
    const cmds = [...(heated ? [heat ? { kind: 'spaHeat', on: true, setF } : { kind: 'spaHeat', on: false }] : []), ...(sped ? [{ kind: 'speed', id, rpm }] : [])];
    if (!c.on) cmds.push({ kind: 'circuit', id, on: true, minutes: pick }); else if (!sped && !heated) cmds.push({ kind: 'circuit', id, on: false });
    close(); poolSend(S, ...cmds);
  };
  if ($('pcOff')) $('pcOff').onclick = () => { close(); poolSend(S, { kind: 'circuit', id, on: false }); };
  draw(); $('phone').classList.add('open');
}

/* ---------- mockup w frame 5: the turnover planner (in place of the Pump schedule card) ---------- */
const PL_COLOR = { pool: '#6cc4ff', skim: '#ff7a66', boost: 'rgba(255,122,102,.55)' };
const pct = m => `${m / 1440 * 100}%`;
let goalTimer = null;
function drawPlanner(S) {
  const d = S.pool, w = d.water, P = d.plan, C = d.current, sp = d.settings; if (!w || !P) return;
  const mode = d.autopilot?.mode ?? sp.autopilot;
  $('plMode').textContent = `Autopilot · ${mode === 'auto' ? 'Auto' : mode === 'off' ? 'Off' : 'Suggest'}`;
  drawClearBanner(S);
  // the ring: water moved so far today (readings) against the goal
  const f = Math.min(1, w.movedTurnovers / w.goal), circ = 2 * Math.PI * 42;
  $('plArc').setAttribute('stroke-dasharray', `${circ * f} ${circ}`);
  $('plMoved').textContent = w.movedTurnovers.toFixed(1); $('plOf').textContent = `of ${w.goal.toFixed(1)} today`;
  const boostId = sp.boostCircuit ?? 8, bUntil = d.until?.[boostId];
  $('plTxt').innerHTML = `Water moved today: <b>${w.movedTurnovers.toFixed(1)} turnover${w.movedTurnovers === 1 ? '' : 's'}</b> of the <b>${w.goal.toFixed(1)}</b> goal${bUntil ? ', including your boost' : ''}. `
    + (w.projectedTurnovers > w.movedTurnovers + .05 ? `The rest of today’s schedule brings it to <b>${w.projectedTurnovers.toFixed(1)}</b>.` : 'Nothing more is scheduled today.');
  // today's programs on a 24 h bar (wrapping runs split at midnight), your running boost, and now
  const segs = [], put = (a, b, c) => { if (b > a) segs.push(`<i style="left:${pct(a)};width:${pct(b - a)};background:${c}"></i>`); };
  const colorOf = s => s.circuitId === boostId ? PL_COLOR.skim : PL_COLOR.pool;
  for (const s of [...C.schedules].sort((a, b) => (a.circuitId === boostId) - (b.circuitId === boostId))) { if (s.stop > s.start) put(s.start, s.stop, colorOf(s)); else { put(s.start, 1440, colorOf(s)); put(0, s.stop || 1440, colorOf(s)); } }
  const nowM = Math.floor(localHour() * 60);
  if (bUntil) put(nowM, Math.min(1440, nowM + Math.round((bUntil - Date.now()) / 60_000)), PL_COLOR.boost);
  $('plDay').innerHTML = segs.join('') + `<i class="now" style="left:${pct(nowM)}"></i>`;
  const span = s => s.stop === s.start || (s.start === 0 && s.stop >= 1439) ? 'all day' : `${hm(s.start).replace(/([ap])$/, ' $1')}–${hm(s.stop).replace(/([ap])$/, ' $1')}`;
  $('plList').innerHTML = C.schedules.map(s => `<div class="pl-row"><i style="background:${colorOf(s)}"></i><b>${esc(s.name)}${s.circuitId === boostId ? ' skim' : ''} · ${span(s)}</b><span>${s.rpm.toLocaleString()} RPM</span></div>`).join('')
    + (bUntil ? `<div class="pl-row"><i style="background:${PL_COLOR.boost}"></i><b>Your boost · until ${clockAt(bUntil)}</b><span>${(speedsOf(d.snapshot).get(boostId) ?? 0).toLocaleString()} RPM</span></div>` : '')
    || '<p class="fine">No pump programs on the controller.</p>';
  $('plEdit').onclick = () => openEditor(S);
  // the goal (owner only) and what the goal's plan costs a day
  $('plGoal').textContent = w.goal.toFixed(1); $('plSkim').textContent = `${w.skimHours} h`;
  $('ruleGoal').textContent = `goal: ${w.goal} turnover${w.goal === 1 ? '' : 's'}`;   // the Autopilot card's rule chip follows the goal
  $('plGal').textContent = `${w.gallons.toLocaleString()} gal · ${w.goal} = about ${(Math.round(w.gallons * w.goal / 1000) * 1000).toLocaleString()} gal`;
  const save = patch => { clearTimeout(goalTimer); goalTimer = setTimeout(async () => { try { S.pool = await api.poolGoal(patch()); drawPool(S); } catch (e) { drawPlanner(S); $('plNote').textContent = `Couldn’t save the goal: ${e.message}`; } }, 700); };   // back to the saved goal
  let goal = w.goal, skim = w.skimHours;
  const show = () => { $('plGoal').textContent = goal.toFixed(1); $('plSkim').textContent = `${skim} h`; save(() => ({ turnoverGoal: goal, skimHours: skim })); };
  $('plGdn').onclick = () => { goal = Math.max(1, goal - .5); show(); }; $('plGup').onclick = () => { goal = Math.min(4, goal + .5); show(); };
  $('plSdn').onclick = () => { skim = Math.max(0, skim - 1); show(); }; $('plSup').onclick = () => { skim = Math.min(3, skim + 1); show(); };
  // B2-7 (audit L-17): the server's confidence in the plan's kWh a day (learning layer pool.kwhDay), as the AC card shows its savings'
  const kc = confChip(d.conf?.kwhPerDay, modelOf(S.models, 'pool.kwhDay'));
  $('plNums').innerHTML = `<div><b>${P.hours} h</b><span>pump a day</span></div><div><b>${P.kwhPerDay}</b><span>kWh a day</span>${kc && `<span style="margin-top:5px">${kc}</span>`}</div><div><b>${S.guest ? veil('$•') : P.costPerMonth == null ? '—' : money(P.costPerMonth)}</b><span>a month</span></div>`;
  drawPoolLearning(S);
  $('plNote').textContent = `The planner picks hours and speed to reach the goal for the least energy (${P.hours} h at ${P.rpm.toLocaleString()} RPM${P.boostHours ? ` with ${P.boostHours} h at ${sp.boostRpm.toLocaleString()}` : ''}), keeps the skim hour at the sunniest hour, and adds time on hot days (+1 h at 85°) and after rain. Water moved uses the flow model (no flow sensor on this pump), so turnovers are an estimate.`;
}

/* ---------- Autopilot ---------- */
function drawAutopilot(S) {
  const d = S.pool, a = d.autopilot; if (!a || a.error) { $('autoStatus').innerHTML = `<i class="off"></i><span>${esc(a?.error ?? 'Autopilot unavailable')}</span>`; return; }
  document.querySelectorAll('#autoMode button').forEach(b => b.classList.toggle('on', b.dataset.m === a.mode));
  $('autoBadge').textContent = `Autopilot · ${{ off: 'Off', suggest: 'Suggest', auto: 'Auto' }[a.mode] ?? a.mode}`; $('autoBadge').className = `badge${a.mode === 'off' ? '' : ' g'}`;   // a guest's static badge
  $('autoMode').onclick = async e => { const b = e.target.closest('button'); if (!b || b.dataset.m === a.mode) return;
    if (b.dataset.m === 'auto' && !confirm('Auto mode writes tomorrow’s schedule to ScreenLogic every evening without asking. Spa, heater, lights and freeze protection are never touched. Turn it on?')) return;
    if (b.dataset.m === 'off' && !confirm('Turn Pool Autopilot off?\n\nSolstice stops planning and writing the pump schedule. The controller keeps running what it has now.')) return;   // mockup ac
    await api.poolAutopilot(b.dataset.m).catch(err => alert(err.message)); await load(S); };
  const next = new Date(a.nextRunAt), last = a.log[0];
  $('autoStatus').innerHTML = `<i class="${a.mode === 'off' ? 'off' : ''}"></i><span>${a.mode === 'off' ? 'Off. Turn on Suggest to get a plan for tomorrow each evening, or Auto to have it applied.' : `${a.mode === 'auto' ? 'Writes' : 'Suggests'} tomorrow's plan tonight at <b>${next.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</b>${last ? ` · last ${niceDate(last.day, { month: 'short', day: 'numeric' })}` : ''} · never touches spa, heater, lights or freeze protection`}</span>`;
  const g = a.signals, ring = (v, l, f, c) => { const C = 2 * Math.PI * 17; return `<div><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="17" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3.5"/><circle cx="22" cy="22" r="17" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${C * Math.max(0, Math.min(1, f))} ${C}" transform="rotate(-90 22 22)"/></svg><b>${v}</b><small>${l}</small></div>`; };
  $('autoSignals').innerHTML = ring(`${g.waterTemp}°`, 'water', g.waterTemp / 100, '#6cc4ff') + ring(g.sunKwhM2, 'sun', g.sunPct / 100, '#ffc15e') + ring(`${g.high}°`, 'high', g.high / 105, '#ff9e66') + ring(`${g.rainPct}%`, 'rain', g.rainPct / 100, '#c4a2ff') + ring(`${g.useDays}/7`, 'use days', g.useDays / 7, '#4ef0a6') + ring(esc(g.pollen), 'pollen', g.pollen === 'high' ? .9 : g.pollen === 'medium' ? .5 : .15, '#8d93a8');
  const T = a.tomorrow; $('autoTomorrow').textContent = `Tomorrow ${T.plan.hours} h${T.plan.boostHours ? ' + boost' : ''}${T.why.length ? ' · ' + T.why[0].split(':')[0] : ''}`;
  const days = a.week, X = i => 12 + i * 42, mxSun = Math.max(1, ...days.map(x => x.sunKwhM2));
  let o = `<defs><linearGradient id="asg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc15e" stop-opacity=".45"/><stop offset="1" stop-color="#ffc15e" stop-opacity="0"/></linearGradient></defs>`;
  const Y = v => 88 - v / mxSun * 38, pts = days.map((x, i) => `${X(i) + 15},${Y(x.sunKwhM2)}`); if (days.length) o += `<path d="M${X(0) + 15},84 L${pts.join(' L')} L${X(days.length - 1) + 15},84 Z" fill="url(#asg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="#ffc15e" stroke-opacity=".7" stroke-width="1.5"/>`;
  days.forEach((x, i) => { const px = X(i), hh = x.hours / 12 * 56, tm = i === 0; o += `${tm ? `<rect x="${px - 2}" y="4" width="34" height="102" rx="8" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.1)"/>` : ''}<rect x="${px + 7}" y="${84 - hh}" width="16" height="${hh}" rx="4" fill="#6cc4ff" opacity="${tm ? 1 : .75}"/>${x.boost ? `<circle cx="${px + 15}" cy="${84 - hh - 6}" r="3" fill="#ff7a66"/>` : ''}<text x="${px + 15}" y="${84 - hh - (x.boost ? 14 : 6)}" text-anchor="middle" fill="#f2f4f8" font-size="9.5" font-family="JetBrains Mono">${x.hours}h</text><text x="${px + 15}" y="100" text-anchor="middle" fill="rgba(242,244,248,${tm ? .9 : .5})" font-size="9.5" font-family="Manrope">${new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</text>${x.rainPct >= 60 ? `<text x="${px + 15}" y="${84 - hh - 18 - (x.boost ? 8 : 0)}" text-anchor="middle" fill="#c4a2ff" font-size="9" font-family="Manrope">rain</text>` : ''}`; });
  $('autoWeek').innerHTML = o;
  $('autoPending').innerHTML = a.pending && d.pending ? `<div class="rec" style="margin-top:12px"><b>Suggested for ${niceDate(d.pending.date, { weekday: 'long' })}:</b> ${d.pending.plan.hours} h at ${d.settings.filterRpm.toLocaleString()} RPM, ${hm(d.pending.plan.start * 60)}–${hm(d.pending.plan.stop * 60)}${d.pending.plan.boostHours ? `, skim boost at ${hm(d.pending.plan.boostAt * 60)}` : ''}. ${d.pending.why.map(esc).join('; ') || 'Season plan.'}<button class="primary" id="applyTomorrow" style="margin-top:10px">Apply tomorrow’s plan</button></div>` : '';
  const at = $('applyTomorrow'); if (at) at.onclick = async () => { at.textContent = 'Applying…'; try { await api.poolApplyTomorrow(); await load(S); } catch (e) { alert(e.message); at.textContent = 'Apply tomorrow’s plan'; } };
  $('autoLog').innerHTML = (a.log.length ? a.log.slice(0, 6).map(l => `<div><i></i><span>${niceDate(l.day, { month: 'short', day: 'numeric' })}</span><p>${esc(l.text)}${l.delta ? `<em>${esc(l.delta)}</em>` : ''}</p></div>`).join('') : '')
    + `<div><i class="w"></i><span>filter</span><p>About ${a.filterHours} run hours since ${a.filterCleanedOn ? `the D.E. cleaning on ${niceDate(a.filterCleanedOn)}` : 'Solstice started counting'}. <button class="link" id="logClean" style="margin:4px 0 0;padding:4px 10px">I cleaned the filter</button></p></div>`;
  $('logClean').onclick = async () => { await api.addEvent('filter_cleaned', new Date().toLocaleDateString('en-CA')); await load(S); };
}
