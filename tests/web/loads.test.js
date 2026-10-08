// I-22 load signatures (web/src/views/loads.js, approved mockup am frames 4–5): the Big loads rows, the naming sheet's markup and its
// staged state, and the stylesheet's 44 px touch targets for every control on them. Pure builders, run under node. Synthetic data.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

let L;
beforeAll(async () => {
  vi.stubGlobal('document', { hidden: true, addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } });
  vi.stubGlobal('addEventListener', () => {});
  L = await import('../../web/src/views/loads.js');
});

const hist = Array.from({ length: 24 }, (_, h) => h === 17 ? 1 : h === 16 ? .5 : h === 18 ? .8 : h === 19 ? .3 : 0);
const oven = { sig: 'k1m2', labelId: null, name: null, dismissed: false, hue: null, kw: 2.6, minutes: 50, perDay: .57, kwhPerDay: 1.2, hist, window: { from: 16, to: 19 },
  suggestion: { name: 'Oven', text: 'Looks like the oven.' }, badge: 'learning', found: false };
const wh = { ...oven, sig: 'k2m1-morning', labelId: 3, name: 'Water heater', hue: 0, kw: 4.4, minutes: 22, perDay: 6.2, kwhPerDay: 5.3, window: null, suggestion: null, badge: 'learned', found: true };

describe('Big loads rows (frame 4)', () => {
  it('LW-1 an unnamed cluster: signature title, badge, kWh a day, how often and when, the strip, the suggestion, Name it / Not one appliance', () => {
    const h = L.loadRow(oven);
    expect(h).toContain('<div class="c-load c-acc-solar"><div class="c-load-h"><b>2.6 kW · 50 min</b><span class="c-badge" data-t="u">learning</span><span class="f">1.2 kWh/day</span></div>');
    expect(h).toContain('<p>4× a week, 4–7 PM</p>');
    expect(h.match(/<div class="c-day">([\s\S]*?)<\/div>/)[1].match(/<i style="--v:[\d.]+"><\/i>/g)).toHaveLength(24);
    expect(h).toContain('<div class="c-dlab"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>');
    expect(h).toContain('<p class="s">Looks like the oven.</p>');
    expect(h).toContain('<div class="c-btns"><button class="c-btn sm pri c-acc-solar" data-ld="name" data-sig="k1m2">Name it</button><button class="c-btn sm line" data-ld="dismiss" data-sig="k1m2">Not one appliance</button></div>');
  });
  it('LW-2 a named cluster: its name and colour, kW · min · how often, day and night, Rename only; never a "measured" badge', () => {
    const h = L.loadRow(wh);
    expect(h).toContain('<div class="c-load c-acc-warn"><div class="c-load-h"><b>Water heater</b><span class="c-badge" data-t="l">learned</span><span class="f">5.3 kWh/day</span></div>');
    expect(h).toContain('<p>4.4 kW · 22 min · 6× a day, day and night</p>');
    expect(h).toContain('<button class="c-btn sm line" data-ld="name" data-sig="k2m1-morning">Rename</button>');
    expect(h).not.toContain('data-ld="dismiss"');
    expect(L.loadBadge('measured')).toBe('<span class="c-badge" data-t="e">estimated</span>');
    expect(L.loadRow({ ...oven, name: '<b>x</b>' })).toContain('<b>&lt;b&gt;x&lt;/b&gt;</b>');
    expect(L.loadRow({ ...oven, dismissed: true, suggestion: null })).toContain('<div class="c-btns"><button class="c-btn sm line" data-ld="name" data-sig="k1m2">Name it</button></div>');
  });
  it('LW-3 the words: when, how often, the card figure', () => {
    expect([L.whenText({ from: 16, to: 19 }), L.whenText({ from: 10, to: 14 }), L.whenText({ from: 21, to: 0 }), L.whenText(null)]).toEqual(['4–7 PM', '10 AM–2 PM', 'after 9 PM', 'day and night']);
    expect([L.betweenText({ from: 16, to: 19 }), L.freqText(.43), L.freqText(.57, true), L.freqText(5.6)]).toEqual(['between 4 and 7 PM', '3× a week', '4 times a week', '6× a day']);
    expect(L.loadsFig({ clusters: [oven, wh] })).toBe('2 found');
    expect(L.loadsBody({ clusters: [] })).toContain('8 runs on 4 days');
  });
});

