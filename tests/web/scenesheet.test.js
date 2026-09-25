// Full-screen scene sheet (web/src/lib/scenesheet.js, mockups/s-expand.html): the one-vs-two-finger gesture state machine and the
// zoom / pan clamp maths for the road and the landscape.
import { describe, it, expect } from 'vitest';
import { gestureState, roadZoomAt, roadPanBy, atHome, clampTarget, orbitZoom, TAP_SLOP } from '../../web/src/lib/scenesheet.js';

describe('gestureState', () => {
  it('a still finger is a tap; 6 px or more is a drive, not a tap', () => {
    expect(TAP_SLOP).toBe(6);
    let g = gestureState();
    expect(g.down(1, 100, 100)).toEqual({ type: 'start' });
    expect(g.move(1, 103, 104)).toBeNull();            // 5 px: still a tap
    expect(g.up(1, 103, 104)).toEqual({ type: 'tap', x: 103, y: 104 });
    g = gestureState();
    g.down(1, 100, 100);
    expect(g.move(1, 106, 100)).toEqual({ type: 'drive', dx: 6, dy: 0 });
    expect(g.move(1, 80, 102)).toEqual({ type: 'drive', dx: -20, dy: 2 });
    expect(g.up(1, 80, 102)).toBeNull();
  });

  it('a second finger stops the drive at once and turns into pinch + pan around the midpoint', () => {
    const g = gestureState();
    g.down(1, 100, 100); g.move(1, 120, 100);
    expect(g.driving).toBe(true);
    expect(g.down(2, 200, 100)).toEqual({ type: 'pinch-start' });
    expect(g.multi).toBe(true);
    expect(g.move(1, 100, 100)).toEqual({ type: 'pinch', scale: 100 / 80, x: 150, y: 100, dx: -10, dy: 0 });   // spread: zoom in
    expect(g.move(2, 220, 120)).toEqual({ type: 'pinch', scale: Math.hypot(120, 20) / 100, x: 160, y: 110, dx: 10, dy: 10 });
  });

  it('lifting one finger does not restart the drive; a new drive needs all fingers up first', () => {
    const g = gestureState();
    g.down(1, 100, 100); g.down(2, 200, 100);
    expect(g.up(2, 200, 100)).toBeNull();
    expect(g.count).toBe(1);
    expect(g.move(1, 160, 100)).toBeNull();            // the remaining finger moves nothing
    expect(g.move(1, 20, 100)).toBeNull();
    expect(g.up(1, 20, 100)).toBeNull();               // and is never a tap
    expect(g.multi).toBe(false);
    g.down(3, 50, 50);                                 // all up: the next finger drives again
    expect(g.move(3, 70, 50)).toEqual({ type: 'drive', dx: 20, dy: 0 });
  });

  it('a tap never counts once a second finger touched down, even if nothing moved', () => {
    const g = gestureState();
    g.down(1, 100, 100); g.down(2, 110, 100);
    expect(g.up(2, 110, 100)).toBeNull();
    expect(g.up(1, 100, 100)).toBeNull();
  });

  it('pointercancel is never a tap, and a fresh primary touch clears pointers whose pointerup was lost', () => {
    let g = gestureState();
    g.down(1, 100, 100);
    expect(g.up(1, 100, 100, true)).toBeNull();
    g = gestureState();
    g.down(1, 100, 100); g.down(2, 150, 100);        // both pointerups lost
    expect(g.down(3, 10, 10, true)).toEqual({ type: 'start' });
    expect(g.count).toBe(1);
    expect(g.up(3, 10, 10)).toEqual({ type: 'tap', x: 10, y: 10 });
  });

  it('moves from pointers it never saw are ignored', () => {
    const g = gestureState();
    expect(g.move(9, 1, 1)).toBeNull();
    expect(g.up(9, 1, 1)).toBeNull();
  });
});

