// Batch 5: the older small sheets on the component system (approved mockup mockups/al-ia.html, component 11) and S-15, "Sign out
// this device". Each sheet's markup comes from a pure builder, so these run under node: every control in a sheet is a c- component,
// the write sits in the pinned footer, and the stylesheet gives each of those controls a 44 px touch target.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

let water, ac, appl, hist, share;
beforeAll(async () => {
  // the view modules start their pollers and look up a few nodes at import; nothing here renders into a page
  vi.stubGlobal('document', { hidden: true, addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } });
  vi.stubGlobal('addEventListener', () => {});
  [water, ac, appl, hist, share] = await Promise.all(['water', 'ac', 'appliances', 'history', 'share'].map(f => import(`../../web/src/views/${f}.js`)));
});

/* ---------- the stylesheet: the rule for a selector, and its touch target ---------- */
const css = readFileSync(new URL('../../web/src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ sels: m[1].split(',').map(s => s.trim()), body: m[2] }));
const px = (body, prop) => { const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(body); return m ? +m[1] : null; };
/** The largest min-height/height (and width/min-width) any rule written exactly for `sel` gives it. */
function target(sel) {
  const own = rules.filter(r => r.sels.includes(sel));
  const h = Math.max(0, ...own.flatMap(r => [px(r.body, 'min-height'), px(r.body, 'height')]).filter(v => v != null));
  const w = Math.max(0, ...own.flatMap(r => [px(r.body, 'min-width'), px(r.body, 'width')]).filter(v => v != null));
  return { h, w, found: own.length > 0 };
}

/* ---------- the markup: every control, and which component it is ---------- */
const SEG = /<div class="c-seg\b[^"]*"[^>]*>[\s\S]*?<\/div>/g;   // a segment holds only its buttons
const cls = tag => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean);
/** Every interactive control outside the segments ([tag, classes]), the segments' buttons, the footer. */
function controls(html) {
  const segs = html.match(SEG) ?? [], rest = html.replace(SEG, '');
  const tags = [...rest.matchAll(/<(button|input|select|textarea)\b[^>]*>|<[a-z]+\b[^>]*\brole="(?:button|switch)"[^>]*>/g)].map(m => m[0]);
  return { tags, segButtons: segs.flatMap(s => s.match(/<button\b[^>]*>/g) ?? []), segs, foot: /<div class="c-sheet-f">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '' };
}
const BASE = ['c-btn', 'c-step', 'c-x', 'c-fpill', 'c-input'];
/** Each sheet: on the component shell, every control a c- component with a 44 px target, the write in the footer. */
function checkSheet(html, { pri, sec = null }) {
  expect(html).toMatch(/^<div class="c-sheet-h"><h4>/);
  expect(html).toContain('<button class="c-x" data-close aria-label="Close">');
  for (const old of ['class="shead"', 'class="x"', 'class="primary"', 'class="link', 'class="danger"', 'seg2', 'pc-runs', 'pw-chips', 'ag-chips']) expect(html, old).not.toContain(old);
  const { tags, segButtons, segs, foot } = controls(html);
  for (const t of tags) {
    const c = cls(t);
    expect(c.some(x => x.startsWith('c-')), t).toBe(true);
    const sel = t.includes('role="button"') && c.includes('c-part') ? '.c-part[role=button]' : `.${c.find(x => BASE.includes(x))}`;
    expect(sel, t).not.toBe('.undefined');
    const { h, w } = target(sel);
    expect(h, `${sel} min-height`).toBeGreaterThanOrEqual(44);
    if (sel === '.c-x' || sel === '.c-step') expect(w, `${sel} width`).toBeGreaterThanOrEqual(44);
    if (c.includes('c-btn') && c.includes('sm')) expect(target('.c-btn.sm').h).toBeGreaterThanOrEqual(44);
  }
  if (segButtons.length) expect(target('.c-seg button').h).toBeGreaterThanOrEqual(44);
  for (const s of segs) expect(s).toMatch(/style="--n:\d+;--i:\d+"/);
  expect(foot).toMatch(new RegExp(`<button class="c-btn pri [^"]*" data-f="pri">${pri}</button>$`));
  if (sec) expect(foot).toContain(`data-f="sec">${sec}</button>`); else expect(foot).not.toContain('data-f="sec"');
  return { tags, segButtons };
}

