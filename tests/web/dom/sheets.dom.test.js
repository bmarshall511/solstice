// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// The control sheets opened from Now's Autopilot hub (Pool, AC, Powerwalls, Away), driven like a person would: staged writes.
// Every dial, preset, toggle, segment and switch only changes the sheet; nothing calls a write route until the footer's primary is
// tapped, and then exactly the right route gets exactly the right body. All routes are mocked (tests/web/dom/routes.js); nothing
// real is written anywhere. Each sheet also passes the form checks (no undefined/NaN/null text, 44 px controls, tokens only).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { bootApp, $, click, flush, until, sheetEl, sheetOpen, footBtn, byText, badText, smallTargets, hardColours, sheetWrites, KNOWN_COLOURS, LEGACY_SMALL, NOW } from './harness.js';
import { ownerRoutes, external } from './routes.js';
import { vacationCheckLeftOn } from './fixtures-appl.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

let S, f, check = null;
beforeAll(async () => { ({ S, f } = await bootApp(ownerRoutes({ 'vacation/check': () => check ?? ownerRoutes()['vacation/check'] }), external())); });
afterAll(() => vi.useRealTimers());
beforeEach(() => { confirm.mockClear(); confirm.mockImplementation(() => true); alert.mockClear(); });

const open = id => { click($('hubRows').querySelector(`[data-sheet="${id}"]`)); expect(sheetOpen()).toBe(true); };
const close = () => { $('phone').classList.remove('open'); };
const pri = () => footBtn('pri'), sec = () => footBtn('sec');
/** No write route was called since `n` (the background history sync aside). */
const noWrites = n => expect(sheetWrites(f, n), 'a write before the footer’s primary').toEqual([]);
/** The form checks on the open sheet. */
function form(label, { except = [] } = {}) {
  expect(badText(sheetEl()), `${label}: bad text`).toEqual([]);
  expect(smallTargets(sheetEl()), `${label}: controls under 44 px`).toEqual([]);
  expect(hardColours(sheetEl(), { except }), `${label}: hard-coded colours`).toEqual([]);
}
const point = (el, type, x, y) => el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: 1 }));

