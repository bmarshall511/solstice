// Now: the Monday "Your week" card between the status chips and the orb (approved mockup mockups/t-enhancements.html frame 1).
// Shown while the digest alert for the last complete week is unread; ✕ marks it read. Owner-only: a guest never loads it.
import { $, niceDate, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc } from '../lib/conf.js';
import { weekLabel, prevWeekDate, leadHtml, gridCells, gridHtml, autopilotLines, rulesMode, anomalyHtml, badgesHtml, kwh0 } from '../lib/digest.js';
import { detectPush, subscribePush, deviceName } from '../lib/push.js';

let cur = null, prev = null, showing = 'cur', alertId = null;

const apHtml = lines => lines.map(([i, c, b, t]) => `<div style="--c:${c}"><i>${i}</i><span><b>${esc(b)}</b> ${esc(t)}</span></div>`).join('');
const modes = S => ({ pool: S.pool?.autopilot?.mode, ac: S.ac?.settings?.autopilot, powerwall: S.pwRules ? rulesMode(Object.fromEntries(S.pwRules.rules.map(r => [r.id, r.mode]))) : null });

function draw(S) {
  const box = $('digestNow'), d = showing === 'cur' ? cur : prev; if (!box || !d) return;
  const vs = showing === 'cur' ? 'last wk' : `wk ${+String(d.week).split('-W')[1] - 1}`, anom = anomalyHtml(d);
  box.innerHTML = `<div class="card dg" id="digest">
      <div class="h"><b>Your week</b><span style="display:flex;align-items:center;gap:8px"><span class="badge g">new</span><button class="x" id="dgX" aria-label="Dismiss until next Monday">✕</button></span></div>
      <div class="wk">${weekLabel(d)}</div>
      <p class="lead">${leadHtml(d)}</p>
      <div class="share"><i style="width:${d.totals?.sunsharePct ?? 0}%"></i></div>
      <div class="sharel"><span>sunshine (solar + Powerwall)</span><span>PEC</span></div>
      <div class="g4">${gridHtml(gridCells(d, vs))}</div>
      <div class="sect" style="margin:16px 2px 4px;font-size:11px">What the Autopilots did</div>
      <div class="ap">${apHtml(autopilotLines(d, modes(S)))}</div>
      ${anom ? `<div class="anom">${anom}</div>` : ''}
      <div class="badges">${badgesHtml(d, S.models)}</div>
      <div class="foot"><button class="link" id="dgPrev">${showing === 'cur' ? '‹ See last week' : 'This week ›'}</button><button class="link" id="dgFull">Full week ›</button></div>
      <div class="permrow" id="permRow" hidden>
        <div class="ri">✉</div>
        <div class="rt">Get this on your lock screen<small id="permTxt">Every Monday at 7 AM, plus storm prep and approvals. You choose which in Settings › Alerts.</small></div>
        <button class="link" id="permBtn">Turn on</button>
      </div>
    </div>`;
  $('dgX').onclick = async () => { box.innerHTML = ''; if (alertId != null) await api.readAlert(alertId).catch(() => {}); };
  $('dgPrev').onclick = async () => {
    if (showing === 'cur' && !prev) prev = await api.digest(prevWeekDate(cur)).catch(e => { toast('!', 'rgba(255,90,78,.25)', 'Couldn’t load last week', e.message); return null; });
    if (showing === 'cur' && !prev) return;
    showing = showing === 'cur' ? 'prev' : 'cur'; draw(S);
  };
  $('dgFull').onclick = () => openWeek(d);
  drawPermRow();
}

/** "Get this on your lock screen · Turn on", only while push is off on this device. */
async function drawPermRow() {
  const row = $('permRow'); if (!row) return;
  const { state } = await detectPush().catch(() => ({ state: 'unsupported' }));
  row.hidden = state === 'on';
  $('permBtn').onclick = async () => {
    const btn = $('permBtn'); if (btn.textContent === 'Done') { row.hidden = true; return; }
    btn.textContent = 'Turning on…';
    try { await subscribePush(); $('permTxt').textContent = `On for ${deviceName(navigator.userAgent)}. Change which alerts push in Settings › Alerts.`; btn.textContent = 'Done'; }
    catch (e) { $('permTxt').textContent = e.message; btn.textContent = 'Turn on'; }
  };
}

/** "Full week": everything the digest holds, in the sheet. */
function openWeek(d) {
  const a = d.autopilot ?? {}, t = d.totals ?? {}, pw = d.powerwall ?? {};
  const lines = [...(a.pool?.lines ?? []).map(l => ['Pool', l]), ...(a.ac?.lines ?? []).map(l => ['AC', l])];
  $('sheetBody').innerHTML = `<div class="shead"><h4>Your week</h4><button class="x" id="dgClose" aria-label="Close">✕</button></div>
    <p class="sub">${weekLabel(d)}${d.partial ? ' · so far' : ''}</p>
    <div class="dg"><div class="g4">${gridHtml(gridCells(d))}</div>
      <div class="kv" style="margin-top:12px">
        <span>From sunshine</span><b>${t.sunsharePct ?? '—'}%</b>
        <span>Best solar day</span><b>${d.bestSolarDay ? `${niceDate(d.bestSolarDay.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${kwh0(d.bestSolarDay.kwh)} kWh` : '—'}</b>
        <span>Powerwalls full</span><b>${pw.daysWithData ? `${pw.fullDays} of ${pw.daysWithData} days` : '—'}</b>
        <span>Lowest charge</span><b>${pw.lowestPct != null ? `${pw.lowestPct}%` : '—'}</b>
      </div>
      ${lines.length ? `<div class="sect" style="margin:16px 2px 4px;font-size:11px">Autopilot log</div><div class="tline">${lines.map(([w, l]) => `<div><i></i><span>${w}</span><p>${esc(l)}</p></div>`).join('')}</div>` : ''}
      ${d.anomalies?.items?.length ? `<div class="sect" style="margin:16px 2px 4px;font-size:11px">Worth a look</div><div class="tline">${d.anomalies.items.map(x => `<div><i class="w"></i><span>${niceDate(x.day)}</span><p>${esc(x.title)}</p></div>`).join('')}</div>` : ''}
    </div>`;
  $('dgClose').onclick = () => $('phone').classList.remove('open');
  $('phone').classList.add('open');
}

/** Load the week and decide whether the card shows (every few minutes from main.js; a guest never calls it). */
export async function loadDigest(S) {
  if (S.guest || !$('digestNow')) return;
  const [d, feed] = await Promise.all([api.digest(), api.alerts(30)]);
  const alert = feed.alerts.find(x => x.kind === 'digest' && x.data?.week === d.week && !x.readAt);
  if (!alert) { cur = prev = null; alertId = null; $('digestNow').innerHTML = ''; return; }
  if (cur?.week !== d.week) { prev = null; showing = 'cur'; }
  cur = d; alertId = alert.id;
  if (!S.pwRules) S.pwRules = await api.pwRules().catch(() => null);
  draw(S);
}
