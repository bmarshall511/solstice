// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// The remaining owner sheets, booted for real: Log a test (water), the Pool circuits and one circuit, the schedule editor, the goal
// steppers, Clear-up, Sharing (create a link, revoke, the invite name), Preview as a guest, the learning report, the weekly digest
// and the timeline Log. Each one: its controls only stage; its own primary is the one write, with the right route and body.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { bootApp, $, click, flush, until, sheetEl, sheetOpen, footBtn, badText, smallTargets, hardColours, sheetWrites, NOW } from './harness.js';
import { ownerRoutes, external } from './routes.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

let S, f;
const created = { id: 'n1', label: 'Sam', url: 'https://example.test/#s=abcdefghijklmnopqrstu', expiresAt: null };
beforeAll(async () => { ({ S, f } = await bootApp(ownerRoutes({ 'POST share': created, 'POST auth/preview': { ok: true, preview: true } }), external())); });
afterAll(() => vi.useRealTimers());
beforeEach(() => { confirm.mockClear(); confirm.mockImplementation(() => true); });
const close = () => $('phone').classList.remove('open');
const noWrites = n => expect(sheetWrites(f, n), 'a write before the primary').toEqual([]);
const goSys = async seg => { click(document.querySelector('.c-tab[data-v="v-sys"]')); click($('sysSeg').querySelector(`[data-seg="${seg}"]`)); await flush(4); };
function form(label, { targets = true } = {}) {
  expect(badText(sheetEl()), `${label}: bad text`).toEqual([]);
  if (targets) expect(smallTargets(sheetEl()), `${label}: controls under 44 px`).toEqual([]);
  expect(hardColours(sheetEl()), `${label}: hard-coded colours`).toEqual([]);
}

describe('Pool page sheets', () => {
  beforeAll(() => goSys('pool'));
  afterAll(close);
  it('Log a test: steppers, segments and pills stage; Save test posts the test once', async () => {
    await until(() => $('pwLog'), 10_000, 'the water row');
    const n = f.calls.length;
    click($('pwLog'));
    expect(sheetEl().querySelector('h4').textContent).toBe('Log a test');
    click(sheetEl().querySelector('[data-k="fc"][data-d="1"]'));
    click(sheetEl().querySelector('[data-k="ta"][data-d="1"]'));   // an optional value starts mid-range
    click(sheetEl().querySelector('#plClar [data-c="hazy"]'));
    click(sheetEl().querySelector('#plAdd [data-a]'));
    noWrites(n);
    form('Log a test');
    click(footBtn('pri')); await flush();
    const w = sheetWrites(f, n);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'POST', path: 'pool/tests', body: { clarity: 'hazy', ta: 100 } });
    expect(w[0].body.added).toHaveLength(1);
  });
  it('Circuits: every circuit as a row; a circuit’s sheet stages its run length and speed; its primary sends the commands', async () => {
    click(document.querySelector('.c-tab[data-v="v-now"]'));
    click($('hubRows').querySelector('[data-sheet="pool"]'));
    click(sheetEl().querySelector('[data-pl="circ"] .c-sys'));
    expect(sheetEl().querySelector('h4').textContent).toBe('Circuits');
    expect(sheetEl().querySelectorAll('[data-cid]').length).toBe(S.pool.snapshot.circuits.length);
    form('Circuits');
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-cid="5"]'));   // Waterfall, off
    expect(sheetEl().querySelector('h4').textContent).toBe('Waterfall');
    click(sheetEl().querySelector('#pcRuns [data-m="120"]'));
    expect(footBtn('pri').textContent).toBe('Turn on for 2 h');
    noWrites(n);
    form('Waterfall');
    click(footBtn('pri')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/command', body: { kind: 'circuit', id: 5, on: true, minutes: 120 } })]);
  });
  it('the Spa’s sheet stages its heat and setpoint with the run', async () => {
    click($('hubRows').querySelector('[data-sheet="pool"]')); click(sheetEl().querySelector('[data-pl="circ"] .c-sys'));
    const n = f.calls.length;
    click(sheetEl().querySelector('[data-cid="1"]'));
    click(sheetEl().querySelector('#pcHeat [data-h="1"]'));
    click($('pcHup'));
    expect(footBtn('pri').textContent).toMatch(/^Spa on · heat to \d+° for /);
    noWrites(n);
    click(footBtn('pri')); await flush();
    const w = sheetWrites(f, n);
    expect(w.map(x => x.body.kind)).toEqual(['spaHeat', 'circuit']);
    expect(w[0].body).toMatchObject({ kind: 'spaHeat', on: true });
  });
  it('Edit schedule: runs, times and speeds stage; Save to the controller posts the schedule', async () => {
    await goSys('pool');
    await until(() => $('plEdit'), 10_000, 'the planner');
    const n = f.calls.length, runs0 = S.pool.current.schedules.length;
    click($('plEdit'));
    expect(sheetEl().querySelector('h4').textContent).toMatch(/schedule/i);
    click($('seUp'));
    click($('seAdd'));
    noWrites(n);
    form('Pump schedule');
    click(footBtn('pri')); await flush();
    const w = sheetWrites(f, n);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'POST', path: 'appliances/pool/schedule' });
    expect(w[0].body.schedules.length).toBe(runs0 + 1);
    expect(w[0].body.speeds.length).toBeGreaterThan(0);
  });
  it('Clear-up: days and speed stage; Start Clear-up posts {action: start, days, rpm}', async () => {
    const appl = await import('../../../web/src/views/appliances.js');
    const n = f.calls.length;
    appl.openClearUp(S);
    expect(sheetEl().querySelector('h4').textContent).toBe('Clear-up');
    click(sheetEl().querySelector('#pcDays [data-n="3"]'));
    noWrites(n);
    expect(badText(sheetEl())).toEqual([]);
    click(sheetEl().querySelector('[data-f="pri"]')); await flush();   // Batch 8d: Start Clear-up is the pinned footer's primary
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: 'appliances/pool/clearup', body: { action: 'start', days: 3, rpm: 2000 } })]);
  });
});

