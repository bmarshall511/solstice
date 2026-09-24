import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sunAt, RAD, hourLabel } from '../lib/util.js';

/**
 * The house, its 30 panels and 2 Powerwalls under a live sky: real sun position and path for today,
 * shadows, and clouds/rain from the hourly forecast. Panels glow with the array's current output.
 */
export function createRoof(host) {
  let ready = false, renderer, labels, scene, camera, controls, meshes = [], skyU, sunL, hemi, sunBall, clouds = [], rain, panelNormal = new THREE.Vector3(), pathDay = null, pathObjs = [];
  const sunVec = ({ el, az }, v = new THREE.Vector3()) => v.set(Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), -Math.cos(az * RAD) * Math.cos(el * RAD));

  function hip(W, L, wall, tilt) {
    const g = new THREE.Group(), cl = c => new THREE.MeshStandardMaterial({ color: c, roughness: .85 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, wall, L), cl(0xd9d5cc)); body.position.y = wall / 2; body.castShadow = body.receiveShadow = true; g.add(body);
    const w = W / 2 + .5, l = L / 2 + .5, H = w * Math.tan(tilt), r = l - w;
    const A = [-w, 0, -l], B = [w, 0, -l], C = [w, 0, l], D = [-w, 0, l], R1 = [0, H, -r], R2 = [0, H, r];
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([A, D, R2, A, R2, R1, B, R1, R2, B, R2, C, A, R1, B, D, C, R2].flat(), 3)); geo.computeVertexNormals();
    const roof = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6d747e, roughness: .9, side: THREE.DoubleSide, flatShading: true })); roof.position.y = wall; roof.castShadow = roof.receiveShadow = true; g.add(roof);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .2 })); e.position.y = wall; g.add(e);
    return { g, w, wall };
  }
  function puff() { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    for (let i = 0; i < 9; i++) { const px = 30 + Math.random() * 68, py = 46 + Math.random() * 36, r = 20 + Math.random() * 22, g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }
    return new THREE.CanvasTexture(c); }

  function init() {
    ready = true;
    renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; host.appendChild(renderer.domElement);
    labels = new CSS2DRenderer(); Object.assign(labels.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.appendChild(labels.domElement);
    scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x9fb4cf, 60, 160);
    camera = new THREE.PerspectiveCamera(40, 1, .1, 400); camera.position.set(-30, 17, 22);
    controls = new OrbitControls(camera, renderer.domElement); Object.assign(controls, { enableDamping: true, enableZoom: false, enablePan: false, maxPolarAngle: Math.PI * .49, autoRotate: true, autoRotateSpeed: .25 });
    controls.target.set(-1, 3.5, 1);
    skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, glow: { value: new THREE.Color() } };
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
      vertexShader: `varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec3 vD;uniform vec3 top,hor,sunDir,glow;void main(){float y=max(vD.y,0.);vec3 c=mix(hor,top,pow(y,.55));float s=max(dot(vD,normalize(sunDir)),0.);c+=glow*(pow(s,500.)*3.+pow(s,10.)*.35);gl_FragColor=vec4(c,1.);}` })));
    hemi = new THREE.HemisphereLight(0xcfe0ff, 0x2a2f3a, .7); scene.add(hemi);
    sunL = new THREE.DirectionalLight(0xfff2dc, 3); sunL.castShadow = true; sunL.shadow.mapSize.set(2048, 2048); sunL.shadow.bias = -.0004; sunL.shadow.normalBias = .04;
    Object.assign(sunL.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 150 }); scene.add(sunL, sunL.target);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(24, 72), new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 1 })); disc.rotation.x = -Math.PI / 2; disc.receiveShadow = true; scene.add(disc);

    // house rotated to its real bearing so the array faces 244° (WSW)
    const TILT = 27 * RAD, house = hip(14, 24, 3.2, TILT); house.g.rotation.y = Math.atan2(Math.sin(154 * RAD), -Math.cos(154 * RAD)); scene.add(house.g);
    const arr = new THREE.Group(); arr.position.set(-house.w, house.wall, 0); arr.rotation.z = TILT; house.g.add(arr);
    const geo = new THREE.BoxGeometry(1.66, .06, 1.08), edge = new THREE.EdgesGeometry(geo);
    for (let i = 0; i < 30; i++) {
      const row = Math.floor(i / 10), col = i % 10;
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x07101f, metalness: .6, roughness: .22, emissive: 0x2d5bff, emissiveIntensity: .3 }));
      m.position.set(.8 + (row + .5) * 1.72, .1, (col - 4.5) * 1.13 + .6); m.castShadow = m.receiveShadow = true;
      m.add(new THREE.LineSegments(edge, new THREE.LineBasicMaterial({ color: 0xc9d6ff, transparent: true, opacity: .35 })));
      arr.add(m); meshes.push(m);
    }
    // two Powerwall 2s on the east wall by the garage
    [5.4, 6.4].forEach(z => { const u = new THREE.Mesh(new THREE.BoxGeometry(.16, 1.15, .75), new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: .3 }));
      u.position.set(7.08, .9, z); u.castShadow = true; house.g.add(u); });
    scene.updateMatrixWorld(true);
    panelNormal.set(0, 1, 0).applyQuaternion(arr.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const n = document.createElement('div'); n.className = 'lax'; n.style.cssText = 'color:#fff;font-weight:700;text-shadow:0 1px 4px #000'; n.textContent = 'N';
    const nO = new CSS2DObject(n); nO.position.set(0, .1, -26); scene.add(nO);

    sunBall = new THREE.Mesh(new THREE.SphereGeometry(3.2, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffd48a, fog: false })); scene.add(sunBall);
    const tex = puff();
    clouds = Array.from({ length: 22 }, () => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, fog: false }));
      const k = 14 + Math.random() * 18; sp.scale.set(k, k * .5, 1); sp.position.set((Math.random() - .5) * 120, 26 + Math.random() * 12, (Math.random() - .5) * 120); scene.add(sp); return sp; });
    const RN = 900, rp = new Float32Array(RN * 6);
    for (let i = 0; i < RN; i++) { const x = (Math.random() - .5) * 60, y = Math.random() * 30, z = (Math.random() - .5) * 60; rp.set([x, y, z, x - .1, y - .9, z], i * 6); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaecbff, transparent: true, opacity: 0 })); scene.add(rain);
    new ResizeObserver(resize).observe(host); resize();
  }
  function drawPath(dayStart) {
    pathObjs.forEach(o => { scene.remove(o); o.element?.remove(); }); pathObjs = [];
    const pts = [], v = new THREE.Vector3();
    for (let h = 4; h <= 22; h += 1 / 6) { const sp = sunAt(new Date(dayStart + h * 36e5)); if (sp.el > -1) pts.push(sunVec(sp, v).clone().multiplyScalar(110)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffe0a0, dashSize: 2.5, gapSize: 2, transparent: true, opacity: .75, fog: false }));
    line.computeLineDistances(); scene.add(line); pathObjs.push(line);
    [8, 10, 12, 14, 16, 18].forEach(h => { const sp = sunAt(new Date(dayStart + h * 36e5)); if (sp.el < 1) return;
      const el = document.createElement('div'); el.className = 'lax'; el.style.color = '#ffe0a0'; el.textContent = hourLabel(h);
      const o = new CSS2DObject(el); o.position.copy(sunVec(sp, v).multiplyScalar(110)); scene.add(o); pathObjs.push(o); });
  }
  function resize() { const r = host.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); labels.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }

  const C = { nightTop: new THREE.Color(0x03050b), nightHor: new THREE.Color(0x0d1426), duskTop: new THREE.Color(0x24325a), duskHor: new THREE.Color(0xf2a36e),
    dayTop: new THREE.Color(0x3f7fd0), dayHor: new THREE.Color(0xcfe2f3), grayTop: new THREE.Color(0x6f7884), grayHor: new THREE.Color(0xaab2bd) };
  const ramp = [0x0e1a3a, 0x2d5bff, 0xffc15e, 0xfff3d0].map(c => new THREE.Color(c));
  const rampAt = t => { t = Math.max(0, Math.min(.999, t)) * 3; const i = Math.floor(t); return ramp[i].clone().lerp(ramp[i + 1], t - i); };
  const sd = new THREE.Vector3();

  return {
    /** now: Date; dayStart: epoch ms of local midnight; cc: cloud 0–1; code: WMO; solarKw; peakKw */
    render({ now, dayStart, cc = .1, code = 0, solarKw = 0, peakKw = 9, dt, t, calm }) {
      if (!ready) init();
      if (pathDay !== dayStart) { pathDay = dayStart; drawPath(dayStart); }
      const sp = sunAt(now); sunVec(sp, sd);
      const up = Math.max(0, Math.min(1, (sp.el + 4) / 14)), high = Math.max(0, Math.min(1, sp.el / 35));
      const top = C.nightTop.clone().lerp(C.duskTop, up).lerp(C.dayTop, high).lerp(C.grayTop, cc * .65 * up);
      const hor = C.nightHor.clone().lerp(C.duskHor, up).lerp(C.dayHor, high).lerp(C.grayHor, cc * .65 * up);
      skyU.top.value.copy(top); skyU.hor.value.copy(hor); skyU.sunDir.value.copy(sd); skyU.glow.value.set(0xffd9a0).multiplyScalar(up * (1 - cc * .8)); scene.fog.color.copy(hor);
      sunBall.position.copy(sd).multiplyScalar(110); sunBall.visible = sp.el > -3; sunBall.material.color.set(cc > .7 ? 0xd8d2c4 : 0xffd48a);
      sunL.position.copy(sd).multiplyScalar(60); sunL.intensity = 3 * Math.max(0, Math.min(1, sp.el / 8)) * (1 - cc * .8);
      sunL.color.set(0xffc58a).lerp(new THREE.Color(0xfff4e2), high); hemi.intensity = .15 + .75 * up; hemi.color.copy(hor);
      const nC = Math.round(clouds.length * cc), gray = new THREE.Color(0x8a93a0).lerp(new THREE.Color(0xffffff), up * (1 - cc * .4));
      clouds.forEach((c, i) => { c.position.x += dt * 1.8; if (c.position.x > 60) c.position.x = -60; c.material.opacity += ((i < nC ? .85 : 0) - c.material.opacity) * dt * 2; c.material.color.copy(gray); });
      const raining = code >= 51; rain.material.opacity += ((raining ? .5 : 0) - rain.material.opacity) * dt * 2; if (raining) rain.position.y = -((t * 22) % 30);
      const col = rampAt(solarKw / peakKw), glow = .15 + solarKw / peakKw * .9;
      meshes.forEach(m => { m.material.emissive.copy(col); m.material.emissiveIntensity = glow; });
      controls.autoRotate = !calm && controls.autoRotate;
      controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
      return { el: sp.el, az: sp.az, inc: Math.acos(Math.max(-1, Math.min(1, panelNormal.dot(sd)))) / RAD };
    },
  };
}
