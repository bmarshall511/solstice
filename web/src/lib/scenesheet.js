/*
 * Full-screen sheet for a 3D card's scene (approved mockups/s-expand.html). One module for both scenes that expand: the Next 48
 * hours road on Now (scenes/road48.js) and the Production landscape on History (scenes/landscape.js).
 *
 * The shell here owns the DOM, the slide, the hint, the zoom chip and reset button, the dock, Escape and the back gesture (one
 * history entry per open). Each scene mounts its own renderer into `bits.scene` and returns { dispose, reset?, onKey? }.
 * Only one sheet is open at a time; its WebGL context is freed on close. The page's touch helper (lib/touchorbit.js) is not used.
 *
 * The pure parts (the two-finger gesture state machine and the zoom / pan clamp maths) are exported for tests.
 */

export const TAP_SLOP = 6;           // a tap moves less than this many px and never has a second finger
export const HINT_MS = 3000, SLIDE_MS = 240;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- gesture state machine (pure) ----------------
 * One finger drives / rotates. When a second finger lands the drive stops at once and the touch becomes pinch + pan around the
 * midpoint. Lifting one finger does not restart the drive: a new drive needs all fingers up first. */
export function gestureState(slop = TAP_SLOP) {
  const pts = new Map();
  let one = null, two = null, multi = false;
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) }; };
  return {
    get count() { return pts.size; },
    get multi() { return multi; },
    get driving() { return !!one?.moved; },
    /** A pointer lands. `primary` true on a fresh first touch: any pointer still listed lost its pointerup. */
    down(id, x, y, primary = false) {
      if (primary && pts.size) { pts.clear(); one = two = null; multi = false; }
      pts.set(id, { x, y });
      if (pts.size === 1 && !multi) { one = { id, x, y, moved: false }; return { type: 'start' }; }
      one = null; multi = true; two = mid();
      return { type: 'pinch-start' };
    },
    /** → { type: 'drive', dx, dy } (from where the finger landed) | { type: 'pinch', scale, x, y, dx, dy } (since the last move) | null */
    move(id, x, y) {
      if (!pts.has(id)) return null;
      pts.set(id, { x, y });
      if (pts.size >= 2 && two) {
        const m = mid(), out = { type: 'pinch', scale: two.dist > 0 ? m.dist / two.dist : 1, x: m.x, y: m.y, dx: m.x - two.x, dy: m.y - two.y };
        two = m; return out;
      }
      if (one && id === one.id) {
        const dx = x - one.x, dy = y - one.y;
        if (!one.moved && Math.hypot(dx, dy) >= slop) one.moved = true;
        return one.moved ? { type: 'drive', dx, dy } : null;
      }
      return null;
    },
    /** → { type: 'tap', x, y } when this was a tap, else null. `cancel` for pointercancel. */
    up(id, x, y, cancel = false) {
      const tap = !cancel && one && id === one.id && !one.moved && !multi && pts.size === 1;
      pts.delete(id);
      if (pts.size < 2) two = null;
      if (!pts.size) { multi = false; one = null; }
      else if (one?.id === id) one = null;
      return tap ? { type: 'tap', x, y } : null;
    },
    reset() { pts.clear(); one = two = null; multi = false; },
  };
}

/* ---------------- road view maths (pure) ----------------
 * v = { d, z, ty }: drive (hours), zoom (1 = the opening view) and vertical pan (world units).
 * o = { W, H, span, zMax, dLim: [a, b], tyLim: [a, b] }: `span` is the world width visible at the target at zoom 1. */
const TY_K = .6;
export function roadZoomAt(v, f, sx, sy, o) {
  const z = clamp(v.z * f, 1, o.zMax);
  if (z === v.z) return v;
  const k = 1 / v.z - 1 / z, aspect = o.W / o.H;   // keep the world point under (sx, sy) where it is
  return {
    d: clamp(v.d + (sx / o.W - .5) * o.span * k, o.dLim[0], o.dLim[1]),
    ty: clamp(v.ty - (sy / o.H - .5) * o.span / aspect * k * TY_K, o.tyLim[0], o.tyLim[1]),
    z,
  };
}
export function roadPanBy(v, dx, dy, o) {
  const aspect = o.W / o.H;
  return {
    d: clamp(v.d - dx * o.span / o.W / v.z, o.dLim[0], o.dLim[1]),
    ty: clamp(v.ty + dy * o.span / aspect / o.H / v.z * TY_K, o.tyLim[0], o.tyLim[1]),
    z: v.z,
  };
}
export const atHome = (v, home, eps = .01) => Math.abs(v.z - home.z) < eps && Math.abs(v.d - home.d) < eps && Math.abs(v.ty - home.ty) < eps;

/* ---------------- landscape maths (pure) ---------------- */
/** Keep an orbit target inside the box { x: [a, b], y: [a, b], z: [a, b] }; returns the shift applied (add it to the camera too). */
export function clampTarget(t, box) {
  const s = { x: clamp(t.x, ...box.x) - t.x, y: clamp(t.y, ...box.y) - t.y, z: clamp(t.z, ...box.z) - t.z };
  t.x += s.x; t.y += s.y; t.z += s.z;
  return s;
}
/** Zoom level of an orbit camera: the opening distance over the current one, clamped to [1, zMax]. */
export const orbitZoom = (homeDist, dist, zMax) => clamp(homeDist / dist, 1, zMax);

