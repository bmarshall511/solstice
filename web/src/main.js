import './style.css';
import { $, localDate, localHour, addDays, toast, ago, niceDate, setSiteLocation } from './lib/util.js';
import { api, setUnauthorized } from './lib/api.js';
import { forecast, archive, nwsAlerts } from './lib/weather.js';
import { learnYield } from './lib/model.js';
import { createAurora } from './scenes/aurora.js';
import { createOrb } from './scenes/orb.js';
import { createLandscape } from './scenes/landscape.js';
import { createHomeView } from './scenes/home.js';
import { renderLive, renderStatic, renderWeather, freshness, initAhead, initPwDisc } from './views/now.js';
import { initNowTop, redrawNowTop } from './views/nowhub.js';
import { keyActivate, wireDisclosures, segSet } from './views/csheet.js';
import { route, fromInsights, fromQuery } from './lib/sysui.js';
import { showSeg, segKeys, drawSysHeader, drawHomeLive, drawRingLegend, drawSolarLive } from './views/systems.js';
import { initHistory, drawHistoryChart, landscapeData, drawSocHeat, drawRecords, drawOutages, drawBills, openBillSheet } from './views/history.js';
import { initPanels, drawPerformance, roofHud } from './views/panels.js';
import { drawAlerts, openPlanner, drawAC, drawOvernight, drawHealth, initOutage, initBreakdown, initSpare, initCapacity } from './views/insights.js';
import { initWater } from './views/water.js';
import { drawSettings, drawConnections, openRawData, applyAlertPrefs } from './views/settings.js';
import { every } from './lib/poll.js';
import { initAppliances, poolTwin, drawPool, freshPool, tickBoost, releasePoolTwin } from './views/appliances.js';
import { initAc, thermalTwin, drawAc, freshAc, releaseThermalTwin } from './views/ac.js';
import { initLearn } from './views/learn.js';
import { createDayRing } from './scenes/dayring.js';
import { explainOnTap } from './lib/frost.js';
import { fillGuestBill } from './views/guest.js';
import { initShare, applyRole, refreshSharing, showGate, markWelcome, pendingWelcome, ensurePreviewChrome } from './views/share.js';
import { loadDigest } from './views/digest.js';
import { mountPowerwallRules, loadPowerwallRules, drawPowerwallRules } from './views/powerwall.js';
import { initVacation } from './views/vacation.js';

/* Owner link (https://<app>/#owner=<OWNER_KEY>) or share link (https://<app>/#s=<token>): take the secret and strip it from
   the address bar before anything else in this module runs, so it never lingers in history or bookmarks. boot() trades it
   for the owner or guest cookie. */
let ownerLink = null, guestLink = null;
{ const m = /^#(owner|s)=([^&]+)/.exec(location.hash);
  if (m) { let v; try { v = decodeURIComponent(m[2]); } catch { v = m[2]; } if (m[1] === 'owner') ownerLink = v; else guestLink = v; history.replaceState(null, '', location.pathname + location.search); } }
