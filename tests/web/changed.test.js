// I-18 "What changed" in the browser (web/src/lib/changed.js, approved mockup mockups/am-ideas.html frames 1, 2, 3 and 8): the
// waterfall's markup, the badges, the sentences and the morning line. Frame 1's illustrative numbers; all data synthetic.
import { describe, it, expect } from 'vitest';
import { wfHtml, signed1, vsText, usedSum, guestSum, boughtSum, fineText, dayCardHtml, buyCardHtml, weekCardHtml, morningBanner, leadPart } from '../../web/src/lib/changed.js';
import { changedLeadHtml } from '../../web/src/lib/digest.js';
import { pickBanner } from '../../web/src/lib/nowui.js';

const day = {
  scope: 'day', date: '2026-10-06', to: '2026-10-06', baseline: { kind: 'weekday', days: 4 }, wx: { high: 96, baseHigh: 89 },
  home: { obs: 41.3, base: 35.2, delta: 6.1, parts: [
    { id: 'weather', kwh: 3.8, conf: 'estimated' }, { id: 'ac', kwh: 0.9, conf: 'measured' }, { id: 'pool', kwh: 1.2, conf: 'measured' },
    { id: 'alwaysOn', kwh: -0.2, conf: 'measured' }, { id: 'unexplained', kwh: 0.4, conf: null }] },
  import: { obs: 9.4, base: 5.2, delta: 4.2, parts: [{ id: 'home', kwh: 6.1, conf: null }, { id: 'solar', kwh: -1.9, conf: 'measured' }], solar: { obs: 54, base: 53 } },
  notes: [],
};
const guest = { ...day, home: { ...day.home, parts: [{ id: 'weather', kwh: 3.8, conf: 'estimated' }, { id: 'pool', kwh: 1.2, conf: 'measured' }, { id: 'other', kwh: 1.1, conf: null }] } };
const week = { scope: 'week', date: '2026-09-28', to: '2026-10-04', baseline: { kind: 'week', days: 7 }, wx: { high: 94, baseHigh: 88 },
  home: { obs: 212, base: 174, delta: 38, parts: [{ id: 'weather', kwh: 22, conf: 'estimated' }, { id: 'ac', kwh: 9.1, conf: 'measured' }, { id: 'pool', kwh: 4.3, conf: 'measured' },
    { id: 'alwaysOn', kwh: 1.6, conf: 'measured' }, { id: 'unexplained', kwh: 1, conf: null }] },
  import: { obs: 41, base: 29, delta: 12, parts: [{ id: 'home', kwh: 38, conf: null }, { id: 'solar', kwh: -26, conf: 'measured' }], solar: { obs: 380, base: 300 } }, notes: [] };