describe('the older small sheets are component sheets (44 px controls, the write in the footer)', () => {
  it('Log a test: steppers, the water and the source as segments, Added today as toggle pills, Save test', () => {
    const v = { fc: 3, ph: 7.5, cc: null, ta: null, cya: null, ch: null, clarity: 'hazy', added: ['acid'], source: 'kit' };
    const html = water.logTestHtml(v, '3:05 PM', 84.2);
    const { tags, segButtons } = checkSheet(html, { pri: 'Save test' });
    expect(tags.filter(t => t.includes('c-step'))).toHaveLength(12);   // six values, − and +
    expect(tags.filter(t => t.includes('c-fpill'))).toHaveLength(5);
    expect(html).toContain('data-a="acid" aria-pressed="true"');
    expect(segButtons).toHaveLength(6);   // Clear Hazy Cloudy Green · Drop kit Pool store
    expect(html).toMatch(/<button data-c="hazy" class="on" aria-pressed="true">Hazy<\/button>/);
    expect(html).toContain('Today, 3:05 PM · water 84° (from the controller)');
  });
  it('Comfort: stepper rows, the night hours as buttons, pre-cool and drift as segments, Save', () => {
    const v = { dayF: 78, nightF: 77, precoolDepth: 2, driftF: 1, awayF: 82, nightFrom: 22, nightTo: 7 };
    const html = ac.comfortHtml(v);
    const { tags, segButtons } = checkSheet(html, { pri: 'Save' });
    expect(tags.filter(t => t.includes('c-step'))).toHaveLength(6);
    expect(tags.filter(t => /data-h="night(From|To)"/.test(t) && t.includes('c-btn sm'))).toHaveLength(2);
    expect(segButtons).toHaveLength(7);
    expect(html).toMatch(/<span data-c="precoolDepth"><div class="c-seg sm[^"]*" style="--n:4;--i:2"/);
  });
  it('Pump schedule: runs as rows, the circuit segment, the time fields, the speed stepper; Delete this run beside Save', () => {
    const html = appl.scheduleHtml({ runs: [{ circuitId: 6, start: 600, stop: 1140 }, { circuitId: 8, start: 840, stop: 900 }], sel: 1,
      names: { 6: 'Pool', 8: 'High Speed' }, speeds: { 6: 1500, 8: 2400 }, P: 6, B: 8 });
    const { tags, segButtons } = checkSheet(html, { pri: 'Save to the controller', sec: 'Delete this run' });
    expect(tags.filter(t => t.includes('role="button"') && t.includes('c-part'))).toHaveLength(2);
    expect(tags.filter(t => t.includes('c-input') && t.includes('type="time"'))).toHaveLength(2);
    expect(html).toContain('id="seAdd"');
    expect(segButtons).toHaveLength(2);
    expect(html).toContain('c-part c-acc-warn c-open');   // the run being edited
    // no run selected: no Delete
    const none = appl.scheduleHtml({ runs: [], sel: -1, names: { 6: 'Pool', 8: 'High Speed' }, speeds: { 6: 1500, 8: 2400 }, P: 6, B: 8 });
    checkSheet(none, { pri: 'Save to the controller' });
  });
  it('a circuit: Run for as a segment and the speed stepper; the spa adds its heat segment and setpoint; Turn off in the footer', () => {
    const runs = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h']], lim = { min: 450, max: 3450 };
    const pump = appl.circuitHtml({ c: { id: 6, name: 'Pool', on: false }, sched: [], body: null, runs, pick: 60, rpm0: 1500, lim });
    const p = checkSheet(pump, { pri: '' });
    expect(p.tags.filter(t => t.includes('c-step'))).toHaveLength(2);
    expect(p.segButtons).toHaveLength(4);
    const spa = appl.circuitHtml({ c: { id: 1, name: 'Spa', on: true }, sched: [{ start: 1080, stop: 1200 }], body: { heatMode: 3, setPoint: 100, heating: true }, runs: [...runs, [720, '12 h']], pick: 60, rpm0: null, lim });
    const s = checkSheet(spa, { pri: '', sec: 'Turn off' });
    expect(s.segButtons).toHaveLength(7);   // heat Off/On · five run lengths
    expect(spa).toContain('id="pcHdn"');
    expect(spa).toMatch(/class="c-btn del" data-f="sec"/);
  });
  it('a bill: its lines as a key/value card; Remove this bill is the footer’s one write', () => {
    const r = { billDate: '2026-09-12', period: { from: '2026-08-10', to: '2026-09-09', days: 31 }, pec: { deliveredKwh: 900, receivedKwh: 300 },
      tesla: { importKwh: 905.2, exportKwh: 298.7 }, charges: [{ label: 'Energy', kwh: 900, rate: '0.07', amount: 10 }], total: 20 };
    const html = hist.billDetailHtml(r);
    const { tags } = checkSheet(html, { pri: 'Remove this bill' });
    expect(tags).toHaveLength(2);   // the close and the footer
    expect(html).toContain('<div class="c-kv">');
    expect(html).toContain('c-btn pri c-acc-out');
  });
  it('Share: the label field, the expiry segment, Create link; a new link’s Copy / Share / QR; Revoke and Revoke all links', () => {
    const link = { id: 'a1', label: 'Sam', state: 'active', createdAt: '2026-10-01T12:00:00Z', expiresAt: null, openedCount: 0 };
    const form = share.shareHtml({ active: [link] });
    const f = checkSheet(form, { pri: 'Create link', sec: 'Revoke all links' });
    expect(f.tags.filter(t => t.includes('c-input') && t.includes('id="shareLabel"'))).toHaveLength(1);
    expect(f.segButtons).toHaveLength(5);
    expect(f.tags.filter(t => t.includes('data-rvk'))).toHaveLength(1);
    const made = share.shareHtml({ created: { label: 'Sam', url: 'https://example.test/#s=abcdefghijklmnopqrstu', expiresAt: null } });
    const m = checkSheet(made, { pri: 'Done' });
    expect(m.tags.filter(t => /id="lnk(Copy|Share|Qr)"/.test(t) && t.includes('c-btn sm'))).toHaveLength(3);
  });
  it('Owner devices: each device’s Sign out, Sign out this device, Sign out other devices beside Done', () => {
    const list = [{ id: 'me', label: 'iPhone · Safari', current: true }, { id: 'b2', label: 'Mac · Chrome', current: false, lastSeen: new Date(Date.now() - 7200e3).toISOString() }];
    const html = share.devicesHtml(list);
    const { tags } = checkSheet(html, { pri: 'Done', sec: 'Sign out other devices' });
    expect(tags.filter(t => t.includes('data-dev="b2"'))).toHaveLength(1);
    expect(html).toMatch(/<button class="c-btn del block" id="devSelf"[^>]*>Sign out this device<\/button>/);
    expect(html).toContain('This iPhone<small>Safari · now</small>');
    checkSheet(share.devicesHtml([list[0]]), { pri: 'Done' });   // alone: no "other devices"
  });
  it('the new field component exists and is a 44 px target', () => {
    expect(target('.c-input').h).toBeGreaterThanOrEqual(44);
    expect(target('.c-field').found).toBe(true);
  });
});

