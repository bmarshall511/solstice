// DOM test harness (happy-dom): the app's real markup, a routed fetch with synthetic payloads, a 2D-canvas stub, a manual
// requestAnimationFrame, and the form checks every rendered card and sheet goes through (no "undefined"/"NaN"/"null"/
// "[object Object]" text, 44 px touch targets from style.css, no hard-coded colours in inline styles).
// Nothing here talks to the network: an /api route without a fixture, or any other URL, is recorded and fails the test.
import { vi, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');   // not new URL(): happy-dom replaces URL
const read = p => readFileSync(join(ROOT, p), 'utf8');
// booting the whole app takes a second or two, more when the full suite runs files in parallel
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

/** 2:30 PM Chicago on a Wednesday in October (CDT, UTC−5). */
export const NOW = Date.parse('2026-10-07T14:30:00-05:00');
export const TODAY = '2026-10-07';

/* ---------------- the page ---------------- */
const INDEX = read('web/index.html');
const BODY = INDEX.slice(INDEX.indexOf('<body>') + 6, INDEX.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '');
/** web/index.html's body (without the module script) as the document. */
export function loadIndex() { document.body.innerHTML = BODY; document.documentElement.removeAttribute('data-role'); }

/* ---------------- browser stubs ---------------- */
/** A canvas 2D context whose every method is a no-op (gradients and measureText return usable objects). */
function ctx2d(canvas) {
  const grad = { addColorStop() {} };
  const base = { canvas, createLinearGradient: () => grad, createRadialGradient: () => grad, createConicGradient: () => grad, createPattern: () => null,
    measureText: t => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }), getTransform: () => ({ a: 1, d: 1 }), isPointInPath: () => false };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
}
export const frames = [];
/** Install everything happy-dom lacks for the app: canvas 2D, rAF under test control, dialogs, observers. */
export function stubBrowser() {
  // happy-dom queues a class mutation for toggle(token, force) even when force already matches; the DOM spec (and browsers) don't.
  // main.js's a11y observer toggles #sheet's is-c with a force on every class mutation, so without this it never settles.
  const tl = Object.getPrototypeOf(document.documentElement.classList), toggle = tl.toggle;
  tl.toggle = function (token, force) { if (force !== undefined && this.contains(token) === !!force) return !!force; return toggle.call(this, token, force); };
  const proto = globalThis.HTMLCanvasElement.prototype;
  proto.getContext = function (type) { if (type === '2d') return (this.__ctx ??= ctx2d(this)); return null; };   // no WebGL: three.js is mocked (fakegl.js)
  proto.toDataURL = () => 'data:image/png;base64,';
  vi.stubGlobal('requestAnimationFrame', fn => { frames.push(fn); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
  class Obs { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  vi.stubGlobal('ResizeObserver', Obs);
  // an observed element intersects once it is displayed (see `displayed`), so cards that build their scene when scrolled near (year
  // ring, outage) build; intersectVisible() re-checks after a tab or segment change, as scrolling a page into view would
  class IO extends Obs { constructor(cb) { super(cb); this.seen = new Set(); ios.add(this); } observe(el) { this.el = [...(this.el ?? []), el]; queueMicrotask(() => this.check()); }
    check() { for (const el of this.el ?? []) if (!this.seen.has(el) && displayed(el)) { this.seen.add(el); this.cb([{ isIntersecting: true, intersectionRatio: 1, target: el }], this); } }
    disconnect() { this.el = []; } }
  vi.stubGlobal('IntersectionObserver', IO);
  // no layout in happy-dom: offsetParent (the app's "is it on screen" test) follows the same display rules
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return displayed(this) ? this.parentElement : null; } });
  if (!globalThis.matchMedia) vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  try { localStorage.clear(); } catch { /* none */ }
}
const ios = new Set();
/**
 * Whether the stylesheet would display `el`: no [hidden] ancestor, every .view and .sys-page around it the open one, and no
 * [data-owner] around it while the page is a guest's (html[data-role=guest] / [data-as=guest], style.css's guest rule).
 */
export function displayed(el) {
  const guest = !!document.documentElement.dataset.role || document.documentElement.dataset.as === 'guest';
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    if (e.hidden || (e.classList.contains('view') && !e.classList.contains('on')) || (guest && e.hasAttribute('data-owner'))) return false;
  }
  return el.isConnected;
}
/** Fire the IntersectionObservers for elements that are now displayed. */
export const intersectVisible = () => ios.forEach(o => o.check());
/** Run the queued animation frames once (each re-queues itself). */
export function runFrames(n = 1, t = 16) { for (let i = 0; i < n; i++) { const q = frames.splice(0); for (const f of q) f(performance.now() + t * (i + 1)); } }

