import { $, money, money2, niceDate, localHour, localDate, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { poolBackLabel } from '../lib/vacation.js';
import { every, stop } from '../lib/poll.js';
import { createPoolTwin } from '../scenes/pooltwin.js';
import { veil, nameStart, esc } from '../lib/frost.js';
import { cBadge, badge, modelOf } from '../lib/conf.js';
import { icon } from '../lib/icons.js';
import { gauge } from '../lib/sysui.js';
import { nowPct, scheduleBlocks, autopilotStage } from '../lib/nowui.js';
import { sheet, sheetHead, sheetFoot, modePill, seg, segSet, banner, sysTop, planStrip, tileHtml, closeSheet } from './csheet.js';
import { mountPoolPanel, redrawPoolPanels } from './nowsheets.js';

/*
 * Systems › Pool (approved mockup al frames 12, 12b): the live card over the flow twin, four tiles, the Controls card (the Pool sheet's
 * equipment panel in place, views/nowsheets.js), the Pool Autopilot disclosure (goal well, Schedule & goal, Why, Rules, Log) and the
 * circuit, boost, Clear-up and schedule sheets those open. Writes are staged and go only through the routes that already existed.
 */
const hm = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`; };
const CIRCUITS = [['Pool', 'pool'], ['Spa', 'spa'], ['Waterfall', 'waterfall'], ['Jets', 'jets'], ['Air Blower', 'blower'], ['Pool Light', 'lights'], ['Spa Light', 'lights']];

let twin = null, timer;
/** Started by main.js once the role is known (and again when it changes); every 3 minutes while the tab is visible. */
export function initAppliances(S) { stop(timer); timer = every(3 * 60_000, () => load(S)); }
export const poolTwin = () => twin;
/** Leaving the Pool card: free its WebGL context (main.js); the next draw while it is visible builds a new one. */
export function releasePoolTwin() { twin?.dispose(); twin = null; }

async function load(S) {
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
  if (!b || !d || !(d.linked || d.live) || !at) return;
  const age = Date.now() - at, sched = scheduledNow(d), short = ageText(age).replace(' ago', '');
  const html = sched && age > POOL_STALE_MS ? badge('estimated', `Read ${ageText(age)}`) : sched ? badge('live', `Linked · ${short}`) : badge('', `Linked · ${short}`);
  if (b.innerHTML !== html) b.innerHTML = html;
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

/* ---------- Systems › Pool (mockup al frames 12, 12b): Live → Controls → Pool Autopilot → Water tests ---------- */
let panel = null;
const MODE_CLS = { auto: 'auto', suggest: 'suggest', off: 'off' };
export function drawPool(S) {
  const d = S.pool; if (!d) return;
  const L = d.live, sp = d.settings, linked = d.linked || !!L;
  $('poolAuto').hidden = !linked;
  if (!S.guest && !panel && $('poolEquip')) panel = mountPoolPanel(S, $('poolEquip')); else redrawPoolPanels();   // the Pool sheet's equipment panel, in place
  drawPoolSys(S);
  if (!linked) { $('poolBadge').innerHTML = badge('', 'Not linked'); $('poolHud').textContent = d.error ?? 'Add the ScreenLogic system name and password to link the pool.'; return; }
  freshPool(S);
  if (!twin && $('poolTwin').offsetParent) twin = createPoolTwin($('poolTwin'));   // only while it can be seen (WebGL contexts are scarce on iOS)
  const st = twinState(d); twin?.set(st);
  const running = L?.running, names = (L?.on ?? []).filter(n => !/light/i.test(n));
  const ex = d.extras ?? { nowW: 0, todayKwh: 0 };
  $('poolHud').innerHTML = `${running ? (names.map(esc).join(' + ') || 'Running') + ` · ${L.rpm.toLocaleString()} RPM · ${Math.round(L.watts)} W` : 'Pump off'}${ex.nowW ? ` · +${ex.nowW} W ${[st.blower ? 'blower' : '', st.lights ? 'lights' : '', running && d.settings.uv ? 'UV' : ''].filter(Boolean).join('/')}` : ''}${st.heater ? ' · heater' : ''}${L?.freezeMode ? ' · freeze mode' : ''}`;
  $('poolCirc').innerHTML = [['Pool', st.pool], ['Spa', st.spa], ['Sheer descent', st.waterfall], ['Jets', st.jets], ['Air blower', st.blower], ['Heater', st.heater], ['Lights', st.lights]].map(([n, on]) => `<span${on ? ' class="on"' : ''}>${on ? '● ' : ''}${n}</span>`).join('');
  drawPoolTiles(S, st);
  $('poolNote').innerHTML = `IntelliFlo VSF on a Quad D.E. 80 filter, ${sp.gallons.toLocaleString()} gal. Streams follow the water: skimmer → pump → filter → heater → returns; green is the spa loop, purple the sheer-descent feed. Speed follows the pump's RPM. Lights are 500 W + 100 W incandescent, the blower 1.1 kW, the UV lamp ~60 W while the pump runs.${d.model.measured.length ? ` Measured: ${d.model.measured.map(m => `${m.rpm}→${Math.round(m.watts)} W`).join(', ')}.` : ''}${d.error ? ` <span style="color:var(--warn)">Last read failed: ${esc(d.error)}</span>` : ''}`;
  drawPlanner(S); drawAutopilot(S);
  $('poolSeason').hidden = $('poolSeasonNote').hidden = !d.seasons?.length;
  $('poolSeason').innerHTML = (d.seasons ?? []).map(s => `<span${s.current ? ' style="color:var(--text)"' : ''}>${esc(s.label)} <b class="c-num">${esc(s.kwhPerDay)}</b></span>`).join('');
}
/** The Pool system card: the mode pill (Clear-up and Boost win), the pump speed, one line and today's runs on the strip. */
function drawPoolSys(S) {
  const d = S.pool, L = d.live, linked = d.linked || !!L, bid = boostId(S), cu = d.clearUp, boostOn = !!d.snapshot?.circuits?.find(c => c.id === bid)?.on;
  const mode = d.autopilot?.mode ?? d.settings?.autopilot, t = d.snapshot?.bodies?.[0]?.temp;
  const line = !linked ? 'Not linked' : cu ? `Clear-up · day ${cu.day} of ${cu.days} · ${cu.rpm.toLocaleString()} rpm` : boostOn ? `Boost${d.until?.[bid] ? ` · until ${clockAt(d.until[bid])}` : ''}`
    : `${L?.running ? `Running · ${Math.round(L.watts)} W` : 'Pump off'}${t != null ? ` · pool ${t}°` : ''}`;
  $('poolSys').innerHTML = sysTop({ ic: 'pool', title: 'Pool', mode: linked ? modePill(cu ? 'clear' : boostOn ? 'boost' : MODE_CLS[mode]) : '', value: !linked ? '—' : L?.running ? `${L.rpm.toLocaleString()} rpm` : 'off',
    line, plan: planStrip(nowPct(localHour()), scheduleBlocks(d.current?.schedules, bid), [], true) });
}
/** Four tiles (Pump W, Pool energy today, Water °F, Turnover with its model badge) and, when there is one, the spa session. */
function drawPoolTiles(S, st) {
  const d = S.pool, L = d.live, A = S.applDay?.date === localDate() ? S.applDay : null, ss = d.spaSession;
  const hours = (A?.hours ?? []).filter(h => h.hour <= localHour()), watts = hours.map(h => h.pool?.watts ?? null), kw = hours.map(h => h.pool?.meanKw ?? null);
  $('poolTiles').innerHTML = tileHtml({ id: 'pTileW', acc: 'c-acc-pool', k: 'Pump', v: L?.running ? Math.round(L.watts) : 'off', unit: L?.running ? 'W' : '', chip: L?.running ? { t: 'flat', text: `${L.rpm.toLocaleString()} rpm` } : null, spark: watts })
    + tileHtml({ id: 'pTileE', acc: 'c-acc-pool', k: 'Pool energy today', v: d.todayKwh ?? '—', unit: 'kWh', chip: d.shareOfHomePct != null ? { t: 'flat', text: `${d.shareOfHomePct}% of home` } : null, spark: kw })
    + tileHtml({ id: 'pTileT', acc: 'c-acc-pool', k: 'Water', v: st.poolTemp != null ? `${st.poolTemp}°` : '—', chip: { t: 'flat', text: `spa ${st.spaTemp ?? '—'}° · air ${L?.airTemp ?? '—'}°` } })
    + tileHtml({ id: 'pTileX', acc: 'c-acc-pool', k: 'Turnover', badge: badge('model'), v: d.current?.turnoverPerDay ?? '—', unit: '×/day', note: d.water ? `goal ${d.water.goal.toFixed(1)}` : '' })
    + (ss && ss.riseF != null ? `<div class="c-tile c-acc-warn wide"><div class="c-tile-k">Spa session · ${ss.spaTemp}° → ${ss.spaSet}°</div><div class="c-tile-n">${ss.riseF ? `${ss.heatMinutes} min of propane · ${ss.propaneGal} gal ≈ ${S.guest ? veil('$•.••') : money2(ss.propaneUsd)}` : 'already at temperature'} · then ${S.guest ? veil('$•.••/h') : `${money2(ss.electricUsdPerHour)}/h`} pump + blower</div><span class="c-spark"></span></div>` : '');
}
/** Every circuit (Systems › Pool › Circuits, and the Pool sheet's row): on or off, its speed and schedule; a row opens its sheet. */
export function openCircuits(S) {
  const d = S.pool, snap = d?.snapshot; if (!snap?.circuits?.length || S.guest) return;
  const speeds = speedsOf(snap), rank = c => { const i = ORDER.indexOf(c.name); return i < 0 ? 99 + c.id : i; }, spaT = snap.bodies?.[1]?.temp;
  const rows = [...snap.circuits].sort((a, b) => rank(a) - rank(b)).map(c => { const sched = (d.current?.schedules ?? []).filter(x => x.circuitId === c.id), rpm = speeds.get(c.id);
    return `<div class="c-sys compact ${c.on ? 'c-acc-pool' : 'c-acc-mute'}" role="button" tabindex="0" data-cid="${c.id}"><span class="c-ic">${icon(/light/i.test(c.name) ? 'light' : isSpa(c) ? 'spa' : /water|fall/i.test(c.name) ? 'waterfall' : /jet/i.test(c.name) ? 'jets' : /blow/i.test(c.name) ? 'blower' : 'pool')}</span>
      <div style="min-width:0"><div class="c-sys-top"><b>${esc(c.name)}</b><span class="c-mode ${c.on ? 'auto' : 'off'}">${c.on ? 'on' : 'off'}</span></div><div class="c-sys-l">${isSpa(c) ? `${spaT != null ? `${spaT}°` : 'spa'}` : rpm ? `${rpm.toLocaleString()} rpm` : 'switch'}${sched.length ? ` · ${sched.map(x => `${hm(x.start)}–${hm(x.stop)}`).join(', ')}` : ' · no schedule'}</div></div><span class="c-chev">${icon('chev')}</span></div>`; }).join('');
  sheet(`${sheetHead('Circuits', '', 'Every circuit on the controller. A circuit’s sheet runs it, or sets its speed for every run.')}<div class="c-card flush">${rows}</div>${pc.err ? `<p class="c-fine" style="color:var(--warn)">${esc(pc.err)}</p>` : ''}${sheetFoot('', 'Done', 'c-acc-pool')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = () => $('phone').classList.remove('open');
  $('sheetBody').querySelectorAll('[data-cid]').forEach(r => r.onclick = () => openCircuit(S, +r.dataset.cid));
}
/** The last pool command's error, for the equipment panel (null when the last one went through). */
export const poolError = () => pc.err;

/* ---------- mockup w frames 1–2: each circuit's sheet ---------- */
const ORDER = ['Pool', 'High Speed', 'Waterfall', 'Jets', 'Air Blower', 'Spa', 'Pool Light', 'Spa Light'];
const RUNS = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h']], LONG_RUN = [720, '12 h'];
const runLabel = m => m % 60 ? `${m} min` : `${m / 60} h`;
const clockAt = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const pc = { sending: new Set(), err: null };
const speedsOf = snap => new Map((snap?.pump?.circuits ?? []).map(c => [c.circuitId, c.speed]));
const isSpa = c => c.function === 1 || /^spa$/i.test(c.name);
export const boostId = S => S.pool?.settings?.boostCircuit ?? 8;

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
    if (/** @type {Element} */ (e.target).closest('#plLearnBtn')) return openPoolChanges(S);
    const b = /** @type {HTMLButtonElement} */ (/** @type {Element} */ (e.target).closest('[data-ps]')); if (!b) return; b.disabled = true; b.textContent = '…';
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
const PL_ACC = { pool: 'c-acc-home', skim: 'c-acc-warn' };
/** The Pump schedule sheet in the component system (mockup al, component 11): the runs as rows, the run being edited (its circuit as
 *  a segment, start and stop, its circuit's speed), Delete this run and Save to the controller in the pinned footer. */
export function scheduleHtml({ runs, sel, names, speeds, P, B }) {
  const r = runs[sel], acc = c => c === B ? PL_ACC.skim : PL_ACC.pool;
  return `${sheetHead('Pump schedule', '', 'What the controller runs every day')}
    ${runs.length ? `<div class="c-card" style="padding:4px 16px"><div class="c-parts" style="margin:0">${runs.map((x, i) => `<div class="c-part ${acc(x.circuitId)}${i === sel ? ' c-open' : ''}" role="button" tabindex="0" aria-pressed="${i === sel}" data-i="${i}"><i></i><span>${esc(names[x.circuitId])}</span><b>${hm(x.start)} – ${hm(x.stop)} · ${speeds[x.circuitId].toLocaleString()}</b></div>`).join('')}</div></div>` : ''}
    ${runs.length < 6 ? '<div class="c-btns"><button class="c-btn line" id="seAdd">+ Add a run</button></div>' : ''}
    ${r ? `<div class="c-lab">Editing ${esc(names[r.circuitId])}</div>
      <div id="seCirc">${seg([P, B].map(c => [c, esc(names[c])]), r.circuitId, { acc: 'c-acc-batt', attr: 'data-c', label: 'Circuit' })}</div>
      <div class="c-fields"><label class="c-field"><small>Start</small><input class="c-input" type="time" step="900" id="seStart" value="${toTime(r.start)}"></label><label class="c-field"><small>Stop</small><input class="c-input" type="time" step="900" id="seStop" value="${toTime(r.stop === 1439 ? 1440 : r.stop)}"></label></div>
      <div class="c-card" style="padding:4px 16px"><div class="c-stepper"><div>Speed<small>${esc(names[r.circuitId])}'s saved speed</small></div><button class="c-step" id="seDn" aria-label="Slower">−</button><b>${speeds[r.circuitId].toLocaleString()}</b><button class="c-step" id="seUp" aria-label="Faster">+</button></div></div>` : ''}
    <p class="c-fine" id="seNote">Saving keeps your schedule: Autopilot switches to Suggest and offers its plan instead of writing over yours. ${esc(names[P])} and ${esc(names[B])} only (Waterfall is a switch only). New runs are added before old ones are removed.</p>
    ${sheetFoot(r ? 'Delete this run' : '', 'Save to the controller', 'c-acc-batt', { del: true })}`;
}
function openEditor(S) {
  const d = S.pool, sp = d.settings, P = sp.poolCircuit ?? 6, B = sp.boostCircuit ?? 8, snap = d.snapshot;
  if (d.clearUp) { toast('!', 'rgba(255,193,94,.2)', 'Clear-up is running', 'End it first to edit the schedule.'); return; }
  const names = { [P]: snap?.circuits.find(c => c.id === P)?.name ?? 'Pool', [B]: snap?.circuits.find(c => c.id === B)?.name ?? 'High Speed' };
  const speeds0 = speedsOf(snap), speeds = { [P]: speeds0.get(P) ?? 1800, [B]: speeds0.get(B) ?? 2400 }, lim = { min: snap?.pump?.minRpm ?? 450, max: snap?.pump?.maxRpm ?? 3450 };
  const runs = d.current.schedules.filter(x => x.circuitId === P || x.circuitId === B).map(x => ({ circuitId: x.circuitId, start: x.start, stop: x.stop }));
  let sel = runs.length ? 0 : -1;
  const go = () => $('sheetBody').querySelector('[data-f="pri"]');
  const draw = () => {
    const r = runs[sel];
    sheet(scheduleHtml({ runs, sel, names, speeds, P, B }), { keepScroll: true });
    $('sheetBody').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { sel = +b.dataset.i; draw(); });
    if ($('seAdd')) $('seAdd').onclick = () => { runs.push({ circuitId: P, start: 600, stop: 900 }); sel = runs.length - 1; draw(); };
    if (r) {
      $('seCirc').onclick = e => { const b = /** @type {Element} */ (e.target).closest('button'); if (!b) return; r.circuitId = +b.dataset.c; draw(); };
      const q15 = v => Math.round(v / 15) * 15;
      $('seStart').onchange = e => { r.start = q15(fromTime(/** @type {HTMLInputElement} */ (e.target).value)) % 1440; draw(); };
      $('seStop').onchange = e => { const m = q15(fromTime(/** @type {HTMLInputElement} */ (e.target).value)); r.stop = m === 0 || m >= 1440 ? 1439 : m; draw(); };
      const step = dv => { speeds[r.circuitId] = Math.max(lim.min, Math.min(lim.max, Math.round((speeds[r.circuitId] + dv) / 50) * 50)); draw(); };
      $('seDn').onclick = () => step(-50); $('seUp').onclick = () => step(50);
      $('sheetBody').querySelector('[data-f="sec"]').onclick = () => { runs.splice(sel, 1); sel = Math.min(sel, runs.length - 1); save(); };   // Delete this run
    }
    go().onclick = save;
  };
  const save = async () => {
    const bad = runs.find(x => x.start === x.stop); if (bad) { $('seNote').textContent = 'A run needs a stop after its start.'; return; }
    const used = [...new Set(runs.map(x => x.circuitId))], body = { schedules: runs, speeds: used.filter(c => speeds[c] !== speeds0.get(c)).map(c => ({ circuitId: c, rpm: speeds[c] })) };
    go().textContent = 'Saving\u2026';
    try { S.pool = await api.poolSchedule(body); closeSheet(); drawPool(S); }
    catch (e) { go().textContent = 'Save to the controller'; $('seNote').textContent = `Couldn\u2019t save: ${e.message}`; }
  };
  draw();
}

/* frame 6: Clear-up — the Pool circuit all day for 1–3 days, then back to the planner by itself; only End now ends it early */
const endsLabel = ms => `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })} ${clockAt(ms)}`;
const poolRunAfter = t => { const d = new Date(t); d.setUTCHours(1, 15, 0, 0); if (d.getTime() < t) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); };   // as the server
export async function clearUpSend(S, body) {
  pc.clearBusy = true; pc.err = null; redrawPoolPanels();
  try { S.pool = await api.poolClearUp(body); } catch (e) { pc.err = `Clear-up: ${e.message}`; }
  pc.clearBusy = false; drawPool(S); S.onPool?.();
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
  $('pcDays').onclick = e => { const b = /** @type {Element} */ (e.target).closest('button'); if (!b) return; days = +b.dataset.n; draw(); };
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
  if (waits) return banner({ cls: 'teal', ic: 'plane', title: `Trip plan waits${until ? ` until ${esc(until)}` : ''}`, line: `${esc(why.replace(/^Vacation: /, '').replace(/^the trip plan waits/, 'The trip plan waits'))}. The normal plan runs until a clear test.` });
  return banner({ cls: 'teal', ic: 'plane', title: `Trip plan · ${esc(goal ?? 'trip goal')} a day`, line: `${until ? `Until ${esc(until)}. ` : 'Until you’re back. '}${p ? `${p.hours} h at ${p.rpm.toLocaleString()} rpm. ` : ''}Your goal of ${S.pool.settings?.turnoverGoal ?? 3} comes back the evening before you do.` });
}
/** The banner in the Pool Autopilot card while a Clear-up runs (or a trip's plan is on). */
function drawClearBanner(S) {
  const cu = S.pool.clearUp, box = $('plClear'); if (!box) return;
  if (!cu) { box.innerHTML = tripBanner(S); return; }
  const f = Math.min(1, Math.max(0, (Date.now() - cu.startedAt) / (cu.until - cu.startedAt)));
  box.innerHTML = banner({ cls: 'blue', ic: 'pool', title: `Clear-up · day ${cu.day} of ${cu.days}`, line: `Ends ${endsLabel(cu.until)}. Pool on all day at ${cu.rpm.toLocaleString()} rpm; the planner and Autopilot leave the schedule alone until then. Brush the walls and backwash the DE filter when the pressure climbs.`,
    bar: f * 100, btns: S.guest ? [] : [['Add a day', 'cu:extend', false], ['End now', 'cu:end', false]] });
  box.querySelectorAll('[data-b]').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => { const a = b.dataset.b.split(':')[1];
    if (a === 'end' && !confirm('End the Clear-up now? The planner’s schedule goes back on the controller.')) return;
    b.disabled = true; b.textContent = 'Sending…'; clearUpSend(S, { action: a }); });
}
/** Send one or more commands for a circuit in order; the tile says "sending…" until the controller's read-back answers. */
export async function poolSend(S, ...cmds) {
  const id = cmds.find(c => c.id != null)?.id ?? 1, name = S.pool.snapshot?.circuits.find(c => c.id === id)?.name ?? 'Pool';
  pc.sending.add(id); pc.err = null; redrawPoolPanels();
  try { for (const c of cmds) S.pool = await api.poolCommand(c); }
  catch (e) { pc.err = `${name}: ${e.message}`; }
  pc.sending.delete(id); drawPool(S); S.onPool?.();
}
/** One circuit's sheet in the component system (mockup al, component 11): the spa's heat as a segment and a stepper, Run for as a
 *  segment, the speed stepper, the primary write and Turn off in the pinned footer. */
export function circuitHtml({ c, sched, body, runs, pick, rpm0, lim }) {
  return `${sheetHead(esc(c.name), '', `${c.on ? 'On' : 'Off'} · ${sched.length ? `on schedule ${sched.map(x => `${hm(x.start)}–${hm(x.stop)}`).join(', ')}` : 'not on any schedule'}`)}
    ${body ? `<div class="c-lab">Spa heat</div><div id="pcHeat">${seg([['0', 'Off'], ['1', 'On']], body.heatMode === 3 ? '1' : '0', { acc: 'c-acc-warn', attr: 'data-h', label: 'Spa heat' })}</div>
      <div class="c-card" id="pcDial" style="padding:4px 16px"><div class="c-stepper"><div>Heat to<small>${body.heating ? 'heating now' : 'heater off now'}</small></div><button class="c-step" id="pcHdn" aria-label="Cooler">−</button><b id="pcSet"></b><button class="c-step" id="pcHup" aria-label="Warmer">+</button></div></div>` : ''}
    <div id="pcRun"${c.on ? ' hidden' : ''}><div class="c-lab">Run for</div><div id="pcRuns">${seg(runs.map(([m, l]) => [String(m), l]), String(pick), { acc: 'c-acc-pool', attr: 'data-m', label: 'Run for' })}</div></div>
    ${!body && rpm0 != null ? `<div class="c-card" style="padding:4px 16px"><div class="c-stepper"><div>Speed<small>whenever ${esc(c.name)} runs · ${lim.min.toLocaleString()}–${lim.max.toLocaleString()}</small></div><button class="c-step" id="pcDn" aria-label="Slower">−</button><b id="pcRpm"></b><button class="c-step" id="pcUp" aria-label="Faster">+</button></div></div>` : ''}
    <p class="c-fine" id="pcNote"></p>
    ${sheetFoot(c.on ? 'Turn off' : '', '', 'c-acc-pool', { del: true })}`;
}
export function openCircuit(S, id) {
  const d = S.pool, snap = d.snapshot, c = snap?.circuits.find(x => x.id === id); if (!c || S.guest) return;
  const rpm0 = speedsOf(snap).get(id), lim = { min: snap.pump?.minRpm ?? 450, max: snap.pump?.maxRpm ?? 3450 };
  const runs = /light/i.test(c.name) || isSpa(c) ? [...RUNS, LONG_RUN] : RUNS, sched = (d.current?.schedules ?? []).filter(x => x.circuitId === id);
  let pick = d.runFor?.[id] ?? 60, rpm = rpm0;
  if (!runs.some(r => r[0] === pick)) pick = 60;
  // frame 4: the spa's heat (heater mode 3 = on, 0 = off) and setpoint 80–104°; the heater only runs while the Spa circuit is on
  const body = isSpa(c) ? snap.bodies?.[1] : null, heat0 = body?.heatMode === 3, set0 = Math.min(104, Math.max(80, body?.setPoint || 100));
  let heat = heat0, setF = set0;
  sheet(circuitHtml({ c, sched, body, runs, pick, rpm0, lim }));
  const box = $('sheetBody'), go = box.querySelector('[data-f="pri"]'), off = box.querySelector('[data-f="sec"]');
  const draw = () => {
    if ($('pcRuns')) segSet($('pcRuns').firstElementChild, String(pick), 'data-m');
    if ($('pcRpm')) $('pcRpm').textContent = rpm.toLocaleString();
    const sped = rpm0 != null && rpm !== rpm0, heated = !!body && (heat !== heat0 || (heat && setF !== set0));
    if (body) { segSet($('pcHeat').firstElementChild, heat ? '1' : '0', 'data-h'); $('pcDial').hidden = !heat; $('pcSet').textContent = `${setF}°`; }
    go.textContent = c.on ? (heated ? (heat ? `Save heat · ${setF}°` : 'Turn spa heat off') : sped ? `Save ${rpm.toLocaleString()} RPM` : 'Turn off')
      : body ? `Spa on${heat ? ` · heat to ${setF}°` : ''} for ${runLabel(pick)}` : `Turn on for ${runLabel(pick)}`;
    if (off) /** @type {HTMLElement} */ (off).hidden = !(sped || heated);
    $('pcNote').textContent = body ? `The heater only runs while the Spa circuit is on. Setpoint 80–104°. Autopilot never touches the spa, its heat, the lights or the heater; only you do.`
      : c.on ? (sped ? `The new speed applies now and whenever ${c.name} runs, schedules included.` : '')
      : `Turns itself off at ${clockAt(Date.now() + pick * 60_000)} (the controller's own timer, so it stops even if Solstice is offline).`;
  };
  const step = dv => { rpm = Math.max(lim.min, Math.min(lim.max, Math.round((rpm + dv) / 50) * 50)); draw(); };
  if ($('pcRuns')) $('pcRuns').onclick = e => { const b = /** @type {Element} */ (e.target).closest('button'); if (!b) return; pick = +b.dataset.m; draw(); };
  if ($('pcDn')) { $('pcDn').onclick = () => step(-50); $('pcUp').onclick = () => step(50); }
  if (body) {
    $('pcHeat').onclick = e => { const b = /** @type {Element} */ (e.target).closest('button'); if (!b) return; heat = b.dataset.h === '1'; draw(); };
    $('pcHdn').onclick = () => { setF = Math.max(80, setF - 1); draw(); }; $('pcHup').onclick = () => { setF = Math.min(104, setF + 1); draw(); };
  }
  go.onclick = () => {
    const sped = rpm0 != null && rpm !== rpm0, heated = !!body && (heat !== heat0 || (heat && setF !== set0));
    const cmds = /** @type {any[]} */ ([...(heated ? [heat ? { kind: 'spaHeat', on: true, setF } : { kind: 'spaHeat', on: false }] : []), ...(sped ? [{ kind: 'speed', id, rpm }] : [])]);
    if (!c.on) cmds.push({ kind: 'circuit', id, on: true, minutes: pick }); else if (!sped && !heated) cmds.push({ kind: 'circuit', id, on: false });
    closeSheet(); poolSend(S, ...cmds);
  };
  if (off) off.onclick = () => { closeSheet(); poolSend(S, { kind: 'circuit', id, on: false }); };   // Turn off (shown while a speed or heat change is staged)
  draw();
}