describe('I-18: the change waterfall (c-wf)', () => {
  it('CW-1 one row per part with its accent, badge, bar from the centre and signed value, then the total row (frame 1)', () => {
    const h = wfHtml(day.home.parts, day.home.delta, 'Used vs typical');
    expect(h.startsWith('<div class="c-wf">')).toBe(true);
    expect(h).toContain('<div class="c-wf-r c-acc-out"><span class="c-wf-l">Weather<span class="c-badge" data-t="e">estimated</span></span><span class="c-wf-t"><i class="pos" style="width:46%"></i></span><b class="pos">+3.8</b></div>');
    expect(h).toContain('<div class="c-wf-r c-acc-ac"><span class="c-wf-l">AC beyond the weather<span class="c-badge" data-t="m">measured</span></span><span class="c-wf-t"><i class="pos" style="width:11%"></i></span><b class="pos">+0.9</b></div>');
    expect(h).toContain('<i class="pos" style="width:15%"></i>');                                   // pool 1.2
    expect(h).toContain('<div class="c-wf-r c-acc-grid"><span class="c-wf-l">Always-on<span class="c-badge" data-t="m">measured</span></span><span class="c-wf-t"><i class="neg" style="width:2%"></i></span><b class="neg">−0.2</b></div>');
    expect(h).toContain('<div class="c-wf-r c-acc-mute"><span class="c-wf-l">Unexplained</span>');   // no badge
    expect(h).toContain('<div class="c-wf-r c-wf-tot"><span class="c-wf-l">Used vs typical</span><span class="c-wf-t"></span><b>+6.1 kWh</b></div></div>');
    expect(wfHtml([{ id: 'pool', kwh: 0, conf: 'measured' }], 0, 'x')).toContain('<span class="c-wf-t"></span><b class="pos">0.0</b>');   // a zero part has no bar
    expect([signed1(1.25), signed1(-0.04), signed1(-3)]).toEqual(['+1.3', '0.0', '−3.0']);
  });
  it('CW-2 badges: estimated, measured and learning; the bought rows (frame 1, second card)', () => {
    expect(wfHtml([{ id: 'weather', kwh: 1, conf: 'learning' }], 1, 't')).toContain('<span class="c-badge" data-t="e">learning</span>');
    const b = buyCardHtml(day);
    expect(b).toContain('<h5>Bought from PEC</h5><span class="c-fig">+4.2 kWh</span>');
    expect(b).toContain('<span class="c-wf-l">Used more (above)</span><span class="c-wf-t"><i class="pos" style="width:46%"></i></span><b class="pos">+6.1</b>');
    expect(b).toContain('<span class="c-wf-l">Solar &amp; Powerwalls covered more<span class="c-badge" data-t="m">measured</span></span><span class="c-wf-t"><i class="neg" style="width:14%"></i></span><b class="neg">−1.9</b>');
    expect(b).toContain('Bought vs typical</span><span class="c-wf-t"></span><b>+4.2 kWh</b>');
  });
});

