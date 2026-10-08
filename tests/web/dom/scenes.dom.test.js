// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Smoke tests for every three.js scene module under happy-dom. WebGL can't run here, so THREE.WebGLRenderer is replaced by
// tests/web/dom/fakegl.js (a no-op renderer); everything else is real three.js: the scene graphs, materials, cameras, OrbitControls
// and the CSS2D label renderer. Each scene is built, fed synthetic data, rendered for a few frames and disposed. What this proves:
// the setup and update code runs without throwing, draws through the renderer, and writes no "undefined"/"NaN" into its labels.
// What it can't prove: anything about pixels or shaders (those only compile on a GPU).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stubBrowser, NOW, TODAY, badText } from './harness.js';
import { FakeRenderer } from './fakegl.js';
import { coreFixtures } from './fixtures-core.js';
import { applFixtures } from './fixtures-appl.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));

const host = (w = 393, h = 300) => { const el = document.createElement('div'); Object.defineProperty(el, 'clientWidth', { value: w }); Object.defineProperty(el, 'clientHeight', { value: h }); document.body.appendChild(el); return el; };
const canvas = () => { const c = document.createElement('canvas'); document.body.appendChild(c); return c; };
const reading = { ts: NOW - 20e3, soc: 64, solarKw: 6.2, homeKw: 2.4, batteryKw: -3.1, gridKw: -.7, gridStatus: 'Active', islandStatus: 'on_grid', stormActive: false };
const rendersOf = n0 => FakeRenderer.instances.slice(n0).reduce((a, r) => a + r.renders, 0);
let C, A;

beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  stubBrowser();
  C = coreFixtures(NOW); A = applFixtures(NOW);
});
afterAll(() => vi.useRealTimers());