/* ---------- S-15 · Sign out this device ---------- */
describe('Sign out this device (S-15)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });
  const ok = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

  it('drops this browser’s push subscription first, then POSTs /api/auth/signout, then reloads', async () => {
    const order = [], calls = [];
    globalThis.fetch = vi.fn(async (url, init) => { order.push('signout'); calls.push([url, init?.method]); return ok(); });
    const unsub = vi.fn(async () => { order.push('unsub'); }), reload = vi.fn(() => order.push('reload'));
    await share.signOutHere({ unsub, reload });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([['/api/auth/signout', 'POST']]);
    expect(order).toEqual(['unsub', 'signout', 'reload']);
  });
  it('a failing unsubscribe doesn’t stop the sign-out; a failing sign-out doesn’t reload', async () => {
    globalThis.fetch = vi.fn(async () => ok());
    const reload = vi.fn();
    await share.signOutHere({ unsub: async () => { throw new Error('no worker'); }, reload });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/signout', expect.objectContaining({ method: 'POST' }));
    expect(reload).toHaveBeenCalledTimes(1);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }) }));
    const reload2 = vi.fn();
    await expect(share.signOutHere({ unsub: async () => {}, reload: reload2 })).rejects.toThrow('nope');
    expect(reload2).not.toHaveBeenCalled();
  });
  it('the button asks first: one tap arms it, the second signs out; left alone it disarms', async () => {
    vi.useFakeTimers();
    const btn = { dataset: { arm: '' }, textContent: 'Sign out this device', disabled: false, setAttribute() {} };
    const go = vi.fn(async () => {});
    expect(share.signOutTap(btn, go)).toBe(false);
    expect(go).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('Tap again to sign out');
    vi.advanceTimersByTime(4000);
    expect(btn.textContent).toBe('Sign out this device');   // disarmed
    share.signOutTap(btn, go); await share.signOutTap(btn, go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
  });
  it('the button in the sheet, through signOutHere, posts auth/signout and calls the unsubscribe', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ok());
    const unsub = vi.fn(async () => {}), reload = vi.fn();
    const btn = { dataset: { arm: '' }, textContent: 'Sign out this device', disabled: false, setAttribute() {} };
    share.signOutTap(btn, () => share.signOutHere({ unsub, reload }));
    await share.signOutTap(btn, () => share.signOutHere({ unsub, reload }));
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/signout', expect.objectContaining({ method: 'POST' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
