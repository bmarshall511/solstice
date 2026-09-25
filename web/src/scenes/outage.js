import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchOrbit } from '../lib/touchorbit.js';
import { RAD } from '../lib/util.js';

/*
 * Outage readiness (Insights → Home, approved mockup n-outage): the house from scenes/home.js at night, cut off from PEC.
 * Windows lit, Powerwall LEDs and fill strips on, the grid wire red and still, running to a PEC pole with a dark street lamp
 * while six neighbouring houses sit dark. In the storm variant: cloud, rain and a lightning flash every 6–12 s (off in calm).
 * Geometry is home.js buildHouse with the panels, windows and Powerwall parts instanced (≈25 draw calls), no shadows.
 * The card (views/outage.js) owns the data and the timeline; this module only draws what `card.cur` says:
 *   cur = { k: hours into the outage, soc: 0–1, s: solar kW, h: home kW, b: battery kW (+ out, − in), dark: Powerwalls empty }
 * Built only while the card is on screen; render() is called by main.js's loop; dispose() frees the WebGL context.
 */
const TILT = 27 * RAD, W = 14, L = 24, WALL = 3.2, OH = .5;
const THETA = Math.atan2(Math.sin(154 * RAD), -Math.cos(154 * RAD)); // local +z → bearing 154°
const X = -W / 2 - .07, PWZ = [9.7, 10.6];
const COL = { solar: 0xffc15e, batt: 0x4ef0a6, out: 0xff5a4e, rest: 0x8d93a8, idle: 0x9aa3b0 };
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const V = (x, y, z) => new THREE.Vector3(x, y, z), ONE = V(1, 1, 1), m4 = new THREE.Matrix4();
const qY = a => new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), a);

function tex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
function hipGeo(w, l, H) { const r = Math.max(0, l - w), A = [-w, 0, -l], B = [w, 0, -l], C = [w, 0, l], D = [-w, 0, l], R1 = [0, H, -r], R2 = [0, H, r];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([A, D, R2, A, R2, R1, B, R1, R2, B, R2, C, A, R1, B, D, C, R2].flat(), 3)); g.computeVertexNormals(); return g; }
/** One geometry from several (positions and normals, non-indexed): the panel edges and the pole in one draw call each, without an addon. */
function merge(geos) {
  const parts = geos.map(g => { const n = g.index ? g.toNonIndexed() : g; if (n !== g) g.dispose(); return n; }), out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    if (!parts.every(p => p.attributes[name])) continue;
    const arr = new Float32Array(parts.reduce((a, p) => a + p.attributes[name].array.length, 0)); let o = 0;
    parts.forEach(p => { arr.set(p.attributes[name].array, o); o += p.attributes[name].array.length; });
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  parts.forEach(p => p.dispose());
  return out;
}

