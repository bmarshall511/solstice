// Batch 4 (approved mockup mockups/al-ia.html v2, frames 9–15 and 18): Systems, History and Settings. Static checks on the source,
// so they run under node: the page skeletons, what a guest never gets, the writes the pages may make, the push links, the badges.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { SEG_IDS, JUMPS, VIEWS } from '../../web/src/lib/sysui.js';

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const html = read('web/index.html');
const section = id => { const i = html.indexOf(`id="${id}"`); return html.slice(i, html.indexOf('</section>', i)); };
const page = seg => { const s = section('v-sys'), i = s.indexOf(`id="sp-${seg}"`), j = s.indexOf('class="sys-page', i + 10); return s.slice(i, j < 0 ? undefined : j); };
const tag = (src, id) => src.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? '';

describe('Systems (frames 9–13b)', () => {
  it('one segment row, Home · Solar · Powerwall · Pool · AC, each with its page', () => {
    const sys = section('v-sys');
    expect([...sys.matchAll(/data-seg="(\w+)"/g)].map(m => m[1])).toEqual(SEG_IDS);
    for (const s of SEG_IDS) expect(sys).toContain(`id="sp-${s}"`);
    expect(sys).toMatch(/class="c-seg sys[^"]*" id="sysSeg" role="tablist"/);
  });
  it('every page opens on its Live card (a system card over its scene)', () => {
    const first = { home: 'homeLive', solar: 'solarLive', powerwall: 'pwLive', pool: 'poolLive', ac: 'acLive' };
    for (const [s, id] of Object.entries(first)) { const p = page(s); expect(p.indexOf('class="c-card'), s).toBe(p.indexOf(`<div class="c-card flush" id="${id}"`) + 5); }
  });
  it('Pool and AC follow the skeleton: Live → Controls → Autopilot (a disclosure)', () => {
    const pool = page('pool'), ac = page('ac');
    expect(pool.indexOf('id="poolLive"')).toBeLessThan(pool.indexOf('id="sysPoolCtl"'));
    expect(pool.indexOf('id="sysPoolCtl"')).toBeLessThan(pool.indexOf('id="poolAuto"'));
    expect(tag(pool, 'poolAuto')).toContain('c-disc');
    expect(ac.indexOf('id="acLive"')).toBeLessThan(ac.indexOf('id="acTstat"'));
    expect(ac.indexOf('id="acTstat"')).toBeLessThan(ac.indexOf('id="acAuto"'));
    expect(tag(ac, 'acAuto')).toContain('c-disc');
    for (const [p, rows] of [[pool, ['Schedule &amp; goal', 'Why', 'Rules', 'Log']], [ac, ['Today’s plan', 'Why', 'Rules', 'Log']]]) {
      const at = rows.map(r => p.indexOf(`<b>${r}</b>`)); expect(at.every(x => x > 0)).toBe(true); expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });
  it('a guest gets no control: the panels, mode segments, rules, steppers and the owner-only cards carry data-owner', () => {
    for (const id of ['sysPoolCtl', 'autoMode', 'acTstat', 'acMode', 'sysRules', 'egCard', 'learnCard', 'tripsCard', 'pwCard', 'bcCard', 'spCard', 'flowSum']) expect(tag(html, id), id).toContain('data-owner');
    expect(page('pool')).toMatch(/<div data-owner>\s*<div class="c-stepper">/);   // the goal steppers and Edit schedule
    expect(tag(html, 'nightCard')).toContain('data-guest');   // a guest keeps the overnight baseline as a card
  });
  it('"About panel-level data" is gone; the roof stays house, panels, Powerwalls', () => {
    expect(html).not.toContain('About panel-level data');
    expect(page('solar')).toMatch(/data-r="out"[^>]*>Output<\/button><button data-r="pp"[^>]*><span>Per panel<\/span><\/button><button data-r="bars"[^>]*>Hour bars/);
  });
});

describe('History (frame 14) and Settings (frame 15)', () => {
  it('the jump chips match their sections, in order', () => {
    const h = section('v-hist');
    expect([...h.matchAll(/data-j="(\w+)"/g)].map(m => m[1])).toEqual(JUMPS.map(j => j[0]));
    const at = JUMPS.map(j => h.indexOf(`id="${j[2]}"`)); expect(at.every(x => x > 0)).toBe(true); expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it('one Bill analysis card holds the four charts behind Meter · Waterfall · Cycle · Monthly', () => {
    const h = section('v-hist'), card = h.slice(h.indexOf('id="billAnalysis"'));
    expect([...card.matchAll(/data-b="(\w+)"/g)].map(m => m[1])).toEqual(['meter', 'wf', 'cycle', 'monthly']);
    for (const id of ['meterChart', 'waterfall', 'cycBar', 'billChart']) expect(card).toContain(`id="${id}"`);
  });
  it('Settings: Connections has absorbed Data health; Alerts and Sharing are owner-only; Preview is the demo', () => {
    const s = section('v-set');
    expect(html).not.toContain('id="dhList"');
    expect(s).toContain('id="connCard"');
    expect(tag(s, 'alertCard')).toContain('data-owner'); expect(tag(s, 'reserveRow')).toContain('data-owner');
    expect(s).toMatch(/<div class="c-lab" data-owner>Sharing<\/div>\s*<div class="c-card flush" data-owner/);
    expect(s).toContain('Show the outage look'); expect(s).toContain('demo · nothing is simulated');
  });
});

describe('the pages write only through routes that already existed', () => {
  const api = read('web/src/lib/api.js'), methods = new Set([...api.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]));
  const views = ['systems', 'timeline', 'settings', 'history', 'appliances', 'ac', 'powerwall', 'insights', 'learn', 'panels', 'outage', 'water', 'vacation'];
  const calls = f => [...read(`web/src/views/${f}.js`).matchAll(/\bapi\.(\w+)\(/g)].map(m => m[1]);
  it('no fetch of their own, and every api call is one api.js has', () => {
    for (const f of views) { expect(read(`web/src/views/${f}.js`), f).not.toMatch(/\bfetch\(/); for (const m of calls(f)) expect(methods.has(m), `${f}: api.${m}`).toBe(true); }
  });
  it('Systems, the header and the log sheet write nothing', () => {
    for (const f of ['systems', 'timeline']) expect(calls(f), f).toEqual([]);
  });
  it('the Pool and AC pages make only the writes they always had', () => {
    const reads = ['pool', 'ac', 'appliances', 'poolWater', 'events', 'vacation', 'vacationTrips', 'models'];
    expect([...new Set(calls('appliances'))].filter(m => !reads.includes(m)).sort()).toEqual(['addEvent', 'poolApplyTomorrow', 'poolAutopilot', 'poolClearUp', 'poolCommand', 'poolGoal', 'poolSchedule', 'poolSuggestion'].sort());
    expect([...new Set(calls('ac'))].filter(m => !reads.includes(m)).sort()).toEqual(['acApply', 'acNudge', 'acSettings', 'acSuggestion', 'acUntrim'].sort());
  });
  it('the AC Autopilot and Pool Autopilot modes are staged: a segment tap only changes state, the named row sends', () => {
    for (const f of ['appliances', 'ac']) {
      const src = read(`web/src/views/${f}.js`);
      expect(src, f).toMatch(/const apStage = \{ m: null, sending: false \}/);
      expect(src, f).toMatch(/if \(b\) \{ apStage\.m = /);   // the segment's handler returns before any send
    }
  });
});

describe('links, badges and the four tabs', () => {
  it('push links name a tab and, for Systems, a segment (no v-ins or v-roof)', () => {
    const dir = new URL('../../server/src/', import.meta.url), files = [];
    const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : e.name.endsWith('.ts') && files.push(readFileSync(new URL(e.name, d), 'utf8')));
    walk(dir);
    const urls = files.flatMap(s => [...s.matchAll(/['`](\/\?go=[^'`]+)['`]/g)].map(m => m[1]));
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) {
      const q = new URLSearchParams(u.slice(2));
      expect(VIEWS, u).toContain(q.get('go'));
      if (q.get('go') === 'v-sys') expect(SEG_IDS, u).toContain(q.get('p'));
    }
    expect(read('web/public/sw.js')).toContain("'/?go=v-sys&p=powerwall'");
  });
  it('the pages Batch 4 rebuilt use the one badge component, not the old .conf / .badge', () => {
    for (const f of ['systems', 'timeline', 'settings', 'history', 'appliances', 'ac', 'powerwall', 'insights', 'learn', 'panels', 'outage', 'water'])
      expect(read(`web/src/views/${f}.js`), f).not.toMatch(/confChip|class="conf"|class="badge|'badge'|className = 'badge/);
    for (const id of ['v-sys', 'v-hist', 'v-set']) expect(section(id), id).not.toMatch(/class="(badge|conf)[ "]/);
  });
});