// Pasting a link into a tab that already shows Solstice only changes the fragment: reload so the block above runs.
addEventListener('hashchange', () => { if (/^#(owner|s)=/.test(location.hash)) location.reload(); });

/** All app state lives here; views read from it. */
const S = { calm: matchMedia('(prefers-reduced-motion: reduce)').matches, preview: false, guest: false, asGuest: false, ownerName: 'The owner' };
const safe = fn => (...a) => { try { return fn(...a); } catch (e) { console.error(e); } };
const isOn = id => $(id).classList.contains('on');

/* ---------------- loading ---------------- */
async function loadNow() {
  try { S.now = await api.now(); S.nowOffline = false; } catch (e) { S.nowOffline = true; safe(freshness)(S); throw e; }   // mockup x: "Can't reach Solstice"
  api.day(localDate()).then(d => { S.today = d; safe(drawDayRing)(); }).catch(() => {});
  loadYesterday().catch(() => {});
  if (!S.live || (S.now.reading && S.now.reading.ts >= S.live.ts)) S.live = S.now.reading;
  updateOutage();
  safe(renderStatic)(S); safe(drawPowerwallRules)(S);
}
/** Yesterday's 5-minute day (/api/day), once per date: the Today tiles' "vs the same time yesterday" (mockup al frame 2). */
async function loadYesterday() {
  const date = addDays(localDate(), -1); if (S.yday?.date === date || S.ydayAsked === date) return;
  S.ydayAsked = date;
  try { S.yday = await api.day(date); safe(renderStatic)(S); } catch (e) { S.ydayAsked = null; throw e; }
}

async function loadHistory() {
  // each part on its own: one failing endpoint keeps its last good value instead of freezing every History view
  const keep = (p, prev) => p.then(v => v, e => { console.warn(e.message); if (prev === undefined) throw e; return prev; });
  const [daily, monthly, gridDays, records, outages, overnight, reconcile, profile] = await Promise.all([
    keep(api.daily(400), S.daily), keep(api.monthly(13), S.monthly), keep(api.gridDays(30), S.gridDays), keep(api.records(), S.records), keep(api.outages(), S.outages),
    keep(api.overnight(60), S.overnight), keep(api.reconcile(), S.reconcileRaw), keep(api.profile(14), S.profileRaw)]);
  S.reconcileRaw = reconcile; S.profileRaw = profile;
  Object.assign(S, { daily, monthly, gridDays, records, outages, overnight, reconcile: reconcile.map(b => billRow(b, daily)) });
  S.tariff = S.reconcile.findLast(r => r.tariff?.importRateAllIn > 0)?.tariff ?? null; // learned from the newest parsed bill (server: currentTariff); null = rate unknown
  S.profile = Array.from({ length: 24 }, (_, h) => profile.hours.find(x => x.hour === h)?.home ?? 2);
  S.fcConf = profile.conf ?? null;   // r-learning: the 48-hour forecast's confidence tiers
  S.profileScale = profile.scale ?? {};   // mockup ah: each day's home total from its forecast high
  S.fcCorrection = profile.correction ?? null;   // B2-2: the 48-hour road shows the forecast with its 30-day bias divided out
  computeModel();
  [drawSocHeat, drawRecords, drawOutages, drawBills, drawOvernight, drawAC, drawPerformance, drawAlerts, drawSettings, renderStatic, renderWeather].forEach(f => safe(f)(S));
  if (isOn('v-hist')) drawHistoryChart(S);
  const ld = landscapeData(S); if (ld) land.setData(ld);
  $('sideDays').textContent = `${daily.length} days`; $('sideBills').textContent = `${reconcile.length} bill${reconcile.length === 1 ? '' : 's'}`;
  drawBillDue();
}

/** A guest's bills arrive as a skeleton (month, period, kWh bought and sent, whether the meter matched Tesla). Give the bill
    views the owner's row shape with every private value null; the views draw a veil where the owner sees dollars. */
function billRow(b, daily) {
  if (b.pec) return b;
  return fillGuestBill({ billDate: `${b.month}-01`, period: b.period ?? { from: null, to: null, days: null }, total: null, tariff: null, charges: [],
    pec: { deliveredKwh: b.deliveredKwh, receivedKwh: b.receivedKwh, lastYearKwh: null },
    tesla: { days: 0, solarKwh: null, homeKwh: null, importKwh: null, exportKwh: null, chargeKwh: null, dischargeKwh: null }, lastYear: null,
    coverage: 1, importGapPct: null, checks: [{ id: 'meter', ok: !!b.checks?.meterMatchesTesla, label: 'Meter matches Tesla', detail: '' }],
    solarShareOfHome: null, withoutSolarCost: null }, daily);   // then Tesla's kWh for the same dates, from the guest's own history
}

/** Weather, NWS and the sun need the site's coordinates, which come with /api/settings at boot; ask again if that call failed. */
async function ensureLocation() { if (!S.location) S.location = setSiteLocation((await api.settings()).location); }

async function loadWeather() {
  await ensureLocation();
  const w = await forecast();
  S.wx = w;
  const today = localDate(), hourNow = localHour(), recent = {}, eff = {};
  // sunlight the panels would need at standard test conditions (25 °C cells) to make what they made: hot cells lose γ per °C
  const gamma = (S.now?.site?.solar?.tempCoefPctPerC ?? -.35) / 100;
  let soFar = 0; // sunlight on the panels so far today (radiation values describe the hour ending at t)
  w.hourly.time.forEach((t, i) => { const d = t.slice(0, 10), gw = w.hourly.global_tilted_irradiance[i] ?? 0, g = gw / 1000;
    recent[d] = (recent[d] ?? 0) + g;
    const tAir = ((w.hourly.temperature_2m[i] ?? 77) - 32) * 5 / 9, tCell = tAir + gw * (45 - 20) / 800; // NOCT ≈ 45 °C
    eff[d] = (eff[d] ?? 0) + g * (1 + gamma * (tCell - 25));
    const end = +t.slice(11, 13); if (d === today) soFar += g * Math.max(0, Math.min(1, hourNow - (end - 1))); });
  S.gtiByDate = { ...(S.gtiArchive ?? {}), ...recent };
  S.gtiEffByDate = eff;
  S.gtiToday = soFar;
  S.highs = { ...(S.highsArchive ?? {}), ...Object.fromEntries(w.daily.time.map((d, i) => [d, w.daily.temperature_2m_max[i]])) };
  computeModel();
  safe(renderWeather)(S); safe(renderStatic)(S); safe(drawDayRing)();
  [drawPerformance, drawAC, drawAlerts, drawSettings].forEach(f => safe(f)(S));
  const ld = landscapeData(S); if (ld) land.setData(ld);
}

/** A year of sunlight-on-panel and temperatures, for last year's baseline and the AC analysis. */
async function loadArchive() {
  await ensureLocation();
  const to = addDays(localDate(), -3), from = addDays(to, -420), a = await archive(from, to);
  const g = {}; a.hourly.time.forEach((t, i) => { const d = t.slice(0, 10); g[d] = (g[d] ?? 0) + (a.hourly.global_tilted_irradiance[i] ?? 0) / 1000; });
  S.gtiArchive = g;
  S.highsArchive = Object.fromEntries(a.daily.time.map((d, i) => [d, a.daily.temperature_2m_max[i]]));
  if (S.wx) await loadWeather(); else computeModel();
}

/** Learn how much the array makes per unit of sunlight: now (last 30 days) and a year ago (same season). */
function computeModel() {
  if (!S.daily || !S.gtiByDate && !S.gtiArchive) return;
  const gti = S.gtiByDate ?? S.gtiArchive, today = localDate();
  S.yieldK = learnYield(S.daily.filter(d => d.date >= addDays(today, -30) && d.date < today), gti);
  const yearAgo = addDays(today, -365), base = S.daily.filter(d => d.date >= addDays(yearAgo, -30) && d.date <= addDays(yearAgo, 30));
  S.baselineK = learnYield(base, gti) ?? S.yieldK;
  S.yieldStc = S.gtiEffByDate ? learnYield(S.daily.filter(d => d.date >= addDays(today, -30) && d.date < today), S.gtiEffByDate) : null; // temperature-corrected, for the warranty comparison
  const spec = S.now?.site?.solar;
  S.peakKw = Math.min(S.yieldK ?? 9, spec?.acKw ?? 9.45); // ≈ kW at 1000 W/m² on the panel plane, never above the microinverters' AC rating
  const clear = S.daily.filter(d => d.date < today && gti[d.date] > 4.5).slice(-7);
  S.perf = S.baselineK && clear.length >= 3 ? { loss: Math.max(0, 1 - clear.reduce((a, d) => a + d.solar / (S.baselineK * gti[d.date]), 0) / clear.length) } : null;
}

async function loadExternal() {
  const [ercot, nws, feed] = await Promise.allSettled([api.ercot(), nwsAlerts(), S.guest ? Promise.resolve(null) : api.alerts(30)]);
  if (ercot.status === 'fulfilled') S.ercot = ercot.value;
  if (nws.status === 'fulfilled') S.nws = nws.value;
  // mockup ab: the last week's grid alerts (down, Powerwalls low, back) show in the Insights list as well as on the phone
  if (feed.status === 'fulfilled' && feed.value) S.gridFeed = feed.value.alerts.filter(a => (a.kind === 'grid' || a.kind === 'gridLow') && Date.now() - Date.parse(a.createdAt) < 7 * 864e5);
  safe(renderStatic)(S); safe(drawAlerts)(S);
}

/* ---------------- outage detection ---------------- */
let wasOut = null;
function updateOutage() {
  const r = S.live, real = !!r && ((!!r.gridStatus && r.gridStatus !== 'Active') || /off_grid/.test(r.islandStatus ?? '')) || !!S.now?.outage?.active;   // an empty grid status is unknown, not an outage (gridwatch.ts isDown)
  S.outageActive = real || S.preview; S.realOutage = real;
  if (wasOut !== null && S.outageActive !== wasOut) {
    safe(redrawNowTop)(S);
    if (S.outageActive) { toast('⚡', 'rgba(255,90,78,.25)', S.preview ? 'Outage preview' : 'Grid outage detected', `${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · your Powerwalls took over`); go('v-now'); }
    else toast('✓', 'rgba(78,240,166,.2)', 'Grid restored', `Back on PEC. Your home never lost power.`);
  }
  wasOut = S.outageActive;
}

/** Outage preview: the house gets the islanded reading (nothing from PEC, the Powerwalls cover home − solar) so its four labels add up. */
const flowReading = r => S.preview && !S.realOutage ? { ...r, gridKw: 0, batteryKw: r.homeKw - r.solarKw } : r;

/* ---------------- the appliance twins: a WebGL context only while their card is on screen (like the Now twin) ---------------- */
function syncTwins() {
  const sys = isOn('v-sys');
  if (sys && sysSeg === 'pool') { if (!poolTwin() && S.pool) safe(drawPool)(S); } else releasePoolTwin();
  if (sys && sysSeg === 'ac') { if (!thermalTwin() && S.ac) safe(drawAc)(S); } else releaseThermalTwin();
}

/* ---------------- navigation: four tabs (mockup al), Systems' segments, and the old view ids as aliases ---------------- */
let sysSeg = 'home';
/** Open a tab (and, for Systems, a segment), optionally scrolled to a card. `go('v-ins', …)` / `go('v-roof')` still land (lib/sysui.js). */
function go(v, anchor, p) {
  const r = route(v, p ?? (v === 'v-sys' ? sysSeg : null), anchor);
  document.querySelectorAll('.c-tab').forEach(x => { const on = x.dataset.v === r.view; x.classList.toggle('on', on); if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === r.view));
  // the Now twin keeps a WebGL context only while Now is open: disposed on leaving, rebuilt (live framing) on return
  if (r.view === 'v-now') { house ??= createHomeView($('house'), 'flow', { onLink: openAppliance }); loadApplDay().catch(() => {}); } else if (house) { house.dispose(); house = null; S.twinReplay = false; }
  if (r.view === 'v-hist') { land.replay(); drawHistoryChart(S); }
  if (r.view === 'v-sys') setSeg(r.seg, false);
  setTimeout(syncTwins);   // next tick: the view is shown
  const sc = $('screen'), el = r.anchor && $(r.anchor);
  if (el) setTimeout(() => sc.scrollTo({ top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 50, behavior: 'smooth' }), 60); else sc.scrollTo({ top: 0 });
  if (r.planner) setTimeout(() => openPlanner(S), 120);
}
/** Systems: show a segment (its page, the pill, the header) and free or build the scenes that belong to it. */
function setSeg(seg, top = true) {
  sysSeg = S.sysSeg = showSeg(seg);
  setTimeout(syncTwins); setTimeout(() => { dayRing.resize(); poolTwin()?.resize(); thermalTwin()?.resize(); });
  safe(drawSysHeader)(S, sysSeg); safe(drawHomeLive)(S); safe(drawSolarLive)(S);
  if (top) $('screen').scrollTo({ top: 0 });
}
document.querySelectorAll('.c-tab[data-v]').forEach(t => t.onclick = () => go(t.dataset.v));
$('sysSeg').onclick = e => { const b = e.target.closest('[data-seg]'); if (b) setSeg(b.dataset.seg); };
segKeys($('sysSeg'), setSeg);
/** Links out of Now's sheets: a Systems segment, scrolled to a card. The old Insights form (panel, anchor, appliance) still works. */
S.nav = { go, sys: (seg, anchor) => go('v-sys', anchor, seg), insights: (panel, anchor, appl) => { const r = fromInsights(panel, anchor, appl); go('v-sys', r.anchor, r.seg); } };
S.redrawNow = () => safe(redrawNowTop)(S);
document.addEventListener('click', e => { const el = e.target.closest('[data-go]'); if (el) go(el.dataset.go, el.dataset.land ? 'landSect' : el.dataset.bills ? 'billSect' : null, el.dataset.p); });
const closeSheet = () => $('phone').classList.remove('open');
/* accessibility (October audit): every .sw toggle is a keyboard-reachable switch with its state announced, and the bottom sheet is a
   labelled dialog that takes focus when it opens. One observer keeps both right as views redraw. */
function a11y() {
  document.querySelectorAll('.sw').forEach(el => {
    if (!el.hasAttribute('role')) { el.setAttribute('role', 'switch'); el.tabIndex = 0; const t = el.closest('.row')?.querySelector('.rt'); if (t) el.setAttribute('aria-label', t.firstChild?.textContent?.trim() || t.textContent.trim()); }
    const on = String(el.classList.contains('on')); if (el.getAttribute('aria-checked') !== on) el.setAttribute('aria-checked', on);
  });
  const h = $('sheetBody').querySelector('h4'); if (h && $('sheet').getAttribute('aria-label') !== h.textContent) $('sheet').setAttribute('aria-label', h.textContent);
  $('sheet').classList.toggle('is-c', !!$('sheetBody').firstElementChild?.classList.contains('c-sbody'));   // mockup al: the component sheet's look and pinned footer
}
new MutationObserver(a11y).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.sw[role=switch]')) { e.preventDefault(); e.target.click(); } });
new MutationObserver(() => { if ($('phone').classList.contains('open')) setTimeout(() => $('sheetBody').querySelector('button,input,[tabindex]')?.focus({ preventScroll: true }), 50); })
  .observe($('phone'), { attributes: true, attributeFilter: ['class'] });
a11y();
['v-now', 'v-sys', 'v-hist', 'v-set', 'sheet'].forEach(id => keyActivate($(id)));
['v-sys', 'v-hist', 'v-set'].forEach(id => wireDisclosures($(id)));   // disclosure cards and their rows open in place   // role=button rows, disclosure headers and date cards answer Enter and Space
$('scrim').onclick = closeSheet;
document.addEventListener('click', e => { if (e.target.closest('[data-addbill]')) openBillSheet(S, () => loadHistory()); });
$('openData').onclick = openRawData;
addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); if (e.key === 'd' && !S.guest && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) openRawData(); });
/* Calm mode: the owner's is a setting; a guest's lives on the device (it cannot write settings). html[data-calm] stills the veils. */
const guestCalm = () => { try { const v = localStorage.getItem('solstice:calm'); return v == null ? null : v === '1'; } catch { return null; } };
const setCalm = on => { S.calm = on; $('calmSw').classList.toggle('on', on); document.documentElement.toggleAttribute('data-calm', on); };
setCalm(S.calm);
$('calmSw').onclick = () => { setCalm(!S.calm);
  if (S.guest && !S.asGuest) { try { localStorage.setItem('solstice:calm', S.calm ? '1' : '0'); } catch { /* storage off */ } } else api.saveSettings({ calm: S.calm }).catch(() => {}); };