describe('road zoom and pan', () => {
  const o = { W: 375, H: 700, span: 30, zMax: 4, dLim: [-3, 44], tyLim: [-.6, 1.6] };
  const home = { d: 0, z: 1, ty: 0 };

  it('zooms between 1× and 4×', () => {
    let v = home;
    for (let i = 0; i < 20; i++) v = roadZoomAt(v, 1.5, o.W / 2, o.H / 2, o);
    expect(v.z).toBe(4);
    for (let i = 0; i < 20; i++) v = roadZoomAt(v, .5, o.W / 2, o.H / 2, o);
    expect(v.z).toBe(1);
    expect(roadZoomAt(home, .5, 10, 10, o)).toBe(home);   // already at 1×: nothing moves
  });

  it('zooming at the centre keeps the centre; zooming at a side moves toward it', () => {
    const c = roadZoomAt({ d: 10, z: 1, ty: 0 }, 2, o.W / 2, o.H / 2, o);
    expect(c).toEqual({ d: 10, z: 2, ty: 0 });
    const r = roadZoomAt({ d: 10, z: 1, ty: 0 }, 2, o.W, o.H / 2, o);
    expect(r.d).toBeCloseTo(10 + .5 * 30 * .5);        // half the view width × (1/1 − 1/2)
    const l = roadZoomAt({ d: 10, z: 1, ty: 0 }, 2, 0, o.H / 2, o);
    expect(l.d).toBeCloseTo(10 - 7.5);
    const up = roadZoomAt({ d: 10, z: 1, ty: 0 }, 2, o.W / 2, 0, o);
    expect(up.ty).toBeGreaterThan(0);
  });

  it('the world point under the fingers stays put through a zoom', () => {
    // screen x → world x at the target plane: d + (sx/W − .5) · span / z
    const world = (v, sx) => v.d + (sx / o.W - .5) * o.span / v.z;
    const v0 = { d: 12, z: 1.3, ty: 0 }, sx = 290;
    const v1 = roadZoomAt(v0, 1.7, sx, 300, o);
    expect(world(v1, sx)).toBeCloseTo(world(v0, sx));
  });

  it('pan is clamped so the road cannot leave the screen', () => {
    let v = home;
    v = roadPanBy(v, 1e6, 0, o); expect(v.d).toBe(-3);          // from 3 h before now…
    v = roadPanBy(v, -1e6, 0, o); expect(v.d).toBe(44);         // …to the last hour
    v = roadPanBy(v, 0, 1e6, o); expect(v.ty).toBe(1.6);        // top of the battery wall
    v = roadPanBy(v, 0, -1e6, o); expect(v.ty).toBe(-.6);       // the floor
    const z = roadZoomAt({ d: 43, z: 1, ty: 1.5 }, 4, o.W, 0, o);
    expect(z.d).toBeLessThanOrEqual(44); expect(z.ty).toBeLessThanOrEqual(1.6);
  });

  it('pan follows the fingers and is finer when zoomed', () => {
    const a = roadPanBy({ d: 10, z: 1, ty: 0 }, -37.5, 0, o), b = roadPanBy({ d: 10, z: 2, ty: 0 }, -37.5, 0, o);
    expect(a.d).toBeCloseTo(13); expect(b.d).toBeCloseTo(11.5);
  });

  it('knows the opening view', () => {
    expect(atHome({ d: 5, z: 1, ty: 0 }, { d: 5, z: 1, ty: 0 })).toBe(true);
    expect(atHome({ d: 5, z: 1.1, ty: 0 }, { d: 5, z: 1, ty: 0 })).toBe(false);
    expect(atHome({ d: 6, z: 1, ty: 0 }, { d: 5, z: 1, ty: 0 })).toBe(false);
    expect(atHome({ d: 5, z: 1, ty: .2 }, { d: 5, z: 1, ty: 0 })).toBe(false);
  });
});

describe('landscape clamp', () => {
  const box = { x: [-11, 11], y: [0, 5], z: [-16, 16] };
  it('keeps the target over the grid and reports the shift for the camera', () => {
    const t = { x: 14, y: -1, z: -20 };
    expect(clampTarget(t, box)).toEqual({ x: -3, y: 1, z: 4 });
    expect(t).toEqual({ x: 11, y: 0, z: -16 });
    const inside = { x: 1, y: 2, z: 3 };
    expect(clampTarget(inside, box)).toEqual({ x: 0, y: 0, z: 0 });
    expect(inside).toEqual({ x: 1, y: 2, z: 3 });
  });
  it('zoom runs from 1× (all days fit) to 6×', () => {
    expect(orbitZoom(60, 60, 6)).toBe(1);
    expect(orbitZoom(60, 80, 6)).toBe(1);
    expect(orbitZoom(60, 20, 6)).toBe(3);
    expect(orbitZoom(60, 5, 6)).toBe(6);
  });
});
