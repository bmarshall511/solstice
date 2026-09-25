import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchOrbit } from '../lib/touchorbit.js';

/*
 * Thermal twin (Insights → Appliances → AC): a holographic cutaway of the house. Interior colour is indoor temperature,
 * the roof glows with the sun's heat, cool air streams from the air handler while Nest reports cooling, the condenser breathes outside.
 */
const C = { cyan: 0x6cc4ff, warm: 0xff9e66, white: 0xffffff };
const lerp = (a, b, k) => a + (b - a) * k;
export function createThermalTwin(el) {
  const W = el.clientWidth || 353, H = el.clientHeight || 340;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(W, H); el.prepend(renderer.domElement);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, W / H, .1, 100); cam.position.set(7.5, 5.2, 8);
  const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableZoom = false; ctl.enablePan = false; ctl.minPolarAngle = .6; ctl.maxPolarAngle = 1.3; ctl.target.set(0, 1.2, 0); ctl.enableDamping = true; ctl.autoRotate = true; ctl.autoRotateSpeed = .4; touchOrbit(ctl);
  scene.add(new THREE.AmbientLight(0xffffff, .7));
  const grid = new THREE.GridHelper(20, 40, C.cyan, C.cyan); grid.material.transparent = true; grid.material.opacity = .06; scene.add(grid);
  const fade = new THREE.Mesh(new THREE.CircleGeometry(10, 64), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`, fragmentShader: `varying vec2 vUv;void main(){float r=length(vUv-.5)*2.;gl_FragColor=vec4(.02,.024,.04,smoothstep(.45,1.,r));}` })); fade.rotation.x = -Math.PI / 2; fade.position.y = .01; scene.add(fade);
  const edges = (geo, c, op = .9) => new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: op }));
  const S = .28, Wd = 14 * S, Ln = 24 * S, WALL = 3.2 * S, TILT = 27 * Math.PI / 180;
  const interior = new THREE.Mesh(new THREE.BoxGeometry(Wd - .1, WALL - .05, Ln - .1), new THREE.MeshPhysicalMaterial({ color: C.cyan, transparent: true, opacity: .32, roughness: .2, emissive: C.cyan, emissiveIntensity: .35, depthWrite: false })); interior.position.y = WALL / 2; scene.add(interior);
  const we = edges(new THREE.BoxGeometry(Wd, WALL, Ln), 0x9fb8d8, .8); we.position.y = WALL / 2; scene.add(we);
  const w = Wd / 2 + .15, l = Ln / 2 + .15, Hh = w * Math.tan(TILT), r = Math.max(0, l - w);
  const A = [-w, 0, -l], B = [w, 0, -l], Cc = [w, 0, l], D = [-w, 0, l], R1 = [0, Hh, -r], R2 = [0, Hh, r];
  const roofGeo = new THREE.BufferGeometry(); roofGeo.setAttribute('position', new THREE.Float32BufferAttribute([A, D, R2, A, R2, R1, B, R1, R2, B, R2, Cc, A, R1, B, D, Cc, R2].flat(), 3)); roofGeo.computeVertexNormals();
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshPhysicalMaterial({ color: C.warm, transparent: true, opacity: .10, side: THREE.DoubleSide, emissive: C.warm, emissiveIntensity: .15, depthWrite: false })); roof.position.y = WALL; scene.add(roof);
  const re = edges(roofGeo, 0xd9c3b0, .85); re.position.y = WALL; scene.add(re);
  const block = (geo, c, x, y, z, op = .14) => { const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: c, transparent: true, opacity: op, emissive: c, emissiveIntensity: .1, depthWrite: false })); m.position.set(x, y, z); scene.add(m); const e = edges(geo, c, .9); e.position.set(x, y, z); scene.add(e); return { m, e }; };
  const handler = block(new THREE.BoxGeometry(.5, .9, .5), C.cyan, -.8, WALL + .45, 1.2), cond = block(new THREE.BoxGeometry(.9, .8, .9), C.cyan, -Wd / 2 - .75, .4, 2.4);
  const fan = new THREE.Mesh(new THREE.TorusGeometry(.3, .02, 8, 32), new THREE.MeshBasicMaterial({ color: C.cyan })); fan.rotation.x = Math.PI / 2; fan.position.set(-Wd / 2 - .75, .82, 2.4); scene.add(fan);
  const fan2 = new THREE.Mesh(new THREE.BoxGeometry(.5, .02, .03), new THREE.MeshBasicMaterial({ color: C.white })); fan2.position.copy(fan.position); scene.add(fan2);
  scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-Wd / 2 - .4, .6, 2.4), new THREE.Vector3(-Wd / 2, 1.2, 2.0), new THREE.Vector3(-.8, WALL + .2, 1.4)]), 32, .02, 6, false), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: .35 })));
  const cloud = (n, col, size, op = .8) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0), 3)); const p = new THREE.Points(g, new THREE.PointsMaterial({ color: col, size, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); p.userData = { n, op }; scene.add(p); return p; };
  const sunHeat = cloud(400, C.warm, .06, .75), cool = cloud(320, 0xbfe6ff, .055, .95), exhaust = cloud(120, C.warm, .07, .6);
  const tempCol = v => new THREE.Color().setHSL(lerp(.58, .05, Math.max(0, Math.min(1, (v - 70) / 12))), .85, .6);
  let ST = { indoorF: 75, sun: 0, cooling: false, heating: false }, t = 0;
  renderer.domElement.addEventListener('pointerdown', () => ctl.autoRotate = false);
  return {
    set(s) { ST = { ...ST, ...s }; },
    render(dt, calm) { t += dt; const on = ST.cooling, s = ST.sun ?? 0, col = tempCol(ST.indoorF ?? 75);
      if (calm) ctl.autoRotate = false;
      interior.material.color.copy(col); interior.material.emissive.copy(col); interior.material.emissiveIntensity = lerp(interior.material.emissiveIntensity, ST.heating ? .6 : .45, .1);
      roof.material.emissiveIntensity = lerp(roof.material.emissiveIntensity, .15 + s * .9, .08); roof.material.opacity = .1 + s * .2;
      fan.rotation.z += on ? .35 : 0; fan2.rotation.y += on ? .35 : 0; handler.e.material.color.setHex(on || ST.heating ? C.cyan : 0x555566); cond.e.material.color.setHex(on ? C.cyan : 0x555566);
      { const a = sunHeat.geometry.attributes.position; sunHeat.material.opacity = lerp(sunHeat.material.opacity, s > .05 ? sunHeat.userData.op * s : 0, .08); for (let i = 0; i < sunHeat.userData.n; i++) { const u = ((t * .5) + i * .37) % 1; a.setXYZ(i, (Math.sin(i * 7.3) * .5) * Wd * 1.1 + (1 - u) * 1.6, WALL + Hh + 2.2 - u * 2.2, (Math.cos(i * 3.1) * .5) * Ln * 1.1 - (1 - u) * 1.0); } a.needsUpdate = true; }
      { const a = cool.geometry.attributes.position; cool.material.opacity = lerp(cool.material.opacity, on ? cool.userData.op : 0, .08); cool.material.color.setHex(ST.heating ? C.warm : 0xbfe6ff); for (let i = 0; i < cool.userData.n; i++) { const u = ((t * .6) + i * .61) % 1, ang = i * 2.4, rr = u * Math.max(Wd, Ln) * .48; a.setXYZ(i, -.8 + Math.cos(ang) * rr * .62, WALL - .1 - u * (WALL - .35) + Math.sin(u * Math.PI * 3 + i) * .05, 1.2 + Math.sin(ang) * rr); } a.needsUpdate = true; }
      { const a = exhaust.geometry.attributes.position; exhaust.material.opacity = lerp(exhaust.material.opacity, on ? exhaust.userData.op : 0, .08); for (let i = 0; i < exhaust.userData.n; i++) { const u = ((t * .7) + i * .43) % 1; a.setXYZ(i, -Wd / 2 - .75 + Math.cos(i * 2.1) * .3 * (1 + u), .9 + u * 1.8, 2.4 + Math.sin(i * 1.7) * .3 * (1 + u)); } a.needsUpdate = true; }
      ctl.update(); renderer.render(scene, cam); },
    resize() { const w2 = el.clientWidth, h2 = el.clientHeight; if (!w2 || !h2) return; renderer.setSize(w2, h2); cam.aspect = w2 / h2; cam.updateProjectionMatrix(); },
  };
}
