// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Now, booted for real (web/src/main.js in happy-dom, every /api route answered with synthetic payloads): the greeting and story,
// the Status and Vacation pills, the banner slot's priority (outage › vacation › hold › pool › Powerwall › bill › digest ›
// I-18's morning "What changed" line), the Autopilot hub, the Today tiles, the Conditions sheet, Ahead and the Powerwall
// disclosure. Form as well as function: no undefined/NaN/null text, 44 px controls, no hard-coded colours in the new markup.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { bootApp, $, click, flush, sheetEl, sheetOpen, footBtn, badText, expectCleanText, smallTargets, hardColours, sheetWrites, NOW, TODAY } from './harness.js';
import { ownerRoutes, external } from './routes.js';
import { changedClean, changedNotClean } from './fixtures-core.js';
import { acHold, poolClearUp, vacationAway } from './fixtures-appl.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

let S, f, changedNow = null;   // what /api/changed answers (null: the clean fixture for the asked date)
beforeAll(async () => { ({ S, f } = await bootApp(ownerRoutes({ changed: req => changedNow ?? { ...changedClean(NOW), date: req.query.date, to: req.query.date } }), external())); });
afterAll(() => vi.useRealTimers());
const slot = () => $('banSlot').querySelector('.c-ban');

describe('Now after boot (owner)', () => {
  it('asks only for routes that have fixtures, and reaches no network', () => {
    expect(f.unknown).toEqual([]);
    for (const p of ['now', 'daily', 'appliances/pool', 'appliances/ac', 'powerwall/rules', 'vacation', 'settings']) expect(f.calls.some(c => c.path === p), p).toBe(true);
  });
  it('greets for the time of day and tells the story of the live reading', () => {
    expect($('greet').textContent).toBe('Good afternoon');
    expect($('soc').textContent).toBe(String(Math.round(S.live.soc)));
    expect($('story').textContent.length).toBeGreaterThan(20);
    expect($('story').querySelector('.c-skel')).toBeNull();
    expect($('battline').textContent).not.toBe('');
  });
  it('the Status pill shows the NWS advisory in amber; the Vacation pill offers a trip', () => {
    expect($('statusTxt').textContent).toContain(S.nws[0].event);
    expect($('statusPill').className).toContain('warn');
    expect($('vacPill').hidden).toBe(false);
    expect($('vacPillT').textContent).toBe('Plan a trip');
  });
  it('the hub: Pool, AC, Powerwalls and Away rows with live values and their mode pills', () => {
    const rows = [...$('hubRows').querySelectorAll('[data-sheet]')];
    expect(rows.map(r => r.dataset.sheet)).toEqual(['pool', 'ac', 'pw', 'away']);
    const [pool, ac, pw, away] = rows;
    expect(pool.querySelector('.c-sys-v').textContent).toBe(S.pool.live.running ? `${S.pool.live.rpm.toLocaleString()} rpm` : 'off');
    expect(pool.querySelector('.c-mode').textContent).toBe('Auto');
    expect(ac.querySelector('.c-sys-v').textContent).toBe(`${Math.round(S.ac.state.coolF)}°`);
    expect(pw.querySelector('.c-sys-v').textContent).toBe(`${Math.round(S.live.soc)}%`);
    expect(away.querySelector('.c-mode').textContent).toBe('Home');
    expect(away.querySelector('.c-sys-l').textContent).toBe('No trip planned');
    expect($('hubFig').textContent).toMatch(/Auto/);
    for (const r of rows) expect(r.querySelector('.c-plan'), r.dataset.sheet).not.toBeNull();
  });
  it('the Today tiles carry today’s kWh, a delta against yesterday and a sparkline', () => {
    const t = S.now.today;
    expect($('tileSol').querySelector('.c-tile-v b').textContent).toBe((Math.round(t.solar * 10) / 10).toFixed(1));
    expect($('tileHome').querySelector('.c-tile-v b').textContent).toBe((Math.round(t.home * 10) / 10).toFixed(1));
    for (const id of ['tileSol', 'tileHome', 'tileImp', 'tileExp']) {
      expect($(id).querySelector('svg.c-spark'), id).not.toBeNull();
      expect($(id).querySelector('.c-delta'), id).not.toBeNull();
    }
    expect($('tileImp').textContent).toMatch(/≈ \$\d+\.\d\d at PEC rates/);   // the owner sees the bill's rate
  });
  it('the Powerwall disclosure opens and shows the charge, reserve and time figures', () => {
    expect($('pwBody').hidden).toBe(true);
    click($('pwDiscH'));
    expect($('pwBody').hidden).toBe(false);
    expect($('pwDiscH').getAttribute('aria-expanded')).toBe('true');
    expect($('pwPct').textContent).toBe(`${Math.round(S.live.soc)}%`);
    expect($('pwRes').textContent).toBe(`${S.now.site.reservePct}%`);
    expect($('pwUnits').children).toHaveLength(2);
    expectCleanText($('pwDisc'), 'Powerwall disclosure');
  });
  it('Ahead: the 12-hour strip has 12 hours; 48 h shows the SVG fallback without WebGL2', () => {
    expect($('wx12').children.length).toBeGreaterThan(0);
    expect($('wx12').children.length).toBeLessThanOrEqual(12);
    expect($('fcTxt').textContent).toMatch(/kWh/);
    click($('aheadSeg').querySelector('[data-a="48"]'));
    expect($('ah48').hidden).toBe(false); expect($('ah12').hidden).toBe(true);
    expect($('fc48').innerHTML).toContain('<path');
    click($('aheadSeg').querySelector('[data-a="12"]'));
    expect($('ah12').hidden).toBe(false);
  });
  it('form: Now has no undefined/NaN/null/[object Object] text', () => {
    expect(badText($('v-now'))).toEqual([]);
  });
  it('form: the hub and banner slot use tokens, not hard-coded colours, and their controls are 44 px', () => {
    expect(hardColours($('hubRows'))).toEqual([]);
    expect(hardColours($('banSlot'))).toEqual([]);
    expect(smallTargets($('hubRows'))).toEqual([]);
    expect(smallTargets($('banSlot'))).toEqual([]);
  });
});

