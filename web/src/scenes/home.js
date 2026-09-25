import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchOrbit } from '../lib/touchorbit.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sunAt, siteLocation, RAD, hourLabel, localDate, localHour } from '../lib/util.js';

/*
 * One model of the real house, used in two views:
 *   'flow' (Now → Energy flow card): Tesla-style framing, live flow lines along the wiring, kW labels. It is also the whole-home
 *          twin (mockup k-home-twin): pool, spa and equipment pad north of the covered patio, the AC condenser on the west wall,
 *          fill strips on both Powerwalls, pool and AC feed lines, and under the canvas a replay row, appliance chips and a running
 *          total since midnight. Scrubbing eases the camera out to a framing that takes in the pool; Live (or 20 s idle) eases back.
 *   'sun'  (Panels → Live roof):     today's sun path, real shadows, panel glow, weather. No pool, pad or condenser here.
 * Geometry traced from the satellite image: a single hip roof (~14 × 24 m, 27° pitch), the house's long axis
 * running 154°/334°, all 30 SunPower E19-320 AC modules on the west-southwest face (facing 244°) in 3 rows × 10, covered patio at the
 * pool (north) end, garage door on the driveway (south) end. World axes: +x east, −z north.
 */
const TILT = 27 * RAD, W = 14, L = 24, WALL = 3.2, OH = .5;
const THETA = Math.atan2(Math.sin(154 * RAD), -Math.cos(154 * RAD)); // local +z → bearing 154°

function tex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }

/* ---------- twin helpers (from the mockup): merged vertex-coloured geometry, straight-run tubes, the pool twin's water ---------- */
const M = (x, y, z, ry = 0, rx = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(1, 1, 1));
/** Merge [geometry, matrix, colour] items into one vertex-coloured geometry: one draw call per material. */
function mergeColored(items) {
  const P = [], N = [], C = [], c = new THREE.Color();
  for (const [geo, m, hex] of items) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m); if (!g.attributes.normal) g.computeVertexNormals();
    c.set(hex); const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { P.push(p.getX(i), p.getY(i), p.getZ(i)); N.push(n.getX(i), n.getY(i), n.getZ(i)); C.push(c.r, c.g, c.b); }
    g.dispose(); geo.dispose();
  }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); out.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); return out;
}
/** Light tube for the dash-flow shader: one 8-sided cylinder per straight run, uv.x = distance along the whole feed (0–1). */
function segTube(pts, r = .06, rad = 8) {
  const V = pts.map(p => new THREE.Vector3(...p)), lens = V.slice(1).map((v, i) => v.distanceTo(V[i])), total = lens.reduce((a, b) => a + b, 0);
  const pos = [], uv = [], idx = []; let acc = 0; const up = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3(), d = new THREE.Vector3(), o = new THREE.Vector3();
  for (let i = 0; i < lens.length; i++) {
    d.subVectors(V[i + 1], V[i]).normalize(); up.set(Math.abs(d.y) > .9 ? 1 : 0, Math.abs(d.y) > .9 ? 0 : 1, 0); n1.crossVectors(d, up).normalize(); n2.crossVectors(d, n1);
    const a = V[i].clone().addScaledVector(d, i ? -r : 0), b = V[i + 1].clone().addScaledVector(d, i < lens.length - 1 ? r : 0);
    const ua = (acc - (i ? r : 0)) / total, ub = (acc + lens[i] + (i < lens.length - 1 ? r : 0)) / total, base = pos.length / 3;
    for (let j = 0; j <= rad; j++) { const t = j / rad * Math.PI * 2; o.copy(n1).multiplyScalar(Math.cos(t) * r).addScaledVector(n2, Math.sin(t) * r);
      pos.push(a.x + o.x, a.y + o.y, a.z + o.z, b.x + o.x, b.y + o.y, b.z + o.z); uv.push(ua, j / rad, ub, j / rad); }
    for (let j = 0; j < rad; j++) { const A = base + 2 * j, B = A + 1, A2 = A + 2, B2 = A + 3; idx.push(A, B, A2, B, B2, A2); }
    acc += lens[i];
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return { geo: g, len: total };
}
// pooltwin.js water shader, unchanged
const waterMat = () => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uT: { value: 0 }, uGlow: { value: 0 }, uFlow: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `varying vec2 vUv;uniform float uT,uGlow,uFlow;uniform vec2 uSize;
    void main(){vec2 p=(vUv-.5)*uSize; float r=length(p/(uSize*.5)); float base=.22+.18*(1.-r);
      float rings=0.; for(int i=0;i<3;i++){ float ph=fract(uT*.18+float(i)/3.); float rr=ph*1.15; rings+=smoothstep(.03,.0,abs(r-rr))*(1.-ph)*.5; }
      float lanes=smoothstep(.85,1.,sin(p.x*4.+uT*2.2*uFlow)*.5+.5)*uFlow*.35*(1.-r*.7);
      float shimmer=(sin(p.x*9.+uT*1.3)*sin(p.y*11.-uT*1.1))*.05;
      vec3 col=mix(vec3(.26,.62,1.),vec3(.45,.95,1.),uGlow*.8);
      float a=base+rings*(.4+uFlow)+lanes+shimmer+uGlow*.25; gl_FragColor=vec4(col*(1.+uGlow*.6),clamp(a,0.,.9));}` });
/** The design tokens, read once from :root (--ac and --rest come from the k-home-twin block in style.css). */
function palette() {
  const css = getComputedStyle(document.documentElement), tok = (n, f) => new THREE.Color(css.getPropertyValue(n).trim() || f).getHex();
  return { solar: tok('--solar', '#ffc15e'), batt: tok('--batt', '#4ef0a6'), home: tok('--home', '#6cc4ff'), grid: tok('--grid', '#c4a2ff'), out: tok('--out', '#ff5a4e'), ac: tok('--ac', '#ff9e66'), rest: tok('--rest', '#8d93a8') };
}

/**
 * The twin's additions, all in house-local metres (hidden from the 'sun' view by never being built there): Powerwall fill strips
 * with a reserve tick, the pool (pool twin outline rescaled to metres, centred north of the patio, long axis east-west) with the spa
 * at its north-west end and the equipment pad east of it, the condenser on the west wall between the last window and the gateway,
 * the pump rotor and condenser fan, the return stream and exhaust particles, and the pool and AC feeds.
 */
