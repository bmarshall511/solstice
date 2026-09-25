import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/*
 * Day Ring (Insights → Today): 24 hours around a ring. Each hour is a bar stacked by what used the power
 * (pool pump, AC estimate, everything else) with solar as a gold ribbon outside. Modes morph the same bars.
 */
const COL = { rest: 0x8d93a8, ac: 0xff9e66, pool: 0x6cc4ff, solar: 0xffc15e };
const ang = h => (h / 24) * Math.PI * 2 - Math.PI / 2;

export function createDayRing(el, onPick) {
  const W = el.clientWidth || 353, H = el.clientHeight || 330;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(W, H); el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(38, W / H, .1, 100); cam.position.set(0, 9.6, 6.2);
  const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableZoom = false; ctl.enablePan = false; ctl.minPolarAngle = .35; ctl.maxPolarAngle = 1.0; ctl.target.set(0, .6, 0); ctl.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x0a0c14, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 8, 5); scene.add(key);
  const R = 3.1, group = new THREE.Group(); scene.add(group);
  const mat = c => new THREE.MeshStandardMaterial({ color: c, roughness: .55, metalness: .1, emissive: c, emissiveIntensity: .08 });
  const bars = [];
  for (let h = 0; h < 24; h++) {
    const g = new THREE.Group(); g.rotation.y = -ang(h); const parts = {};
    for (const k of ['rest', 'ac', 'pool']) { const m = new THREE.Mesh(new THREE.BoxGeometry(.5, 1, .42), mat(COL[k])); m.geometry.translate(0, .5, 0); m.position.x = R; parts[k] = m; g.add(m); }
    const s = new THREE.Mesh(new THREE.BoxGeometry(.18, 1, .62), new THREE.MeshStandardMaterial({ color: COL.solar, transparent: true, opacity: .55, emissive: COL.solar, emissiveIntensity: .25 })); s.geometry.translate(0, .5, 0); s.position.x = R + .55; parts.solar = s; g.add(s);
    group.add(g); bars.push({ h, parts, g });
  }
  const disc = new THREE.Mesh(new THREE.RingGeometry(R - .45, R + .95, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .05, side: THREE.DoubleSide })); disc.rotation.x = -Math.PI / 2; scene.add(disc);
  const hand = new THREE.Mesh(new THREE.BoxGeometry(.05, .02, R + 1.2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .35 })); hand.geometry.translate(0, 0, (R + 1.2) / 2); hand.position.y = .02; scene.add(hand);
  let target = null, cur = null, spin = true, picked = null, scale = .32, data = null;
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  function pick(e) { const r = renderer.domElement.getBoundingClientRect(); ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam);
    const hit = ray.intersectObjects(group.children, true)[0], h = hit ? bars.find(b => b.g === hit.object.parent)?.h : null;
    if (h !== picked) { picked = h; bars.forEach(b => Object.values(b.parts).forEach(p => p.material.emissiveIntensity = b.h === h ? .6 : (p === b.parts.solar ? .25 : .08))); onPick?.(h, data); } }
  renderer.domElement.addEventListener('pointermove', pick); renderer.domElement.addEventListener('pointerdown', e => { spin = false; pick(e); });
  return {
    /** d = { rest[24], ac[24], pool[24], solar[24] } in kWh per hour */
    setData(d) { data = d; const mx = Math.max(1, ...Array.from({ length: 24 }, (_, h) => d.rest[h] + d.ac[h] + d.pool[h]), ...d.solar); scale = 2.4 / mx;
      target = {}; bars.forEach(b => { const h = b.h; target[h] = { rest: d.rest[h] * scale, ac: d.ac[h] * scale, pool: d.pool[h] * scale, solar: d.solar[h] * scale }; });
      if (!cur) { cur = {}; bars.forEach(b => cur[b.h] = { ...target[b.h] }); } onPick?.(picked, data); },
    setHour(h) { hand.rotation.y = -ang(h) + Math.PI / 2; },
    render(dt, calm) { if (!target) return; if (spin && !calm) { group.rotation.y += .0025; disc.rotation.z += .0025; }
      bars.forEach(b => { for (const k in target[b.h]) cur[b.h][k] += (target[b.h][k] - cur[b.h][k]) * .08; const c = cur[b.h]; let y = 0; for (const k of ['rest', 'ac', 'pool']) { b.parts[k].scale.y = Math.max(.001, c[k]); b.parts[k].position.y = y; y += c[k]; } b.parts.solar.scale.y = Math.max(.001, c.solar); });
      ctl.update(); renderer.render(scene, cam); },
    resize() { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); },
  };
}
