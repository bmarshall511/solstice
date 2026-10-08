// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Settings booted for real: Connections (Data health folded in, with the I-16 "History back to …" row, complete or filling),
// Your system, Alerts (Push to this device and five groups: a group's switch, "N of M on", its switches in place, Strip heat in
// Comfort & pool with its NEW badge from the day it shipped), Sharing (owner devices, Sign out this device: tap to arm, tap again),
// Calm mode and All data. Every write here is a settings or auth route, mocked.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { bootApp, $, click, flush, until, sheetEl, sheetOpen, footBtn, badText, smallTargets, hardColours, NOW, TODAY } from './harness.js';
import { ownerRoutes, external } from './routes.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

let S, f, settings;
beforeAll(async () => {
  ({ S, f } = await bootApp(ownerRoutes(), external()));
  settings = await import('../../../web/src/views/settings.js');
  click(document.querySelector('.c-tab[data-v="v-set"]')); await flush();
  await until(() => S.status, 3000, '/api/status');
});
afterAll(() => vi.useRealTimers());
const writes = n => f.writes(n).filter(c => c.path !== 'sync');
const rowTitled = (root, t) => [...root.querySelectorAll('.c-sys')].find(r => r.querySelector('.c-sys-top b')?.textContent === t);

describe('Connections', () => {
  it('one row per service with its age and badge; PEC bills and All data open', () => {
    const c = $('connCard');
    for (const t of ['Tesla Fleet API', 'Open-Meteo', 'Pentair ScreenLogic', 'Google Nest', 'ERCOT grid status', 'PEC bills', 'All data']) expect(rowTitled(c, t), t).toBeTruthy();
    expect(rowTitled(c, 'Tesla Fleet API').querySelector('.c-sys-l').textContent).toMatch(/^live \d+ s · history \d+ min · backups ok · \d+ days stored$/);
    expect(rowTitled(c, 'Google Nest').querySelector('a.c-btn').textContent).toBe('Relink');
    expect(rowTitled(c, 'Open-Meteo').textContent).toContain('00000 · tilt 27° · facing 244°');
    expect(badText(c)).toEqual([]); expect(hardColours(c)).toEqual([]); expect(smallTargets(c)).toEqual([]);
  });
  it('History back to … (I-16): "complete" once the back-fill is done', () => {
    const r = [...$('connCard').querySelectorAll('.c-sys')].find(x => /^History back to /.test(x.querySelector('b').textContent));
    expect(r.querySelector('b').textContent).toBe('History back to Jun 2020');
    expect(r.querySelector('.c-sys-l').textContent).toBe('complete');
    expect(r.querySelector('.c-badge').textContent).toBe('Complete');
  });
  it('… and "N of M days" with a progress bar while it fills', () => {
    const keep = S.status;
    S.status = { ...keep, backfill: { ...keep.backfill, deep: { ...keep.backfill.deep, daysDone: 612, daysTotal: 1668, done: false } } };
    settings.drawConnections(S);
    const r = [...$('connCard').querySelectorAll('.c-sys')].find(x => /^History back to /.test(x.querySelector('b').textContent));
    expect(r.querySelector('.c-sys-l').textContent).toBe('612 of 1,668 days');
    expect(r.querySelector('.c-bar i').getAttribute('style')).toBe('width:37%');
    expect(r.querySelector('.c-badge').textContent).toBe('Filling');
    S.status = { ...keep, backfill: { daysDone: 10 } };   // no deep back-fill (a guest's status): no row
    settings.drawConnections(S);
    expect([...$('connCard').querySelectorAll('b')].some(b => /^History back to /.test(b.textContent))).toBe(false);
    S.status = keep; settings.drawConnections(S);
  });
  it('All data opens the raw reading and site_info', async () => {
    click($('openData')); await until(() => sheetEl().querySelectorAll('.raw').length === 2, 2000, 'All data');
    expect(sheetEl().querySelector('.raw').textContent).toContain('"soc"');
    expect(badText(sheetEl())).toEqual([]);
    click(footBtn('pri')); expect(sheetOpen()).toBe(false);
  });
});

describe('Your system', () => {
  it('a key-value list: capacity, batteries, solar, panels, the bill’s rates', () => {
    const t = $('sysGroup').textContent;
    expect(t).toContain('27 kWh · 10 kW'); expect(t).toContain('2 × Powerwall 2'); expect(t).toContain('30 × 320 W');
    expect(t).toMatch(/Rate, all-in\$0\.\d+\/kWh/);
    expect($('reserveVal').textContent).toBe('20%');
    expect(badText($('sysGroup'))).toEqual([]);
  });
});