$('signOut').onclick = async () => { await api.logout().catch(() => {}); location.reload(); };
$('outSw').onclick = () => { S.preview = !S.preview; S.previewSince = Date.now(); $('outSw').classList.toggle('on', S.preview); updateOutage(); renderLive(S); };

/* ---------------- scenes + loop ---------------- */
let house = createHomeView($('house'), 'flow', { onLink: openAppliance });
/** POOL / AC labels on the Now twin: that system's Systems page. A link only; it changes nothing. */
function openAppliance(id) { go('v-sys', null, id === 'ac' ? 'ac' : 'pool'); }
/** Today hour by hour for the Now twin (/api/appliances/day): at most every 5 minutes while Now is open, never on the 30-second loop. */
async function loadApplDay() {
  if (S.guest) return;   // owner-only route (no guest view in server/src/redact.ts): a guest's twin runs live-only, without a 401 a minute
  const date = localDate();
  if (S.applDayAt && Date.now() - S.applDayAt < 5 * 60_000 && S.applDay?.date === date) return;
  S.applDayAt = Date.now();
  try { S.applDay = await api.applDay(date); } catch (e) { S.applDayAt = 0; throw e; }
  safe(drawDayRing)();   // B2-7: the Day Ring's AC hours come from this day
}
const aurora = createAurora($('aurora')), orb = createOrb($('orb')), land = createLandscape($('land'), $('landTip')), roof = createHomeView($('roof'), 'sun');
initHistory(S); initPanels(S, roof);   // initAppliances / initAc start in boot(), once the role is known
const outage = initOutage(S);
mountPowerwallRules();   // t-enhancements: the Powerwall rules card, directly below Outage readiness
$('planRow').onclick = () => openPlanner(S);   // mockup al frame 9: "What if you added…" opens the Planner in a sheet

