import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/*
 * Pool & spa flow twin (Insights → Appliances): a holographic model of the pool, spa, waterfall and equipment pad.
 * Water is shown as particle streams along the real path (skimmer → pump → filter → heater → returns, the spa loop,
 * the waterfall feed). Each ScreenLogic circuit has a visible effect; particle speed follows the pump's RPM.
 */
const C = { cyan: 0x6cc4ff, green: 0x4ef0a6, purple: 0xc4a2ff, gold: 0xffc15e, heat: 0xff7a4a, white: 0xffffff };
const lerp = (a, b, k) => a + (b - a) * k;
const rrect = (w, h, r) => { const s = new THREE.Shape(); s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false); s.lineTo(w / 2, h / 2 - r); s.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false); s.lineTo(-w / 2 + r, h / 2); s.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false); s.lineTo(-w / 2, -h / 2 + r); s.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false); return s; };
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
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, W / H, .1, 100); cam.position.set(8.2, 7.6, 9.6);
  const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableZoom = false; ctl.enablePan = false; ctl.minPolarAngle = .5; ctl.maxPolarAngle = 1.15; ctl.target.set(1.3, .2, -.5); ctl.enableDamping = true; ctl.autoRotate = true; ctl.autoRotateSpeed = .45;
  scene.add(new THREE.AmbientLight(0xffffff, .6));
  const grid = new THREE.GridHelper(16, 32, C.cyan, C.cyan); grid.material.transparent = true; grid.material.opacity = .07; scene.add(grid);
  const fade = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`, fragmentShader: `varying vec2 vUv;void main(){float r=length(vUv-.5)*2.;gl_FragColor=vec4(.02,.024,.04,smoothstep(.45,1.,r));}` })); fade.rotation.x = -Math.PI / 2; fade.position.y = .01; scene.add(fade);
  // pool
  const PW = 7.4, PH = 3.8, PR = 1.1, px = -1.3, pz = .2, D = 1.0;
  const poolGeo = new THREE.ExtrudeGeometry(rrect(PW, PH, PR), { depth: D, bevelEnabled: false, curveSegments: 24 });
  const poolVol = new THREE.Mesh(poolGeo, glass(C.cyan, .06)); poolVol.rotation.x = Math.PI / 2; poolVol.position.set(px, .02, pz); scene.add(poolVol);
  const poolEdge = edges(poolGeo, C.cyan, .8); poolEdge.rotation.x = Math.PI / 2; poolEdge.position.set(px, .02, pz); scene.add(poolEdge);
  const wg = new THREE.ShapeGeometry(rrect(PW, PH, PR), 24); { const pos = wg.attributes.position, uv = wg.attributes.uv; for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / PW + .5, pos.getY(i) / PH + .5); uv.needsUpdate = true; }
  P.water = new THREE.Mesh(wg, waterMat()); P.water.material.uniforms.uSize.value.set(PW, PH); P.water.rotation.x = -Math.PI / 2; P.water.position.set(px, .03, pz); scene.add(P.water);
  // spa
  const sx = 3.9, sz = .2, SR = 1.25, SH = .55;
  const spaVol = new THREE.Mesh(new THREE.CylinderGeometry(SR, SR, SH, 48, 1, true), glass(C.green, .07)); spaVol.position.set(sx, SH / 2, sz); scene.add(spaVol);
  const ring = (y, c, op) => { const r = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, SR, 0, Math.PI * 2, false).getPoints(64).map(p => new THREE.Vector3(p.x, 0, p.y))), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op })); r.position.set(sx, y, sz); scene.add(r); return r; };
  ring(0.01, C.green, .5); P.spaRing = ring(SH, C.green, .9);
  P.spa = new THREE.Mesh(new THREE.CircleGeometry(SR, 48), waterMat()); P.spa.material.uniforms.uSize.value.set(2, 2); P.spa.rotation.x = -Math.PI / 2; P.spa.position.set(sx, SH - .02, sz); scene.add(P.spa);
  // waterfall ledge
  const ledgeGeo = new THREE.BoxGeometry(2.2, .12, .4); const ledge = new THREE.Mesh(ledgeGeo, glass(C.purple, .15)); ledge.position.set(-1.3, 1.15, -1.75); scene.add(ledge); const le = edges(ledgeGeo, C.purple, .9); le.position.copy(ledge.position); scene.add(le);
  // equipment pad
  const block = (geo, c, x, y, z) => { const m = new THREE.Mesh(geo, glass(c, .12)); m.position.set(x, y, z); scene.add(m); const e = edges(geo, c, .9); e.position.set(x, y, z); scene.add(e); return { m, e }; };
  block(new THREE.BoxGeometry(3.4, .06, 1.5), 0x8d93a8, 4.4, .03, -2.6).e.material.opacity = .35;
  P.pump = block(new THREE.BoxGeometry(.7, .5, .5), C.cyan, 3.3, .3, -2.6);
  P.rotor = new THREE.Mesh(new THREE.TorusGeometry(.19, .02, 8, 32), new THREE.MeshBasicMaterial({ color: C.cyan })); P.rotor.position.set(3.3, .3, -2.34); scene.add(P.rotor);
  P.rotor2 = new THREE.Mesh(new THREE.BoxGeometry(.32, .03, .03), new THREE.MeshBasicMaterial({ color: C.white })); P.rotor2.position.copy(P.rotor.position); scene.add(P.rotor2);
  P.filter = block(new THREE.CylinderGeometry(.32, .32, .95, 24), 0xe1d7b3, 4.35, .53, -2.6);
  P.heater = block(new THREE.BoxGeometry(.8, .65, .65), C.heat, 5.35, .38, -2.6);
  P.heaterCore = new THREE.Mesh(new THREE.BoxGeometry(.5, .35, .35), new THREE.MeshBasicMaterial({ color: C.heat, transparent: true, opacity: 0 })); P.heaterCore.position.set(5.35, .38, -2.6); scene.add(P.heaterCore);
  // pipes and streams
  const tube = (cv, c) => scene.add(new THREE.Mesh(new THREE.TubeGeometry(cv, 64, .035, 6, false), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .14 })));
  const stream = (cv, color, n, size = .045) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0), 3)); const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); pts.userData = { curve: cv, n, off: Math.random() }; scene.add(pts); return pts; };
  const cvSuck = curve([[1.4, .1, -1.3], [1.4, .1, -2.1], [2.4, .15, -2.6], [2.95, .3, -2.6]]), cvPad = curve([[3.65, .3, -2.6], [4.0, .5, -2.6], [4.7, .5, -2.6], [4.95, .38, -2.6]]);
  const cvRet = curve([[5.75, .38, -2.6], [6.1, .3, -2.6], [6.1, .1, -1.4], [3.0, .05, -1.2], [.5, .05, -1.3], [-3.0, .05, -1.0]]), cvSpa = curve([[6.1, .3, -1.9], [6.1, .6, -.9], [5.2, .6, -.2], [4.9, .55, .0]]);
  const cvSpaBack = curve([[3.9, .3, 1.6], [3.9, .1, 2.4], [1.4, .1, 2.4], [1.4, .1, -1.2]]), cvFall = curve([[-3.3, .1, 1.4], [-3.9, .1, -.9], [-3.9, .8, -2.0], [-2.4, 1.15, -1.75]]);
  [[cvSuck, C.cyan], [cvPad, C.cyan], [cvRet, C.cyan], [cvSpa, C.green], [cvSpaBack, C.green], [cvFall, C.purple]].forEach(([c, col]) => tube(c, col));
  P.sSuck = stream(cvSuck, C.cyan, 40); P.sPad = stream(cvPad, C.cyan, 30); P.sRet = stream(cvRet, C.cyan, 90); P.sSpa = stream(cvSpa, C.green, 40); P.sSpaBack = stream(cvSpaBack, C.green, 50); P.sFall = stream(cvFall, C.purple, 50);
  P.curtain = stream(curve([[-1.3, 1.1, -1.7], [-1.3, .6, -1.6], [-1.3, .05, -1.45]]), C.white, 160, .03); P.spill = stream(curve([[2.65, .5, .2], [2.55, .3, .2], [2.45, .05, .2]]), C.green, 40, .03);
  P.jets = stream(curve([[0, 0, 0], [1, 0, 0]]), 0xdff4ff, 140, .03); P.bubbles = stream(curve([[0, 0, 0], [0, 1, 0]]), C.white, 160, .03); P.steam = stream(curve([[5.35, .7, -2.6], [5.4, 1.3, -2.6], [5.3, 1.9, -2.5]]), 0xffc9a8, 50, .07);
  const cone = (x, y, z, r) => { const c = new THREE.Mesh(new THREE.ConeGeometry(r, 1.2, 32, 1, true), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })); c.position.set(x, y, z); scene.add(c); return c; };
  P.conePool = cone(px, .62, pz, 2.4); P.coneSpa = cone(sx, 1.1, sz, 1.0);
  P.lightPool = new THREE.PointLight(C.cyan, 0, 8, 1.5); P.lightPool.position.set(px, .5, pz); scene.add(P.lightPool);
  const label = (x, y, z) => { const d = document.createElement('div'); d.className = 'lbl3d'; const o = new CSS2DObject(d); o.position.set(x, y, z); scene.add(o); return d; };
  P.lPump = label(2.6, .7, -2.9); P.lHeat = label(5.5, 1.6, -2.6); P.lPool = label(px - 1.6, .3, pz + 1.2); P.lSpa = label(sx + .2, 1.0, sz + .9); P.lFall = label(-1.3, 1.55, -1.75);
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
      { const s = P.jets; s.material.opacity = lerp(s.material.opacity, ST.jets ? .9 : 0, .08); const a = s.geometry.attributes.position; for (let i = 0; i < s.userData.n; i++) { const an = (i % 14) / 14 * Math.PI * 2, u = ((t * 1.4) + i * .37) % 1; a.setXYZ(i, sx + Math.cos(an) * (1.15 - u * .95), .55 + Math.sin(u * Math.PI) * .08, sz + Math.sin(an) * (1.15 - u * .95)); } a.needsUpdate = true; }
      { const s = P.bubbles; s.material.opacity = lerp(s.material.opacity, ST.blower ? .9 : 0, .08); const a = s.geometry.attributes.position; for (let i = 0; i < s.userData.n; i++) { const u = ((t * .9) + i * .41) % 1, r = .15 + u * .9; a.setXYZ(i, sx + Math.cos(i * 2.4) * r, .06 + u * .5, sz + Math.sin(i * 1.7) * r); } a.needsUpdate = true; }
      P.heaterCore.material.opacity = lerp(P.heaterCore.material.opacity, ST.heater ? .55 + Math.sin(t * 5) * .15 : 0, .07); P.heater.e.material.color.setHex(ST.heater ? C.heat : 0x6e727a);
      const glow = lerp(P.water.material.uniforms.uGlow.value, ST.lights ? 1 : 0, .06); P.water.material.uniforms.uGlow.value = glow; P.spa.material.uniforms.uGlow.value = glow; P.conePool.material.opacity = glow * .08; P.coneSpa.material.opacity = glow * .1; P.lightPool.intensity = glow * 3;
      P.spaRing.material.color.setHex(ST.spa || ST.jets || ST.blower ? C.green : 0x3a5a4a);
      P.lPump.innerHTML = `Pump<br><b>${running ? `${Math.round(ST.watts).toLocaleString()} W · ${ST.rpm.toLocaleString()} rpm` : 'off'}</b>`; P.lPump.classList.toggle('dim', !running);
      P.lHeat.innerHTML = `Heater<br><b>${ST.heater ? 'heating' : 'off'}${ST.spaSet ? ` · spa set ${ST.spaSet}°` : ''}</b>`; P.lHeat.classList.toggle('dim', !ST.heater);
      P.lFall.innerHTML = `Waterfall<br><b>${ST.waterfall ? 'on' : 'off'}</b>`; P.lFall.classList.toggle('dim', !ST.waterfall);
      P.lPool.innerHTML = `Pool<br><b>${ST.poolTemp != null ? ST.poolTemp + '°F' : '—'}</b>`; P.lSpa.innerHTML = `Spa<br><b>${ST.spaTemp != null ? ST.spaTemp + '°F' : '—'}${ST.jets ? ' · jets' : ''}${ST.blower ? ' · air' : ''}</b>`;
      ctl.update(); renderer.render(scene, cam); labels.render(scene, cam); },
    resize() { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); labels.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); },
  };
}
