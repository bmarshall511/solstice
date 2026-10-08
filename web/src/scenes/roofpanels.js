import * as THREE from 'three';
import { tint, RED } from '../lib/panels.js';

/*
 * The Live roof's Per panel layer (approved mockup u-panels). A second layer on the same 30 panels, nothing new standing on the roof:
 * one InstancedMesh of thin tint quads just above each panel's glass (one draw call), a white outline for the selected panel, and a
 * readout strip pinned to it by a leader line. A tap (under 6 px of movement) picks a panel, only while the layer is on; a drag still
 * rotates. Selecting pauses the slow auto-rotate. The readout's HTML comes from views/panels.js.
 */
export function createPanelLayer({ H, camera, controls, canvas, host, hud }) {
  const qGeo = new THREE.PlaneGeometry(1.5, .99); qGeo.rotateX(-Math.PI / 2);
  const aCol = new THREE.InstancedBufferAttribute(new Float32Array(30 * 3), 3), aA = new THREE.InstancedBufferAttribute(new Float32Array(30), 1);
  qGeo.setAttribute('aCol', aCol); qGeo.setAttribute('aA', aA);
  const qMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: false,
    vertexShader: `attribute vec3 aCol;attribute float aA;varying vec3 vC;varying float vA;void main(){vC=aCol;vA=aA;vec4 p=vec4(position,1.);
      #ifdef USE_INSTANCING
      p=instanceMatrix*p;
      #endif
      gl_Position=projectionMatrix*modelViewMatrix*p;}`,
    fragmentShader: `varying vec3 vC;varying float vA;void main(){gl_FragColor=vec4(vC,vA);}` });
  const quads = new THREE.InstancedMesh(qGeo, qMat, 30), m4 = new THREE.Matrix4(), POS = H.panels.map(p => p.position.clone());
  POS.forEach((p, k) => quads.setMatrixAt(k, m4.makeTranslation(p.x, p.y + .032, p.z)));
  quads.frustumCulled = false; quads.visible = false; H.arr.add(quads);
  const selEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.6, .08, 1.09)), new THREE.LineBasicMaterial({ color: 0xffffff, fog: false }));
  selEdge.visible = false; H.arr.add(selEdge);

  const pin = document.createElement('div'); pin.className = 'pin';
  pin.innerHTML = '<svg><line stroke="rgba(255,255,255,.75)" stroke-width="1"/><circle r="3.5" fill="#fff"/></svg><div class="ro"></div>';
  host.appendChild(pin);
  const ld = pin.querySelector('line'), dt = pin.querySelector('circle'), ro = pin.querySelector('.ro');

  const L = { on: false, sel: null, onPick: null };
  /** ratios[k] (panel ÷ median panel, null = no tint) and flags[k] (an open panel.low anomaly: red). */
  L.setTints = (ratios, flags = []) => {
    for (let k = 0; k < 30; k++) {
      const t = flags[k] ? { rgb: RED, a: .6 } : tint(ratios[k]);
      aCol.setXYZ(k, ...(t ? t.rgb : [1, 1, 1])); aA.setX(k, t ? t.a : 0);
    }
    aCol.needsUpdate = aA.needsUpdate = true;
  };
  L.setOn = v => { L.on = !!v; quads.visible = L.on; if (!L.on) L.select(null); };
  L.select = k => {
    L.sel = k ?? null; selEdge.visible = L.sel != null; controls.autoRotate = L.sel == null;
    if (L.sel == null) { pin.classList.remove('on'); ro.innerHTML = ''; return; }
    selEdge.position.copy(POS[L.sel]); pin.classList.add('on');
  };
  L.setReadout = html => { ro.innerHTML = html; };
  ro.addEventListener('click', e => { if (/** @type {Element} */ (e.target).closest('button[data-x]')) L.onPick?.(null); });

  // tap vs drag: a pointer that moves under 6 px picks the panel under it (or clears on empty sky)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null;
  const onDown = e => { down = [e.clientX, e.clientY]; };
  const onUp = e => {
    if (!down || !L.on) return; const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null; if (moved > 6) return;
    const r = canvas.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(H.panels, false)[0]; L.onPick?.(hit ? H.panels.indexOf(hit.object) : null);
  };
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);

  // keep the readout pinned: a full-width strip docked at the bottom of the scene when the panel sits in the upper part, else just under the HUD
  const v = new THREE.Vector3();
  L.frame = () => {
    if (L.sel == null) return;
    v.copy(POS[L.sel]); H.arr.localToWorld(v); v.project(camera);
    const w = canvas.clientWidth, h = canvas.clientHeight, sx = (v.x + 1) / 2 * w, sy = (1 - v.y) / 2 * h, bh = /** @type {HTMLElement} */ (ro).offsetHeight;
    const hb = hud ? hud.offsetTop + hud.offsetHeight + 8 : 8;
    const bx = 8, by = sy < h * .62 ? h - bh - 8 : hb;
    ro.style.width = (w - 16) + 'px'; ro.style.transform = `translate(${bx}px,${by}px)`;
    const ex = Math.max(bx + 16, Math.min(bx + w - 32, sx)), ey = by > sy ? by : by + bh;
    ld.setAttribute('x1', String(sx)); ld.setAttribute('y1', String(sy)); ld.setAttribute('x2', String(ex)); ld.setAttribute('y2', String(ey)); dt.setAttribute('cx', String(sx)); dt.setAttribute('cy', String(sy));
  };
  L.dispose = () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); pin.remove(); };
  return L;
}