/* ---------- the Pool Autopilot card (mockup al frames 12, 12b; the turnover planner of mockup w frame 5 lives in it) ---------- */
const goal = { v: null, skim: null, saving: false };   // a staged goal change (Schedule & goal's steppers), sent only by its Save
function drawPlanner(S) {
  const d = S.pool, w = d.water, P = d.plan, C = d.current, sp = d.settings; if (!w || !P) return;
  drawClearBanner(S);
  // the goal well: water moved so far today (readings) against the goal, the sentence, today's runs on the strip and their legend
  const f = Math.min(1, w.movedTurnovers / w.goal);
  $('plArc').setAttribute('stroke-dasharray', `${(100.5 * f).toFixed(1)} 100.5`);
  $('plMoved').textContent = w.movedTurnovers.toFixed(1);
  const bid = sp.boostCircuit ?? 8, bUntil = d.until?.[bid], T = d.autopilot?.tomorrow?.plan;
  $('plTxt').innerHTML = `<b>${w.movedTurnovers.toFixed(1)} of ${w.goal.toFixed(1)} turnovers today</b>${bUntil ? ', including your boost' : ''}. `
    + (w.projectedTurnovers > w.movedTurnovers + .05 ? `The rest of today’s schedule brings it to ${w.projectedTurnovers.toFixed(1)}.` : 'Nothing more is scheduled today.')
    + (T ? `<br>${tomorrowLine(S)}` : '');
  const nowM = Math.floor(localHour() * 60), blocks = scheduleBlocks(C.schedules, bid);
  if (bUntil) blocks.push({ left: Math.round(nowM / 14.4 * 10) / 10, width: Math.round(Math.min(1440 - nowM, Math.round((bUntil - Date.now()) / 60_000)) / 14.4 * 10) / 10, cls: 'alt' });
  $('plDay').style.setProperty('--now', `${nowPct(localHour())}%`);
  $('plDay').innerHTML = blocks.map(b => `<i class="${b.cls}" style="left:${b.left}%;width:${b.width}%"></i>`).join('') + '<s></s>';
  const span = s => s.stop === s.start || (s.start === 0 && s.stop >= 1439) ? 'all day' : `${hm(s.start)}–${hm(s.stop)}`;
  $('plList').innerHTML = C.schedules.map(s => `<span class="${s.circuitId === bid ? 'c-acc-warn' : 'c-acc-pool'}"><i></i>${esc(s.name)} ${span(s)} <b>${s.rpm.toLocaleString()}</b></span>`).join('')
    + (bUntil ? `<span class="c-acc-warn"><i></i>Your boost · until ${clockAt(bUntil)} <b>${(speedsOf(d.snapshot).get(bid) ?? 0).toLocaleString()}</b></span>` : '')
    || '<span>No pump programs on the controller.</span>';
  $('plEdit').onclick = () => openEditor(S);
  // Schedule & goal: the steppers stage a change; Save sends it (POST …/pool/goal), Cancel puts the saved goal back
  const g = goal.v ?? w.goal, sk = goal.skim ?? w.skimHours, staged = goal.v != null && (goal.v !== w.goal || goal.skim !== w.skimHours);
  $('plGoal').textContent = g.toFixed(1); $('plSkim').textContent = `${sk} h`;
  $('plGoalLine').textContent = `${w.goal.toFixed(1)} turnovers · skim ${w.skimHours} h`;
  $('ruleGoal').textContent = `goal: ${w.goal} turnover${w.goal === 1 ? '' : 's'}`;   // the Rules chip follows the goal
  $('plGal').textContent = `goal · ${w.gallons.toLocaleString()} gal · ${g} = about ${(Math.round(w.gallons * g / 1000) * 1000).toLocaleString()} gal`;
  $('plGoalStage').innerHTML = staged ? `<div class="c-btns c-stagerow"><button class="c-btn line" data-g="cancel">Cancel</button><button class="c-btn pri c-acc-pool" data-g="save">${goal.saving ? 'Saving…' : `Save goal ${g.toFixed(1)} · skim ${sk} h`}</button></div>` : '';
  const step = (k, dv) => { goal.v ??= w.goal; goal.skim ??= w.skimHours; if (k === 'g') goal.v = Math.max(1, Math.min(4, goal.v + dv)); else goal.skim = Math.max(0, Math.min(3, goal.skim + dv)); drawPlanner(S); };
  $('plGdn').onclick = () => step('g', -.5); $('plGup').onclick = () => step('g', .5); $('plSdn').onclick = () => step('s', -1); $('plSup').onclick = () => step('s', 1);
  $('plGoalStage').onclick = async e => { const b = /** @type {Element} */ (e.target).closest('[data-g]'); if (!b || goal.saving) return;
    if (b.dataset.g === 'cancel') { goal.v = goal.skim = null; return drawPlanner(S); }
    goal.saving = true; drawPlanner(S);
    try { S.pool = await api.poolGoal({ turnoverGoal: goal.v, skimHours: goal.skim }); goal.v = goal.skim = null; }
    catch (err) { $('plNote').textContent = `Couldn’t save the goal: ${err.message}`; }
    goal.saving = false; drawPool(S); S.onPool?.(); };
  // B2-7 (audit L-17): the server's confidence in the plan's kWh a day (learning layer pool.kwhDay)
  const kc = cBadge(d.conf?.kwhPerDay, modelOf(S.models, 'pool.kwhDay'));
  $('plNums').innerHTML = `<div><b>${P.hours} h</b><span>pump a day</span></div><div><b>${P.kwhPerDay}</b><span>kWh a day</span>${kc && `<span style="margin-top:5px">${kc}</span>`}</div><div><b>${S.guest ? veil('$•') : P.costPerMonth == null ? '—' : money(P.costPerMonth)}</b><span>a month</span></div>`;
  drawPoolLearning(S);
  $('plNote').textContent = `The planner picks hours and speed to reach the goal for the least energy (${P.hours} h at ${P.rpm.toLocaleString()} RPM${P.boostHours ? ` with ${P.boostHours} h at ${sp.boostRpm.toLocaleString()}` : ''}), keeps the skim hour at the sunniest hour, and adds time on hot days (+1 h at 85°) and after rain. Water moved uses the flow model (no flow sensor on this pump), so turnovers are an estimate.`;
}
/** "Tomorrow: 12 h at 1,750 rpm + 1 h skim · writes at 8:15 PM" (the collapsed card's line, as the Pool sheet says it). */
function tomorrowLine(S) {
  const d = S.pool, ap = d.autopilot, T = ap?.tomorrow?.plan, mode = ap?.mode ?? d.settings?.autopilot; if (!T) return '';
  return `Tomorrow: ${T.hours} h at ${(T.rpm ?? d.settings?.filterRpm ?? 0).toLocaleString()} rpm${T.boostHours ? ` + ${T.boostHours} h skim` : ''} · ${mode === 'auto' ? 'writes' : mode === 'off' ? 'off, nothing written' : 'suggests'}${mode !== 'off' && ap?.nextRunAt ? ` at ${clockAt(Date.parse(ap.nextRunAt))}` : ''}`;
}

