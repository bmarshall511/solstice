import './style.css';
import { $, localDate, localHour, addDays, toast, fmtDur, ago, niceDate, setSiteLocation } from './lib/util.js';
import { api, setUnauthorized } from './lib/api.js';
import { forecast, archive, nwsAlerts } from './lib/weather.js';
import { learnYield } from './lib/model.js';
import { createAurora } from './scenes/aurora.js';
import { createOrb } from './scenes/orb.js';
import { createLandscape } from './scenes/landscape.js';
import { createHomeView } from './scenes/home.js';
import { buildFlow, renderLive, renderStatic, renderWeather } from './views/now.js';
import { initHistory, drawHistoryChart, landscapeData, drawSocHeat, drawRecords, drawOutages, drawBills, openBillSheet } from './views/history.js';
import { initPanels, drawPerformance, roofHud } from './views/panels.js';
import { drawAlerts, initPlanner, drawAC, drawOvernight, drawHealth } from './views/insights.js';
import { drawSettings, openRawData } from './views/settings.js';
import { initAppliances, poolTwin } from './views/appliances.js';
import { initAc, thermalTwin, drawAc } from './views/ac.js';
import { createDayRing } from './scenes/dayring.js';

/** All app state lives here; views read from it. */
const S = { calm: matchMedia('(prefers-reduced-motion: reduce)').matches, preview: false };
const safe = fn => (...a) => { try { return fn(...a); } catch (e) { console.error(e); } };
const isOn = id => $(id).classList.contains('on');

/* ---------------- loading ---------------- */
async function loadNow() {
  S.now = await api.now();
  api.day(localDate()).then(d => { S.today = d; safe(drawDayRing)(); }).catch(() => {});
  if (!S.live || (S.now.reading && S.now.reading.ts >= S.live.ts)) S.live = S.now.reading;
  updateOutage();
  safe(renderStatic)(S);
}

async function loadHistory() {
  const [daily, monthly, gridDays, records, outages, overnight, reconcile, profile] = await Promise.all([
    api.daily(400), api.monthly(13), api.gridDays(30), api.records(), api.outages(), api.overnight(60), api.reconcile(), api.profile(14)]);
  Object.assign(S, { daily, monthly, gridDays, records, outages, overnight, reconcile });
  S.tariff = reconcile.at(-1)?.tariff ?? null;
  S.profile = Array.from({ length: 24 }, (_, h) => profile.hours.find(x => x.hour === h)?.home ?? 2);
  computeModel();
  [drawSocHeat, drawRecords, drawOutages, drawBills, drawOvernight, drawAC, drawPerformance, drawAlerts, drawSettings, renderStatic, renderWeather].forEach(f => safe(f)(S));
  if (isOn('v-hist')) drawHistoryChart(S);
  const ld = landscapeData(S); if (ld) land.setData(ld);
  $('sideDays').textContent = `${daily.length} days`; $('sideBills').textContent = `${reconcile.length} bill${reconcile.length === 1 ? '' : 's'}`;
  drawBillDue();
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
  const [ercot, nws] = await Promise.allSettled([api.ercot(), nwsAlerts()]);
  if (ercot.status === 'fulfilled') S.ercot = ercot.value;
  if (nws.status === 'fulfilled') S.nws = nws.value;
  safe(renderStatic)(S); safe(drawAlerts)(S);
}

/* ---------------- outage detection ---------------- */
let wasOut = null;
function updateOutage() {
  const r = S.live, real = !!r && (r.gridStatus !== 'Active' || /off_grid/.test(r.islandStatus ?? '')) || !!S.now?.outage?.active;
  S.outageActive = real || S.preview;
  if (wasOut !== null && S.outageActive !== wasOut) {
    if (S.outageActive) { toast('⚡', 'rgba(255,90,78,.25)', S.preview ? 'Outage preview' : 'Grid outage detected', `${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · your Powerwalls took over`); go('v-now'); }
    else toast('✓', 'rgba(78,240,166,.2)', 'Grid restored', `Back on PEC. Your home never lost power.`);
  }
  wasOut = S.outageActive;
}

