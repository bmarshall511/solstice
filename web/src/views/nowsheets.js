// The control sheets opened from Now's Autopilot hub (approved mockup mockups/al-ia.html v2, frames 5, 6 and 7): Pool, AC and Powerwalls.
// Writes are staged: the dial, presets, toggles and mode segments change only this sheet's state, and the pinned footer's primary names
// the one exact write ("Run 2,400 rpm · 1 h", "Set 77°"); only its tap calls a route, and only routes that already existed:
// /api/appliances/pool/command, …/pool/autopilot, …/pool/clearup, …/pool/apply-tomorrow, …/ac/command, …/ac/hold, …/ac/settings,
// …/ac/untrim, …/ac/nudge (through the existing nudge sheet), /api/powerwall/rules/:id(/apply). Named action buttons inside the sheet
// ("End now", "Add a day", "Resume now", "Apply", "Undo") act on tap with the confirms they always had. Owner only.
import { $ } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { clock, weekday } from '../lib/presence.js';
import { icon } from '../lib/icons.js';
import { dialPoint, arcPath, dialFrac, toFrac, fromFrac, snapRpm, snapDeg, thermoTone, pumpPresets, poolSpeedStage, circuitStage, autopilotStage, acStage,
  holdProgress, runLabel, rulesPill, ageWords, NEST_WORD } from '../lib/nowui.js';
import { sheet, sheetHead, sheetFoot, modePill, seg, sysRow, banner, closeSheet } from './csheet.js';
import { poolSend, clearUpSend, openClearUp, boostId, drawPool } from './appliances.js';
import { drawAc, openComfort, openNudge, loadAc } from './ac.js';
import { RULE, EXPORT, MODE, waitingSuggestion, applyRule, setRuleMode, skip, loadPowerwallRules } from './powerwall.js';
import { openVacation } from './vacation.js';

const MODES = [['off', 'Off'], ['suggest', 'Suggest'], ['auto', 'Auto']];
const foot = () => $('sheetBody').querySelector('.c-sheet-f');
/** The footer: nothing staged → [Open …] [Done]; staged → [Cancel] [the write]. */
const footer = (stage, open, acc) => stage ? sheetFoot('Cancel', esc(stage.label), acc) : sheetFoot(open, 'Done', acc);
const vib = () => { try { navigator.vibrate?.(8); } catch { /* no haptics */ } };

/* ---------- the 240° dial (equipment panel and thermostat) ---------- */
function dialSvg({ label, min, max, value, ticks = [], minor = false, soft = null, dot = null, valFrom = 0, aria }) {
  const f = toFrac(value, min, max), [kx, ky] = dialPoint(f), line = (fr, r0, r1, cls) => { const [x0, y0] = dialPoint(fr, r0), [x1, y1] = dialPoint(fr, r1); return `<line class="${cls}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`; };
  let o = `<path class="c-arc-track" d="${arcPath(0, 1)}"/>`;
  if (minor) for (let v = min; v <= max; v++) o += line(toFrac(v, min, max), 112, (v - min) % 5 ? 116 : 119, 'c-arc-minor');
  for (const t of ticks) o += line(toFrac(t.v, min, max), 111, 118, `c-arc-tick${t.on ? ' on' : ''}`);
  if (soft != null) o += `<path class="c-arc-soft" d="${arcPath(0, f)}"/>`;
  o += dot != null ? `<path class="c-arc-val" d="${arcPath(f, toFrac(dot, min, max))}"/>` : `<path class="c-arc-val" d="${arcPath(valFrom, f)}"/>`;
  if (dot != null) { const [dx, dy] = dialPoint(toFrac(dot, min, max)); o += `<circle class="c-arc-dot" cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="4"/>`; }
  o += `<circle class="c-arc-halo" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="22"/><circle class="c-arc-knob" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="12"/>`;
  return `<svg viewBox="0 0 260 196" role="slider" tabindex="0" aria-label="${esc(label)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}"${aria ? ` aria-valuetext="${esc(aria)}"` : ''}>${o}</svg>`;
}
/** Drag and keys on a dial: `onMove(v)` while dragging (cheap redraw), `onSet(v)` on release or a key. */
function wireDial(el, { min, max, snap, step, onMove, onSet }) {
  const svg = el.querySelector('svg'); if (!svg) return;
  const at = e => { const b = svg.getBoundingClientRect(); return snap(fromFrac(dialFrac((e.clientX - b.left) / b.width * 260, (e.clientY - b.top) / b.height * 196), min, max)); };
  let drag = false, last = null;
  svg.onpointerdown = e => { drag = true; svg.setPointerCapture?.(e.pointerId); last = at(e); onMove(last); e.preventDefault(); };
  svg.onpointermove = e => { if (!drag) return; const v = at(e); if (v !== last) { last = v; vib(); onMove(v); } };
  svg.onpointerup = svg.onpointercancel = () => { if (!drag) return; drag = false; onSet(last); };
  svg.onkeydown = e => { const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!d) return; e.preventDefault(); onSet(step(d)); };
  svg.style.touchAction = 'none';
}

