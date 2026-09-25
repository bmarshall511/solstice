import * as THREE from 'three';
import { money, money2 } from '../lib/util.js';

/*
 * History → "Where every kWh went" (mockups/m-flows.html, approved; docs/audit-designs/visualizations.md §5): a 2.5-D Sankey of
 * /api/flows for a day or the last 30 days. Sources on the left (solar, PEC, the Powerwalls discharging), sinks on the right (the home,
 * split into pool, AC and the rest; the Powerwalls charging; export to PEC). Ribbon width is kWh and colour runs from source to sink.
 * Tap a ribbon or a slab to highlight it and read it out; tap Home again to step through AC, pool and the rest.
 * Fixed camera with a ±12° pointer parallax (no OrbitControls), so the canvas keeps `touch-action: pan-y` and the page scrolls.
 * Scene host rules: renders only while ≥ 10% visible on the open tab, DPR ≤ 1.5, and disposes itself when the History tab closes.
 */

const SRC = [{ name: 'Solar', key: 'solar', noun: 'solar', short: 'solar', verb: 'made' },
             { name: 'PEC grid', key: 'grid', noun: 'what you bought', short: 'PEC', verb: 'bought' },
             { name: 'Powerwalls', key: 'batt', noun: 'Powerwall output', short: 'Powerwalls', verb: 'out' }];
const SNK = [{ name: 'Home', key: 'home', short: 'home', verb: 'used' },
             { name: 'Powerwalls', key: 'batt', short: 'Powerwalls', verb: 'in' },
             { name: 'PEC export', key: 'grid', short: 'PEC', verb: 'sent' }];