/* ---------------- navigation ---------------- */
function go(v, anchor) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === v));
  if (v === 'v-hist') { land.replay(); drawHistoryChart(S); }
  const sc = $('screen');
  if (anchor) setTimeout(() => sc.scrollTo({ top: $(anchor).getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 50, behavior: 'smooth' }), 60); else sc.scrollTo({ top: 0 });
}
document.querySelectorAll('.tab[data-v]').forEach(t => t.onclick = () => go(t.dataset.v));
document.addEventListener('click', e => { const el = e.target.closest('[data-go]'); if (el) go(el.dataset.go, el.dataset.land ? 'landSect' : el.dataset.bills ? 'billSect' : null); });
const closeSheet = () => $('phone').classList.remove('open');
$('scrim').onclick = closeSheet;
document.addEventListener('click', e => { if (e.target.closest('[data-addbill]')) openBillSheet(S, () => loadHistory()); });
$('openData').onclick = openRawData;
addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); if (e.key === 'd' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) openRawData(); });
$('calmSw').classList.toggle('on', S.calm); $('calmSw').onclick = () => { S.calm = !S.calm; $('calmSw').classList.toggle('on', S.calm); api.saveSettings({ calm: S.calm }).catch(() => {}); };
$('signOut').onclick = async () => { await api.logout().catch(() => {}); location.reload(); };
$('outSw').onclick = () => { S.preview = !S.preview; S.previewSince = Date.now(); $('outSw').classList.toggle('on', S.preview); updateOutage(); renderLive(S); };

/* ---------------- scenes + loop ---------------- */
const house = createHomeView($('house'), 'flow');
const aurora = createAurora($('aurora')), orb = createOrb($('orb')), land = createLandscape($('land'), $('landTip')), roof = createHomeView($('roof'), 'sun');
buildFlow(); initHistory(S); initPanels(S); initPlanner(S); initAppliances(S); initAc(S);
let applSel = 'pool';
$('applStrip').onclick = e => { const a = e.target.closest('.app'); if (!a || !a.dataset.id || a.classList.contains('dim')) return; applSel = a.dataset.id; document.querySelectorAll('#applStrip .app').forEach(x => x.classList.toggle('on', x === a)); $('applPool').hidden = applSel !== 'pool'; $('applAc').hidden = applSel !== 'ac'; poolTwin()?.resize(); thermalTwin()?.resize(); if (applSel === 'ac') safe(drawAc)(S); };