/* ---------------- Systems › Home: the Day Ring ---------------- */
const dayRing = createDayRing($('dayRing'), (h, d) => {
  const ro = $('drRead'); if (!d) return;
  const sum = a => a.reduce((x, y) => x + y, 0), bd = (p, a, r) => `<div class="bd"><span><i style="background:#6cc4ff"></i>${p}</span><span><i style="background:#ff9e66"></i>${a}</span><span><i style="background:#8d93a8"></i>${r}</span></div>`;
  // B2-7: today so far reads Tesla's home total (the parts are split out of it); the what-if modes read their parts' sum
  if (h == null) ro.innerHTML = `<b>${(Math.round((d.total ?? sum(d.rest) + sum(d.ac) + sum(d.pool)) * 10) / 10).toFixed(1)}</b><small>kWh ${d.label}</small>`;   // the parts are in the legend under the ring
  else ro.innerHTML = `<b>${(d.rest[h] + d.ac[h] + d.pool[h]).toFixed(1)} kWh</b><small>${h % 12 || 12}${h < 12 ? ' AM' : ' PM'} · solar ${d.solar[h].toFixed(1)} kWh</small>${bd(d.pool[h].toFixed(1), d.ac[h].toFixed(1), d.rest[h].toFixed(1))}`;
});
/** Settings › Connections and Data health follow the latest sync, pool and Nest reads (health waits for its first /api/status). */
const refreshStatus = () => { safe(drawConnections)(S); if ('status' in S) safe(drawHealth)(S, S.status); };
S.ringMode = 'now'; S.onPool = () => { safe(drawDayRing)(); refreshStatus(); S.redrawNow(); }; S.onAc = () => { safe(drawDayRing)(); refreshStatus(); S.redrawNow(); };
initNowTop(S); initAhead(S); initPwDisc();   // mockup al: the pills, banner slot, Autopilot hub, Ahead's 12 h | 48 h and the Powerwall disclosure
$('drModes').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; S.ringMode = b.dataset.m; segSet($('drModes'), b.dataset.m, 'data-m'); drawDayRing(); };
/**
 * Today's hourly loads (B2-7, audit L-13/L-14, O-11): the AC from Nest's cooling minutes × the learned kW (/api/appliances/day), the pool
 * from the schedule model for the hours so far only, the rest from Tesla's home load; in "now" mode the parts add up to Tesla's total.
 */