describe('Sharing', () => {
  beforeAll(() => click(document.querySelector('.c-tab[data-v="v-set"]')));
  afterAll(close);
  it('Share: an empty label asks for one and sends nothing; the expiry segment stages; Create link posts {label, expiresIn}', async () => {
    click($('shareRow')); await until(() => $('shareLabel'), 10_000, 'the share sheet');
    form('Share');
    const n = f.calls.length;
    click(footBtn('pri')); await flush();
    expect($('shareErr').hidden).toBe(false);
    click($('expSeg').querySelector('[data-e="7d"]'));
    noWrites(n);
    $('shareLabel').value = 'Sam';
    click(footBtn('pri')); await until(() => $('lnkCopy'), 10_000, 'the new link');
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ method: 'POST', path: 'share', body: { label: 'Sam', expiresIn: '7d' } })]);
    form('New link');
    click($('lnkQr'));
    expect($('lnkQrBox').hidden).toBe(false);
  });
  it('Revoke asks first, then posts share/:id/revoke', async () => {
    close(); click($('shareRow')); await until(() => sheetEl().querySelector('[data-rvk]'), 10_000, 'the active links');
    const n = f.calls.length, id = sheetEl().querySelector('[data-rvk]').dataset.rvk;
    confirm.mockImplementation(() => false);
    click(sheetEl().querySelector('[data-rvk]')); await flush();
    noWrites(n);
    confirm.mockImplementation(() => true);
    click(sheetEl().querySelector('[data-rvk]')); await flush();
    expect(sheetWrites(f, n)).toEqual([expect.objectContaining({ path: `share/${id}/revoke` })]);
  });
  it('the invite name: typing stages; Save puts ownerName', async () => {
    close(); click($('nameRow'));
    const n = f.calls.length;
    $('nameIn').value = '  Test   Owner 2 ';
    noWrites(n);
    form('Invite name');
    click(footBtn('pri')); await flush();
    const w = sheetWrites(f, n);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'PUT', path: 'settings' });
    expect(w[0].body.ownerName).toMatch(/^Test\s+Owner 2$/);
  });
});

describe('the report sheets', () => {
  afterAll(close);
  it('learning: the card’s rows open one model and All models', async () => {
    await until(() => $('lrRows').querySelector('[data-model="*"]'), 10_000, 'the learning card');
    click($('lrRows').querySelector('[data-model]:not([data-model="*"])'));
    expect(sheetOpen()).toBe(true);
    expect(badText(sheetEl())).toEqual([]);
    close();
    click($('lrRows').querySelector('[data-model="*"]'));
    expect(sheetEl().textContent.length).toBeGreaterThan(50);
    expect(badText(sheetEl())).toEqual([]);
  });
  it('the weekly digest opens from its banner and shows the week', async () => {
    const dg = await import('../../../web/src/views/digest.js');
    close(); dg.openDigest(S); await flush();
    expect(sheetOpen()).toBe(true);
    expect(sheetEl().querySelector('h4').textContent).toBe('Your week');
    expect(badText(sheetEl())).toEqual([]);
    if ($('dgFull')) { click($('dgFull')); expect(badText(sheetEl())).toEqual([]); }
  });
  it('the Log: every system’s entries by day, the filters, one system only and back to all', () => {
    close(); S.openLog({ src: 'ac' });
    expect(sheetEl().querySelector('h4').textContent).toBe('Log');
    expect(sheetEl().querySelector('.c-sheet-h .c-badge').textContent).toBe('AC Autopilot');
    click(sheetEl().querySelector('[data-wide]'));
    for (const b of [...sheetEl().querySelectorAll('[data-fl]')].map(x => x.dataset.fl)) click(sheetEl().querySelector(`[data-fl="${b}"]`));
    expect(badText(sheetEl())).toEqual([]);
    expect(smallTargets(sheetEl())).toEqual([]);
  });
});

describe('Preview as a guest', () => {
  it('the switch posts auth/preview {on: true} and puts the page in the guest preview; again ends it', async () => {
    click(document.querySelector('.c-tab[data-v="v-set"]'));
    const n = f.calls.length;
    click($('guestSw'));
    // the role flips mid-wipe; the guest pill shows once the whole frost wipe is done (a tap before that is ignored)
    await until(() => $('gpill')?.classList.contains('show'), 20_000, 'the preview');
    expect(document.documentElement.dataset.as).toBe('guest');
    expect(f.writes(n).filter(c => c.path === 'auth/preview')).toEqual([expect.objectContaining({ body: { on: true } })]);
    expect(S.guest && S.asGuest).toBe(true);
    const m = f.calls.length;
    click($('guestSw'));
    await until(() => document.documentElement.dataset.as !== 'guest', 20_000, 'the end of the preview');
    expect(f.writes(m).filter(c => c.path === 'auth/preview')).toEqual([expect.objectContaining({ body: { on: false } })]);
    expect(S.guest).toBe(false);
  });
});
