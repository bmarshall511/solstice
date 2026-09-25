// Privacy guard for a public repo (rule 5; design §5). Scans tests/, mockups/ and docs/ on every run.
// Failure messages mask every digit, so a real figure that slips in is never echoed into a (public) CI log.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'tests/hygiene.test.ts';
const GIT_IGNORED = new Set(['mockups/d-rooftop.html']); // local-only on purpose; never published, never read here

const walk = (dir: string): string[] => !existsSync(join(ROOT, dir)) ? [] : readdirSync(join(ROOT, dir)).flatMap(f => {
  const p = `${dir}/${f}`;
  if (GIT_IGNORED.has(p) || f === 'node_modules' || f.startsWith('.')) return [];
  return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p];
});
const text = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const mask = (s: string) => s.replace(/\d/g, '#').slice(0, 60);
const hits = (files: string[], re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true) =>
  files.flatMap(f => [...text(f).matchAll(re)].filter(keep).map(m => `${f}: ${mask(m[0])}`));

const TESTS = walk('tests').filter(f => f !== SELF);
const FIXTURES = TESTS.filter(f => f.startsWith('tests/fixtures/'));
const MOCKUPS = walk('mockups').filter(f => f.endsWith('.html'));
const DOCS = walk('docs').filter(f => f.endsWith('.md'));

/** A loan, net-cost, payback, price or system-cost label followed by a dollar figure. Per-unit rates ($/W, $/kWh, $/MWh)
 *  are generic, not the owner's figures, so they are allowed; the number is matched atomically so backtracking cannot
 *  dodge the unit check. */
const PRICE = /(loan|net cost|payback|price|system cost)[^$\n]{0,40}\$\s?(?=(\d[\d,.]*))\2(?!\s*\/\s*(?:W|kW|kWh|MWh)\b)/gi;

describe('tests/ holds nothing personal', () => {
  it('finds the files it is meant to scan', () => {
    expect(TESTS.length).toBeGreaterThan(10);
    expect(FIXTURES).toContain('tests/fixtures/pec-bill.ts');
    expect(MOCKUPS).toContain('mockups/g-insights.html');
    expect(DOCS).toContain('docs/audit-2026-09.md');
  });
  it('no account-number-like run of 9 or more digits (other than all zeros)', () => {
    expect(hits(TESTS, /\d{9,}/g, m => !/^0+$/.test(m[0]))).toEqual([]);
  });
  it('no dollar amount of 1,000 or more', () => {
    expect(hits(TESTS, /\$\s?\d{1,3}(,\d{3})+/g)).toEqual([]);
  });
  it('no loan, payback or account number figure', () => {
    expect(hits(TESTS, /(Loan|Payback|Account #)[^\d\n]{0,12}[1-9]/g)).toEqual([]);
  });
  it('no street address', () => {
    expect(hits(TESTS, /\d{3,5} [A-Z][a-z]+ (St|Dr|Ln|Rd|Ct|Cir|Blvd|Trl|Way)\b/g)).toEqual([]);
  });
  it('no test reads data/, secrets/, .env files or the local-only rooftop mockup', () => {
    const code = TESTS.filter(f => /\.(ts|js|mjs)$/.test(f));
    expect(hits(code, /['"`](?:\.{1,2}\/)*(?:data|secrets)\/|['"`](?:\.{1,2}\/)*\.env|d-rooftop/g)).toEqual([]);
  });
  it('fixtures use 2026 dates only', () => {
    expect(hits(FIXTURES, /\b(\d{4})-\d{2}-\d{2}\b/g, m => m[1] !== '2026')).toEqual([]);
    expect(hits(FIXTURES, /\b\d{1,2}\/\d{1,2}\/(\d{4}|\d{2})\b/g, m => m[1] !== '2026' && m[1] !== '26')).toEqual([]);
  });
});

describe('mockups/ and docs/ hold no loan or price figures', () => {
  it('every mockup and doc except the known one is clean', () => {
    expect(hits([...MOCKUPS, ...DOCS].filter(f => f !== 'mockups/g-insights.html'), PRICE)).toEqual([]);
  });
  // PRIV-1 · today mockups/g-insights.html shows the real net cost and loan payment. This flips when the privacy batch
  // replaces them with placeholders (git history still holds them; rewriting it is owner question 8).
  it('PRIV-1: mockups/g-insights.html has no loan or price figures', () => {
    expect(hits(['mockups/g-insights.html'], PRICE)).toEqual([]);
  });
});