let ringDayAsked = 0;
function drawDayRing() {
  const day = S.today; if (!day || !day.buckets?.length) return;
  // the AC series comes from the owner-only appliance day; ask for it (at most once a minute) when the ring has none for today
  if (!S.guest && S.applDay?.date !== localDate() && Date.now() - ringDayAsked > 60_000) { ringDayAsked = Date.now(); loadApplDay().catch(() => {}); }   // it redraws the ring
  const home = Array(24).fill(0), solar = Array(24).fill(0);
  const per = 60 / (day.bucketMinutes ?? 5); // buckets per hour: kW ÷ 12 = kWh for five-minute buckets (a guest's day comes hourly)
  day.buckets.forEach(b => { const h = Math.floor(b.t); if (h < 24) { home[h] += b.home / per; solar[h] += b.solar / per; } });
  const p = S.pool, curve = p?.model?.curve, W = r => r && curve ? curve.reduce((a, c) => Math.abs(c.rpm - r) < Math.abs(a.rpm - r) ? c : a).watts : 0;
  const hourly = src => Array.from({ length: 24 }, (_, h) => src?.[h] ? (src[h].slices ? src[h].slices.reduce((a, r) => a + W(r) / 4, 0) : W(src[h].rpm) * src[h].frac) / 1000 : 0); // per 15-minute slice
  const extras = p?.extras?.hourlyToday ?? Array(24).fill(0);
  const hNow = localHour(), sofar = h => h < Math.floor(hNow) ? 1 : h === Math.floor(hNow) ? hNow % 1 : 0;   // the hours so far (this one in part)
  const A = S.applDay?.date === localDate() ? S.applDay : null;
  const ac = home.map((v, h) => Math.min(v, A?.hours?.[h]?.ac?.kwh ?? 0));   // Nest cooling minutes × the learned kW, never more than the hour's home load
  const poolNow = hourly(p?.current?.hourly).map((v, h) => Math.min(Math.max(0, home[h] - ac[h]), (v + extras[h]) * sofar(h)));
  const pool = S.ringMode === 'pool' ? hourly(p?.plan?.hourly).map((v, h) => v + extras[h]) : poolNow;
  const rest = home.map((v, h) => Math.max(0, v - ac[h] - poolNow[h])); // the house minus the AC and the pump's real share, whatever mode is shown
  const sol = S.ringMode === 'panels' ? solar.map(v => v * (1 + 8 * 400 / 9600)) : solar;
  const label = S.ringMode === 'now' ? 'today so far' : S.ringMode === 'pool' ? 'with the smarter pool schedule' : 'with 8 more panels';
  const tot = day.totals?.home ?? home.reduce((a, b) => a + b, 0), pk = pool.reduce((a, b) => a + b, 0);   // Tesla's home total, as Now and History show it
  dayRing.setData({ rest, ac, pool, solar: sol, label, total: S.ringMode === 'now' ? tot : null }); dayRing.setHour(localHour());
  const sum = a => a.reduce((x, y) => x + y, 0), pNow = sum(poolNow), aNow = sum(ac);
  drawRingLegend(S, { pool: pNow, ac: aNow, rest: Math.max(0, tot - pNow - aNow), acConf: A?.acConf ?? null });
  const acTxt = !A ? 'AC isn’t split out in this view'
    : A.acConf === 'measured' ? `AC is measured: Nest’s cooling minutes × the AC’s draw from Tesla’s load steps (${A.acKw.toFixed(1)} kW, confirmed by two independent checks)`
    : `AC is estimated: Nest’s cooling minutes × ${A.acKw.toFixed(1)} kW, a draw not yet confirmed by Tesla’s load steps`;
  $('drTxt').innerHTML = S.ringMode === 'now' ? (tot ? `The pool pump is about <b style="color:var(--text)">${Math.round(pk / tot * 100)}%</b> of today so far. ${acTxt}; everything else is what's left of Tesla's home load.` : 'Waiting for today’s data.')
    : S.ringMode === 'pool' ? `With the smarter schedule the pump moves under the solar curve and drops to about <b style="color:var(--text)">${Math.round(pk)} kWh</b> a day, so nights are just the house idling and the Powerwalls reach the evening fuller.`
    : `Eight more panels lift the gold ribbon by a third. Midday surplus covers more of the AC ramp, and the planner says the batteries would fill on far more days.`;
}

