/*
 * Touch on the 3D cards. OrbitControls sets `touch-action: none` on its canvas, so a finger that lands on a card could
 * never scroll the page. touchOrbit(controls) gives the canvas `touch-action: pan-y`, takes touch away from OrbitControls
 * and decides each one-finger drag from its first ~8 px of movement:
 *   mostly vertical   → nothing here; the browser scrolls the page (no tilt on touch);
 *   mostly horizontal → the scene orbits around its vertical axis only (azimuth), through OrbitControls, so damping still applies.
 * A second finger ends the orbit and pinch is left to the browser (the scenes never zoom on touch).
 * Mouse and pen input stay with OrbitControls, unchanged.
 */
export const SLOP = 8;

/** 'orbit' | 'scroll' for a drag of (dx, dy) CSS px from where the finger landed, or null while it is still under `slop`. */
export const touchIntent = (dx, dy, slop = SLOP) => Math.hypot(dx, dy) < slop ? null : Math.abs(dx) > Math.abs(dy) ? 'orbit' : 'scroll';

export function touchOrbit(controls) {
  const el = controls.domElement;
  controls.touches.ONE = controls.touches.TWO = null;   // OrbitControls now ignores touch (its handlers fall through to "no state")
  el.style.touchAction = 'pan-y';                       // OrbitControls wrote 'none' when it connected
  const fingers = new Set();
  let x0 = 0, y0 = 0, lastX = 0, intent = null, resume = false;
  const reset = () => { if (resume) controls.autoRotate = true; intent = null; resume = false; };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (e.isPrimary && fingers.size) { fingers.clear(); reset(); }   // a new touch while one looked active: its pointerup was lost
    fingers.add(e.pointerId);
    if (fingers.size === 1) { x0 = lastX = e.clientX; y0 = e.clientY; intent = null; }
    else intent = 'multi';                              // pinch or two-finger gesture: the browser's, never an orbit
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !fingers.has(e.pointerId) || fingers.size !== 1 || !controls.enabled) return;
    if (!intent) {
      intent = touchIntent(e.clientX - x0, e.clientY - y0);
      if (intent !== 'orbit') return;
      resume = controls.autoRotate; controls.autoRotate = false;   // as OrbitControls does while a drag is active
    }
    if (intent !== 'orbit') return;
    controls.rotateLeft(2 * Math.PI * (e.clientX - lastX) * controls.rotateSpeed / el.clientHeight);   // OrbitControls' own scale
    lastX = e.clientX;
  });
  const lift = e => { if (fingers.delete(e.pointerId) && !fingers.size) reset(); };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);           // the browser took the gesture over (it scrolls the page)
}
