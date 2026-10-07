// Now's markup and its sheets (approved mockup mockups/al-ia.html v2): guests never get a control, and the sheets write only through
// routes that already existed. Static checks on the source, so they run under node.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const html = read('web/index.html'), now = html.slice(html.indexOf('id="v-now"'), html.indexOf('<!-- ================= HISTORY'));
const tag = id => now.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? '';

describe('Now markup (frames 1, 2, 17)', () => {
  it('the hub, the banner slot, the Vacation pill and the replay row are owner-only; the guest pill is guest-only', () => {
    for (const id of ['hub', 'banSlot', 'vacPill']) expect(tag(id)).toContain('data-owner');
    expect(now).toMatch(/<div class="c-scrub twin-row" data-owner>/);
    expect(tag('chipGuest')).toContain('data-guest');
  });
  it('exactly two pills, and the old chips, banners and cards are gone from Now', () => {
    expect(now.match(/class="c-pill[ "]/g)).toHaveLength(3);   // Status, Vacation (owner) and the guest pill
    for (const id of ['chipGw', 'chipNws', 'chipErcot', 'chipStorm', 'vacNow', 'digestNow', 'billDueNow', 'wxSum']) expect(now).not.toContain(`id="${id}"`);
    expect(now).not.toContain('class="banner"');
  });
  it('placeholders are skeletons, not "connecting…" or a dash', () => {
    expect(tag('synced')).toBeTruthy(); expect(now).not.toContain('connecting…');
    for (const id of ['soc', 'story', 'statusTxt', 'pwPct', 'pwSum', 'fcTxt']) expect(now.slice(now.indexOf(`id="${id}"`), now.indexOf(`id="${id}"`) + 200)).toContain('c-skel');
  });
  it('the tab bar is the floating glass bar with its four tabs: Now · Systems · History · Settings (Batch 4)', () => {
    expect([...html.matchAll(/<button class="c-tab[ "][^>]*data-v="(v-[a-z]+)"/g)].map(m => m[1])).toEqual(['v-now', 'v-sys', 'v-hist', 'v-set']);
    expect(html).not.toContain('id="v-ins"'); expect(html).not.toContain('id="v-roof"');
  });
});

describe('Now sheets write only through existing routes', () => {
  const api = read('web/src/lib/api.js'), methods = new Set([...api.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]));
  const files = ['web/src/views/nowsheets.js', 'web/src/views/nowhub.js', 'web/src/views/csheet.js', 'web/src/views/now.js'];
  it('no fetch of their own, and every api call is one api.js already had', () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bfetch\(/);
      for (const [, m] of src.matchAll(/\bapi\.(\w+)\(/g)) expect(methods.has(m), `${f}: api.${m}`).toBe(true);
    }
  });
  it('the device writes the sheets make are the known ones', () => {
    const used = new Set(files.flatMap(f => [...read(f).matchAll(/\bapi\.(\w+)\(/g)].map(m => m[1])));
    const writes = [...used].filter(m => !['pool', 'ac', 'day', 'pwRules', 'vacation'].includes(m));
    expect(writes.sort()).toEqual(['acCommand', 'acHold', 'acSettings', 'acUntrim', 'poolApplyTomorrow', 'poolAutopilot'].sort());
  });
  it('staged writes: the pump dial, toggles and segments only change state; the footer primary sends', () => {
    const src = read('web/src/views/nowsheets.js');
    // every poolSend / api write sits in a footer handler, a named mode-line action or a banner button
    const sends = [...src.matchAll(/(poolSend|api\.(acCommand|acSettings|poolAutopilot))\(/g)].length;
    expect(sends).toBeGreaterThan(0);
    expect(src).not.toMatch(/onMove:[^\n]*(poolSend|api\.)/);
    expect(src).not.toMatch(/onSet:[^\n]*(poolSend|api\.)/);
  });
});