let HIDDEN = false; document.addEventListener('visibilitychange', () => HIDDEN = document.hidden);
let last = performance.now(), T = 0, hudTick = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (HIDDEN) return;
  T += dt * (S.calm ? .35 : 1);
  const r = S.live;
  if (r) aurora.set(r);
  aurora.render(T, S.outageActive);
  if (isOn('v-now') && r) orb.render({ soc: r.soc, batteryKw: r.batteryKw, solarKw: r.solarKw, peakKw: S.peakKw ?? 9, maxKw: S.now?.site?.maxPowerKw || 10, out: S.outageActive, dt, t: T });
  if (isOn('v-now') && r && house) {
    const i = S.wx ? S.wx.hourly.time.indexOf(`${localDate()}T${String(Math.floor(localHour())).padStart(2, '0')}:00`) : -1;
    S.twinReplay = house.render({ r: flowReading(r), cloud: i >= 0 ? S.wx.hourly.cloud_cover[i] / 100 : .1, code: i >= 0 ? S.wx.hourly.weather_code[i] : 0, out: S.outageActive, peakKw: S.peakKw ?? 9, dt, t: T, calm: S.calm,
      day: S.applDay, wx: S.wx, pool: S.pool, ac: S.ac, reservePct: S.now?.site?.reservePct })?.replaying ?? false;
  }
  if (isOn('v-hist')) land.render(dt, S.calm);
  const sys = isOn('v-sys');
  if (sys && sysSeg === 'home') dayRing.render(dt, S.calm);
  if (sys && sysSeg === 'pool') poolTwin()?.render(dt, S.calm);
  if (sys && sysSeg === 'ac') thermalTwin()?.render(dt, S.calm);
  if (sys && sysSeg === 'powerwall') outage.frame(dt, now);
  if (sys && sysSeg === 'solar') {
    const d = new Date(), dayStart = Date.parse(`${localDate(d)}T00:00:00${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'longOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value.replace('GMT', '') || 'Z'}`);
    hudTick += dt;
    const info = roof.render({ r, now: d, dayStart, cloud: S.roofWx?.cc ?? .1, code: S.roofWx?.code ?? 0, out: S.outageActive, peakKw: S.peakKw ?? 9, dt, t: T, calm: S.calm });
    if (hudTick > .5) { hudTick = 0; if (S.location) { S.roofWx = roofHud(S, info, d); roof.setHours(S.roofWx.hours); } roof.setDust(S.dust?.score); }
  }
}
requestAnimationFrame(frame);
setInterval(() => { if (document.hidden) return; safe(renderLive)(S); safe(sideSummary)(); safe(freshness)(S); safe(freshPool)(S); safe(tickBoost)(S); safe(freshAc)(S);
  if (isOn('v-sys')) { safe(drawSysHeader)(S, sysSeg); if (sysSeg === 'home') safe(drawHomeLive)(S); if (sysSeg === 'solar') safe(drawSolarLive)(S); } }, 1000);

function sideSummary() {
  const r = S.live; if (!r) return;
  $('sideSync').textContent = ago(r.ts);
  $('sideTitle').textContent = S.outageActive ? 'The grid is down. Your home isn’t.' : r.solarKw > .3 ? `${r.solarKw.toFixed(1)} kW of sunshine right now.` : `Home drawing ${r.homeKw.toFixed(1)} kW.`;
  $('sideText').innerHTML = `Powerwalls at <b>${Math.round(r.soc)}%</b>${r.batteryKw < -.05 ? `, charging ${(-r.batteryKw).toFixed(1)} kW` : r.batteryKw > .05 ? `, supplying ${r.batteryKw.toFixed(1)} kW` : ''}. ` +
    (r.gridKw > .05 ? `Buying ${r.gridKw.toFixed(1)} kW from PEC.` : r.gridKw < -.05 ? `Sending ${(-r.gridKw).toFixed(1)} kW to PEC.` : 'Nothing from PEC right now.');
}

/* ---------------- "your bill should be ready" prompt ---------------- */
function drawBillDue() {
  const last = S.reconcile?.at(-1); if (!last) return;
  const nextClose = addDays(last.period.to, 31), ready = addDays(nextClose, 2), today = localDate();
  const card = ready <= today
    ? `<div class="card due"><div class="h"><b>Your ${niceDate(nextClose, { month: 'long' })} PEC bill should be ready</b><span>${niceDate(last.period.to)} – ${niceDate(nextClose)}</span></div>
        <p>Download it from SmartHub or myPEC.com and add it. Solstice checks it against Tesla and updates your rates.</p><button class="link" data-addbill="1">+ Add the bill</button></div>` : '';
  $('billDue').innerHTML = card;
  // mockup al: on Now it is the banner slot's plain bill banner (owner only; no dollar figure)
  S.billDue = ready <= today && !S.guest ? { month: niceDate(nextClose, { month: 'long' }), period: `${niceDate(last.period.to)} – ${niceDate(nextClose)}` } : null; S.redrawNow();
  $('setBills').textContent = ready <= today ? `${niceDate(nextClose, { month: 'long' })} bill ready to add` : `Last: ${niceDate(last.billDate, { month: 'long' })} · next ~${niceDate(ready)}`;
}

