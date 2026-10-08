// The "Your week" card's numbers (web/src/lib/digest.js, approved mockup mockups/t-enhancements.html frame 1).
import { describe, it, expect } from 'vitest';
import { kwh0, delta0, weekLabel, prevWeekDate, leadHtml, deltaClass, gridCells, gridHtml, autopilotLines, rulesMode, anomalyHtml, stripHtml, badgesHtml } from '../../web/src/lib/digest.js';

const d = {
  week: '2026-W39', from: '2026-09-21', to: '2026-09-27',
  totals: { days: 7, solarKwh: 312.4, homeKwh: 512.2, importKwh: 235.6, exportKwh: 36.3, sunsharePct: 54 },
  vsLastWeek: { solarKwh: 18.2, homeKwh: -9.4, importKwh: -31, exportKwh: 4.1, sunsharePts: 6 },
  powerwall: { fullDays: 6, daysWithData: 7, lowestPct: 20 },
  autopilot: { pool: { applied: 7, suggested: 0, refused: 0, lines: [] }, ac: { set: 11, refused: 0, lines: [] }, powerwall: { sent: 0, refused: 0, suggested: 1, scopeMissing: 0 } },
  anomalies: { open: 1, openedThisWeek: 1, items: [{ kind: 'home.day', title: 'Tue used 14 kWh more than a 91° day usually does', severity: 'warn', day: '2026-09-22' }] },
  confidence: { 'fc48.solar': 'learned', 'ac.shifted': 'learned', 'pool.kwhDay': 'learning', 'fc48.soc': 'estimated' },
};

describe('digest number formatting', () => {
  it('rounds kWh to whole numbers with separators', () => {
    expect(kwh0(312.4)).toBe('312'); expect(kwh0(1204.6)).toBe('1,205'); expect(kwh0(0)).toBe('0'); expect(kwh0(null)).toBe('—');
  });
  it('signs changes with a plus or a true minus, and zero plainly', () => {
    expect(delta0(18.2)).toBe('+18'); expect(delta0(-9.4)).toBe('−9'); expect(delta0(-0.4)).toBe('0'); expect(delta0(1500)).toBe('+1,500'); expect(delta0(null)).toBe('—');
  });
  it('labels the ISO week with its Monday and Sunday', () => {
    expect(weekLabel(d)).toBe('Week 39 · Mon Sep 21 – Sun Sep 27');
    expect(prevWeekDate(d)).toBe('2026-09-14');
  });
  it('writes the sunshine lead with the change in points', () => {
    expect(leadHtml(d)).toBe('<b>54%</b> of what the house used came from sunshine, up 6 points on the week before.');
    expect(leadHtml({ ...d, vsLastWeek: { ...d.vsLastWeek, sunsharePts: -1 } })).toMatch(/down 1 point on/);
    expect(leadHtml({ ...d, vsLastWeek: null })).toBe('<b>54%</b> of what the house used came from sunshine.');
    expect(leadHtml({ ...d, totals: { ...d.totals, sunsharePct: null } })).toMatch(/Not enough data/);
  });
  it('colours each change the way the mockup does', () => {
    expect(deltaClass('solarKwh', 18)).toBe('up'); expect(deltaClass('solarKwh', -22)).toBe('dn');
    expect(deltaClass('importKwh', -31)).toBe('up'); expect(deltaClass('importKwh', 30)).toBe('dn');
    expect(deltaClass('homeKwh', -9)).toBe(''); expect(deltaClass('homeKwh', 12)).toBe('dn');
    expect(deltaClass('exportKwh', 4)).toBe(''); expect(deltaClass('solarKwh', .2)).toBe('');
  });
  it('builds the four cells as the mockup shows them', () => {
    expect(gridCells(d)).toEqual([
      ['Solar', '312', '+18 vs last wk', 'up'], ['Used', '512', '−9 vs last wk', ''],
      ['Bought from PEC', '236', '−31 vs last wk', 'up'], ['Sent to PEC', '36', '+4 vs last wk', '']]);
    expect(gridCells({ ...d, vsLastWeek: null })[0]).toEqual(['Solar', '312', 'no week before', '']);
    expect(gridCells(d, 'wk 37')[0][2]).toBe('+18 vs wk 37');
    expect(gridHtml([gridCells(d)[0]])).toBe('<div><small>Solar</small><b>312 <small>kWh</small></b><em class="up">+18 vs last wk</em></div>');
  });
  it('writes one line per Autopilot from the counts, with no dollar figure', () => {
    const [pool, ac, pw] = autopilotLines(d, { pool: 'auto', ac: 'auto', powerwall: 'Suggest' });
    expect(pool.slice(2)).toEqual(['Pool · Auto.', 'Wrote 7 nightly plans.']);
    expect(ac.slice(2)).toEqual(['AC · Auto.', '11 setpoint writes. None refused by the safety clamps.']);
    expect(pw.slice(2)).toEqual(['Powerwall rules · Suggest.', '1 suggestion, not applied. Powerwalls full 6 of 7 days.']);
    expect(autopilotLines(d, { pool: 'suggest' })[0][3]).toBe('0 plans suggested, 7 applied.');
    expect(JSON.stringify(autopilotLines(d, {}))).not.toMatch(/\$/);
  });
  it('names the rules mode', () => {
    expect(rulesMode({ reserve: 'suggest', storm: 'suggest', export: 'suggest' })).toBe('Suggest');
    expect(rulesMode({ reserve: 'auto', storm: 'suggest', export: 'suggest' })).toBe('1 in Auto');
    expect(rulesMode({ reserve: 'off', storm: 'off', export: 'off' })).toBe('Off');
  });
  it('writes the anomaly line and the learning badges', () => {
    expect(anomalyHtml(d)).toBe('<b>Worth a look:</b> Tue used 14 kWh more than a 91° day usually does.');
    expect(anomalyHtml({ ...d, anomalies: { open: 0, items: [] } })).toBeNull();
    const html = badgesHtml(d, { models: [{ id: 'fc48.solar', tier: 'learned', v: '±4%' }, { id: 'pool.kwhDay', tier: 'learning', v: 'learning · 18 of 30' }] });
    expect(html).toContain('<span class="conf" data-t="l">solar model ±4%</span>');
    expect(html).toContain('<span class="conf" data-t="n">pump curve learning · 18 of 30</span>');
    expect(html).toContain('<span class="conf" data-t="e">48 h forecast estimated</span>');
    expect(badgesHtml({ ...d, confidence: {} })).toBe('');
  });
});

describe('the strip heat line (mockup am frame 7)', () => {
  it('reads "Strip heat: 3 mornings · 31 kWh (2 after setbacks)." and is absent without strip mornings', () => {
    expect(stripHtml({ ...d, strip: { mornings: 3, kwh: 31, setbacks: 2 } })).toBe('<b>Strip heat:</b> 3 mornings · 31 kWh (2 after setbacks).');
    expect(stripHtml({ ...d, strip: { mornings: 1, kwh: 6.4, setbacks: 0 } })).toBe('<b>Strip heat:</b> 1 morning · 6 kWh.');
    expect(stripHtml(d)).toBeNull();
  });
});
