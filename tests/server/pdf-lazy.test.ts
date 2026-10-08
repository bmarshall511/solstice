// Batch 7: pdf.js (server/src/pdf.ts and its worker) loads only when a bill PDF is parsed, not on every cold start of the API function.
// The module's factory counts how often pdf.ts is loaded; importing the bills module (which app.ts imports) must not load it.
import { describe, it, expect, vi } from 'vitest';
import { PEC_BILL } from '../fixtures/pec-bill.js';

const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock(import('../../server/src/pdf.js'), () => { loads.n++; return { pdfToLayoutText: vi.fn(async () => PEC_BILL) }; });

describe('pdf.js is lazy', () => {
  it('importing bills.ts does not load pdf.ts; the first parsed PDF does, once', async () => {
    const bills = await import('../../server/src/bills.js');
    expect(loads.n).toBe(0);
    const b = await bills.parsePecPdf(new Uint8Array([1, 2, 3]));
    expect(b.billDate).toBe('2026-09-15');
    await bills.parsePecPdf(new Uint8Array([1, 2, 3]));
    expect(loads.n).toBe(1);
  });
});
