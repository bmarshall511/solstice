import * as THREE from 'three';

/** Full-screen aurora whose colours follow the energy mix; turns to embers during an outage. */
export function createAurora(canvas) {
  const r = new THREE.WebGLRenderer({ canvas });
  r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const U = { uT: { value: 0 }, uRes: { value: new THREE.Vector2() }, uMix: { value: new THREE.Vector3(1, 0, 0) }, uOut: { value: 0 } };
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: U,
    vertexShader: `varying vec2 v;void main(){v=uv;gl_Position=vec4(position,1.);}`,
    fragmentShader: `precision highp float; varying vec2 v; uniform float uT,uOut; uniform vec2 uRes; uniform vec3 uMix;
    float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
    float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n(p);p*=2.02;a*=.5;}return s;}
    void main(){
      vec2 p=v; p.x*=uRes.x/uRes.y;
      vec3 solar=vec3(1.,.66,.25), batt=vec3(.2,.95,.62), grid=vec3(.62,.45,1.), deep=vec3(.018,.02,.04), ember=vec3(1.,.28,.18);
      vec3 m=uMix/(uMix.x+uMix.y+uMix.z+.001);
      vec3 c1=mix(solar*m.x+batt*m.y+grid*m.z, ember, uOut*.55);
      vec3 c2=mix(c1,vec3(.25,.5,1.),.5-uOut*.35);
      float t=uT*.05, band=0.;
      for(int k=0;k<3;k++){float fk=float(k);
        float y=.63+.12*sin(p.x*1.3+t*2.+fk*1.7)+.18*(fbm(vec2(p.x*1.5+t+fk,t*.7))-.5);
        float d=abs(p.y-y); band+=exp(-d*d*110.)*(.5+.5*fbm(vec2(p.x*6.+fk*3.,p.y*2.-t*3.)));}
      float curtain=fbm(vec2(p.x*9.,p.y*.8-t*2.))*smoothstep(.2,.85,p.y);
      vec3 c=deep+c1*band*.55+c2*curtain*band*.5;
      c+=ember*uOut*(.10+.08*(.5+.5*sin(uT*2.2)))*smoothstep(.55,0.,v.y);
      c*=1.-.35*length(v-.5);
      gl_FragColor=vec4(c,1.);
    }` })));
  const resize = () => { r.setSize(innerWidth, innerHeight, false); U.uRes.value.set(innerWidth, innerHeight); };
  resize(); addEventListener('resize', resize);
  const target = new THREE.Vector3(1, 0, 0);
  return {
    set({ solarKw = 0, homeKw = 0, batteryKw = 0, gridKw = 0 }) { const s = Math.min(solarKw, homeKw); target.set(s + .05, Math.max(0, batteryKw) * 1.2, Math.max(0, gridKw) * 1.2); },
    render(t, out) { U.uMix.value.lerp(target, .03); U.uOut.value += ((out ? 1 : 0) - U.uOut.value) * .05; U.uT.value = t; r.render(scene, cam); },
  };
}
