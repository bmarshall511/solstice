// Systems (approved mockup mockups/al-ia.html v2, frames 9–13b): the header (title, one line for the open system, its live key
// figure), the segment row Home · Solar · Powerwall · Pool · AC, and each page's Live card. Pages follow one skeleton: Live →
// Controls → Autopilot → analysis. The cards below the Live card are drawn by the modules that always drew them (insights.js,
// panels.js, powerwall.js, appliances.js, ac.js); this file only reads S and writes markup. Nothing here writes to a device.
import { $, clamp, localDate, localHour, addDays } from '../lib/util.js';
import { cBadge } from '../lib/conf.js';
import { SEGS, SEG_IDS, segIndex, k1 } from '../lib/sysui.js';
import { nowPct, scheduleBlocks, acBlocks, hourBlocks, tileDelta, sumUntil } from '../lib/nowui.js';
import { sysTop, planStrip, tileHtml, modePill } from './csheet.js';

const set = (id, prop, v) => { const el = $(id); if (el && el[prop] !== v) el[prop] = v; };
const same = (id, html) => { const el = $(id); if (el && el.dataset.k !== html) { el.dataset.k = html; el.innerHTML = html; } };

/* ======================= the segment row ======================= */
/** Show one segment's page: the pill slides, the row takes the system's accent, the pages swap. Returns the segment shown. */
export function showSeg(seg) {
  const id = SEG_IDS.includes(seg) ? seg : 'home', row = $('sysSeg'), def = SEGS.find(s => s.id === id);
  row.style.setProperty('--i', segIndex(id));
  SEGS.forEach(s => row.classList.toggle(s.acc, s.id === id));
  row.querySelectorAll('[data-seg]').forEach(b => { const on = b.dataset.seg === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  document.querySelectorAll('.sys-page').forEach(p => { const on = p.id === `sp-${id}`; p.hidden = !on; p.classList.toggle('on', on); });
  row.querySelector('.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return def.id;
}
/** Arrow keys move along the segment row (it is a tablist). */
export function segKeys(row, go) {
  row.addEventListener('keydown', e => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return;
    const i = (SEG_IDS.indexOf(row.querySelector('.on')?.dataset.seg) + d + SEG_IDS.length) % SEG_IDS.length;
    e.preventDefault(); go(SEG_IDS[i]); row.querySelector(`[data-seg="${SEG_IDS[i]}"]`)?.focus();
  });
}

/* ======================= the header (every second) ======================= */
export function drawSysHeader(S, seg) {
  const r = S.live, site = S.now?.site ?? {}, sp = site.solar, today = S.now?.today ?? {}, p = S.pool, a = S.ac;
  let sub = '', fig = '—', lab = '';
  if (seg === 'home') { sub = 'Home · today so far'; fig = k1(today.home); lab = 'kWh today'; }
  else if (seg === 'solar') { sub = sp ? `Solar · ${sp.panels} × ${sp.panelWdc} W · ${sp.dcKw} kW DC` : 'Solar'; fig = r ? r.solarKw.toFixed(1) : '—'; lab = 'kW right now'; }
  else if (seg === 'powerwall') { const n = site.batteries?.length ?? site.batteryCount ?? 2; sub = `Powerwall · ${n} units · ${site.capacityKwh ?? '—'} kWh · ${site.maxPowerKw ?? '—'} kW`; fig = r ? `${Math.round(r.soc)}%` : '—'; lab = 'charge'; }
  else if (seg === 'pool') { const L = p?.live, t = p?.snapshot?.bodies?.[0]?.temp; sub = !p ? 'Pool' : !(p.linked || L) ? 'Pool · not linked' : `Pool · ${t != null ? `${t}° · ` : ''}pump ${L?.running ? 'running' : 'off'}`; fig = L?.running ? String(Math.round(L.watts)) : p && (p.linked || L) ? 'off' : '—'; lab = 'W pump'; }
  else if (seg === 'ac') { const st = a?.state; sub = !a ? 'AC' : !a.linked || !st ? 'AC · Nest not linked' : `AC · inside ${st.indoorF ?? '—'}° · ${String(st.hvac ?? 'off').toLowerCase() === 'off' ? 'idle' : String(st.hvac).toLowerCase()}`; fig = a?.todayKwh != null ? k1(a.todayKwh) : '—'; lab = 'kWh today'; }
  set('sysSub', 'textContent', sub);
  const f = $('sysFig'); if (f) { const b = f.querySelector('b'); if (b.textContent !== fig || b.firstElementChild) b.textContent = fig; }
  set('sysFigL', 'textContent', lab);
  const dot = $('syncDot'), mine = $('sysSync'); if (dot && mine && mine.style.background !== dot.style.background) mine.style.background = dot.style.background;
}

/* ======================= Home (frame 9) ======================= */
/** The Home system card: presence (owner only), live use, the share from solar + battery, pool (top) and AC (bottom) on the strip. */
export function drawHomeLive(S) {
  const r = S.live; if (!r) return;
  const pr = S.ac?.presence, away = pr?.state === 'away', nowP = nowPct(localHour());
  const share = r.homeKw > .05 ? Math.round(clamp(1 - Math.max(0, r.gridKw) / r.homeKw, 0, 1) * 100) : null;
  const bid = S.pool?.settings?.boostCircuit ?? 8;
  const pool = scheduleBlocks(S.pool?.current?.schedules, bid).map(b => ({ ...b, cls: b.cls === 'alt' ? 'top c-acc-pool' : 'lo top c-acc-pool' }));
  const ac = S.ac?.linked && S.ac.settings?.autopilot !== 'off' ? acBlocks(S.ac.plan?.steps, S.ac.settings?.nightFrom, S.ac.settings?.nightTo).blocks.filter(b => !b.cls).map(b => ({ ...b, cls: 'lo bot c-acc-ac' })) : [];
  same('homeSys', sysTop({ ic: 'home', title: 'Home', mode: S.guest || !pr ? '' : modePill(away ? 'away' : 'home'), value: `${r.homeKw.toFixed(1)} kW`,
    line: `Using ${r.homeKw.toFixed(1)} kW${share != null ? ` · ${share}% from solar + battery` : ''}`, plan: planStrip(nowP, [...pool, ...ac]) }));
}
/** The Day Ring's legend: pool, AC (with how each is known) and everything else, today so far (main.js drawDayRing). */
export function drawRingLegend(S, { pool, ac, rest, acConf }) {
  const f = v => `<b>${k1(v)}</b>`;
  same('drLeg', `<span class="c-acc-pool"><i></i>Pool ${f(pool)} ${cBadge('estimated')}</span><span class="c-acc-ac"><i></i>AC ${f(ac)} ${acConf ? cBadge(acConf) : ''}</span><span class="c-acc-mute"><i></i>Everything else ${f(rest)}</span>`);
}

/* ======================= Solar (frame 10) ======================= */
/** The Solar system card (today's production window: solid so far, dashed forecast) and the two tiles. */
export function drawSolarLive(S) {
  const r = S.live; if (!r) return;
  const today = localDate(), h = localHour(), info = S.roofInfo, ss = info?.ss;
  const past = Array(24).fill(false), fut = Array(24).fill(false);
  for (const b of S.today?.buckets ?? []) { const hh = Math.floor(b.t); if (hh < 24 && hh < Math.floor(h) && b.solar > .05) past[hh] = true; }
  if (S.wx) S.wx.hourly.time.forEach((t, i) => { if (!t.startsWith(today)) return; const hh = +t.slice(11, 13); if (hh >= Math.floor(h) && (S.wx.hourly.global_tilted_irradiance[i] ?? 0) > 20) fut[hh] = true; });
  const line = !info ? 'output right now' : info.el > 0 ? `${ss ? `${ss.pct}% of what the sun says · ` : ''}sun ${Math.round(info.el)}° up` : 'sun down';
  same('solarSys', sysTop({ ic: 'sun', title: 'Solar', value: `${r.solarKw.toFixed(1)} kW`, line, plan: planStrip(nowPct(h), [...hourBlocks(past, ''), ...hourBlocks(fut, 'est')], [], true) }));
  drawSolarTiles(S);
}
function drawSolarTiles(S) {
  const t = S.now?.today; if (!t) return;
  const now = localDate(), y = S.yday?.date === addDays(now, -1) ? sumUntil(S.yday, localHour()) : null, K = S.yieldK, gti = S.gtiByDate ?? {};
  const week = (S.daily ?? []).filter(d => d.date < now).slice(-7);
  const pct = K && S.gtiToday > .2 ? Math.round(t.solar / (K * S.gtiToday) * 100) : null;
  const ratios = week.map(d => K && gti[d.date] > .5 ? Math.round(d.solar / (K * gti[d.date]) * 100) : null);
  const yPct = ratios.at(-1), dp = pct != null && yPct != null ? pct - yPct : null;
  same('solarTiles', tileHtml({ id: 'stSol', acc: 'c-acc-solar', k: 'Produced today', v: k1(t.solar), unit: 'kWh', chip: tileDelta(t.solar, y?.solar ?? null, 'up'), spark: week.map(d => d.solar) })
    + tileHtml({ id: 'stSun', acc: 'c-acc-solar', k: 'Of today’s sun', v: pct ?? '—', unit: pct != null ? '%' : '', note: pct == null ? 'waiting for the weather' : '',
      chip: dp == null ? null : dp === 0 ? { t: 'flat', text: '— same' } : { t: dp > 0 ? 'good' : 'bad', text: `${dp > 0 ? '▲' : '▼'} ${Math.abs(dp)} pts` }, spark: ratios }));
}

