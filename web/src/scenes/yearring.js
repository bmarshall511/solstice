import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchOrbit } from '../lib/touchorbit.js';
import { addDays, niceDate } from '../lib/util.js';

/*
 * Your year (History → Year, mockup o-year-ring, design docs/audit-designs/visualizations.md §7).
 * The last 365 days on three rings of bars at their calendar positions: solar outside, home in the middle, bought from PEC
 * inside, all on one scale. Green floor ticks mark days the Powerwalls reached 100%, red beads mark outages (radius ∝ √minutes),
 * a faint gold line traces last year's solar where last year's data exists, and the white hand is today.
 * A day with no stored row is an empty slot (no bar), never a zero-height bar. Days are calendar dates, so 23- and 25-hour
 * DST days are one slot like any other.
 */

/* ---------------- data (pure; tested in tests/web/yearring.test.js) ---------------- */
const DAY = 864e5;
export const yearLen = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
export const dayOfYear = date => Math.round((Date.parse(date + 'T00:00:00Z') - Date.UTC(+date.slice(0, 4), 0, 1)) / DAY);
/** Where a calendar day sits on the ring: 0..1 from Jan 1, at the middle of the day. */
export const yearFrac = date => (dayOfYear(date) + .5) / yearLen(+date.slice(0, 4));
/** The same date a year earlier (Feb 29 → Mar 1). */
export const lastYearOf = date => { const t = new Date(date + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };

/**
 * One slot per calendar day for the 365 days ending `today`, oldest first.
 * daily: /api/daily rows ({date, solar, home, import, export, socMax, …}); history: older rows for last year's ghost (optional);
 * outages: /api/outages rows ({ts, duration_s}).
 */
export function yearModel({ daily = [], history = [], today, outages = [] }) {
  const rows = new Map(daily.map(r => [r.date, r])), past = new Map([...history, ...daily].map(r => [r.date, r]));
  const from = addDays(today, -364), outMin = {}, events = outages.filter(o => { const d = o.ts.slice(0, 10); return d >= from && d <= today; });
  events.forEach(o => { const d = o.ts.slice(0, 10); outMin[d] = (outMin[d] ?? 0) + o.duration_s / 60; });
  const days = Array.from({ length: 365 }, (_, i) => {
    const date = addDays(from, i), ly = past.get(lastYearOf(date));
    return { i, date, frac: yearFrac(date), d: rows.get(date) ?? null, outage: Math.round(outMin[date] ?? 0), ghost: ly?.solar ?? null };
  });
  const ghostMax = Math.max(0, ...[...past.values()].map(r => r.solar ?? 0));
  return { today, days, events: events.length, eventMin: Math.round(events.reduce((a, o) => a + o.duration_s / 60, 0)), ghostMax };
}

/** Contiguous runs of slots that have last year's solar; each run draws as its own closed outline, so gaps stay open. */
export function ghostRuns(days) {
  const runs = []; let cur = null;
  days.forEach(s => { if (s.ghost == null) cur = null; else { if (!cur) runs.push(cur = []); cur.push(s); } });
  return runs;
}

/** The card's numbers. Averages and counts use only the days that are stored. */
export function yearStats(m) {
  const P = m.days.filter(s => s.d), sum = k => P.reduce((a, s) => a + (s.d[k] ?? 0), 0), home = sum('home'), imp = sum('import');
  const soc = P.filter(s => s.d.socMax != null), month = n => { const M = P.filter(s => +s.date.slice(5, 7) === n); return M.length ? M.reduce((a, s) => a + s.d.home, 0) / M.length : null; };
  const ghost = m.days.filter(s => s.ghost != null);
  return { present: P.length, solar: sum('solar'), home, import: imp, covered: home ? 1 - imp / home : null,
    full: soc.filter(s => s.d.socMax >= 99).length, socDays: soc.length, outages: m.events, outageMin: m.eventMin,
    jul: month(7), dec: month(12), best: P.reduce((a, s) => !a || s.d.solar > a.d.solar ? s : a, null),
    ghost: ghost.length, ghostFrom: ghost[0]?.date ?? null, ghostTo: ghost.at(-1)?.date ?? null };
}

export const dur = m => m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;

/* ---------------- the scene ---------------- */
const ang = f => f * Math.PI * 2 - Math.PI / 2;   // Jan at the far side, clockwise from above
const R = { solar: 3.2, home: 2.6, imp: 2.1, tick: 2.9, lab: 3.95 }, MAXH = 2.4, CAP = 366, GROW = 1.2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FALLBACK = { '--solar': '#ffc15e', '--home': '#6cc4ff', '--grid': '#c4a2ff', '--batt': '#4ef0a6', '--out': '#ff5a4e' };

/** onTap(slot index | -1). Renders only when render() is called; DPR capped at 1.5. */
export function createYearRing(el, { labs: labsEl, calm = false, onTap }) {
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || FALLBACK[n];
  const C = { solar: new THREE.Color(css('--solar')), home: new THREE.Color(css('--home')), grid: new THREE.Color(css('--grid')), batt: new THREE.Color(css('--batt')), out: new THREE.Color(css('--out')) };
  let W = el.clientWidth || 353, H = el.clientHeight || 330;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(1.5, devicePixelRatio)); renderer.setSize(W, H); el.prepend(renderer.domElement);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(38, W / H, .1, 100); cam.position.set(0, 9.6, 6.2);
  const ctl = new OrbitControls(cam, renderer.domElement); Object.assign(ctl, { enableZoom: false, enablePan: false, enableDamping: true, minPolarAngle: .35, maxPolarAngle: 1.0, autoRotate: !calm, autoRotateSpeed: .35 });
  ctl.target.set(0, .15, 0); touchOrbit(ctl);   // horizontal drag orbits, vertical swipes scroll History
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x0a0c14, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 8, 5); scene.add(key);

  const REACH = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 5.5);   // covers every bar and bead at full height, for culling and taps
  const inst = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, CAP); m.count = 0; m.boundingSphere = REACH; scene.add(m); return m; };
  const bar = new THREE.BoxGeometry(.05, 1, .11).translate(0, .5, 0);
  const std = (op = 1) => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .55, metalness: .1, transparent: op < 1, opacity: op, depthWrite: op >= 1 });
  const rings = [{ key: 'solar', r: R.solar, col: C.solar, mesh: inst(bar, std()) }, { key: 'home', r: R.home, col: C.home, mesh: inst(bar, std(.6)) }, { key: 'import', r: R.imp, col: C.grid, mesh: inst(bar, std()) }];
  rings.forEach(g => { for (let i = 0; i < CAP; i++) g.mesh.setColorAt(i, g.col); });

  const disc = new THREE.Mesh(new THREE.RingGeometry(1.9, 3.5, 128), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .045, side: THREE.DoubleSide, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2; scene.add(disc);
  const ticks = inst(new THREE.PlaneGeometry(.035, .2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.batt }));
  const beads = inst(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: C.out }));
  const ghostMat = new THREE.LineBasicMaterial({ color: C.solar, transparent: true, opacity: 0, depthWrite: false });
  const ghost = new THREE.LineSegments(new THREE.BufferGeometry(), ghostMat); scene.add(ghost);
  const L = 1.9, hand = new THREE.Mesh(new THREE.BoxGeometry(.035, .02, L).translate(0, 0, 1.85 + L / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .55 }));
  hand.position.y = .02; scene.add(hand);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const place = (a, r, y, sx, sy, sz) => { p.set(r * Math.cos(a), y, r * Math.sin(a)); q.setFromAxisAngle(UP, Math.PI / 2 - a); sc.set(sx, sy, sz); return m4.compose(p, q, sc); };

  let model = null, present = [], instOf = new Map(), full = [], outs = [], K = 1, grow = calm ? GROW : 0, labs = [], sel = -1, touched = false;
  const beadR = s => .06 + .011 * Math.sqrt(s.outage);

  function layout(t) {
    const k = t / GROW, ke = 1 - Math.pow(1 - Math.min(1, k), 3);
    present.forEach((s, n) => { const e0 = Math.max(0, Math.min(1, k * 1.3 - s.i / 365 * .3)), e = 1 - Math.pow(1 - e0, 3), a = ang(s.frac);
      rings.forEach(g => g.mesh.setMatrixAt(n, place(a, g.r, 0, 1, Math.max(.004, (s.d[g.key] ?? 0) * K * e), 1))); });
    rings.forEach(g => g.mesh.instanceMatrix.needsUpdate = true);
    outs.forEach((s, n) => { const r = beadR(s) * ke, top = s.d ? Math.max(s.d.home, s.d.solar) * K : 0; beads.setMatrixAt(n, place(ang(s.frac), R.home + .3, top * ke + .18 + r, r || .001, r || .001, r || .001)); });
    beads.instanceMatrix.needsUpdate = true;
    full.forEach((s, n) => ticks.setMatrixAt(n, place(ang(s.frac), R.tick, .01, 1, 1, Math.max(.001, ke))));
    ticks.instanceMatrix.needsUpdate = true;
    ghostMat.opacity = .25 * ke;
  }

  function placeLabels() {
    labs.forEach(l => { if (!l.w) { l.w = l.e.offsetWidth; l.h = l.e.offsetHeight; }
      p.copy(l.pos).project(cam); const x = (p.x + 1) / 2 * W, y = (1 - p.y) / 2 * H;
      const lx = Math.max(4, Math.min(W - l.w - 4, x - l.w / 2)), ly = Math.max(4, Math.min(H - l.h - 4, y - l.h / 2));
      l.e.style.transform = `translate(${lx.toFixed(1)}px,${ly.toFixed(1)}px)`; });
  }
  document.fonts?.ready.then(() => labs.forEach(l => l.w = 0));

  function highlight(i) {
    const prev = instOf.get(sel), next = instOf.get(i); sel = i;
    rings.forEach(g => { if (prev != null) g.mesh.setColorAt(prev, g.col); if (next != null) g.mesh.setColorAt(next, g.col.clone().lerp(new THREE.Color(0xffffff), .75)); g.mesh.instanceColor.needsUpdate = true; });
  }

  // tap = pointer up within 6 px of pointer down: a bar or bead by instance, otherwise the day under the floor point inside the ring band
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(), floor = new THREE.Plane(UP, 0), hitP = new THREE.Vector3();
  let down = null;
  const cv = renderer.domElement;
  cv.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; touched = true; ctl.autoRotate = false; });
  cv.addEventListener('pointercancel', () => down = null);
  cv.addEventListener('pointerup', e => {
    if (!down || !model || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; down = null;
    const r = cv.getBoundingClientRect(); ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ptr, cam);
    const hit = ray.intersectObjects([...rings.map(g => g.mesh), beads], false)[0];
    if (hit) return onTap?.(hit.object === beads ? outs[hit.instanceId].i : present[hit.instanceId].i);
    if (ray.ray.intersectPlane(floor, hitP)) { const rr = Math.hypot(hitP.x, hitP.z);
      if (rr > 1.8 && rr < 4.2) { const f = (((Math.atan2(hitP.z, hitP.x) + Math.PI / 2) / (2 * Math.PI)) % 1 + 1) % 1;
        const near = model.days.reduce((a, s) => { const dd = Math.abs(s.frac - f), d = Math.min(dd, 1 - dd); return d < a.d ? { s, d } : a; }, { s: null, d: Infinity });
        if (near.s && near.d < .6 / 365 && (near.s.d || near.s.outage)) return onTap?.(near.s.i); } }
    onTap?.(-1);
  });

  return {
    /** A yearModel(). Keeps the grow-in where it is, so a refresh mid-animation carries on. */
    setData(m) {
      model = m; present = m.days.filter(s => s.d); full = present.filter(s => s.d.socMax >= 99); outs = m.days.filter(s => s.outage > 0);
      instOf = new Map(present.map((s, n) => [s.i, n]));
      K = MAXH / Math.max(1e-6, ...present.map(s => Math.max(s.d.home ?? 0, s.d.solar ?? 0, s.d.import ?? 0)));
      rings.forEach(g => { g.mesh.count = present.length; for (let n = 0; n < present.length; n++) g.mesh.setColorAt(n, g.col); g.mesh.instanceColor.needsUpdate = true; });
      ticks.count = full.length; beads.count = outs.length;
      // last year's ghost: per run, out along last year's solar and back along the ring's base (LineSegments: gaps stay open)
      const GK = .42 / Math.max(1e-6, m.ghostMax), pts = [], at = (s, r) => { const a = ang(s.frac); return new THREE.Vector3(r * Math.cos(a), .015, r * Math.sin(a)); };
      ghostRuns(m.days).forEach(run => { const loop = [...run.map(s => at(s, R.solar + .12 + s.ghost * GK)), ...[...run].reverse().map(s => at(s, R.solar + .1))];
        loop.forEach((v, n) => pts.push(v, loop[(n + 1) % loop.length])); });
      ghost.geometry.dispose(); ghost.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      hand.rotation.y = Math.PI / 2 - ang(yearFrac(m.today));
      const year = +m.today.slice(0, 4), cur = +m.today.slice(5, 7) - 1;
      if (!labs.length) labs = MONTHS.map((t, n) => { const e = document.createElement('div'); e.textContent = t; labsEl.appendChild(e);
        const a = ang(yearFrac(`${year}-${String(n + 1).padStart(2, '0')}-15`)); return { e, pos: new THREE.Vector3(R.lab * Math.cos(a), 0, R.lab * Math.sin(a)), w: 0, h: 0 }; });
      labs.forEach((l, n) => l.e.className = 'lax' + (n === cur ? ' cur' : ''));
      sel = -1;   // colours were reset above; the card re-selects by date
      layout(grow);
    },
    select: highlight,
    render(dt, calmNow) {
      ctl.autoRotate = !calmNow && !touched;
      if (grow < GROW) { grow = calmNow ? GROW : Math.min(GROW, grow + dt); layout(grow); }
      ctl.update(); renderer.render(scene, cam); placeLabels();
    },
    resize() { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; W = w; H = h; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); },
    dispose() {
      ctl.dispose();
      scene.traverse(o => { o.geometry?.dispose(); [o.material].flat().forEach(x => x?.dispose()); if (o.isInstancedMesh) o.dispose(); });
      renderer.dispose(); renderer.forceContextLoss(); cv.remove(); labs.forEach(l => l.e.remove()); labs = [];
    },
  };
}

