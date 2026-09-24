import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { niceDate, clock12 } from '../lib/util.js';

/** 30 days × 24 hours of real solar production as 3D bars; underperforming days tinted red. Built lazily. */
export function createLandscape(host, tip) {
  let ready = false, renderer, labels, scene, camera, controls, bars, meta = [], grow = 0, data = null, dirty = false;
  const SX = .9, SZ = 1.05, HS = .55;
  const ramp = [0x1b2a4a, 0x3a6bd6, 0xffc15e, 0xfff1c9].map(c => new THREE.Color(c)), warn = new THREE.Color(0xff5a4e);
  const rampAt = t => { t = Math.max(0, Math.min(.999, t)) * 3; const i = Math.floor(t); return ramp[i].clone().lerp(ramp[i + 1], t - i); };
  function init() {
    ready = true;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);
    labels = new CSS2DRenderer(); Object.assign(labels.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.appendChild(labels.domElement);
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(36, 1, .1, 300); camera.position.set(22, 22, 30);
    controls = new OrbitControls(camera, renderer.domElement); Object.assign(controls, { enableDamping: true, enableZoom: false, enablePan: false, maxPolarAngle: Math.PI * .45, autoRotate: true, autoRotateSpeed: .5 });
    controls.target.set(0, 1, 0);
    scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x0b0d12, .7)); const k = new THREE.DirectionalLight(0xffffff, 1.2); k.position.set(10, 30, 20); scene.add(k);
    const gh = new THREE.GridHelper(40, 40, 0x2a2f3a, 0x1a1e26); gh.material.transparent = true; gh.material.opacity = .5; scene.add(gh);
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let sel = -1, selC = new THREE.Color(), down = null;
    renderer.domElement.addEventListener('pointerdown', e => down = [e.clientX, e.clientY]);
    renderer.domElement.addEventListener('pointerup', e => {
      if (!bars || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
      const r = host.getBoundingClientRect(); mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
      ray.setFromCamera(mouse, camera); const hit = ray.intersectObject(bars)[0];
      if (sel >= 0) { bars.setColorAt(sel, selC); sel = -1; }
      if (hit) { sel = hit.instanceId; bars.getColorAt(sel, selC); bars.setColorAt(sel, new THREE.Color(0xffffff)); const m = meta[sel];
        tip.innerHTML = `${niceDate(m.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock12(m.h)}–${clock12(m.h + 1)}<br><b>${m.kwh.toFixed(2)} kWh</b> produced${m.ratio != null ? ` · that day ran at ${Math.round(m.ratio * 100)}% of what its sunlight should give` : ''}`;
        controls.autoRotate = false; }
      bars.instanceColor.needsUpdate = true;
    });
    new ResizeObserver(resize).observe(host); resize();
  }
  function build() {
    dirty = false; if (bars) { scene.remove(bars); bars.geometry.dispose(); }
    scene.children.filter(o => o.isCSS2DObject || o.userData.day).forEach(o => { scene.remove(o); o.element?.remove(); });
    const { dates, solar, ratios } = data, D = dates.length, peak = Math.max(1, ...solar.flat().filter(v => v != null));
    bars = new THREE.InstancedMesh(new THREE.BoxGeometry(.72, 1, .86).translate(0, .5, 0), new THREE.MeshStandardMaterial({ roughness: .35, metalness: .15 }), D * 24);
    scene.add(bars); meta = [];
    dates.forEach((date, di) => solar[di].forEach((v, h) => { const i = di * 24 + h, kwh = v ?? 0;
      const c = rampAt(kwh / peak); if (ratios[di] != null && ratios[di] < .9 && kwh > .2) c.lerp(warn, .55); bars.setColorAt(i, c);
      meta[i] = { date, h, kwh, ratio: ratios[di], x: (h - 11.5) * SX, z: (di - D / 2 + .5) * SZ, y: Math.max(.04, kwh * HS * 8 / peak) }; }));
    const lab = (t, p, c = '') => { const e = document.createElement('div'); e.className = 'lax ' + c; e.textContent = t; const o = new CSS2DObject(e); o.position.copy(p); scene.add(o); };
    [['6a', 6], ['12p', 12], ['6p', 18]].forEach(([t, h]) => lab(t, new THREE.Vector3((h - 11.5) * SX, 0, D / 2 * SZ + 1.4)));
    [0, Math.floor(D / 3), Math.floor(D * 2 / 3), D - 1].forEach(di => lab(niceDate(dates[di]), new THREE.Vector3(12.4 * SX + 1.2, 0, (di - D / 2 + .5) * SZ), ratios[di] != null && ratios[di] < .9 ? 'w' : ''));
    grow = 0;
  }
  function resize() { const r = host.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); labels.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  return {
    setData(d) { data = d; dirty = true; },
    replay() { grow = 0; },
    render(dt, calm) {
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
