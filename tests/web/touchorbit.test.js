// Touch on the 3D cards (web/src/lib/touchorbit.js): vertical drags are left to the page, horizontal drags orbit (azimuth only),
// a second finger never orbits, and mouse input is left to OrbitControls.
import { describe, it, expect } from 'vitest';
import { touchIntent, touchOrbit, SLOP } from '../../web/src/lib/touchorbit.js';

const H = 370;
function setup({ autoRotate = true } = {}) {
  const el = Object.assign(new EventTarget(), { style: { touchAction: 'none' }, clientHeight: H });
  const turns = [];
  const controls = { domElement: el, touches: { ONE: 0, TWO: 2 }, enabled: true, autoRotate, rotateSpeed: 1, rotateLeft: a => turns.push(a) };
  touchOrbit(controls);
  const fire = (type, x, y, o = {}) => el.dispatchEvent(Object.assign(new Event(type), { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, ...o }));
  return { el, controls, turns, fire };
}

describe('touchIntent', () => {
  it('waits for about 8 px of movement', () => {
    expect(SLOP).toBe(8);
    expect(touchIntent(0, 0)).toBeNull();
    expect(touchIntent(5, 5)).toBeNull();
    expect(touchIntent(-7.9, 0)).toBeNull();
  });
  it('mostly horizontal orbits, mostly vertical (or a tie) scrolls', () => {
    expect(touchIntent(8, 0)).toBe('orbit');
    expect(touchIntent(-12, 5)).toBe('orbit');
    expect(touchIntent(3, 9)).toBe('scroll');
    expect(touchIntent(0, -20)).toBe('scroll');
    expect(touchIntent(7, 7)).toBe('scroll');
  });
});

describe('touchOrbit', () => {
  it('lets the page pan vertically and takes touch away from OrbitControls', () => {
    const { el, controls } = setup();
    expect(el.style.touchAction).toBe('pan-y');
    expect(controls.touches).toEqual({ ONE: null, TWO: null });
  });
  it('a vertical drag never turns the scene', () => {
    const { fire, turns, controls } = setup();
    fire('pointerdown', 100, 100); fire('pointermove', 102, 110); fire('pointermove', 104, 160); fire('pointercancel', 104, 160);
    expect(turns).toEqual([]);
    expect(controls.autoRotate).toBe(true);
  });
  it('a horizontal drag orbits by OrbitControls\' scale, from where the finger landed, and pauses auto-rotate until lift', () => {
    const { fire, turns, controls } = setup();
    fire('pointerdown', 100, 100); fire('pointermove', 104, 101);
    expect(turns).toEqual([]);                                   // still under the slop
    fire('pointermove', 110, 102);
    expect(controls.autoRotate).toBe(false);
    fire('pointermove', 150, 130);                              // later vertical drift never tilts: only rotateLeft exists here
    fire('pointerup', 150, 130);
    expect(turns.reduce((a, b) => a + b, 0)).toBeCloseTo(2 * Math.PI * 50 / H);
    expect(controls.autoRotate).toBe(true);
  });
  it('does not resume auto-rotate that was off', () => {
    const { fire, controls } = setup({ autoRotate: false });
    fire('pointerdown', 0, 0); fire('pointermove', 30, 0); fire('pointerup', 30, 0);
    expect(controls.autoRotate).toBe(false);
  });
  it('a second finger stops the orbit until every finger is up', () => {
    const { fire, turns } = setup();
    fire('pointerdown', 100, 100); fire('pointermove', 120, 100);
    const n = turns.length;
    fire('pointerdown', 200, 100, { pointerId: 2, isPrimary: false });
    fire('pointermove', 160, 100); fire('pointerup', 200, 100, { pointerId: 2 }); fire('pointermove', 190, 100);
    expect(turns.length).toBe(n);
    fire('pointerup', 190, 100);
    fire('pointerdown', 0, 0); fire('pointermove', 20, 0);      // a fresh touch orbits again
    expect(turns.length).toBe(n + 1);
  });
  it('leaves mouse and pen to OrbitControls', () => {
    const { fire, turns } = setup();
    for (const pointerType of ['mouse', 'pen']) { fire('pointerdown', 0, 0, { pointerType }); fire('pointermove', 50, 0, { pointerType }); fire('pointerup', 50, 0, { pointerType }); }
    expect(turns).toEqual([]);
  });
});