describe('Pool sheet (frame 5)', () => {
  beforeAll(() => open('pool'));
  afterAll(close);
  it('opens on the equipment panel: dial, four presets, Plan · Boost · Clear-up, the toggles, Autopilot; footer Open Pool | Done', () => {
    const b = sheetEl();
    expect(b.querySelector('h4').textContent).toBe('Pool');
    expect(b.querySelector('svg[role=slider]').getAttribute('aria-valuenow')).toBe(String(S.pool.live.rpm));
    expect([...b.querySelectorAll('.c-preset b')].map(x => x.textContent)).toEqual(['Quiet', 'Filter', 'Skim', 'Max']);
    expect([...b.querySelectorAll('[data-tab]')].map(x => x.textContent)).toEqual(['Plan', 'Boost', 'Clear-up']);
    expect(b.querySelectorAll('.c-tgl').length).toBeGreaterThanOrEqual(6);
    expect(b.querySelector('[data-ap="auto"]').classList.contains('on')).toBe(true);
    expect(pri().textContent).toBe('Done'); expect(sec().textContent).toBe('Open Pool');
    form('Pool sheet');
  });
  it('a preset only stages: the footer names the write; Cancel clears it; nothing is sent', () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('.c-preset[data-rpm="2400"]'));
    expect(pri().textContent).toBe('Run 2,400 rpm · 1 h');
    expect(sec().textContent).toBe('Cancel');
    expect(sheetEl().querySelector('[data-pl="v"]').textContent).toBe('2,400');
    click(sec());
    expect(pri().textContent).toBe('Done');
    noWrites(n);
  });
  it('Max stages "Set Pool 3,000 rpm" (Pool is on); the primary sends one speed command', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('.c-preset[data-rpm="3000"]'));
    expect(pri().textContent).toBe('Set Pool 3,000 rpm');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'appliances/pool/command', body: { kind: 'speed', id: 6, rpm: 3000 } })]);
    expect(pri().textContent).toBe('Done');
  });
  it('the dial: arrow keys and a drag stage a speed; release, not the drag, is what stages it', async () => {
    const n = f.calls.length, svg = () => sheetEl().querySelector('svg[role=slider]');
    svg().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(pri().textContent).toBe(`Set Pool ${(S.pool.live.rpm + 50).toLocaleString()} rpm`);
    click(sec());
    const s = svg(); s.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 196, right: 260, bottom: 196, x: 0, y: 0 });
    point(s, 'pointerdown', 130, 22);   // the top of the arc: half way, 1,950 rpm
    expect(sheetEl().querySelector('[data-pl="v"]').textContent).toBe('1,950');
    expect(pri().textContent).toBe('Done');   // dragging redraws only the dial
    point(s, 'pointerup', 130, 22);
    expect(pri().textContent).toBe('Set Pool 1,950 rpm');
    click(sec());
    noWrites(n);
  });
  it('a round toggle stages "Waterfall on · 1 h"; the primary turns it on with the controller’s own timer', async () => {
    const n = f.calls.length, wf = S.pool.snapshot.circuits.find(c => c.name === 'Waterfall');
    click(sheetEl().querySelector(`.c-tgl[data-cid="${wf.id}"]`));
    expect(sheetEl().querySelector(`.c-tgl[data-cid="${wf.id}"]`).classList.contains('stg')).toBe(true);
    expect(pri().textContent).toBe('Waterfall on · 1 h');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/command', body: { kind: 'circuit', id: wf.id, on: true, minutes: 60 } })]);
  });
  it('Boost: the tab shows its mode line; "Boost 1 h" stages High Speed; the primary runs it', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-tab="boost"]'));
    expect(sheetEl().querySelector('.c-modeline').textContent).toMatch(/High Speed at 2,400 rpm/);
    click(sheetEl().querySelector('[data-act="boost-stage"]'));
    expect(pri().textContent).toBe('Run 2,400 rpm · 1 h');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/command', body: { kind: 'circuit', id: 8, on: true, minutes: 60 } })]);
  });
  it('Autopilot: Suggest stages "Set Autopilot to Suggest"; the primary posts pool/autopilot, then reloads the pool', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-ap="suggest"]'));
    expect(pri().textContent).toBe('Set Autopilot to Suggest');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/autopilot', body: { mode: 'suggest' } })]);
    expect(f.calls.slice(n).some(c => c.method === 'GET' && c.path === 'appliances/pool')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();   // only Auto and Off ask
  });
  it('Autopilot Off asks first; saying no sends nothing', async () => {
    S.pool = ownerRoutes()['appliances/pool']; close(); open('pool');
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-ap="off"]'));
    confirm.mockImplementation(() => false);
    click(pri()); await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    noWrites(n);
    expect(pri().textContent).toBe('Set Autopilot to Off');   // still staged
    click(sec());
  });
  it('Clear-up › Set up… opens the Clear-up sheet, which writes only from its own footer', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-tab="clear"]'));
    click(sheetEl().querySelector('[data-act="cu-open"]'));
    expect(sheetEl().querySelector('h4').textContent).toMatch(/Clear-up/);
    noWrites(n);
    expect(badText(sheetEl())).toEqual([]);
  });
});