describe('I-18: the words', () => {
  it('CW-3 the day: vs a typical Tuesday, the heat leads, the pool follows, the fine print', () => {
    expect(vsText(day)).toBe('vs a typical Tuesday');
    expect(vsText({ ...day, baseline: { kind: 'prev7', days: 7 } })).toBe('vs a typical day');
    expect(leadPart(day).id).toBe('weather');
    expect(usedSum(day)).toBe('Most of it was the heat: a 96° high against 89° on a typical Tuesday. The pool ran 1.2 kWh longer.');
    expect(usedSum({ ...day, wx: { high: 80, baseHigh: 89 }, home: { ...day.home, delta: -4, parts: [{ id: 'weather', kwh: -3, conf: 'estimated' }, { id: 'unexplained', kwh: -1, conf: null }] } }))
      .toBe('Most of it was the cooler weather: a 80° high against 89° on a typical Tuesday.');
    expect(usedSum({ ...day, home: { ...day.home, delta: 5, parts: [{ id: 'pool', kwh: 2, conf: 'measured' }, { id: 'ac', kwh: 1.5, conf: 'measured' }, { id: 'unexplained', kwh: 1.5, conf: null }] } }))
      .toBe('The biggest part was the pool, 2.0 kWh more.');
    expect(usedSum({ ...day, home: { ...day.home, delta: -20, parts: [{ id: 'trip', kwh: -22, conf: 'estimated' }, { id: 'unexplained', kwh: 2, conf: null }] } }))
      .toBe('Most of it was the trip: the house was empty.');
    expect(usedSum({ ...day, home: { ...day.home, delta: 0.3 } })).toBe('About the same as a typical Tuesday.');
    expect(boughtSum(day)).toBe('Sun was normal (54 kWh made); solar and the Powerwalls covered 1.9 kWh more.');
    expect(boughtSum({ ...day, import: { ...day.import, solar: { obs: 30, base: 52 } } })).toBe('Sun was weak (30 kWh made, 52 typical); solar and the Powerwalls covered 1.9 kWh more.');
    expect(fineText(day)).toBe('Typical = the last 4 Tuesdays at home (trip days left out). Parts add up to the change exactly; what the models can’t place is “Unexplained”.');
    expect(fineText({ ...day, baseline: { kind: 'weekday', days: 3 } })).toMatch(/^Typical = 3 of the last 4 Tuesdays at home/);
    expect(fineText({ ...day, baseline: { kind: 'prev7', days: 7 } })).toMatch(/^Typical = the last 7 days at home/);
  });
  it('CW-4 the owner card has the Used · Bought segment and the fine print; the guest card (frame 8) has neither', () => {
    const o = dayCardHtml(day);
    expect(o).toContain('<h5>What changed</h5><span class="c-fig">vs a typical Tuesday</span>');
    expect(o).toContain('<button class="on" data-c="home" aria-pressed="true">Used</button><button class="" data-c="import" aria-pressed="false">Bought</button>');
    expect(o).toContain('class="c-fine"'); expect(o).toContain('Used vs typical');
    const b = dayCardHtml(day, { view: 'import' });
    expect(b).toContain('--i:1'); expect(b).toContain('Bought vs typical'); expect(b).toContain('<span class="c-wf-l">Used more</span>');
    const g = dayCardHtml(guest, { guest: true });
    expect(g).not.toContain('c-seg'); expect(g).not.toContain('c-fine');
    expect(g).toContain('<span class="c-wf-l">Everything else</span>');
    expect(g).toContain('<div class="c-sum">Mostly the heat.</div>');
    expect(guestSum({ ...guest, home: { ...guest.home, delta: 3, parts: [{ id: 'weather', kwh: 0.5, conf: 'estimated' }, { id: 'pool', kwh: 0, conf: 'measured' }, { id: 'other', kwh: 2.5, conf: null }] } })).toBe('Mostly everything else.');
  });
  it('CW-5 the week card (frame 2): its figures, the waterfall against last week and the sentence', () => {
    const w = weekCardHtml(week);
    expect(w).toContain('<h5>Week of Sep 28</h5><span class="c-fig">212 kWh used</span>');
    expect(w).toContain('<span>Used</span><b>212 kWh · ▲ 38</b><span>Bought</span><b>41 kWh · ▲ 12</b><span>Sunshare</span><b>81%</b>');
    expect(w).toContain('Used vs last week</span><span class="c-wf-t"></span><b>+38.0 kWh</b>');
    expect(w).toContain('<div class="c-sum">A hotter week (avg high 94° vs 88°) explains most of it.</div>');
  });
  it('CW-5b a guest’s week (no import from the server: guests never get the Bought split) draws the Used row only, without throwing', () => {
    const { import: _bought, ...g } = week;
    const w = weekCardHtml({ ...g, home: { ...week.home, parts: [{ id: 'weather', kwh: 22, conf: 'estimated' }, { id: 'pool', kwh: 4, conf: 'measured' }, { id: 'other', kwh: 12, conf: null }] } }, { guest: true });
    expect(w).toContain('<span>Used</span><b>212 kWh · ▲ 38</b></div>');
    expect(w).not.toContain('Bought'); expect(w).not.toContain('Sunshare');
    expect(w).toContain('Used vs last week');
  });
  it('CW-6 the digest line (frame 2): whole kWh that still add up, weather badged', () => {
    expect(changedLeadHtml({ changed: week })).toBe('<b>+38 kWh used vs last week:</b> weather +22 <span class="c-badge" data-t="e">est</span>, AC +9, pool +4, always-on +2, unexplained +1.');
    // 3.4 + 3.4 + 3.4 = 10.2 → 3 + 3 + 3, and the rounding goes into the last part
    expect(changedLeadHtml({ changed: { home: { delta: 10.2, parts: [{ id: 'weather', kwh: 3.4, conf: 'learning' }, { id: 'pool', kwh: 3.4 }, { id: 'other', kwh: 3.4 }] } } }))
      .toBe('<b>+10 kWh used vs last week:</b> weather +3 <span class="c-badge" data-t="e">learning</span>, pool +3, everything else +4.');
    expect(changedLeadHtml({ changed: null })).toBeNull();
    expect(changedLeadHtml({})).toBeNull();
  });
});

