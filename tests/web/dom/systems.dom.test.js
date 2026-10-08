// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Systems booted for real: the segment row (Home · Solar · Powerwall · Pool · AC), each page's Live card and header, and the cards
// under them that read or write: Where your energy goes (with a named load as its own part), Big loads and its naming sheet (staged:
// pills and typing write nothing; only the footer writes Solstice's own label), the Powerwall rules, the in-place Pool and AC
// panels (a staged change gets its own Cancel / write row), and the Strip heat card (owner only, Nov–Mar or after heating).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { bootApp, $, click, flush, until, sheetEl, sheetOpen, footBtn, badText, smallTargets, hardColours, sheetWrites, NOW } from './harness.js';
import { ownerRoutes, external } from './routes.js';
import { acStrip, acStripWinter } from './fixtures-appl.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

let S, f, strip = null;
beforeAll(async () => { ({ S, f } = await bootApp(ownerRoutes({ 'appliances/ac/strip': () => strip ?? acStrip(NOW) }), external())); click(document.querySelector('.c-tab[data-v="v-sys"]')); await flush(); });
afterAll(() => vi.useRealTimers());
const seg = async s => { click($('sysSeg').querySelector(`[data-seg="${s}"]`)); await flush(4); };
const page = s => $(`sp-${s}`);
const noWrites = n => expect(sheetWrites(f, n), 'a write before the primary').toEqual([]);
/** No bad text on the whole page; tokens only in the component markup (`ids`: the Live card, tiles and rows drawn from the component
 *  system). The older cards still carry colours from their approved mockups: the per-panel health bars (views/panels.js) and the
 *  outage ladder's --c (views/outage.js); those are reported, not changed. */
function form(root, label, ids = null) {
  expect(badText(root), `${label}: bad text`).toEqual([]);
  for (const el of ids ? ids.map(i => $(i)) : [root]) expect(hardColours(el), `${label} ${el.id}: hard-coded colours`).toEqual([]);
}

describe('the segment row', () => {
  it('opens on Home; each segment shows only its page, slides the pill and marks itself selected', async () => {
    expect($('v-sys').classList.contains('on')).toBe(true);
    for (const s of ['solar', 'powerwall', 'pool', 'ac', 'home']) {
      await seg(s);
      expect(page(s).hidden, s).toBe(false);
      expect([...document.querySelectorAll('.sys-page')].filter(p => !p.hidden).map(p => p.id)).toEqual([`sp-${s}`]);
      expect($('sysSeg').querySelector(`[data-seg="${s}"]`).getAttribute('aria-selected')).toBe('true');
      expect($('sysSub').textContent.length, s).toBeGreaterThan(1);
    }
  });
  it('arrow keys move along the tablist', async () => {
    await seg('home');
    $('sysSeg').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(page('solar').hidden).toBe(false);
    $('sysSeg').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(page('home').hidden).toBe(false);
  });
});

