// Now, top (approved mockup mockups/al-ia.html v2, frames 1, 4 and 16): the Status and Vacation pills, the banner slot (one banner at
// a time, by priority), the Autopilot hub (owner only) and the Conditions sheet. Every write here goes through an action that already
// existed (views/vacation.js, views/ac.js, views/appliances.js, views/powerwall.js, views/digest.js); the hub's rows open the control
// sheets (views/nowsheets.js), where writes are staged.
import { $, localDate, localHour, fmtDur } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { clock, weekday, when } from '../lib/presence.js';
import { backLabel, dayOfTrip, tripProgress, dateLabel, shortClock, k0, welcomeSteps } from '../lib/vacation.js';
import { statusPill, vacationPill, pickBanner, holdProgress, ageWords, nowPct, scheduleBlocks, acBlocks, chargeBlocks, tripStrip, tripIn, hubFigure, rulesPill, nwsIsWarning } from '../lib/nowui.js';
import { icon } from '../lib/icons.js';
import { sheet, sheetHead, sheetFoot, modePill, sysRow, banner, closeSheet } from './csheet.js';
import { healthRows } from './insights.js';
import { openVacation, endTrip, answerAsk, reportDue, dismissReport, openReport } from './vacation.js';
import { digestBanner, openDigest, dismissDigest } from './digest.js';
import { RULE, EXPORT, waitingSuggestion, applyRule, skip } from './powerwall.js';
import { clearUpSend, poolSend, boostId } from './appliances.js';
import { openPoolSheet, openAcSheet, openPwSheet } from './nowsheets.js';

const D = 864e5;
const MODE_CLS = { auto: 'auto', suggest: 'suggest', off: 'off' };

/* ======================= the two pills ======================= */
export function drawPills(S) {
  const r = S.live, offline = !!S.nowOffline || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const st = statusPill({ outage: !!S.outageActive, outageSince: S.now?.outage?.since ?? S.previewSince ?? null, offline, readingAt: r?.ts ?? null,
    nws: S.nws ?? [], ercot: S.ercot ?? null, stormActive: !!r?.stormActive });
  const known = !!r || offline;   // before the first reading the pill keeps its skeleton
  const p = $('statusPill');
  if (known) {
    p.className = `c-pill ${st.level === 'alert' ? 'alert c-acc-out' : st.level === 'warn' ? 'warn c-acc-solar' : 'c-acc-batt'}`;
    const html = `${esc(st.text)}${st.small ? ` <small>${esc(st.small)}</small>` : ''}`;
    if ($('statusTxt').innerHTML !== html) $('statusTxt').innerHTML = html;
    p.setAttribute('aria-label', `Conditions: ${st.text}${st.small ? ' ' + st.small.replace('· ', '') : ''}`);
  }
  if (S.guest) return;
  const v = vacationPill({ trip: S.vac?.trip ?? null, phase: S.vac?.phase ?? null, presence: S.ac?.presence ?? null });
  const vp = $('vacPill'); vp.hidden = !S.vac && !S.ac;
  vp.className = `c-pill vac c-acc-vac${v.state === 'idle' ? ' idle' : ''}`;
  const vh = `${esc(v.text)}${v.small ? ` <small>${esc(v.small)}</small>` : ''}`;
  if ($('vacPillT').innerHTML !== vh) $('vacPillT').innerHTML = vh;
}