describe('the naming sheet (frame 5)', () => {
  it('LW-4 the suggestion preselected; seven choices; the footer is Not one appliance and Save "Oven"', () => {
    const st = L.sheetState(oven), h = L.nameSheetHtml(oven, st);
    expect(st).toEqual({ choice: 'Oven', other: '' });
    expect(h).toMatch(/^<div class="c-sheet-h"><h4>Name this load<\/h4><button class="c-x" data-close aria-label="Close">/);
    expect(h).toContain('<p class="c-sheet-sub">About 2.6 kW for 50 minutes, 4 times a week, between 4 and 7 PM.</p>');
    expect(h).toContain('<div class="c-day c-acc-solar" style="height:20px">');
    expect(h).toContain('<div class="c-lab">What is it?</div>');
    expect([...h.matchAll(/<button class="c-fpill( on)?" data-pick="([^"]+)" aria-pressed="(true|false)">/g)].map(m => [m[2], !!m[1], m[3]]))
      .toEqual([['Oven', true, 'true'], ['Range', false, 'false'], ['Dishwasher', false, 'false'], ['Dryer', false, 'false'], ['Water heater', false, 'false'], ['EV / tool charger', false, 'false'], ['Other…', false, 'false']]);
    expect(h).toContain('<div class="c-sheet-f"><button class="c-btn line" data-f="sec">Not one appliance</button><button class="c-btn pri c-acc-solar" data-f="pri">Save "Oven"</button></div>');
    expect(h).not.toContain('<input');
  });
  it('LW-5 staged: Other… opens a 24-character field; nothing picked or an empty field disables the save', () => {
    expect(L.nameSheetHtml(oven, { choice: L.OTHER, other: '' })).toContain('<label class="c-field">Name<input class="c-input" id="ldOther" maxlength="24" autocomplete="off" placeholder="e.g. Kiln" value=""></label>');
    expect(L.nameSheetHtml(oven, { choice: L.OTHER, other: '' })).toContain('data-f="pri" disabled>Save</button>');
    expect(L.nameSheetHtml({ ...oven, suggestion: null }, L.sheetState({ ...oven, suggestion: null }))).toContain('data-f="pri" disabled>Save</button>');
    expect(L.nameSheetHtml(oven, { choice: L.OTHER, other: ' Kiln  room ' })).toContain('data-f="pri">Save "Kiln room"</button>');
    expect(L.stagedName({ choice: L.OTHER, other: 'x'.repeat(25) })).toBeNull();
    expect(L.sheetState({ ...wh, name: 'Pottery kiln' })).toEqual({ choice: L.OTHER, other: 'Pottery kiln' });   // a rename keeps the name
    expect(L.sheetState(wh)).toEqual({ choice: 'Water heater', other: '' });
    expect(L.nameSheetHtml(wh, L.sheetState(wh))).toContain('<button class="c-btn pri c-acc-warn" data-f="pri">Save "Water heater"</button>');
  });
});

describe('44 px controls and the new rules', () => {
  const css = readFileSync(new URL('../../web/src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ sels: m[1].split(',').map(s => s.trim()), body: m[2] }));
  const px = (sel, prop) => Math.max(0, ...rules.filter(r => r.sels.includes(sel)).map(r => +(new RegExp(`(?:^|;)\\s*${prop}:\\s*(\\d+)px`).exec(r.body)?.[1] ?? 0)));
  it('LW-6 every control on the rows and the sheet is at least 44 px tall (and the close button 44 wide)', () => {
    for (const sel of ['.c-btn', '.c-btn.sm', '.c-fpill', '.c-x', '.c-input']) expect(Math.max(px(sel, 'min-height'), px(sel, 'height')), sel).toBeGreaterThanOrEqual(44);
    expect(px('.c-x', 'width')).toBeGreaterThanOrEqual(44);
    const tags = [L.loadRow(oven), L.loadRow(wh), L.nameSheetHtml(oven, { choice: L.OTHER, other: '' })].join('').match(/<(button|input)\b[^>]*>/g);
    for (const t of tags) expect(/class="(c-btn|c-fpill|c-x|c-input)\b/.test(t), t).toBe(true);
  });
  it('LW-7 the mockup\'s am-day, am-dlab and am-load* live in the component block as c-day, c-dlab and c-load*', () => {
    for (const sel of ['.c-day', '.c-day i', '.c-dlab', '.c-load', '.c-load-h', '.c-load-h b', '.c-load-h span.f', '.c-load p', '.c-load .c-btns']) expect(rules.some(r => r.sels.includes(sel)), sel).toBe(true);
    expect(css).not.toMatch(/\.am-(day|dlab|load)/);
  });
});