/* ---------------- sign-in gate ---------------- */
function showAuth(mode, opts = {}) {
  $('auth').hidden = false; $('authErr').textContent = opts.error ?? '';
  const form = $('authForm'), connect = $('connectBtn');
  form.hidden = mode === 'connect'; connect.hidden = mode !== 'connect'; $('authNameRow').hidden = mode !== 'setup';
  $('authTitle').textContent = mode === 'setup' ? 'Create your Solstice account' : mode === 'connect' ? 'Connect your Tesla account' : 'Sign in to Solstice';
  $('authSub').textContent = mode === 'setup' ? 'This one-time link sets up the owner account. Your existing history, bills and Tesla connection will be attached to it.'
    : mode === 'connect' ? "Sign in with Tesla to give Solstice read-only access to your Powerwall and solar data. You'll approve it on Tesla's own page."
    : 'Your home’s energy, live.';
  $('authBtn').textContent = mode === 'setup' ? 'Create account' : 'Sign in';
  $('authPass').autocomplete = mode === 'setup' ? 'new-password' : 'current-password';
  form.onsubmit = async e => {
    e.preventDefault(); $('authErr').textContent = ''; $('authBtn').disabled = true;
    try {
      if (mode === 'setup') await api.setup(opts.token, $('authEmail').value, $('authPass').value, $('authName').value);
      else await api.login($('authEmail').value, $('authPass').value);
      history.replaceState(null, '', '/'); location.reload();
    } catch (err) { $('authErr').textContent = err.message; $('authBtn').disabled = false; }
  };
}
/* Single-owner mode without the owner cookie: every API call answers 401 and the app stays locked behind the "Solstice is
   private" card (paste a share link, or "I'm the owner" and the key); a link that was turned off or has expired gets its own
   card (views/share.js showGate, mockup q-share frame 6). */
let started = false, multi = false, unlocking = !!(ownerLink || guestLink), rechecking = false;
const lockOut = (reason, error = '') => (reason === 'revoked' || reason === 'expired' ? showGate('off', { reason }) : showGate('private', { error }));
// Any 401 locks the app in single-owner mode (while a link is being redeemed, boot() decides). A guest's 401 is either an
// owner-only route (nothing to do) or a link that was just revoked or expired: /api/auth/me says which. The owner previewing
// as a guest gets the same 401s for owner-only reads, and stays. MULTI_USER: as before.
setUnauthorized(() => {
  if (multi) { if (started) showAuth('login'); return; }
  if (unlocking || !started || S.asGuest) return;   // before boot() knows the role, it decides which card to show
  if (!S.guest) return lockOut();
  if (rechecking) return; rechecking = true;
  api.me().then(m => { if (m.owner) location.reload(); else if (!m.guest) lockOut(m.reason); }).catch(() => {}).finally(() => { rechecking = false; });
});

/* Guests (and the owner previewing as one) never see a control that writes: Apply, Restore, Autopilot modes, Home/Away,
   settings edits, bill upload and removal, cleaning logs, link/unlink, raw data and the CSV. The server refuses all of
   those to a guest anyway. The CSS block q-share hides them (and every [data-owner]) under html[data-role=guest] or
   html[data-as=guest], so views that re-render stay covered and the owner's own view returns when a preview ends. */
/** Every view's data again, as the role now stands (the Frost wipe waits for the main reads). */
async function reloadAll() {
  const prefs = await api.settings().catch(() => null);
  if (prefs) S.location = setSiteLocation(prefs.location);
  initAppliances(S); initAc(S);
  initLearn(S);
  await Promise.allSettled([loadNow(), loadHistory(), loadExternal(), loadWeather()]);
  if (isOn('v-hist')) safe(drawHistoryChart)(S);
}
initShare(S, { reload: reloadAll });
explainOnTap(toast, () => S.ownerName);

