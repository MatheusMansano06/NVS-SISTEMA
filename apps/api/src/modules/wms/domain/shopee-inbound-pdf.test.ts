import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdfText } from '../infrastructure/pdf-text.js';
import type { InboundDoc } from './ml-inbound-pdf.js';
import { isValidEan13, parseShopeeInboundText } from './shopee-inbound-pdf.js';

// PDFs reais da Shopee (os mesmos dos testes do NVS-WMS), com o bug de camada dupla nas páginas 4/6 e 4/5
const read = async (name: string) =>
  parseShopeeInboundText(await extractPdfText(new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))));
const qty = (doc: InboundDoc, sku: string) => {
  const found = doc.items.filter((i) => i.sku === sku);
  expect(found, `esperava 1 item ${sku}`).toHaveLength(1);
  return found[0]!.qty;
};

describe('PDF Shopee de abril (FBSINBR2026042800054)', () => {
  let doc: InboundDoc;
  beforeAll(async () => {
    doc = await read('FBSINBR2026042800054.pdf');
  });
  it('soma das quantidades fecha com o total do rodapé (11.820)', () => {
    expect(doc.ref).toBe('INBRFSP12604290170');
    expect(doc.declaredUnits).toBe(11820);
    expect(doc.items.reduce((s, i) => s + i.qty, 0)).toBe(11820);
    expect(doc.items.length).toBeGreaterThanOrEqual(60);
    expect(doc.items.filter((i) => i.qty <= 0)).toEqual([]);
  });
  it('SKUs numéricos são SKUs, não quantidades', () => {
    for (const s of ['588', '576', '502']) expect(doc.items.some((i) => i.sku === s)).toBe(true);
  });
  it('páginas com camada dupla (quantidade em dígitos soltos)', () => {
    expect(qty(doc, 'FAROLINTRUDER')).toBe(100);
    expect(qty(doc, 'VLIB45')).toBe(200);
    expect(qty(doc, 'CAVLETÃO')).toBe(300);
    expect(doc.items.find((i) => i.sku.includes('KIT-VISREPSPI'))?.qty).toBe(200);
  });
  it('páginas normais', () => {
    expect(qty(doc, 'VEOX')).toBe(200);
    expect(qty(doc, 'VISCAMVISION')).toBe(100);
    expect(qty(doc, 'EMB150')).toBe(240); // "50" do armazém (GTIN,EMB1 + 50) não é quantidade
    expect(doc.items.find((i) => i.sku === 'VEOX')).toMatchObject({ mlCode: '25147029740_243914807565', description: 'Viseira Transparent Capacete Ebf New Spark Flash Eox E0x E17' });
  });
});

describe('PDF Shopee de julho (FBSINBR2026072103635)', () => {
  let doc: InboundDoc;
  beforeAll(async () => {
    doc = await read('FBSINBR2026072103635.pdf');
  });
  it('fecha 4.073 unidades em 53 SKUs', () => {
    expect(doc.ref).toBe('INBRFSP12607220080');
    expect(doc.declaredUnits).toBe(4073);
    expect(doc.items.reduce((s, i) => s + i.qty, 0)).toBe(4073);
    expect(doc.items).toHaveLength(53);
  });
  it('EAN do armazém quebrado em 2 linhas não vira quantidade (FAROL125 = 82, não 2)', () => {
    expect(qty(doc, 'FAROL125')).toBe(82);
    expect(doc.items.find((i) => i.sku === 'FAROL125')?.ean).toBe('7897846416859');
  });
  it('vendedor numérico e vendedor terminado em dígito', () => {
    expect(qty(doc, '514')).toBe(290);
    expect(qty(doc, 'V+L4')).toBe(64);
  });
});

it('dígito verificador do EAN-13', () => {
  expect(isValidEan13('7897846416859')).toBe(true);
  expect(isValidEan13('7908429128301')).toBe(true);
  expect(isValidEan13('7897846416858')).toBe(false);
  expect(isValidEan13('789784641685')).toBe(false);
});