describe('I-18: the morning line (frame 3)', () => {
  const at = { hour: 7.7, today: '2026-10-07' };
  it('CW-7 yesterday, 06:00–11:00, two biggest parts and the sun; Why and Dismiss', () => {
    expect(morningBanner(day, at)).toEqual({ kind: 'changed', cls: 'plain', ic: 'bill', title: 'Yesterday: 4.2 kWh more bought',
      line: 'Hotter (+3.8) and a longer pool run (+1.2) · sun was normal', btns: [['Why', 'chg-why', false], ['Dismiss', 'chg-dismiss', false]] });
    expect(morningBanner(day, { ...at, hour: 6 })).not.toBeNull();
    expect(morningBanner(day, { ...at, hour: 5.99 })).toBeNull();
    expect(morningBanner(day, { ...at, hour: 11 })).toBeNull();
  });
  it('CW-8 hidden under 2 kWh either way, on another day, and after Dismiss until tomorrow', () => {
    expect(morningBanner({ ...day, import: { ...day.import, delta: 1.9 } }, at)).toBeNull();
    expect(morningBanner({ ...day, import: { ...day.import, delta: -1.99 } }, at)).toBeNull();
    const less = morningBanner({ ...day, import: { ...day.import, delta: -2.5, solar: { obs: 70, base: 53 } }, home: { ...day.home, delta: -1, parts: [{ id: 'weather', kwh: -1.5, conf: 'estimated' }, { id: 'unexplained', kwh: 0.5, conf: null }] }, wx: { high: 85, baseHigh: 89 } }, at);
    expect(less).toMatchObject({ title: 'Yesterday: 2.5 kWh less bought', line: 'Cooler (−1.5) · sun was strong' });
    expect(morningBanner({ ...day, date: '2026-10-05' }, at)).toBeNull();
    expect(morningBanner(day, { ...at, dismissed: '2026-10-07' })).toBeNull();
    expect(morningBanner(day, { ...at, dismissed: '2026-10-06' })).not.toBeNull();   // dismissed yesterday: today's shows
    expect(morningBanner(null, at)).toBeNull();
  });
  it('CW-9 the lowest banner: anything else in the slot wins', () => {
    const chg = morningBanner(day, at);
    expect(pickBanner([chg, { kind: 'digest' }])).toEqual({ kind: 'digest' });
    expect(pickBanner([chg, { kind: 'bill' }])).toEqual({ kind: 'bill' });
    expect(pickBanner([chg])).toBe(chg);
  });
});

// The owner's rule (2026-10-08): until the history is clean the Used split stays hidden; the total and one line show instead.
describe('I-18: not clean yet', () => {
  const dirty = { ...day, clean: false, home: { ...day.home, parts: [] } };
  it('the Day card shows the total and one line, no parts; the owner can still switch to the (exact) Bought split', () => {
    const h = dayCardHtml(dirty);
    expect(h).toContain('Not enough clean history to split this day yet.');
    expect(h.match(/class="c-wf-r (?!c-wf-tot)/g) ?? []).toHaveLength(0);   // only the total row
    expect(h).toContain('Used vs typical</span><span class="c-wf-t"></span><b>+6.1 kWh</b>');
    expect(h).toContain('data-c="import"');
    expect(dayCardHtml(dirty, { view: 'import' })).toContain('Bought vs typical');
    expect(dayCardHtml({ ...dirty }, { guest: true })).toContain('Not enough clean history to split this day yet.');
  });
  it('the Week card, the digest line and the morning line follow it', () => {
    expect(weekCardHtml({ ...week, clean: false, home: { ...week.home, parts: [] } })).toContain('Not enough clean history to split this week yet.');
    expect(changedLeadHtml({ changed: { ...week, clean: false, home: { ...week.home, parts: [] } } })).toBe('<b>+38 kWh used vs last week.</b>');
    expect(morningBanner({ ...dirty }, { hour: 7, today: '2026-10-07' })).toBeNull();
    expect(morningBanner({ ...day, clean: true }, { hour: 7, today: '2026-10-07' })).not.toBeNull();
  });
});
