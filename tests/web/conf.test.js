// Confidence badges (web/src/lib/conf.js, approved mockup mockups/r-learning.html): tier → chip class and text.
import { describe, it, expect } from 'vitest';
import { TIERS, confText, confChip, fc48Header, biasDir, sparkline, modelOf } from '../../web/src/lib/conf.js';

const report = { models: [
  { id: 'fc48.solar', tier: 'learned', v: '±11%' },
  { id: 'fc48.home', tier: 'estimated', v: '±34%' },
  { id: 'fc48.soc', tier: 'learned', v: '±7 pts', bands: { 'h1-6': 5, 'h7-24': 12, 'h25-48': null } },
  { id: 'pool.kwhDay', tier: 'learning', v: 'learning · 3 of 14' },
] };

describe('confidence badge mapping', () => {
  it('maps each tier to the mockup data-t letter', () => {
    expect(TIERS).toEqual({ measured: 'm', learned: 'l', estimated: 'e', learning: 'n', unscored: 'u' });
    for (const [tier, t] of Object.entries(TIERS)) expect(confChip(tier)).toBe(`<span class="conf" data-t="${t}">${tier}</span>`);
  });

  it('draws no chip where the API gave no tier (or an unknown one)', () => {
    for (const v of [undefined, null, '', 'bogus', 'toString', '__proto__']) { expect(confChip(v)).toBe(''); expect(confText(v)).toBeNull(); }
  });

  it("uses the owner's model text only when the report agrees on the tier", () => {
    expect(confChip('learning', modelOf(report, 'pool.kwhDay'))).toBe('<span class="conf" data-t="n">learning · 3 of 14</span>');
    expect(confText('unscored', modelOf(report, 'pool.kwhDay'))).toBe('unscored');   // tiers disagree: the tier word
    expect(confText('learned', null)).toBe('learned');                                // a guest has no report
    expect(confChip('learned', { tier: 'learned', v: '<b>' })).toContain('&lt;b&gt;');  // escaped
  });

  it('builds the Next 48 hours header from /api/profile conf, with the 1–6 h battery band for the owner', () => {
    const conf = { 'fc48.solar': 'learned', 'fc48.home': 'estimated', 'fc48.soc': 'learned' };
    expect(fc48Header(conf, report)).toBe('forecast · solar ±11% · home ±34% · battery ±5 pts at 6 h');
    expect(fc48Header(conf, null)).toBe('forecast · solar learned · home estimated · battery learned');
    expect(fc48Header({ 'fc48.solar': 'learning' }, null)).toBe('forecast · solar learning');
    expect(fc48Header(null, report)).toBeNull();
    expect(fc48Header({}, report)).toBeNull();
  });

  it('bias arrows and the sparkline', () => {
    expect([biasDir(null), biasDir(5), biasDir(-6), biasDir(.5)]).toEqual([null, 'up', 'dn', 'ev']);
    expect(sparkline([])).toBe('');
    expect(sparkline([4, 2, 1]).match(/<rect/g)).toHaveLength(3);
  });
});
