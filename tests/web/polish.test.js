// Polish from the overnight UI walk on the offline demo (2026-10-08): rules for form that the screens must keep.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { svgText } from '../../web/src/lib/util.js';

const css = readFileSync(new URL('../../web/src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = ['views/powerwall.js', 'views/settings.js'].map(f => readFileSync(new URL(`../../web/src/${f}`, import.meta.url), 'utf8')).join('\n');

describe('fonts never fall back to a serif', () => {
  it('every font / font-family naming Manrope or JetBrains Mono also names a generic family', () => {
    const decls = [...css.matchAll(/(?<![-\w])font(?:-family)?:([^;}]*)/g)].map(m => m[1]).filter(d => /Manrope|JetBrains Mono/.test(d));
    expect(decls.length).toBeGreaterThan(50);
    expect(decls.filter(d => !/sans-serif|monospace/.test(d))).toEqual([]);
    expect(js.match(/font:[^"`]*JetBrains Mono'(?!,)/g) ?? []).toEqual([]);
  });
  it('SVG text gets the same stacks', () => {
    expect(svgText(0, 0, 'x')).toContain(`font-family="'JetBrains Mono',ui-monospace,monospace"`);
    expect(svgText(0, 0, 'x', { font: 'Manrope' })).toContain('font-family="Manrope,system-ui,sans-serif"');
    expect(svgText(0, 0, 'x', { font: 'Georgia' })).toContain('font-family="Georgia"');
  });
});

describe('the closed sheet is fully off-screen', () => {
  it('moves down by its height plus the gap, not 110% (a short empty sheet left a 3 px sliver above the bottom edge)', () => {
    expect(css).toMatch(/\.sheet\{[^}]*transform:translateY\(calc\(100% \+ 24px\)\)/);
    expect(css).not.toMatch(/\.sheet\{[^}]*translateY\(110%\)/);
  });
});

describe('Settings › History back to', () => {
  it('draws its progress bar in the battery green (mockup am frame 9)', () => {
    expect(js).toContain('<div class="c-bar c-acc-batt"');
  });
});

describe('the private card', () => {
  it('"I’m the owner" is a 44 px target (it measured 17 px tall on the demo)', () => {
    const rule = css.match(/\.authcard \.olink\{([^}]*)\}/)[1];
    expect(rule).toMatch(/min-height:44px/); expect(rule).toMatch(/min-width:44px/);
  });
});