/* ---------------- the card: readout, stats, note, and the scene's life ---------------- */
/**
 * els: { el (the .ring3d), labs, read, stats, note, calm: () => bool, highs: () => {date: °F} (read when a day is shown, since
 * the weather archive can arrive after the card), onOpen(date) }.
 * The scene is built when the card first comes near the screen, renders only while it is near and the page is visible,
 * and is disposed (its WebGL context released) as soon as History stops being the open tab or hide() is called.
 */
export function yearRingCard({ el, labs, read, stats, note, calm = () => false, highs = () => null, onOpen }) {
  const view = el.closest('.view'), root = el.closest('.screen');
  let model = null, st = null, scene = null, io = null, ro = null, raf = 0, near = false, last = 0, selDate = null;
  const open = () => !view || view.classList.contains('on');

  function readout() {
    const s = selDate && model?.days.find(x => x.date === selDate);
    if (!s) {
      read.innerHTML = st?.present ? `<b>${st.covered == null ? '—' : Math.round(st.covered * 100) + '%'}</b><small>of home from solar</small><small>${Math.round(st.home / st.present)} kWh/day · last 365 days</small><small>tap a day to read it</small>`
        : '<b>—</b><small>loading…</small>';
      return;
    }
    const d = s.d, high = highs()?.[s.date], parts = [high != null ? `${Math.round(high)}°F` : '', d?.socMax == null ? '' : d.socMax >= 99 ? '<span class="bt">full at 100%</span>' : `peak ${Math.round(d.socMax)}%`].filter(Boolean);
    read.innerHTML = `<b>${niceDate(s.date)}</b>`
      + (d ? `<small><span class="s">${Math.round(d.solar)} kWh solar</span> · <span class="hm">${Math.round(d.home)} home</span></small>`
        + `<small><span class="im">${Math.round(d.import)} from PEC</span> · ${Math.round(d.export)} sent</small>` : '')
      + (parts.length ? `<small>${parts.join(' · ')}</small>` : '')
      + (s.outage ? `<small class="ot">outage · ${dur(s.outage)}</small>` : '')
      + '<a class="open" href="#">Open this day →</a>';
    read.querySelector('.open').onclick = e => { e.preventDefault(); onOpen?.(s.date); };
  }
  const slotOf = () => (selDate && model?.days.find(s => s.date === selDate)?.i) ?? -1;
  function select(i) { const s = model?.days[i]; selDate = s ? s.date : null; scene?.select(s ? s.i : -1); readout(); }

  function text() {
    if (!st?.present) { stats.innerHTML = ''; return; }
    const S = [['Solar · 12 mo', `${(st.solar / 1000).toFixed(1)} MWh`], ['Solar covered', st.covered == null ? '—' : `${Math.round(st.covered * 100)}% of home`],
      ['Full-battery days', `${st.full} of ${st.socDays}`], ['Outages', `${st.outages} · ${dur(st.outageMin)}`],
      ['Home/day Jul vs Dec', `${st.jul == null ? '—' : Math.round(st.jul)} vs ${st.dec == null ? '—' : Math.round(st.dec)} kWh`],
      ['Best solar day', st.best ? `${niceDate(st.best.date)} · ${Math.round(st.best.d.solar)} kWh` : '—']];
    stats.innerHTML = S.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');
    note.textContent = 'Bars share one scale, so solar, home and PEC heights compare directly. Last year shown where data exists: '
      + (st.ghost ? `${niceDate(st.ghostFrom)} – ${niceDate(st.ghostTo)}, ${st.ghost} of 365 days.` : 'none yet.')
      + (st.ghost < 365 ? ' The ghost closes into a full loop as the second year is stored.' : '');
  }

  function dispose() { cancelAnimationFrame(raf); raf = 0; ro?.disconnect(); ro = null; scene?.dispose(); scene = null; }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!open()) return dispose();                       // History is no longer the open tab: release the context
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (near && !document.hidden) scene.render(dt, calm());
  }
  function build() {
    if (scene || !open() || !st?.present) return;
    scene = createYearRing(el, { labs, calm: calm(), onTap: select });
    scene.setData(model); scene.select(slotOf());
    ro = new ResizeObserver(() => scene?.resize()); ro.observe(el);
    last = performance.now(); scene.render(0, calm()); raf = requestAnimationFrame(frame);
  }

  return {
    show(m) {
      model = m; st = yearStats(m);
      if (slotOf() < 0) selDate = null;   // the tapped day has left the 365-day window
      text(); readout();
      if (scene) { scene.setData(m); scene.select(slotOf()); }
      if (!io) { io = new IntersectionObserver(es => { near = es.at(-1).isIntersecting; if (near) build(); }, { root, rootMargin: '160px 0px' }); io.observe(el); }
      else if (near) build();
    },
    hide() { io?.disconnect(); io = null; near = false; dispose(); },
  };
}
