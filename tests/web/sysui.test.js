// The four-tab layout (approved mockup mockups/al-ia.html v2): Systems segment routing and the old Insights / Panels aliases,
// deep links, the History jump targets, the mini-gauge arc and the one badge component (web/src/lib/sysui.js, lib/conf.js).
import { describe, it, expect } from 'vitest';
import { SEGS, SEG_IDS, VIEWS, route, fromInsights, fromQuery, segIndex, JUMPS, jumpTarget, scrollFor, gaugeArc, hm, k1 } from '../../web/src/lib/sysui.js';
import { cBadge, badge, BADGE_T, TIERS } from '../../web/src/lib/conf.js';

describe('tabs and segments', () => {
  it('four tabs and five Systems segments, in the mockup order', () => {
    expect(VIEWS).toEqual(['v-now', 'v-sys', 'v-hist', 'v-set']);
    expect(SEGS.map(s => s.label)).toEqual(['Home', 'Solar', 'Powerwall', 'Pool', 'AC']);
    expect(segIndex('pool')).toBe(3); expect(segIndex('nope')).toBe(0);
  });
  it('a Systems route keeps its segment; an unknown one opens Home', () => {
    for (const s of SEG_IDS) expect(route('v-sys', s)).toMatchObject({ view: 'v-sys', seg: s });
    expect(route('v-sys', 'bogus')).toMatchObject({ view: 'v-sys', seg: 'home' });
    expect(route('v-sys')).toMatchObject({ view: 'v-sys', seg: 'home' });
  });
  it('the other tabs have no segment; an unknown view goes to Now', () => {
    expect(route('v-hist')).toEqual({ view: 'v-hist', seg: null, anchor: null });
    expect(route('v-set')).toMatchObject({ view: 'v-set', seg: null });
    expect(route('v-nope')).toEqual({ view: 'v-now', seg: null, anchor: null });
  });
});

describe('the old view ids still work for a release', () => {
  it('Insights panels land on the Systems segment that now holds their cards', () => {
    expect(route('v-ins', 'today').seg).toBe('home');
    expect(route('v-ins', 'home').seg).toBe('home');
    expect(route('v-ins', 'appl').seg).toBe('pool');
    expect(route('v-ins', 'plan')).toMatchObject({ seg: 'home', planner: true });
    expect(route('v-ins').seg).toBe('home');
  });
  it('the Panels tab is Systems › Solar', () => expect(route('v-roof')).toMatchObject({ view: 'v-sys', seg: 'solar' }));
  it("the Now sheets' old links (panel, anchor, appliance) map to the right segment and card", () => {
    expect(fromInsights('appl', 'applPool', 'pool')).toMatchObject({ seg: 'pool', anchor: null });
    expect(fromInsights('appl', 'applAc', 'ac')).toMatchObject({ seg: 'ac' });
    expect(fromInsights('appl', 'poolCtl', 'pool')).toMatchObject({ seg: 'pool', anchor: 'sysPoolCtl' });
    expect(fromInsights('home', 'outage')).toMatchObject({ seg: 'powerwall', anchor: 'sysOutage' });
    expect(fromInsights('home', 'pwr')).toMatchObject({ seg: 'powerwall', anchor: 'sysRules' });
  });
  it('push and bookmark queries, old and new', () => {
    const q = s => fromQuery(new URLSearchParams(s));
    expect(q('go=v-ins&p=appl')).toMatchObject({ view: 'v-sys', seg: 'pool' });
    expect(q('go=v-ins&p=home')).toMatchObject({ view: 'v-sys', seg: 'home' });
    expect(q('go=v-ins')).toMatchObject({ view: 'v-sys', seg: 'home' });
    expect(q('go=v-roof&panel=r1c3')).toMatchObject({ view: 'v-sys', seg: 'solar' });
    expect(q('go=v-sys&p=powerwall')).toMatchObject({ view: 'v-sys', seg: 'powerwall' });
    expect(q('go=v-hist&bills=1')).toMatchObject({ view: 'v-hist', anchor: 'hjBills' });
    expect(q('go=v-now')).toMatchObject({ view: 'v-now' });
    expect(q('go=javascript:alert(1)')).toBeNull();
    expect(q('p=pool')).toBeNull();
  });
});

describe('History jump chips', () => {
  it('Energy · Battery · Outages · Bills, each with its section', () => {
    expect(JUMPS.map(j => j[1])).toEqual(['Energy', 'Battery', 'Outages', 'Bills']);
    expect(jumpTarget('bills')).toBe('hjBills'); expect(jumpTarget('battery')).toBe('hjBattery'); expect(jumpTarget('x')).toBeNull();
  });
  it('scrolls the section to just under the top, never above 0', () => {
    expect(scrollFor(900, 100, 300, 12)).toBe(1088);
    expect(scrollFor(50, 100, 0, 12)).toBe(0);
  });
});

describe('drawing helpers', () => {
  it('the gauge arc runs 240° from the bottom left (the mockup paths)', () => {
    expect(gaugeArc(1)).toBe('M11.2 42.0 A24 24 0 1 1 52.8 42.0');
    expect(gaugeArc(.75)).toBe('M11.2 42.0 A24 24 0 0 1 52.8 18.0');
    expect(gaugeArc(-1)).toBe(gaugeArc(0)); expect(gaugeArc(2)).toBe(gaugeArc(1));
  });
  it('run time and kWh figures', () => {
    expect(hm(64)).toBe('1h 4m'); expect(hm(null)).toBe('—');
    expect(k1(14.849)).toBe('14.8'); expect(k1(NaN)).toBe('—');
  });
});

describe('badge vocabulary (frame 18)', () => {
  it('each confidence tier has its c-badge look; dormant and unscored are the dashed one', () => {
    for (const tier of Object.keys(TIERS)) expect(cBadge(tier)).toBe(`<span class="c-badge" data-t="${BADGE_T[tier]}">${tier}</span>`);
    expect(BADGE_T.dormant).toBe('u'); expect(BADGE_T.measured).toBe('m'); expect(BADGE_T.learned).toBe('l'); expect(BADGE_T.estimated).toBe('e');
    expect(cBadge('bogus')).toBe(''); expect(cBadge(undefined)).toBe('');
  });
  it('fixed words: simulation, live, model, new, and the neutral badge', () => {
    expect(badge('simulation')).toBe('<span class="c-badge" data-t="sim">simulation</span>');
    expect(badge('live', 'Live')).toBe('<span class="c-badge" data-t="live">Live</span>');
    expect(badge('model')).toBe('<span class="c-badge" data-t="e">model</span>');
    expect(badge('new')).toBe('<span class="c-badge" data-t="new">new</span>');
    expect(badge('', '4 in 12 months')).toBe('<span class="c-badge">4 in 12 months</span>');
    expect(badge('toString', '<b>')).toBe('<span class="c-badge">&lt;b&gt;</span>');
  });
});
