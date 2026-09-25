import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchOrbit } from '../lib/touchorbit.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/*
 * Pool & spa flow twin (Insights → Appliances): a holographic model of the pool, spa, waterfall and equipment pad.
 * Water is shown as particle streams along the real path (skimmer → pump → filter → heater → returns, the spa loop,
 * the waterfall feed). Each ScreenLogic circuit has a visible effect; particle speed follows the pump's RPM.
 */
const C = { cyan: 0x6cc4ff, green: 0x4ef0a6, purple: 0xc4a2ff, gold: 0xffc15e, heat: 0xff7a4a, white: 0xffffff };
const lerp = (a, b, k) => a + (b - a) * k;
const glass = (c, op = .10) => new THREE.MeshPhysicalMaterial({ color: c, transparent: true, opacity: op, roughness: .15, metalness: 0, emissive: c, emissiveIntensity: .08, side: THREE.DoubleSide, depthWrite: false });
const edges = (geo, c, op = .9) => new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op }));
const waterMat = () => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uT: { value: 0 }, uGlow: { value: 0 }, uFlow: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `varying vec2 vUv;uniform float uT,uGlow,uFlow;uniform vec2 uSize;
    void main(){vec2 p=(vUv-.5)*uSize; float r=length(p/(uSize*.5)); float base=.22+.18*(1.-r);
      float rings=0.; for(int i=0;i<3;i++){ float ph=fract(uT*.18+float(i)/3.); float rr=ph*1.15; rings+=smoothstep(.03,.0,abs(r-rr))*(1.-ph)*.5; }
      float lanes=smoothstep(.85,1.,sin(p.x*4.+uT*2.2*uFlow)*.5+.5)*uFlow*.35*(1.-r*.7);
      float shimmer=(sin(p.x*9.+uT*1.3)*sin(p.y*11.-uT*1.1))*.05;
      vec3 col=mix(vec3(.26,.62,1.),vec3(.45,.95,1.),uGlow*.8);
      float a=base+rings*(.4+uFlow)+lanes+shimmer+uGlow*.25; gl_FragColor=vec4(col*(1.+uGlow*.6),clamp(a,0.,.9));}` });
const curve = pts => new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), false, 'catmullrom', .2);