function buildHouse() {
  const edgeMats = [];
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
    const body = new THREE.Mesh(new THREE.BoxGeometry(Wd, wallH, Ln), wallMat); body.position.y = wallH / 2; grp.add(body);
    const w = Wd / 2 + over, l = Ln / 2 + over, geo = hipGeo(w, l, w * Math.tan(tilt));
    const roof = new THREE.Mesh(geo, roofMat.clone()); roof.material.side = THREE.DoubleSide; roof.material.flatShading = true; roof.position.y = wallH; grp.add(roof);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .12 })); e.position.y = wallH; grp.add(e); edgeMats.push(e.material);
    return { grp, w };
  }
  const main = hip(W, L, WALL, TILT, wall, roofM, OH); g.add(main.grp);
  const patio = hip(7, 6, 2.8, 22 * RAD, mat(0x34373e), mat(0x1f2126, .85), .3); patio.grp.position.set(-5.5, 0, -14.5); g.add(patio.grp);
  // 30 SunPower modules on the west face, 3 rows × 10: one InstancedMesh + one merged edge set
  const arr = new THREE.Group(); arr.position.set(-main.w, WALL, 0); arr.rotation.z = TILT; g.add(arr);
  const pGeo = new THREE.BoxGeometry(1.558, .05, 1.046), eg = new THREE.EdgesGeometry(pGeo), parts = [], panels = new THREE.InstancedMesh(pGeo, panelMat, 30);
  let n = 0; for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) { const x = .9 + (r + .5) * 1.591, y = .09, z = 1.2 + (c - 4.5) * 1.079; panels.setMatrixAt(n++, m4.makeTranslation(x, y, z)); parts.push(eg.clone().translate(x, y, z)); }
  eg.dispose(); arr.add(panels);
  const panelEdge = new THREE.LineBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: .15 }); edgeMats.push(panelEdge); arr.add(new THREE.LineSegments(merge(parts), panelEdge));
  // windows on the west wall, garage door on the south end
  const wins = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.4, 1.2), winMat, 4), frames = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1.4), trim, 4), qW = qY(-Math.PI / 2);
  [-8.5, -5.5, 1.5, 4.5].forEach((z, i) => { wins.setMatrixAt(i, m4.compose(V(-W / 2 - .03, 1.7, z), qW, ONE)); frames.setMatrixAt(i, m4.compose(V(-W / 2 - .015, 1.7, z), qW, ONE)); }); g.add(frames, wins);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.3), new THREE.MeshStandardMaterial({ roughness: .7, map: tex(256, 256, (x, w, h) => { x.fillStyle = '#2a2d33'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(0,0,0,.35)'; for (let j = 1; j < 8; j++) x.fillRect(0, j * h / 8 - 2, w, 4); }) }));
  door.position.set(2.2, 1.2, L / 2 + .02); g.add(door);
  // gateway + 2 Powerwall 2s on the west wall near the garage end
  const gw = new THREE.Mesh(new THREE.BoxGeometry(.14, .75, .5), mat(0x4a4e57, .5, .2)); gw.position.set(-W / 2 - .08, 1.6, 8.6); g.add(gw);
  const slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(.16, 1.15, .75), new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: .35 }), 2);
  PWZ.forEach((z, i) => slabs.setMatrixAt(i, m4.makeTranslation(-W / 2 - .1, .95, z))); g.add(slabs);
  // Powerwall face: track, fill strip (scale.y = charge), 20% reserve tick, LED; one InstancedMesh of bottom-anchored unit planes
  const fx = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0, .5, 0), new THREE.MeshBasicMaterial({ toneMapped: false }), 8); g.add(fx);
  const FX = (i, x, y, z, sx, sy, col) => { fx.setMatrixAt(i, m4.compose(V(x, y, z), qW, V(sx, Math.max(.001, sy), 1))); if (col != null) fx.setColorAt(i, new THREE.Color(col)); };
  const face = -W / 2 - .18;
  PWZ.forEach((z, i) => { FX(i, face - .006, .45, z + .05, .6, 1, 0x0b0d12); FX(2 + i, face - .016, .45, z + .05, .6, .74, COL.solar); FX(4 + i, face - .026, .45 + .2 - .0125, z + .05, .66, .025, COL.out); FX(6 + i, face - .026, .5, z - .3, .03, .5, COL.solar); });
  const setPw = (soc, col, led) => { PWZ.forEach((z, i) => { FX(2 + i, face - .016, .45, z + .05, .6, soc, col); fx.setColorAt(6 + i, new THREE.Color(led)); }); fx.instanceMatrix.needsUpdate = true; fx.instanceColor.needsUpdate = true; };
  // wiring (same FEED as home.js); the grid feed ends at the PEC pole
  const FEED = { solar: [[X, WALL - .05, 6.9], [X, 2.05, 6.9], [X, 2.05, 8.45]], home: [[X, 1.6, 8.3], [X, 1.6, 5.3]], batt: [[X, 1.4, 8.9], [X, 1.4, 9.3]], grid: [[X, 1.25, 8.6], [X, .05, 8.6], [X - 3, .05, 8.6], [X - 3, .05, 14]] };
  const flows = {};
  for (const [k, pts] of Object.entries(FEED)) {
    const path = new THREE.CurvePath(); for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(V(...pts[i]), V(...pts[i + 1])));
    const len = path.getLength(), u = { uColor: { value: new THREE.Color() }, uT: { value: 0 }, uOn: { value: 0 }, uDir: { value: 1 }, uLen: { value: len }, uSpeed: { value: 1 } };
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(12, Math.round(len * 12)), .06, 8, false), new THREE.ShaderMaterial({ uniforms: u,
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uT,uOn,uDir,uLen,uSpeed;
        void main(){float d=fract(vUv.x*uLen/.9-uT*uSpeed*uDir);float dash=smoothstep(.0,.15,d)*smoothstep(.75,.45,d);
          gl_FragColor=vec4(mix(vec3(.16,.17,.2),uColor*1.6,uOn*(.35+.65*dash)),1.);}` })));
    flows[k] = u;
  }
  // PEC pole at the grid feed's end (X−3, 0, 14): pole + crossarm + lamp arm merged, dark lamp head
  const pole = merge([new THREE.CylinderGeometry(.13, .18, 8, 8).translate(0, 4, 0), new THREE.BoxGeometry(.12, .12, 2.0).translate(0, 7.6, 0), new THREE.BoxGeometry(.08, .08, 1.7).translate(0, 6.6, .85)]);
  const poleM = new THREE.Mesh(pole, mat(0x3b342c, .9)); poleM.position.set(X - 3, 0, 14); g.add(poleM);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(.3, .16, .55), new THREE.MeshStandardMaterial({ color: 0x202328, roughness: .5, metalness: .3, emissive: 0x000000 })); lamp.position.set(X - 3, 6.48, 15.65); g.add(lamp);
  g.updateMatrixWorld(true);
  const local = (x, y, z) => g.localToWorld(V(x, y, z));
  const anchors = { home: local(-W / 2, 2.4, 4.5), pw: local(-W / 2 - .1, .3, 10.2), grid: local(X - 3, 8.2, 14) };
  return { group: g, panelMat, winMat, flows, anchors, local, edgeMats, setPw };
}
const sunVec = ({ el, az }, v = new THREE.Vector3()) => v.set(Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), -Math.cos(az * RAD) * Math.cos(el * RAD));

/** host: the card's `.o3d` box (holds the `[data-hud]` element). Returns { render(dt, t, card, calm), resize(), dispose() }. */
export function createOutageScene(host, dpr = Math.min(devicePixelRatio, 1.5)) {
  const hud = host.querySelector('[data-hud]');
  const canvas = document.createElement('canvas'); canvas.className = 'house-canvas'; host.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1; // no shadows
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x1a2030, 45, 140);
  const H = buildHouse(); scene.add(H.group);
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 500);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, enablePan: false, enableZoom: false, maxPolarAngle: Math.PI * .48 });
  touchOrbit(controls); // the page keeps scrolling; horizontal drags orbit
  camera.position.copy(H.local(-42, 11, 17)); controls.target.copy(H.local(-3, 2.6, 5));

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
  const moon = new THREE.DirectionalLight(0x9fbcff, 0); moon.position.set(35, 55, -30); scene.add(moon, moon.target);
  const nightFill = new THREE.DirectionalLight(0x8fa8d8, 0); scene.add(nightFill, nightFill.target);
  const sun = new THREE.DirectionalLight(0xfff0d8, 0); scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(70, 72), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: .95 })); ground.rotation.x = -Math.PI / 2; scene.add(ground);

  // neighbourhood: six dark houses on a loose ±35 m grid (house-local), instanced walls + 6-triangle hip roofs, matte, no windows
  const nMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: .95 }), nRoofMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: .95, flatShading: true, side: THREE.DoubleSide });
  const NB = [[33, -33, .95, .2], [36, -8, 1.05, -.1], [33, 15, .9, .15], [8, -38, 1, .05], [-30, -36, 1.1, -.2], [6, 38, .95, .1]];
  const nBox = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0), nMat, 6), nRoof = new THREE.InstancedMesh(hipGeo(6.4, 9.4, 6.4 * Math.tan(25 * RAD)), nRoofMat, 6);
  NB.forEach(([x, z, s, j], i) => { const p = H.local(x, 0, z), q = qY(THETA + j); nBox.setMatrixAt(i, m4.compose(p, q, V(12 * s, 3 * s, 18 * s))); nRoof.setMatrixAt(i, m4.compose(p.clone().setY(3 * s), q, V(s, s, s))); });
  scene.add(nBox, nRoof);

  // rain (as home.js), shown only in the storm variant
  const RN = 1200, rp = new Float32Array(RN * 6);
  for (let i = 0; i < RN; i++) { const x = (Math.random() - .5) * 70, y = Math.random() * 30, z = (Math.random() - .5) * 70; rp.set([x, y, z, x - .1, y - .9, z], i * 6); }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  const rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaecbff, transparent: true, opacity: .45 })); rain.visible = false; scene.add(rain);

  // labels: the app's .hlbl + leader lines, clamped inside the canvas and clear of the HUD
  const lift = { home: -44, pw: 22, grid: -12 }, names = { home: 'HOME', pw: 'POWERWALL · 2×', grid: 'PEC GRID' }, els = {}, lines = {}, size = {}, txt = {};
  for (const k of Object.keys(H.anchors)) {
    const el = document.createElement('div'); el.className = `hlbl ${lift[k] > 0 ? 'below' : ''} ${k === 'grid' ? 'off' : ''}`; el.innerHTML = `<small>${names[k]}</small><b>—</b>`; host.appendChild(el); els[k] = el;
    const l = document.createElement('div'); l.className = 'hlead'; host.appendChild(l); lines[k] = l;
  }
  const setLbl = (k, html) => { if (txt[k] === html) return; txt[k] = html; els[k].querySelector('b').innerHTML = html; size[k] = [els[k].offsetWidth, els[k].offsetHeight]; };
  let hudBox = null;

  const C = { nightTop: new THREE.Color(0x05070d), nightHor: new THREE.Color(0x121a2c), duskTop: new THREE.Color(0x2a3560), duskHor: new THREE.Color(0xe79a68), dayTop: new THREE.Color(0x3d6fb0), dayHor: new THREE.Color(0x9fb8d6), grayTop: new THREE.Color(0x4b5360), grayHor: new THREE.Color(0x7d8591), flash: new THREE.Color(0xb9c6e8) };
  const sd = new THREE.Vector3(), v = new THREE.Vector3();
  let CW = 1, CH = 1;
  function resize() { const r = host.getBoundingClientRect(); if (!r.width) return; CW = r.width; CH = r.height; renderer.setSize(CW, CH, false); camera.aspect = CW / CH; camera.updateProjectionMatrix(); hudBox = null; }
  const ro = new ResizeObserver(resize); ro.observe(host); resize();
  let nextFlash = 3 + Math.random() * 4, flashAt = -10, lastSoc = -1, lastCol = -1;

  return {
    resize,
    /** card: { cur, storm, startHour, hudDirty } from views/outage.js · calm: Calm mode or prefers-reduced-motion */
    render(dt, t, card, calm) {
      const cur = card.cur, storm = !!card.storm, cloud = storm ? 1 : .1;
      // the time of day follows the outage timeline; "now" is drawn as night with the sun forced to el = −10
      const hod = (card.startHour + cur.k) % 24, el = cur.k < .01 ? -10 : Math.max(-10, 62 * Math.sin(Math.PI * (hod - 7.3) / 12.2)), az = el > -4 ? 90 + 180 * clamp((hod - 7.3) / 12.2) : 290;
      sunVec({ el, az }, sd);
      let flash = 0;
      if (storm && !calm) { if (t > nextFlash) { flashAt = t; nextFlash = t + 6 + Math.random() * 6; } const d = t - flashAt; flash = Math.exp(-d * 9) + (d > .18 ? .7 * Math.exp(-(d - .18) * 12) : 0); if (d > 1.5) flash = 0; }
      const up = clamp((el + 4) / 14), high = clamp(el / 35);
      sky.top.value.copy(C.nightTop).lerp(C.duskTop, up).lerp(C.dayTop, high).lerp(C.grayTop, cloud * .7 * up).lerp(C.flash, flash * .55);
      sky.hor.value.copy(C.nightHor).lerp(C.duskHor, up).lerp(C.dayHor, high).lerp(C.grayHor, cloud * .7 * up).lerp(C.flash, flash * .35);
      sky.sunDir.value.copy(sd); sky.glow.value.set(0xffd9a0).multiplyScalar(up * (1 - cloud * .75)); sky.cloud.value = cloud; sky.t.value = t;
      scene.fog.color.copy(sky.hor.value).multiplyScalar(.6);
      sun.position.copy(sd).multiplyScalar(60); sun.intensity = 3.4 * clamp(el / 8) * (1 - cloud * .7); hemi.intensity = .55 + .45 * up + flash * 3.2;
      moon.intensity = (1 - up) * 1.1 * (1 - cloud * .5); nightFill.intensity = (1 - up) * .7; nightFill.position.copy(camera.position); nightFill.target.position.copy(controls.target);
      H.edgeMats.forEach(m => m.opacity = .12 + (1 - up) * .3);
      rain.visible = storm; if (storm) rain.position.y = -((t * 22 * (calm ? .35 : 1)) % 30);

      // the house as the island simulation has it
      H.panelMat.emissiveIntensity = (1 - up) * .15 + cur.s / 9 * .5;
      H.winMat.emissiveIntensity = cur.dark ? 0 : Math.min(1.6, (1 - up) * (.4 + cur.h / 4));
      const col = cur.dark ? 0x3a3f48 : cur.b < -.05 ? COL.batt : cur.b > .05 ? COL.solar : COL.rest, led = cur.dark ? 0x3a3f48 : cur.b < -.05 ? COL.batt : cur.b > .05 ? COL.solar : COL.idle;
      if (Math.abs(cur.soc - lastSoc) > .0005 || col !== lastCol) { H.setPw(cur.soc, col, led); lastSoc = cur.soc; lastCol = col; }
      const set = (k, on, dir, color, amt) => { const f = H.flows[k]; f.uOn.value = on ? 1 : 0; f.uDir.value = dir; f.uColor.value.set(color); f.uSpeed.value = calm ? .3 : .6 + Math.min(1.6, amt / 3); f.uT.value = t; };
      set('solar', cur.s > .05, 1, COL.solar, cur.s);
      set('batt', !cur.dark && Math.abs(cur.b) > .05, cur.b < 0 ? 1 : -1, cur.b < 0 ? COL.solar : COL.batt, Math.abs(cur.b));
      set('home', !cur.dark, 1, cur.s >= cur.h ? COL.solar : COL.batt, cur.h);
      H.flows.grid.uOn.value = 1; H.flows.grid.uColor.value.set(COL.out); H.flows.grid.uSpeed.value = 0; H.flows.grid.uT.value = 0; // red and still
      setLbl('home', cur.dark ? 'dark' : `${cur.h.toFixed(1)} kW`); els.home.classList.toggle('dark', cur.dark);
      setLbl('pw', `${Math.abs(cur.b) < .05 ? 0 : Math.abs(cur.b).toFixed(1)} kW ${cur.b < -.05 ? '<i style="color:var(--batt)">▲</i>' : cur.b > .05 ? '<i style="color:var(--solar)">▼</i>' : '<i style="color:var(--mute)">·</i>'}${Math.round(cur.soc * 100)}%`);
      setLbl('grid', 'Offline');

      controls.update(); renderer.render(scene, camera);
      if (card.hudDirty || !hudBox) { hudBox = [hud.offsetLeft, hud.offsetTop, hud.offsetLeft + hud.offsetWidth, hud.offsetTop + hud.offsetHeight]; card.hudDirty = false; }
      for (const [k, p] of Object.entries(H.anchors)) {
        v.copy(p).project(camera); const ax = (v.x + 1) / 2 * CW, ay = (1 - v.y) / 2 * CH, dy = lift[k], [w, h] = size[k] || [80, 34], below = dy > 0;
        const vis = v.z < 1 && ax > -40 && ax < CW + 40 && ay > -40 && ay < CH + 40; els[k].style.visibility = lines[k].style.visibility = vis ? 'visible' : 'hidden'; if (!vis) continue;
        const x = clamp(ax, w / 2 + 6, CW - w / 2 - 6); let top = ay + dy;
        if (below) top = clamp(top, 6, CH - h - 6);
        else { let minTop = h + 6; if (x - w / 2 < hudBox[2] + 4 && x + w / 2 > hudBox[0] - 4) minTop = Math.max(minTop, hudBox[3] + 6 + h); top = clamp(top, minTop, CH - 6); }
        els[k].style.left = x + 'px'; els[k].style.top = top + 'px';
        const lx = clamp(ax, 2, CW - 2), y0 = Math.min(ay, top), y1 = Math.max(ay, top);
        lines[k].style.left = lx + 'px'; lines[k].style.top = (below ? y0 : y0 + 4) + 'px'; lines[k].style.height = Math.max(0, y1 - y0 - 4) + 'px';
      }
    },
    /** Frees everything: geometries, materials, textures, the WebGL context, the canvas and the labels. */
    dispose() {
      ro.disconnect(); controls.dispose();
      scene.traverse(o => { o.geometry?.dispose(); if (o.isInstancedMesh) o.dispose(); const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        ms.forEach(m => { Object.values(m).forEach(x => { if (x?.isTexture) x.dispose(); }); m.dispose(); }); });
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
      [...Object.values(els), ...Object.values(lines)].forEach(e => e.remove());
    },
  };
}
