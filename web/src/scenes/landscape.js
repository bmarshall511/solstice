import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchOrbit } from '../lib/touchorbit.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { niceDate, clock12 } from '../lib/util.js';
import { gestureState, clampTarget, orbitZoom, expandButton, openSceneSheet } from '../lib/scenesheet.js';

const SX = .9, SZ = 1.05, HS = .55;
const ramp = [0x1b2a4a, 0x3a6bd6, 0xffc15e, 0xfff1c9].map(c => new THREE.Color(c)), warn = new THREE.Color(0xff5a4e);
const rampAt = t => { t = Math.max(0, Math.min(.999, t)) * 3; const i = Math.floor(t); return ramp[i].clone().lerp(ramp[i + 1], t - i); };
const CARD_POS = new THREE.Vector3(22, 22, 30), TARGET = new THREE.Vector3(0, 1, 0), MAX_POLAR = Math.PI * .45;

/** The tap readout for one bar. */
const tipText = m => `${niceDate(m.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock12(m.h)}–${clock12(m.h + 1)}<br><b>${m.kwh.toFixed(2)} kWh</b> produced${m.ratio != null ? ` · that day ran at ${Math.round(m.ratio * 100)}% of what its sunlight should give` : ''}`;

/** The bars (colour set, matrices left to the caller) and each bar's meta, for one data set. */
function makeBars(data) {
  const { dates, solar, ratios } = data, D = dates.length, peak = Math.max(1, ...solar.flat().filter(v => v != null));
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(.72, 1, .86).translate(0, .5, 0), new THREE.MeshStandardMaterial({ roughness: .35, metalness: .15 }), D * 24);
  const meta = [];
  dates.forEach((date, di) => solar[di].forEach((v, h) => { const i = di * 24 + h, kwh = v ?? 0;
    const c = rampAt(kwh / peak); if (ratios[di] != null && ratios[di] < .9 && kwh > .2) c.lerp(warn, .55); bars.setColorAt(i, c);
    meta[i] = { date, h, kwh, ratio: ratios[di], x: (h - 11.5) * SX, z: (di - D / 2 + .5) * SZ, y: Math.max(.04, kwh * HS * 8 / peak) }; }));
  return { bars, meta };
}
const lab = (scene, t, p, c = '') => { const e = document.createElement('div'); e.className = 'lax ' + c; e.textContent = t; const o = new CSS2DObject(e); o.position.copy(p); scene.add(o); return o; };
const dayLabel = (scene, data, di) => lab(scene, niceDate(data.dates[di]), new THREE.Vector3(12.4 * SX + 1.2, 0, (di - data.dates.length / 2 + .5) * SZ), data.ratios[di] != null && data.ratios[di] < .9 ? 'w' : '');
const hourLabels = (scene, D) => [['6a', 6], ['12p', 12], ['6p', 18]].forEach(([t, h]) => lab(scene, t, new THREE.Vector3((h - 11.5) * SX, 0, D / 2 * SZ + 1.4)));
function lights(scene) {
  scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x0b0d12, .7)); const k = new THREE.DirectionalLight(0xffffff, 1.2); k.position.set(10, 30, 20); scene.add(k);
  const gh = new THREE.GridHelper(40, 40, 0x2a2f3a, 0x1a1e26); gh.material.transparent = true; gh.material.opacity = .5; scene.add(gh);
}