export function createPoolTwin(el) {
  const W = el.clientWidth || 353, H = el.clientHeight || 340, P = {}; let t = 0;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(W, H); el.prepend(renderer.domElement);
  const labels = new CSS2DRenderer(); labels.setSize(W, H); labels.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none'; el.appendChild(labels.domElement);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(34, W / H, .1, 100); cam.position.set(4.2, 9.6, 9.4);
  const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableZoom = false; ctl.enablePan = false; ctl.minPolarAngle = .4; ctl.maxPolarAngle = 1.05; ctl.target.set(1.6, 0, .9); ctl.enableDamping = true; ctl.autoRotate = true; ctl.autoRotateSpeed = .45; touchOrbit(ctl);
  scene.add(new THREE.AmbientLight(0xffffff, .6));
  const grid = new THREE.GridHelper(20, 40, C.cyan, C.cyan); grid.material.transparent = true; grid.material.opacity = .07; scene.add(grid);
  const fade = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`, fragmentShader: `varying vec2 vUv;void main(){float r=length(vUv-.5)*2.;gl_FragColor=vec4(.02,.024,.04,smoothstep(.45,1.,r));}` })); fade.rotation.x = -Math.PI / 2; fade.position.y = .01; scene.add(fade);
  // Geometry traced from the construction plan (1 ft = 0.2 units; x east, z south): 32'7" × 18'5" freeform pool (14,995 gal),
  // 7' spa raised 12" at the north-west end with its spillway, 24" sheer descent on the raised beam beside it, 50 sq ft tanning
  // ledge at the west end, equipment pad (2'6" × 8') east of the pool. Pipe runs follow the plan's skimmer, spa and feature lines.
  const FT = .2, ox = -3.3, oz = -1.6, ftv = (x, z) => [ox + x * FT, oz + z * FT];
  const outline = [[1, 7], [3, 3], [8, 1], [14, 1.5], [19, 3.5], [24, 2], [29, 3], [32.5, 7], [31.5, 12], [27, 16], [21, 18.2], [15, 17.5], [9, 18.4], [4, 16.5], [.8, 12]];
  const cv2 = new THREE.CatmullRomCurve3(outline.map(([x, z]) => { const [X, Z] = ftv(x, z); return new THREE.Vector3(X, 0, Z); }), true, 'catmullrom', .5);
  const shape = new THREE.Shape(cv2.getPoints(120).map(p => new THREE.Vector2(p.x, -p.z)));
  const poolGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.0, bevelEnabled: false });
  const poolVol = new THREE.Mesh(poolGeo, glass(C.cyan, .06)); poolVol.rotation.x = Math.PI / 2; poolVol.position.y = .02; scene.add(poolVol);
  const poolEdge = edges(poolGeo, C.cyan, .8); poolEdge.rotation.x = Math.PI / 2; poolEdge.position.y = .02; scene.add(poolEdge);
  const wg = new THREE.ShapeGeometry(shape, 48); { const bb = new THREE.Box2(); shape.getPoints().forEach(p => bb.expandByPoint(p)); const sz2 = bb.getSize(new THREE.Vector2()); const pos = wg.attributes.position, uv = wg.attributes.uv; for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / sz2.x, (pos.getY(i) - bb.min.y) / sz2.y); uv.needsUpdate = true; }
  P.water = new THREE.Mesh(wg, waterMat()); P.water.material.uniforms.uSize.value.set(6.5, 3.7); P.water.rotation.x = -Math.PI / 2; P.water.position.y = .03; scene.add(P.water);
  const [lx, lz] = ftv(5, 12); const ledge = new THREE.Mesh(new THREE.CircleGeometry(.75, 32), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: .18 })); ledge.rotation.x = -Math.PI / 2; ledge.position.set(lx, .035, lz); scene.add(ledge);
  const lr = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, .75, 0, Math.PI * 2, false).getPoints(48).map(p => new THREE.Vector3(p.x, 0, p.y))), new THREE.LineBasicMaterial({ color: C.cyan, transparent: true, opacity: .5 })); lr.position.set(lx, .04, lz); scene.add(lr);
  // spa
  const [sx, sz] = ftv(5.5, -1.5), SR = 3.5 * FT, SH = .5;
  const spaVol = new THREE.Mesh(new THREE.CylinderGeometry(SR, SR, SH, 48, 1, true), glass(C.green, .07)); spaVol.position.set(sx, SH / 2, sz); scene.add(spaVol);
  const ring = (y, c, op) => { const r = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, SR, 0, Math.PI * 2, false).getPoints(64).map(p => new THREE.Vector3(p.x, 0, p.y))), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op })); r.position.set(sx, y, sz); scene.add(r); return r; };
  ring(0.01, C.green, .5); P.spaRing = ring(SH, C.green, .9);
  P.spa = new THREE.Mesh(new THREE.CircleGeometry(SR, 48), waterMat()); P.spa.material.uniforms.uSize.value.set(2, 2); P.spa.rotation.x = -Math.PI / 2; P.spa.position.set(sx, SH - .02, sz); scene.add(P.spa);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, j = new THREE.Mesh(new THREE.SphereGeometry(.03, 8, 8), new THREE.MeshBasicMaterial({ color: 0xdff4ff })); j.position.set(sx + Math.cos(a) * (SR - .08), SH - .06, sz + Math.sin(a) * (SR - .08)); scene.add(j); }
  // raised beam with the sheer descent
  const [bx, bz] = ftv(13, 1.2); const beamGeo = new THREE.BoxGeometry(2.4, .32, .3); const beam = new THREE.Mesh(beamGeo, glass(C.purple, .12)); beam.position.set(bx, .16, bz - .15); scene.add(beam); const be = edges(beamGeo, C.purple, .8); be.position.copy(beam.position); scene.add(be);
  // equipment pad
  const [px2, pz2] = ftv(43, 26);
  const block = (geo, c, x, y, z) => { const m = new THREE.Mesh(geo, glass(c, .12)); m.position.set(x, y, z); scene.add(m); const e = edges(geo, c, .9); e.position.set(x, y, z); scene.add(e); return { m, e }; };
  block(new THREE.BoxGeometry(.55, .06, 1.7), 0x8d93a8, px2, .03, pz2).e.material.opacity = .35;
  P.pump = block(new THREE.BoxGeometry(.4, .36, .36), C.cyan, px2, .22, pz2 - .6);
  P.rotor = new THREE.Mesh(new THREE.TorusGeometry(.13, .015, 8, 32), new THREE.MeshBasicMaterial({ color: C.cyan })); P.rotor.position.set(px2 - .21, .22, pz2 - .6); P.rotor.rotation.y = Math.PI / 2; scene.add(P.rotor);
  P.rotor2 = new THREE.Mesh(new THREE.BoxGeometry(.03, .03, .22), new THREE.MeshBasicMaterial({ color: C.white })); P.rotor2.position.copy(P.rotor.position); scene.add(P.rotor2);
  P.filter = block(new THREE.CylinderGeometry(.2, .2, .7, 24), 0xe1d7b3, px2, .4, pz2);
  P.heater = block(new THREE.BoxGeometry(.45, .45, .45), C.heat, px2, .28, pz2 + .6);
  P.heaterCore = new THREE.Mesh(new THREE.BoxGeometry(.28, .24, .24), new THREE.MeshBasicMaterial({ color: C.heat, transparent: true, opacity: 0 })); P.heaterCore.position.set(px2, .28, pz2 + .6); scene.add(P.heaterCore);
  // pipes and streams
  const tube = (cv, c) => scene.add(new THREE.Mesh(new THREE.TubeGeometry(cv, 64, .035, 6, false), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .14 })));
  const stream = (cv, color, n, size = .045) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0), 3)); const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); pts.userData = { curve: cv, n, off: Math.random() }; scene.add(pts); return pts; };
  const F = (x, z, y = .05) => { const [X, Z] = ftv(x, z); return [X, y, Z]; };
  const cvSuck = curve([F(31, 9), F(36, 12), F(40, 20), [px2 - .2, .2, pz2 - .6]]), cvPad = curve([[px2, .3, pz2 - .4], [px2, .45, pz2], [px2, .35, pz2 + .4]]);
  const cvRet = curve([[px2 + .3, .25, pz2 + .6], [px2 + .45, .1, pz2], F(38, 17), F(26, 20), F(16, 19.5), F(6, 18)]), cvSpa = curve([F(38, 16, .1), F(30, -1, .15), F(12, -3, .35), [sx + SR * .9, SH - .1, sz - .2]]);
  const cvSpaBack = curve([[sx, SH - .3, sz + SR * .9], F(6, 3), F(20, 7), F(31, 9)]), cvFall = curve([F(40, 18, .1), F(22, -2.5, .2), [bx, .35, bz - .3]]);
  [[cvSuck, C.cyan], [cvPad, C.cyan], [cvRet, C.cyan], [cvSpa, C.green], [cvSpaBack, C.green], [cvFall, C.purple]].forEach(([c, col]) => tube(c, col));
  P.sSuck = stream(cvSuck, C.cyan, 40); P.sPad = stream(cvPad, C.cyan, 20); P.sRet = stream(cvRet, C.cyan, 90); P.sSpa = stream(cvSpa, C.green, 50); P.sSpaBack = stream(cvSpaBack, C.green, 50); P.sFall = stream(cvFall, C.purple, 50);
  P.curtain = stream(curve([[bx, .32, bz - .05], [bx, .18, bz + .05], [bx, .04, bz + .18]]), C.white, 120, .03);
  P.spill = stream(curve([[sx + SR * .55, SH - .02, sz + SR * .8], [sx + SR * .6, .25, sz + SR * .95], [sx + SR * .65, .04, sz + SR * 1.15]]), C.green, 40, .03);
  P.jets = stream(curve([[0, 0, 0], [1, 0, 0]]), 0xdff4ff, 140, .03); P.bubbles = stream(curve([[0, 0, 0], [0, 1, 0]]), C.white, 160, .03);
  P.steam = stream(curve([[px2, .55, pz2 + .6], [px2 + .05, 1.0, pz2 + .6], [px2, 1.4, pz2 + .55]]), 0xffc9a8, 40, .07);
  const cone = (x, y, z, r) => { const c = new THREE.Mesh(new THREE.ConeGeometry(r, 1.2, 32, 1, true), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })); c.position.set(x, y, z); scene.add(c); return c; };
  const [cx2, cz2] = ftv(24, 9); P.conePool = cone(cx2, .62, cz2, 1.6); P.coneSpa = cone(sx, SH + .55, sz, .7);
  P.lightPool = new THREE.PointLight(C.cyan, 0, 8, 1.5); P.lightPool.position.set(cx2, .5, cz2); scene.add(P.lightPool);
  const tags = [], tv = new THREE.Vector3();
  const label = (x, y, z) => { const d = document.createElement('div'); d.className = 'lbl3d'; const o = new CSS2DObject(d); o.position.set(x, y, z); scene.add(o);
    const lead = document.createElement('div'); lead.className = 'lead3d'; el.insertBefore(lead, labels.domElement); tags.push({ d, o, lead }); return d; };
  P.lPump = label(px2 - .7, .75, pz2 - 1.1); P.lHeat = label(px2 - .6, 1.0, pz2 + 1.0); { const [lx2, lz2] = ftv(22, 14); P.lPool = label(lx2, .3, lz2); } P.lSpa = label(sx - .5, SH + .55, sz - .6); P.lFall = label(bx + .6, .85, bz - .5);
  renderer.domElement.addEventListener('pointerdown', () => ctl.autoRotate = false);
  const advance = (s, on, speed) => { s.material.opacity = lerp(s.material.opacity, on ? .95 : 0, .08); const a = s.geometry.attributes.position; for (let i = 0; i < s.userData.n; i++) { const p = s.userData.curve.getPointAt((t * speed * .25 + i / s.userData.n + s.userData.off) % 1); a.setXYZ(i, p.x, p.y, p.z); } a.needsUpdate = true; };
  const spread = (s, on, speed, w) => { s.material.opacity = lerp(s.material.opacity, on ? .9 : 0, .08); const a = s.geometry.attributes.position; for (let i = 0; i < s.userData.n; i++) { const p = s.userData.curve.getPointAt((t * speed + i * .618) % 1); a.setXYZ(i, p.x + (i / s.userData.n - .5) * w * 2, p.y, p.z + Math.sin(i * 3.1) * .05); } a.needsUpdate = true; };
  let ST = { pool: false, spa: false, waterfall: false, jets: false, blower: false, heater: false, lights: false, rpm: 0, watts: 0, poolTemp: null, spaTemp: null, spaSet: null };
  return {
    /** state: { pool, spa, waterfall, jets, blower, heater, lights, rpm, watts, poolTemp, spaTemp, spaSet } */
    set(s) { ST = { ...ST, ...s }; },
    render(dt, calm) { t += dt;
      const running = ST.pool || ST.spa || ST.waterfall || ST.jets || ST.blower, sp = ST.rpm / 3450;
      if (calm) ctl.autoRotate = false;
      P.rotor.rotation.z += sp * .5; P.rotor2.rotation.z += sp * .5; P.rotor.material.color.setHex(running ? C.cyan : 0x444455);
      P.water.material.uniforms.uFlow.value = lerp(P.water.material.uniforms.uFlow.value, running && !ST.spa ? .4 + sp : 0, .06); P.spa.material.uniforms.uFlow.value = ST.spa || ST.jets ? .8 : 0;
      P.water.material.uniforms.uT.value = t; P.spa.material.uniforms.uT.value = t;
      advance(P.sSuck, running, 1 + sp * 3); advance(P.sPad, running, 1 + sp * 3); advance(P.sRet, running && !ST.spa, 1 + sp * 3); advance(P.sSpa, ST.spa, 2 + sp * 3); advance(P.sSpaBack, ST.spa, 2 + sp * 3); advance(P.sFall, ST.waterfall, 2.5);
      spread(P.curtain, ST.waterfall, .9, 1.0); spread(P.spill, ST.spa, 1.2, .3); spread(P.steam, ST.heater, .35, .25);
      { const s = P.jets; s.material.opacity = lerp(s.material.opacity, ST.jets ? .9 : 0, .08); const a = s.geometry.attributes.position; for (let i = 0; i < s.userData.n; i++) { const an = (i % 14) / 14 * Math.PI * 2, u = ((t * 1.4) + i * .37) % 1; a.setXYZ(i, sx + Math.cos(an) * (SR * .92 - u * SR * .8), SH - .03 + Math.sin(u * Math.PI) * .05, sz + Math.sin(an) * (SR * .92 - u * SR * .8)); } a.needsUpdate = true; }
      { const s = P.bubbles; s.material.opacity = lerp(s.material.opacity, ST.blower ? .9 : 0, .08); const a = s.geometry.attributes.position; for (let i = 0; i < s.userData.n; i++) { const u = ((t * .9) + i * .41) % 1, r = .15 + u * .9; a.setXYZ(i, sx + Math.cos(i * 2.4) * r * SR * .8, .02 + u * (SH - .05), sz + Math.sin(i * 1.7) * r * SR * .8); } a.needsUpdate = true; }
      P.heaterCore.material.opacity = lerp(P.heaterCore.material.opacity, ST.heater ? .55 + Math.sin(t * 5) * .15 : 0, .07); P.heater.e.material.color.setHex(ST.heater ? C.heat : 0x6e727a);
      const glow = lerp(P.water.material.uniforms.uGlow.value, ST.lights ? 1 : 0, .06); P.water.material.uniforms.uGlow.value = glow; P.spa.material.uniforms.uGlow.value = glow; P.conePool.material.opacity = glow * .08; P.coneSpa.material.opacity = glow * .1; P.lightPool.intensity = glow * 3;
      P.spaRing.material.color.setHex(ST.spa || ST.jets || ST.blower ? C.green : 0x3a5a4a);
      P.lPump.innerHTML = `Pump<br><b>${running ? `${Math.round(ST.watts).toLocaleString()} W · ${ST.rpm.toLocaleString()} rpm` : 'off'}</b>`; P.lPump.classList.toggle('dim', !running);
      P.lHeat.innerHTML = `Heater · propane<br><b>${ST.heater ? 'heating' : 'off'}${ST.spaSet ? ` · spa set ${ST.spaSet}°` : ''}</b>`; P.lHeat.classList.toggle('dim', !ST.heater);
      P.lFall.innerHTML = `24" sheer descent<br><b>${ST.waterfall ? 'on' : 'off'}</b>`; P.lFall.classList.toggle('dim', !ST.waterfall);
      P.lPool.innerHTML = `Pool · 14,995 gal<br><b>${ST.poolTemp != null ? ST.poolTemp + '°F' : '—'}</b>`; P.lSpa.innerHTML = `Spa · 1,000 gal<br><b>${ST.spaTemp != null ? ST.spaTemp + '°F' : '—'}${ST.jets ? ' · jets' : ''}${ST.blower ? ' · air' : ''}</b>`;
      ctl.update(); renderer.render(scene, cam); labels.render(scene, cam);
      // every label stays 8 px inside the twin; one moved in from the edge gets a 1 px leader back to its anchor
      const { width: lw, height: lh } = labels.getSize(), ws = tags.map(g => g.d.offsetWidth);
      tags.forEach((g, i) => { if (g.d.style.display === 'none') { g.lead.style.width = '0'; return; }
        g.o.getWorldPosition(tv).project(cam); const x = (tv.x + 1) / 2 * lw, y = (1 - tv.y) / 2 * lh, cx = Math.max(8 + ws[i] / 2, Math.min(x, lw - 8 - ws[i] / 2));
        if (cx !== x) g.d.style.transform = `translate(-50%, -50%) translate(${cx}px, ${y}px) rotate(0rad)`;
        const edge = cx + Math.sign(x - cx) * ws[i] / 2; Object.assign(g.lead.style, { left: Math.min(x, edge) + 'px', top: y + 'px', width: Math.abs(x - edge) + 'px' }); }); },
    resize() { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); labels.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); },
  };
}