describe('Home', () => {
  beforeAll(() => seg('home'));
  it('the Home card: live use, the share from solar + battery, and the plan strip', () => {
    expect($('homeSys').textContent).toContain(`${S.live.homeKw.toFixed(1)} kW`);
    expect($('homeSys').querySelector('.c-plan')).not.toBeNull();
    expect($('sysFig').textContent).not.toBe('—');
  });
  it('the Day Ring legend splits today into Pool, AC and everything else; the modes swap its sentence', () => {
    expect($('drLeg').textContent).toMatch(/Pool [\d.]+.*AC [\d.]+.*Everything else [\d.]+/s);
    expect($('drTxt').textContent).toMatch(/pool pump is about \d+%/);
    click($('drModes').querySelector('[data-m="pool"]'));
    expect($('drTxt').textContent).toMatch(/smarter schedule/);
    click($('drModes').querySelector('[data-m="now"]'));
  });
  it('Where your energy goes: the week’s parts with a named load as its own part; a part opens its detail in place', async () => {
    await until(() => $('egParts').children.length > 0, 2000, 'the breakdown');
    const parts = [...$('egParts').querySelectorAll('.c-part[data-id]')];
    expect(parts.map(p => p.dataset.id)).toEqual(['ac', 'alwaysOn', 'load:1', 'big', 'pool', 'other']);
    expect(parts[2].textContent).toContain('Water heater');
    expect($('egTotal').textContent).toBe(String(Math.round(ownerRoutes().breakdown.homeKwh)));
    click(parts[2]);
    expect($('egParts').querySelector('.c-part-d').textContent).toContain('Rename it under Big loads');
    click($('egParts').querySelector('.c-part[data-id="alwaysOn"]'));
    expect($('egParts').querySelector('[data-night]')).not.toBeNull();
    expect($('egBar').children).toHaveLength(6);
    form($('egCard'), 'Where your energy goes');
    expect(smallTargets($('egParts'))).toEqual([]);
  });
  it('Big loads: one row per cluster, a named one with Rename, unnamed ones with Name it / Not one appliance', async () => {
    await until(() => $('ldBody').querySelector('.c-load'), 2000, 'the loads');
    expect($('ldFig').textContent).toBe('3 found');
    const rows = [...$('ldBody').querySelectorAll('.c-load')];
    expect(rows[0].querySelector('b').textContent).toBe('Water heater');
    expect(rows[0].querySelector('[data-ld="name"]').textContent).toBe('Rename');
    expect(rows[1].querySelector('b').textContent).toBe('5.2 kW · 55 min');
    expect(rows[1].textContent).toContain('Looks like the dryer.');
    expect(rows[1].querySelector('[data-ld="dismiss"]').textContent).toBe('Not one appliance');
    form($('ldCard'), 'Big loads');
    expect(smallTargets($('ldBody'))).toEqual([]);
  });
  it('the naming sheet starts on the suggestion; pills and typing only stage; Save writes the label once', async () => {
    const n = f.calls.length;
    click($('ldBody').querySelectorAll('.c-load')[1].querySelector('[data-ld="name"]'));
    expect(sheetOpen()).toBe(true);
    expect(sheetEl().querySelector('h4').textContent).toBe('Name this load');
    expect(sheetEl().querySelector('[data-pick="Dryer"]').getAttribute('aria-pressed')).toBe('true');
    expect(footBtn('pri').textContent).toBe('Save "Dryer"');
    click(sheetEl().querySelector('[data-pick="Oven"]'));
    expect(footBtn('pri').textContent).toBe('Save "Oven"');
    click(sheetEl().querySelector('[data-pick="Other…"]'));
    const inp = sheetEl().querySelector('#ldOther');
    expect(footBtn('pri').disabled).toBe(true);   // Other… with nothing typed
    inp.value = '  Kiln   two '; inp.dispatchEvent(new Event('input', { bubbles: true }));
    expect(footBtn('pri').textContent).toBe('Save "Kiln two"');
    noWrites(n);
    expect(badText(sheetEl())).toEqual([]); expect(smallTargets(sheetEl())).toEqual([]); expect(hardColours(sheetEl())).toEqual([]);
    click(footBtn('pri')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'loads/label', body: { sig: 'k4m2', name: 'Kiln two' } })]);
    expect(sheetOpen()).toBe(false);
    expect(f.calls.slice(n).some(c => c.path === 'breakdown')).toBe(true);   // a new name reloads Where your energy goes
  });
  it('Not one appliance (row or sheet) posts {sig, dismissed: true}', async () => {
    const n = f.calls.length;
    click($('ldBody').querySelectorAll('.c-load')[1].querySelector('[data-ld="dismiss"]')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'loads/label', body: { sig: 'k4m2', dismissed: true } })]);
  });
});

