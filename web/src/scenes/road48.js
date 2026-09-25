import * as THREE from 'three';
import { touchIntent } from '../lib/touchorbit.js';

/*
 * Next 48 hours as a road (Now → Next 48 hours; mockups/l-forecast48.html, docs/audit-designs/visualizations.md §4).
 * x = hours from now, one unit per hour. Solar is the near lane (z +1.2), the home's load the middle lane (z 0) and the
 * Powerwalls' charge the wall at the back (z −1.2) with the reserve dashed across it. The floor darkens at night and under
 * cloud; the strip at the front shows the pool (front row) and AC pre-cool / coast (back row) windows, applied solid and planned
 * outlined. Horizontal drag drives along x, vertical drag scrolls the page, a tap shows that hour's numbers in the readout.
 * 8 draw calls, MeshBasic only, no lights, no shadows.
 *
 * Scene host rules (§2): renders on demand and only while the card is on screen; DPR capped at 1.5; when the Now tab is left the
 * WebGL context is disposed (geometries, materials, overlays, renderer) and rebuilt from the last model on return.
 */
const DPR_CAP = 1.5, MAX_LABELS = 4;
const TGT = new THREE.Vector3(15, 1.3, 0), OFF = new THREE.Vector3(-22, 3.4, 6).multiplyScalar(1.22);
const ROW = { pool: [2.02, 2.26], boost: [2.05, 2.23], pre: [1.72, 1.94], coast: [1.72, 1.94] };
const CSSVAR = { pool: 'var(--home)', pre: 'var(--batt)', coast: 'var(--grid)' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const V3 = THREE.Vector3;

let glOk = null;
/** WebGL2 available? (three.js needs it; without it the card keeps the SVG chart.) */
export function webgl2() {
  if (glOk == null) {
    try { const g = document.createElement('canvas').getContext('webgl2'); glOk = !!g; g?.getExtension('WEBGL_lose_context')?.loseContext(); }
    catch { glOk = false; }
  }
  return glOk;
}

let PAL = null;
const palette = () => PAL ??= (() => {
  const css = getComputedStyle(document.documentElement), tok = n => new THREE.Color(css.getPropertyValue(n).trim() || '#8d93a8');
  return { solar: tok('--solar'), batt: tok('--batt'), home: tok('--home'), grid: tok('--grid'), warn: tok('--warn'), out: tok('--out'), rest: tok('--rest'), white: new THREE.Color(1, 1, 1) };
})();

/** The scene's meshes and label overlays for one model (lib/road48data.js roadModel). */
function buildContent(M, el) {
  const PL = palette(), n = M.n, H = M.hours, scene = new THREE.Scene(), m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion();

  // floor: one tile per hour, night/day and cloud shading per instance
  const floor = new THREE.InstancedMesh(new THREE.PlaneGeometry(.94, 4.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial(), n);
  const tileCol = H.map(p => PL.rest.clone().multiplyScalar((p.night ? .025 : p.dusk ? .045 : .09) * (1 - .6 * Math.max(0, p.c - .08) / .92)));
  H.forEach((p, k) => { m4.makeTranslation(k + .5, 0, .35); floor.setMatrixAt(k, m4); floor.setColorAt(k, tileCol[k]); });
  floor.instanceColor.needsUpdate = true; scene.add(floor);

  // lanes: vertical ribbons (indexed triangle strips), brighter at the top edge
  function ribbon(xs, ys, z, col, bot, opacity, order) {
    const len = xs.length, pos = new Float32Array(len * 6), cc = new Float32Array(len * 6), idx = [], b = col.clone().multiplyScalar(bot);
    for (let i = 0; i < len; i++) { pos.set([xs[i], 0, z, xs[i], ys[i], z], i * 6); cc.set([b.r, b.g, b.b, col.r, col.g, col.b], i * 6); if (i < len - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(cc, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    m.renderOrder = order; scene.add(m); return m;
  }
  const lx = [0, ...H.map((_, k) => k + .5), n];
  const laneY = f => [f(H[0]), ...H.map(f), f(H[n - 1])];
  const sY = laneY(p => .25 * p.s), hY = laneY(p => .25 * p.h);
  const socPts = [[0, M.soc0]]; H.forEach((p, k) => { if (M.full && M.full.x >= k && M.full.x < k + 1) socPts.push([M.full.x, 1]); socPts.push([k + 1, p.soc]); });
  const socX = socPts.map(p => p[0]), socY = socPts.map(p => 2.5 * p[1]);
  const socWall = ribbon(socX, socY, -1.2, PL.batt, .1, .55, 2);
  const homeLane = ribbon(lx, hY, 0, PL.home, .6, .35, 3);
  const solarLane = ribbon(lx, sY, 1.2, PL.solar, .3, .62, 4);

  // reserve: dashed, --out, at 2.5 × reserve on the SOC wall
  const res = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(0, 2.5 * M.reserve, -1.2), new V3(n, 2.5 * M.reserve, -1.2)]), new THREE.LineDashedMaterial({ color: PL.out, dashSize: .35, gapSize: .25 }));
  res.computeLineDistances(); res.renderOrder = 5; scene.add(res);

  // schedule gutter: pool row (front) and AC row; planned windows are dim with an outline
  const KCOL = { pool: PL.home, boost: PL.home, pre: PL.batt, coast: PL.grid };
  const LP = [], LC = []; const seg = (a, b, c) => { LP.push(...a, ...b); LC.push(c.r, c.g, c.b, c.r, c.g, c.b); };
  const boxEdges = (x0, x1, y0, y1, z0, z1, c) => { const X = [x0, x1], Y = [y0, y1], Z = [z0, z1];
    for (const y of Y) for (const z of Z) seg([x0, y, z], [x1, y, z], c);
    for (const x of X) for (const z of Z) seg([x, y0, z], [x, y1, z], c);
    for (const x of X) for (const y of Y) seg([x, y, z0], [x, y, z1], c); };
  if (M.windows.length) {
    const gut = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), M.windows.length);
    M.windows.forEach((w, i) => { const [z0, z1] = ROW[w.kind], hgt = w.kind === 'boost' ? .24 : .1, c = KCOL[w.kind];
      m4.compose(new V3((w.a + w.b) / 2, hgt / 2, (z0 + z1) / 2), q0, new V3(Math.max(.02, w.b - w.a - .06), hgt, z1 - z0)); gut.setMatrixAt(i, m4);
      gut.setColorAt(i, c.clone().multiplyScalar(w.plan ? .1 : w.kind === 'boost' ? 1 : .6));
      if (w.plan) boxEdges(w.a + .03, w.b - .03, 0, hgt + .004, z0, z1, c); });
    gut.instanceColor.needsUpdate = true; gut.renderOrder = 1; scene.add(gut);
  }

  // every thin line in one LineSegments: home edge, SOC edge, now line, midnights, planned outlines
  for (let i = 0; i < lx.length - 1; i++) seg([lx[i], hY[i], 0], [lx[i + 1], hY[i + 1], 0], PL.home);
  for (let i = 0; i < socX.length - 1; i++) seg([socX[i], socY[i], -1.2], [socX[i + 1], socY[i + 1], -1.2], PL.batt);
  seg([0, 0, -1.2], [0, 2.95, -1.2], PL.white); seg([0, .01, -1.75], [0, .01, 2.4], PL.white);
  const mid = PL.rest.clone().multiplyScalar(.22);
  H.forEach((p, k) => { if (p.midnight) seg([k, .012, -1.75], [k, .012, 2.4], mid); });
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(LC, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true })); lines.renderOrder = 6; scene.add(lines);

  // markers: full (--batt) and lowest (--warn)
  const marks = [M.full && [M.full.x, 2.5, PL.batt], M.low && [M.low.x, 2.5 * M.low.soc, PL.warn]].filter(Boolean);
  if (marks.length) {
    const sph = new THREE.InstancedMesh(new THREE.SphereGeometry(.17, 16, 12), new THREE.MeshBasicMaterial(), marks.length);
    marks.forEach(([x, y, c], i) => { m4.makeTranslation(x, y, -1.2); sph.setMatrixAt(i, m4); sph.setColorAt(i, c); });
    sph.instanceColor.needsUpdate = true; sph.renderOrder = 7; scene.add(sph);
  }

  // DOM labels: at most 4 at once; day-2 windows take over from today's once the view passes tomorrow's midnight
  const todayLabels = M.windows.some(w => w.day === 0 && w.label);
  const dayAt = d => d >= M.day2At || !todayLabels ? 1 : 0;
  const LBL = [
    M.full && { txt: M.full.txt, at: [M.full.x, 2.5, -1.2], color: 'var(--batt)', on: () => true },
    M.low && { txt: M.low.txt, at: [M.low.x, 2.5 * M.low.soc, -1.2], w: true, on: () => true },
    ...['pre', 'pool', 'coast'].flatMap(kind => M.windows.filter(w => w.kind === kind && w.label).map(w => ({
      txt: w.label, at: [kind === 'pool' ? Math.min(w.a + 1.5, (w.a + w.b) / 2) : (w.a + w.b) / 2, .12, (ROW[kind][0] + ROW[kind][1]) / 2], color: CSSVAR[kind],
      on: d => w.day === dayAt(d) }))),
    M.rain && { txt: M.rain.txt, at: [M.rain.k + .5, 2.2, .6], color: 'var(--dim)', on: () => true },
  ].filter(Boolean);
  LBL.forEach(l => { const e = document.createElement('div'); e.className = 'lax rl' + (l.w ? ' w' : ''); if (l.color) e.style.color = l.color; e.textContent = l.txt; el.appendChild(e); l.el = e; });

  return { scene, floor, tileCol, pick: [solarLane, homeLane, socWall], labels: LBL };
}