/* ---------- Pool Autopilot: mode (staged), status, the six signals, the week, a waiting suggestion, the log row ---------- */
const apStage = { m: null, sending: false };
function drawAutopilot(S) {
  const d = S.pool, a = d.autopilot;
  if (!a || a.error) { $('autoSum').textContent = a?.error ?? 'Autopilot unavailable'; return; }
  const w = d.water, m = apStage.m ?? a.mode;
  $('autoBadge').innerHTML = modePill(MODE_CLS[a.mode] ?? a.mode);
  $('autoFig').textContent = w ? `${w.movedTurnovers.toFixed(1)} / ${w.goal.toFixed(1)}` : '—';
  $('autoSum').textContent = tomorrowLine(S) || 'No plan for tomorrow yet.';
  // the mode, staged: Off · Suggest · Auto, then one row that names the write ("Set Pool Autopilot to Auto") with the old confirms
  $('autoMode').innerHTML = seg([['off', 'Off'], ['suggest', 'Suggest'], ['auto', 'Auto']], m, { acc: 'c-acc-batt', attr: 'data-ap', label: 'Pool Autopilot' })
    + (apStage.m && apStage.m !== a.mode ? `<div class="c-btns c-stagerow"><button class="c-btn line" data-aps="cancel">Cancel</button><button class="c-btn pri c-acc-batt" data-aps="send">${apStage.sending ? 'Saving…' : autopilotStage('Pool', apStage.m)}</button></div>` : '');
  $('autoMode').onclick = async e => {
    const b = /** @type {Element} */ (e.target).closest('[data-ap]'); if (b) { apStage.m = b.dataset.ap === a.mode ? null : b.dataset.ap; return drawAutopilot(S); }
    const s = /** @type {Element} */ (e.target).closest('[data-aps]'); if (!s || apStage.sending) return;
    if (s.dataset.aps === 'cancel') { apStage.m = null; return drawAutopilot(S); }
    if (apStage.m === 'auto' && !confirm('Auto mode writes tomorrow’s schedule to ScreenLogic every evening without asking. Spa, heater, lights and freeze protection are never touched. Turn it on?')) return;
    if (apStage.m === 'off' && !confirm('Turn Pool Autopilot off?\n\nSolstice stops planning and writing the pump schedule. The controller keeps running what it has now.')) return;   // mockup ac
    apStage.sending = true; drawAutopilot(S);
    await api.poolAutopilot(apStage.m).catch(err => alert(err.message)); apStage.sending = false; apStage.m = null; await load(S);
  };
  const next = new Date(a.nextRunAt);
  $('autoStatus').textContent = a.mode === 'off' ? 'Off. Suggest plans tomorrow each evening and waits for you; Auto applies it.' : `${a.mode === 'auto' ? 'Writes' : 'Suggests'} tomorrow’s plan tonight at ${next.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · never touches spa, heater, lights or freeze protection.`;
  const g = a.signals;
  $('autoSignals').innerHTML = gauge(`${g.waterTemp}°`, 'water', g.waterTemp / 100, 'c-acc-pool') + gauge(esc(g.sunKwhM2), 'sun', g.sunPct / 100, 'c-acc-solar') + gauge(`${g.high}°`, 'high', g.high / 105, 'c-acc-ac')
    + gauge(`${g.rainPct}%`, 'rain', g.rainPct / 100, 'c-acc-pool') + gauge(`${g.useDays}/7`, 'use', g.useDays / 7, 'c-acc-grid') + gauge(esc(g.pollen), 'pollen', g.pollen === 'high' ? .9 : g.pollen === 'medium' ? .5 : .15, 'c-acc-batt');
  const T = a.tomorrow; $('autoTomorrow').textContent = `tomorrow ${T.plan.hours} h${T.plan.boostHours ? ' + boost' : ''}${T.why.length ? ' · ' + T.why[0].split(':')[0].toLowerCase() : ''}`;
  const days = a.week, X = i => 12 + i * 42, mxSun = Math.max(1, ...days.map(x => x.sunKwhM2));
  let o = `<defs><linearGradient id="asg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--solar);stop-opacity:.4"/><stop offset="1" style="stop-color:var(--solar);stop-opacity:0"/></linearGradient><linearGradient id="awg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--home)"/><stop offset="1" style="stop-color:var(--home);stop-opacity:.25"/></linearGradient></defs>`;
  const Y = v => 88 - v / mxSun * 38, pts = days.map((x, i) => `${X(i) + 15},${Y(x.sunKwhM2)}`); if (days.length) o += `<path d="M${X(0) + 15},84 L${pts.join(' L')} L${X(days.length - 1) + 15},84 Z" fill="url(#asg)"/>`;
  days.forEach((x, i) => { const px = X(i), hh = x.hours / 12 * 56, tm = i === 0;
    o += `<rect x="${px + 7}" y="${84 - hh}" width="16" height="${hh}" rx="5" fill="url(#awg)" opacity="${tm ? 1 : .8}"/>${x.boost ? `<circle cx="${px + 15}" cy="${84 - hh - 6}" r="3" style="fill:var(--warn)"/>` : ''}<text class="v" x="${px + 15}" y="${84 - hh - (x.boost ? 14 : 6)}" text-anchor="middle">${x.hours}h</text><text x="${px + 15}" y="104" text-anchor="middle">${new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</text>`; });
  $('autoWeek').innerHTML = o;
  $('autoPending').innerHTML = a.pending && d.pending ? `<div class="c-well"><div class="c-head"><h5>Suggested for ${esc(niceDate(d.pending.date, { weekday: 'long' }))}</h5></div><p class="c-sum">${d.pending.plan.hours} h at ${d.settings.filterRpm.toLocaleString()} rpm, ${hm(d.pending.plan.start * 60)}–${hm(d.pending.plan.stop * 60)}${d.pending.plan.boostHours ? `, skim boost at ${hm(d.pending.plan.boostAt * 60)}` : ''}. ${d.pending.why.map(esc).join('; ') || 'Season plan.'}</p>${S.guest ? '' : '<div class="c-btns"><button class="c-btn pri c-acc-batt block" id="applyTomorrow">Apply tomorrow’s plan</button></div>'}</div>` : '';
  const at = $('applyTomorrow'); if (at) at.onclick = async () => { at.textContent = 'Applying…'; try { await api.poolApplyTomorrow(); await load(S); } catch (e) { alert(e.message); at.textContent = 'Apply tomorrow’s plan'; } };
  const last = a.log?.[0];
  $('autoLogLine').textContent = last ? `last: ${niceDate(last.day, { month: 'short', day: 'numeric' })}${Number.isFinite(last.at) ? ` · ${clockAt(last.at)}` : ''} · opens the timeline` : 'nothing yet · opens the timeline';
  $('autoLogRow').onclick = () => S.openLog?.({ src: 'pool' });
  // the D.E. filter's run hours (owner: "I cleaned the filter" logs the cleaning)
  $('plFilter').innerHTML = `<p><b>Filter</b> · about ${a.filterHours} run hours since ${a.filterCleanedOn ? `the D.E. cleaning on ${niceDate(a.filterCleanedOn)}` : 'Solstice started counting'}</p>${S.guest ? '' : '<button class="c-btn sm line" id="logClean">I cleaned the filter</button>'}`;
  if ($('logClean')) $('logClean').onclick = async () => { await api.addEvent('filter_cleaned', new Date().toLocaleDateString('en-CA')); await load(S); };
}
