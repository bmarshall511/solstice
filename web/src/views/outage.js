import { $, niceDate, localDate, addDays, svgText } from '../lib/util.js';
import { api } from '../lib/api.js';

/*
 * Outage readiness: the first card on Insights → Home (approved mockup n-outage). Numbers come from /api/outage
 * (server/src/outage.ts); the card replays its island simulation to drive the HUD, the fill strips and the 3D scene.
 * The selector picks the As is / Without AC / Without AC + pool run and re-runs the ladder here; Preview plays the next
 * 48 hours in about nine seconds. Both are card-local: neither touches S.preview (Settings' outage preview) or any device.
 * The scene (scenes/outage.js) is built only while the card is on screen, renders only while ≥10% of it is visible,
 * and is disposed as soon as the tab or the Insights panel changes (or after 45 s scrolled away).
 */
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, k) => a + (b - a) * k, ease = p => p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
/** 9.674 → "9 h 40 m"; a day or more rounds to hours; under an hour is minutes only. */
const fmtHM = h => { if (h == null || !isFinite(h)) return '—'; let H = Math.floor(h), M = Math.round((h - H) * 60); if (M === 60) { H++; M = 0; } return h >= 24 ? `${Math.round(h)} h` : !H ? `${M} m` : M ? `${H} h ${M} m` : `${H} h`; };
const RUNGS = { on: ['rgba(242,244,248,.75)', (r) => `${r.kw.toFixed(1)} kW`], pool: ['var(--home)', r => `+${r.addKw.toFixed(2)} → ${r.kw.toFixed(2)} kW`],
  ac: ['#ff9e66', (r, d) => `+${r.addKw.toFixed(1)} kW (${d.loads.acKw.toFixed(1)} × ${Math.round(d.loads.acDuty * 100)}% duty)`], else: ['#8d93a8', r => `+${r.addKw.toFixed(2)} → ${r.kw.toFixed(1)} kW`] };

const MARKUP = `<div class="card outage">
  <div class="h"><b>Outage readiness</b><span class="hbtns"><span class="badge" data-swbadge hidden>Storm Watch</span><button class="chip" data-preview>Preview</button></span></div>
  <div class="ring3d o3d" data-scene><div class="roofhud" data-hud>—</div></div>
  <div class="seg2 wide" data-seg><button class="on" data-s="asis">As is</button><button data-s="noac">Without AC</button><button data-s="noacpool">Without AC + pool</button></div>
  <div class="ochips" data-chips></div>
  <div class="wkhead"><span>If it kept drawing</span><b data-usable>—</b></div>
  <div class="kv" data-ladder></div>
  <div class="kv" data-rows></div>
  <p class="fine" data-limit>Up to 10 kW at once (2 × PW2 at 5 kW continuous). The AC and pool pump starting together stay well inside that.</p>
  <div class="wkhead"><span>Outages</span><b>12 months</b></div>
  <p data-last style="margin-top:6px">—</p>
  <svg class="mini" data-strip viewBox="0 0 310 64"></svg>
  <p class="fine">The ladder divides what the Powerwalls hold now (charge × 27 kWh × 95%) by a steady draw. The HUD runs tonight's hourly load through the Next 48 hours battery model instead, so it lasts longer as the house draws less overnight. "Sun tomorrow adds" counts the hours tomorrow's sun keeps the house fully powered after the first empty.</p>
</div>`;