async function boot() {
  const params = new URLSearchParams(location.search);
  // the server sends fixed codes only (never upstream text); each maps to one sentence here
  const OAUTH_ERR = { expired: 'Sign-in expired. Try again.', denied: 'Access was not granted. Try again and allow access.', failed: 'Something went wrong. Try again.',
    othersite: 'That Tesla account doesn\u2019t have this home\u2019s Powerwalls. Nothing was changed; sign in with the account that owns them.' };
  if (params.get('tesla_error')) toast('!', 'rgba(255,90,78,.25)', 'Tesla connection failed', OAUTH_ERR[params.get('tesla_error')] ?? OAUTH_ERR.failed);
  if (params.get('nest_error')) toast('!', 'rgba(255,90,78,.25)', 'Nest link failed', OAUTH_ERR[params.get('nest_error')] ?? OAUTH_ERR.failed);
  if (params.has('tesla_error') || params.has('nest_error') || params.has('nest')) history.replaceState(null, '', location.pathname + location.hash);   // a reload doesn't toast again
  if (params.get('nest') === 'linked') toast('✓', 'rgba(78,240,166,.2)', 'Nest linked', 'Solstice can now see the thermostat. Open Systems › AC.');
  if (ownerLink) {   // first open of the owner link on this device: trade the key for the owner cookie
    const ok = await api.owner(ownerLink).then(() => true, () => false);
    unlocking = false;
    // Views that loaded while this device had no cookie got 401s; reload once so everything starts with the cookie.
    if (ok) return location.reload();
  }
  let guestLinkError = null;
  if (guestLink) {   // a share link opened on this device: trade the token for the guest cookie, then start clean
    const err = await api.guest(guestLink).then(() => null, e => e);
    unlocking = false;
    if (!err) { await markWelcome(guestLink); return location.reload(); }   // the welcome card shows after the reload, once
    guestLinkError = err;
  }
  let me;
  try { me = await api.me(); } catch { $('authErr').textContent = 'Can’t reach the Solstice server.'; return showAuth('login'); }
  multi = me.mode !== 'single';
  if (me.mode === 'single') {           // no accounts: the owner cookie opens straight to the connected site
    document.querySelectorAll('.acct').forEach(el => el.hidden = true);
    if (me.guest) applyRole({ guest: true, preview: !!me.preview, ownerName: me.ownerName, expiresAt: me.expiresAt ?? null });   // read-only, no controls
    else {
      if (!me.owner) return guestLinkError ? lockOut(guestLinkError.reason, 'That link didn’t work on this device.')
        : lockOut(me.reason, ownerLink ? 'That owner link didn’t work on this device.' : '');
      if (!me.site) return showAuth('connect');
    }
  } else {
    if (!me.user) return me.needsSetup && params.get('setup') ? showAuth('setup', { token: params.get('setup') }) : showAuth('login');
    $('acctEmail').textContent = me.user.email;
    if (!me.site) return showAuth('connect');
  }
  started = true;
  const prefs = await api.settings().catch(() => ({}));
  if (!S.guest) applyAlertPrefs(prefs.alerts);
  initAppliances(S); initAc(S); initBreakdown(S, every); initSpare(S, every); initCapacity(S, every); initWater(S, every);   // mockup aj   // after the role is known: a locked device no longer sends a 401 every 3 minutes
  S.location = setSiteLocation(prefs.location);  // exact coordinates + ZIP from the server env; weather, NWS and the sun wait for them
  if (typeof prefs.calm === 'boolean') S.calm = prefs.calm;
  else if (S.guest && !S.asGuest) { const c = guestCalm(); if (c != null) S.calm = c; }   // a guest keeps Calm mode on this device
  setCalm(S.calm);
  if (!S.guest) { S.ownerName = typeof prefs.ownerName === 'string' && prefs.ownerName.trim() ? prefs.ownerName.trim() : 'The owner'; refreshSharing(); }
  if (S.asGuest) { ensurePreviewChrome(); applyRole({ guest: true, preview: true, ownerName: S.ownerName }); }   // a preview survives a reload (the server's flag lasts an hour)
  S.onModels = () => { safe(renderWeather)(S); if (S.pool) safe(drawPool)(S); safe(drawAC)(S); };   // B2-8: drawAC's heating sentence reads the home model
  initLearn(S);   // r-learning: the model report (owner only) and its badge text
  const welcome = S.guest && !S.asGuest ? pendingWelcome() : null;
  if (welcome) showGate('welcome', { welcomeKey: welcome });
  every(30_000, loadNow);                 // live status (the server asks Tesla at most every ~25 s)
  every(5 * 60_000, loadHistory);
  every(15 * 60_000, loadWeather);
  every(5 * 60_000, loadExternal);
  every(60_000, () => isOn('v-now') ? loadApplDay() : Promise.resolve());   // the Now twin's day (self-limited to every 5 min)
  if (!S.guest) { every(5 * 60_000, () => loadDigest(S)); every(5 * 60_000, () => loadPowerwallRules(S)); }   // t-enhancements (owner-only routes)
  if (!S.guest && !S.asGuest) initVacation(S, every);   // mockup ak: the Vacation chip, banner, sheet and report (owner-only routes)
  // a tapped push opens /?go=<view>[&p=<segment>] (web/public/sw.js); the old v-ins / v-roof links land on their Systems segment
  const dl = fromQuery(params);
  if (dl) { go(dl.view, dl.anchor, dl.seg); history.replaceState(null, '', location.pathname); }
  loadArchive().catch(e => console.warn('archive', e.message));
  // keep history current: sync now, then every 5 min while open; keep going while there are missing days to backfill
  // one task, so a slow sync and the next 5-minute run can't overlap (the backfill keeps going inside the task while days remain)
  const sync = async () => { for (;;) {
    const r = await api.sync().catch(() => null); if (r?.filled || r?.done?.includes('lastHistory')) loadHistory().catch(() => {});
    S.syncInfo = r; $('sideDays').textContent = r?.remaining ? `loading… ${r.remaining} days left` : $('sideDays').textContent; refreshStatus();
    if (!(r?.remaining > 0)) return; await new Promise(res => setTimeout(res, 1500)); } };
  if (!S.guest) every(5 * 60_000, sync); // syncing is a write: the owner's device keeps history current
  every(60_000, async () => { const s = await api.status().catch(() => null); S.status = s; safe(drawHealth)(S, s); });
}
boot();

// PWA: offline shell + home-screen install
if ('serviceWorker' in navigator && !import.meta.env.DEV) navigator.serviceWorker.register('/sw.js').catch(() => {});