/* ======================= the banner slot (frame 16) ======================= */
const hm = m => `${String(Math.floor(m / 60) % 12 || 12)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''} ${Math.floor(m / 60) % 24 < 12 ? 'AM' : 'PM'}`;
/** Every banner that has something to say now; pickBanner takes the first by priority. */
function candidates(S) {
  const out = [], now = Date.now(), r = S.live, site = S.now?.site ?? {};
  // 1 · outage (red)
  if (S.outageActive) {
    const since = S.now?.outage?.since ?? S.previewSince ?? now, mcap = site.modelKwh || site.capacityKwh || 27, kw = Math.max(.3, r?.homeKw ?? 1);
    const h = r ? Math.max(0, r.soc) / 100 * mcap * .95 / kw : null;
    out.push({ kind: 'outage', cls: 'red', ic: 'bolt', title: `Grid outage since ${esc(clock(since))}`, line: r ? `Powerwalls ${Math.round(r.soc)}% · ~${fmtDur(h)} at ${kw.toFixed(1)} kW` : 'Your Powerwalls took over',
      btns: [['Outage view', 'outage']] });
  }
  // 2 · vacation (teal): running, the welcome, late, planned, the report afterwards
  const v = S.vac, t = v?.trip;
  if (t) {
    const ac = S.ac?.vacation, st = S.ac?.state, ask = (S.vacAlerts ?? []).find(a => a.data?.ask === 'wall' && !a.readAt);
    if (v.phase === 'planned') out.push({ kind: 'vacation', cls: 'teal', ic: 'plane', title: 'Vacation planned', line: `${esc(dateLabel(t.leaveAt))} ${esc(clock(t.leaveAt))} → ${t.backAt ? `${esc(dateLabel(t.backAt))} ${esc(clock(t.backAt))}` : 'open'}`,
      btns: [['Departure check', 'vac-check'], ['Edit', 'vac-edit']] });
    else if (v.phase === 'late') out.push({ kind: 'vacation', cls: 'teal', ic: 'plane', title: 'Not back yet?', line: `Was due ${esc(shortClock(t.backAt))} · holding the trip setting again`, btns: [['I’m home', 'vac-home'], ['Running late', 'vac-edit']] });
    else if (ac?.welcome || v.phase === 'due') {
      const w = ac?.welcome, target = ac?.arrivalF ?? w?.target, start = w?.startAt ?? now, pct = t.backAt ? Math.max(2, Math.min(100, (now - start) / Math.max(1, t.backAt - start) * 100)) : 50;
      const steps = welcomeSteps(start, w?.fromF ?? st?.indoorF, target, t.backAt);
      out.push({ kind: 'vacation', cls: 'teal', ic: 'home', title: `Getting the house ready · ${target ?? '—'}° by ${esc(shortClock(t.backAt ?? now))}`,
        line: `Cooling from ${w?.fromF != null ? Math.round(w.fromF) : '—'}° since ${esc(clock(start))}${w?.solar ? ' on spare solar' : ''} · ${steps.filter(s => !s.you).map(s => `${esc(s.label)} ${esc(s.sub)}`).join(' · ')}`, bar: pct,
        btns: [['I’m home', 'vac-home'], ['Running late', 'vac-edit']] });
    } else {
      const quiet = (S.vacAlerts ?? []).filter(a => now - Date.parse(a.createdAt) < D);
      const line = ask ? esc(ask.body.replace(/ Open Solstice to answer\.$/, '')) : quiet.length ? `${quiet.length === 1 ? 'One alert' : `${quiet.length} alerts`} today: ${esc(quiet[0].title)}`
        : `${st?.indoorF != null ? `House at ${Math.round(st.indoorF)}°` : 'House'} · Powerwalls ${r ? Math.round(r.soc) + '%' : '—'} · ${esc(dayOfTrip(t.startedAt ?? t.leaveAt, t.backAt, now))}`;
      out.push({ kind: 'vacation', cls: 'teal', ic: 'plane', title: ask ? esc(ask.title) : `Vacation · ${esc(backLabel(t.backAt, now))}`, line, bar: Math.round(tripProgress(t.startedAt ?? t.leaveAt, t.backAt, now) * 100),
        btns: ask ? [['Someone’s allowed', `vac-ans:allowed:${ask.id}`], ['Not expected', `vac-ans:unexpected:${ask.id}`]] : [['I’m home', 'vac-home'], ['Change dates', 'vac-edit']] });
    }
  } else { const last = reportDue(S, now);
    if (last) { const rp = last.report; out.push({ kind: 'vacation', cls: 'teal', ic: 'plane', title: `Your trip · ${esc(weekday(rp.from))}–${esc(weekday(rp.to))}`, line: `${k0(rp.usedKwh)} kWh used · about ${k0(rp.emptyKwh)} empty without Vacation mode`,
      btns: [['See the report', 'vac-report'], ['Dismiss', `vac-dismiss:${last.id}`]] }); } }
  // 3 · AC hold (purple, with its ring)
  const h = S.ac?.hold, hp = S.ac?.state?.mode === 'COOL' || !S.ac?.state ? holdProgress(h, now) : null;
  if (hp) { const R = x => x == null ? x : Math.round(x), what = h.mode === 'OFF' ? 'Off' : h.mode === 'HEAT' ? `heat ${R(h.heatF)}°` : h.mode === 'HEATCOOL' ? `${R(h.heatF)}–${R(h.coolF)}°` : `${R(h.coolF)}°`;
    out.push({ kind: 'hold', cls: 'purple', ring: { pct: hp.pct }, title: h.by === 'app' ? `Holding your ${what}` : `Holding ${what} set at the thermostat`, line: `until ${esc(clock(h.until))}`,
      btns: [['Resume now', 'hold:resume'], ...(h.extended ? [] : [['Until morning', 'hold:morning']])] }); }
  // 4 · pool Clear-up or Boost (blue)
  const p = S.pool, cu = p?.clearUp, bid = boostId(S), bc = p?.snapshot?.circuits?.find(c => c.id === bid), bu = p?.until?.[bid];
  if (cu) { const f = Math.min(1, Math.max(0, (now - cu.startedAt) / (cu.until - cu.startedAt)));
    out.push({ kind: 'pool', cls: 'blue', ic: 'pool', title: `Clear-up · day ${cu.day} of ${cu.days}`, line: `${cu.rpm.toLocaleString()} rpm · ends ${esc(weekday(cu.until))} ${esc(clock(cu.until))}`, bar: f * 100,
      btns: [['Add a day', 'cu:extend'], ['End now', 'cu:end']] }); }
  else if (bc?.on) { const rpm = new Map((p.snapshot?.pump?.circuits ?? []).map(c => [c.circuitId, c.speed])).get(bid);
    out.push({ kind: 'pool', cls: 'blue', ic: 'pool', title: `Boost${rpm ? ` · ${rpm.toLocaleString()} rpm` : ''}`, line: bu ? `${esc(bc.name)} · ends ${esc(clock(bu))}` : `${esc(bc.name)} is on`, btns: [['End now', 'boost:end']] }); }
  // 5 · a Powerwall suggestion waiting (amber)
  const sg = waitingSuggestion(S.pwRules);
  if (sg) { const v2 = sg.suggestion.value, cmds = !!S.pwRules.scope?.energyCmds;
    const title = sg.id === 'reserve' ? `Reserve ${esc(v2)}% tonight?` : sg.id === 'storm' ? `Reserve ${esc(v2)}% before the storm?` : `Export ${esc(EXPORT[v2] ?? v2)}?`;
    out.push({ kind: 'powerwall', cls: 'amber', ic: 'batt', title, line: `${esc(RULE[sg.id].title)} · Suggest`, btns: [[cmds ? 'Apply' : 'How to', cmds ? `pw-apply:${sg.id}` : 'pw-open'], ['Skip', `pw-skip:${sg.id}`]] }); }
  // 6 · the bill should be ready (plain)
  if (S.billDue) out.push({ kind: 'bill', cls: 'plain', ic: 'bill', title: `Your ${esc(S.billDue.month)} PEC bill should be ready`, line: `${esc(S.billDue.period)} · add it to check against Tesla`, btns: [['Add it', 'bill']] });
  // 7 · the weekly digest (plain)
  const dg = digestBanner();
  if (dg) out.push({ kind: 'digest', cls: 'plain', ic: 'chart', title: `Your week · ${esc(dg.week.replace(/^Week \d+ · /, '').replace(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /g, ''))}`, line: dg.lead, btns: [['See the week', 'dg-open'], ['Dismiss', 'dg-dismiss']] });
  return out;
}
let slotKey = '';
export function drawBanner(S) {
  const box = $('banSlot'); if (!box || S.guest) return;
  const b = pickBanner(candidates(S)), html = b ? banner(b) : '';
  if (html === slotKey) return; slotKey = html; box.innerHTML = html;
  box.onclick = async e => {
    const btn = e.target.closest('[data-b]'); if (!btn) return;
    const [k, a1, a2] = btn.dataset.b.split(':');
    switch (k) {
      case 'outage': return S.nav?.sys('powerwall', 'sysOutage');
      case 'vac-check': return openVacation(S, { scrollTo: 'vaCheck' });
      case 'vac-edit': return openVacation(S);
      case 'vac-home': return endTrip(S, btn);
      case 'vac-ans': btn.disabled = true; return answerAsk(S, a1, a2);
      case 'vac-report': return S.vac?.last && openReport(S.vac.last);
      case 'vac-dismiss': return dismissReport(S, a1);
      case 'hold': btn.disabled = true; btn.textContent = '…';
        try { S.ac = await api.acHold(a1); } catch (err) { alert(err.message); } S.reloadAc?.(); return redraw(S);
      case 'cu': if (a1 === 'end' && !confirm('End the Clear-up now? The planner’s schedule goes back on the controller.')) return;
        btn.disabled = true; btn.textContent = 'Sending…'; await clearUpSend(S, { action: a1 }); return redraw(S);
      case 'boost': btn.disabled = true; btn.textContent = 'Sending…'; await poolSend(S, { kind: 'circuit', id: boostId(S), on: false }); return redraw(S);
      case 'pw-apply': return applyRule(S, a1, btn);
      case 'pw-open': return openPwSheet(S);
      case 'pw-skip': { const r = S.pwRules?.rules.find(x => x.id === a1); skip(a1, r?.suggestion?.value); return redraw(S); }
      case 'bill': return;   // main.js's document listener opens the bill sheet ([data-addbill], set below)
      case 'dg-open': return openDigest(S);
      case 'dg-dismiss': return dismissDigest(S);
    }
  };
  box.querySelector('[data-b="bill"]')?.setAttribute('data-addbill', '1');   // main.js's document listener opens the bill sheet
}

