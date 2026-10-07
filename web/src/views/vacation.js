// Vacation mode (approved mockup mockups/ak-vacation.html): the sheet that starts a trip (frames 1, 1b and 2), the chip and banner on Now
// while it runs (frames 3 and 5), the "Is someone home?" answer (frame 4), the trip report (frame 6) and the past trips on Insights › Home.
// Owner only: every route is owner-only on the server and none of this is drawn for a guest. Nothing here writes to a device except the
// owner's own "Turn off" on the sheet, which is the pool command the Pool card already sends.
import { $, toast, ago } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { pickedEpoch, localInput, clock, weekday } from '../lib/presence.js';
import { backLabel, spanLabel, dayOfTrip, tripProgress, defaultDates, poolBackLabel, welcomeSteps, dateLabel, shortClock, minus, k0 } from '../lib/vacation.js';

const D = 864e5;
const dismissKey = id => `solstice:tripReport:${id}`;
const dismissed = id => { try { return localStorage.getItem(dismissKey(id)) === '1'; } catch { return false; } };
const dismiss = id => { try { localStorage.setItem(dismissKey(id), '1'); } catch { /* storage off */ } };
const close = () => $('phone').classList.remove('open');

/* ======================= loading ======================= */
export function initVacation(S, every) {
  if (S.guest || !$('vacNow')) return;
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

/* ======================= Now: the chip, the banner, the report ======================= */
export function drawNow(S) {
  const v = S.vac, box = $('vacNow'); if (!v || !box) return;
  let chip = $('chipVac');
  if (!chip) { $('chips').insertAdjacentHTML('beforeend', '<div class="chipx vidle" id="chipVac" data-owner role="button" tabindex="0"><i></i>Vacation…</div>'); chip = $('chipVac'); chip.onclick = () => openVacation(S); }
  const t = v.trip, away = t && v.phase !== 'planned';
  // frame 3: during a trip the chip leads the row; otherwise "Vacation…" sits at its end (frame 7)
  if (away && $('chips').firstElementChild !== chip) $('chips').prepend(chip); else if (!away && $('chips').lastElementChild !== chip) $('chips').append(chip);
  chip.className = `chipx ${away ? 'vacc' : 'vidle'}`;
  chip.innerHTML = `<i></i>${!t ? 'Vacation…' : v.phase === 'planned' ? `Vacation · from ${weekday(t.leaveAt)} ${shortClock(t.leaveAt)}` : `Vacation · ${esc(backLabel(t.backAt))}`}`;
  if (away) { box.innerHTML = bannerHtml(S); wireBanner(S); return; }
  const last = v.last;
  if (!t && last?.report && Date.now() - last.endedAt < 4 * D && !dismissed(last.id)) {
    box.innerHTML = `<div class="card vrep">${reportHtml(last, true)}</div>`;
    $('vrepX').onclick = () => { dismiss(last.id); box.innerHTML = ''; };
    return;
  }
  box.innerHTML = '';
}

function bannerHtml(S) {
  const v = S.vac, t = v.trip, ac = S.ac?.vacation, st = S.ac?.state, now = Date.now();
  const ask = (S.vacAlerts ?? []).find(a => a.data?.ask === 'wall' && !a.readAt);
  const buttons = (extra = '') => `<div class="row2">${extra || '<button class="p" id="vacHome">I’m home</button><button id="vacDates">Change dates</button>'}</div>`;
  // late: not back 2 h after the arrival time (frame 5's "Running late")
  if (v.phase === 'late') return `<div class="vac"><div class="hh"><i></i><b>Not back yet?</b><em>was due ${esc(shortClock(t.backAt))}</em></div>
    <p>Holding the trip setting again. Change the arrival time, or tap I’m home when you are.</p>${buttons('<button class="p" id="vacHome">I’m home</button><button id="vacDates">Running late</button>')}</div>`;
  // the welcome: from its start through the arrival time
  if (ac?.welcome || v.phase === 'due') {
    const w = ac?.welcome, target = ac?.arrivalF ?? w?.target, start = w?.startAt ?? now, solar = w?.solar;
    const steps = welcomeSteps(start, w?.fromF ?? st?.indoorF, target, t.backAt), pct = t.backAt ? Math.max(2, Math.min(100, (now - start) / Math.max(1, t.backAt - start) * 100)) : 50;
    return `<div class="vac"><div class="hh"><i></i><b>Getting the house ready</b><em>${target}° by ${esc(shortClock(t.backAt ?? now))}</em></div>
      <p>Cooling from <b>${w?.fromF != null ? Math.round(w.fromF) : '—'}°</b> since ${esc(clock(start))}${solar ? ' on spare solar (Powerwalls full)' : ''}. The pool ran its normal plan today.</p>
      <div class="hrow">${steps.map(s => `<span class="${s.done ? 't' : ''}">${esc(s.label)}<br>${esc(s.sub)}</span>`).join('')}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>${buttons('<button class="p" id="vacHome">I’m home</button><button id="vacDates">Running late</button>')}</div>`;
  }
  const quiet = (S.vacAlerts ?? []).filter(a => now - Date.parse(a.createdAt) < D), checked = st?.at ? ago(st.at) : null;
  const line = ask ? `<b>${esc(ask.title)}</b>. ${esc(ask.body.replace(/ Open Solstice to answer\.$/, ''))}`
    : quiet.length ? `${quiet.length === 1 ? 'One alert' : `${quiet.length} alerts`} today: ${esc(quiet[0].title)}.` : `All quiet.${checked ? ` Last check ${esc(checked)}.` : ''}`;
  const rt = S.ac?.runtime, pool = S.pool?.current, main = pool?.schedules?.[0], soc = S.live?.soc, grid = S.live?.gridKw ?? 0, est = S.vacEst?.est;
  const hm = m => `${String(Math.floor(m / 60) % 12 || 12)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''} ${Math.floor(m / 60) % 24 < 12 ? 'AM' : 'PM'}`;
  const tiles = [
    ['House', st?.indoorF != null ? `${Math.round(st.indoorF)}°<small> · ${st.humidity ?? '—'}%</small>` : '—', rt?.minutes ? `AC ran ${Math.floor(rt.minutes / 60)} h ${rt.minutes % 60} m today` : 'AC hasn’t needed to run today'],
    ['Pool', pool ? `${pool.hours} h<small> at ${(main?.rpm ?? 0).toLocaleString()}</small>` : '—', main ? `${hm(main.start)}–${hm(main.stop)}${S.pool?.live?.waterTemp != null ? ` · water ${Math.round(S.pool.live.waterTemp)}°` : ''}` : ''],
    ['Powerwalls', soc != null ? `${Math.round(soc)}%` : '—', grid < -.1 ? 'sending the rest to PEC' : (S.live?.batteryKw ?? 0) < -.1 ? 'charging' : 'covering the house'],
    ['Today so far', S.now?.today?.home != null ? `${(Math.round(S.now.today.home * 10) / 10)}<small> kWh</small>` : '—', est?.perDay?.empty != null ? `<span class="g">≈ ${k0(est.perDay.empty)} without Vacation mode</span>` : ''],
  ];
  return `<div class="vac"><div class="hh"><i></i><b>Vacation mode · ${esc(dayOfTrip(t.startedAt ?? t.leaveAt, t.backAt, now))}</b><em>${esc(backLabel(t.backAt, now))}</em></div>
    <p>${line}</p><div class="bar"><i style="width:${Math.round(tripProgress(t.startedAt ?? t.leaveAt, t.backAt, now) * 100)}%"></i></div>
    <div class="vmini">${tiles.map(([s, b, e]) => `<div><small>${s}</small><b>${b}</b><em>${e}</em></div>`).join('')}</div>
    ${ask ? buttons(`<button class="p" id="vacHome">I’m home</button><button data-ans="allowed" data-alert="${ask.id}">Someone’s allowed</button><button data-ans="unexpected" data-alert="${ask.id}">Not expected</button>`) : buttons()}</div>`;
}
function wireBanner(S) {
  const home = $('vacHome'), dates = $('vacDates');
  if (home) home.onclick = async () => { if (!confirm('End Vacation mode now?\n\nThe AC goes back to your comfort plan (2° every 30 minutes), the pool to its normal plan at the next evening run, and guest links come back in 24 h.')) return;
    home.textContent = 'Ending…'; await api.vacationEnd().catch(e => alert(e.message)); toast('✓', 'rgba(127,224,200,.22)', 'Welcome home', 'Vacation mode ended.'); reload(S); };
  if (dates) dates.onclick = () => openVacation(S);
  document.querySelectorAll('#vacNow [data-ans]').forEach(b => b.onclick = async () => {
    await api.vacationAnswer(b.dataset.ans).catch(e => alert(e.message)); await api.readAlert(b.dataset.alert).catch(() => {});
    toast('✓', 'rgba(127,224,200,.22)', b.dataset.ans === 'allowed' ? 'Noted: someone is allowed in today' : 'Noted', b.dataset.ans === 'allowed' ? 'Solstice won’t ask again today.' : 'Solstice keeps watching.'); reload(S);
  });
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

/* ======================= the sheet (frames 1, 1b and 2) ======================= */
const CHECK = [['waterHeater', 'Water heater', 'to its vacation setting · about 1.3 kWh a day while you’re away'], ['unplug', 'Unplug what can be', '· the house drops about 0.4 kW by itself when you leave']];
export async function openVacation(S, opts = {}) {
  const live = S.vac?.trip ?? null, edit = !!live, now = Date.now(), d = defaultDates(now);
  let leaveAt = live?.leaveAt ?? d.leaveAt, backAt = live ? live.backAt : opts.detected ? null : d.backAt;
  const tick = { ...(live?.data?.checklist ?? {}) }; let macHome = live?.data?.macHome ?? true, est = null, check = null, busy = false;
  const started = edit && live.state === 'active';
  $('sheetBody').innerHTML = `<div class="shead"><h4>Vacation mode</h4><button class="x" id="vaX" aria-label="Close">✕</button></div>
    <p class="sub">${opts.detected ? 'Nest has said Away and nothing at home has been used since. Set when you’re back, or leave it open.' : 'Solstice runs the AC, pool and Powerwalls for an empty house, watches over it, and has it ready when you’re back.'}</p>
    <div class="vd" id="vaDates"></div>
    ${started ? '' : '<div class="lab">Before you go</div><div class="chk" id="vaCheck"><div class="man"><span>Checking the pool and the thermostat…</span></div></div>'}
    ${started ? '' : `<div class="lab">Your checklist · things Solstice can’t switch</div><div class="chk" id="vaList"></div>`}
    <div class="lab">While you’re away</div><div class="vp" id="vaPlan"><div><span>Working out the estimate…</span></div></div>
    <div class="sum3" id="vaSum"></div><p class="fine2" id="vaTot"></p>
    <button class="go2" id="vaGo"></button>
    ${edit ? `<button class="link vaend" id="vaEnd">${started ? 'End Vacation mode' : 'Cancel this trip'}</button>` : opts.detected ? '<button class="link vaend" id="vaSnooze">I’m just out</button>' : ''}
    <p class="fine" style="text-align:center;margin-top:10px" id="vaFine"></p>`;
  const draw = () => {
    const leaveNow = leaveAt <= Date.now() + 5 * 60_000;
    $('vaDates').innerHTML = `<label class="${started ? 'off' : ''}"><small>Leaving</small><b>${leaveNow ? (started ? esc(dateLabel(live.startedAt ?? leaveAt)) : 'Now') : esc(dateLabel(leaveAt))}</b><span>${leaveNow && !started ? 'when you tap Start' : esc(clock(leaveAt))}</span>${started ? '' : `<input type="datetime-local" id="vaLeave" value="${localInput(leaveAt)}" min="${localInput(Date.now())}" max="${localInput(Date.now() + 60 * D)}" aria-label="Leaving">`}</label>
      <label class="on"><small>Back</small><b>${backAt ? esc(dateLabel(backAt)) : 'Not set'}</b><span>${backAt ? `about ${esc(clock(backAt))}` : 'tap to set'}</span><input type="datetime-local" id="vaBack" value="${backAt ? localInput(backAt) : ''}" min="${localInput(Math.max(Date.now(), leaveAt) + 3600_000)}" max="${localInput(leaveAt + 60 * D)}" aria-label="Back"></label>`;
    if ($('vaLeave')) $('vaLeave').onchange = e => { const v = pickedEpoch(e.target.value); if (v) { leaveAt = Math.max(v, Date.now()); if (backAt && backAt < leaveAt + 3600_000) backAt = leaveAt + 3 * D; draw(); estimate(); } };
    $('vaBack').onchange = e => { const v = pickedEpoch(e.target.value); backAt = v && v > leaveAt + 3600_000 ? v : backAt; draw(); estimate(); };
    if ($('vaList')) $('vaList').innerHTML = CHECK.map(([k, b, s]) => `<div class="man" data-tick="${k}"><span class="tick${tick[k] ? ' on' : ''}"></span><span><b>${b}</b> ${s}</span></div>`).join('') +
      `<div class="man"><span class="tick${tick.mac ? ' on' : ''}" data-tick="mac"></span><span><b>Mac</b> that runs the panel relay · staying home? <button class="yn${macHome ? ' on' : ''}" data-mac="1">Yes</button> · <button class="yn${macHome ? '' : ' on'}" data-mac="0">No</button></span></div>`;
    if ($('vaList')) $('vaList').onclick = e => { const m = e.target.closest('[data-mac]'); if (m) { macHome = m.dataset.mac === '1'; tick.mac = true; return draw(); } const t = e.target.closest('[data-tick]'); if (t) { tick[t.dataset.tick] = !tick[t.dataset.tick]; draw(); } };
    drawCheck(); drawPlan();
    const span = spanLabel(leaveNow ? Date.now() : leaveAt, backAt);
    $('vaGo').textContent = edit ? 'Save dates' : `Start Vacation mode · ${span}`;
    $('vaFine').textContent = edit ? (started ? 'The trip keeps running with the new arrival time.' : `Nothing changes until ${weekday(leaveAt, 'long')} ${clock(leaveAt)}.`)
      : leaveNow ? 'Starts now. You can change the dates or end it from the Now screen.' : `Nothing changes until ${weekday(leaveAt, 'long')} ${clock(leaveAt)}. You can change the dates or end it from the Now screen.`;
  };
  const drawCheck = () => {
    const box = $('vaCheck'); if (!box || !check) return;
    const rows = [], p = check.pool, n = check.nest;
    for (const o of p?.leftOn ?? []) rows.push(`<div class="on"><i>!</i><span><b>${esc(o.name)} is on</b>${o.kind === 'heat' ? ' · propane while it runs' : o.watts ? ` · ${o.watts.toLocaleString()} W, about ${o.kwhPerDay} kWh a day if it stays on` : ''}</span><button data-off="${o.id}">Turn off</button></div>`);
    if (p?.linked && !(p.leftOn ?? []).length) rows.push('<div class="ok"><i>✓</i><span><b>Spa, jets, blower, lights and spa heat are off</b></span></div>');
    if (p?.linked) rows.push(p.water ? `<div class="on"><i>!</i><span><b>Your last test said ${esc(p.water)}</b> · the trip plan waits until a clear test; the pool keeps its normal plan</span></div>`
      : p.clearUp ? '<div class="on"><i>!</i><span><b>A Clear-up is running</b> · the trip plan starts after it</span></div>' : '<div class="ok"><i>✓</i><span><b>Water looked clear</b> on your last test · no Clear-up running</span></div>');
    if (n) rows.push(n.autopilot === 'off' ? '<div class="on"><i>!</i><span><b>AC Autopilot is Off</b> · Vacation mode won’t change the thermostat</span></div>'
      : `<div class="ok"><i>✓</i><span><b>Thermostat linked</b> · ${n.eco ? 'Eco will be turned off so Solstice can hold ' : 'Solstice will hold '}${n.mode === 'HEAT' ? '55° heat' : '85°'}</span></div>`);
    box.innerHTML = rows.join('') || '<div class="man"><span>Nothing to check: the pool and thermostat aren’t linked.</span></div>';
    box.onclick = async e => { const b = e.target.closest('[data-off]'); if (!b || busy) return; busy = true; b.textContent = 'Turning off…';
      const id = +b.dataset.off;
      try { S.pool = await api.poolCommand(id === -1 ? { kind: 'spaHeat', on: false } : { kind: 'circuit', id, on: false }); check = await api.vacationCheck(); }
      catch (err) { toast('!', 'rgba(255,90,78,.25)', 'Not turned off', err.message); }
      busy = false; drawCheck(); };
  };
  const drawPlan = () => {
    const box = $('vaPlan'), n = check?.nest, heat = n?.mode === 'HEAT', back = backAt ? `${weekday(backAt)} ${shortClock(backAt)}` : 'you’re back';
    const guestsBack = backAt ? `${weekday(backAt + D)} ${shortClock(backAt + D)}` : 'a day after you’re back';
    const s = est?.saving, mode = m => m ? `<span class="mode">${esc({ off: 'Off', suggest: 'Suggest', auto: 'Auto' }[m] ?? m)}</span>` : '';
    const em = v => v != null && v > .05 ? `<em>${minus(v)}<small>kWh a day</small></em>` : '<em>—</em>';
    box.innerHTML = [
      ['#ff9e66', '❄', `<b>AC</b>${mode(n?.autopilot ?? S.ac?.settings?.autopilot)}<br>${heat ? 'Heat <b>55°</b> (Nest’s Eco is 50°); your setting comes back for your arrival.' : 'Hold <b>85°</b>. If humidity stays over 60% for 2 h, step down 2° at a time (never below 80°) until it’s under 55%.'}`, em(s?.acPerDay)],
      ['var(--home)', '≈', `<b>Pool</b>${mode(check?.pool?.autopilot ?? S.pool?.autopilot?.mode)}<br><b>${(S.pool?.live?.waterTemp ?? 0) >= 80 ? '1.5 turnovers' : '1 turnover'}</b> a day on the sunniest hours. No spare-solar speed-ups. +1 h skim after heavy rain.`, em(s?.poolPerDay)],
      ['var(--batt)', '▮', '<b>Powerwalls</b><br>Self-powered, solar-only export, 20% reserve. Storm rule raises the reserve <b>without waiting for you</b> on this trip, and lowers it again after.', '<em>—</em>'],
      ['#c4a2ff', '!', '<b>Alerts</b><br>Grid down, too hot or cold, damp, thermostat offline, pump not running, unexpected power use, someone at the thermostat. Water-test and panel reminders wait until you’re back.', '<em>—</em>'],
      ['rgba(242,244,248,.7)', '◐', `<b>Guest links</b><br>Paused until ${esc(guestsBack)}. Guests see the usual “turned off” card.`, '<em>—</em>'],
      ['var(--solar)', '☀', `<b>Welcome home</b><br>${backAt ? `Pool back on its normal plan ${esc(poolBackLabel(backAt))}. ` : ''}AC ${heat ? 'back to your heat setting' : `cools to <b>${S.ac?.settings?.dayF ?? 78}°</b>`} before ${esc(back)}, on solar when it can.`, '<em>—</em>'],
    ].map(([c, i, txt, e]) => `<div style="--c:${c}"><i>${i}</i><span>${txt}</span>${e}</div>`).join('');
    const p = est?.perDay;
    $('vaSum').innerHTML = p ? `<div><small>A day at home</small><b>${k0(p.home)}<small> kWh</small></b></div><div><small>Empty, no Vacation mode</small><b>${k0(p.empty)}<small> kWh</small></b></div><div class="hl"><small>With Vacation mode</small><b>${k0(p.vacation)}<small> kWh</small></b></div>` : '';
    $('vaTot').innerHTML = est ? `${est.open ? 'For a week away: about' : 'About'} ${k0(est.total.vacation)} kWh${est.open ? '' : ' for the trip'}${est.total.home != null ? ` instead of about ${k0(est.total.home)} at home` : ''}. Solstice’s own share is about ${k0(est.saving.totalKwh)} kWh (the AC and pool lines).${est.total.home != null ? ' The rest happens because nobody’s home.' : ''} Estimates.` : '';
  };
  let timer = null;
  const estimate = () => { clearTimeout(timer); timer = setTimeout(async () => { est = await api.vacationEstimate(Math.max(leaveAt, Date.now()), backAt).catch(() => null); drawPlan(); }, 250); };
  $('vaX').onclick = close;
  $('vaGo').onclick = async () => {
    if (busy) return; busy = true; const go = $('vaGo'); go.textContent = 'Saving…';
    try {
      if (edit) await api.vacationPatch(started ? { backAt } : { leaveAt, backAt });
      else await api.vacationStart({ leaveAt: leaveAt <= Date.now() + 5 * 60_000 ? Date.now() : leaveAt, backAt, detected: !!opts.detected, checklist: { waterHeater: !!tick.waterHeater, unplug: !!tick.unplug, mac: !!tick.mac }, macHome });
      close(); toast('✈', 'rgba(127,224,200,.22)', edit ? 'Dates saved' : 'Vacation mode is set', backAt ? `Back ${weekday(backAt)} ${shortClock(backAt)}` : 'Until you’re back');
      await reload(S);
    } catch (e) { alert(e.message); busy = false; draw(); }
  };
  if ($('vaEnd')) $('vaEnd').onclick = async () => { if (!confirm(started ? 'End Vacation mode now?' : 'Cancel this trip? Nothing has changed yet.')) return; await api.vacationEnd().catch(e => alert(e.message)); close(); reload(S); };
  if ($('vaSnooze')) $('vaSnooze').onclick = async () => { await api.vacationSnooze().catch(() => {}); close(); toast('✓', 'rgba(255,255,255,.12)', 'Got it', 'No more of those for 24 hours.'); };
  draw(); estimate();
  $('phone').classList.add('open');
  if (!started) { check = await api.vacationCheck().catch(() => null); drawCheck(); drawPlan(); }
}