function buildExtras(g, X, PAL) {
  const ex = new THREE.Group(); g.add(ex);
  // Powerwall fill strips: base at y .45, scale.y = soc/100; dark track and the --out reserve tick behind them
  const strip = new THREE.Mesh(mergeColored([9.7, 10.6].map(z => [new THREE.PlaneGeometry(.6, 1).translate(0, .5, 0), M(-W / 2 - .187, 0, z + .03, -Math.PI / 2), 0xffffff])), new THREE.MeshBasicMaterial({ color: PAL.batt }));
  strip.position.y = .45; ex.add(strip);
  ex.add(new THREE.Mesh(mergeColored([9.7, 10.6].map(z => [new THREE.PlaneGeometry(.6, 1), M(-W / 2 - .184, .95, z + .03, -Math.PI / 2), 0x1a1d24])), new THREE.MeshBasicMaterial({ vertexColors: true })));
  const tick = new THREE.Mesh(mergeColored([9.7, 10.6].map(z => [new THREE.PlaneGeometry(.68, .03), M(-W / 2 - .19, 0, z + .03, -Math.PI / 2), PAL.out])), new THREE.MeshBasicMaterial({ vertexColors: true }));
  tick.position.y = .45 + .2; ex.add(tick);
  // pool: pooltwin outline (feet) → metres, centred at (−3, −23), long axis ≈ east-west
  const FTM = .3048, pl = (x, z) => [-3 + (x - 16.65) * FTM, -23 + (z - 9.7) * FTM], F = (x, z, y = .08) => { const [X2, Z] = pl(x, z); return new THREE.Vector3(X2, y, Z); };
  const outline = [[1, 7], [3, 3], [8, 1], [14, 1.5], [19, 3.5], [24, 2], [29, 3], [32.5, 7], [31.5, 12], [27, 16], [21, 18.2], [15, 17.5], [9, 18.4], [4, 16.5], [.8, 12]];
  const oPts = new THREE.CatmullRomCurve3(outline.map(([x, z]) => F(x, z, 0)), true, 'catmullrom', .5).getPoints(120);
  const shape = new THREE.Shape(oPts.map(p => new THREE.Vector2(p.x, -p.z))), sg = new THREE.ShapeGeometry(shape);
  { const bb = new THREE.Box2(); oPts.forEach(p => bb.expandByPoint(new THREE.Vector2(p.x, -p.z))); const s2 = bb.getSize(new THREE.Vector2()), pos = sg.attributes.position, uv = sg.attributes.uv; for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / s2.x, (pos.getY(i) - bb.min.y) / s2.y); uv.needsUpdate = true; }
  const floor = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x103552, roughness: .35 })); floor.rotation.x = -Math.PI / 2; floor.position.y = .02; floor.receiveShadow = true; ex.add(floor);
  const water = new THREE.Mesh(sg, waterMat()); water.material.uniforms.uSize.value.set(6.5, 3.7); water.rotation.x = -Math.PI / 2; water.position.y = .05; ex.add(water);
  ex.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(oPts.map(p => p.clone().setY(.07))), new THREE.LineBasicMaterial({ color: 0xd6dbe2, transparent: true, opacity: .55 })));
  const [sx, sz] = pl(5.5, -1.5), SRd = 3.5 * FTM;                        // 7' spa at the north-west end, raised 0.3 m
  const spaW = new THREE.Mesh(new THREE.CircleGeometry(SRd - .07, 24), waterMat()); spaW.material.uniforms.uSize.value.set(2, 2); spaW.rotation.x = -Math.PI / 2; spaW.position.set(sx, .33, sz); ex.add(spaW);
  // equipment pad 0.76 × 2.4 m east of the pool; condenser 0.9 × 0.8 × 0.9 on the west wall between the last window and the gateway
  const PX = 5.03, PZ = -18.03, PUMPZ = PZ - .91, CX = -W / 2 - .8, CZ = 6.2;
  ex.add(Object.assign(new THREE.Mesh(mergeColored([
    [new THREE.CylinderGeometry(SRd, SRd, .32, 28), M(sx, .16, sz), 0x9aa0a8],
    [new THREE.BoxGeometry(.76, .1, 2.4), M(PX, .05, PZ), PAL.rest], [new THREE.BoxGeometry(.55, .5, .5), M(PX, .35, PUMPZ), 0x3f5566],
    [new THREE.CylinderGeometry(.3, .3, 1.0, 16), M(PX, .6, PZ), 0xd8cfae], [new THREE.BoxGeometry(.6, .6, .6), M(PX, .4, PZ + .93), 0x6e727a],
    [new THREE.BoxGeometry(.9, .8, .9), M(CX, .45, CZ), 0x575c64]]), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .7, metalness: .1 })), { castShadow: true, receiveShadow: true }));
  const rotor = new THREE.Mesh(mergeColored([[new THREE.TorusGeometry(.17, .02, 6, 20), M(0, 0, 0), PAL.home], [new THREE.BoxGeometry(.3, .03, .02), M(0, 0, 0), 0xffffff]]), new THREE.MeshBasicMaterial({ vertexColors: true }));
  rotor.position.set(PX - .29, .35, PUMPZ); rotor.rotation.y = Math.PI / 2; ex.add(rotor);
  const fan = new THREE.Mesh(mergeColored([[new THREE.TorusGeometry(.3, .025, 6, 24), M(0, 0, 0), PAL.ac], [new THREE.BoxGeometry(.5, .03, .02), M(0, 0, 0), 0xffffff]]), new THREE.MeshBasicMaterial({ vertexColors: true }));
  fan.position.set(CX, .87, CZ); fan.rotation.x = Math.PI / 2; ex.add(fan);
  const pointsOf = (n, color, size) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)); const p = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); p.frustumCulled = false; p.visible = false; ex.add(p); return p; };
  const streamCurve = new THREE.CatmullRomCurve3([F(31, 9), F(37, 13), new THREE.Vector3(PX - .45, .3, PUMPZ - .1), new THREE.Vector3(PX, .8, PZ), new THREE.Vector3(PX - .35, .4, PZ + .93), F(34, 19.5), F(24, 19.6), F(14, 19.2), F(5, 16.5)], false, 'catmullrom', .2);
  const stream = pointsOf(90, PAL.home, .28), exhaust = pointsOf(120, PAL.ac, .22);
  const feeds = {
    pool: [[X, 1.6, 5.3], [X, .05, 5.3], [X - 2.4, .05, 5.3], [X - 2.4, .05, -19.4], [PX - .28, .05, -19.4], [PX - .28, .05, PUMPZ], [PX - .28, .3, PUMPZ]],
    ac:   [[X, 1.6, 5.3], [X, 1.0, CZ], [CX + .45, .8, CZ]],
  };
  return { group: ex, strip, tick, water, spaW, rotor, fan, stream, streamCurve, exhaust, cond: [CX, CZ], feeds, anchors: { ac: [CX, .95, CZ], pool: [PX, .75, PUMPZ] } };
}

