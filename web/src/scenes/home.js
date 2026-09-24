import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sunAt, RAD, hourLabel } from '../lib/util.js';

/*
 * One model of the real house, used in two views:
 *   'flow' (Now → Energy flow card): Tesla-style framing, live flow lines along the wiring, kW labels.
 *   'sun'  (Panels → Live roof):     today's sun path, real shadows, panel glow, weather.
 * Geometry traced from the satellite image: a single hip roof (~14 × 24 m, 27° pitch), the house's long axis
 * running 154°/334°, all 30 SunPower E19-320 AC modules on the west-southwest face (facing 244°) in 3 rows × 10, covered patio at the
 * pool (north) end, garage door on the driveway (south) end. World axes: +x east, −z north.
 */
const TILT = 27 * RAD, W = 14, L = 24, WALL = 3.2, OH = .5;
const THETA = Math.atan2(Math.sin(154 * RAD), -Math.cos(154 * RAD)); // local +z → bearing 154°

function tex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }

function buildHouse() {
  const mat = (c, r = .8, m = .05) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const wall = mat(0x3b3f47), roofM = mat(0x2a2c32, .85, .05), trim = mat(0x4a4f58, .6);
  const panelMat = new THREE.MeshStandardMaterial({ roughness: .25, metalness: .55, emissive: 0x1a2a66, emissiveIntensity: 0, map: tex(256, 400, (x, w, h) => {
    x.fillStyle = '#12182b'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(150,170,220,.28)'; x.lineWidth = 3;
    for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo(i * w / 6, 0); x.lineTo(i * w / 6, h); x.stroke(); } for (let j = 1; j < 10; j++) { x.beginPath(); x.moveTo(0, j * h / 10); x.lineTo(w, j * h / 10); x.stroke(); }
    x.strokeStyle = 'rgba(210,220,240,.55)'; x.lineWidth = 8; x.strokeRect(0, 0, w, h); }) });
  const winMat = new THREE.MeshStandardMaterial({ color: 0x6f7a8e, roughness: .08, metalness: .6, emissive: 0xffc98a, emissiveIntensity: 0 });
  const g = new THREE.Group(); g.rotation.y = THETA;

  function hip(Wd, Ln, wallH, tilt, wallMat, roofMat, over) {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(Wd, wallH, Ln), wallMat); body.position.y = wallH / 2; body.castShadow = body.receiveShadow = true; grp.add(body);
    const w = Wd / 2 + over, l = Ln / 2 + over, H = w * Math.tan(tilt), r = Math.max(0, l - w);
    const A = [-w, 0, -l], B = [w, 0, -l], C = [w, 0, l], D = [-w, 0, l], R1 = [0, H, -r], R2 = [0, H, r];
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([A, D, R2, A, R2, R1, B, R1, R2, B, R2, C, A, R1, B, D, C, R2].flat(), 3)); geo.computeVertexNormals();
    const roof = new THREE.Mesh(geo, roofMat.clone()); roof.material.side = THREE.DoubleSide; roof.material.flatShading = true; roof.position.y = wallH; roof.castShadow = roof.receiveShadow = true; grp.add(roof);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .12 })); e.position.y = wallH; grp.add(e);
    return { grp, w };
  }
  const main = hip(W, L, WALL, TILT, wall, roofM, OH); g.add(main.grp);
  const patio = hip(7, 6, 2.8, 22 * RAD, mat(0x34373e), mat(0x1f2126, .85), .3); patio.grp.position.set(-5.5, 0, -14.5); g.add(patio.grp);

  // 30 panels on the west (−x) face: 3 rows up the slope × 10 along the ridge
  const arr = new THREE.Group(); arr.position.set(-main.w, WALL, 0); arr.rotation.z = TILT; g.add(arr);
  // SunPower SPR-E19-320-AC modules: 1558 × 1046 mm, portrait (long side up the slope), 33 mm apart
  const pGeo = new THREE.BoxGeometry(1.558, .05, 1.046);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) { const p = new THREE.Mesh(pGeo, panelMat); p.position.set(.9 + (r + .5) * 1.591, .09, 1.2 + (c - 4.5) * 1.079); p.castShadow = p.receiveShadow = true; arr.add(p); }

  // windows on the west wall (north of the equipment), garage door on the south (driveway) end
  [-8.5, -5.5, 1.5, 4.5].forEach(z => { const w = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.2), winMat); w.rotation.y = -Math.PI / 2; w.position.set(-W / 2 - .02, 1.7, z); g.add(w);
    const f = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.4), trim); f.rotation.y = -Math.PI / 2; f.position.set(-W / 2 - .015, 1.7, z); g.add(f); });
  const door = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.3), new THREE.MeshStandardMaterial({ roughness: .7, map: tex(256, 256, (x, w, h) => { x.fillStyle = '#2a2d33'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(0,0,0,.35)'; for (let j = 1; j < 8; j++) x.fillRect(0, j * h / 8 - 2, w, 4); }) }));
  door.position.set(2.2, 1.2, L / 2 + .02); g.add(door);

  // gateway + 2 Powerwall 2s mounted outside on the west wall near the garage end
  const gw = new THREE.Mesh(new THREE.BoxGeometry(.14, .75, .5), mat(0x4a4e57, .5, .2)); gw.position.set(-W / 2 - .08, 1.6, 8.6); g.add(gw);
  const pwLeds = [];
  [9.7, 10.6].forEach(z => { const u = new THREE.Mesh(new THREE.BoxGeometry(.16, 1.15, .75), new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: .35 })); u.position.set(-W / 2 - .1, .95, z); u.castShadow = true; g.add(u);
    const led = new THREE.Mesh(new THREE.PlaneGeometry(.03, .5), new THREE.MeshBasicMaterial({ color: 0x4ef0a6 })); led.rotation.y = -Math.PI / 2; led.position.set(-W / 2 - .19, .75, z - .3); g.add(led); pwLeds.push(led); });

  // wiring (house-local coordinates)
  const X = -W / 2 - .07;
  const FEED = {
    solar: [[X, WALL - .05, 6.9], [X, 2.05, 6.9], [X, 2.05, 8.45]],
    home:  [[X, 1.6, 8.3], [X, 1.6, 5.3]],
    batt:  [[X, 1.4, 8.9], [X, 1.4, 9.3]],
    grid:  [[X, 1.25, 8.6], [X, .05, 8.6], [X - 3, .05, 8.6], [X - 3, .05, 14]],
  };
  const flows = {};
  for (const [k, pts] of Object.entries(FEED)) {
    const path = new THREE.CurvePath(); for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(...pts[i]), new THREE.Vector3(...pts[i + 1])));
    const len = path.getLength(), u = { uColor: { value: new THREE.Color() }, uT: { value: 0 }, uOn: { value: 0 }, uDir: { value: 1 }, uLen: { value: len }, uSpeed: { value: 1 } };
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(12, Math.round(len * 12)), .06, 8, false), new THREE.ShaderMaterial({ uniforms: u,
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uT,uOn,uDir,uLen,uSpeed;
        void main(){float d=fract(vUv.x*uLen/.9-uT*uSpeed*uDir);float dash=smoothstep(.0,.15,d)*smoothstep(.75,.45,d);
          gl_FragColor=vec4(mix(vec3(.16,.17,.2),uColor*1.6,uOn*(.35+.65*dash)),1.);}` })));
    flows[k] = u;
  }
  g.updateMatrixWorld(true);
  const panelNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(arr.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const local = (x, y, z) => g.localToWorld(new THREE.Vector3(x, y, z));
  const anchors = { solar: local(-4.4, 5.3, 1.2), home: local(-W / 2, 2.4, 4.5), pw: local(-W / 2 - .1, .3, 10.2), grid: local(X - 3, .05, 13) };
  return { group: g, panelMat, winMat, pwLeds, flows, panelNormal, anchors, local };
}

const sunVec = ({ el, az }, v = new THREE.Vector3()) => v.set(Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), -Math.cos(az * RAD) * Math.cos(el * RAD));

export function createHomeView(host, mode = 'flow') {
  const canvas = document.createElement('canvas'); canvas.className = 'house-canvas'; host.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x1a2030, 45, 140);
  const H = buildHouse(); scene.add(H.group);

  // camera: flow view looks at the panel (west) face from the WSW like the Tesla app; sun view orbits wider
  const camera = new THREE.PerspectiveCamera(mode === 'flow' ? 32 : 40, 1, .1, 500);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, enablePan: false, enableZoom: false, maxPolarAngle: Math.PI * .48 });
  if (mode === 'flow') { camera.position.copy(H.local(-38, 19, 12)); controls.target.copy(H.local(-3, 2.2, 3.5)); }
  else { camera.position.copy(H.local(-30, 17, 20)); controls.target.copy(H.local(-1, 2.5, 0)); controls.autoRotate = true; controls.autoRotateSpeed = .25; }

  const sky = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, glow: { value: new THREE.Color() }, cloud: { value: 0 }, t: { value: 0 } };
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, uniforms: sky,
    vertexShader: `varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec3 vD;uniform vec3 top,hor,sunDir,glow;uniform float cloud,t;
    float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
    float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n(p);p*=2.;a*=.5;}return s;}
    void main(){float y=max(vD.y,0.);vec3 c=mix(hor,top,pow(y,.6));float s=max(dot(vD,normalize(sunDir)),0.);c+=glow*(pow(s,300.)*2.5+pow(s,8.)*.4);
      vec2 uv=vD.xz/(vD.y+.25)*1.4+vec2(t*.02,0.);float cl=smoothstep(1.-cloud*.95,1.25-cloud*.6,fbm(uv*1.3))*smoothstep(0.,.25,vD.y);
      c=mix(c,mix(hor,vec3(.85,.88,.92),.35)*(.55+.6*max(0.,normalize(sunDir).y)),cl*.85);gl_FragColor=vec4(c,1.);}` })));
  const hemi = new THREE.HemisphereLight(0xbfd2ff, 0x2a2d34, .9); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 3); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -.0005; sun.shadow.normalBias = .04;
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 160 }); scene.add(sun, sun.target);
  // Now card: a soft fill from the viewer's side keeps the wall, wiring and equipment readable when the sun is behind the house
  if (mode === 'flow') { const fill = new THREE.DirectionalLight(0xdfe8ff, .9); fill.position.copy(camera.position); fill.target.position.copy(controls.target); scene.add(fill, fill.target); }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(70, 72), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: .95 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffd48a, fog: false })); sunBall.visible = mode === 'sun'; scene.add(sunBall);

  // DOM overlays: CSS2D for sun-path hour marks; plain divs with leader lines for the flow labels
  const css = new CSS2DRenderer(); Object.assign(css.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.appendChild(css.domElement);
  const els = {}, lines = {}, lift = { solar: -40, home: -54, pw: 24, grid: -34 }, names = { solar: 'SOLAR', home: 'HOME', pw: 'POWERWALL · 2×', grid: 'PEC GRID' };
  if (mode === 'flow') for (const k of Object.keys(H.anchors)) {
    const el = document.createElement('div'); el.className = `hlbl ${lift[k] > 0 ? 'below' : ''}`; el.innerHTML = `<small>${names[k]}</small><b>—</b>`; host.appendChild(el); els[k] = el;
    const l = document.createElement('div'); l.className = 'hlead'; host.appendChild(l); lines[k] = l;
  }
  let pathDay = null, pathObjs = [];
  function drawSunPath(dayStart) {
    pathObjs.forEach(o => { scene.remove(o); o.element?.remove(); }); pathObjs = [];
    const pts = [], v = new THREE.Vector3();
    for (let h = 4; h <= 22; h += 1 / 6) { const sp = sunAt(new Date(dayStart + h * 36e5)); if (sp.el > -1) pts.push(sunVec(sp, v).clone().multiplyScalar(160)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffe0a0, dashSize: 3, gapSize: 2.5, transparent: true, opacity: .75, fog: false }));
    line.computeLineDistances(); scene.add(line); pathObjs.push(line);
    [8, 10, 12, 14, 16, 18].forEach(h => { const sp = sunAt(new Date(dayStart + h * 36e5)); if (sp.el < 1) return;
      const el = document.createElement('div'); el.className = 'lax'; el.style.color = '#ffe0a0'; el.textContent = hourLabel(h);
      const o = new CSS2DObject(el); o.position.copy(sunVec(sp, v).multiplyScalar(160)); scene.add(o); pathObjs.push(o); });
    const n = document.createElement('div'); n.className = 'lax'; n.style.cssText = 'color:#fff;font-weight:700;text-shadow:0 1px 4px #000'; n.textContent = 'N';
    const no = new CSS2DObject(n); no.position.set(0, .1, -30); scene.add(no); pathObjs.push(no);
  }

  const RN = 1200, rp = new Float32Array(RN * 6);
  for (let i = 0; i < RN; i++) { const x = (Math.random() - .5) * 70, y = Math.random() * 30, z = (Math.random() - .5) * 70; rp.set([x, y, z, x - .1, y - .9, z], i * 6); }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  const rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaecbff, transparent: true, opacity: 0 })); scene.add(rain);

  const C = { nightTop: new THREE.Color(0x05070d), nightHor: new THREE.Color(0x121a2c), duskTop: new THREE.Color(0x2a3560), duskHor: new THREE.Color(0xe79a68),
    dayTop: new THREE.Color(0x3d6fb0), dayHor: new THREE.Color(0x9fb8d6), grayTop: new THREE.Color(0x4b5360), grayHor: new THREE.Color(0x7d8591) };
  const sd = new THREE.Vector3(), v = new THREE.Vector3(), ramp = [0x0e1a3a, 0x2d5bff, 0xffc15e, 0xfff3d0].map(c => new THREE.Color(c));
  const rampAt = t => { t = Math.max(0, Math.min(.999, t)) * 3; const i = Math.floor(t); return ramp[i].clone().lerp(ramp[i + 1], t - i); };
  const kw = x => `${Math.abs(x) < .05 ? 0 : Math.abs(x).toFixed(1)} kW`;
  function resize() { const r = canvas.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); css.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(canvas);

  return {
    /** r: live reading · cloud 0–1 · code: WMO weather code · out: grid outage · peakKw: array's ~max kW · dayStart: local midnight (ms) */
    render({ r, now = new Date(), dayStart, cloud = .1, code = 0, out = false, peakKw = 9, dt, t, calm }) {
      const sp = sunAt(now); sunVec(sp, sd);
      const up = Math.max(0, Math.min(1, (sp.el + 4) / 14)), high = Math.max(0, Math.min(1, sp.el / 35));
      sky.top.value.copy(C.nightTop).lerp(C.duskTop, up).lerp(C.dayTop, high).lerp(C.grayTop, cloud * .7 * up);
      sky.hor.value.copy(C.nightHor).lerp(C.duskHor, up).lerp(C.dayHor, high).lerp(C.grayHor, cloud * .7 * up);
      sky.sunDir.value.copy(sd); sky.glow.value.set(0xffd9a0).multiplyScalar(up * (1 - cloud * .75)); sky.cloud.value = cloud; sky.t.value = t;
      scene.fog.color.copy(sky.hor.value).multiplyScalar(.6);
      sun.position.copy(sd).multiplyScalar(60); sun.intensity = 3.4 * Math.max(0, Math.min(1, sp.el / 8)) * (1 - cloud * .7); hemi.intensity = .25 + .75 * up;
      sunBall.position.copy(sd).multiplyScalar(160); sunBall.visible = mode === 'sun' && sp.el > -3;
      rain.material.opacity += ((code >= 51 ? .45 : 0) - rain.material.opacity) * dt * 2; if (code >= 51) rain.position.y = -((t * 22) % 30);
      if (mode === 'sun' && dayStart && pathDay !== dayStart) { pathDay = dayStart; drawSunPath(dayStart); }

      const solar = r?.solarKw ?? 0;
      H.panelMat.emissive.copy(mode === 'sun' ? rampAt(solar / peakKw) : new THREE.Color(0x1a2a66));
      H.panelMat.emissiveIntensity = mode === 'sun' ? .12 + solar / peakKw * .9 : solar / peakKw * .5;
      H.winMat.emissiveIntensity = Math.min(1.6, (1 - up) * (.4 + (r?.homeKw ?? 1) / 4));
      if (r) H.pwLeds.forEach(l => l.material.color.set(r.batteryKw < -.05 ? 0x4ef0a6 : r.batteryKw > .05 ? 0xffc15e : 0x9aa3b0));

      if (mode === 'flow' && r) {
        const set = (k, on, dir, color, amt) => { const f = H.flows[k]; f.uOn.value = on ? 1 : 0; f.uDir.value = dir; f.uColor.value.set(color); f.uSpeed.value = calm ? .3 : .6 + Math.min(1.6, amt / 3); f.uT.value = t; };
        set('solar', r.solarKw > .05, 1, 0xffc15e, r.solarKw);
        set('batt', Math.abs(r.batteryKw) > .05, r.batteryKw < 0 ? 1 : -1, r.batteryKw < 0 ? 0xffc15e : 0x4ef0a6, Math.abs(r.batteryKw));
        set('home', r.homeKw > .05, 1, r.solarKw >= r.homeKw ? 0xffc15e : r.batteryKw > .05 && r.batteryKw >= Math.max(0, r.gridKw) ? 0x4ef0a6 : r.gridKw > .05 ? 0xc4a2ff : 0xffc15e, r.homeKw);
        set('grid', !out && Math.abs(r.gridKw) > .05, r.gridKw < 0 ? 1 : -1, r.gridKw < 0 ? 0xffc15e : 0xc4a2ff, Math.abs(r.gridKw));
        if (out) { H.flows.grid.uOn.value = 1; H.flows.grid.uColor.value.set(0xff5a4e); H.flows.grid.uSpeed.value = 0; }
        els.solar.querySelector('b').textContent = kw(r.solarKw);
        els.home.querySelector('b').textContent = kw(r.homeKw);
        els.pw.querySelector('b').innerHTML = `${kw(r.batteryKw)} ${r.batteryKw < -.05 ? '<i style="color:var(--batt)">▲</i>' : r.batteryKw > .05 ? '<i style="color:var(--solar)">▼</i>' : '<i style="color:var(--mute)">·</i>'}${Math.round(r.soc)}%`;
        els.grid.classList.toggle('off', out);
        els.grid.querySelector('b').textContent = out ? 'Offline' : r.gridKw > .05 ? `↓ ${kw(r.gridKw)}` : r.gridKw < -.05 ? `↑ ${kw(r.gridKw)}` : '0 kW';
      } else Object.values(H.flows).forEach(f => { f.uOn.value = 0; });

      controls.autoRotate = mode === 'sun' && !calm && controls.autoRotate;
      controls.update(); renderer.render(scene, camera); css.render(scene, camera);
      if (mode === 'flow') { const rect = canvas.getBoundingClientRect();
        for (const [k, p] of Object.entries(H.anchors)) { v.copy(p).project(camera); const x = (v.x + 1) / 2 * rect.width, y = (1 - v.y) / 2 * rect.height, dy = lift[k];
          els[k].style.left = x + 'px'; els[k].style.top = (y + dy) + 'px'; lines[k].style.left = x + 'px'; lines[k].style.height = Math.abs(dy) - 4 + 'px'; lines[k].style.top = (dy > 0 ? y : y + dy + 4) + 'px'; } }
      return { el: sp.el, az: sp.az, inc: Math.acos(Math.max(-1, Math.min(1, H.panelNormal.dot(sd)))) / RAD };
    },
  };
}
