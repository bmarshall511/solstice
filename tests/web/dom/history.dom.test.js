// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// History booted for real: Day (the radial chart, the four tiles, day-by-day navigation), Week, Month and Year (bars, the year ring),
// I-18 What changed (a past day against its typical weekday with Used · Bought; the last week against the one before; the
// not-clean line in place of the split), Bought from PEC, Where every kWh went (and its 3D flow), and the bill, record and outage
// sheets. Form: no undefined/NaN/null text anywhere on the page; the new cards use tokens and 44 px controls.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { bootApp, $, click, flush, until, sheetEl, sheetOpen, footBtn, badText, smallTargets, hardColours, TODAY, NOW } from './harness.js';
import { ownerRoutes, external } from './routes.js';
import { changedClean, changedNotClean } from './fixtures-core.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

const notClean = new Set();   // dates (or 'week') whose /api/changed answer is the not-clean one
const changedFor = q => {
  const base = notClean.has(q.scope === 'week' ? 'week' : q.date) ? changedNotClean(NOW) : changedClean(NOW);
  return { ...base, scope: q.scope, date: q.date ?? '2026-09-28', to: q.scope === 'week' ? '2026-10-04' : q.date };
};
let S, f;
beforeAll(async () => { ({ S, f } = await bootApp(ownerRoutes({ changed: req => changedFor(req.query) }), external())); click(document.querySelector('.c-tab[data-v="v-hist"]')); await flush(10); });
afterAll(() => vi.useRealTimers());
const range = async r => { click($('hseg').querySelector(`[data-r="${r}"]`)); await flush(10); };
const card = () => $('chgCard'), buy = () => $('chgBuy');
const wfParts = el => [...el.querySelectorAll('.c-wf-r:not(.c-wf-tot) .c-wf-l')].map(x => x.firstChild.textContent);

describe('Day', () => {
  it('today: the radial chart, the legend, four tiles; What changed waits for a complete day', () => {
    expect($('dayLabel').textContent).toBe('Today');
    expect($('dayNext').disabled).toBe(true);
    expect($('hchart').innerHTML).toContain('<path');
    expect($('hleg').textContent).toMatch(/Solar [\d.]+Home [\d.]+From PEC [\d.]+Battery %/);
    expect($('hstats').querySelectorAll('.c-tile')).toHaveLength(4);
    expect($('hstats').textContent).toMatch(/≈ \$\d+\.\d\d/);   // the owner's dollars from the bill's rate
    expect(card().hidden).toBe(true); expect(buy().hidden).toBe(true);
  });
  it('yesterday: What changed vs a typical Tuesday (clean: the parts), Used · Bought, and Bought from PEC', async () => {
    click($('dayPrev')); await until(() => !card().hidden, 10_000, 'What changed');
    expect($('dayLabel').textContent).toMatch(/^Tue, Oct 6/);
    expect(f.calls.some(c => c.path === 'changed' && c.query.scope === 'day' && c.query.date === '2026-10-06')).toBe(true);
    expect(card().querySelector('h5').textContent).toBe('What changed');
    expect(card().querySelector('.c-fig').textContent).toBe('vs a typical Tuesday');
    expect(wfParts(card())).toEqual(['Weather', 'AC beyond the weather', 'Pool', 'Always-on', 'Unexplained']);
    expect(card().querySelector('.c-wf-tot b').textContent).toBe('+6.1 kWh');
    expect(card().querySelector('.c-sum').textContent).toMatch(/^Most of it was the heat: a 91° high against 86°/);
    expect(card().querySelector('[data-c="home"]').getAttribute('aria-pressed')).toBe('true');
    expect(buy().hidden).toBe(false);
    expect(buy().querySelector('h5').textContent).toBe('Bought from PEC');
    expect(buy().querySelector('.c-fig').textContent).toBe('+4.2 kWh');
    // Bought
    click(card().querySelector('[data-c="import"]'));
    expect(card().querySelector('[data-c="import"]').getAttribute('aria-pressed')).toBe('true');
    expect(card().querySelector('.c-wf-tot .c-wf-l').textContent).toBe('Bought vs typical');
    expect(card().querySelector('.c-sum').textContent).toMatch(/^Sun was normal \(41 kWh made\); solar and the Powerwalls covered 1\.9 kWh more\.$/);
    click(card().querySelector('[data-c="home"]'));
    for (const el of [card(), buy()]) { expect(badText(el)).toEqual([]); expect(hardColours(el)).toEqual([]); expect(smallTargets(el)).toEqual([]); }
  });
  it('a day whose history isn’t clean: the total and one line, no split; Bought still splits', async () => {
    notClean.add('2026-10-05');
    click($('dayPrev')); await until(() => $('dayLabel').textContent.startsWith('Mon, Oct 5') && !card().hidden, 10_000, 'the not-clean day');
    expect(wfParts(card())).toEqual([]);
    expect(card().querySelector('.c-wf-tot b').textContent).toBe('+6.1 kWh');
    expect(card().querySelector('.c-sum').textContent).toBe('Not enough clean history to split this day yet.');
    click(card().querySelector('[data-c="import"]'));
    expect(wfParts(card()).length).toBe(2);
    click(card().querySelector('[data-c="home"]'));
    expect(badText(card())).toEqual([]);
  });
  it('Next walks back to today; the arrow stops there', async () => {
    click($('dayNext')); await flush(10); click($('dayNext')); await flush(10);
    expect($('dayLabel').textContent).toBe('Today');
    expect($('dayNext').disabled).toBe(true);
  });
  it('Where every kWh went: the stacked bar and its three parts; 3D flow builds the scene on demand', async () => {
    await until(() => $('flowStack').children.length, 10_000, 'the flows');
    expect($('flowSum').hidden).toBe(false);
    expect($('flowDl').textContent).toMatch(/Pool [\d.]+AC [\d.]+Everything else [\d.]+/);
    click($('flow3d')); await flush(10);
    expect($('flow3d').textContent).toBe('Hide the 3D flow');
    expect($('flowHost').hidden).toBe(false);
    expect($('flowHost').querySelector('.kv').textContent).toContain('Solar made');
    click($('flow3d')); await flush();
    expect($('flowHost').hidden).toBe(true);
  });
});