/* ---------------- Insights: four panels + the Day Ring ---------------- */
let insPanel = 'today';
$('insSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; insPanel = b.dataset.p; document.querySelectorAll('#insSeg button').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('#v-ins .panel').forEach(p => p.classList.toggle('on', p.id === 'ip-' + insPanel)); poolTwin()?.resize(); dayRing.resize(); };
const dayRing = createDayRing($('dayRing'), (h, d) => {
  const ro = $('drRead'); if (!d) return;
  const sum = a => a.reduce((x, y) => x + y, 0), bd = (p, a, r) => `<div class="bd"><span><i style="background:#6cc4ff"></i>${p}</span><span><i style="background:#ff9e66"></i>${a}</span><span><i style="background:#8d93a8"></i>${r}</span></div>`;
  if (h == null) ro.innerHTML = `<b>${Math.round(sum(d.rest) + sum(d.ac) + sum(d.pool))} kWh</b><small>${d.label}</small>${bd(Math.round(sum(d.pool)), Math.round(sum(d.ac)), Math.round(sum(d.rest)))}`;
  else ro.innerHTML = `<b>${(d.rest[h] + d.ac[h] + d.pool[h]).toFixed(1)} kWh</b><small>${h % 12 || 12}${h < 12 ? ' AM' : ' PM'} · solar ${d.solar[h].toFixed(1)} kWh</small>${bd(d.pool[h].toFixed(1), d.ac[h].toFixed(1), d.rest[h].toFixed(1))}`;
});
S.ringMode = 'now'; S.onPool = () => safe(drawDayRing)();
$('drModes').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.ringMode = b.dataset.m; document.querySelectorAll('#drModes button').forEach(x => x.classList.toggle('on', x === b)); drawDayRing(); };
/** Today's hourly loads: pool from the schedule model, AC from the heat model, the rest from Tesla's home load. */
export function drawDayRing() {
  const day = S.today; if (!day || !day.buckets?.length) return;
  const home = Array(24).fill(0), solar = Array(24).fill(0);
  day.buckets.forEach(b => { const h = Math.floor(b.t); if (h < 24) { home[h] += b.home / 12; solar[h] += b.solar / 12; } });
  const p = S.pool, curve = p?.model?.curve, W = r => r && curve ? curve.reduce((a, c) => Math.abs(c.rpm - r) < Math.abs(a.rpm - r) ? c : a).watts : 0;
  const hourly = src => Array.from({ length: 24 }, (_, h) => src?.[h] ? W(src[h].rpm) * src[h].frac / 1000 : 0);
  const extras = p?.extras?.hourlyToday ?? Array(24).fill(0);
  const poolNow = hourly(p?.current?.hourly).map((v, h) => v + extras[h]), pool = S.ringMode === 'pool' ? hourly(p?.plan?.hourly).map((v, h) => v + extras[h]) : poolNow;
  const high = S.highs?.[localDate()], slope = S.acSlope ?? 2.5, acDay = high != null ? Math.max(0, (high - 80) * slope) : 0;
  const w = Array.from({ length: 24 }, (_, h) => Math.max(0, Math.sin((h - 8) / 15 * Math.PI)) ** 1.5), ws = w.reduce((a, b) => a + b, 0) || 1;
  const ac = w.map(v => Math.min(acDay * v / ws, Math.max(0, home[w.indexOf(v)] - poolNow[w.indexOf(v)])));
  const rest = home.map((v, h) => Math.max(0, v - ac[h] - poolNow[h])); // the house minus the pump's real share, whatever mode is shown
  const sol = S.ringMode === 'panels' ? solar.map(v => v * (1 + 8 * 400 / 9600)) : solar;
  const label = S.ringMode === 'now' ? 'today so far' : S.ringMode === 'pool' ? 'with the smarter pool schedule' : 'with 8 more panels';
  dayRing.setData({ rest, ac, pool, solar: sol, label }); dayRing.setHour(localHour());
  const tot = home.reduce((a, b) => a + b, 0), pk = pool.reduce((a, b) => a + b, 0);
  $('insToday').textContent = Math.round(tot);
  $('drTxt').innerHTML = S.ringMode === 'now' ? (tot ? `The pool pump is about <b style="color:var(--text)">${Math.round(pk / tot * 100)}%</b> of today so far. AC is estimated from your heat model (about ${slope.toFixed(1)} kWh per degree over 80°F) until Nest is linked; everything else is what's left of Tesla's home load.` : 'Waiting for today’s data.')
    : S.ringMode === 'pool' ? `With the smarter schedule the pump moves under the solar curve and drops to about <b style="color:var(--text)">${Math.round(pk)} kWh</b> a day, so nights are just the house idling and the Powerwalls reach the evening fuller.`
    : `Eight more panels lift the gold ribbon by a third. Midday surplus covers more of the AC ramp, and the planner says the batteries would fill on far more days.`;
}
$('planMore').onclick = () => { $('cmp').hidden = !$('cmp').hidden; $('planFine').hidden = $('cmp').hidden; };