describe('Solar and Powerwall', () => {
  it('Solar: the card’s production strip and the two tiles', async () => {
    await seg('solar');
    expect($('solarSys').textContent).toContain(`${S.live.solarKw.toFixed(1)} kW`);
    expect($('solarTiles').querySelectorAll('.c-tile')).toHaveLength(2);
    expect($('sysSub').textContent).toMatch(/Solar · 30 × 320 W · 9.6 kW DC/);
    form(page('solar'), 'Solar', ['solarSys', 'solarTiles']);
  });
  it('Powerwall: hero, unit bars, key values, four tiles, three rule rows', async () => {
    await seg('powerwall');
    expect($('pwHero').textContent).toBe(`${Math.round(S.live.soc)}%`);
    expect($('pwUnitBars').querySelectorAll('.c-unit')).toHaveLength(2);
    expect($('pwKv').textContent).toContain('Backup reserve');
    expect($('pwTiles').querySelectorAll('.c-tile')).toHaveLength(4);
    expect($('pwrRows').querySelectorAll('[data-rule]')).toHaveLength(3);
    expect($('pwrRows').textContent).toMatch(/Suggests 30% · waiting for you/);
    form(page('powerwall'), 'Powerwall', ['pwSys', 'pwHero', 'pwUnitBars', 'pwKv', 'pwTiles', 'pwrRows']);
  });
  it('a rule row opens its sheet; a mode is staged until the footer sends it', async () => {
    const n = f.calls.length;
    click($('pwrRows').querySelector('[data-rule="export"]'));
    expect(sheetEl().querySelector('h4').textContent).toBe('Export rule');
    click(sheetEl().querySelector('[data-m="off"]'));
    expect(footBtn('pri').textContent).toBe('Set export rule to Off');
    noWrites(n);
    expect(badText(sheetEl())).toEqual([]); expect(smallTargets(sheetEl())).toEqual([]);
    click(footBtn('pri')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'powerwall/rules/export', body: { mode: 'off' } })]);
    $('phone').classList.remove('open');
  });
});

describe('Pool and AC in place', () => {
  it('Pool: the Live card, then the equipment panel in place; a preset gets its own Cancel / write row', async () => {
    await seg('pool');
    const ctl = $('poolEquip');
    await until(() => ctl.querySelector('.c-preset'), 2000, 'the pool panel');
    expect(ctl.querySelector('.c-stagerow')).toBeNull();
    const n = f.calls.length;
    click(ctl.querySelector('.c-preset[data-rpm="3000"]'));
    const row = ctl.querySelector('.c-stagerow');
    expect(row.querySelector('[data-f="pri"]').textContent).toBe('Set Pool 3,000 rpm');
    noWrites(n);
    click(row.querySelector('[data-f="sec"]'));
    expect(ctl.querySelector('.c-stagerow')).toBeNull();
    click(ctl.querySelector('.c-preset[data-rpm="3000"]'));
    click(ctl.querySelector('.c-stagerow [data-f="pri"]')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/command', body: { kind: 'speed', id: 6, rpm: 3000 } })]);
    await flush(); expect(ctl.querySelector('.c-stagerow')).toBeNull();   // sent: back to the plain panel
    form(page('pool'), 'Pool page');
    expect(smallTargets(ctl)).toEqual([]);
  });
  it('AC: the thermostat panel in place stages a setpoint on its own row; the Strip heat card is hidden in October', async () => {
    await seg('ac');
    const p = $('acPanel');
    await until(() => p.querySelector('[data-step]'), 2000, 'the AC panel');
    const n = f.calls.length, set = Math.round(S.ac.state.coolF);
    click(p.querySelector('[data-step="-1"]'));
    expect(p.querySelector('.c-stagerow [data-f="pri"]').textContent).toBe(`Set ${set - 1}°`);
    noWrites(n);
    click(p.querySelector('.c-stagerow [data-f="pri"]')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/ac/command', body: { kind: 'cool', f: set - 1 } })]);
    expect($('acStrip').hidden).toBe(true);
    form(page('ac'), 'AC page');
    expect(smallTargets(p)).toEqual([]);
  });
  it('Strip heat (I-15): shown after a strip morning, with the bars, Strips and Heat pump, Why, the tip, the week; no buttons', async () => {
    strip = acStripWinter(NOW);
    await S.reloadAc(); await flush();
    const c = $('acStrip');
    expect(c.hidden).toBe(false);
    expect(c.querySelector('h5').textContent).toBe('Strip heat');
    expect(c.querySelector('.c-fig').textContent).toBe('7.8 kWh this morning');
    expect(c.querySelectorAll('.c-stage i')).toHaveLength(16);
    expect(c.querySelectorAll('.c-stage i.st').length).toBeGreaterThan(0);
    expect([...c.querySelectorAll('.c-part span')].map(s => s.textContent)).toEqual(['Strips', 'Heat pump']);
    expect(c.textContent).toContain('Why: Catching up from the 64° night setback');
    expect(c.textContent).toContain('Tip:');
    expect(c.textContent).toMatch(/3 mornings · 19 kWh/);
    expect(c.querySelectorAll('button,[role=button]')).toHaveLength(0);
    expect(badText(c)).toEqual([]);
    strip = null; await S.reloadAc();
    expect($('acStrip').hidden).toBe(true);
  });
});