describe('AC sheet (frame 6)', () => {
  beforeAll(() => { close(); open('ac'); });
  afterAll(close);
  const reopen = () => { close(); S.ac = ownerRoutes()['appliances/ac']; open('ac'); };
  it('opens on the thermostat: the dial at the setpoint, the mode segment, Eco and Fan, Comfort and Away rows, the nudges, Autopilot', () => {
    const b = sheetEl(), set = Math.round(S.ac.state.coolF);
    expect(b.querySelector('h4').textContent).toBe('AC');
    expect(b.querySelector('svg[role=slider]').getAttribute('aria-valuenow')).toBe(String(set));
    expect(b.querySelector('[data-mode="COOL"]').classList.contains('on')).toBe(true);
    expect(b.querySelectorAll('[data-sw]')).toHaveLength(2);
    expect(b.querySelector('[data-go2="comf"]').textContent).toContain(`${S.ac.settings.dayF}° day`);
    expect(b.querySelectorAll('[data-nudge]')).toHaveLength(2);
    expect(pri().textContent).toBe('Done'); expect(sec().textContent).toBe('Open AC');
    form('AC sheet');
  });
  it('+ stages "Set N°" (one degree warmer); the primary sends a cool command', async () => {
    const n = f.calls.length, set = Math.round(S.ac.state.coolF);
    click(sheetEl().querySelector('[data-step="1"]'));
    expect(pri().textContent).toBe(`Set ${set + 1}°`);
    expect(sheetEl().querySelector('.c-dial-c em').textContent).toBe('staged · tap Set below');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'appliances/ac/command', body: { kind: 'cool', f: set + 1 } })]);
  });
  it('a mode stages "Switch to Heat"; the primary asks, then sends a mode command', async () => {
    reopen();
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-mode="HEAT"]'));
    expect(pri().textContent).toBe('Switch to Heat');
    expect(sheetEl().querySelector('svg[role=slider]')).toBeNull();   // no dial while a mode is staged
    noWrites(n);
    click(pri()); await flush();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Switch the thermostat to Heat?'));
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/ac/command', body: { kind: 'mode', mode: 'HEAT' } })]);
  });
  it('Eco and Fan switches stage "Eco on" and "Run the fan 1 h"; Cancel clears; each primary sends its one command', async () => {
    reopen();
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-sw="eco"]'));
    expect(pri().textContent).toBe('Eco on');
    click(sec()); expect(pri().textContent).toBe('Done');
    click(sheetEl().querySelector('[data-sw="fan"]'));
    expect(pri().textContent).toBe('Run the fan 1 h');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/ac/command', body: { kind: 'fan', seconds: 3600 } })]);
  });
  it('Autopilot Suggest stages "Set Autopilot to Suggest"; the primary posts ac/settings and reloads', async () => {
    reopen();
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-ap="suggest"]'));
    expect(pri().textContent).toBe('Set Autopilot to Suggest');
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/ac/settings', body: { autopilot: 'suggest' } })]);
    expect(f.calls.slice(n).some(c => c.method === 'GET' && c.path === 'appliances/ac')).toBe(true);
  });
  it('"Too warm" opens the nudge sheet; picking an option writes nothing; its button sends ac/nudge', async () => {
    reopen();
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-nudge="-1"]'));
    expect(sheetEl().querySelector('h4').textContent).toBe('Cooler by 1°');
    click(sheetEl().querySelector('[data-keep="0"]'));
    noWrites(n);
    expect(badText(sheetEl())).toEqual([]);
    expect(hardColours(sheetEl())).toEqual([]);
    expect(smallTargets(sheetEl())).toEqual(LEGACY_SMALL.nudge);   // the old shell, now with 44 px targets (Batch 8e)
    click($('ngGo')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/ac/nudge', body: { dir: -1, keep: false } })]);
  });
  it('Comfort opens its stepper sheet; steps write nothing; Save posts ac/settings with the edited targets', async () => {
    reopen();
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-go2="comf"]'));
    expect(sheetEl().querySelector('h4').textContent).toMatch(/Comfort/);
    const plus = sheetEl().querySelector('.c-step[aria-label*="arm"], .c-step:last-of-type');
    click(plus);
    noWrites(n);
    form('Comfort sheet', { except: KNOWN_COLOURS });
    click(pri()); await flush();
    const w = sheetWrites(f, n);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'POST', path: 'appliances/ac/settings' });
    expect(Object.keys(w[0].body)).toEqual(expect.arrayContaining(['dayF', 'nightF']));
  });
});