let HIDDEN = false; document.addEventListener('visibilitychange', () => HIDDEN = document.hidden);
let last = performance.now(), T = 0, tick = 0, hudTick = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (HIDDEN) return;
  T += dt * (S.calm ? .35 : 1);
  const r = S.live;
  if (r) aurora.set(r);
  aurora.render(T, S.outageActive);
  if (isOn('v-now') && r) orb.render({ soc: r.soc, batteryKw: r.batteryKw, solarKw: r.solarKw, peakKw: S.peakKw ?? 9, maxKw: S.now?.site?.maxPowerKw || 10, out: S.outageActive, dt, t: T });
  if (isOn('v-now') && r) {
    const i = S.wx ? S.wx.hourly.time.indexOf(`${localDate()}T${String(Math.floor(localHour())).padStart(2, '0')}:00`) : -1;
    house.render({ r, cloud: i >= 0 ? S.wx.hourly.cloud_cover[i] / 100 : .1, code: i >= 0 ? S.wx.hourly.weather_code[i] : 0, out: S.outageActive, peakKw: S.peakKw ?? 9, dt, t: T, calm: S.calm });
  }
  if (isOn('v-hist')) land.render(dt, S.calm);
  if (isOn('v-ins') && insPanel === 'today') dayRing.render(dt, S.calm);
  if (isOn('v-ins') && insPanel === 'appl' && applSel === 'pool') poolTwin()?.render(dt, S.calm);
  if (isOn('v-ins') && insPanel === 'appl' && applSel === 'ac') thermalTwin()?.render(dt, S.calm);
  if (isOn('v-roof')) {
    const d = new Date(), dayStart = Date.parse(`${localDate(d)}T00:00:00${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'longOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value.replace('GMT', '') || 'Z'}`);
    hudTick += dt;
    const info = roof.render({ r, now: d, dayStart, cloud: S.roofWx?.cc ?? .1, code: S.roofWx?.code ?? 0, out: S.outageActive, peakKw: S.peakKw ?? 9, dt, t: T, calm: S.calm });
    if (hudTick > .5) { hudTick = 0; if (S.location) S.roofWx = roofHud(S, info, d); $('rfKw').textContent = r ? r.solarKw.toFixed(1) : '—'; }
  }
}
requestAnimationFrame(frame);
setInterval(() => { safe(renderLive)(S); safe(sideSummary)(); }, 1000);

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
  $('billDue').innerHTML = card; $('billDueNow').innerHTML = card;
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
let started = false;
setUnauthorized(() => { if (!started) return; showAuth('login'); });

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('tesla_error')) toast('!', 'rgba(255,90,78,.25)', 'Tesla connection failed', params.get('tesla_error'));
  if (params.get('nest_error')) toast('!', 'rgba(255,90,78,.25)', 'Nest link failed', params.get('nest_error'));
  if (params.get('nest') === 'linked') toast('✓', 'rgba(78,240,166,.2)', 'Nest linked', 'Solstice can now see the thermostat. Open Insights → Appliances → AC.');
  let me;
  try { me = await api.me(); } catch { $('authErr').textContent = 'Can’t reach the Solstice server.'; return showAuth('login'); }
  if (me.mode === 'single') {           // no accounts yet: open straight to the connected site
    document.querySelectorAll('.acct').forEach(el => el.hidden = true);
    if (!me.site) return showAuth('connect');
  } else {
    if (!me.user) return me.needsSetup && params.get('setup') ? showAuth('setup', { token: params.get('setup') }) : showAuth('login');
    $('acctEmail').textContent = me.user.email;
    if (!me.site) return showAuth('connect');
  }
  started = true;
  const prefs = await api.settings().catch(() => ({}));
  S.location = setSiteLocation(prefs.location);  // exact coordinates + ZIP from the server env; weather, NWS and the sun wait for them
  if (typeof prefs.calm === 'boolean') { S.calm = prefs.calm; $('calmSw').classList.toggle('on', S.calm); }
  const every = (ms, fn) => { const run = () => fn().catch(e => console.warn(e.message)); run(); setInterval(run, ms); };
  every(30_000, loadNow);                 // live status (the server asks Tesla at most every ~25 s)
  every(5 * 60_000, loadHistory);
  every(15 * 60_000, loadWeather);
  every(5 * 60_000, loadExternal);
  loadArchive().catch(e => console.warn('archive', e.message));
  // keep history current: sync now, then every 5 min while open; keep going while there are missing days to backfill
  const sync = async () => { const r = await api.sync().catch(() => null); if (r?.filled || r?.done?.includes('lastHistory')) loadHistory().catch(() => {}); if (r?.remaining > 0) setTimeout(sync, 1500);
    S.syncInfo = r; $('sideDays').textContent = r?.remaining ? `loading… ${r.remaining} days left` : $('sideDays').textContent; };
  sync(); setInterval(sync, 5 * 60_000);
  setInterval(async () => { const s = await api.status().catch(() => null); safe(drawHealth)(S, s); }, 60_000);
  api.status().then(s => safe(drawHealth)(S, s)).catch(() => {});
}
boot();

// PWA: offline shell + home-screen install
if ('serviceWorker' in navigator && !import.meta.env.DEV) navigator.serviceWorker.register('/sw.js').catch(() => {});