describe('Alerts', () => {
  const group = id => $('alertPrefs').querySelector(`[data-group="${id}"]`);
  it('five groups with "N of M on"; Comfort & pool holds Strip heat', () => {
    expect([...$('alertPrefs').querySelectorAll('[data-group]')].map(g => g.dataset.group)).toEqual(['power', 'solar', 'comfort', 'away', 'reports']);
    expect(group('comfort').querySelector('.c-sys-l').textContent).toBe('4 of 4 on');
    expect(group('reports').querySelector('.c-sys-l').textContent).toBe('3 of 4 on');   // baseline is off in the settings fixture
    expect(group('comfort').nextElementSibling.hidden).toBe(true);
    click(group('comfort'));
    const inner = group('comfort').nextElementSibling;
    expect(inner.hidden).toBe(false);
    expect([...inner.querySelectorAll('[data-pref]')].map(x => x.dataset.pref)).toEqual(['approval', 'poolTest', 'anomaly', 'strip']);
    expect(inner.querySelector('[data-pref="strip"]').textContent).toContain('Strip heat');
    expect(badText($('alertPrefs'))).toEqual([]); expect(smallTargets($('alertPrefs'))).toEqual([]); expect(hardColours($('alertPrefs'))).toEqual([]);
  });
  it('the Strip heat switch turns that one alert off: PUT settings with alerts.strip = false', async () => {
    const n = f.calls.length;
    click($('alertPrefs').querySelector('[data-pref="strip"]')); await flush();
    const w = writes(n);
    expect(w).toEqual([expect.objectContaining({ method: 'PUT', path: 'settings' })]);
    expect(w[0].body.alerts).toMatchObject({ strip: false, baseline: false });
    expect(group('comfort').querySelector('.c-sys-l').textContent).toMatch(/^3 of 4 on/);
    expect($('alertPrefs').querySelector('[data-pref="strip"]').getAttribute('aria-checked')).toBe('false');
  });
  it('a group’s switch sets the whole group (on → all off; off → all on)', async () => {
    const n = f.calls.length;
    click($('alertPrefs').querySelector('[data-gsw="comfort"]')); await flush();
    expect(writes(n)[0].body.alerts).toMatchObject({ approval: false, poolTest: false, anomaly: false, strip: false });
    click($('alertPrefs').querySelector('[data-gsw="comfort"]')); await flush();
    expect(writes(n)[1].body.alerts).toMatchObject({ approval: true, poolTest: true, anomaly: true, strip: true });
  });
  it('Strip heat’s NEW badge shows from the day it shipped (Oct 8) for 14 days, and on its group', () => {
    const { applyAlertPrefs } = settings;
    const strip = () => $('alertPrefs').querySelector('[data-pref="strip"]');
    applyAlertPrefs({});
    expect(strip().querySelector('.c-badge')).toBeNull();   // Oct 7: not yet (the group shows NEW for Time to test the pool)
    vi.setSystemTime(Date.parse('2026-10-08T09:00:00-05:00')); applyAlertPrefs({});
    expect(strip().querySelector('.c-badge')?.textContent).toMatch(/new/i);
    expect(group('comfort').querySelector('.c-badge')?.textContent).toMatch(/new/i);
    vi.setSystemTime(Date.parse('2026-10-22T09:00:00-05:00')); applyAlertPrefs({});
    expect(strip().querySelector('.c-badge')).toBeNull();   // day 14: gone
    expect(group('comfort').querySelector('.c-badge')).toBeNull();
    vi.setSystemTime(NOW);
  });
});

describe('Sharing: owner devices and Sign out this device', () => {
  const close = () => $('phone').classList.remove('open');
  it('the Sharing rows carry the counts', async () => {
    await until(() => /device/.test($('devN').textContent), 2000, 'the device count');
    expect($('devN').textContent).toBe('Owner on 2 devices');
    expect($('nameVal').textContent).toBe('Test Owner');
  });
  it('Owner devices: this device first, the other with its own Sign out (one POST for that device)', async () => {
    click($('devRow')); await until(() => sheetEl().querySelector('#devSelf'), 2000, 'the devices sheet');
    expect(sheetEl().querySelector('h4').textContent).toBe('Owner devices');
    expect(sheetEl().textContent).toContain('This iPhone');
    expect(footBtn('sec').textContent).toBe('Sign out other devices');
    expect(badText(sheetEl())).toEqual([]); expect(smallTargets(sheetEl())).toEqual([]); expect(hardColours(sheetEl())).toEqual([]);
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-dev="d4e5f6"]')); await flush();
    expect(writes(n)).toEqual([expect.objectContaining({ method: 'POST', path: 'auth/devices/d4e5f6/signout' })]);
  });
  it('Sign out other devices asks first', async () => {
    const n = f.calls.length;
    confirm.mockImplementation(() => false);
    click(footBtn('sec')); await flush();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Sign out 1 other device?'));
    expect(writes(n)).toEqual([]);
    confirm.mockImplementation(() => true);
  });
  it('Sign out this device: the first tap only arms it; the second POSTs auth/signout and reloads to the locked card', async () => {
    const replace = vi.fn();
    try { Object.defineProperty(location, 'replace', { value: replace, configurable: true, writable: true }); } catch { location.replace = replace; }
    const n = f.calls.length, btn = $('devSelf');
    click(btn);
    expect(btn.textContent).toBe('Tap again to sign out');
    expect(writes(n)).toEqual([]);
    click(btn); await flush();
    expect(writes(n)).toEqual([expect.objectContaining({ method: 'POST', path: 'auth/signout' })]);
    expect(replace).toHaveBeenCalledWith('/');
    close();
  });
});

describe('Calm mode', () => {
  it('the switch stills the veils at once and saves calm for the owner', async () => {
    const n = f.calls.length, was = S.calm;
    click($('calmSw')); await flush();
    expect(document.documentElement.hasAttribute('data-calm')).toBe(!was);
    expect(writes(n)).toEqual([expect.objectContaining({ method: 'PUT', path: 'settings', body: { calm: !was } })]);
    click($('calmSw')); await flush();
  });
});

describe('form', () => {
  it('Settings has no undefined/NaN/null/[object Object] text', () => {
    expect(badText($('v-set'))).toEqual([]);
  });
});