/* ---------------- the sheet shell ---------------- */
let current = null, skipPop = 0;
if (typeof window !== 'undefined') {
  addEventListener('popstate', () => {
    if (skipPop) { skipPop--; return; }
    current?.close(true);   // the back gesture
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && current) { e.preventDefault(); current.close(); } });
}

const EXPAND_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9.3 6.7M2.5 13.5l4.2-4.2"/></svg>';
const CLOSE_SVG = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 2.5l9 9M11.5 2.5l-9 9"/></svg>';
const RESET_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8"/><path d="M2.5 2.2v3h3"/></svg>';

/** The icon-only glass expand button for a card's scene (top-right corner). Its pointer events never reach the scene. */
export function expandButton(host, label, onOpen) {
  const b = document.createElement('button');
  b.className = 'xbtn'; b.type = 'button'; b.setAttribute('aria-label', label); b.innerHTML = EXPAND_SVG;
  for (const t of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'touchstart']) b.addEventListener(t, e => e.stopPropagation());
  b.addEventListener('click', e => { e.stopPropagation(); onOpen(b); });
  host.appendChild(b);
  return b;
}

/**
 * Open a scene full screen.
 * @param o.title   the card's title        @param o.label  the scene's aria-label     @param o.hint  the one-line hint
 * @param o.legend  the dock's legend HTML  @param o.tip    the dock readout's first HTML
 * @param o.calm    () => Calm mode or reduced motion
 * @param o.from    the expand button (focus returns to it)
 * @param o.mount   bits => { dispose(), reset?(), onKey?(e) → handled }
 * @param o.onClose called after the scene is disposed and the sheet removed
 */
export function openSceneSheet(o) {
  if (current) current.close();
  const calm = !!o.calm?.() || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const root = document.createElement('div');
  root.className = 'xs' + (calm ? ' calm' : '');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', o.title);
  root.innerHTML = `<div class="xs-scene" tabindex="0"></div>
    <div class="xs-top"><div class="t"><b></b><span class="xhud">—</span></div><button class="xs-close" type="button" aria-label="Close full screen">${CLOSE_SVG}</button></div>
    <div class="xs-hint"></div>
    <div class="xs-tools"><span class="xs-zoom">1.0×</span><button class="xs-reset" type="button" aria-label="Reset view" disabled>${RESET_SVG}</button></div>
    <div class="xs-dock"><div class="legend"></div><div class="landtip"></div></div>`;
  const q = s => root.querySelector(s);
  const bits = { root, scene: q('.xs-scene'), hud: q('.xhud'), tip: q('.xs-dock .landtip'), zoom: q('.xs-zoom'), reset: q('.xs-reset'), calm };
  bits.scene.setAttribute('aria-label', o.label);
  q('.xs-top b').textContent = o.title; q('.xs-hint').textContent = o.hint;
  q('.xs-dock .legend').innerHTML = o.legend; bits.tip.innerHTML = o.tip ?? '';

  const host = document.getElementById('phone') ?? document.body;
  host.appendChild(root); host.classList.add('xs-on');

  // the zoom chip and reset sit just above the dock; labels keep out of the top bar and of the dock + tools
  const place = () => { q('.xs-tools').style.bottom = (q('.xs-dock').offsetHeight + 10) + 'px'; };
  place();
  bits.keepOut = () => {
    const top = q('.xs-top'), sc = bits.scene.getBoundingClientRect(), t = top.getBoundingClientRect();
    return { top: Math.max(4, t.bottom - sc.top + 6), bottom: q('.xs-dock').offsetHeight + q('.xs-tools').offsetHeight + 16 };
  };
  const hint = q('.xs-hint'); let hintT = setTimeout(() => hint.classList.add('gone'), HINT_MS);
  bits.hideHint = () => { clearTimeout(hintT); hint.classList.add('gone'); };
  bits.setZoom = (z, isHome) => { bits.zoom.textContent = `${z.toFixed(1)}×`; bits.reset.disabled = isHome; };

  const scene = o.mount(bits);
  bits.reset.onclick = () => scene.reset?.();
  bits.scene.addEventListener('pointerdown', bits.hideHint);
  bits.scene.addEventListener('wheel', bits.hideHint, { passive: true });
  bits.scene.addEventListener('keydown', e => {
    if (e.key === '0') { scene.reset?.(); e.preventDefault(); return; }
    if (scene.onKey?.(e)) e.preventDefault();
  });
  bits.scene.addEventListener('contextmenu', e => e.preventDefault());
  const ro = new ResizeObserver(place); ro.observe(q('.xs-dock'));

  // slide up (none with Calm / reduced motion)
  if (!calm) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('on'))); else root.classList.add('on');
  bits.scene.focus({ preventScroll: true });

  history.pushState({ solsticeSheet: 1 }, '');
  let closed = false;
  const api = {
    close(fromHistory = false) {
      if (closed) return; closed = true;
      if (current === api) current = null;
      clearTimeout(hintT); ro.disconnect();
      if (!fromHistory) { skipPop++; history.back(); }
      const done = () => { try { scene.dispose(); } catch (e) { console.warn('sheet', e); }   // frees the sheet's WebGL context
        root.remove(); if (!current) host.classList.remove('xs-on'); o.onClose?.(); o.from?.focus({ preventScroll: true }); };
      if (calm) done();
      else { root.classList.remove('on'); root.classList.add('closing'); setTimeout(done, SLIDE_MS); }
    },
  };
  q('.xs-close').onclick = () => api.close();
  current = api;
  return api;
}