/** Mounts the card as the first child of `parent` (#ip-home). Returns { frame(dt, now) } for main.js's loop. */
export function mountOutageCard(S, parent) {
  parent.insertAdjacentHTML('afterbegin', MARKUP);
  const root = parent.firstElementChild, $q = s => root.querySelector(s), host = $q('[data-scene]'), hud = $q('[data-hud]');
  const C = { data: null, scen: 'asis', sim: null, knots: null, kw0: 0, kNight: 0, socNight: 0, kMin: 0, startHour: 21, storm: false, previewOutage: false, anim: null, hudDirty: true,
    cur: { k: 0, soc: 0, s: 0, h: 0, b: 0, dark: false } };
  let scene = null, building = false, failed = false, vis = false, hiddenAt = 0, loading = false, t = 0, lastHud = '';

  /* ---------- time labels ---------- */
  const weekday = d => new Date(addDays(C.data.date, d) + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const clock = (k, step = 1, day = true) => { const tot = C.startHour + k; let d = Math.floor(tot / 24), hh = tot - d * 24, H = Math.floor(hh), M = Math.round((hh - H) * 60 / step) * step;
    if (M >= 60) { H++; M = 0; } if (H >= 24) { H -= 24; d++; }
    return `${day ? weekday(d) + ' ' : ''}${H % 12 || 12}:${String(M).padStart(2, '0')} ${H < 12 ? 'AM' : 'PM'}`; };

  /* ---------- the chosen run of the island simulation ---------- */
  function run() {
    const d = C.data, sc = d.scenarios[C.scen], S0 = [d.soc / 100, ...sc.island.points.map(p => p.soc)];
    C.sim = sc.island; C.kw0 = sc.drawKw; C.knots = S0.map((v, i) => [i, v]);
    if (C.sim.emptyH != null) { const e = C.sim.emptyH; C.knots = C.knots.filter(([i]) => i <= Math.floor(e)).concat([[e, 0]], C.knots.filter(([i]) => i > e)); }
    let km = 0; for (let i = 1; i <= 12; i++) if (S0[i] < S0[km] - 1e-6) km = i; C.kNight = km; C.socNight = S0[km];
    let kg = 0; S0.forEach((v, i) => { if (v < S0[kg] - 1e-6) kg = i; }); C.kMin = kg;
  }
  const socAt = k => { const n = C.knots; if (k <= 0) return n[0][1]; for (let i = 1; i < n.length; i++) if (n[i][0] >= k) { const [a, va] = n[i - 1], [b, vb] = n[i]; return lerp(va, vb, (k - a) / (b - a || 1)); } return n[n.length - 1][1]; };
  function sample(k) { const i = Math.min(47, Math.floor(k)), p = C.sim.points[i], e = C.sim.emptyH;
    C.cur = { k, soc: socAt(k), s: p.s, h: p.h, b: p.b, dark: e != null && p.u > 1e-6 && (i !== Math.floor(e) || k >= e) }; }
  function summary() { const m = C.sim, cloudy = C.data.solar.cloudy;
    if (m.emptyH != null) return [`${fmtHM(m.emptyH)} at ${C.kw0.toFixed(1)} kW`, `sun tomorrow adds ~${m.sunAdds} h${cloudy ? ' · clouds' : ''}`];
    return [`48 h+ at ${C.kw0.toFixed(1)} kW`, `lowest ${Math.round(m.minSoc * 100)}% · ${clock(C.kMin)} · sun refills`]; }
  function setHud(a, b) { const s = `${a}<span>${b}</span>`; if (s !== lastHud) { hud.innerHTML = s; lastHud = s; C.hudDirty = true; } }

  /* ---------- the card's text ---------- */
  function rows() {
    const d = C.data, m = C.sim, sc = d.scenarios[C.scen], st = d.storm, sw = st.stormWatch;
    const chip = (alert, c, text) => `<span class="chipx${alert ? ' alert' : ''}"><i style="--c:${c}"></i>${text}</span>`;
    const e = st.ercot, grey = 'rgba(242,244,248,.38)';
    $q('[data-chips]').innerHTML = chip(sw.active, sw.active ? 'var(--out)' : sw.enabled ? 'var(--batt)' : grey, `Storm Watch · ${sw.active ? 'active' : sw.enabled ? 'on' : sw.enabled === false ? 'off' : '—'}`) +
      (st.nws.length ? chip(true, 'var(--out)', `NWS · ${st.nws[0].event}`) : chip(false, 'var(--batt)', 'NWS · no alerts')) +
      (!e ? chip(false, grey, 'ERCOT · —') : e.eea > 0 ? chip(true, 'var(--out)', `ERCOT · EEA ${e.eea}`) : chip(false, /normal/i.test(e.condition ?? '') ? 'var(--batt)' : 'var(--warn)', `ERCOT · ${String(e.condition ?? '—').toLowerCase()}`)) +
      chip(false, 'var(--home)', `Reserve ${d.reservePct ?? '—'}%`);
    $q('[data-swbadge]').hidden = !sw.active;
    const tmr = d.solar.tomorrowKwh;
    $q('[data-rows]').innerHTML = [['Powerwalls now', `${Math.round(d.soc)}% · ${d.usableKwh.toFixed(1)} kWh`], ['Reserve (kept for outages)', `${d.reservePct ?? '—'}%`],
      ['Backup at current draw', `${fmtHM(sc.backupH)} at ${sc.drawKw.toFixed(1)} kW`],
      ['Tonight (sim)', m.emptyH != null && m.emptyH < 16 ? `empty ~${clock(m.emptyH, 1, false)}` : `${Math.round(C.socNight * 100)}% by ${clock(C.kNight, 1, false)}`],
      ["Tomorrow's solar", tmr == null ? '—' : `${Math.round(tmr)} kWh${d.solar.cloudy ? ' · clouds' : ''}`], ['Most at once', `${d.maxKw} kW`]]
      .map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
    // the ladder, re-run here for the selected scenario: hours = usable kWh ÷ each rung's steady draw; switched-off loads are struck through
    const off = id => (id === 'ac' && C.scen !== 'asis') || (id === 'pool' && C.scen === 'noacpool');
    $q('[data-ladder]').innerHTML = d.ladder.map(r => { const [c, small] = RUNGS[r.id], h = r.kw > 0 ? d.usableKwh / r.kw : null, o = off(r.id) ? ' off' : '';
      return `<span class="rung${o}" style="--c:${c}">${r.label}<small>${small(r, d)}</small><i style="width:${h == null ? 100 : Math.min(100, h / 48 * 100).toFixed(1)}%"></i></span><b class="${o.trim()}">${fmtHM(h)}</b>`; }).join('');
    $q('[data-usable]').textContent = `${d.usableKwh.toFixed(1)} kWh usable`;
    $q('[data-limit]').textContent = `Up to ${d.maxKw} kW at once (${d.batteries} × PW2 at ${+(d.maxKw / d.batteries).toFixed(1)} kW continuous). The AC and pool pump starting together stay well inside that.`;
  }

  /** The 12-month strip (the History outage card's drawing) and the last-outage line. */
  function outages() {
    const o = C.data.outages, yearAgo = addDays(localDate(), -365);
    const when = ts => niceDate(ts.slice(0, 10), ts.slice(0, 10) < yearAgo ? { month: 'short', day: 'numeric', year: 'numeric' } : undefined);
    const dur = s => fmtHM(s / 3600).replace(/ /g, ' ');   // "1 h 33 m" never breaks across lines
    $q('[data-last]').innerHTML = !o.last ? 'No outages on record.'
      : `Last outage: <b style="color:var(--text)">${when(o.last.ts)} · ${dur(o.last.duration_s)}</b> · ${o.count12 ? `${o.count12} in 12 months${o.longest12 ? ` · longest ${dur(o.longest12.duration_s)}` : ''}` : 'none in 12 months'}`;
    const months = Array.from({ length: 12 }, (_, i) => addDays(yearAgo, i * 30.4).slice(0, 7));
    let s = '<line x1="6" x2="304" y1="28" y2="28" stroke="rgba(255,255,255,.1)"/>';
    months.forEach((m, i) => s += svgText(6 + i * 24.8 + 12, 58, new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'narrow', timeZone: 'UTC' }), { anchor: 'middle' }));
    o.list.forEach(e => { const f = (Date.parse(e.ts) - Date.parse(yearAgo)) / (365 * 864e5), r = 3 + Math.sqrt(e.duration_s / 3600) * 5;
      s += `<circle cx="${(6 + clamp(f, 0, 1) * 298).toFixed(1)}" cy="28" r="${r.toFixed(1)}" fill="#ff5a4e" fill-opacity=".3" stroke="#ff5a4e"><title>${e.ts.slice(0, 16).replace('T', ' ')} · ${dur(e.duration_s)}</title></circle>`; });
    $q('[data-strip]').innerHTML = s;
  }

  /* ---------- the timeline: drain after a selector change, hold, ease back; Preview plays 48 h in 9 s ---------- */
  const go = anim => { C.anim = anim ? { ...anim, t0: performance.now() } : null; };
  const stopPreview = () => { C.previewOutage = false; $q('[data-preview]').classList.remove('on'); };
  function tick(now) {
    const A = C.anim; if (!A) { sample(0); C.cur.soc = C.data.soc / 100; setHud(...summary()); return; }
    const p = clamp((now - A.t0) / A.dur, 0, 1);
    if (A.type === 'drain' || A.type === 'preview') {
      const k = (A.type === 'drain' ? ease(p) : p) * A.kEnd; sample(k);
      const pct = Math.round(C.cur.soc * 100), c = C.cur;
      if (A.type === 'drain') setHud(`+${fmtHM(k)} · ${pct}%`, `${clock(k, 10)} · home ${c.h.toFixed(1)} kW`);
      else setHud(`${clock(k, 10)} · ${pct}%`, c.dark ? 'dark · Powerwalls empty' : c.s >= c.h ? `sun → home${c.b < -.05 ? ` · +${(-c.b).toFixed(1)} kW to PW` : ''}` : c.s > .05 ? `sun ${c.s.toFixed(1)} + PW ${c.b.toFixed(1)} kW → home` : `Powerwalls → home ${c.b.toFixed(1)} kW`);
      if (p >= 1) { if (A.type === 'drain') go({ type: 'hold', dur: 1400 }); else { stopPreview(); go({ type: 'back', dur: 700, from: C.cur.soc }); } }
    } else if (A.type === 'hold') { setHud(...summary()); if (p >= 1) go({ type: 'back', dur: 700, from: C.cur.soc }); }
    else if (A.type === 'back') { sample(0); C.cur.soc = lerp(A.from, C.data.soc / 100, ease(p)); setHud(...summary()); if (p >= 1) go(null); }
  }
  $q('[data-seg]').onclick = e => { const b = e.target.closest('button'); if (!b || !C.data) return;
    root.querySelectorAll('[data-seg] button').forEach(x => x.classList.toggle('on', x === b)); C.scen = b.dataset.s; run(); rows(); stopPreview();
    go({ type: 'drain', dur: 2000, kEnd: C.sim.emptyH ?? C.kNight }); };
  $q('[data-preview]').onclick = e => { if (!C.data) return; C.previewOutage = !C.previewOutage; e.currentTarget.classList.toggle('on', C.previewOutage);
    if (C.previewOutage) go({ type: 'preview', dur: 9000, kEnd: 47.99 }); else go({ type: 'back', dur: 700, from: C.cur.soc }); };

  /* ---------- data ---------- */
  async function load() {
    if (loading) return; loading = true;
    try { const d = await api.outage(); C.data = d; C.startHour = d.startHour; C.storm = d.storm.active; run(); rows(); outages(); if (!C.anim) tick(performance.now()); }
    catch (e) { console.warn('outage', e.message); }
    finally { loading = false; }
  }
  setInterval(() => { if (root.offsetParent) load(); }, 5 * 60_000);

  /* ---------- the scene: build near the viewport, render while ≥10% visible, dispose when the panel or tab changes ---------- */
  const dispose = () => { scene?.dispose(); scene = null; hiddenAt = 0; };
  function build() {
    if (scene || building || failed) return; building = true;
    import('../scenes/outage.js').then(m => { if (host.offsetParent && !scene) { scene = m.createOutageScene(host); C.hudDirty = true; } })
      .catch(e => { failed = true; console.error('outage scene', e); }).finally(() => { building = false; });
  }
  new IntersectionObserver(es => es.forEach(e => {
    vis = e.intersectionRatio >= .1;
    if (e.isIntersecting) { hiddenAt = 0; if (!C.data) load(); build(); }
    else if (!host.offsetParent) dispose();          // Insights tab or Home panel switched away: free the WebGL context now
    else hiddenAt ||= performance.now();             // scrolled away: paused, then disposed after 45 s
  }), { root: $('screen'), rootMargin: '160px 0px', threshold: [0, .1, .2] }).observe(host);

  return {
    frame(dt, now = performance.now()) {
      if (!C.data) return;
      t += dt; tick(now);
      if (scene && vis) scene.render(dt, t, C, S.calm || RM.matches);
      else if (scene && hiddenAt && now - hiddenAt > 45_000) dispose();
    },
  };
}