const NODE = { solar: 0, grid: 1, battery: 2 }, SINK = { home: 0, battery: 1, grid: 2 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sum = (a, b) => a + b;
/** kWh as the mockup prints them: one decimal under 100, whole numbers with separators above. */
export const f1 = v => { const m = v < 0 ? '−' : ''; v = Math.abs(v); if (v >= 100) return m + Math.round(v).toLocaleString('en-US'); const r = Math.round(v * 10) / 10; return m + (Number.isInteger(r) ? String(r) : r.toFixed(1)); };
const pc = v => `${Math.round(v * 100)}%`;
/** Dollars at the learned rate, or "—" when the rate is unknown (the app's existing treatment). */
const usd = v => v == null ? '—' : v < 10 ? money2(v) : money(v);
const glass = (c, op) => new THREE.MeshPhysicalMaterial({ color: c, transparent: true, opacity: op, roughness: .15, metalness: 0, emissive: c, emissiveIntensity: .08, side: THREE.DoubleSide, depthWrite: false });

/** The card's markup (mockup m-flows), placed after the History totals by views/history.js. */
export function createFlowsCard() {
  const card = document.createElement('div');
  card.className = 'card flows';
  card.innerHTML = `<div class="h fh"><b>Where every kWh went · <span class="fti">Today</span></b><span class="ro"></span></div>
    <div class="ring3d flow3d"></div>
    <div class="legend"><span><i style="background:var(--solar)"></i>Solar</span><span><i style="background:var(--grid)"></i>PEC</span><span><i style="background:var(--batt)"></i>Powerwalls</span><span><i style="background:var(--home)"></i>Home · pool</span><span><i style="background:var(--ac)"></i>AC</span><span><i style="background:var(--rest)"></i>rest</span><span style="color:var(--mute)">ribbons in kWh · ≈ estimated</span></div>
    <div class="landtip"></div>
    <div class="kv"></div>
    <p class="fine"></p>`;
  return card;
}

/** Where each home slice's number comes from: a short tag for its label and a sentence for the readout. */
function provenance(f, today) {
  const P = f.home.pool, A = f.home.ac, one = f.range === 'day', when = one ? (f.to === today ? 'today' : 'that day') : 'in this range';
  const r2 = v => String(Math.round(v * 100) / 100);
  const pool = P.source === 'readings' ? { src: 'measured', how: `measured: ScreenLogic readings cover ${pc(P.coverage)} of the pump's scheduled time${one ? '' : ` over ${f.days} days`}` }
    : P.source === 'schedule' ? { src: 'from the schedule', how: one || P.rpm == null ? `from the applied schedule (ScreenLogic readings too sparse ${when})`
      : `from the schedule: ${P.watts} W @ ${P.rpm.toLocaleString('en-US')} RPM, ${f1(P.kwhPerDay)} kWh a day${P.coverage > 0 ? ` (readings cover ${pc(P.coverage)} of pump time)` : ''}` }
    : { src: 'no data', how: `no pool schedule or readings stored ${when}` };
  const ac = A.source === 'readings' ? { src: 'measured', how: `measured: Nest cooling minutes × ${A.acKw.toFixed(1)} kW ${A.acKwSource === 'learned' ? 'learned' : 'estimated'}` }
    : A.source === 'heat-model' ? { src: 'heat model', how: `heat model: ${r2(A.slope)} kWh per °F above 80°${one ? ` (Nest readings too sparse ${when})` : ` (Nest readings cover ${A.readingDays} of ${A.days} days)`}` }
    : { src: 'no data', how: `no Nest readings or daily high stored ${when}` };
  return { pool, ac };
}

/**
 * Fill the card for one /api/flows answer and build its scene. `opts`: { title, today, calm: () => boolean, sel }.
 * Returns { dispose(), alive(), sel() }.
 */
export function mountFlows(card, f, opts) {
  const el = card.querySelector('.flow3d'), tip = card.querySelector('.landtip');
  card.querySelector('.fti').textContent = opts.title;
  const T = f.totals, K = Object.fromEntries(f.ribbons.map(r => [r.id, r])), prov = provenance(f, opts.today);
  const pool = f.home.pool.kwh, ac = f.home.ac.kwh, rest = f.home.rest;

  // ---------- card text: header readout, totals, fine print ----------
  const sunshine = T.home > 0 ? (K.solarHome.kwh + K.battHome.kwh) / T.home : null;
  card.querySelector('.ro').innerHTML = `<b>${f1(Math.round(T.home))} kWh</b> used · <b>${sunshine == null ? '—' : pc(sunshine)}</b> sunshine`;
  const kv = [['Solar made', `${f1(T.solar)} kWh`], ['Home used · Tesla total', `${f1(T.home)} kWh${f.days > 1 && f.dataDays ? ` · ${f1(T.home / f.dataDays)}/day` : ''}`],
    ['Bought from PEC', `${f1(T.import)} kWh`], ['Sent to PEC', `${f1(T.export)} kWh`], ['Powerwalls in / out', `${f1(T.charge)} / ${f1(T.discharge)} kWh`],
    ['Pool · AC · rest', `${f1(pool)} · ${f1(ac)} · ${f1(rest)} kWh`], ['Unaccounted', `${f1(f.unaccounted)} kWh`]];
  card.querySelector('.kv').innerHTML = kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  const R = f.residual, big = v => Math.abs(v) >= .05, dir = v => v > 0 ? 'more' : 'less';
  const res = big(R.home) && big(R.export) ? `Tesla's home total is ${f1(Math.abs(R.home))} kWh ${dir(R.home)} than the split can place, and its export total ${f1(Math.abs(R.export))} kWh ${dir(R.export)} than the ribbons into PEC; that is shown as "unaccounted", not hidden.`
    : big(R.home) ? `Tesla's home total is ${f1(Math.abs(R.home))} kWh ${dir(R.home)} than the split can place; that is shown as "unaccounted", not hidden.`
    : big(R.export) ? `Tesla's export total is ${f1(Math.abs(R.export))} kWh ${dir(R.export)} than the ribbons into PEC; that is shown as "unaccounted", not hidden.`
    : `Every kWh of Tesla's home and export totals is on a ribbon, so nothing is unaccounted.`;
  const how = f.method === 'measured' ? 'Every ribbon is Tesla\'s own per-path measurement.'
    : f.method === 'estimated' ? `Ribbons (≈, dotted) are estimated from the stored totals while Tesla's per-path split is missing for ${(f.buckets - f.splitBuckets).toLocaleString('en-US')} of the ${f.buckets.toLocaleString('en-US')} five-minute buckets; Powerwall → PEC and PEC → Powerwall are the least certain.`
    : 'Nothing is stored for this range yet.';
  card.querySelector('.fine').textContent = `${how} ${res} Sunshine counts solar used directly plus Powerwall output.`;

  // ---------- nothing to draw ----------
  const E = f.ribbons.map(r => ({ id: r.id, s: NODE[r.from], d: SINK[r.to], v: r.kwh, est: r.estimated })).filter(e => e.v > 0);
  if (!E.length) {
    el.hidden = true; tip.textContent = f.method === 'none' ? 'No energy is stored for this range yet.' : 'No energy moved in this range.';
    return { dispose() {}, alive: () => false, sel: () => null };
  }
  el.hidden = false;

  // ---------- renderer, camera ----------
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const COL = { solar: css('--solar') || '#ffc15e', grid: css('--grid') || '#c4a2ff', batt: css('--batt') || '#4ef0a6', home: css('--home') || '#6cc4ff', ac: css('--ac') || '#ff9e66', rest: css('--rest') || '#8d93a8' };
  let W = el.clientWidth || 351, H = el.clientHeight || 300;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(1.5, devicePixelRatio)); renderer.setSize(W, H); el.prepend(renderer.domElement);
  const labs = document.createElement('div'); labs.className = 'labs'; el.appendChild(labs);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(34, W / H, .1, 100); cam.position.set(0, .5, 13); cam.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, .6));

  // ---------- layout: largest column = 5 units, slabs at least .4, ribbons at least .08 ----------
  const srcTot = SRC.map((_, i) => E.filter(e => e.s === i).map(e => e.v).reduce(sum, 0));
  const snkTot = SNK.map((_, i) => E.filter(e => e.d === i).map(e => e.v).reduce(sum, 0));
  const KS = 5 / Math.max(srcTot.reduce(sum), snkTot.reduce(sum));
  E.forEach(e => e.w = Math.max(.08, e.v * KS));
  const GAP = .45, XS = -4, XD = 4, HW = .25, DEP = .6, YC = -.15;
  const column = (tots, key) => { const hs = tots.map((t, i) => Math.max(.4, t * KS, E.filter(e => e[key] === i).map(e => e.w).reduce(sum, 0)));
    let y = YC + (hs.reduce(sum) + GAP * (hs.length - 1)) / 2; return hs.map(h => { const top = y; y -= h + GAP; return { top, h, cy: top - h / 2 }; }); };
  const SC = column(srcTot, 's'), DC = column(snkTot, 'd');
  // attach points: at a source, ribbons stack in sink order; at a sink, in source order
  SC.forEach((n, i) => { const L = E.filter(e => e.s === i).sort((a, b) => a.d - b.d); let y = n.cy + L.map(e => e.w).reduce(sum, 0) / 2; L.forEach(e => { e.y0 = y - e.w / 2; y -= e.w; }); });
  DC.forEach((n, i) => { const L = E.filter(e => e.d === i).sort((a, b) => a.s - b.s); let y = n.cy + L.map(e => e.w).reduce(sum, 0) / 2; L.forEach(e => { e.y1 = y - e.w / 2; y -= e.w; }); });

  // ---------- slabs (glass + one merged edge buffer) ----------
  const slabs = {}, slabMeshes = [], ePos = [], eCol = [], disposables = [];
  const slab = (key, x, cy, h, col) => { const geo = new THREE.BoxGeometry(HW * 2, h, DEP), mat = glass(col, .12), m = new THREE.Mesh(geo, mat); m.position.set(x, cy, 0); m.userData.key = key; scene.add(m); slabMeshes.push(m); disposables.push(geo, mat);
    slabs[key] = { m, op: .12, em: .08 };
    const eg = new THREE.EdgesGeometry(geo, 20), p = eg.attributes.position, c = new THREE.Color(col); for (let i = 0; i < p.count; i++) { ePos.push(p.getX(i) + x, p.getY(i) + cy, p.getZ(i)); eCol.push(c.r, c.g, c.b); } eg.dispose(); };
  SC.forEach((n, i) => slab('s' + i, XS, n.cy, n.h, COL[SRC[i].key]));
  DC.forEach((n, i) => { if (i) slab('d' + i, XD, n.cy, n.h, COL[SNK[i].key]); });
  // Home: stacked rest (top), AC, pool (bottom), proportional to the home the ribbons place
  const hn = DC[0], homeSplit = snkTot[0], hs = Math.max(homeSplit, pool + ac + rest), sliceY = {};
  const slices = hs > 0 ? [['rest', rest, COL.rest], ['ac', ac, COL.ac], ['pool', pool, COL.home]] : [['rest', 1, COL.rest], ['ac', 0, COL.ac], ['pool', 0, COL.home]];
  { let y = hn.top; slices.forEach(([k, v, c]) => { const h = Math.max(.05, v / (hs || 1) * hn.h); slab('h' + k, XD, y - h / 2, h, c); sliceY[k] = y - h / 2; y -= h; }); }
  { const g = new THREE.BufferGeometry(), m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .85 });
    g.setAttribute('position', new THREE.Float32BufferAttribute(ePos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(eCol, 3)); scene.add(new THREE.LineSegments(g, m)); disposables.push(g, m); }

  // ---------- ribbons: cubic Béziers × 24 samples as flat strips, one draw call; per-ribbon uniforms indexed by aId ----------
  const N = 24, TRI = (N - 1) * 2, x0 = XS + HW, x1 = XD - HW, cx = (x1 - x0) * .45, ZS = [.12, 0, -.12];
  const bez = (e, t) => { const u = 1 - t, y = u * u * u * e.y0 + 3 * u * u * t * e.y0 + 3 * u * t * t * e.y1 + t * t * t * e.y1;
    const x = u * u * u * x0 + 3 * u * u * t * (x0 + cx) + 3 * u * t * t * (x1 - cx) + t * t * t * x1; return new THREE.Vector3(x, y, ZS[e.s]); };
  const pos = [], uv = [], ids = [], idx = [];
  E.forEach((e, j) => { let len = 0, prev = null;
    for (let i = 0; i < N; i++) { const t = i / (N - 1), p = bez(e, t); if (prev) len += p.distanceTo(prev); prev = p;
      pos.push(p.x, p.y + e.w / 2, p.z, p.x, p.y - e.w / 2, p.z); uv.push(t, 1, t, 0); ids.push(j, j);
      if (i < N - 1) { const a = j * N * 2 + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    e.len = len; });
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); rg.setAttribute('aId', new THREE.Float32BufferAttribute(ids, 1)); rg.setIndex(idx);
  const pad = (a, v) => { while (a.length < 7) a.push(v); return a; }, maxV = Math.max(...E.map(e => e.v));
  const U = { uT: { value: 0 },
    uSrc: { value: pad(E.map(e => new THREE.Color(COL[SRC[e.s].key])), new THREE.Color()) }, uDst: { value: pad(E.map(e => new THREE.Color(COL[SNK[e.d].key])), new THREE.Color()) },
    uOn: { value: pad(E.map(() => .85), 0) }, uLen: { value: pad(E.map(e => e.len), 1) }, uSpeed: { value: pad(E.map(() => .35), 0) }, uEst: { value: pad(E.map(e => e.est ? 1 : 0), 0) } };
  const rmat = new THREE.ShaderMaterial({ uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `attribute float aId;uniform vec3 uSrc[7];uniform vec3 uDst[7];uniform float uOn[7],uLen[7],uSpeed[7],uEst[7];
      varying vec2 vUv;varying vec3 vS,vD;varying float vOn,vLen,vSp,vEst;
      void main(){int i=int(aId+.5);vUv=uv;vS=uSrc[i];vD=uDst[i];vOn=uOn[i];vLen=uLen[i];vSp=uSpeed[i];vEst=uEst[i];gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    // the flowline dash from home.js, the source→sink blend over the last 30% and a dotted look for estimated ribbons
    fragmentShader: `uniform float uT;varying vec2 vUv;varying vec3 vS,vD;varying float vOn,vLen,vSp,vEst;
      void main(){float d=fract(vUv.x*vLen/.9-uT*vSp);float dash=smoothstep(.0,.15,d)*smoothstep(.75,.45,d);
        float dotted=vEst>.5?mix(.35,1.,step(.5,fract(vUv.x*vLen/.25))):1.;
        vec3 c=mix(vS,vD,smoothstep(.7,1.,vUv.x));float side=smoothstep(0.,.22,vUv.y)*smoothstep(1.,.78,vUv.y);
        float a=(.2+.55*dash*vOn)*mix(.6,1.,side)*(.3+.7*vOn)*dotted;
        gl_FragColor=vec4(c*(.75+.8*dash*vOn),clamp(a,0.,1.));
        #include <colorspace_fragment>
      }` });
  const ribbon = new THREE.Mesh(rg, rmat); disposables.push(rg, rmat);
  scene.add(ribbon); scene.updateMatrixWorld();   // so taps can pick before the first render

  // ---------- DOM labels (projected by hand so they can be clamped inside the canvas) ----------
  const labels = [];
  const mk = (cls, html, p, ax, ay, extra = {}) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.style.transform = 'none'; labs.appendChild(d); const L = { el: d, p, ax, ay, oy: 0, show: true, ...extra }; labels.push(L); return L; };
  SC.forEach((n, i) => mk('lax', `${SRC[i].name} · ${f1(srcTot[i])}`, new THREE.Vector3(XS, n.top + .05, DEP / 2), .5, 1, { fixed: true }));
  DC.forEach((n, i) => mk('lax', `${SNK[i].name} · ${f1(snkTot[i])}`, new THREE.Vector3(XD, n.top + .05, DEP / 2), .5, 1, { fixed: true }));
  const lAc = mk('lbl3d', `AC <span class="n">${f1(ac)} kWh</span> · ${prov.ac.src}`, new THREE.Vector3(XD - HW - .1, sliceY.ac, DEP / 2), 1, .5, { fixed: true });
  const lPool = mk('lbl3d', `pool <span class="n">${f1(pool)} kWh</span> · ${prov.pool.src}`, new THREE.Vector3(XD - HW - .1, sliceY.pool, DEP / 2), 1, 1, { fixed: true });
  const edgeL = [...E].sort((a, b) => b.v - a.v).map(e => mk('lbl3d e', `<span class="n">${e.est ? '≈' : ''}${f1(e.v)} kWh</span>`, null, .5, .5, { edge: e }));
  const project = p => { const v = p.clone().project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; };
  const rectOf = L => { const [x, y] = project(L.p); const l = clamp(x - L.w * L.ax, 4, W - L.w - 4), t = clamp(y - L.h * L.ay + L.oy, 4, H - L.h - 4); return { l, t, r: l + L.w, b: t + L.h }; };
  const hits = (a, b, g = 3) => a.l < b.r + g && b.l < a.r + g && a.t < b.b + g && b.t < a.b + g;
  const TRY = Array.from({ length: 19 }, (_, i) => .14 + i * .04).sort((a, b) => Math.abs(a - .5) - Math.abs(b - .5));   // midpoint first, then outward
  function layout() {   // at the resting camera: fixed labels first, then up to 3 edge labels that find a clear spot along their ribbon
    if (!el.clientWidth) return;
    const saved = cam.position.clone(); cam.position.set(0, .5, 13); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    labels.forEach(L => { L.el.style.display = ''; L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; L.oy = 0; });
    const placed = labels.filter(L => L.fixed).map(L => { L.r = rectOf(L); return L.r; });
    const ra = lAc.r, rp = lPool.r; if (hits(ra, rp, 2)) { lAc.oy = rp.t - 3 - ra.b; lAc.r = rectOf(lAc); placed[placed.indexOf(ra)] = lAc.r; }   // pool sits on its slice; AC moves up to clear it
    let shown = 0;
    const selId = sel?.type === 'edge' ? sel.k : null;
    [...edgeL].sort((a, b) => (b.edge.id === selId) - (a.edge.id === selId)).forEach(L => { L.show = false; if (shown >= 3) return;
      const dys = L.edge.w > .5 ? [0, .3, -.3] : [0];   // a thick ribbon can carry its label off-centre, still on the ribbon
      search: for (const dy of dys) for (const t of TRY) { L.p = bez(L.edge, t); L.p.y += dy * L.edge.w; const r = rectOf(L); if (!placed.some(q => hits(q, r))) { L.show = true; placed.push(r); shown++; break search; } } });
    cam.position.copy(saved); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); place();
  }
  function place() { labels.forEach(L => { if (!L.show) { L.el.style.display = 'none'; return; } L.el.style.display = ''; const r = rectOf(L); L.el.style.transform = `translate(${r.l.toFixed(1)}px,${r.t.toFixed(1)}px)`; }); }

  // ---------- selection, emphasis, readout ----------
  let sel = opts.sel && (opts.sel.type !== 'edge' || E.some(e => e.id === opts.sel.k)) ? opts.sel : null, ready = false;
  const HC = ['all', 'ac', 'pool', 'rest'];
  const onT = E.map(() => .85), slabT = {};
  function apply() {
    Object.keys(slabs).forEach(k => slabT[k] = { op: .12, em: .08 });
    const bright = k => slabT[k] = { op: .3, em: .35 }, dim = k => slabT[k] = { op: .05, em: .04 };
    E.forEach((e, j) => onT[j] = .85);
    if (sel?.type === 'edge') { const e = E.find(x => x.id === sel.k); E.forEach((x, j) => onT[j] = x === e ? 1 : .45); bright('s' + e.s); if (e.d) bright('d' + e.d); else ['rest', 'ac', 'pool'].forEach(k => bright('h' + k)); }
    if (sel?.type === 'node') { E.forEach((x, j) => onT[j] = (sel.side === 's' ? x.s : x.d) === sel.i ? 1 : .45); bright(sel.side + sel.i); }
    if (sel?.type === 'slice') { E.forEach((x, j) => onT[j] = x.d === 0 ? 1 : .45); ['rest', 'ac', 'pool'].forEach(k => sel.k === 'all' || sel.k === k ? bright('h' + k) : dim('h' + k)); }
    edgeL.forEach(L => L.el.classList.toggle('on', sel?.type === 'edge' && L.edge.id === sel.k));
    tip.innerHTML = tipText();
    if (ready) layout();
  }
  const shares = (list, tot, name) => list.filter(x => x.v > 0).map(x => `${pc(x.v / tot)} ${name(x)}${x.est ? ' ≈' : ''}`).join(' · ');
  function tipText() {
    if (!sel) return 'Tap a ribbon or a slab. Ribbon width is kWh; colour runs from where the energy came from to where it went.';
    if (sel.type === 'edge') { const e = E.find(x => x.id === sel.k), S = SRC[e.s], D = SNK[e.d], rate = e.d === 2 ? f.rate?.exportCredit : f.rate?.importRateAllIn;
      return `<b>${S.name} → ${D.name}</b> · ${e.est ? '≈' : ''}${f1(e.v)} kWh · ${pc(e.v / srcTot[e.s])} of ${S.noun} · ${usd(rate == null ? null : e.v * rate)}${e.d === 2 ? ' credit' : ''} at your rate${e.est ? ' · estimated' : ''}`; }
    if (sel.type === 'node' && sel.side === 's') { const i = sel.i; return `<b>${SRC[i].name}</b> · ${f1(srcTot[i])} kWh ${SRC[i].verb} · ${shares(E.filter(e => e.s === i), srcTot[i], e => SNK[e.d].short)}`; }
    if (sel.type === 'node') { const i = sel.i; return `<b>${SNK[i].name}</b> · ${f1(snkTot[i])} kWh ${SNK[i].verb} · ${shares(E.filter(e => e.d === i), snkTot[i], e => SRC[e.s].short)}`; }
    const k = sel.k, of = v => homeSplit > 0 ? pc(v / homeSplit) : '—';
    if (k === 'all') return `<b>Home</b> · ${f1(homeSplit)} kWh used · ${shares(E.filter(e => e.d === 0), homeSplit, e => SRC[e.s].short)} · tap again for AC, pool and the rest`;
    if (k === 'ac') return `<b>Home · AC</b> · ${f1(ac)} kWh · ${of(ac)} of home use · ${prov.ac.how}`;
    if (k === 'pool') return `<b>Home · pool</b> · ${f1(pool)} kWh · ${of(pool)} of home use · ${prov.pool.how}`;
    return `<b>Home · everything else</b> · ${f1(rest)} kWh · ${of(rest)} of home use · what is left after the pool and the AC`;
  }

  // ---------- picking + parallax ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), cv = renderer.domElement;
  function pick(x, y) { const r = el.getBoundingClientRect();
    for (const [dx, dy] of [[0, 0], [0, -6], [0, 6], [-6, 0], [6, 0], [0, -12], [0, 12]]) {
      ndc.set((x + dx - r.left) / r.width * 2 - 1, -((y + dy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, cam);
      const h = ray.intersectObjects([...slabMeshes, ribbon], false)[0]; if (h) return h; } return null; }
  function tap(x, y) { const h = pick(x, y);
    if (!h) sel = null;
    else if (h.object === ribbon) { const e = E[Math.floor(h.faceIndex / TRI)]; sel = sel?.type === 'edge' && sel.k === e.id ? null : { type: 'edge', k: e.id }; }
    else { const k = h.object.userData.key;
      if (k[0] === 'h') sel = { type: 'slice', k: sel?.type === 'slice' ? HC[(HC.indexOf(sel.k) + 1) % HC.length] : 'all' };
      else { const side = k[0], i = +k.slice(1); sel = sel?.type === 'node' && sel.side === side && sel.i === i ? null : { type: 'node', side, i }; } }
    apply(); }
  let yaw = 0, yawT = 0, down = null; const MAXYAW = 12 * Math.PI / 180;
  const on = (t, fn) => cv.addEventListener(t, fn);
  on('pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY }; });
  on('pointermove', ev => { const r = el.getBoundingClientRect(); yawT = clamp(((ev.clientX - r.left) / r.width - .5) * 2, -1, 1) * MAXYAW; });
  on('pointerup', ev => { if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 8) tap(ev.clientX, ev.clientY); down = null; if (ev.pointerType !== 'mouse') yawT = 0; });
  on('pointerleave', () => { yawT = 0; down = null; });
  on('pointercancel', () => { yawT = 0; down = null; });

  // ---------- loop: renders only while ≥ 10% visible on the open tab; disposes when the tab closes ----------
  let vis = true, t = 0, last = performance.now(), lastYaw = NaN, raf = 0, dead = false;
  const io = new IntersectionObserver(es => { vis = es[es.length - 1].intersectionRatio >= .1; }, { root: document.getElementById('screen'), threshold: [0, .1, .5] });
  io.observe(el);
  const ro = new ResizeObserver(() => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h || (w === W && h === H)) return; W = w; H = h; renderer.setSize(W, H); cam.aspect = W / H; cam.updateProjectionMatrix(); layout(); });
  ro.observe(el);
  function frame(now) {
    if (dead) return;
    if (!card.isConnected || !el.offsetParent || card.hidden) { dispose(); return; }   // the History tab (or the card) closed
    raf = requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!vis || document.hidden) return;
    t += dt;
    yaw += (yawT - yaw) * Math.min(1, dt * 5);
    if (Math.abs(yaw - lastYaw) > 1e-5 || lastYaw !== lastYaw) { cam.position.set(13 * Math.sin(yaw), .5, 13 * Math.cos(yaw)); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); place(); lastYaw = yaw; }
    const calm = opts.calm?.();
    U.uT.value = t; const k = Math.min(1, dt * 8);
    E.forEach((e, j) => { U.uOn.value[j] += (onT[j] - U.uOn.value[j]) * k; U.uSpeed.value[j] = calm ? .25 : .35 + 1.1 * e.v / maxV; });
    Object.entries(slabs).forEach(([key, s]) => { const T = slabT[key]; s.op += (T.op - s.op) * k; s.em += (T.em - s.em) * k; s.m.material.opacity = s.op; s.m.material.emissiveIntensity = s.em; });
    renderer.render(scene, cam);
  }
  function dispose() {
    if (dead) return; dead = true;
    cancelAnimationFrame(raf); io.disconnect(); ro.disconnect();
    disposables.forEach(x => x.dispose());
    renderer.dispose(); renderer.forceContextLoss(); cv.remove(); labs.remove();
  }

  apply(); E.forEach((e, j) => U.uOn.value[j] = onT[j]); Object.entries(slabs).forEach(([key, s]) => { s.op = slabT[key].op; s.em = slabT[key].em; });
  ready = true; layout(); document.fonts?.ready.then(() => { if (!dead) layout(); });
  raf = requestAnimationFrame(frame);
  return { dispose, alive: () => !dead, sel: () => sel };
}