/* ======================= the Autopilot hub (frame 1) ======================= */
const row = ({ id, acc, ic, title, mode, value, line, plan, lab = '' }) => `<div class="c-sys ${acc}" role="button" tabindex="0" data-sheet="${id}" aria-label="${esc(title)} controls">
  <span class="c-ic">${icon(ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${title}</b>${mode}<span class="c-sys-v">${value}</span></div><div class="c-sys-l">${line}</div>${plan}${lab}</div>
  <span class="c-chev">${icon('chev')}</span></div>`;
const strip = (now, blocks = [], ticks = []) => `<div class="c-plan" style="--now:${now}%">${blocks.map(b => `<i class="${b.cls}" style="left:${b.left}%;width:${b.width}%"></i>`).join('')}${ticks.map(x => `<u style="left:${x}%"></u>`).join('')}<s></s></div>`;
const skelRow = '<div class="c-sys static"><span class="c-skel" style="width:40px;height:40px;border-radius:12px"></span><div><div class="c-skel" style="width:60%;height:14px"></div><div class="c-skel" style="width:85%;height:10px;margin-top:8px"></div><div class="c-skel r" style="height:6px;margin-top:10px"></div></div><span></span></div>';

function poolRow(S, nowP) {
  const d = S.pool; if (!d) return skelRow;
  const L = d.live, linked = d.linked || !!L, mode = d.autopilot?.mode ?? d.settings?.autopilot;
  if (!linked) return row({ id: 'pool', acc: 'c-acc-pool', ic: 'pool', title: 'Pool', mode: '', value: '—', line: 'Not linked', plan: strip(nowP) });
  const m = Math.floor(localHour() * 60), sch = d.current?.schedules ?? [], cu = d.clearUp, bid = boostId(S), boostOn = !!d.snapshot?.circuits?.find(c => c.id === bid)?.on;
  const inRun = sch.find(s => s.stop > s.start ? m >= s.start && m < s.stop : m >= s.start || m < s.stop), next = sch.filter(s => s.start > m).sort((a, b) => a.start - b.start)[0];
  const line = cu ? `Clear-up · day ${cu.day} of ${cu.days} · ${cu.rpm.toLocaleString()} rpm` : boostOn ? `Boost${d.until?.[bid] ? ` · until ${esc(clock(d.until[bid]))}` : ''}`
    : L?.running ? `Running · ${Math.round(L.watts)} W${inRun ? ` · plan until ${hm(inRun.stop)}` : ''}` : `Off${next ? ` · next run ${hm(next.start)}` : ''}`;
  return row({ id: 'pool', acc: 'c-acc-pool', ic: 'pool', title: 'Pool', mode: modePill(cu ? 'clear' : boostOn ? 'boost' : MODE_CLS[mode]), value: L?.running ? `${L.rpm.toLocaleString()} rpm` : 'off', line,
    plan: strip(nowP, scheduleBlocks(sch, bid)) });
}
function acRow(S, nowP) {
  const d = S.ac; if (!d) return skelRow;
  if (!d.linked || !d.state) return row({ id: 'ac', acc: 'c-acc-ac', ic: 'ac', title: 'AC', mode: '', value: '—', line: d.configured === false ? 'Nest not set up' : 'Nest not linked', plan: strip(nowP) });
  const st = d.state, s = d.settings, ap = s.autopilot, mode = st.eco ? 'ECO' : st.mode;
  const value = mode === 'OFF' ? 'off' : mode === 'ECO' ? 'eco' : mode === 'HEAT' ? `${Math.round(st.heatF)}°` : mode === 'HEATCOOL' ? `${Math.round(st.heatF)}–${Math.round(st.coolF)}°` : `${Math.round(st.coolF)}°`;
  const verb = { COOL: `Cool to ${Math.round(st.coolF)}°`, HEAT: `Heat to ${Math.round(st.heatF)}°`, HEATCOOL: 'Keep between', OFF: 'Thermostat off', ECO: 'Eco · Away' }[mode] ?? mode;
  const line = ap === 'off' ? 'Solstice won’t write to the thermostat' : `${verb} · inside ${st.indoorF ?? '—'}° · ${String(st.hvac ?? 'off').toLowerCase()}`;
  const ab = ap === 'off' ? { blocks: [], ticks: [] } : acBlocks(d.plan?.steps, s.nightFrom, s.nightTo);
  return row({ id: 'ac', acc: 'c-acc-ac', ic: 'ac', title: 'AC', mode: modePill(MODE_CLS[ap]), value, line, plan: strip(nowP, ab.blocks, ab.ticks) });
}
function pwRow(S, nowP) {
  const r = S.live, site = S.now?.site; if (!r || !site) return skelRow;
  const m = rulesPill(S.pwRules?.rules);
  const line = `Reserve ${site.reservePct ?? '—'}% · Storm Watch ${r.stormActive ? 'active' : site.stormWatch ? 'standby' : 'off'}`;
  return row({ id: 'pw', acc: 'c-acc-batt', ic: 'batt', title: 'Powerwalls', mode: modePill(m), value: `${Math.round(r.soc)}%`, line, plan: strip(nowP, chargeBlocks(S.today, S.fc48?.points, localHour(), localDate())) });
}
function awayRow(S) {
  if (!S.vac && !S.ac) return skelRow;
  const t = S.vac?.trip, phase = S.vac?.phase, pr = S.ac?.presence, away = (t && phase !== 'planned') || pr?.state === 'away';
  const ts = tripStrip(t?.leaveAt ?? null, t?.backAt ?? null);
  const line = t ? `Trip ${esc(weekday(t.leaveAt))} ${esc(clock(t.leaveAt))} → ${t.backAt ? `${esc(weekday(t.backAt))} ${esc(clock(t.backAt))}` : 'open'}`
    : pr?.state === 'away' ? (pr.until ? `Away until ${esc(when(pr.until))}` : pr.source === 'nest' ? 'Nest says Away' : 'Away') : 'No trip planned';
  return row({ id: 'away', acc: 'c-acc-vac', ic: 'plane', title: 'Away', mode: modePill(away ? 'away' : 'home'), value: esc(tripIn(t, phase)), line,
    plan: `<div class="c-plan" style="--now:${ts.now}%">${ts.block ? `<i style="left:${ts.block.left}%;width:${ts.block.width}%"></i>` : ''}<s></s></div>`, lab: `<div class="c-plan-lab">${ts.labels.map(l => `<span>${l}</span>`).join('')}</div>` });
}
let hubKey = '';
export function drawHub(S) {
  const box = $('hubRows'); if (!box || S.guest) return;
  const nowP = nowPct(localHour());
  const html = poolRow(S, nowP) + acRow(S, nowP) + pwRow(S, nowP) + awayRow(S);
  if (html !== hubKey) { hubKey = html; box.innerHTML = html; }
  $('hubFig').textContent = hubFigure([S.pool?.autopilot?.mode ?? S.pool?.settings?.autopilot, S.ac?.linked ? S.ac.settings?.autopilot : null, rulesPill(S.pwRules?.rules)]);
}