/* ======================= Pool (frame 5) ======================= */
const TGL = [['Features', 'tap · hold for time', [['Waterfall', 'waterfall'], ['Jets', 'jets'], ['Air Blower', 'blower']]], ['Spa & lights', 'hold Spa for heat', [['Spa', 'spa'], ['Pool Light', 'light'], ['Spa Light', 'spalight']]]];
const RUNS = [30, 60, 120, 240, 720];
const isSpa = c => c.function === 1 || /^spa$/i.test(c.name);
const leftText = ms => { const m = Math.max(1, Math.round(ms / 60_000)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}` : `${m} min`; };
const hm = m => `${String(Math.floor(m / 60) % 12 || 12)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${Math.floor(m / 60) % 24 < 12 ? 'a' : 'p'}`;
export function openPoolSheet(S) {
  const st = { rpm: null, tab: null, stage: null, long: null, minutes: null, heat: null, setF: null, sending: false };
  const draw = () => {
    const d = S.pool; if (!d) return sheet(`${sheetHead('Pool')}<p class="c-sheet-sub">Waiting for the controller…</p>${sheetFoot('', 'Done', 'c-acc-pool')}`), wireFoot();
    const L = d.live, snap = d.snapshot, s = d.settings ?? {}, linked = d.linked || !!L, ap = d.autopilot, mode = ap?.mode ?? s.autopilot;
    if (!linked) { sheet(`${sheetHead('Pool')}<p class="c-sheet-sub">${esc(d.error ?? 'ScreenLogic is not linked. Add the system name and password to link the pool.')}</p>${sheetFoot('Open Pool', 'Done', 'c-acc-pool')}`); return wireFoot(); }
    const pid = s.poolCircuit ?? 6, bid = boostId(S), speeds = new Map((snap?.pump?.circuits ?? []).map(c => [c.circuitId, c.speed]));
    const lim = { min: snap?.pump?.minRpm ?? 450, max: snap?.pump?.maxRpm ?? 3450 }, presets = pumpPresets(d);
    const circ = id => snap?.circuits?.find(c => c.id === id), poolOn = !!circ(pid)?.on, boostOn = !!circ(bid)?.on, cu = d.clearUp;
    const running = !!L?.running, cur = running ? L.rpm : (speeds.get(pid) ?? presets[1].rpm), v = st.rpm ?? cur;
    const match = presets.find(p => p.rpm === v);
    const tab = st.tab ?? (cu ? 'clear' : boostOn ? 'boost' : 'plan');
    const temp = snap?.bodies?.[0]?.temp, at = L?.at ?? snap?.at;
    const sub = `Pool ${temp ?? '—'}° · pump ${running ? 'running' : 'off'}${at ? ` · linked ${ageWords(Date.now() - at)}` : ''}`;
    // dial + presets
    const em = st.rpm != null ? 'staged · tap below to send' : cu ? 'Clear-up' : boostOn ? 'Boost' : running ? `${match ? `${match.name} · ` : ''}on plan` : 'pump off';
    const dial = `<div class="c-dial c-acc-pool" id="plDial">${dialSvg({ label: 'Pump speed', min: lim.min, max: lim.max, value: v, ticks: presets.map(p => ({ v: p.rpm, on: p.rpm === v })), aria: `${v.toLocaleString()} rpm` })}
      <div class="c-dial-c"><small>Pump</small><b id="plV">${v.toLocaleString()}</b><span>rpm${running ? ` · ${Math.round(L.watts)} W` : ''}</span><em id="plEm">${esc(em)}</em></div>
      <span class="c-dial-end" style="left:22px">${lim.min.toLocaleString()}</span><span class="c-dial-end" style="right:12px">${lim.max.toLocaleString()}</span></div>
      <div class="c-presets c-acc-pool" id="plPre">${presets.map(p => `<button class="c-preset${p.rpm === v ? ' on' : ''}" data-rpm="${p.rpm}" aria-pressed="${p.rpm === v}"><b>${p.name}</b><span>${p.rpm.toLocaleString()}</span></button>`).join('')}</div>
      <p class="c-fine" style="margin-top:8px">Filter and Skim are ${presets[1].src === 'controller' ? 'the controller’s saved Pool and High Speed speeds' : 'Solstice’s defaults until the controller is read'}; Quiet and Max are Solstice’s.</p>`;
    // Plan · Boost · Clear-up, the mode line carrying that mode's actions
    const runs = (d.current?.schedules ?? []).map(x => `${x.circuitId === bid ? 'skim ' : ''}${hm(x.start)}–${hm(x.stop)} at ${x.rpm.toLocaleString()}`).join(' · ');
    const bu = d.until?.[bid], bRpm = speeds.get(bid) ?? presets[2].rpm;
    const line = tab === 'plan' ? `<p><b>${cu || boostOn ? 'The plan' : 'On plan'}</b> · ${runs ? esc(runs) : 'no pump programs on the controller'}</p>`
      : tab === 'boost' ? (boostOn ? `<p><b>Boost</b> · ${bRpm.toLocaleString()} rpm${bu ? ` · ends ${esc(clock(bu))}` : ''}</p><button class="c-btn sm line" data-act="boost-end">End now</button>`
        : `<p><b>Boost</b> · High Speed at ${bRpm.toLocaleString()} rpm on its own timer</p><button class="c-btn sm" data-act="boost-stage">Boost ${runLabel(d.runFor?.[bid] ?? 60)}</button>`)
      : cu ? `<p><b>Clear-up</b> · day ${cu.day} of ${cu.days} · ${cu.rpm.toLocaleString()} rpm · ends ${esc(weekday(cu.until))} ${esc(clock(cu.until))}</p><div class="c-bar"><i style="width:${Math.round(Math.min(1, Math.max(0, (Date.now() - cu.startedAt) / (cu.until - cu.startedAt))) * 100)}%"></i></div><button class="c-btn sm" data-act="cu-extend">Add a day</button><button class="c-btn sm line" data-act="cu-end">End now</button>`
        : `<p><b>Clear-up</b> · the pool runs around the clock for 1–3 days, then back to the planner</p><button class="c-btn sm" data-act="cu-open">Set up…</button>`;
    const modes = `${seg([['plan', 'Plan'], ['boost', 'Boost'], ['clear', 'Clear-up']], tab, { acc: tab === 'boost' ? 'c-acc-warn' : 'c-acc-pool', attr: 'data-tab', label: 'Pump mode' })}<div class="c-modeline ${tab === 'boost' ? 'c-acc-warn' : 'c-acc-pool'}">${line}</div>`;
    // the six round toggles
    const tgl = ([name, ic]) => { const c = snap?.circuits?.find(x => x.name.toLowerCase() === name.toLowerCase()); if (!c) return '';
      const staged = st.stage?.id === c.id, until = d.until?.[c.id], total = (d.runFor?.[c.id] ?? 60) * 60_000, C = 194.8;
      const ring = c.on && until ? `<svg class="c-tgl-ring" viewBox="0 0 68 68"><circle class="t" cx="34" cy="34" r="31"/><circle class="v" cx="34" cy="34" r="31" stroke-dasharray="${(C * Math.max(0, Math.min(1, (until - Date.now()) / total))).toFixed(1)} ${C}"/></svg>` : '';
      const sub = staged ? 'staged' : c.on ? (until ? `${leftText(until - Date.now())} left` : 'on') : `last ${runLabel(d.runFor?.[c.id] ?? 60)}`;
      return `<button class="c-tgl${c.on ? ' on' : ''}${staged ? ' stg' : ''}${st.sending && staged ? ' busy' : ''}" data-cid="${c.id}" aria-pressed="${c.on}" aria-label="${esc(c.name)}, ${c.on ? 'on' : 'off'}. Tap to ${c.on ? 'turn off' : `run for ${runLabel(d.runFor?.[c.id] ?? 60)}`}; hold for the time"><span class="c-tgl-b">${ring}${icon(ic)}</span><span class="c-tgl-n">${esc(c.name)}</span><span class="c-tgl-s">${sub}</span></button>`; };
    const toggles = snap?.circuits?.length ? TGL.map(([lab, hint, list]) => { const b = list.map(tgl).join(''); return b ? `<div class="c-tgl-group c-acc-pool"><div class="c-tgl-lab">${lab}<span>${hint}</span></div><div class="c-tgls">${b}</div></div>` : ''; }).join('') + longWell(d) : '<p class="c-fine">The controller hasn’t been read yet, so the switches wait.</p>';
    // Autopilot
    const T = ap?.tomorrow?.plan, apMode = st.stage?.ap ?? mode;
    const auto = `<div class="c-lab">Pool Autopilot</div>${seg(MODES, apMode, { acc: 'c-acc-batt', attr: 'data-ap', label: 'Pool Autopilot' })}
      ${T ? `<div class="c-modeline c-acc-batt"><p><b>Tomorrow:</b> ${T.hours} h at ${(T.rpm ?? s.filterRpm ?? 0).toLocaleString()} rpm${T.boostHours ? ` + ${T.boostHours} h skim` : ''} · ${mode === 'auto' ? 'writes' : mode === 'off' ? 'off, nothing written' : 'suggests'}${mode !== 'off' && ap?.nextRunAt ? ` at ${esc(clock(Date.parse(ap.nextRunAt)))}` : ''}</p></div>` : ''}
      ${ap?.pending && d.pending ? `<div class="c-well"><div class="c-head"><h5>Plan waiting</h5><span class="c-fig">${esc(new Date(d.pending.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' }))}</span></div>
        <p class="c-sum">${d.pending.plan.hours} h at ${(s.filterRpm ?? 0).toLocaleString()} rpm${d.pending.plan.boostHours ? ' + skim' : ''}. ${esc(d.pending.why.join('; ') || 'Season plan.')}</p><div class="c-btns"><button class="c-btn pri c-acc-batt" data-act="apply-tomorrow">Apply tomorrow</button></div></div>` : ''}`;
    const rows = `<div class="c-card flush">${sysRow({ acc: 'c-acc-pool', ic: 'grid', title: 'Circuits', line: 'every circuit, its speed and schedule', id: 'plCirc' })}</div>`;
    sheet(`${sheetHead('Pool', modePill(cu ? 'clear' : boostOn ? 'boost' : mode))}<p class="c-sheet-sub">${esc(sub)}</p><div class="c-equip">${dial}${modes}${toggles}</div>${auto}${rows}${footer(st.stage, 'Open Pool', 'c-acc-pool')}`, { keepScroll: true });
    wire(d, { pid, bid, lim, presets, poolOn, boostOn, speeds, cur });
  };
  /* long-press: the run-for well (Spa's adds its heat and setpoint) */
  const longWell = d => {
    const c = st.long != null ? d.snapshot?.circuits?.find(x => x.id === st.long) : null; if (!c) return '';
    const body = isSpa(c) ? d.snapshot.bodies?.[1] : null, heat0 = body?.heatMode === 3, set0 = Math.min(104, Math.max(80, body?.setPoint || 100));
    const heat = st.heat ?? heat0, setF = st.setF ?? set0, minutes = st.minutes ?? d.runFor?.[c.id] ?? 60;
    const runs = /light/i.test(c.name) || isSpa(c) ? RUNS : RUNS.slice(0, 4);
    return `<div class="c-well c-acc-pool" id="plLong"><div class="c-head"><h5>${esc(c.name)}</h5><span class="c-fig">${c.on ? 'on' : 'off'}</span></div>
      ${c.on ? '' : `<div class="c-tgl-lab" style="margin-top:10px">Run for</div>${seg(runs.map(m => [String(m), runLabel(m)]), String(minutes), { acc: 'c-acc-pool', attr: 'data-min', label: 'Run for' })}`}
      ${body ? `<div class="c-swrow" style="grid-template-columns:1fr"><div class="c-swp c-acc-warn" role="switch" tabindex="0" aria-checked="${heat}" id="plHeat">${icon('flame')}<span>Spa heat<small>heater runs only while Spa is on</small></span><span class="c-sw${heat ? ' on' : ''}"></span></div></div>
        ${heat ? `<div class="c-stepper" style="border:0;margin-top:6px"><div>Heat to<small>80–104°</small></div><button class="c-step" data-heat="-1" aria-label="Cooler">−</button><b>${setF}°</b><button class="c-step" data-heat="1" aria-label="Warmer">+</button></div>` : ''}` : ''}
      <p class="c-fine">${body ? 'Autopilot never touches the spa, its heat, the lights or the heater; only you do.' : c.on ? 'Tap the switch to turn it off.' : `Turns itself off after ${runLabel(minutes)} (the controller’s own timer).`}</p></div>`;
  };
  const stageLong = d => {
    const c = d.snapshot?.circuits?.find(x => x.id === st.long); if (!c) return;
    const body = isSpa(c) ? d.snapshot.bodies?.[1] : null, heat0 = body?.heatMode === 3, set0 = Math.min(104, Math.max(80, body?.setPoint || 100));
    const heat = st.heat ?? heat0, setF = st.setF ?? set0, minutes = st.minutes ?? d.runFor?.[c.id] ?? 60, heated = !!body && (heat !== heat0 || (heat && setF !== set0));
    const cmds = [...(heated ? [heat ? { kind: 'spaHeat', on: true, setF } : { kind: 'spaHeat', on: false }] : []), ...(c.on ? [] : [{ kind: 'circuit', id: c.id, on: true, minutes }])];
    if (!cmds.length) { st.stage = null; return; }
    const label = c.on ? (heat ? `Spa heat to ${setF}°` : 'Spa heat off') : `${c.name} on · ${runLabel(minutes)}${body && heat ? ` · heat to ${setF}°` : ''}`;
    st.stage = { id: c.id, label, cmds };
  };
  const wireFoot = () => { const f = foot(); if (!f) return;
    f.querySelector('[data-f="pri"]').onclick = closeSheet;
    const sec = f.querySelector('[data-f="sec"]'); if (sec) sec.onclick = () => { closeSheet(); S.nav?.insights('appl', 'applPool', 'pool'); }; };
  const wire = (d, k) => {
    const dialEl = $('plDial');
    const setRpm = v => { st.rpm = v === k.cur ? null : v; st.stage = st.rpm == null ? null : (() => { const x = poolSpeedStage({ rpm: v, poolId: k.pid, boostId: k.bid, poolSpeed: k.speeds.get(k.pid) ?? null, boostSpeed: k.speeds.get(k.bid) ?? null, poolOn: k.poolOn, boostOn: k.boostOn, minutes: d.runFor?.[k.pid] ?? 60 }); return x && { ...x, kind: 'rpm' }; })(); st.long = null; draw(); };
    wireDial(dialEl, { min: k.lim.min, max: k.lim.max, snap: x => snapRpm(x, k.presets, k.lim), step: dir => snapRpm((st.rpm ?? k.cur) + dir * 50, [], k.lim),
      onMove: v => { const svg = dialEl.querySelector('svg'), f = toFrac(v, k.lim.min, k.lim.max), [x, y] = dialPoint(f);
        svg.querySelector('.c-arc-val').setAttribute('d', arcPath(0, f)); svg.querySelectorAll('.c-arc-halo,.c-arc-knob').forEach(c => { c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1)); });
        $('plV').textContent = v.toLocaleString(); },
      onSet: setRpm });
    $('plPre').onclick = e => { const b = e.target.closest('[data-rpm]'); if (b) { vib(); setRpm(+b.dataset.rpm); } };
    const body = $('sheetBody');
    body.querySelector('[data-tab]')?.parentElement.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { st.tab = b.dataset.tab; draw(); } });
    body.querySelector('[data-ap]')?.parentElement.addEventListener('click', e => { const b = e.target.closest('[data-ap]'); if (!b) return; const m = b.dataset.ap, cur = d.autopilot?.mode ?? d.settings?.autopilot;
      st.stage = m === cur ? null : { ap: m, label: autopilotStage('', m), run: async () => {
        if (m === 'auto' && !confirm('Auto mode writes tomorrow’s schedule to ScreenLogic every evening without asking. Spa, heater, lights and freeze protection are never touched. Turn it on?')) return false;
        if (m === 'off' && !confirm('Turn Pool Autopilot off?\n\nSolstice stops planning and writing the pump schedule. The controller keeps running what it has now.')) return false;
        await api.poolAutopilot(m); S.pool = await api.pool(); return true; } };
      st.rpm = null; draw(); });
    // toggles: tap stages the run (or off); a 500 ms hold opens the time well
    let press = null;
    body.querySelectorAll('.c-tgls').forEach(g => {
      g.onpointerdown = e => { const b = e.target.closest('[data-cid]'); if (!b) return; press = setTimeout(() => { press = 'long'; vib(); st.long = +b.dataset.cid; st.minutes = st.heat = st.setF = null; stageLong(d); st.rpm = null; draw(); }, 500); };
      g.onpointerup = g.onpointerleave = g.onpointercancel = () => { if (press && press !== 'long') clearTimeout(press); };
      g.onclick = e => { const b = e.target.closest('[data-cid]'); if (!b) return; if (press === 'long') { press = null; return; }
        const c = d.snapshot.circuits.find(x => x.id === +b.dataset.cid); if (!c) return;
        st.long = null; st.rpm = null; st.stage = st.stage?.id === c.id ? null : { id: c.id, ...circuitStage(c.name, c.id, c.on, d.runFor?.[c.id] ?? 60) }; draw(); };
    });
    const lw = $('plLong');
    if (lw) lw.onclick = e => {
      const m = e.target.closest('[data-min]'); if (m) { st.minutes = +m.dataset.min; stageLong(d); return draw(); }
      if (e.target.closest('#plHeat')) { const body0 = d.snapshot.bodies?.[1]; st.heat = !(st.heat ?? body0?.heatMode === 3); stageLong(d); return draw(); }
      const h = e.target.closest('[data-heat]'); if (h) { const body0 = d.snapshot.bodies?.[1]; st.setF = Math.max(80, Math.min(104, (st.setF ?? Math.min(104, Math.max(80, body0?.setPoint || 100))) + +h.dataset.heat)); stageLong(d); return draw(); }
    };
    if ($('plHeat')) $('plHeat').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('plHeat').click(); } };
    // named actions in the mode line
    body.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const a = b.dataset.act;
      if (a === 'boost-stage') { st.rpm = null; st.stage = { id: k.bid, label: `Run ${(k.speeds.get(k.bid) ?? k.presets[2].rpm).toLocaleString()} rpm · ${runLabel(d.runFor?.[k.bid] ?? 60)}`, cmds: [{ kind: 'circuit', id: k.bid, on: true, minutes: d.runFor?.[k.bid] ?? 60 }] }; return draw(); }
      if (a === 'cu-open') return openClearUp(S);
      if (a === 'cu-end' && !confirm('End the Clear-up now? The planner’s schedule goes back on the controller.')) return;
      b.disabled = true; b.textContent = 'Sending…';
      if (a === 'boost-end') await poolSend(S, { kind: 'circuit', id: k.bid, on: false });
      else if (a === 'cu-extend') await clearUpSend(S, { action: 'extend' });
      else if (a === 'cu-end') await clearUpSend(S, { action: 'end' });
      else if (a === 'apply-tomorrow') { try { await api.poolApplyTomorrow(); S.pool = await api.pool(); drawPool(S); } catch (err) { alert(err.message); } }
      st.tab = null; draw(); S.redrawNow?.();
    });
    $('plCirc').onclick = () => { closeSheet(); S.nav?.insights('appl', 'poolCtl', 'pool'); };
    // the footer
    const f = foot(), pri = f.querySelector('[data-f="pri"]'), sec = f.querySelector('[data-f="sec"]');
    if (!st.stage) { pri.onclick = closeSheet; sec.onclick = () => { closeSheet(); S.nav?.insights('appl', 'applPool', 'pool'); }; return; }
    sec.onclick = () => { st.stage = null; st.rpm = null; st.long = null; draw(); };
    pri.onclick = async () => {
      if (st.sending) return; st.sending = true; pri.textContent = 'Sending…'; pri.disabled = true;
      $('sheetBody').querySelector(`.c-tgl[data-cid="${st.stage.id}"]`)?.classList.add('busy');
      try { if (st.stage.run) { const ok = await st.stage.run(); if (ok === false) { st.sending = false; return draw(); } drawPool(S); S.onPool?.(); } else await poolSend(S, ...st.stage.cmds); }
      catch (err) { alert(err.message); }
      st.sending = false; st.stage = null; st.rpm = null; st.long = null; draw(); S.redrawNow?.();
    };
  };
  draw();
}

/* ======================= AC (frame 6) ======================= */
const MANUAL = { COOL: [65, 85], HEAT: [55, 80] };
export function openAcSheet(S) {
  const st = { change: null, ap: null, sending: false };
  const draw = () => {
    const d = S.ac;
    if (!d?.linked || !d.state) { sheet(`${sheetHead('AC')}<p class="c-sheet-sub">${d?.configured === false ? 'Google Device Access is not configured yet.' : 'Nest isn’t linked. Link it once on the AC page.'}</p>${sheetFoot('Open AC', 'Done', 'c-acc-home')}`);
      const f = foot(); f.querySelector('[data-f="pri"]').onclick = closeSheet; f.querySelector('[data-f="sec"]').onclick = () => { closeSheet(); S.nav?.insights('appl', 'applAc', 'ac'); }; return; }
    const s = d.settings, t = d.state, nest = t.eco ? 'ECO' : t.mode, ch = st.change;
    const mode = ch?.kind === 'mode' ? ch.mode : nest, k = mode === 'HEAT' ? 'heatF' : 'coolF', [lo, hi] = MANUAL[mode === 'HEAT' ? 'HEAT' : 'COOL'];
    const canDial = (mode === 'COOL' || mode === 'HEAT' || mode === 'HEATCOOL') && ch?.kind !== 'mode';
    const set0 = t[k] != null ? Math.round(t[k]) : null, val = ch && (ch.kind === 'cool' || ch.kind === 'heat') ? ch.f : ch?.kind === 'range' ? ch.coolF : set0;
    const hp = holdProgress(d.hold), indoor = t.indoorF;
    const sub = `Inside ${indoor ?? '—'}° · ${t.humidity ?? '—'}% · linked ${ageWords(Date.now() - t.at)}`;
    // the hold (or Autopilot paused by the mode)
    let top = '';
    if (nest === 'COOL' && hp) { const h = d.hold, what = h.mode === 'OFF' ? 'Off' : `${Math.round(h.coolF ?? h.heatF)}°`;
      top = banner({ cls: 'purple', ring: { pct: hp.pct }, title: h.by === 'app' ? `Holding your ${what}` : `Holding ${what} set at the thermostat`, line: `until ${esc(clock(h.until))}`, btns: [['Resume now', 'hold:resume'], ...(h.extended ? [] : [['Until morning', 'hold:morning']])] }); }
    else if (nest !== 'COOL') top = banner({ cls: 'plain', ic: nest === 'HEAT' ? 'heat' : nest === 'OFF' ? 'off' : 'eco', title: nest === 'ECO' ? 'Away · Eco' : `AC Autopilot paused · ${NEST_WORD[nest] ?? nest}`,
      line: { HEAT: 'Autopilot only plans cooling; it starts again in Cool.', HEATCOOL: 'Autopilot plans one cooling setpoint, so it waits for Cool.', OFF: 'Solstice sends nothing until it is turned back on.', ECO: 'Nest is in Eco; tap Eco to turn it off.' }[nest] ?? '' });
    // the dial
    const tone = thermoTone(indoor, val), hvac = String(t.hvac ?? 'off').toLowerCase();
    const em = ch && ch.kind !== 'mode' ? 'staged · tap Set below' : val == null || indoor == null ? hvac : hvac === 'cooling' || hvac === 'heating' ? `${hvac === 'cooling' ? 'Cooling' : 'Heating'} · ${Math.abs(indoor - val).toFixed(1)}° to go` : `Idle · ${Math.abs(indoor - val).toFixed(1)}° ${indoor < val ? 'under' : 'over'} target`;
    const label = !canDial ? (mode === 'OFF' ? 'Thermostat' : mode === 'ECO' ? 'Eco · Away' : `Switching to ${NEST_WORD[mode]}`) : hp && nest === 'COOL' ? 'Holding at' : { COOL: 'Cool to', HEAT: 'Heat to', HEATCOOL: 'Cool end' }[mode];
    const dial = `<div class="c-dial c-thermo ${tone}" id="acDial">${canDial && val != null ? dialSvg({ label: 'Setpoint', min: lo, max: hi, value: val, minor: true, soft: true, dot: indoor != null ? Math.max(lo, Math.min(hi, indoor)) : null, aria: `${val}°` }) : `<svg viewBox="0 0 260 196" aria-hidden="true"><path class="c-arc-track" d="${arcPath(0, 1)}"/></svg>`}
      <div class="c-dial-c"><small>${esc(label)}</small><b>${canDial && val != null ? `${val}<sup>°</sup>` : mode === 'OFF' ? 'Off' : mode === 'ECO' ? `${t.ecoCoolF != null ? Math.round(t.ecoCoolF) : '—'}<sup>°</sup>` : '—'}</b><span>inside ${indoor ?? '—'}° · ${t.humidity ?? '—'}%</span>${canDial ? `<em>${esc(em)}</em>` : ''}</div>
      ${canDial ? '<button class="c-step" style="left:0" data-step="-1" aria-label="One degree cooler">−</button><button class="c-step" style="right:0" data-step="1" aria-label="One degree warmer">+</button>' : ''}</div>`;
    const avail = t.availableModes?.length ? t.availableModes : ['COOL', 'HEAT', 'HEATCOOL', 'OFF'];
    const modes = seg([['COOL', `${icon('cool')}Cool`], ['HEAT', `${icon('heat')}Heat`], ['HEATCOOL', `${icon('auto')}Auto`], ['OFF', `${icon('off')}Off`]].filter(m => avail.includes(m[0])), mode === 'ECO' ? '' : mode, { acc: 'c-acc-home', attr: 'data-mode', label: 'Thermostat mode' });
    const eco = ch?.kind === 'eco' ? ch.on : !!t.eco, fan = ch?.kind === 'fan' ? ch.seconds > 0 : !!t.fanTimer;
    const fanLeft = t.fanTimer && t.fanUntil ? Math.max(0, Math.round((t.fanUntil - Date.now()) / 60_000)) : null;
    const sw = `<div class="c-swrow"><div class="c-swp c-acc-batt" role="switch" tabindex="0" aria-checked="${eco}" data-sw="eco">${icon('eco')}<span>Eco<small>${eco ? 'on' : 'off'}</small></span><span class="c-sw${eco ? ' on' : ''}"></span></div>
      <div class="c-swp c-acc-batt" role="switch" tabindex="0" aria-checked="${fan}" data-sw="fan">${icon('fan')}<span>Fan<small>${ch?.kind === 'fan' ? (fan ? '1 h' : 'stop') : t.fanTimer ? (fanLeft != null ? `${leftText(fanLeft * 60_000)} left` : 'on') : 'off'}</small></span><span class="c-sw${fan ? ' on' : ''}"></span></div></div>`;
    const pr = d.presence ?? { state: s.presence }, away = pr.state === 'away';
    const rows = `<div class="c-card flush">${sysRow({ acc: 'c-acc-ac', ic: 'sliders', title: 'Comfort', line: `${s.dayF}° day · ${s.nightF}° night · pre-cool ${s.precoolDepth ?? 0}°`, id: 'acComf', end: `<span class="c-end"><span class="c-num c-cap">Edit</span><span class="c-chev">${icon('chev')}</span></span>` })}
      ${sysRow({ acc: 'c-acc-vac', ic: 'plane', title: 'Away', mode: modePill(away ? 'away' : 'home'), line: away ? (pr.source === 'vacation' ? 'Vacation mode' : pr.until ? `Away until ${esc(clock(pr.until))}` : 'Away') + ' · Home · plan a vacation' : 'Away until… · plan a vacation', id: 'acAway' })}</div>`;
    const nudge = `<div class="c-nudge"><button class="c-acc-home" data-nudge="1">${icon('cool')}Too cold</button><button class="c-acc-ac" data-nudge="-1">${icon('sun')}Too warm</button></div>`;
    const apMode = st.ap ?? s.autopilot, P = d.plan, tr = P?.trim, clk = h => `${Math.floor(h) % 12 || 12}${h % 1 ? ':' + String(Math.round(h % 1 * 60)).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
    const trim = tr ? `<div class="c-modeline c-acc-batt"><p><b>Trim today</b> · ${tr.what === 'coast' ? `coast ${tr.to < tr.from ? 'ends earlier' : 'runs longer'}, to ${clk(tr.to)}` : `pre-cool to ${tr.to}° instead of ${tr.from}°`} · ${esc(tr.reason)}</p><button class="c-btn sm line" data-act="untrim">Undo</button></div>`
      : P?.control ? '<div class="c-modeline c-acc-batt"><p><b>Control day</b> · holding the comfort band so Solstice can measure what pre-cooling saves</p></div>' : '';
    const auto = `<div class="c-lab">AC Autopilot</div>${seg(MODES, apMode, { acc: 'c-acc-batt', attr: 'data-ap', label: 'AC Autopilot' })}${trim}`;
    const stage = st.ap != null ? { label: autopilotStage('', st.ap) } : ch ? acStage(ch) : null;
    sheet(`${sheetHead('AC', modePill(s.autopilot))}<p class="c-sheet-sub">${esc(sub)}</p>${top}${dial}${modes}${sw}${rows}${nudge}${auto}${footer(stage, 'Open AC', 'c-acc-home')}`, { keepScroll: true });
    wire(d, { lo, hi, val, mode, nest, canDial, set0, k });
  };
  const wire = (d, x) => {
    const t = d.state, body = $('sheetBody');
    const setF = v => { const kind = x.mode === 'HEAT' ? 'heat' : 'cool';
      if (v === x.set0) { st.change = null; return draw(); }
      if (x.mode === 'HEATCOOL') { if (v - t.heatF < 3) return draw(); st.change = { kind: 'range', heatF: Math.round(t.heatF), coolF: v }; } else st.change = { kind, f: v };
      st.ap = null; draw(); };
    if (x.canDial && x.val != null) {
      const el = $('acDial');
      wireDial(el, { min: x.lo, max: x.hi, snap: v => snapDeg(v, x.lo, x.hi), step: dir => snapDeg(x.val + dir, x.lo, x.hi),
        onMove: v => { const svg = el.querySelector('svg'), f = toFrac(v, x.lo, x.hi), [px, py] = dialPoint(f);
          svg.querySelector('.c-arc-soft')?.setAttribute('d', arcPath(0, f));
          const dot = svg.querySelector('.c-arc-dot'); if (dot) svg.querySelector('.c-arc-val').setAttribute('d', arcPath(f, toFrac(Math.max(x.lo, Math.min(x.hi, t.indoorF)), x.lo, x.hi)));
          svg.querySelectorAll('.c-arc-halo,.c-arc-knob').forEach(c => { c.setAttribute('cx', px.toFixed(1)); c.setAttribute('cy', py.toFixed(1)); });
          el.querySelector('.c-dial-c b').innerHTML = `${v}<sup>°</sup>`; },
        onSet: setF });
      el.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { vib(); setF(snapDeg(x.val + +b.dataset.step, x.lo, x.hi)); });
    }
    body.querySelector('[data-mode]')?.parentElement.addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b) return;
      st.change = b.dataset.mode === x.nest ? null : { kind: 'mode', mode: b.dataset.mode }; st.ap = null; draw(); });
    body.querySelectorAll('[data-sw]').forEach(el => { el.onclick = () => { st.ap = null;
      if (el.dataset.sw === 'eco') st.change = st.change?.kind === 'eco' ? null : { kind: 'eco', on: !t.eco };
      else st.change = st.change?.kind === 'fan' ? null : { kind: 'fan', seconds: t.fanTimer ? 0 : 3600 };
      draw(); };
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } }; });
    body.querySelector('[data-ap]')?.parentElement.addEventListener('click', e => { const b = e.target.closest('[data-ap]'); if (!b) return;
      st.ap = b.dataset.ap === d.settings.autopilot ? null : b.dataset.ap; st.change = null; draw(); });
    body.querySelectorAll('[data-nudge]').forEach(b => b.onclick = () => openNudge(S, +b.dataset.nudge));   // the existing nudge sheet, which calls /ac/nudge
    $('acComf').onclick = () => openComfort(S);
    $('acAway').onclick = () => openVacation(S);
    body.querySelectorAll('.c-ban [data-b]').forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = '…';
      try { S.ac = await api.acHold(b.dataset.b.split(':')[1]); drawAc(S); S.onAc?.(); } catch (err) { alert(err.message); } draw(); });
    const un = body.querySelector('[data-act="untrim"]');
    if (un) un.onclick = async () => { un.disabled = true; un.textContent = 'Undoing…'; try { await api.acUntrim(); await loadAc(S); } catch (err) { alert(err.message); } draw(); };
    const f = foot(), pri = f.querySelector('[data-f="pri"]'), sec = f.querySelector('[data-f="sec"]');
    if (!st.change && st.ap == null) { pri.onclick = closeSheet; sec.onclick = () => { closeSheet(); S.nav?.insights('appl', 'applAc', 'ac'); }; return; }
    sec.onclick = () => { st.change = null; st.ap = null; draw(); };
    pri.onclick = async () => {
      if (st.sending) return;
      if (st.ap != null) {   // the same confirms the AC card's Autopilot control has
        const m = st.ap;
        if (m === 'auto' && !confirm('Auto mode sets the cooling setpoint through each day without asking, always inside your comfort band. Turn it on?')) return;
        if (m === 'off' && !confirm('Turn AC Autopilot off?\n\nSolstice stops changing the thermostat. Nest keeps the setpoint it has now.')) return;
        st.sending = true; pri.textContent = 'Saving…';
        try { await api.acSettings({ autopilot: m }); await loadAc(S); } catch (err) { alert(err.message); }
      } else {
        const sc = acStage(st.change);
        if (sc.cmd.kind === 'mode' && !confirm(`Switch the thermostat to ${NEST_WORD[sc.cmd.mode]}?${sc.cmd.mode !== 'COOL' ? '\n\nAC Autopilot pauses until it is back in Cool.' : ''}`)) return;
        st.sending = true; pri.textContent = 'Sending…';
        try { S.ac = await api.acCommand(sc.cmd); drawAc(S); S.onAc?.(); } catch (err) { alert(err.message); }
      }
      st.sending = false; st.change = null; st.ap = null; draw(); S.redrawNow?.();
    };
  };
  draw();
}