describe('Powerwalls sheet (frame 7)', () => {
  beforeAll(() => { close(); open('pw'); });
  afterAll(close);
  it('opens with the charge, the units, three rules with their mode segments and the waiting suggestion', () => {
    const b = sheetEl();
    expect(b.querySelector('h4').textContent).toBe('Powerwalls');
    expect(b.querySelector('.c-hero b').textContent).toContain(String(Math.round(S.live.soc)));
    expect(b.querySelectorAll('.c-unit')).toHaveLength(2);
    expect([...b.querySelectorAll('[data-rule]')].map(w => w.dataset.rule)).toEqual(['reserve', 'storm', 'export']);
    expect(b.querySelector('[data-rule="reserve"] .c-ban.amber')).not.toBeNull();
    expect(pri().textContent).toBe('Done'); expect(sec().textContent).toBe('Open Powerwall');
    form('Powerwalls sheet');
  });
  it('a rule’s mode stages "<rule>: Off"; the primary posts powerwall/rules/:id {mode}, then reloads the rules', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-rule="storm"] [data-m="off"]'));
    expect(pri().textContent).toMatch(/: Off$/);
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'powerwall/rules/storm', body: { mode: 'off' } })]);
    expect(f.calls.slice(n).some(c => c.method === 'GET' && c.path === 'powerwall/rules')).toBe(true);
  });
  it('the suggestion’s Apply is a named action: it asks first, and a no sends nothing', async () => {
    const n = f.calls.length;
    confirm.mockImplementation(() => false);
    click(sheetEl().querySelector('[data-rule="reserve"] [data-b="apply:reserve"]')); await flush();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Set the backup reserve to 30%?'));
    noWrites(n);
    confirm.mockImplementation(() => true);
    click(sheetEl().querySelector('[data-rule="reserve"] [data-b="apply:reserve"]')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'powerwall/rules/reserve/apply' })]);
  });
  it('Skip hides the suggestion on this device only (no request)', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-rule="reserve"] [data-b="skip:reserve"]'));
    expect(sheetEl().querySelector('[data-rule="reserve"] .c-ban')).toBeNull();
    expect(f.calls.length).toBe(n);
  });
});

describe('Away & Vacation sheet (frame 8)', () => {
  // each opening waits for its departure check and its estimate: an earlier sheet's 250 ms estimate timer redraws whatever Away sheet is
  // open with its own state (views/vacation.js showing()), so a reopen inside that window would be driven by the old one
  const openAway = async (ready = () => sheetEl().querySelector('#vaCheck')?.textContent.includes('Thermostat linked')) => {
    close(); await new Promise(r => setTimeout(r, 300)); open('away');
    await until(() => ready() && !sheetEl().querySelector('#vaSum')?.hidden, 10_000, 'the departure check and the estimate'); };
  beforeAll(() => openAway());
  afterAll(close);
  it('opens with Home / Away until…, the dates, Before you go, While you’re away; footer Start Vacation mode', () => {
    const b = sheetEl();
    expect(b.querySelector('h4').textContent).toBe('Away & Vacation');
    expect(b.querySelector('[data-pres="home"]').classList.contains('on')).toBe(true);
    expect(b.querySelectorAll('[data-dur]').length).toBeGreaterThanOrEqual(2);
    expect(b.querySelector('#vaPlan').querySelectorAll('[data-row]')).toHaveLength(6);
    expect(pri().textContent).toMatch(/^Start Vacation mode · /);
    form('Away sheet');
  });
  it('the checklist and the rows only change the sheet', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-tick="waterHeater"]'));
    expect(sheetEl().querySelector('[data-tick="waterHeater"]').getAttribute('aria-pressed')).toBe('true');
    click(sheetEl().querySelector('#vaPlan [data-row="0"]'));
    expect(sheetEl().querySelector('#vaPlan .c-inner')).not.toBeNull();
    click(sheetEl().querySelector('[data-mac="0"]'));
    noWrites(n);
  });
  it('Away until… stages "Away until I’m back", a duration "Away until …"; Cancel clears; the primary posts presence', async () => {
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-pres="away"]'));
    expect(pri().textContent).toBe('Away until I’m back');
    click(sheetEl().querySelector('[data-dur="2h"]'));
    expect(pri().textContent).toMatch(/^Away until /);
    click(sec()); expect(pri().textContent).toMatch(/^Start Vacation mode/);
    click(sheetEl().querySelector('[data-pres="away"]'));
    noWrites(n);
    click(pri()); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'presence', body: { state: 'away' } })]);
  });
  it('Start Vacation mode posts the trip with the checklist and whether the Mac stays home', async () => {
    await openAway();
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-tick="unplug"]'));
    noWrites(n);
    click(pri()); await flush();
    const w = sheetWrites(f, n);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'POST', path: 'vacation', body: { detected: false, checklist: { waterHeater: false, unplug: true, mac: false }, macHome: true } });
    expect(w[0].body.backAt).toBeGreaterThan(w[0].body.leaveAt);
  });
  it('a light left on gets a Turn off that acts on tap (a named action, the Pool card’s own command)', async () => {
    check = vacationCheckLeftOn(NOW);
    await openAway(() => sheetEl().querySelector('[data-off="3"]'));
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-off="3"]')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/command', body: { kind: 'circuit', id: 3, on: false } })]);
    check = null;
  });
});