describe('Week, Month, Year', () => {
  it('Week: bars and tiles, and What changed against the week before (clean, then not clean)', async () => {
    await range('week');
    expect($('dayNav').hidden).toBe(true);
    expect($('hchart').querySelectorAll('rect').length).toBe(14);   // 7 days × solar and home
    await until(() => !card().hidden && card().querySelector('h5')?.textContent.startsWith('Week of'), 10_000, 'the week card');
    expect(card().querySelector('h5').textContent).toBe('Week of Sep 28');
    expect(card().querySelector('.c-kv').textContent).toMatch(/Used41 kWh · ▲ 6Bought9 kWh · ▲ 4Sunshare\d+%/);
    expect(wfParts(card()).length).toBe(5);
    expect(buy().hidden).toBe(true);   // Bought from PEC is a Day card
    expect(badText($('v-hist'))).toEqual([]);
    notClean.add('week'); S.changedCache = {};
    await range('day'); await range('week');
    await until(() => card().querySelector('.c-sum')?.textContent === 'Not enough clean history to split this week yet.', 10_000, 'the not-clean week');
    expect(wfParts(card())).toEqual([]);
  });
  it('Month: 30 days of bars, the flows card; no What changed', async () => {
    await range('month');
    expect($('hchart').querySelectorAll('rect').length).toBe(60);
    expect(card().hidden).toBe(true);
    expect($('flowSum').hidden).toBe(false);
    expect($('hstats').textContent).toMatch(/kWh\/day avg/);
  });
  it('Year: 12 months of bars and the year ring card', async () => {
    await range('year');
    expect($('hchart').querySelectorAll('rect').length).toBe(24);
    expect($('yrCard').hidden).toBe(false);
    expect($('flowSum').hidden).toBe(true);
    await until(() => $('yrRead').textContent.length > 0, 10_000, 'the year ring read-out');
    expect(badText($('yrCard'))).toEqual([]);
    await range('day');
    expect($('yrCard').hidden).toBe(true);
  });
  it('form: History has no undefined/NaN/null/[object Object] text', () => {
    expect(badText($('v-hist'))).toEqual([]);
  });
});

describe('the History sheets', () => {
  const close = () => $('phone').classList.remove('open');
  it('Records, Outages and Bills open as sheets with no bad text', async () => {
    for (const id of ['recAll', 'outAll', 'billAll']) {
      click($(id)); await flush();
      expect(sheetOpen(), id).toBe(true);
      expect(badText(sheetEl()), id).toEqual([]);
      close();
    }
  });
  it('a bill’s detail: its lines, and Remove this bill as the footer’s one write (asked first)', async () => {
    click($('billAll')); await flush();
    const row = sheetEl().querySelector('[data-bill], [role=button]');
    expect(row).not.toBeNull();
    click(row); await flush();
    expect(sheetEl().querySelector('.c-kv')).not.toBeNull();
    expect(footBtn('pri').textContent).toBe('Remove this bill');
    expect(badText(sheetEl())).toEqual([]); expect(smallTargets(sheetEl())).toEqual([]);
    const n = f.calls.length; confirm.mockImplementation(() => false);
    click(footBtn('pri')); await flush();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Remove the \w+ 2026 bill\?/));
    expect(f.writes(n).filter(c => c.path !== 'sync')).toEqual([]);
    confirm.mockImplementation(() => true);
    const date = row.dataset.bill;
    click(footBtn('pri')); await flush();
    expect(f.writes(n).filter(c => c.path !== 'sync')).toEqual([expect.objectContaining({ method: 'DELETE', path: `bills/${date}` })]);
    expect(sheetOpen()).toBe(false);
    expect(f.calls.slice(n).some(c => c.method === 'GET' && c.path === 'reconcile')).toBe(true);
  });
  it('the bill segment swaps Meter · Waterfall · Cycle · Monthly', () => {
    for (const b of ['wf', 'cycle', 'monthly', 'meter']) {
      click($('billSeg').querySelector(`[data-b="${b}"]`));
      expect([...document.querySelectorAll('#billAnalysis [data-pane]')].filter(p => !p.hidden).map(p => p.dataset.pane)).toEqual([b]);
    }
  });
});