/**
 * Mount the road in `el` (a .ring3d.road holding a .hud) with its tap readout `tip`.
 * `model()` returns the current roadModel (or null); it is read on refresh() and whenever the card comes back on screen.
 */
export function createRoad48(el, tip, { model, calm = () => false }) {
  const hud = el.querySelector('.hud'), placeholder = tip.innerHTML;
  let M = null, key = '', G = null, C = null, W = 0, H = 0;
  let d = 0, dT = 0, selT = null, visible = false, raf = 0, last = 0;
  const dmax = () => Math.max(0, (M?.n ?? 48) - 14);

  /* ---------- lifecycle ---------- */
  function build() {
    if (G || !M || !visible) return;
    W = el.clientWidth; H = el.clientHeight; if (!W || !H) return;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); } catch (e) { console.warn('road48', e.message); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, DPR_CAP)); renderer.setSize(W, H); el.prepend(renderer.domElement);
    G = { renderer, cam: new THREE.PerspectiveCamera(34, W / H, .1, 120) };
    content();
  }
  function content() {
    if (C) dropContent();
    C = buildContent(M, el); measure(); paintSel();
  }
  function dropContent() {
    C.scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    C.labels.forEach(l => l.el.remove()); C = null;
  }
  function dispose() {
    if (!G) return;
    cancelAnimationFrame(raf); raf = 0; last = 0;
    if (C) dropContent();
    G.renderer.dispose(); G.renderer.forceContextLoss(); G.renderer.domElement.remove(); G = null;
  }
  /** Re-read the model; rebuild the meshes only when it changed. */
  function refresh() {
    const m = model(); if (!m) return;
    const k = JSON.stringify(m); if (k === key) return;
    key = k; M = m; dT = clamp(dT, 0, dmax()); d = clamp(d, 0, dmax());
    if (selT && !M.hours.some(h => h.t === selT)) selT = null;
    if (G) content(); else build();
    showTip(); kick();
  }

  /* ---------- labels: projected, clamped inside the card, de-overlapped, at most 4 ---------- */
  function measure() { C?.labels.forEach(l => { l.el.style.display = 'block'; l.bw = l.el.offsetWidth; l.bh = l.el.offsetHeight; l.el.style.display = 'none'; }); }
  document.fonts?.ready.then(() => { measure(); kick(); });
  const pv = new V3(), cv = new V3();
  function placeLabels(dd) {
    const placed = [], cam = G.cam;
    for (const l of C.labels) {
      let show = false;
      if (placed.length < MAX_LABELS && l.on(dd)) {
        pv.set(...l.at); cv.copy(pv).applyMatrix4(cam.matrixWorldInverse); pv.project(cam);
        const px = (pv.x + 1) / 2 * W, py = (1 - pv.y) / 2 * H;
        if (cv.z < -.2 && px > -6 && px < W + 6 && py > 0 && py < H) {
          let x = clamp(px - l.bw / 2, 4, W - 4 - l.bw), y = clamp(py - l.bh - 6, 4, H - 4 - l.bh), ok = true;
          for (let i = 0; i < 4; i++) { const hit = placed.find(r => x < r.x + r.w + 2 && x + l.bw + 2 > r.x && y < r.y + r.h + 2 && y + l.bh + 2 > r.y);
            if (!hit) break; y = hit.y - l.bh - 3; if (y < 4 || i === 3) { ok = false; break; } }
          if (ok) { show = true; placed.push({ x, y, w: l.bw, h: l.bh }); l.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; }
        }
      }
      l.el.style.display = show ? 'block' : 'none';
    }
  }

  /* ---------- tap readout ---------- */
  const selK = () => selT ? M.hours.findIndex(h => h.t === selT) : -1;
  function paintSel() {
    if (!C) return;
    const k = selK();
    C.tileCol.forEach((c, i) => C.floor.setColorAt(i, i === k ? palette().solar.clone().multiplyScalar(.28) : c));
    C.floor.instanceColor.needsUpdate = true;
  }
  function showTip() { const k = M ? selK() : -1; tip.innerHTML = k >= 0 ? M.hours[k].readout : placeholder; }
  function select(k) { selT = M.hours[k].t; paintSel(); showTip(); kick(); }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function tap(e) {
    if (!G || !C) return;
    const r = el.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, G.cam);
    const f = ray.intersectObject(C.floor)[0]; if (f) return select(f.instanceId);
    const h = ray.intersectObjects(C.pick)[0]; if (h) select(clamp(Math.floor(h.point.x), 0, M.n - 1));
  }

  /* ---------- drive: horizontal drag slides along x (damped); vertical drag is left to the page (touch-action: pan-y) ---------- */
  let st = null; const down = new Set();
  el.addEventListener('pointerdown', e => {
    if (e.button) return;
    if (e.isPrimary) down.clear();   // a new first touch: any pointer still listed lost its pointerup
    down.add(e.pointerId);
    st = down.size > 1 ? null : { x: e.clientX, y: e.clientY, d: dT, id: e.pointerId, intent: null };   // a second finger never drives
  });
  el.addEventListener('pointermove', e => {
    if (!st || e.pointerId !== st.id || !G) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.intent) { st.intent = touchIntent(dx, dy); if (st.intent === 'orbit') { try { el.setPointerCapture(e.pointerId); } catch {} } }
    if (st.intent === 'orbit') { dT = clamp(st.d - dx * 24 / W, 0, dmax()); kick(); }
  });
  el.addEventListener('pointerup', e => { if (st && e.pointerId === st.id && !st.intent) tap(e); st = null; down.delete(e.pointerId); });
  el.addEventListener('pointercancel', e => { st = null; down.delete(e.pointerId); });   // the browser took the gesture (it scrolls the page)
  el.tabIndex = 0;
  el.addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { dT = clamp(dT + (e.key === 'ArrowRight' ? 3 : -3), 0, dmax()); kick(); e.preventDefault(); } });

  /* ---------- render on demand, only while on screen ---------- */
  function kick() { if (!raf && visible && G) raf = requestAnimationFrame(loop); }
  function loop(t) {
    raf = 0; if (!visible || !G || !C) return;
    const dt = last ? Math.min(.05, (t - last) / 1000) : .016; last = t;
    d = calm() ? dT : d + (dT - d) * (1 - Math.exp(-dt * 8)); if (Math.abs(dT - d) < .003) d = dT;
    const cam = G.cam;
    cam.position.set(TGT.x + OFF.x + d, TGT.y + OFF.y, TGT.z + OFF.z); cam.lookAt(TGT.x + d, TGT.y, TGT.z); cam.updateMatrixWorld();
    G.renderer.render(C.scene, cam); placeLabels(d);
    hud.textContent = M.hours[clamp(Math.round(d), 0, M.n - 1)].hud;
    if (d !== dT) kick(); else last = 0;
  }
  const io = new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (visible) { refresh(); build(); kick(); }
    else if (!el.offsetParent) dispose();   // the Now tab was left: free the WebGL context
  }, { root: document.getElementById('screen'), rootMargin: '160px 0px' });
  io.observe(el);
  new ResizeObserver(() => {
    if (!G || !el.clientWidth || !el.clientHeight) return;
    W = el.clientWidth; H = el.clientHeight; G.renderer.setSize(W, H); G.cam.aspect = W / H; G.cam.updateProjectionMatrix(); measure(); kick();
  }).observe(el);

  return { refresh, dispose };
}