const flowMat = (u, side = THREE.FrontSide) => new THREE.ShaderMaterial({ uniforms: u, side,
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uT,uOn,uDir,uLen,uSpeed;
    void main(){float d=fract(vUv.x*uLen/.9-uT*uSpeed*uDir);float dash=smoothstep(.0,.15,d)*smoothstep(.75,.45,d);
      gl_FragColor=vec4(mix(vec3(.16,.17,.2),uColor*1.6,uOn*(.35+.65*dash)),1.);}` });

function buildHouse(mode, PAL) {
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
    const body = new THREE.Mesh(new THREE.BoxGeometry(Wd, wallH, Ln), wallMat); body.position.y = wallH / 2; body.castShadow = body.receiveShadow = true; grp.add(body);
    const w = Wd / 2 + over, l = Ln / 2 + over, H = w * Math.tan(tilt), r = Math.max(0, l - w);
    const A = [-w, 0, -l], B = [w, 0, -l], C = [w, 0, l], D = [-w, 0, l], R1 = [0, H, -r], R2 = [0, H, r];
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([A, D, R2, A, R2, R1, B, R1, R2, B, R2, C, A, R1, B, D, C, R2].flat(), 3)); geo.computeVertexNormals();
    const roof = new THREE.Mesh(geo, roofMat.clone()); roof.material.side = THREE.DoubleSide; roof.material.flatShading = true; roof.position.y = wallH; roof.castShadow = roof.receiveShadow = true; grp.add(roof);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .12 })); e.position.y = wallH; grp.add(e); edgeMats.push(e.material);
    return { grp, w };
  }
  const main = hip(W, L, WALL, TILT, wall, roofM, OH); g.add(main.grp);
  const patio = hip(7, 6, 2.8, 22 * RAD, mat(0x34373e), mat(0x1f2126, .85), .3); patio.grp.position.set(-5.5, 0, -14.5); g.add(patio.grp);

  // 30 panels on the west (−x) face: 3 rows up the slope × 10 along the ridge
  const arr = new THREE.Group(); arr.position.set(-main.w, WALL, 0); arr.rotation.z = TILT; g.add(arr);
  // SunPower SPR-E19-320-AC modules: 1558 × 1046 mm, portrait (long side up the slope), 33 mm apart
  const pGeo = new THREE.BoxGeometry(1.558, .05, 1.046);
  const panelEdge = new THREE.LineBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: .15 }); edgeMats.push(panelEdge);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) { const p = new THREE.Mesh(pGeo, panelMat); p.position.set(.9 + (r + .5) * 1.591, .09, 1.2 + (c - 4.5) * 1.079); p.castShadow = p.receiveShadow = true; arr.add(p); const e = new THREE.LineSegments(new THREE.EdgesGeometry(pGeo), panelEdge); e.position.copy(p.position); arr.add(e); }

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
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(12, Math.round(len * 12)), .06, 8, false), flowMat(u)));
    flows[k] = u;
  }
  // the twin: extras plus the pool and AC feeds, in the same dash-flow shader
  const ex = mode === 'flow' ? buildExtras(g, X, PAL) : null;
  if (ex) for (const [k, pts] of Object.entries(ex.feeds)) {
    const { geo, len } = segTube(pts), u = { uColor: { value: new THREE.Color() }, uT: { value: 0 }, uOn: { value: 0 }, uDir: { value: 1 }, uLen: { value: len }, uSpeed: { value: 1 } };
    g.add(new THREE.Mesh(geo, flowMat(u, THREE.DoubleSide))); flows[k] = u;
  }
  g.updateMatrixWorld(true);
  const panelNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(arr.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const local = (x, y, z) => g.localToWorld(new THREE.Vector3(x, y, z));
  const anchors = { solar: local(-4.4, 5.3, 1.2), home: local(-W / 2, 2.4, 4.5), pw: local(-W / 2 - .1, .3, 10.2), grid: local(X - 3, .05, 13) };
  if (ex) { anchors.ac = local(...ex.anchors.ac); anchors.pool = local(...ex.anchors.pool); }
  return { group: g, panelMat, winMat, pwLeds, flows, panelNormal, anchors, local, edgeMats, ex };
}

const sunVec = ({ el, az }, v = new THREE.Vector3()) => v.set(Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), -Math.cos(az * RAD) * Math.cos(el * RAD));

/* ---------- twin: text and time helpers ---------- */
const fmt = h => { const m = Math.round(h * 60) % 1440, H = Math.floor(m / 60), Mn = m % 60; return `${H % 12 || 12}:${String(Mn).padStart(2, '0')} ${H < 12 ? 'AM' : 'PM'}`; };
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const EASE = (() => { const x1 = .2, y1 = .8, x2 = .2, y2 = 1; return t => { let s = t; for (let i = 0; i < 8; i++) { const x = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3 - t, dx = 3 * (1 - s) ** 2 * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2); if (Math.abs(dx) < 1e-6) break; s = clampN(s - x / dx, 0, 1); } return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3; }; })(); // --ease
/** Chicago midnight of a YYYY-MM-DD day, epoch ms (CDT or CST; DST switches at 2 AM, so midnight keeps the day's first offset). */
const dayStarts = new Map(), dayStartMs = date => { if (!dayStarts.has(date)) { let ms = Date.parse(`${date}T00:00:00-06:00`); for (const off of ['-05:00', '-06:00']) { const t = Date.parse(`${date}T00:00:00${off}`); if (localDate(new Date(t)) === date && localHour(new Date(t)) === 0) { ms = t; break; } } dayStarts.set(date, ms); } return dayStarts.get(date); };
/** The AC phase from the thermostat, the same rule the server uses (server/src/appliances/day.ts acPhase). */
function acPhase(on, sp, hour, s) {
  const b = s?.band ?? { homeLo: 74, homeHi: 78 }, mid = Math.min(b.homeHi, Math.max(b.homeLo, Math.round((b.homeLo + b.homeHi) / 2)));
  const day = hour >= (s?.nightTo ?? 7) && hour < (s?.nightFrom ?? 22);
  if (on) return day && sp != null && sp < mid - .25 ? 'pre-cool' : 'cool';
  return day && sp != null && sp > mid + .25 && sp <= Math.max(s?.coastF ?? 78, b.homeHi) + .25 ? 'coast' : 'idle';
}
const KEYS = ['solar', 'home', 'pw', 'grid', 'ac', 'pool'];
const NAMES = { solar: 'SOLAR', home: 'HOME', pw: 'POWERWALL · 2×', grid: 'PEC GRID', ac: 'AC', pool: 'POOL' };
// label offsets from the anchor [dx, dy]; live = today's card, twin = tuned for the wide framing
const PREF = { live: { solar: [0, -40], home: [0, -54], pw: [0, 24], grid: [0, -34], ac: [0, -40], pool: [0, -40] },
               twin: { solar: [0, -62], home: [-70, -40], pw: [0, 40], grid: [0, -60], ac: [-135, 44], pool: [0, -50] } };

export function createHomeView(host, mode = 'flow', opts = {}) {
  const twin = mode === 'flow';
  const PAL = palette();
  const canvas = document.createElement('canvas'); canvas.className = 'house-canvas'; host.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const phone = matchMedia('(pointer: coarse)').matches || innerWidth < 900;
  const DPR = twin ? Math.min(devicePixelRatio || 1, 1.5) : Math.min(devicePixelRatio, 2);       // the Now twin is capped at 1.5
  renderer.setPixelRatio(DPR); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = twin ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  if (twin) renderer.shadowMap.autoUpdate = false;                                                   // shadows on demand: when the sun moves
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x1a2030, 45, 140);
  const H = buildHouse(mode, PAL); scene.add(H.group);

  // camera: flow view looks at the panel (west) face from the WSW like the Tesla app; sun view orbits wider
  const camera = new THREE.PerspectiveCamera(mode === 'flow' ? 32 : 40, 1, .1, 500);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, enablePan: false, enableZoom: false, maxPolarAngle: Math.PI * .48 });
  touchOrbit(controls);
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
  // after dark: cool moonlight from high in the north-east plus a soft fill from the viewer, so the roof, panels and equipment stay readable
  const moon = new THREE.DirectionalLight(0x9fbcff, 0); moon.position.set(35, 55, -30); scene.add(moon, moon.target);
  const nightFill = new THREE.DirectionalLight(0x8fa8d8, 0); scene.add(nightFill, nightFill.target);
  const sun = new THREE.DirectionalLight(0xfff0d8, 3); sun.castShadow = true; sun.shadow.bias = -.0005; sun.shadow.normalBias = .04;
  if (twin) { const s = phone ? 1024 : 2048; sun.shadow.mapSize.set(s, s); Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 160 }); } // takes in the pool
  else { sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 160 }); }
  scene.add(sun, sun.target);
  // Now card: a soft fill from the viewer's side keeps the wall, wiring and equipment readable when the sun is behind the house
  if (mode === 'flow') { const fill = new THREE.DirectionalLight(0xdfe8ff, .9); fill.position.copy(camera.position); fill.target.position.copy(controls.target); scene.add(fill, fill.target); }
  const ground = new THREE.Mesh(new THREE.CircleGeometry(70, 72), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: .95 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffd48a, fog: false })); sunBall.visible = mode === 'sun'; scene.add(sunBall);

  // DOM overlays: CSS2D for sun-path hour marks (sun view); the flow view's labels and leaders are laid out by the twin below
  const css = new CSS2DRenderer(); Object.assign(css.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.appendChild(css.domElement);
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
  const sz = { w: 0, h: 0 };
  function resize() { const r = canvas.getBoundingClientRect(); if (!r.width) return; sz.w = r.width; sz.h = r.height; renderer.setSize(r.width, r.height, false); css.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  /** Sky, fog, sun, moon and rain for a sun position (both views). Returns the day factor `up` (0 night … 1 day). */
  function light(sp, cloud, code, dt, t) {
    sunVec(sp, sd);
    const up = Math.max(0, Math.min(1, (sp.el + 4) / 14)), high = Math.max(0, Math.min(1, sp.el / 35));
    sky.top.value.copy(C.nightTop).lerp(C.duskTop, up).lerp(C.dayTop, high).lerp(C.grayTop, cloud * .7 * up);
    sky.hor.value.copy(C.nightHor).lerp(C.duskHor, up).lerp(C.dayHor, high).lerp(C.grayHor, cloud * .7 * up);
    sky.sunDir.value.copy(sd); sky.glow.value.set(0xffd9a0).multiplyScalar(up * (1 - cloud * .75)); sky.cloud.value = cloud; sky.t.value = t;
    scene.fog.color.copy(sky.hor.value).multiplyScalar(.6);
    sun.position.copy(sd).multiplyScalar(60); sun.intensity = 3.4 * Math.max(0, Math.min(1, sp.el / 8)) * (1 - cloud * .7); hemi.intensity = .55 + .45 * up;
    moon.intensity = (1 - up) * 1.1 * (1 - cloud * .5); nightFill.intensity = (1 - up) * .7; nightFill.position.copy(camera.position); nightFill.target.position.copy(controls.target);
    H.edgeMats.forEach(m => m.opacity = .12 + (1 - up) * .3);
    sunBall.position.copy(sd).multiplyScalar(160); sunBall.visible = mode === 'sun' && sp.el > -3;
    rain.material.opacity += ((code >= 51 ? .45 : 0) - rain.material.opacity) * dt * 2; if (code >= 51) rain.position.y = -((t * 22) % 30);
    return up;
  }

  /* ---------------- 'sun' view (Panels → Live roof): unchanged ---------------- */
  function renderSun({ r, now = new Date(), dayStart, cloud = .1, code = 0, peakKw = 9, dt, t, calm }) {
    const sp = sunAt(now), up = light(sp, cloud, code, dt, t);
    if (dayStart && pathDay !== dayStart && siteLocation()) { pathDay = dayStart; drawSunPath(dayStart); } // the path waits for the site's location
    const solar = r?.solarKw ?? 0;
    H.panelMat.emissive.copy(rampAt(solar / peakKw).lerp(new THREE.Color(0x2d5bff), (1 - up) * .5));
    H.panelMat.emissiveIntensity = .12 + (1 - up) * .2 + solar / peakKw * .9;
    H.winMat.emissiveIntensity = Math.min(1.6, (1 - up) * (.4 + (r?.homeKw ?? 1) / 4));
    if (r) H.pwLeds.forEach(l => l.material.color.set(r.batteryKw < -.05 ? 0x4ef0a6 : r.batteryKw > .05 ? 0xffc15e : 0x9aa3b0));
    Object.values(H.flows).forEach(f => { f.uOn.value = 0; });
    controls.autoRotate = !calm && controls.autoRotate;
    controls.update(); renderer.render(scene, camera); css.render(scene, camera);
    return { el: sp.el, az: sp.az, inc: Math.acos(Math.max(-1, Math.min(1, H.panelNormal.dot(sd)))) / RAD };
  }

  const view = { render: twin ? null : renderSun, dispose };
  const cleanup = [];
  function dispose() {
    cleanup.forEach(f => f()); ro.disconnect(); controls.dispose();
    scene.traverse(o => { o.geometry?.dispose(); for (const m of [o.material].flat().filter(Boolean)) { for (const x of Object.values(m)) if (x?.isTexture) x.dispose(); m.dispose(); } });
    renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); css.domElement.remove();
  }
  if (!twin) return view;

  /* ---------------- 'flow' view: the whole-home twin (mockup k-home-twin) ---------------- */
  const EX = H.ex, card = host.closest('.card'), abort = new AbortController(), on = (el, ev, fn) => el?.addEventListener(ev, fn, { signal: abort.signal });
  const q = s => card?.querySelector(s);
  const noteEl = q('.h span'), hud = host.querySelector('.twinhud'), range = q('.twin-row input'), tm = q('.twin-row .tm'), playB = q('.twin-row .play'), liveB = q('.twin-row .livep');
  const [chipP, chipA, chipB] = card ? card.querySelectorAll('.circ span') : [], tip = q('.landtip');
  const FR = { live: { pos: H.local(-38, 19, 12), tgt: H.local(-3, 2.2, 3.5), fov: 32 }, twin: { pos: H.local(-74, 55, -7), tgt: H.local(-2, 9, -7), fov: 34 } };
  const st = { mode: 'live', h: localHour(), playing: false, dragging: false, idle: -1, k: 0, tw: null, calm: false, now: localHour(), nowAt: 0, date: localDate() };
  let vis = false;
  const io = new IntersectionObserver(es => { vis = es[es.length - 1].intersectionRatio >= .1; }, { threshold: [0, .1, .5] }); io.observe(host);

  // labels with leaders, and the replay HUD
  const els = {}, leads = {}, meta = {};
  for (const k of KEYS) {
    const el = document.createElement('div'); el.className = 'hlbl' + (k === 'pool' || k === 'ac' ? ' link' : ''); el.innerHTML = `<small>${NAMES[k]}</small><b>—</b>`; el.style.visibility = 'hidden'; host.appendChild(el);
    const l = document.createElement('div'); l.className = 'hlead'; l.style.visibility = 'hidden'; host.appendChild(l); els[k] = el; leads[k] = l; meta[k] = { html: null, w: 60, h: 34, dirty: true, edge: '' }; // hidden until the first layout
  }
  // POOL and AC open Insights → Appliances with that appliance selected. A link only: nothing here changes the pool or the thermostat.
  on(els.pool, 'click', () => opts.onLink?.('pool')); on(els.ac, 'click', () => opts.onLink?.('ac'));
  const hudM = { html: null, rect: null, dirty: true };
  document.fonts?.ready.then(() => { for (const k of KEYS) meta[k].dirty = true; hudM.dirty = true; });   // label boxes measured before Manrope loaded are re-measured
  cleanup.push(() => { abort.abort(); io.disconnect(); for (const k of KEYS) { els[k].remove(); leads[k].remove(); } if (hud) { hud.hidden = true; hud.innerHTML = ''; } });

  /* ---- interactions ---- */
  const setDpr = d => { renderer.setPixelRatio(d); if (sz.w) renderer.setSize(sz.w, sz.h, false); };
  const touch = () => { st.idle = 20; };
  function tweenTo(F) { const k1 = F === FR.twin ? 1 : 0;
    if (st.calm) { camera.position.copy(F.pos); controls.target.copy(F.tgt); camera.fov = F.fov; camera.updateProjectionMatrix(); st.k = k1; st.tw = null; return; }
    st.tw = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), f0: camera.fov, k0: st.k, F, k1 }; }
  function enterReplay() { if (st.mode === 'replay') return; st.mode = 'replay'; tweenTo(FR.twin); }
  function goLive() { st.mode = 'live'; st.playing = false; st.idle = -1; st.h = st.now; tweenTo(FR.live); }
  function release() { if (st.mode === 'replay' && !st.playing && Math.abs(st.h - st.now) <= 10 / 60) goLive(); }
  on(range, 'pointerdown', () => { st.dragging = true; setDpr(Math.min(DPR, 1.25)); st.playing = false; touch(); });
  const up = () => { if (!st.dragging) return; st.dragging = false; setDpr(DPR); release(); };
  on(window, 'pointerup', up); on(window, 'pointercancel', up);
  on(range, 'input', () => { st.h = Math.round(+range.value * 12) / 12; st.playing = false; enterReplay(); touch(); });   // step .0833 is not quite 5 min: snap
  on(range, 'keydown', e => { if (!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return; e.preventDefault();   // ←/→ is the range's own 5 min; Shift = 1 h
    if (st.mode === 'live') st.h = st.now; st.h = clampN(st.h + (e.key === 'ArrowRight' ? 1 : -1), 0, 24); st.playing = false; enterReplay(); touch(); });
  on(playB, 'click', () => { if (st.playing) { st.playing = false; touch(); return; }
    if (st.mode === 'live' || st.h >= st.now - 1 / 60) st.h = 0; enterReplay(); st.playing = true; touch(); });
  on(liveB, 'click', goLive);
  on(canvas, 'pointerdown', () => { st.tw = null; if (st.mode === 'replay') touch(); });

  /* ---- one frame of data: live (S.live, S.pool.live, S.ac.state) or the replayed hour (/api/appliances/day) ---- */
  const fresh = at => at && Date.now() - at < 30 * 60_000;       // a pool or Nest state older than 30 min is not shown as live
  let wxRef = null, wxIdx = null;
  function wxAt(wx, date, hh) {
    if (!wx?.hourly?.time) return null;
    if (wxRef !== wx) { wxRef = wx; wxIdx = new Map(wx.hourly.time.map((t, i) => [t, i])); }
    const i = wxIdx.get(`${date}T${String(hh).padStart(2, '0')}:00`); return i == null ? null : { cloud: (wx.hourly.cloud_cover[i] ?? 10) / 100, code: wx.hourly.weather_code[i] ?? 0 };
  }
  function socAt(D, h) {
    const pts = D.hours.filter(x => x.energy?.soc != null).map(x => [x.hour + .5, x.energy.soc]); if (!pts.length) return null;
    if (h <= pts[0][0]) return pts[0][1]; if (h >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) if (h <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (h - x0) / (x1 - x0); }
    return null;
  }
  /** Where stored data ends today: the last hour with energy buckets (5 min each), never past now. */
  const dataEnd = D => { if (!D) return st.now; const e = D.hours.filter(x => x.energy); if (!e.length) return 0; const l = e[e.length - 1]; return Math.min(st.now, l.hour + Math.min(12, l.energy.buckets) / 12); };
  function liveFrame(c) {
    const pl = c.pool?.live, as = c.ac?.state, acKw = c.ac?.learned?.acKw ?? c.day?.acKw ?? 0;
    const pool = pl && fresh(pl.at) ? { running: !!pl.running, rpm: pl.running ? Math.round(pl.rpm ?? 0) : 0, watts: pl.running ? Math.round(pl.watts ?? 0) : 0, source: 'measured' } : null;
    let ac = null;
    if (as && fresh(as.at)) { const isOn = as.hvac === 'COOLING'; ac = { on: isOn, phase: acPhase(isOn, as.coolF, Math.floor(st.now), c.ac?.settings), set: as.coolF, indoorF: as.indoorF, kw: isOn ? acKw : 0 }; }
    return { sp: sunAt(new Date()), cloud: c.cloud ?? .1, code: c.code ?? 0, r: c.r, out: !!c.out, pool, ac, nodata: false, gap: false };
  }
  function replayFrame(c, D, h) {
    const hh = Math.min(23, Math.floor(h)), row = D?.hours?.[hh], w = wxAt(c.wx, st.date, hh), future = h > dataEnd(D) + 1e-6, gap = !future && !row?.energy;
    const e = row?.energy, r = e && !future ? { solarKw: e.solarKw, homeKw: e.homeKw, batteryKw: e.batteryKw, gridKw: e.gridKw, soc: socAt(D, h) } : null;
    const ac = row?.ac && !future ? { on: row.ac.on, phase: row.ac.phase, set: row.ac.setpointF, indoorF: row.ac.indoorF, kw: row.ac.kw } : null;
    return { sp: sunAt(new Date(dayStartMs(st.date) + h * 36e5)), cloud: w?.cloud ?? c.cloud ?? .1, code: w?.code ?? c.code ?? 0, r, out: false,
      pool: !future ? row?.pool ?? null : null, ac, nodata: !r, gap };
  }
  /** Running totals since midnight up to hour x, kWh (hourly means × hours; the current hour counts up to x). */
  function totalsTo(D, x) {
    const o = { solar: 0, home: 0, imp: 0, exp: 0, pool: 0, ac: 0, hasPool: false, hasAc: false };
    for (const row of D.hours) { const f = clampN(x - row.hour, 0, 1); if (!f) continue; const e = row.energy;
      if (e) { o.solar += e.solarKw * f; o.home += e.homeKw * f; o.imp += e.importKw * f; o.exp += e.exportKw * f; }
      if (row.pool) { o.pool += row.pool.meanKw * f; o.hasPool = true; } if (row.ac) { o.ac += row.ac.meanKw * f; o.hasAc = true; } }
    return o;
  }

  /* ---- scene update for a frame ---- */
  const warmWin = new THREE.Color(0xffc98a), coolWin = new THREE.Color(0xcfe6ff), panelBase = new THREE.Color(0x1a2a66), MUTE = 0x6b6f78;
  let lastSun = null, coolK = 0, poolFlow = 0;
  function applyScene(d, c, dt) {
    const t = c.t, calm = !!c.calm, pace = calm ? .35 : 1, sp = d.sp, up = light(sp, d.cloud, d.code, dt, t);
    scene.fog.near = 45 + 25 * st.k; scene.fog.far = 140 + 60 * st.k; ground.scale.setScalar(1 + st.k);
    if (!lastSun || Math.abs(sp.el - lastSun.el) + Math.abs(sp.az - lastSun.az) >= .5) { renderer.shadowMap.needsUpdate = true; lastSun = { el: sp.el, az: sp.az }; }
    const r = d.r, solar = r?.solarKw ?? 0, peakKw = c.peakKw ?? 9;
    H.panelMat.emissive.copy(panelBase); H.panelMat.emissiveIntensity = (1 - up) * .15 + solar / peakKw * .5;
    const cooling = !!d.ac?.on; coolK += ((cooling ? 1 : 0) - coolK) * Math.min(1, dt * 3);
    H.winMat.emissive.copy(warmWin).lerp(coolWin, coolK); H.winMat.emissiveIntensity = Math.min(1.6, (1 - up) * (.4 + (r?.homeKw ?? 1) / 4));
    H.pwLeds.forEach(l => l.material.color.set(r ? (r.batteryKw < -.05 ? 0x4ef0a6 : r.batteryKw > .05 ? 0xffc15e : 0x9aa3b0) : 0x9aa3b0));
    EX.strip.material.color.set(!r ? MUTE : r.batteryKw < -.05 ? PAL.batt : r.batteryKw > .05 ? PAL.solar : MUTE); EX.strip.scale.y = Math.max(.001, (r?.soc ?? 0) / 100);
    EX.tick.position.y = .45 + (c.reservePct ?? 20) / 100;
    const F = H.flows, set = (k, isOn, dir, color, amt) => { const f = F[k]; f.uOn.value = isOn ? 1 : 0; f.uDir.value = dir; f.uColor.value.set(color); f.uSpeed.value = calm ? .3 : .6 + Math.min(1.6, amt / 3); f.uT.value = t; };
    if (r) {
      set('solar', r.solarKw > .05, 1, 0xffc15e, r.solarKw);
      set('batt', Math.abs(r.batteryKw) > .05, r.batteryKw < 0 ? 1 : -1, r.batteryKw < 0 ? 0xffc15e : 0x4ef0a6, Math.abs(r.batteryKw));
      set('home', r.homeKw > .05, 1, r.solarKw >= r.homeKw ? 0xffc15e : r.batteryKw > .05 && r.batteryKw >= Math.max(0, r.gridKw) ? 0x4ef0a6 : r.gridKw > .05 ? 0xc4a2ff : 0xffc15e, r.homeKw);
      set('grid', !d.out && Math.abs(r.gridKw) > .05, r.gridKw < 0 ? 1 : -1, r.gridKw < 0 ? 0xffc15e : 0xc4a2ff, Math.abs(r.gridKw));
      if (d.out) { F.grid.uOn.value = 1; F.grid.uColor.value.set(0xff5a4e); F.grid.uSpeed.value = 0; }
      set('pool', !!d.pool?.running, 1, PAL.home, (d.pool?.watts ?? 0) / 1000);
      set('ac', cooling, 1, PAL.ac, d.ac?.kw ?? 0);
    } else Object.values(F).forEach(f => { f.uOn.value = 0; });
    // pool water, pump rotor and return stream; condenser fan and exhaust
    const running = !!d.pool?.running, s2 = running ? (d.pool.rpm || 1500) / 3450 : 0;
    poolFlow += ((running ? .4 + s2 : 0) - poolFlow) * Math.min(1, dt * 3);
    EX.water.material.uniforms.uFlow.value = poolFlow; EX.water.material.uniforms.uT.value = t; EX.spaW.material.uniforms.uT.value = t;
    EX.rotor.rotation.z += s2 * 30 * dt * pace; EX.fan.rotation.z += (cooling ? 21 : 0) * dt * pace;
    const s = EX.stream, sa = s.geometry.attributes.position; s.material.opacity += ((running ? .9 : 0) - s.material.opacity) * Math.min(1, dt * 4);
    if (s.material.opacity > .01) { for (let i = 0; i < 90; i++) { const p = EX.streamCurve.getPointAt(((t * (1 + s2 * 3) * .06 + i / 90) % 1 + 1) % 1, v); sa.setXYZ(i, p.x, p.y, p.z); } sa.needsUpdate = true; }
    s.visible = s.material.opacity > .01;
    const e = EX.exhaust, ea = e.geometry.attributes.position, [cx, cz] = EX.cond; e.material.opacity += ((cooling ? .6 : 0) - e.material.opacity) * Math.min(1, dt * 4);
    if (e.material.opacity > .01) { for (let i = 0; i < 120; i++) { const u = (t * .7 + i * .43) % 1; ea.setXYZ(i, cx + Math.cos(i * 2.1) * .3 * (1 + u) - u * .6, .9 + u * 1.8, cz + Math.sin(i * 1.7) * .3 * (1 + u)); } ea.needsUpdate = true; }
    e.visible = e.material.opacity > .01;
  }

  /* ---- DOM: labels, HUD, chips, readout ---- */
  const put = (el, prop, val) => { if (!el || el['_' + prop] === val) return; el['_' + prop] = val; el[prop] = val; };
  const tog = (el, cls, isOn) => { if (el && el.classList.contains(cls) !== isOn) el.classList.toggle(cls, isOn); };
  const sgn = x => Math.abs(x) < .05 ? '0.0' : (x > 0 ? '+' : '−') + Math.abs(x).toFixed(1);
  const nb = s => s.replace(/ /g, '&nbsp;');
  const deg = x => x == null ? '—' : `${Math.round(x)}°`;
  const rpmTxt = x => Math.round(x).toLocaleString('en-US');
  function labelHtml(k, d) {
    if (d.nodata) return `<small>${NAMES[k]}</small><b>—</b>`;
    const r = d.r;
    switch (k) {
      case 'solar': return `<small>SOLAR</small><b>${kw(r.solarKw)}</b>`;
      case 'home': return `<small>HOME</small><b>${kw(r.homeKw)}</b>`;
      case 'pw': return `<small>POWERWALL · 2×</small><b>${kw(r.batteryKw)} ${r.batteryKw < -.05 ? '<i style="color:var(--batt)">▲</i>' : r.batteryKw > .05 ? '<i style="color:var(--solar)">▼</i>' : '<i style="color:var(--mute)">·</i>'}${r.soc != null ? Math.round(r.soc) + '%' : '—'}</b>`;
      case 'grid': return `<small>PEC GRID</small><b>${d.out ? 'Offline' : r.gridKw > .05 ? `↓ ${kw(r.gridKw)}` : r.gridKw < -.05 ? `↑ ${kw(r.gridKw)}` : '0 kW'}</b>`;
      case 'ac': return !d.ac ? '<small>AC</small><b>—</b>' : d.ac.on ? `<small>AC</small><b>${kw(d.ac.kw)}<i class="s">· cooling · ${deg(d.ac.set)}</i></b>`
        : `<small>AC</small><b>0 kW<i class="s">· ${d.ac.phase === 'coast' ? 'coasting' : 'idle'} · ${deg(d.ac.indoorF)}</i></b>`;
      case 'pool': return !d.pool ? '<small>POOL</small><b>—</b>' : d.pool.running ? `<small>POOL</small><b>${Math.round(d.pool.watts)} W<i class="s">· ${rpmTxt(d.pool.rpm)} rpm</i></b>` : '<small>POOL</small><b>Off<i class="s">· pump</i></b>';
    }
    return '';
  }
  function hudHtml(d, h, D, reserve) {
    if (d.nodata) return d.gap ? `<div class="m">${nb(fmt(h))} · no&nbsp;data</div><div class="s">Sun and sky only. Nothing is stored for this hour.</div>`
      : `<div class="m">${nb(fmt(h))} · no&nbsp;data&nbsp;yet</div><div class="s">Sun and sky only. Data stops at ${fmt(dataEnd(D))}.</div>`;
    const r = d.r;
    const m = [fmt(h), `☀ ${r.solarKw.toFixed(1)} kW → home ${r.homeKw.toFixed(1)}`, `PW ${sgn(-r.batteryKw)}`, `PEC ${sgn(-r.gridKw)}`, r.soc != null ? `${Math.round(r.soc)}%` : '—'].map(nb).join(' · ');
    const src = r.solarKw >= r.homeKw - .05 ? 'on sunshine' : r.batteryKw > Math.max(.05, r.gridKw) ? 'on the Powerwalls' : 'on PEC';
    const tag = d.pool?.source === 'schedule' ? ' <em>(schedule)</em>' : '';
    const pool = !d.pool ? 'Pump —' : d.pool.running ? `Pump at ${rpmTxt(d.pool.rpm)} rpm ${src}${tag}` : `Pump off${tag}`;
    const ac = !d.ac ? 'AC —' : d.ac.on ? (d.ac.phase === 'pre-cool' ? `AC pre-cooling to ${deg(d.ac.set)}` : `AC cooling to ${deg(d.ac.set)}`)
      : d.ac.phase === 'coast' ? `AC coasting, ${deg(d.ac.indoorF)} inside` : `AC idle, ${deg(d.ac.indoorF)} inside`;
    const soc = r.soc ?? 50;
    const pw = r.batteryKw < -.05 ? (soc > 99 ? 'Powerwalls full' : 'Powerwalls filling') : r.batteryKw > .05 ? 'Powerwalls running the house' : soc <= reserve + .5 ? 'Powerwalls at reserve, PEC supplying' : soc >= 99 ? 'Powerwalls full' : 'Powerwalls idle';
    const cov = D?.coverage ?? {}, chip = (name, v) => v != null && v < .9 ? `<span class="cov">${name} ${Math.round(v * 100)}%</span>` : '';
    return `<div class="m">${m}</div><div class="s">${pool} · ${ac} · ${pw}${chip('pool', cov.pool)}${chip('nest', cov.nest)}</div>`;
  }
  function updateDom(d, h, D, c) {
    put(noteEl, 'textContent', st.mode === 'live' ? (d.out ? 'islanded · grid offline' : `live · ${new Date(c.r.ts ?? Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`) : `replay · ${fmt(h)}`);
    put(tm, 'textContent', fmt(h)); if (range && !st.dragging) { const rv = String(h); if (range._v !== rv) { range._v = rv; range.value = rv; } }
    const pct = (st.now / 24 * 100).toFixed(1); if (range && range._pct !== pct) { range._pct = pct; range.style.background = `linear-gradient(90deg,rgba(255,255,255,.3) 0 ${pct}%,rgba(255,255,255,.08) ${pct}% 100%)`; }
    tog(liveB, 'on', st.mode === 'live'); put(playB, 'textContent', st.playing ? '❚❚' : '▶'); playB?.setAttribute('aria-label', st.playing ? 'Pause' : 'Play the day');
    tog(host, 'nodata', d.nodata);
    for (const k of KEYS) { const html = labelHtml(k, d); if (meta[k].html !== html) { meta[k].html = html; els[k].innerHTML = html; meta[k].dirty = true; } }
    tog(els.grid, 'off', !d.nodata && d.out);
    const showHud = st.mode === 'replay' && !!hud; if (hud && hud.hidden === showHud) { hud.hidden = !showHud; hudM.dirty = true; }
    if (showHud) { const hh = hudHtml(d, h, D, c.reservePct ?? 20); if (hudM.html !== hh) { hudM.html = hh; hud.innerHTML = hh; hudM.dirty = true; } }
    // chips
    const r = d.r;
    put(chipP, 'textContent', d.nodata || !d.pool ? 'Pool —' : d.pool.running ? `Pool ${Math.round(d.pool.watts)} W` : 'Pool off'); tog(chipP, 'on', !d.nodata && !!d.pool?.running);
    put(chipA, 'textContent', d.nodata || !d.ac ? 'AC —' : d.ac.on ? `AC cooling ${d.ac.kw.toFixed(1)} kW` : d.ac.phase === 'coast' ? 'AC coasting' : 'AC idle'); tog(chipA, 'on', !d.nodata && !!d.ac?.on);
    put(chipB, 'textContent', d.nodata ? 'PW —' : `PW ${r.soc != null ? Math.round(r.soc) + '%' : '—'} ${r.batteryKw < -.05 ? '▲' : r.batteryKw > .05 ? '▼' : '·'}`);
    tog(chipB, 'chg', !d.nodata && r.batteryKw < -.05); tog(chipB, 'dis', !d.nodata && r.batteryKw > .05);
    // readout: running totals since midnight, clamped to the data stored so far
    if (!D) { put(tip, 'innerHTML', 'Since midnight…'); return; }
    const end = dataEnd(D), x = Math.min(h, end), o = totalsTo(D, x);
    put(tip, 'innerHTML', `<b>Midnight → ${fmt(x)}</b> ☀ ${o.solar.toFixed(1)} · home ${o.home.toFixed(1)} · pool ${o.hasPool ? o.pool.toFixed(1) : '—'} · AC ${o.hasAc ? o.ac.toFixed(1) : '—'} · PEC in ${o.imp.toFixed(1)} / out ${o.exp.toFixed(1)} kWh${h > end + 1e-6 ? ` · nothing recorded after ${fmt(end)} yet` : ''}`);
  }
  function measure() {
    for (const k of KEYS) if (meta[k].dirty) { meta[k].w = els[k].offsetWidth; meta[k].h = els[k].offsetHeight; meta[k].dirty = false; }
    if (hudM.dirty) { hudM.rect = !hud || hud.hidden ? null : { x: hud.offsetLeft, y: hud.offsetTop, w: hud.offsetWidth, h: hud.offsetHeight }; hudM.dirty = false; }
  }
  const hits = (b, list) => list.some(o => o && b.x < o.x + o.w + 3 && b.x + b.w + 3 > o.x && b.y < o.y + o.h + 3 && b.y + b.h + 3 > o.y);
  function layout() {
    const Wc = sz.w, Hc = sz.h, placed = [hudM.rect], wires = []; // wires: the energy labels' leaders, which later energy labels keep clear of (F6)
    for (const k of KEYS) {
      const m = meta[k], el = els[k], ld = leads[k];
      v.copy(H.anchors[k]).project(camera);
      // F6 (mockup j-ui-fixes): the four energy labels stay 8 px inside the card and keep a leader to an anchor just past the side edge;
      // the twin's POOL and AC labels keep their 4 px margin and edge pinning
      const energy = k !== 'pool' && k !== 'ac', mx = energy ? 8 : 4;
      const ax = (v.x + 1) / 2 * Wc, ay = (1 - v.y) / 2 * Hc, off = v.z > 1 || ay < 0 || ay > Hc || (!energy && (ax < 0 || ax > Wc)) || (energy && (ax < -Wc / 2 || ax > Wc * 1.5));
      const pL = PREF.live[k], pT = PREF.twin[k], dx = pL[0] + (pT[0] - pL[0]) * st.k, dy = pL[1] + (pT[1] - pL[1]) * st.k;
      let box, edge = '';
      if (off) { // anchor outside the canvas: pin the label to that edge (clamped), no leader
        edge = ax < Wc / 2 ? 'l' : 'r';
        box = { x: edge === 'l' ? 6 : Wc - 6 - m.w, y: clampN(ay - m.h / 2, 6, Hc - m.h - 6), w: m.w, h: m.h };
        for (let i = 0; i < 12 && hits(box, placed); i++) box.y = clampN(box.y + 14, 6, Hc - m.h - 6);
      } else {
        const cands = dy < 0 ? [dy, dy - 22, dy - 44, 24, 46, 68] : [dy, dy + 22, dy + 44, -40, -62, -84];
        for (const cy of cands) { const b = { x: clampN(ax + dx - m.w / 2, mx, Wc - mx - m.w), y: cy < 0 ? ay + cy - m.h : ay + cy, w: m.w, h: m.h };
          if (b.y < 4 || b.y + b.h > Hc - 4 || hits(b, energy ? placed.concat(wires) : placed)) continue; box = b; break; }
        if (!box) box = { x: clampN(ax + dx - m.w / 2, mx, Wc - mx - m.w), y: clampN(dy < 0 ? ay + dy - m.h : ay + dy, 4, Hc - 4 - m.h), w: m.w, h: m.h };
      }
      if (m.edge !== edge) { tog(el, 'edge-l', edge === 'l'); tog(el, 'edge-r', edge === 'r'); m.edge = edge; m.dirty = true; }
      el.style.left = box.x.toFixed(1) + 'px'; el.style.top = box.y.toFixed(1) + 'px';
      if (off) ld.style.display = 'none';
      else { const above = box.y + box.h / 2 < ay, ex = clampN(ax, box.x + 6, box.x + box.w - 6), ey = above ? box.y + box.h + 4 : box.y - 4, ddx = ex - ax, ddy = ey - ay, len = Math.hypot(ddx, ddy);
        if (len < 4) ld.style.display = 'none';
        else { if (energy) wires.push({ x: Math.min(ax, ex), y: Math.min(ay, ey), w: Math.abs(ddx), h: Math.abs(ddy) });
          ld.style.display = ''; ld.style.left = ax.toFixed(1) + 'px'; ld.style.top = ay.toFixed(1) + 'px'; ld.style.height = len.toFixed(1) + 'px'; ld.style.transform = `rotate(${Math.atan2(-ddx, ddy).toFixed(4)}rad)`; } }
      placed.push(box);
      if (el.style.visibility) { el.style.visibility = ''; ld.style.visibility = ''; }
    }
  }

  /**
   * One frame of the twin. `c` is today's render context plus: day (/api/appliances/day for today), wx (Open-Meteo hourly),
   * pool (S.pool), ac (S.ac), reservePct. Returns { replaying } so main.js can keep now.js off the card note while replaying.
   */
  view.render = c => {
    if (!vis) return { replaying: st.mode === 'replay' };
    const dt = c.dt ?? .016; st.calm = !!c.calm;
    if (performance.now() - st.nowAt > 1000) { st.nowAt = performance.now(); st.now = localHour(); st.date = localDate(); }
    if (st.playing) { st.h += dt; if (st.h >= st.now) goLive(); }                                             // ▶ = 1 hour per second, up to now, then live
    if (st.mode === 'replay' && !st.playing && !st.dragging && st.idle > 0 && !st.calm) { st.idle -= dt; if (st.idle <= 0) goLive(); } // 20 s idle → live
    if (st.tw) { const w = st.tw; w.t = Math.min(1, w.t + dt / .6); const e = EASE(w.t);
      camera.position.lerpVectors(w.p0, w.F.pos, e); controls.target.lerpVectors(w.t0, w.F.tgt, e); camera.fov = w.f0 + (w.F.fov - w.f0) * e; camera.updateProjectionMatrix();
      st.k = w.k0 + (w.k1 - w.k0) * e; if (w.t >= 1) st.tw = null; }
    const D = c.day?.date === st.date ? c.day : null, h = st.mode === 'live' ? st.now : clampN(st.h, 0, 24);
    const d = st.mode === 'live' ? liveFrame(c) : replayFrame(c, D, h);
    applyScene(d, c, dt);
    controls.update(); renderer.render(scene, camera); css.render(scene, camera);
    updateDom(d, h, D, c); measure(); layout();
    return { replaying: st.mode === 'replay' };
  };
  return view;
}