describe('scenes build, update and dispose with a stubbed renderer', () => {
  it('aurora: set() a reading, render() in and out of an outage', async () => {
    const { createAurora } = await import('../../../web/src/scenes/aurora.js'), n0 = FakeRenderer.instances.length;
    const a = createAurora(canvas());
    a.set(reading); a.render(1, false); a.render(2, true); a.set({});
    expect(rendersOf(n0)).toBe(2);
  });
  it('orb: charging, discharging and islanded frames', async () => {
    const { createOrb } = await import('../../../web/src/scenes/orb.js'), n0 = FakeRenderer.instances.length;
    const o = createOrb(canvas());
    o.render({ soc: 64, batteryKw: -3, solarKw: 6, peakKw: 9, maxKw: 10, out: false, dt: .016, t: 1 });
    o.render({ soc: 30, batteryKw: 2, solarKw: 0, peakKw: 9, maxKw: 10, out: true, dt: .016, t: 2 });
    expect(rendersOf(n0)).toBe(2);
  });
  it('day ring: setData with 24 hours, pick callback, setHour, render, resize', async () => {
    const { createDayRing } = await import('../../../web/src/scenes/dayring.js'), n0 = FakeRenderer.instances.length;
    const picks = [], el = host();
    const r = createDayRing(el, (h, d) => picks.push([h, d]));
    const z = () => Array(24).fill(0).map((_, h) => h > 7 && h < 19 ? 1.2 : .4);
    r.setData({ rest: z(), ac: z().map(v => v / 2), pool: z().map(v => v / 4), solar: z().map(v => v * 2), label: 'today so far', total: 30 });
    r.setHour(14.5); r.render(.016, false); r.render(.016, true); r.resize();
    expect(picks.length).toBeGreaterThan(0);
    expect(rendersOf(n0)).toBe(2);
  });
  it('home twin (flow mode): live frames with pool and AC, then dispose frees the context', async () => {
    const { createHomeView } = await import('../../../web/src/scenes/home.js'), n0 = FakeRenderer.instances.length;
    const el = host(), links = [];
    const v = createHomeView(el, 'flow', { onLink: id => links.push(id) });
    for (let i = 0; i < 3; i++) v.render({ r: reading, cloud: .2, code: 1, out: false, peakKw: 9, dt: .016, t: i, calm: false, day: A['appliances/day'], wx: null, pool: A['appliances/pool'], ac: A['appliances/ac'], reservePct: 20 });
    v.render({ r: { ...reading, gridKw: 0, gridStatus: 'Inactive' }, cloud: .9, code: 95, out: true, peakKw: 9, dt: .016, t: 4, calm: true, day: null, wx: null, pool: null, ac: null, reservePct: 20 });
    expect(badText(el)).toEqual([]);
    const R = FakeRenderer.instances[n0];
    v.dispose();
    expect(R.disposed).toBe(true);
    expect(el.querySelector('canvas')).toBeNull();
  });
  it('roof (sun mode): renders the day, takes hours and dust, and the per-panel layer', async () => {
    const { createHomeView } = await import('../../../web/src/scenes/home.js'), n0 = FakeRenderer.instances.length;
    const el = host(), d = new Date(NOW), dayStart = Date.parse(`${TODAY}T00:00:00-05:00`);
    const v = createHomeView(el, 'sun');
    const info = v.render({ r: reading, now: d, dayStart, cloud: .1, code: 0, out: false, peakKw: 9, dt: .016, t: 1, calm: false });
    v.setHours({ exp: Array(15).fill(1), act: Array(15).fill(null).map((x, i) => i < 8 ? .9 : null) });
    v.setDust(.4); v.setBars?.(true);
    v.render({ r: reading, now: d, dayStart, cloud: .5, code: 3, out: false, peakKw: 9, dt: .016, t: 2, calm: true });
    expect(info === undefined || typeof info === 'object').toBe(true);
    expect(rendersOf(n0)).toBeGreaterThan(0);
    expect(badText(el)).toEqual([]);
    v.dispose();
  });
  it('landscape: setData from history, replay, render', async () => {
    const { createLandscape } = await import('../../../web/src/scenes/landscape.js'), { landscapeData } = await import('../../../web/src/views/history.js');
    const n0 = FakeRenderer.instances.length, el = host(), tip = document.createElement('div');
    const gti = Object.fromEntries(C.daily.map(d => [d.date, 5]));
    const data = landscapeData({ gridDays: C['grid-days'], daily: C.daily, gtiByDate: gti, baselineK: 1.6, yieldK: 1.6 });
    const l = createLandscape(el, tip);
    if (data) l.setData(data);
    l.replay(); l.render(.016, false); l.render(.016, true);
    expect(rendersOf(n0)).toBeGreaterThan(0);
    expect(badText(el)).toEqual([]);
  });
  it('pool twin: set() every feature on and off, render, resize, dispose', async () => {
    const { createPoolTwin } = await import('../../../web/src/scenes/pooltwin.js'), n0 = FakeRenderer.instances.length, el = host();
    const t = createPoolTwin(el);
    t.set({ pool: true, rpm: 1750, watts: 610, poolTemp: 84, spaTemp: 90, spaSet: 100 }); t.render(.016, false);
    t.set({ pool: false, spa: true, waterfall: true, jets: true, blower: true, heater: true, lights: true, rpm: 3000, watts: 2200 }); t.render(.016, true);
    t.resize();
    expect(rendersOf(n0)).toBe(2);
    expect(badText(el)).toEqual([]);
    t.dispose();
    expect(FakeRenderer.instances[n0].disposed).toBe(true);
  });
  it('thermal twin: cooling, heating and idle frames, dispose', async () => {
    const { createThermalTwin } = await import('../../../web/src/scenes/thermaltwin.js'), n0 = FakeRenderer.instances.length, el = host();
    const t = createThermalTwin(el);
    t.set({ cooling: true, sun: .8, indoorF: 77 }); t.render(.016, false);
    t.set({ cooling: false, heating: true, sun: 0, indoorF: 68 }); t.render(.016, true);
    t.resize(); t.dispose();
    expect(FakeRenderer.instances[n0].disposed).toBe(true);
  });
  it('outage scene: resize and render along a timeline, with and without a storm', async () => {
    const { createOutageScene } = await import('../../../web/src/scenes/outage.js'), n0 = FakeRenderer.instances.length, el = host();
    el.innerHTML = '<div data-hud></div>';   // views/outage.js's card gives the scene its HUD box
    const s = createOutageScene(el, 1);
    const cur = { k: 0, soc: 64, s: 0, h: 1.2, b: 1.2, dark: false };   // views/outage.js C.cur
    s.resize?.();
    expect(() => { s.render(.016, 1, { cur, storm: false, startHour: 14, hudDirty: true }, false); s.render(.016, 2, { cur: { ...cur, k: 6 }, storm: true, startHour: 14, hudDirty: false }, false); }).not.toThrow();
    expect(rendersOf(n0)).toBeGreaterThan(0);
  });
  it('year ring card: a year of days, select, read-out text', async () => {
    const { yearRingCard, yearModel } = await import('../../../web/src/scenes/yearring.js');
    const view = document.createElement('section'); view.className = 'view on'; const scr = document.createElement('div'); scr.className = 'screen'; scr.appendChild(view); document.body.appendChild(scr);
    const mk = c => { const e = document.createElement('div'); e.className = c; view.appendChild(e); return e; };
    const el = mk('yr'); Object.defineProperty(el, 'clientWidth', { value: 393 }); Object.defineProperty(el, 'clientHeight', { value: 393 });
    const card = yearRingCard({ el, labs: mk('labs'), read: mk('read'), stats: mk('stats'), note: mk('note'), calm: () => false, highs: () => ({}), onOpen: () => {} });
    card.show(yearModel({ daily: C.daily, history: C.daily, today: TODAY, outages: C.outages ?? [] }));
    expect(badText(view)).toEqual([]);
    card.hide();
  });
  it('flows (Where every kWh went): mount a /api/flows answer, then dispose', async () => {
    const { createFlowsCard, mountFlows } = await import('../../../web/src/scenes/flows.js');
    const card = createFlowsCard(); document.body.appendChild(card);
    const el = card.querySelector('.flow3d'); Object.defineProperty(el, 'clientWidth', { value: 393 }); Object.defineProperty(el, 'clientHeight', { value: 300 });
    const v = mountFlows(card, C.flows, { title: 'Today', today: TODAY, calm: () => false, sel: null });
    expect(card.querySelector('.kv').textContent).toContain('Solar made');
    expect(badText(card)).toEqual([]);
    v.dispose();
    expect(v.alive()).toBe(false);
  });
  it('48-hour road: built when WebGL2 is reported, refresh with a road model, dispose', async () => {
    const proto = HTMLCanvasElement.prototype, gc = proto.getContext;
    proto.getContext = function (t) { return t === 'webgl2' ? { getExtension: () => null } : gc.call(this, t); };
    const { createRoad48, webgl2 } = await import('../../../web/src/scenes/road48.js'), { roadModel } = await import('../../../web/src/lib/road48data.js'), { forecast48 } = await import('../../../web/src/lib/model.js');
    const { weatherFixtures } = await import('./fixtures-core.js'), w = weatherFixtures(NOW).forecast;
    expect(webgl2()).toBe(true);
    const fc = forecast48({ w, startDate: TODAY, startHour: 14, soc0: .64, yieldK: 1.6, profile: Array(24).fill(1.5), capKwh: 27, maxKw: 10, reservePct: 20, dayScale: {}, correction: null });
    const el = host(); el.innerHTML = '<div class="hud"></div>'; const tip = document.createElement('div'); tip.innerHTML = '<span class="ph">…</span>';
    const when = t => t;
    const road = createRoad48(el, tip, { model: () => roadModel({ fc, w, when, soc0: .64, capKwh: 27, maxKw: 10, reservePct: 20, pool: A['appliances/pool'], ac: A['appliances/ac'] }), calm: () => false });
    expect(() => road.refresh()).not.toThrow();
    expect(badText(el)).toEqual([]);
    road.dispose();
    proto.getContext = gc;
  });
});