/* ---------------- fetch ---------------- */
/**
 * A fetch stub. `routes` maps an /api path (query stripped) to a payload, or to a function (req) → payload | Response-like.
 * `external` handles non-/api URLs ({forecast, archive, nws} payloads for Open-Meteo and NWS). Every call is in `.calls`.
 */
export function router(routes, external = {}) {
  const calls = [], unknown = [];
  const res = (status, j) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(j) });
  const fn = vi.fn(async (input, init = {}) => {
    const u = String(input), method = (init.method ?? 'GET').toUpperCase();
    if (u.startsWith('/api/')) {
      const [p, qs] = u.slice(5).split('?'), body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null;
      const req = { method, path: p, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body };
      calls.push(req);
      const key = method === 'GET' ? p : `${method} ${p}`;
      let h = routes[key];
      if (h === undefined && method !== 'GET') h = routes[`* ${p}`] ?? { ok: true };   // writes answer {ok:true} unless a test says otherwise
      if (h === undefined && routes.__fallback) return res(routes.__fallback, { error: 'Sign in required' });   // the guest gate: no guest view → 401
      if (h === undefined) { unknown.push(key); return res(404, { error: `no fixture for ${key}` }); }
      const v = typeof h === 'function' ? await h(req) : h;
      if (v && v.__status) return res(v.__status, v.body ?? {});
      return res(200, v);
    }
    if (/open-meteo\.com\/v1\/forecast/.test(u) && external.forecast) return res(200, external.forecast);
    if (/archive-api\.open-meteo\.com/.test(u) && external.archive) return res(200, external.archive);
    if (/api\.weather\.gov\/alerts/.test(u) && external.nws) return res(200, external.nws);
    unknown.push(u.split('?')[0]);
    throw new Error(`unmocked fetch in test: ${u.split('?')[0]}`);
  });
  fn.calls = calls; fn.unknown = unknown;
  /** The calls that are not GETs (the writes), optionally only those since index `from`. */
  fn.writes = (from = 0) => calls.slice(from).filter(c => c.method !== 'GET');
  return fn;
}
/** Let pending promises and zero-delay timers run. */
export async function flush(n = 6) { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); }
/** Wait (real time) until `pred()` holds, or fail. */
export async function until(pred, ms = 10_000, what = 'condition') {
  const t0 = Date.now(); for (;;) { if (pred()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 10)); }
}

/* ---------------- interaction ---------------- */
export const $ = id => document.getElementById(id);
export const click = el => { if (!el) throw new Error('click: no element'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); intersectVisible(); };
export const sheetEl = () => $('sheetBody');
export const sheetOpen = () => $('phone').classList.contains('open');
export const footBtn = which => sheetEl().querySelector(`.c-sheet-f [data-f="${which}"]`);
/** The button (or role=button) whose text contains `text`, inside `root`. */
export function byText(root, text, sel = 'button,[role=button],[role=switch]') {
  const el = [...root.querySelectorAll(sel)].find(b => b.textContent.replace(/\s+/g, ' ').includes(text));
  if (!el) throw new Error(`no control with text "${text}" in ${root.id || root.className}`);
  return el;
}

/* ---------------- form checks ---------------- */
const BAD = /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]|\bInfinity\b/;
/** Every text node and attribute value under `root` that reads undefined, NaN, null, Infinity or [object Object]. */
export function badText(root) {
  const out = [], w = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (BAD.test(n.textContent)) out.push(`text: ${n.textContent.trim().slice(0, 120)}`);
  for (const el of root.querySelectorAll('*')) for (const a of el.attributes) if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(a.value)) out.push(`<${el.tagName.toLowerCase()} ${a.name}="${a.value.slice(0, 80)}">`);
  return out;
}
export const expectCleanText = (root, label = '') => expect(badText(root), `${label} bad text`).toEqual([]);

