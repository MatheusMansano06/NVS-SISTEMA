import { describe, expect, it } from 'vitest';
import { inboundPdf } from '../../../../test/helpers/inbound-pdf.js';
import { extractPdfText } from '../infrastructure/pdf-text.js';
import { parseInboundText, splitIntoLists } from './ml-inbound-pdf.js';

describe('PDF do envio Full do ML', () => {
  it('lê Código ML, EAN, SKU, descrição e unidades de cada produto', async () => {
    const pdf = inboundPdf([
      { sku: 'PTHermetico', mlCode: 'IBFJ71702', description: 'Kit 10 Potes Vidro Hermético', qty: 10 },
      { sku: 'VARAL', mlCode: 'YTHH93028', ean: '7891234567895', description: 'Varal De Chão Slim', qty: 5 },
    ], '68874755');
    const doc = parseInboundText(await extractPdfText(new Uint8Array(pdf)));
    expect(doc.ref).toBe('68874755');
    expect(doc.declaredUnits).toBe(15);
    expect(doc.items).toEqual([
      { sku: 'PTHERMETICO', mlCode: 'IBFJ71702', ean: null, description: 'Kit 10 Potes Vidro Hermético', qty: 10 },
      { sku: 'VARAL', mlCode: 'YTHH93028', ean: '7891234567895', description: 'Varal De Chão Slim', qty: 5 },
    ]);
  });

  it('mesmo SKU com Códigos ML diferentes são anúncios distintos; repetido soma', () => {
    const t = (y: number, s: string, x = 38) => ({ page: 1, x, y, str: s });
    const doc = parseInboundText([
      t(640, 'UNIDADES', 220), t(640, 'IDENTIFIÇÃO', 291),
      t(600, 'Código ML: AAA11111 Código universal: N/A SKU:'), t(600, '3', 220), t(591, 'X1'),
      t(540, 'Código ML: BBB22222 Código universal: N/A SKU:'), t(540, '2', 220), t(531, 'X1'),
      t(480, 'Código ML: AAA11111 Código universal: N/A SKU:'), t(480, '4', 220), t(471, 'X1'),
    ]);
    expect(doc.items.map((i) => [i.mlCode, i.qty])).toEqual([['AAA11111', 7], ['BBB22222', 2]]);
  });

  it('divide em listas de até 1.000 unidades (maiores primeiro)', () => {
    const lists = splitIntoLists([{ qty: 600 }, { qty: 500 }, { qty: 300 }, { qty: 1200 }], 1000);
    expect(lists.map((l) => l.map((i) => i.qty))).toEqual([[1200], [600], [500, 300]]);
  });
});