/* ======================= the Conditions sheet (frame 4) ======================= */
export function openConditions(S) {
  const r = S.live, site = S.now?.site ?? {}, now = Date.now(), offline = !!S.nowOffline;
  const st = statusPill({ outage: !!S.outageActive, outageSince: S.now?.outage?.since ?? S.previewSince ?? null, offline, readingAt: r?.ts ?? null, nws: S.nws ?? [], ercot: S.ercot ?? null, stormActive: !!r?.stormActive });
  const badge = `<span class="c-badge" data-t="${st.level === 'ok' ? 'live' : st.level === 'alert' ? 'sim' : 'e'}">${esc(st.text)}</span>`;
  const nws = S.nws ?? [], e = S.ercot, load = e?.demandMw && e?.capacityMw ? Math.round(e.demandMw / e.capacityMw * 100) : null;
  const age = r ? now - r.ts : null;
  const rows = [
    sysRow({ acc: S.outageActive ? 'c-acc-out' : 'c-acc-batt', ic: 'batt', title: S.outageActive ? 'Powerwalls · islanded' : offline ? 'Can’t reach Solstice' : 'Powerwalls online', stat: true,
      line: r ? `last reading ${ageWords(age)}` : 'waiting for the first reading', end: `<span class="c-num c-cap">${r ? ageShort(age) : '—'}</span>` }),
    sysRow({ acc: nws.some(nwsIsWarning) ? 'c-acc-out' : nws.length ? 'c-acc-solar' : 'c-acc-home', ic: 'cloud', title: 'Weather alerts', stat: true,
      line: S.nws == null ? 'checking NWS…' : nws.length ? esc(nws.map(a => a.event).join(' · ')) : 'none from NWS', end: `<span class="c-badge">${S.nws == null ? '—' : nws.length || 'none'}</span>` }),
    sysRow({ acc: e && e.condition !== 'normal' ? 'c-acc-solar' : 'c-acc-grid', ic: 'tower', title: 'ERCOT', stat: true,
      line: e ? `${esc(e.condition === 'normal' ? 'normal' : e.title || e.condition)}${load != null ? ` · ${load}% load` : ''}` : 'checking…', end: `<span class="c-num c-cap">${load != null ? load + '%' : '—'}</span>` }),
    sysRow({ acc: 'c-acc-solar', ic: 'storm', title: 'Storm Watch', stat: true, line: `${r?.stormActive ? 'active · charging for a storm' : site.stormWatch ? 'standby' : 'off'}${S.wxStorm ? ` · ${esc(S.wxStorm)}` : ''}`,
      end: `<span class="c-badge">${r?.stormActive ? 'active' : site.stormWatch ? 'standby' : 'off'}</span>` }),
  ].join('');
  const alerts = nws.length ? `<div class="c-well">${nws.map(a => `<div class="c-check" style="grid-template-columns:minmax(0,1fr)"><span><b>${esc(a.event)}</b>${a.ends || a.expires ? ` · until ${esc(when(Date.parse(a.ends ?? a.expires)))}` : ''}${a.headline ? `<br><span class="c-cap">${esc(a.headline)}</span>` : ''}</span></div>`).join('')}</div>` : '';
  const { rows: hr, issues } = healthRows(S, S.status);
  const health = `<div class="c-lab">Data health <span style="letter-spacing:0;text-transform:none;font-weight:500">· ${issues ? `${issues} issue${issues === 1 ? '' : 's'}` : 'all good'}</span></div>
    <div class="c-well" style="margin-top:0;padding:4px 12px"><div class="c-parts" style="margin:0">${hr.map(x => `<div class="c-part ${x.ok ? 'c-acc-batt' : 'c-acc-warn'}"><i style="border-radius:50%"></i><span>${x.label}</span><b>${x.v}</b></div>`).join('')}</div></div>`;
  const mcap = site.modelKwh || site.capacityKwh || 27, kw = r?.homeKw > .05 ? r.homeKw : null, ready = r && kw ? `${fmtDur(Math.max(0, r.soc) / 100 * mcap * .95 / kw)} at ${kw.toFixed(1)} kW` : 'if the grid went down now';
  const links = `<div class="c-card flush">${S.guest ? '' : sysRow({ acc: 'c-acc-out', ic: 'shield', title: 'Outage readiness', line: esc(ready), id: 'cdOutage' })}${sysRow({ acc: 'c-acc-home', ic: 'link', title: 'Connections', line: 'Tesla · Open-Meteo · ScreenLogic · Nest · PEC bills', id: 'cdConn' })}</div>`;
  sheet(`${sheetHead('Conditions', badge, 'Everything the Status pill adds up, in one place.')}<div class="c-card flush">${rows}</div>${alerts}${health}${links}${sheetFoot('', 'Done')}`);
  $('sheetBody').querySelector('[data-f="pri"]').onclick = closeSheet;
  if ($('cdOutage')) $('cdOutage').onclick = () => { closeSheet(); S.nav?.sys('powerwall', 'sysOutage'); };
  $('cdConn').onclick = () => { closeSheet(); S.nav?.go('v-set'); };
}
const ageShort = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3600_000)} h`;

/* ======================= wiring ======================= */
const redraw = S => { drawPills(S); drawBanner(S); drawHub(S); };
export { redraw as redrawNowTop };
export function initNowTop(S) {
  $('statusPill').onclick = () => openConditions(S);
  $('vacPill').onclick = () => openVacation(S);
  $('hubRows').onclick = e => { const r = e.target.closest('[data-sheet]'); if (!r) return;
    ({ pool: openPoolSheet, ac: openAcSheet, pw: openPwSheet, away: s => openVacation(s) })[r.dataset.sheet]?.(S); };
}