const CSS = read('web/src/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const RULES = [...CSS.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ sels: m[1].split(',').map(s => s.trim()).filter(Boolean), body: m[2] }));
const px = (body, prop) => { const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(body); return m ? +m[1] : null; };
/** The largest min-height/height any style.css rule matching `el` gives it (pseudo-class and pseudo-element selectors skipped). */
export function cssTarget(el) {
  let h = 0, w = 0;
  for (const r of RULES) for (const s of r.sels) {
    if (/::|:hover|:active|:focus|:not\(|:has\(|:where|:is\(|@/.test(s)) continue;
    let ok = false; try { ok = el.matches(s); } catch { ok = false; }
    if (!ok) continue;
    for (const v of [px(r.body, 'min-height'), px(r.body, 'height')]) if (v != null) h = Math.max(h, v);
    for (const v of [px(r.body, 'min-width'), px(r.body, 'width')]) if (v != null) w = Math.max(w, v);
  }
  return { h, w };
}
/** A rule matching `el` makes it fill its parent (an invisible input laid over a date card). */
const fillsParent = el => RULES.some(r => /(?:^|;)\s*(inset:\s*0|height:\s*100%)/.test(r.body) && r.sels.some(s => { try { return !/::|:hover|:active|:focus/.test(s) && el.matches(s); } catch { return false; } }));
/**
 * A control's touch height from the stylesheet: its own min-height/height; else that of a child it wraps (the round toggle's 56 px
 * disc); else, when it is laid over its parent (inset: 0 / height: 100%), the parent's.
 */
export function touchHeight(el) {
  let { h } = cssTarget(el);
  if (h < 44) for (const c of el.children) h = Math.max(h, cssTarget(c).h);
  if (h < 44 && el.parentElement && fillsParent(el)) h = Math.max(h, cssTarget(el.parentElement).h);
  return h;
}
/** Every interactive control under `root` (buttons, role=button/switch, inputs) whose stylesheet height is under 44 px. */
export function smallTargets(root) {
  const out = [];
  for (const el of root.querySelectorAll('button,[role=button],[role=switch],input:not([type=hidden]),select,textarea')) {
    if (el.closest('[hidden]')) continue;
    const h = touchHeight(el);
    if (h < 44) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${el.parentElement ? ` in .${[...el.parentElement.classList].join('.')}` : ''} → ${h}px`);
  }
  return out;
}
const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
/** Inline style attributes under `root` that hard-code a colour instead of a token (var(--…)). */
export function hardColours(root, { except = [] } = {}) {
  return [...root.querySelectorAll('[style]')].filter(el => !except.some(sel => el.matches(sel))).map(el => el.getAttribute('style')).filter(s => COLOUR.test(s.replace(/var\([^)]*\)/g, '')));
}
/**
 * Markup that predates the token rule and still hard-codes colours, as approved in its mockup. Listed here so the checks keep
 * catching anything new; each is reported (not changed: a colour change is a visual change and needs the owner's approval).
 *  - the Comfort sheet's "hot, sunny day" band (views/ac.js DAYC, mockup ag): four hex colours, no matching tokens in style.css
 */
export const KNOWN_COLOURS = ['#cmDay > *'];
/**
 * The sheets still on the pre-component shell (.shead / .x / .primary): AC "Too warm/Too cold" (openNudge) and "Your changes",
 * Pool "Your changes" and Clear-up, Add a PEC bill, the weekly digest, Water · last 30 days, the trip report. Their close button
 * (.sheet .x) is 32 × 32 px, under the 44 px rule; .ag-opt and .primary get their height from padding (about 46 px) rather than a
 * min-height. What the check reports for them, so a migration (which needs an approved mockup) shows up as a change here.
 */
export const LEGACY_SMALL = { nudge: ['button.x in .shead → 32px', 'button.ag-opt in . → 0px', 'button.ag-opt.pick in . → 0px', 'button.primary in . → 0px'] };
/** All three form checks on a rendered region. */
export function expectForm(root, label = '', { colours = true, targets = true } = {}) {
  expectCleanText(root, label);
  if (targets) expect(smallTargets(root), `${label} touch targets under 44 px`).toEqual([]);
  if (colours) expect(hardColours(root), `${label} hard-coded colours`).toEqual([]);
}

/* ---------------- booting the app ---------------- */
/**
 * Boot web/src/main.js against `routes` (and the weather payloads in `external`), as the module script would in a browser.
 * The test file must mock 'three' (fakegl.js) and views/nowhub.js's initNowTop so that it keeps the app's state on
 * globalThis.__S (the two vi.mock lines every *.dom.test.js that boots the app starts with). Returns { S, f } once the first
 * loads have been drawn.
 */
export async function bootApp(routes, external = {}, { wait = true } = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  loadIndex(); stubBrowser();
  const f = router(routes, external);
  vi.stubGlobal('fetch', f);
  await import('../../../web/src/main.js');
  const S = globalThis.__S;
  if (!S) throw new Error('bootApp: the test file must mock views/nowhub.js initNowTop to capture S');
  if (wait) await until(() => S.now && S.live && S.daily && S.wx && S.pool && S.ac, 20_000, 'the first loads');
  if (wait) await until(() => document.getElementById('greet').textContent !== 'Hello', 10_000, 'the first per-second render');   // main.js's 1 s loop
  await flush(10);
  return { S, f };
}
/** Writes other than the owner device's background history sync (POST /api/sync runs at boot and every 5 minutes). */
export const sheetWrites = (f, from = 0) => f.writes(from).filter(c => c.path !== 'sync');