describe('the banner slot: one banner, by priority', () => {
  const keep = {};
  beforeAll(() => { Object.assign(keep, { outageActive: S.outageActive, vac: S.vac, ac: S.ac, pool: S.pool, pwRules: S.pwRules, billDue: S.billDue }); });
  afterAll(() => { Object.assign(S, keep); S.redrawNow(); });
  it('with the fixtures: the waiting Powerwall suggestion (amber) is the banner', () => {
    expect(slot()?.className).toContain('amber');
    expect(slot().querySelector('b').textContent).toMatch(/\?$/);
    expect(slot().querySelectorAll('.c-btns button').length).toBe(2);
  });
  it('a pool Clear-up outranks it (blue), an AC hold outranks that (purple ring), a trip outranks the hold, an outage everything', () => {
    S.pool = poolClearUp(NOW); S.redrawNow();
    expect(slot().className).toContain('blue'); expect(slot().textContent).toMatch(/Clear-up · day \d of \d/);
    S.ac = acHold(NOW); S.redrawNow();
    expect(slot().className).toContain('purple'); expect(slot().querySelector('.c-ring')).not.toBeNull();
    expect(slot().textContent).toMatch(/Holding/);
    S.vac = vacationAway(NOW); S.redrawNow();
    expect(slot().className).toContain('teal');
    S.outageActive = true; S.redrawNow();
    expect(slot().className).toContain('red'); expect(slot().textContent).toMatch(/Grid outage since/);
    expect(badText($('banSlot'))).toEqual([]);
    S.outageActive = keep.outageActive; S.vac = keep.vac; S.redrawNow();
    expect(slot().className).toContain('purple');
  });
  it('the hold banner’s Resume now posts appliances/ac/hold {action: resume}', async () => {
    const n = f.calls.length;
    click(slot().querySelector('[data-b="hold:resume"]'));
    await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'appliances/ac/hold', body: { action: 'resume' } })]);
    S.ac = keep.ac; S.pool = keep.pool; S.redrawNow();
  });
  it('the bill banner (plain) shows only when nothing above it has something to say', () => {
    S.pwRules = { ...keep.pwRules, rules: keep.pwRules.rules.map(r => ({ ...r, mode: 'auto' })) };
    S.billDue = { month: 'October', period: 'Sep 9 – Oct 10' }; S.redrawNow();
    expect(slot().className).toContain('plain');
    expect(slot().textContent).toContain('Your October PEC bill should be ready');
    expect(slot().querySelector('[data-b="bill"]').getAttribute('data-addbill')).toBe('1');
    S.billDue = null; S.redrawNow();
  });
  it('the morning line (I-18): 06:00–11:00 only, yesterday’s change ≥ 2 kWh, never while the history isn’t clean; Dismiss hides it today', async () => {
    const changed = await import('../../../web/src/views/changed.js');
    // the weekly digest banner ranks above it: its Dismiss marks the digest alert read
    const dg = slot()?.querySelector('[data-b="dg-dismiss"]');
    if (dg) { const n = f.calls.length; click(dg); await flush(); expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: expect.stringMatching(/^alerts\/[^/]+\/read$/) })]); }
    const route = f.calls.length;
    vi.setSystemTime(Date.parse(`${TODAY}T08:30:00-05:00`));
    // not clean: no banner
    changedNow = changedNotClean(NOW);
    await changed.loadChanged(S); S.redrawNow();
    expect(f.calls.slice(route).filter(c => c.path === 'changed')).toEqual([expect.objectContaining({ query: { scope: 'day', date: '2026-10-06' } })]);
    changedNow = null;
    expect(slot()?.textContent ?? '').not.toMatch(/Yesterday:/);
    // clean (a new module state: reset by the hour window), 4.2 kWh more bought
    vi.setSystemTime(Date.parse(`${TODAY}T12:00:00-05:00`)); await changed.loadChanged(S);   // outside the window: forgets
    vi.setSystemTime(Date.parse(`${TODAY}T08:30:00-05:00`)); await changed.loadChanged(S); S.redrawNow();
    expect(slot().textContent).toMatch(/Yesterday: 4\.2 kWh more bought/);
    expect(slot().querySelectorAll('[data-b^="chg-"]')).toHaveLength(2);
    // Dismiss: gone until tomorrow, on this device
    click(slot().querySelector('[data-b="chg-dismiss"]'));
    expect(slot()?.textContent ?? '').not.toMatch(/Yesterday:/);
    expect(localStorage.getItem('solstice:changed:dismissed')).toBe(TODAY);
    // outside the window it never shows
    localStorage.removeItem('solstice:changed:dismissed');
    vi.setSystemTime(Date.parse(`${TODAY}T11:30:00-05:00`)); S.redrawNow();
    expect(slot()?.textContent ?? '').not.toMatch(/Yesterday:/);
    vi.setSystemTime(NOW); await changed.loadChanged(S); S.redrawNow();
  });
  it('the morning line’s Why opens History › Day for yesterday', async () => {
    const changed = await import('../../../web/src/views/changed.js');
    vi.setSystemTime(Date.parse(`${TODAY}T08:30:00-05:00`)); await changed.loadChanged(S); S.redrawNow();
    click(slot().querySelector('[data-b="chg-why"]'));
    await flush(10);
    expect($('v-hist').classList.contains('on')).toBe(true);
    expect($('dayLabel').textContent).toMatch(/^Tue, Oct 6/);
    vi.setSystemTime(NOW); await changed.loadChanged(S); S.redrawNow();
    click(document.querySelector('.c-tab[data-v="v-now"]'));
  });
});

describe('the Conditions sheet', () => {
  it('opens from the Status pill with Powerwalls, weather alerts, ERCOT, Storm Watch, Data health and links; Done closes it', () => {
    click($('statusPill'));
    expect(sheetOpen()).toBe(true);
    const b = sheetEl();
    expect(b.querySelector('h4').textContent).toBe('Conditions');
    for (const t of ['Powerwalls online', 'Weather alerts', 'ERCOT', 'Storm Watch', 'Data health', 'Outage readiness', 'Connections']) expect(b.textContent, t).toContain(t);
    expect(b.textContent).toContain(S.nws[0].event);
    expect(badText(b)).toEqual([]);
    expect(smallTargets(b)).toEqual([]);
    click(footBtn('pri'));
    expect(sheetOpen()).toBe(false);
  });
  it('Connections goes to Settings', () => {
    click($('statusPill')); click($('cdConn'));
    expect(sheetOpen()).toBe(false);
    expect($('v-set').classList.contains('on')).toBe(true);
    click(document.querySelector('.c-tab[data-v="v-now"]'));
    expect($('v-now').classList.contains('on')).toBe(true);
  });
});
