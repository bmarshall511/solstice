// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Guest mode (a share link), booted for real against the server's own guest views (server/src/redact.ts GUEST_GET applied to the
// owner fixtures; every other route answers 401 as access.ts does). A guest walks every tab, segment and History range, and:
// the owner-only cards and controls are hidden (html[data-role=guest] with the stylesheet's guest rules), no owner-only route is
// ever asked for, nothing is written, and no dollar figure or "undefined"/"NaN" reaches the page.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { bootApp, $, click, flush, until, sheetEl, sheetOpen, badText, NOW } from './harness.js';
import { guestRoutes, external } from './routes.js';
import { OWNER_ONLY } from './fixtures-core.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

/* the stylesheet's guest rules: `html[data-role=guest] <sel>{…display:none…}` */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../web/src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const GUEST_HIDE = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter(m => /display:\s*none/.test(m[2])).flatMap(m => m[1].split(/,(?![^(]*\))/))
  .map(s => s.trim()).filter(s => s.startsWith('html[data-role=guest] ')).map(s => s.slice('html[data-role=guest] '.length))
  .flatMap(s => { const is = /^:is\((.*)\)$/.exec(s); return is ? is[1].split(',').map(x => x.trim()) : [s]; });
/** Hidden for a guest: the element or an ancestor has [hidden], or matches one of the stylesheet's guest rules. */
const guestHidden = el => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { if (e.hidden) return true; if (GUEST_HIDE.some(s => { try { return e.matches(s); } catch { return false; } })) return true; } return false; };

let S, f, allowed;
beforeAll(async () => {
  const routes = await guestRoutes();
  allowed = new Set(Object.keys(routes).filter(k => !k.startsWith('__')));
  ({ S, f } = await bootApp(routes, external()));
  // walk everything a guest can open, so every lazy load has had its chance
  for (const v of ['v-sys', 'v-hist', 'v-set', 'v-now']) { click(document.querySelector(`.c-tab[data-v="${v}"]`)); await flush(6);
    if (v === 'v-sys') for (const s of ['solar', 'powerwall', 'pool', 'ac', 'home']) { click($('sysSeg').querySelector(`[data-seg="${s}"]`)); await flush(6); }
    if (v === 'v-hist') { click($('dayPrev')); await flush(10); for (const r of ['week', 'month', 'year', 'day']) { click($('hseg').querySelector(`[data-r="${r}"]`)); await flush(10); } }
  }
});
afterAll(() => vi.useRealTimers());

describe('guest mode', () => {
  it('the page is in the guest role, with the guest pill and the owner’s name', () => {
    expect(S.guest).toBe(true);
    expect(document.documentElement.dataset.role).toBe('guest');
    expect($('chipGuest').textContent).toContain('Shared by');
    expect($('siteLine').textContent).toBe('Test Owner’s home'.replace('’', "'"));
  });
  it('asks only for routes with a guest view, and writes nothing', () => {
    const asked = new Set(f.calls.map(c => c.path));
    expect([...asked].filter(p => !allowed.has(p))).toEqual([]);
    for (const p of OWNER_ONLY) expect(asked.has(p), p).toBe(false);
    for (const p of ['appliances/day', 'appliances/ac/strip', 'loads', 'vacation', 'powerwall/rules', 'flows', 'breakdown']) expect(asked.has(p), p).toBe(false);
    expect(f.writes()).toEqual([]);
    expect(f.unknown).toEqual([]);
  });
  it('owner-only cards and controls are hidden', () => {
    for (const id of ['hub', 'banSlot', 'vacPill', 'egCard', 'ldCard', 'sysPoolCtl', 'acTstat', 'acStrip', 'sysRules', 'alertPrefs', 'openData', 'chgBuy', 'flowSum', 'billDue', 'pwCard', 'sysOutage'].filter(id => $(id)))
      expect(guestHidden($(id)), id).toBe(true);
    expect(guestHidden($('chipGuest'))).toBe(false);
    expect(guestHidden($('statusPill'))).toBe(false);
  });
  it('no visible control on any page is a write: every visible button belongs to navigation, segments, disclosures or the guest’s own device', () => {
    const visible = [...document.querySelectorAll('#screen button, #screen [role=button], #screen [role=switch]')].filter(b => !guestHidden(b));
    const writes = visible.filter(b => /\b(Apply|Save|Restore|Remove|Sign out|Start|Turn off|Link|Relink|Set )/.test(b.textContent) && !b.closest('[data-guest]'));
    expect(writes.map(b => `${b.id || b.className}: ${b.textContent.trim().slice(0, 40)}`)).toEqual([]);
  });
  it('no dollar figure and no undefined/NaN/null text reaches the page', () => {
    const shown = [...document.querySelectorAll('#screen *')].filter(e => !e.children.length && !guestHidden(e)).map(e => e.textContent).join(' ');
    expect(shown).not.toMatch(/\$\s?\d/);
    expect(badText($('screen'))).toEqual([]);
  });
  it('the Conditions sheet leaves out Outage readiness for a guest', () => {
    click($('statusPill'));
    expect(sheetOpen()).toBe(true);
    expect($('cdOutage')).toBeNull();
    expect($('cdConn')).not.toBeNull();
    expect(badText(sheetEl())).toEqual([]);
    $('phone').classList.remove('open');
  });
  it('History › a past day: the guest’s What changed (Used only, no segment, no fine print); no Bought from PEC', async () => {
    click(document.querySelector('.c-tab[data-v="v-hist"]')); await flush();
    click($('dayPrev')); await until(() => !$('chgCard').hidden, 10_000, 'the guest What changed');
    const c = $('chgCard');
    expect(c.querySelector('[data-c]')).toBeNull();
    expect(c.querySelector('.c-fine')).toBeNull();
    expect([...c.querySelectorAll('.c-wf-r:not(.c-wf-tot) .c-wf-l')].map(x => x.firstChild.textContent)).toEqual(['Weather', 'Pool', 'Everything else']);
    expect(c.querySelector('.c-sum').textContent).toBe('Mostly the heat.');
    expect($('chgBuy').hidden).toBe(true);
    click($('dayNext')); await flush();
  });
});
