import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PdfText } from '../domain/ml-inbound-pdf.js';

// métricas das fontes padrão (Helvetica etc.): sem elas o pdf.js junta textos vizinhos
const FONTS = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';

/** Texto posicionado de todas as páginas (pdf.js, sem worker e sem executar código do PDF). */
export async function extractPdfText(data: Uint8Array): Promise<PdfText[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl: FONTS }).promise;
  const out: PdfText[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 200); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        out.push({ page: p, x: it.transform[4] as number, y: it.transform[5] as number, str: it.str });
      }
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