/* ======================= Powerwalls (frame 7) ======================= */
export function openPwSheet(S) {
  const st = { modes: {}, sending: false };
  const draw = () => {
    const r = S.live, site = S.now?.site ?? {}, P = S.pwRules, cap = site.capacityKwh || 27, mcap = site.modelKwh || cap, reserve = site.reservePct ?? 20, out = S.outageActive;
    const soc = r ? Math.round(r.soc) : null;
    const toFull = r && r.batteryKw < -.05 ? (100 - r.soc) / 100 * mcap / (-r.batteryKw * .95) : null, toRes = r && r.batteryKw > .05 ? Math.max(0, r.soc - (out ? 0 : reserve)) / 100 * mcap * .95 / r.batteryKw : null;
    const hours = h => h == null || !isFinite(h) ? '—' : h >= 1 ? `${Math.floor(h)}h ${String(Math.round(h % 1 * 60)).padStart(2, '0')}m` : `${Math.round(h * 60)}m`;
    const state = !r ? '' : r.batteryKw < -.05 ? `Charging <b class="c-num" style="font-size:12.5px;color:var(--batt);letter-spacing:0">${(-r.batteryKw).toFixed(1)} kW</b><br>full in ${hours(toFull)}`
      : r.batteryKw > .05 ? `${out ? 'Powering home' : 'Discharging'} <b class="c-num" style="font-size:12.5px;color:var(--solar);letter-spacing:0">${r.batteryKw.toFixed(1)} kW</b><br>${hours(toRes)} to ${out ? 'empty' : 'reserve'}` : 'Standing by';
    const sub = `≈ ${r ? (r.soc / 100 * cap).toFixed(1) : '—'} of ${cap} kWh · ${esc(out ? 'Backup (islanded)' : MODE[site.mode] ?? site.mode ?? '—')}`;
    const units = (site.batteries?.length ? site.batteries : [{}, {}]).map((b, i) => `<div class="c-unit"><i style="width:${soc ?? 0}%"></i><s style="left:${reserve}%"></s><em>PW ${i + 1}</em><span>${soc ?? '—'}%</span></div>`).join('');
    const cmds = !!P?.scope?.energyCmds, sg = waitingSuggestion(P);
    const fig = id => { const cur = P?.rules.find(x => x.id === id)?.suggestion?.current;
      return id === 'reserve' ? `now ${reserve}%` : id === 'storm' ? (r?.stormActive ? 'storm active' : site.stormWatch ? 'Storm Watch on' : 'Storm Watch off') : esc(EXPORT[cur] ?? cur ?? '—'); };
    const rules = !P ? '<p class="c-fine">Loading the rules…</p>' : P.rules.filter(x => RULE[x.id]).map(x => {
      const m = st.modes[x.id] ?? x.mode, s = x.suggestion;
      const ban = sg?.id === x.id ? banner({ cls: 'amber', ic: 'batt', title: x.id === 'reserve' ? `Reserve ${esc(s.value)}% tonight?` : x.id === 'storm' ? `Reserve ${esc(s.value)}% before the storm?` : `Export ${esc(EXPORT[s.value] ?? s.value)}?`,
        line: esc(s.reason ?? 'Suggestion waiting'), btns: [[cmds ? 'Apply' : 'Skip', cmds ? `apply:${x.id}` : `skip:${x.id}`], ...(cmds ? [['Skip', `skip:${x.id}`]] : [])] }) : '';
      return `<div class="c-well" data-rule="${x.id}"><div class="c-head"><h5>${esc(RULE[x.id].title)}</h5><span class="c-fig">${fig(x.id)}</span></div><p class="c-cap">${esc(RULE[x.id].sub)}</p>
        ${seg(MODES.map(([v, l]) => [v, l, v === 'auto' && !cmds]), m, { acc: 'c-acc-batt', attr: 'data-m', label: `${RULE[x.id].title} mode` })}${ban}</div>`; }).join('');
    const scope = P && !cmds ? '<p class="c-fine">Solstice can read these settings but can’t change them yet: it needs Tesla’s energy commands permission. Until then each suggestion shows its steps in the Tesla app (Open Powerwall).</p>' : '';
    const ready = r?.homeKw > .05 ? `${hours(Math.max(0, r.soc) / 100 * mcap * .95 / r.homeKw)} at ${r.homeKw.toFixed(1)} kW` : 'if the grid went down now';
    const staged = Object.entries(st.modes).find(([id, m]) => m !== P?.rules.find(x => x.id === id)?.mode);
    const stage = staged ? { label: `${RULE[staged[0]].title}: ${MODES.find(z => z[0] === staged[1])[1]}` } : null;
    sheet(`${sheetHead('Powerwalls', modePill(rulesPill(P?.rules)))}<p class="c-sheet-sub">${sub}</p>
      <div class="c-hero"><b>${soc ?? '—'}<small>%</small></b><span>${state}</span></div><div class="c-units">${units}</div>
      <div class="c-lab">Rules</div>${rules}${scope}
      <div class="c-card flush">${sysRow({ acc: 'c-acc-out', ic: 'shield', title: 'Outage readiness', line: esc(ready), id: 'pwOutage' })}</div>${footer(stage, 'Open Powerwall', 'c-acc-batt')}`, { keepScroll: true });
    wire(staged);
  };
  const wire = staged => {
    const body = $('sheetBody');
    body.querySelectorAll('[data-rule]').forEach(w => w.onclick = async e => {
      const id = w.dataset.rule, b = e.target.closest('button'); if (!b) return;
      if (b.dataset.m) { if (b.getAttribute('aria-disabled') === 'true') return alert('Auto needs Tesla’s energy commands permission (energy_cmds). Re-connect Tesla first.');
        st.modes = { [id]: b.dataset.m }; return draw(); }
      const [k, rid] = (b.dataset.b ?? '').split(':');
      if (k === 'skip') { const r = S.pwRules.rules.find(x => x.id === rid); skip(rid, r?.suggestion?.value); S.redrawNow?.(); return draw(); }
      if (k === 'apply') { await applyRule(S, rid, b); S.redrawNow?.(); return draw(); }
    });
    $('pwOutage').onclick = () => { closeSheet(); S.nav?.insights('home', 'outage'); };
    const f = foot(), pri = f.querySelector('[data-f="pri"]'), sec = f.querySelector('[data-f="sec"]');
    if (!staged) { pri.onclick = closeSheet; sec.onclick = () => { closeSheet(); S.nav?.insights('home', 'pwr'); }; return; }
    sec.onclick = () => { st.modes = {}; draw(); };
    pri.onclick = async () => { if (st.sending) return; st.sending = true; pri.textContent = 'Saving…';
      await setRuleMode(S, staged[0], staged[1]); st.sending = false; st.modes = {}; draw(); S.redrawNow?.(); };
  };
  if (!S.pwRules) loadPowerwallRules(S).then(() => { if ($('pwOutage') && $('phone').classList.contains('open')) draw(); }).catch(() => {});
  draw();
}
