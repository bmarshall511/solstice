// Pure-JS PDF → layout text (no poppler), so bills can be read on Vercel.
// Rebuilds lines by grouping text items that share a baseline and spacing them by their x-gap,
// which reproduces `pdftotext -layout` closely enough for the PEC parser.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
// Load the worker in-process so serverless bundlers include it (pdf.js looks for globalThis.pdfjsWorker).
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
(globalThis as any).pdfjsWorker = pdfjsWorker;

type Item = { str: string; transform: number[]; width: number };
const TOL = 3.2; // points

export async function pdfToLayoutText(data: Uint8Array): Promise<string> {
  const task = getDocument({ data, useSystemFonts: false, disableFontFace: true } as Parameters<typeof getDocument>[0]), doc = await task.promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items as Item[];
    // cluster items whose baselines are within a few points of each other into one line
    const sorted = items.filter(it => it.str.trim()).sort((a, b) => b.transform[5] - a.transform[5]);
    const rows: Array<{ y: number; items: Item[] }> = [];
    for (const it of sorted) {
      const y = it.transform[5], row = rows.at(-1);
      if (row && Math.abs(row.y - y) <= TOL) row.items.push(it); else rows.push({ y, items: [it] });
    }
    const lines = rows.map(({ items: row }) => {
      row.sort((a, b) => a.transform[4] - b.transform[4]);
      let line = '', end = 0;
      for (const it of row) {
        const x = it.transform[4], size = Math.abs(it.transform[0]) || 8, charW = size * .5;
        const gap = x - end;
        if (line) line += gap > charW * 1.5 ? ' '.repeat(Math.max(2, Math.round(gap / charW))) : gap > charW * .25 ? ' ' : '';
        line += it.str; end = x + it.width;
      }
      return line;
    });
    pages.push(lines.join('\n'));
  }
  await task.destroy();
  return pages.join('\n\f\n');
}
