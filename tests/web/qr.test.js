// The share sheet's QR encoder (web/src/lib/qr.js): byte mode, versions 1–40, levels L/M/Q/H, automatic mask choice.
// Golden symbols were produced once with two independent encoders, Project Nayuki's qrcodegen (Python) and the `qrcode`
// package, which agree module for module on every fixed-mask case below; qrcodegen also fixes the automatic mask choice.
// Neither is a dependency of this repo. Matrices are '#' (dark) and '.' (light), row by row, with no quiet zone.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeQr, qrSvg, rsDivisor, rsRemainder, dataCodewords, penalty } from '../../web/src/lib/qr.js';

const rows = q => q.modules.map(r => r.map(c => (c ? '#' : '.')).join(''));
const digest = q => createHash('sha256').update(rows(q).join('\n')).digest('base64');
const URL = 'https://solstice-example.vercel.app/#s=Xq7a0b1c2d3e4f5g6h7i8j9kLmNoPq9F';   // synthetic, shaped like a share link

describe('QR encoder', () => {
  it('QR-1 Reed–Solomon matches the textbook HELLO WORLD 1-M block', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];   // alphanumeric data codewords
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('QR-2 capacities: the smallest version that fits, 4 × version + 17 modules a side', () => {
    expect([1, 5, 10, 40].map(v => dataCodewords(v, 'M'))).toEqual([16, 86, 216, 2334]);
    expect([1, 7, 40].map(v => dataCodewords(v, 'L'))).toEqual([19, 156, 2956]);
    expect(encodeQr('x'.repeat(14), { ecl: 'M' }).version).toBe(1);                       // 4 + 8 + 112 bits fit 16 bytes
    expect(encodeQr('x'.repeat(15), { ecl: 'M' }).version).toBe(2);
    const q = encodeQr(URL);                                                                // the default level is M
    expect([q.version, q.size, q.ecl]).toEqual([5, 37, 'M']);
    expect(() => encodeQr('x'.repeat(2400), { ecl: 'M' })).toThrow(RangeError);
    expect(() => encodeQr('x', { ecl: 'X' })).toThrow(RangeError);
  });

  it('QR-3 HELLO WORLD, level M, automatic mask: module for module', () => {
    const q = encodeQr('HELLO WORLD', { ecl: 'M' });
    expect([q.version, q.mask]).toEqual([1, 4]);
    expect(rows(q)).toEqual([
      '#######.##..#.#######', '#.....#....#..#.....#', '#.###.#..#.#..#.###.#', '#.###.#.#..#..#.###.#', '#.###.#.###.#.#.###.#',
      '#.....#.#..#..#.....#', '#######.#.#.#.#######', '........#..##........', '#...#.######.#####..#', '...#....#.###....####',
      '..######..##.##.#..#.', '#####...##...#.......', '#####.#.#.#.#.##..##.', '........#.#.####.#.##', '#######.###.#.#.##.#.',
      '#.....#..#.###.##..##', '#.###.#.##.#.##...##.', '#.###.#..#..#...##.##', '#.###.#..###...###...', '#.....#....#.#.......',
      '#######.#########.#.#',
    ]);
  });

  it('QR-4 a share-link-sized URL, level M, automatic mask: module for module', () => {
    const q = encodeQr(URL, { ecl: 'M' });
    expect([q.version, q.mask]).toEqual([5, 4]);
    expect(rows(q)).toEqual([
      '#######.########..##.##..####.#######', '#.....#..##..##.#.#.###..#..#.#.....#', '#.###.#..#...##..#.####.#.#...#.###.#',
      '#.###.#.####..###.###....#.##.#.###.#', '#.###.#.#....#..#.....###.###.#.###.#', '#.....#.#.#.#.#...##.....##.#.#.....#',
      '#######.#.#.#.#.#.#.#.#.#.#.#.#######', '........#.##.##.###..####.#.#........', '#...#.####..#..#..##.##.#.#.######..#',
      '#.##...#.#....#.#..##.##...#.#.##..#.', '..##.##.#..#.#..##..#..#..####.#.#...', '.#####.#.##..#...#...##.#.###.##.###.',
      '#..#.##.####..###########..#.##..####', '.#...#..#...#.##.##....#..###...##...', '#..##.##.###...#..#..###...#...####..',
      '.##.##..##.#.#.##..###.##..###.##.##.', '....#######.#.#.#...##.##..#.###.##.#', '#..###..##..#....###..#..####...#..#.',
      '..##.##...#...##..##.#.##.###.###.#..', '..........#..#.#######.##.#...#...##.', '.#.#.###.....#..###.#####....###..#..',
      '#...#...##.#..###.#.####...##..##..#.', '#.##..#.#.....####...###.#.##..#####.', '#####....###...####.##.#...#.####.#..',
      '##..####.#.#...#..#...#.#.#.#.#..##.#', '#.##.#....###...#..##..#...#.#.##....', '..#..##.#.#.##..#...#.##...#..#......',
      '..#.#..#.#...##..##..####....#.#.##.#', '#####.#.#.#..#.###.#####....#########', '........##.#.#..##.....#..###...#....',
      '#######.########..#.#..##...#.#.#....', '#.....#...#.####....#####.#.#...###.#', '#.###.#.#.##.####..##..##...#########',
      '#.###.#..#..##....##.....#######....#', '#.###.#....#.#.#...#..###..##.#..#...', '#.....#...##..########....##....#.##.',
      '#######.##.###..###.#####..#.###..###',
    ]);
  });

  it('QR-5 every forced mask, version information (v7+), all four levels and UTF-8 text', () => {
    const forced = ['2uLVarcI+3uFLSs2xICc2v5ZHiLohQED6WcsYSBkRx0=', 'kwPGS+Qoj3cfnDer8BMMc+B1iFogr0HJ+9zzT4IdBfI=', 'hh/uujSiavrhEerY7hsHrUfax3zSWoAEItugYGnG6RU=',
      'mLK9BR/RUwdNMgxrKUoPVIywpND/t50utXGGxACPYk8=', 'hv2gvxl38UF5XyKK3nyuRMngMRs8Bv2/X+WtMeZlFHI=', 'xiBckruxZOJzQ4kRwQl60Oa6cQCmJv5IBRmZzPituFg=',
      'foinPlm94PVcV1ws/yR5m6nvQRHXo1h++NBbbGsJ9rI=', 'NCzLvg5h1a9kQI18etutlfKSfaBZ8iz1HhlyZoRnrd8='];
    forced.forEach((sha, mask) => expect(digest(encodeQr(URL, { ecl: 'M', mask })), `mask ${mask}`).toBe(sha));
    for (const [text, ecl, version, mask, sha] of [
      ['a'.repeat(150), 'L', 7, 1, 'JArxXZkQfFooJYL/2XiFyobg/U8AZeoGfLBLuDAECTI='],
      ['b'.repeat(300), 'H', 18, 2, 'bFFVJRFAT01pwG5CzKqpUT6a4Gbkw6Ru6m+E4ATytOM='],
      ['Solstice · 日本 · ünïcode ☀', 'Q', 4, 3, 'NTqT04BVUSpT5kAOC3I+9SimO8LSKvl0ely8osBhhMc='],
      ['', 'M', 1, 3, '/HdteWP8hfwiusHOThtWs0P2y6GA9WIqXaKwBBq7/5A='],
      [URL, 'L', 4, 2, 'NOPmI+mveRf1NuL8kOL6g6eKj4Ub0Z4WmLZQ3AlgFCg='],
    ]) {
      const q = encodeQr(text, { ecl });
      expect([q.version, q.mask, digest(q)], `${ecl} ${text.slice(0, 12)}`).toEqual([version, mask, sha]);
    }
  });

  it('QR-6 the automatic mask is the lowest-penalty one', () => {
    const auto = encodeQr(URL);
    const scores = Array.from({ length: 8 }, (_, mask) => penalty(encodeQr(URL, { mask }).modules));
    expect(scores[auto.mask]).toBe(Math.min(...scores));
  });

  it('QR-7 qrSvg: one path of dark modules on white, a 4-module quiet zone, the link never in the markup', () => {
    const svg = qrSvg(URL), q = encodeQr(URL);
    expect(svg).toMatch(/^<svg class="qr" viewBox="0 0 45 45" role="img" aria-label="QR code for the share link" shape-rendering="crispEdges"><rect width="45" height="45" fill="#fff"\/><path d="[^"]+" fill="#05060a"\/><\/svg>$/);
    expect(svg.match(/h1v1h-1z/g).length).toBe(q.modules.flat().filter(Boolean).length);
    expect(svg).not.toContain('solstice-example');
    expect(svg).toContain('M4 4h1v1h-1z');                                                   // the top-left finder's corner, inside the quiet zone
  });
});