/** 30 days × 24 hours of real solar production as 3D bars; underperforming days tinted red. Built lazily. */
export function createLandscape(host, tip) {
  let ready = false, renderer, labels, scene, camera, controls, bars, meta = [], grow = 0, data = null, dirty = false;
  let sel = -1, paused = false; const selC = new THREE.Color();
  function paint(i) {   // the tapped bar turns white; -1 clears
    if (sel >= 0 && bars) bars.setColorAt(sel, selC);
    sel = i >= 0 && bars && i < meta.length ? i : -1;
    if (sel >= 0) { bars.getColorAt(sel, selC); bars.setColorAt(sel, new THREE.Color(0xffffff)); tip.innerHTML = tipText(meta[sel]); }
    if (bars) bars.instanceColor.needsUpdate = true;
  }
  function init() {
    ready = true;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);
    labels = new CSS2DRenderer(); Object.assign(labels.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.appendChild(labels.domElement);
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(36, 1, .1, 300); camera.position.copy(CARD_POS);
    controls = new OrbitControls(camera, renderer.domElement); Object.assign(controls, { enableDamping: true, enableZoom: false, enablePan: false, maxPolarAngle: MAX_POLAR, autoRotate: true, autoRotateSpeed: .5 }); touchOrbit(controls);
    controls.target.copy(TARGET);
    lights(scene);
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let down = null;
    renderer.domElement.addEventListener('pointerdown', e => down = [e.clientX, e.clientY]);
    renderer.domElement.addEventListener('pointerup', e => {
      if (!bars || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
      const r = host.getBoundingClientRect(); mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
      ray.setFromCamera(mouse, camera); const hit = ray.intersectObject(bars)[0];
      paint(hit ? hit.instanceId : -1);
      if (hit) controls.autoRotate = false;
    });
    new ResizeObserver(resize).observe(host); resize();
  }
  function build() {
    dirty = false; if (bars) { scene.remove(bars); bars.geometry.dispose(); }
    scene.children.filter(o => o.isCSS2DObject || o.userData.day).forEach(o => { scene.remove(o); o.element?.remove(); });
    ({ bars, meta } = makeBars(data)); scene.add(bars); sel = -1;
    const D = data.dates.length;
    hourLabels(scene, D);
    [0, Math.floor(D / 3), Math.floor(D * 2 / 3), D - 1].forEach(di => dayLabel(scene, data, di));
    grow = 0;
  }
  function resize() { const r = host.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); labels.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();

  /* expand (mockups/s-expand.html frames 4–5): the card's angle and tapped bar go in and come back; auto-rotate stops */
  let calmNow = false;
  expandButton(host, 'Open Production landscape full screen', btn => {
    if (!data || !data.dates.length) return;
    if (controls) controls.autoRotate = false;
    paused = true;
    const dir = camera ? camera.position.clone().sub(controls.target).normalize() : CARD_POS.clone().sub(TARGET).normalize();
    openLandscapeSheet({ data, dir, pick: sel, from: btn, calm: () => calmNow,
      title: host.closest('.card')?.querySelector('.h b')?.textContent ?? 'Last 30 days × 24 hours',
      legend: host.closest('.card')?.querySelector('.legend')?.innerHTML ?? '',
      onClose: back => {
        paused = false;
        if (camera) { camera.position.copy(controls.target).addScaledVector(back.dir, CARD_POS.distanceTo(TARGET)); controls.update(); }
        if (back.pick !== sel) paint(back.pick);
      } });
  });

  return {
    setData(d) { data = d; dirty = true; },
    replay() { grow = 0; },
    render(dt, calm) {
      calmNow = calm;
      if (paused) return;   // the full-screen sheet is open: only one scene renders at a time
      if (!ready) init();
      if (dirty && data) build();
      if (!bars) return;
      if (grow < 1) { grow = Math.min(1, grow + dt * .5); const D = data.dates.length;
        for (let i = 0; i < meta.length; i++) { const di = Math.floor(i / 24), k = Math.max(0, Math.min(1, grow * 2.2 - di / D * 1.2)), e = 1 - Math.pow(1 - k, 3), m = meta[i];
          ps.set(m.x, 0, m.z); sc.set(1, m.y * e, 1); m4.compose(ps, q, sc); bars.setMatrixAt(i, m4); }
        bars.instanceMatrix.needsUpdate = true; }
      controls.autoRotate = controls.autoRotate && !calm;
      controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
    },
  };
}

/* ================= the sheet (mockups/s-expand.html frame 5) =================
 * Opens at the card's angle, pulled back so all 30 rows fit a tall screen (zoom 1×), up to 6×. OrbitControls' standard touch
 * mapping (one finger rotates and tilts within the card's 81° limit, two fingers dolly + pan toward the pinch point); the target
 * stays over the grid. Auto-rotate is off. Every fifth day is labelled, plus the tapped day. */
const SHEET_DIST = CARD_POS.clone().multiplyScalar(1.62).distanceTo(TARGET), Z_MAX = 6;

function openLandscapeSheet({ data, dir, pick, from, calm, title, legend, onClose }) {
  const handback = { dir: dir.clone(), pick };
  const D = data.dates.length, span = D / 2 * SZ + .25;
  const BOX = { x: [-11, 11], y: [0, 5], z: [-span, span] };
  openSceneSheet({
    title, legend, calm, from,
    tip: 'Each bar is one hour of solar production.',
    label: 'Production landscape, full screen. Pinch to zoom, two fingers to pan, drag to rotate, tap a bar for its numbers.',
    hint: 'pinch to zoom · two fingers to pan · drag to rotate',
    onClose: () => onClose(handback),
    mount(bits) {
      const host = bits.scene, still = bits.calm;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = THREE.ACESFilmicToneMapping;
      host.prepend(renderer.domElement);
      const labels = new CSS2DRenderer(); Object.assign(labels.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.appendChild(labels.domElement);
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(36, 1, .1, 300);
      const homeT = TARGET.clone(), homePos = homeT.clone().addScaledVector(dir, SHEET_DIST);
      camera.position.copy(homePos);
      const controls = new OrbitControls(camera, renderer.domElement);
      Object.assign(controls, { enableDamping: !still, enableZoom: true, enablePan: true, screenSpacePanning: true, zoomToCursor: true, maxPolarAngle: MAX_POLAR, autoRotate: false,
        minDistance: SHEET_DIST / Z_MAX, maxDistance: SHEET_DIST, touches: { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } });
      controls.target.copy(homeT); controls.update();
      lights(scene);

      const { bars, meta } = makeBars(data); scene.add(bars);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
      meta.forEach((m, i) => { ps.set(m.x, 0, m.z); sc.set(1, m.y, 1); m4.compose(ps, q, sc); bars.setMatrixAt(i, m4); });
      hourLabels(scene, D);
      const every = [...new Set([...Array.from({ length: Math.ceil(D / 5) }, (_, i) => i * 5), D - 1])];
      every.forEach(di => dayLabel(scene, data, di));
      let extra = null;   // the tapped day, when it is not one of the fifth days
      let sel = -1; const selC = new THREE.Color();
      function select(i) {
        if (sel >= 0) bars.setColorAt(sel, selC);
        sel = i;
        if (sel >= 0) { bars.getColorAt(sel, selC); bars.setColorAt(sel, new THREE.Color(0xffffff)); bits.tip.innerHTML = tipText(meta[sel]); }
        bars.instanceColor.needsUpdate = true;
        if (extra) { scene.remove(extra); extra.element.remove(); extra = null; }
        const di = sel >= 0 ? Math.floor(sel / 24) : -1;
        if (di >= 0 && !every.includes(di)) extra = dayLabel(scene, data, di);
        handback.pick = sel;
      }
      if (pick >= 0 && pick < meta.length) select(pick);

      /* one finger rotates; once a second finger lands, lifting one does not restart the rotation (all fingers up first) */
      const g = gestureState(), ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), el = renderer.domElement;
      const local = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      el.addEventListener('pointerdown', e => {
        if (e.button) return;
        g.down(e.pointerId, ...local(e), e.isPrimary && e.pointerType === 'touch');
        if (g.multi) controls.touches.ONE = null;
      }, { capture: true });
      el.addEventListener('pointermove', e => g.move(e.pointerId, ...local(e)), { capture: true });
      const up = e => {
        const r = g.up(e.pointerId, ...local(e), e.type === 'pointercancel');
        if (!g.count) controls.touches.ONE = THREE.TOUCH.ROTATE;
        if (!r) return;
        const b = host.getBoundingClientRect(); mouse.set(r.x / b.width * 2 - 1, -r.y / b.height * 2 + 1);
        ray.setFromCamera(mouse, camera); const hit = ray.intersectObject(bars)[0];
        if (hit) select(hit.instanceId);
      };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);

      /* the target stays over the grid; the camera moves with it so the angle holds */
      const tv = new THREE.Vector3();
      controls.addEventListener('change', () => { const s = clampTarget(controls.target, BOX); if (s.x || s.y || s.z) camera.position.add(tv.set(s.x, s.y, s.z)); });

      /* reset: back to the opening view (eased unless Calm) */
      let tween = null;
      function reset() {
        if (still) { controls.target.copy(homeT); camera.position.copy(homePos); controls.update(); return; }
        tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone() };
      }
      const zoom = () => orbitZoom(SHEET_DIST, camera.position.distanceTo(controls.target), Z_MAX);

      let W = 0, H = 0, keep = bits.keepOut();
      function resize() {
        const r = host.getBoundingClientRect(); if (!r.width) return; W = r.width; H = r.height;
        renderer.setSize(W, H); labels.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix();
        keep = bits.keepOut(); labels.domElement.style.clipPath = `inset(${keep.top}px 0 ${keep.bottom}px 0)`;   // labels never sit under the bars
      }
      const ro = new ResizeObserver(resize); ro.observe(host); resize();

      let raf = 0, last = 0, alive = true;
      const fmt = d => niceDate(d);
      function loop(t) {
        if (!alive) return; raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(.05, (t - last) / 1000) : .016; last = t;
        if (tween) { tween.t = Math.min(1, tween.t + dt / .45); const e = 1 - Math.pow(1 - tween.t, 3);
          controls.target.lerpVectors(tween.t0, homeT, e); camera.position.lerpVectors(tween.p0, homePos, e); if (tween.t >= 1) tween = null; }
        controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
        const z = zoom();
        bits.setZoom(z, z < 1.01 && controls.target.distanceTo(homeT) < .05 && camera.position.distanceTo(homePos) < .05);
        bits.hud.textContent = `${fmt(data.dates[0])} – ${fmt(data.dates[D - 1])} · ${z < 1.05 ? `all ${D} days` : z.toFixed(1) + '×'}`;
        handback.dir.copy(camera.position).sub(controls.target).normalize();
      }
      raf = requestAnimationFrame(loop);

      return {
        reset,
        onKey(e) {
          const step = Math.PI / 24;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { controls.rotateLeft(e.key === 'ArrowLeft' ? step : -step); return true; }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { controls.rotateUp(e.key === 'ArrowUp' ? step : -step); return true; }
          if (e.key === '+' || e.key === '=') { controls.dollyIn(1.25); return true; }
          if (e.key === '-' || e.key === '_') { controls.dollyOut(1.25); return true; }
          return false;
        },
        dispose() {
          alive = false; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
          scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
          scene.children.filter(o => o.isCSS2DObject).forEach(o => o.element?.remove());
          renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); labels.domElement.remove();
        },
      };
    },
  });
}
