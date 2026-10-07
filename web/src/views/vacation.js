// Vacation mode (approved mockup mockups/ak-vacation.html): the sheet that starts a trip (frames 1, 1b and 2), the banner on Now while it
// runs (frames 3 and 5), the "Is someone home?" answer (frame 4), the trip report (frame 6) and the past trips on Insights › Home.
// Since mockup al (v2): the sheet is the Away & Vacation sheet (frame 8: Home / Away until… first, then the trip), the chip is Now's
// Vacation pill and the banner is one of the banner slot's (views/nowhub.js draws both from S.vac).
// Owner only: every route is owner-only on the server and none of this is drawn for a guest. Nothing here writes to a device except the
// owner's own "Turn off" on the sheet, which is the pool command the Pool card already sends.
import { $, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { pickedEpoch, localInput, clock, weekday, presets, untilLabel } from '../lib/presence.js';
import { spanLabel, defaultDates, poolBackLabel, dateLabel, shortClock, minus, k0 } from '../lib/vacation.js';
import { tripStrip } from '../lib/nowui.js';
import { icon } from '../lib/icons.js';
import { sheet, sheetHead, sheetFoot, modePill, seg } from './csheet.js';

const D = 864e5;
const dismissKey = id => `solstice:tripReport:${id}`;
const dismissed = id => { try { return localStorage.getItem(dismissKey(id)) === '1'; } catch { return false; } };
const dismiss = id => { try { localStorage.setItem(dismissKey(id), '1'); } catch { /* storage off */ } };
const close = () => $('phone').classList.remove('open');

/* ======================= loading ======================= */
export function initVacation(S, every) {
  if (S.guest) return;
  S.openVacation = opts => openVacation(S, opts);
  const params = new URLSearchParams(location.search);
  const detected = params.get('vacation') === 'detected';
  every(60_000, async () => {
    await load(S);
    if (detected && !S.vacOpened) { S.vacOpened = true; if (!S.vac?.trip) openVacation(S, { detected: true }); }
  });
  initTrips(S, every);
}
async function load(S) {
  S.vac = await api.vacation();
  const t = S.vac.trip;
  if (t && S.vac.phase !== 'planned') {
    const feed = await api.alerts(20).catch(() => null);
    S.vacAlerts = (feed?.alerts ?? []).filter(a => a.kind === 'vacation' && Date.parse(a.createdAt) >= (t.startedAt ?? t.leaveAt));
    if (!S.vacEst || S.vacEst.trip !== t.id) S.vacEst = { trip: t.id, est: await api.vacationEstimate(t.startedAt ?? t.leaveAt, t.backAt).catch(() => null) };
  }
  drawNow(S);
}
const reload = async S => { await load(S).catch(e => toast('!', 'rgba(255,90,78,.25)', 'Vacation mode', e.message)); S.reloadAc?.(); };

/* ======================= Now: the pill and the banner are drawn by views/nowhub.js; these are their actions ======================= */
export function drawNow(S) { S.redrawNow?.(); }
/** The trip report on Now for four days after a trip, until dismissed on this device. */
export function reportDue(S, now = Date.now()) { const last = S.vac?.last; return !S.vac?.trip && last?.report && now - last.endedAt < 4 * D && !dismissed(last.id) ? last : null; }
export function dismissReport(S, id) { dismiss(id); S.redrawNow?.(); }
export function openReport(trip) {
  $('sheetBody').innerHTML = `<div class="vrep sheetrep">${reportHtml(trip, false)}</div><button class="primary" id="vrClose">Close</button>`; $('vrClose').onclick = close; $('phone').classList.add('open');
}
/** "I'm home": ends the trip after the same confirm as before. */
export async function endTrip(S, btn) {
  if (!confirm('End Vacation mode now?\n\nThe AC goes back to your comfort plan (2° every 30 minutes), the pool to its normal plan at the next evening run, and guest links come back in 24 h.')) return;
  if (btn) btn.textContent = 'Ending…'; await api.vacationEnd().catch(e => alert(e.message)); toast('✓', 'rgba(127,224,200,.22)', 'Welcome home', 'Vacation mode ended.'); reload(S);
}
/** The "Is someone home?" answer (frame 4). */
export async function answerAsk(S, ans, alertId) {
  await api.vacationAnswer(ans).catch(e => alert(e.message)); await api.readAlert(alertId).catch(() => {});
  toast('✓', 'rgba(127,224,200,.22)', ans === 'allowed' ? 'Noted: someone is allowed in today' : 'Noted', ans === 'allowed' ? 'Solstice won’t ask again today.' : 'Solstice keeps watching.'); reload(S);
}

/* ======================= the report (frame 6) ======================= */
const PART = { ac: ['AC', '#ff9e66'], pool: ['Pool', 'var(--home)'], alwaysOn: ['Always-on', 'var(--batt)'], waterHeater: ['Water heater', '#c4a2ff'], else: ['Everything else', 'rgba(242,244,248,.5)'] };
function lengthLabel(ms) { const h = Math.round(ms / 3600_000), d = Math.floor(h / 24); return d ? `${d} day${d === 1 ? '' : 's'}${h % 24 ? ` ${h % 24} h` : ''}` : `${h} h`; }
export function reportHtml(trip, closable) {
  const r = trip.report, max = Math.max(1, ...r.parts.map(p => Math.max(p.used, p.empty)));
  return `<div class="h"><b>Your trip · ${esc(weekday(r.from))}–${esc(weekday(r.to))}</b><span style="display:flex;align-items:center;gap:8px"><span class="badge vb">${esc(lengthLabel(r.to - r.from))}</span>${closable ? '<button class="x" id="vrepX" aria-label="Dismiss">✕</button>' : ''}</span></div>
    <div class="sum3"><div><small>If you’d been home</small><b>${k0(r.homeKwh)}<small> kWh</small></b></div><div><small>Empty, no Vacation mode</small><b>${k0(r.emptyKwh)}<small> kWh</small></b></div><div class="hl"><small>Used</small><b>${k0(r.usedKwh)}<small> kWh</small></b></div></div>
    <div class="bars">${r.parts.map(p => `<div><span>${PART[p.id][0]}</span><s><i class="cf" style="width:${p.empty / max * 100}%"></i><i style="width:${p.used / max * 100}%;background:${PART[p.id][1]}"></i></s><em>${k0(p.used)} / ${k0(p.empty)}</em></div>`).join('')}</div>
    <div class="key"><span><i style="background:rgba(255,255,255,.14)"></i>empty, no Vacation mode</span><span><i style="background:var(--vac)"></i>coloured: used (kWh)</span></div>
    ${r.did?.length ? `<div class="tline" style="margin-top:14px">${r.did.slice(-6).map(l => `<div><i></i><p>${esc(l)}</p></div>`).join('')}</div>` : ''}
    ${r.next?.length ? `<div class="rec vnext"><b>Next time</b><ul>${r.next.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    <p class="fine" style="margin-top:10px">Used is measured. The other two are Solstice’s estimates for the same days and weather${r.model?.days ? `, from this house’s own model (${r.model.days} days)` : ''}.${r.alerts ? ` ${r.alerts} alert${r.alerts === 1 ? '' : 's'} while you were away.` : ''}</p>`;
}

/* ======================= Insights › Home: past trips ======================= */
function initTrips(S, every) {
  const home = $('ip-home'); if (!home || $('vacTrips')) return;
  home.insertAdjacentHTML('beforeend', '<div class="card" id="vacTrips" data-owner hidden><div class="h"><b>Your trips</b><span>Vacation mode</span></div><div class="group" id="vacTripList" style="margin-top:10px"></div></div>');
  every(10 * 60_000, async () => {
    const trips = (await api.vacationTrips()).filter(x => x.report);
    $('vacTrips').hidden = !trips.length;
    $('vacTripList').innerHTML = trips.map(x => `<div class="row tap" data-trip="${x.id}" tabindex="0" style="--c:var(--vac)"><div class="ri">✈</div><div class="rt">${esc(dateLabel(x.startedAt))} – ${esc(dateLabel(x.endedAt))}<small>${k0(x.report.usedKwh)} kWh used · about ${k0(x.report.emptyKwh)} empty without Vacation mode</small></div><div class="chev">›</div></div>`).join('');
    $('vacTripList').onclick = e => { const row = e.target.closest('[data-trip]'); const x = trips.find(y => String(y.id) === row?.dataset.trip); if (!x) return;
      $('sheetBody').innerHTML = `<div class="vrep sheetrep">${reportHtml(x, false)}</div><button class="primary" id="vrClose">Close</button>`; $('vrClose').onclick = close; $('phone').classList.add('open'); };
  });
}

/* ======================= the Away & Vacation sheet (mockup al frame 8; the trip parts are mockup ak frames 1, 1b and 2) ======================= */
const CHECK = [['waterHeater', 'Water heater', 'to its vacation setting · about 1.3 kWh a day while you’re away'], ['unplug', 'Unplug what can be', '· the house drops about 0.4 kW by itself when you leave']];
const MODE_WORD = m => m ? modePill(m) : '';
export async function openVacation(S, opts = {}) {
  const live = S.vac?.trip ?? null, edit = !!live, now = Date.now(), d = defaultDates(now);
  let leaveAt = live?.leaveAt ?? d.leaveAt, backAt = live ? live.backAt : opts.detected ? null : d.backAt;
  const tick = { ...(live?.data?.checklist ?? {}) }; let macHome = live?.data?.macHome ?? true, est = null, check = null, busy = false;
  const started = edit && live.state === 'active';
  // Home / Away until… (the AC's presence, as the AC card's Home/Away sets it): staged until the footer's primary is tapped
  const ac = S.ac, pr = ac?.presence ?? { state: ac?.settings?.presence }, onVac = pr.source === 'vacation';
  const presNow = pr.state === 'away' ? 'away' : 'home', awayF = ac?.settings?.awayF ?? 80;
  let pres = null;   // { state: 'home' } | { state: 'away', at: epoch | null, id }
  const P0 = presets(now), tonight = P0.find(p => p.id === 'tonight'), morning = P0.find(p => p.id === 'morning');
  const durs = [{ id: '2h', label: '2 h', at: Math.round((now + 2 * 3600_000) / 60_000) * 60_000 }, ...(tonight ? [{ id: 'tonight', label: 'until 6 PM', at: tonight.at }] : []), { id: 'morning', label: 'until tomorrow', at: morning.at }];
  const open = new Set();
  const draw = () => {
    const leaveNow = leaveAt <= Date.now() + 5 * 60_000, strip = tripStrip(leaveNow ? Date.now() : leaveAt, backAt, Date.now());
    const lit = pres?.state ?? presNow;
    const choice = `<div class="c-choice c-acc-vac" id="vaPres">
        <button data-pres="home" class="${lit === 'home' ? 'on' : ''}" aria-pressed="${lit === 'home'}"><b>${icon('home')}Home</b><small>normal comfort targets</small></button>
        <button data-pres="away" class="${lit === 'away' ? 'on' : ''}" aria-pressed="${lit === 'away'}"${onVac ? ' disabled' : ''}><b>${icon('plane')}${onVac ? 'Vacation' : 'Away until…'}</b><small>${onVac ? 'the trip below holds the house' : `AC eases to ${awayF}° while you’re out`}</small></button></div>
      ${onVac || !ac?.linked ? '' : `<div class="c-fpills" id="vaDur" style="margin-top:8px">${durs.map(x => `<button class="c-fpill${pres?.id === x.id ? ' on' : ''}" data-dur="${x.id}">${x.label}</button>`).join('')}</div>`}
      ${opts.detected ? '<p class="c-cap" style="margin-top:10px">Nest has said Away and nothing at home has been used since. Set when you’re back, or leave it open.</p>' : ''}`;
    const dates = `<div class="c-lab">Vacation</div>
      <div class="c-dates c-acc-vac">
        <label class="c-date${started ? ' off' : ''}"><small>Leaving</small><b>${leaveNow ? (started ? esc(dateLabel(live.startedAt ?? leaveAt)) : 'Now') : esc(dateLabel(leaveAt))}</b><span>${leaveNow && !started ? 'when you tap Start' : esc(clock(leaveAt))}</span>${started ? '' : `<input type="datetime-local" id="vaLeave" value="${localInput(leaveAt)}" min="${localInput(Date.now())}" max="${localInput(Date.now() + 60 * D)}" aria-label="Leaving">`}</label>
        <label class="c-date"><small>Back</small><b>${backAt ? esc(dateLabel(backAt)) : 'Not set'}</b><span>${backAt ? esc(clock(backAt)) : 'tap to set'}</span><input type="datetime-local" id="vaBack" value="${backAt ? localInput(backAt) : ''}" min="${localInput(Math.max(Date.now(), leaveAt) + 3600_000)}" max="${localInput(leaveAt + 60 * D)}" aria-label="Back"></label></div>
      <div class="c-acc-vac" style="margin-top:12px"><div class="c-plan" style="--now:${strip.now}%">${strip.block ? `<i style="left:${strip.block.left}%;width:${strip.block.width}%"></i>` : ''}<s></s></div><div class="c-plan-lab">${strip.labels.map(l => `<span>${l}</span>`).join('')}</div></div>`;
    const go = started ? '' : `<div class="c-lab">Before you go</div><div class="c-well" style="margin-top:0;padding:2px 12px" id="vaCheck">${checkRows()}</div>`;
    const plan = `<div class="c-lab">While you’re away</div><div class="c-card flush" style="margin-top:0" id="vaPlan">${planRows()}</div>
      <div class="c-well" id="vaSum"${est?.perDay ? '' : ' hidden'}>${sumHtml()}</div><p class="c-fine" id="vaTot">${totHtml()}</p>`;
    const span = spanLabel(leaveNow ? Date.now() : leaveAt, backAt);
    const presLabel = pres ? (pres.state === 'home' ? 'Mark the house Home' : pres.at ? `Away until ${untilLabel(pres.at, Date.now())}` : 'Away until I’m back') : null;
    const pri = presLabel ?? (edit ? 'Save dates' : `Start Vacation mode · ${span}`);
    const sec = pres ? 'Cancel' : edit ? (started ? 'End trip' : 'Cancel trip') : opts.detected ? 'I’m just out' : null;
    const fine = edit ? (started ? 'The trip keeps running with the new arrival time.' : `Nothing changes until ${weekday(leaveAt, 'long')} ${clock(leaveAt)}.`)
      : leaveNow ? 'Starts now. You can change the dates or end it from the Now screen.' : `Nothing changes until ${weekday(leaveAt, 'long')} ${clock(leaveAt)}. You can change the dates or end it from the Now screen.`;
    sheet(`${sheetHead('Away &amp; Vacation')}${choice}${dates}${go}${plan}<p class="c-fine" style="text-align:center">${esc(fine)}</p>${sheetFoot(sec, esc(pri), 'c-acc-vac', { del: !pres && edit })}`, { keepScroll: true });
    wire();
  };
  const checkRows = () => {
    const rows = [], p = check?.pool, n = check?.nest, ok = (b, t = '') => `<div class="c-check"><i>✓</i><span><b>${b}</b>${t}</span></div>`;
    if (!check) rows.push('<div class="c-check"><i class="todo"></i><span>Checking the pool and the thermostat…</span></div>');
    for (const o of p?.leftOn ?? []) rows.push(`<div class="c-check"><i class="todo"></i><span><b>${esc(o.name)} is on</b>${o.kind === 'heat' ? ' · propane while it runs' : o.watts ? ` · ${o.watts.toLocaleString()} W, about ${o.kwhPerDay} kWh a day if it stays on` : ''}<br><button class="c-btn sm line" data-off="${o.id}" style="margin-top:6px">Turn off</button></span></div>`);
    if (p?.linked && !(p.leftOn ?? []).length) rows.push(ok('Pool Light, spa, jets and blower are off', ' · spa heat too'));
    if (p?.linked) rows.push(p.water ? `<div class="c-check"><i class="todo"></i><span><b>Your last test said ${esc(p.water)}</b> · the trip plan waits until a clear test; the pool keeps its normal plan</span></div>`
      : p.clearUp ? '<div class="c-check"><i class="todo"></i><span><b>A Clear-up is running</b> · the trip plan starts after it</span></div>' : ok('Water looked clear', ' on your last test · no Clear-up running'));
    if (n) rows.push(n.autopilot === 'off' ? '<div class="c-check"><i class="todo"></i><span><b>AC Autopilot is Off</b> · Vacation mode won’t change the thermostat</span></div>'
      : ok('Thermostat linked', ` · ${n.eco ? 'Eco will be turned off so Solstice can hold ' : 'Solstice will hold '}${n.mode === 'HEAT' ? '55° heat' : '85°'}`));
    if (check && !p?.linked && !n) rows.push('<div class="c-check"><i class="todo"></i><span>Nothing to check: the pool and thermostat aren’t linked.</span></div>');
    rows.push(...CHECK.map(([k, b, t]) => `<div class="c-check" role="button" tabindex="0" data-tick="${k}" aria-pressed="${!!tick[k]}"><i class="${tick[k] ? '' : 'todo'}">${tick[k] ? '✓' : ''}</i><span><b>${b}</b> ${t}</span></div>`));
    rows.push(`<div class="c-check"><i class="${tick.mac ? '' : 'todo'}">${tick.mac ? '✓' : ''}</i><span><b>Mac</b> that runs the panel relay · staying home?${seg([['1', 'Yes'], ['0', 'No']], macHome ? '1' : '0', { cls: 'sm acc', acc: 'c-acc-vac', attr: 'data-mac', label: 'Mac staying home' })}</span></div>`);
    return rows.join('');
  };
  const planRows = () => {
    const n = check?.nest, heat = n?.mode === 'HEAT', back = backAt ? `${weekday(backAt)} ${shortClock(backAt)}` : 'you’re back';
    const guestsBack = backAt ? `${weekday(backAt + D)} ${shortClock(backAt + D)}` : 'a day after you’re back';
    const s = est?.saving, em = v => v != null && v > .05 ? `<span class="c-end"><span class="c-num">${minus(v)} kWh/d</span><span class="c-chev">${icon('chev')}</span></span>` : '';
    const turns = (S.pool?.live?.waterTemp ?? 0) >= 80 ? '1.5 turnovers' : '1 turnover';
    const rows = [
      ['ac', 'c-acc-ac', 'AC', MODE_WORD(n?.autopilot ?? S.ac?.settings?.autopilot), heat ? 'heat 55° · back for your arrival' : 'hold 85° · humidity guard', em(s?.acPerDay),
        heat ? 'Heat <b>55°</b> (Nest’s Eco is 50°); your setting comes back for your arrival.' : 'Hold <b>85°</b>. If humidity stays over 60% for 2 h, step down 2° at a time (never below 80°) until it’s under 55%.'],
      ['pool', 'c-acc-pool', 'Pool', MODE_WORD(check?.pool?.autopilot ?? S.pool?.autopilot?.mode), `${turns} a day · sunniest hours`, em(s?.poolPerDay),
        `<b>${turns}</b> a day on the sunniest hours. No spare-solar speed-ups. +1 h skim after heavy rain.`],
      ['batt', 'c-acc-batt', 'Powerwalls', '', 'self-powered · 20% reserve', '', 'Self-powered, solar-only export, 20% reserve. Storm rule raises the reserve <b>without waiting for you</b> on this trip, and lowers it again after.'],
      ['bell', 'c-acc-grid', 'Alerts', '', 'grid, heat, damp, pump', '', 'Grid down, too hot or cold, damp, thermostat offline, pump not running, unexpected power use, someone at the thermostat. Water-test and panel reminders wait until you’re back.'],
      ['share', 'c-acc-house', 'Guest links', '', `paused until ${esc(guestsBack)}`, '', `Paused until ${esc(guestsBack)}. Guests see the usual “turned off” card.`],
      ['sun', 'c-acc-solar', 'Welcome home', '', `AC to ${heat ? 'your heat setting' : `${S.ac?.settings?.dayF ?? 78}°`}, pool back on plan`, '',
        `${backAt ? `Pool back on its normal plan ${esc(poolBackLabel(backAt))}. ` : ''}AC ${heat ? 'back to your heat setting' : `cools to <b>${S.ac?.settings?.dayF ?? 78}°</b>`} before ${esc(back)}, on solar when it can.`],
    ];
    return rows.map(([ic, acc, t, mode, line, end, more], i) => `<div class="c-sys compact ${acc}${open.has(i) ? ' c-open' : ''}" role="button" tabindex="0" data-row="${i}" aria-expanded="${open.has(i)}"><span class="c-ic">${icon(ic === 'ac' ? 'ac' : ic === 'pool' ? 'pool' : ic)}</span><div style="min-width:0"><div class="c-sys-top"><b>${t}</b>${mode}</div><div class="c-sys-l">${line}</div></div>${end || `<span class="c-chev">${icon('chev')}</span>`}</div>${open.has(i) ? `<div class="c-inner c-cap">${more}</div>` : ''}`).join('');
  };
  const sumHtml = () => { const p = est?.perDay; return p ? `<div class="c-kv" style="margin-top:0"><span>A day at home</span><b>${k0(p.home)} kWh</b><span>Empty, no Vacation mode</span><b>${k0(p.empty)} kWh</b><span>With Vacation mode</span><b>${k0(p.vacation)} kWh</b></div>` : ''; };
  const totHtml = () => est ? `${est.open ? 'For a week away: about' : 'About'} ${k0(est.total.vacation)} kWh${est.open ? '' : ' for the trip'}${est.total.home != null ? ` instead of about ${k0(est.total.home)} at home` : ''}. Solstice’s own share is about ${k0(est.saving.totalKwh)} kWh (the AC and pool lines).${est.total.home != null ? ' The rest happens because nobody’s home.' : ''} Estimates.` : 'Working out the estimate…';
  const wire = () => {
    $('vaPres').onclick = e => { const b = e.target.closest('[data-pres]'); if (!b || b.disabled) return;
      const want = b.dataset.pres; pres = want === presNow ? null : want === 'home' ? { state: 'home' } : { state: 'away', at: null, id: 'open' }; draw(); };
    if ($('vaDur')) $('vaDur').onclick = e => { const b = e.target.closest('[data-dur]'); if (!b) return; const x = durs.find(y => y.id === b.dataset.dur); pres = pres?.id === x.id ? null : { state: 'away', at: x.at, id: x.id }; draw(); };
    if ($('vaLeave')) $('vaLeave').onchange = e => { const v = pickedEpoch(e.target.value); if (v) { leaveAt = Math.max(v, Date.now()); if (backAt && backAt < leaveAt + 3600_000) backAt = leaveAt + 3 * D; draw(); estimate(); } };
    $('vaBack').onchange = e => { const v = pickedEpoch(e.target.value); backAt = v && v > leaveAt + 3600_000 ? v : backAt; draw(); estimate(); };
    const ck = $('vaCheck');
    if (ck) ck.onclick = async e => {
      const m = e.target.closest('[data-mac]'); if (m) { macHome = m.dataset.mac === '1'; tick.mac = true; return draw(); }
      const t = e.target.closest('[data-tick]'); if (t) { tick[t.dataset.tick] = !tick[t.dataset.tick]; return draw(); }
      const b = e.target.closest('[data-off]'); if (!b || busy) return; busy = true; b.textContent = 'Turning off…';
      const id = +b.dataset.off;   // the owner's own "Turn off": the pool command the Pool card already sends
      try { S.pool = await api.poolCommand(id === -1 ? { kind: 'spaHeat', on: false } : { kind: 'circuit', id, on: false }); check = await api.vacationCheck(); }
      catch (err) { toast('!', 'rgba(255,90,78,.25)', 'Not turned off', err.message); }
      busy = false; draw();
    };
    $('vaPlan').onclick = e => { const r = e.target.closest('[data-row]'); if (!r) return; const i = +r.dataset.row; open.has(i) ? open.delete(i) : open.add(i); draw(); };
    const foot = document.querySelector('#sheetBody .c-sheet-f');
    foot.querySelector('[data-f="pri"]').onclick = async () => {
      if (busy) return; const go = foot.querySelector('[data-f="pri"]');
      if (pres) {   // Home / Away until…: the same two writes the AC card's Home/Away control sends
        if (pres.state === 'home' && !confirm('Mark the house Home?\n\nThe AC plan goes back to your home band, so the thermostat may change now.')) return;
        busy = true; go.textContent = 'Saving…';
        try { if (pres.state === 'home') await api.acSettings({ presence: 'home' }); else await api.setPresence('away', pres.at); close(); S.reloadAc?.(); }
        catch (e) { alert(e.message); busy = false; draw(); }
        return;
      }
      busy = true; go.textContent = 'Saving…';
      try {
        if (edit) await api.vacationPatch(started ? { backAt } : { leaveAt, backAt });
        else await api.vacationStart({ leaveAt: leaveAt <= Date.now() + 5 * 60_000 ? Date.now() : leaveAt, backAt, detected: !!opts.detected, checklist: { waterHeater: !!tick.waterHeater, unplug: !!tick.unplug, mac: !!tick.mac }, macHome });
        close(); toast('✈', 'rgba(127,224,200,.22)', edit ? 'Dates saved' : 'Vacation mode is set', backAt ? `Back ${weekday(backAt)} ${shortClock(backAt)}` : 'Until you’re back');
        await reload(S);
      } catch (e) { alert(e.message); busy = false; draw(); }
    };
    const sec = foot.querySelector('[data-f="sec"]');
    if (sec) sec.onclick = async () => {
      if (pres) { pres = null; return draw(); }
      if (edit) { if (!confirm(started ? 'End Vacation mode now?' : 'Cancel this trip? Nothing has changed yet.')) return; await api.vacationEnd().catch(e => alert(e.message)); close(); reload(S); return; }
      if (opts.detected) { await api.vacationSnooze().catch(() => {}); close(); toast('✓', 'rgba(255,255,255,.12)', 'Got it', 'No more of those for 24 hours.'); }
    };
    if (opts.scrollTo && $(opts.scrollTo)) { $(opts.scrollTo).scrollIntoView({ block: 'start' }); opts.scrollTo = null; }
  };
  let timer = null;
  const estimate = () => { clearTimeout(timer); timer = setTimeout(async () => { est = await api.vacationEstimate(Math.max(leaveAt, Date.now()), backAt).catch(() => null); if (showing()) draw(); }, 250); };
  const showing = () => !!$('vaPlan') && $('phone').classList.contains('open');
  draw(); estimate();
  if (!started) { check = await api.vacationCheck().catch(() => null); if (showing()) draw(); }
}
