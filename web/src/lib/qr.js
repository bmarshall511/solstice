// A small QR Code encoder (ISO/IEC 18004, model 2): byte mode, versions 1–40, error correction L/M/Q/H, automatic mask
// choice by the standard's penalty rules. Enough for the share sheet's link QR, drawn client-side with no dependency
// (the share link never leaves the browser to be rendered). The structure follows Project Nayuki's reference encoder.

const ECL = { L: 1, M: 0, Q: 3, H: 2 };   // the two format bits for each level
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const bit = (x, i) => ((x >>> i) & 1) !== 0;

/** Modules available for data and error correction in a version (everything but the function patterns). */
export function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
  return n;
}
/** Data codewords (bytes) a version holds at an error correction level. */
export const dataCodewords = (ver, ecl) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver];

/* ---------- Reed–Solomon over GF(2^8), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ---------- */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
/** The generator polynomial of the given degree (coefficients high to low, leading 1 dropped). */
export function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
/** The error correction codewords for one block of data. */
export function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

/* ---------- the symbol ---------- */
function utf8(text) { return Array.from(new TextEncoder().encode(String(text))); }

/** The smallest version (≥ minVersion) whose byte-mode capacity at this level fits `n` bytes, or -1. */
function pickVersion(n, ecl, minVersion) {
  for (let v = Math.max(1, minVersion); v <= 40; v++) if (4 + (v < 10 ? 8 : 16) + 8 * n <= dataCodewords(v, ecl) * 8) return v;
  return -1;
}

/** Data bits → padded data codewords for the version. */
function dataBytes(bytes, ver, ecl) {
  const bits = [], push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => push(b, 8));
  const cap = dataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Split into blocks, add each block's error correction, interleave. */
function withEcc(data, ver, ecl) {
  const n = BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver], raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = n - raw % n, shortLen = Math.floor(raw / n), div = rsDivisor(eccLen), blocks = [];
  for (let i = 0, k = 0; i < n; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1)); k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < shortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(b[i]); });
  return out;
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const a = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + a * 3 + 5) / (a * 4 - 4)) * 2, out = [6];
  for (let pos = size - 7; out.length < a; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

function build(ver, ecl, codewords) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false)), fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
    if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = alignmentPositions(ver, size), k = al.length;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = mask => {
    const data = ECL[ecl] << 3 | mask; let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = (data << 10 | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
    set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const b = ver << 12 | rem;
    for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)); }
  }
  // the codewords, in the zig-zag of two-module columns from the bottom right
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!fn[y][x] && i < codewords.length * 8) { m[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; }
    }
  }
  return { size, m, fn, format };
}

/** Penalty of a finished symbol (ISO/IEC 18004 §7.8.3): runs, 2×2 blocks, finder-like patterns, dark/light balance. */
export function penalty(m) {
  const size = m.length; let score = 0;
  const addHistory = (run, h) => { if (h[0] === 0) run += size; h.pop(); h.unshift(run); };
  const countFinder = h => { const n = h[1], core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0); };
  const line = get => {
    let color = false, run = 0, s = 0; const h = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i++) {
      if (get(i) === color) { run++; if (run === 5) s += 3; else if (run > 5) s++; }
      else { addHistory(run, h); if (!color) s += countFinder(h) * 40; color = get(i); run = 1; }
    }
    if (color) { addHistory(run, h); run = 0; }
    addHistory(run + size, h);
    return s + countFinder(h) * 40;
  };
  for (let y = 0; y < size; y++) score += line(x => m[y][x]);
  for (let x = 0; x < size; x++) score += line(y => m[y][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3; }
  const dark = m.reduce((a, r) => a + r.filter(Boolean).length, 0), total = size * size;
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

/**
 * Encode text (UTF-8, byte mode) as a QR Code.
 * @param {string} text
 * @param {{ ecl?: 'L'|'M'|'Q'|'H', mask?: number, minVersion?: number }} [o] mask 0–7 forces one (tests); otherwise the lowest penalty wins
 * @returns {{ version: number, ecl: string, mask: number, size: number, modules: boolean[][] }} modules[y][x], true = dark
 */
export function encodeQr(text, { ecl = 'M', mask, minVersion = 1 } = {}) {
  if (!(ecl in ECL)) throw new RangeError('ecl must be L, M, Q or H');
  const bytes = utf8(text), ver = pickVersion(bytes.length, ecl, minVersion);
  if (ver < 0) throw new RangeError('text too long for a QR code');
  const { size, m, fn, format } = build(ver, ecl, withEcc(dataBytes(bytes, ver, ecl), ver, ecl));
  const apply = k => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
  let best = mask;
  if (best == null) {
    let min = Infinity;
    for (let k = 0; k < 8; k++) { apply(k); format(k); const p = penalty(m); if (p < min) { min = p; best = k; } apply(k); }
  }
  if (!(best >= 0 && best <= 7)) throw new RangeError('mask must be 0–7');
  apply(best); format(best);
  return { version: ver, ecl, mask: best, size, modules: m };
}

/** An SVG of the code: dark modules on white with a 4-module quiet zone, one path, crisp at any size. */
export function qrSvg(text, { ecl = 'M', label = 'QR code for the share link' } = {}) {
  const { size, modules } = encodeQr(text, { ecl }), q = 4, n = size + q * 2;
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + q} ${y + q}h1v1h-1z`; }));
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#05060a"/></svg>`;
}
