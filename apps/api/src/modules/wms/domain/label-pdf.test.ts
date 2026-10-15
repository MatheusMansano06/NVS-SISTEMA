import { describe, expect, it } from 'vitest';
import { extractPdfText } from '../infrastructure/pdf-text.js';
import { buildLabelsPdf, labelSlots } from './label-pdf.js';

const ML = { marketplace: 'ml' as const, code: 'IBFJ71702', sku: 'PROTENIS', description: 'Protetor de Tênis Moto', qty: 3 };

async function pages(pdf: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  const sizes: number[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const [, , w, h] = (await doc.getPage(p)).view;
    sizes.push([Math.round((w! * 25.4) / 72), Math.round((h! * 25.4) / 72)]);
  }
  await doc.destroy();
  return sizes;
}

describe('etiquetas em PDF', () => {
  it('rolo de 1 coluna: uma etiqueta por página, no tamanho da etiqueta', async () => {
    const pdf = await buildLabelsPdf([ML], { format: 'rolo_1col', widthMm: 50, heightMm: 25 });
    expect(await pages(pdf)).toEqual([[50, 25], [50, 25], [50, 25]]);
    const text = (await extractPdfText(new Uint8Array(pdf))).map((t) => t.str).join(' ');
    expect(text).toContain('IBFJ71702');
    expect(text).toContain('SKU: PROTENIS');
    expect(text).toContain('Protetor de Tênis Moto');
  });

  it('rolo de 2 colunas: duas por página; quantidade ímpar fecha com uma sozinha à esquerda', async () => {
    const pdf = await buildLabelsPdf([ML], { format: 'rolo_2col', widthMm: 40, heightMm: 25 });
    expect(await pages(pdf)).toEqual([[80, 25], [80, 25]]);
    expect(labelSlots({ format: 'rolo_2col', widthMm: 40, heightMm: 25 }, 3).pages).toEqual([[{ x: 0, y: 0 }, { x: 40, y: 0 }], [{ x: 0, y: 0 }]]);
  });

  it('folha A4: grade centralizada (Pimaco A4356 = 3 × 11)', () => {
    const s = labelSlots({ format: 'a4', widthMm: 63.5, heightMm: 25.4 }, 40);
    expect(s.pageW).toBe(210);
    expect(s.pages.map((p) => p.length)).toEqual([33, 7]);
    expect(s.pages[0]![0]!.x).toBeCloseTo((210 - 3 * 63.5) / 2);
  });

  it('Shopee usa QR e mostra o seller sku', async () => {
    const pdf = await buildLabelsPdf([{ marketplace: 'shopee', code: '25147029740_243914807565', sku: 'VEOX', description: 'Produto Shopee', qty: 1 }], {
      format: 'rolo_1col',
      widthMm: 50,
      heightMm: 25,
    });
    const text = (await extractPdfText(new Uint8Array(pdf))).map((t) => t.str).join(' ');
    expect(text).toContain('seller sku: VEOX');
  });
});
