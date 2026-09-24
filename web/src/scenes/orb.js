import * as THREE from 'three';

/** Liquid-filled glass orb: fill = battery %, waves when charging/discharging, gold motes = solar in, red shield = outage. */
export function createOrb(canvas) {
  const R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  R.setPixelRatio(Math.min(devicePixelRatio, 2));
  const S = new THREE.Scene(), C = new THREE.PerspectiveCamera(32, 1, .1, 50); C.position.set(0, -.6, 7.4);
  const U = { uT: { value: 0 }, uLevel: { value: .5 }, uCharge: { value: 0 }, uDis: { value: 0 }, uOut: { value: 0 } };
  const orb = new THREE.Mesh(new THREE.SphereGeometry(1.25, 128, 96), new THREE.ShaderMaterial({ uniforms: U, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;void main(){vP=position;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;uniform float uT,uLevel,uCharge,uDis,uOut;
    void main(){
      float fres=pow(1.-max(dot(vN,vV),0.),2.4);
      float lvl=(uLevel*2.-1.)*1.25;
      float wave=.05*sin(vP.x*4.+uT*2.2)+.035*sin(vP.z*5.-uT*1.7)+.02*sin((vP.x+vP.z)*9.+uT*3.);
      float surf=lvl+wave*(.6+uCharge+uDis);
      float inside=smoothstep(surf+.015,surf-.015,vP.y);
      vec3 deep=vec3(.02,.35,.28), top=vec3(.3,1.,.72), glow=vec3(.55,1.,.85), amber=vec3(1.,.72,.3);
      top=mix(top,amber,uDis*.55); glow=mix(glow,amber,uDis*.6);
      float g=clamp((vP.y+1.25)/max(.01,surf+1.25),0.,1.);
      vec3 liquid=mix(deep,top,g*g)+glow*smoothstep(.06,0.,abs(vP.y-surf))*.9+vec3(1.,.8,.4)*uCharge*.25*pow(g,6.);
      vec3 glass=mix(vec3(.75,.85,1.),vec3(1.,.4,.3),uOut*(.6+.4*sin(uT*3.)))*fres*.95;
      gl_FragColor=vec4(mix(glass,liquid+glass*.4,inside),mix(.08+fres*.75,.93,inside));
    }` }));
  S.add(orb);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.62, .007, 8, 200), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .18 }));
  ring.rotation.x = Math.PI / 2.25; S.add(ring);
  const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1.75, 3), new THREE.MeshBasicMaterial({ color: 0xff5a4e, transparent: true, opacity: 0, wireframe: true, depthWrite: false }));
  S.add(shield);
  const PN = 280, pos = new Float32Array(PN * 3), seed = Array.from({ length: PN }, () => [Math.random(), Math.random() * Math.PI * 2]);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, '#fff'); g.addColorStop(.4, 'rgba(255,210,130,.8)'); g.addColorStop(1, 'rgba(255,190,90,0)'); x.fillStyle = g; x.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
  const pMat = new THREE.PointsMaterial({ size: .07, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  S.add(new THREE.Points(geo, pMat));
  const resize = () => { const r = canvas.getBoundingClientRect(); if (!r.width) return; R.setSize(r.width, r.height, false); C.aspect = r.width / r.height; C.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(canvas);
  return {
    render({ soc = 50, batteryKw = 0, solarKw = 0, peakKw = 10, maxKw = 10, out = false, dt, t }) {
      const charging = Math.max(0, -batteryKw) / maxKw, dis = Math.max(0, batteryKw) / maxKw;
      U.uT.value = t; U.uLevel.value += (soc / 100 - U.uLevel.value) * .06; U.uCharge.value = charging; U.uDis.value += (dis - U.uDis.value) * .05;
      U.uOut.value += ((out ? 1 : 0) - U.uOut.value) * .05;
      shield.material.opacity = U.uOut.value * (.08 + .05 * Math.sin(t * 3)); shield.rotation.y = t * .2;
      ring.material.color.set(out ? 0xff8a7e : 0xffffff); ring.material.opacity = .18 + U.uOut.value * .25;
      orb.rotation.y = t * .15; ring.rotation.z = t * .1;
      const n = Math.round(PN * Math.min(1, solarKw / peakKw * 1.2)); geo.setDrawRange(0, n);
      for (let i = 0; i < n; i++) { const s = seed[i]; s[0] = (s[0] + dt * (.12 + charging * .35)) % 1; const k = s[0], r = 2.4 - k * 1.1, a = s[1] + k * 5 + t * .2;
        pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = 1.9 - k * 1.7 + Math.sin(a * 2) * .1; pos[i * 3 + 2] = Math.sin(a) * r * .6; }
      geo.attributes.position.needsUpdate = true; pMat.opacity = .4 + charging;
      R.render(S, C);
    },
  };
}
