import { describe, expect, it } from 'vitest';
import { parseBrNumber, parseSkuCsv } from './sku-csv.js';

describe('parseBrNumber', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1234.56', 1234.56],
    ['R$ 10,5', 10.5],
    ['9%', 9],
    ['', null],
  ])('%s → %s', (raw, expected) => expect(parseBrNumber(raw)).toBe(expected));
  it('texto inválido vira NaN', () => expect(parseBrNumber('abc')).toBeNaN());
});

describe('parseSkuCsv', () => {
  it('lê planilha do Excel BR (; e vírgula decimal) com cabeçalho alternativo', () => {
    const csv = '\uFEFFSKU;Custo Unitario;Imposto %\nKIT-1;12,50;9\n"CAP;X";100;0\n\n';
    const { rows, headerError } = parseSkuCsv(csv);
    expect(headerError).toBeNull();
    expect(rows).toEqual([
      { line: 2, sku: 'KIT-1', custoUnit: 12.5, impostoPct: 9, error: null },
      { line: 3, sku: 'CAP;X', custoUnit: 100, impostoPct: 0, error: null },
    ]);
  });
  it('aponta linhas inválidas sem descartar as demais', () => {
    const { rows } = parseSkuCsv('sku,custo_unit,imposto_pct\nA,0,9\n,10,9\nB,10,150\nC,abc,1\nD,-5,1\nE,,9');
    expect(rows.map((r) => r.error)).toEqual([
      null, // custo zero é aceito: o SKU fica "sem custo"
      'SKU vazio',
      'imposto fora de 0 a 100',
      'custo inválido',
      'custo não pode ser negativo',
      null, // custo vazio também
    ]);
    expect(rows[0]!.custoUnit).toBeNull();
    expect(rows[5]!.custoUnit).toBeNull();
  });
  it('exige as colunas mínimas', () => {
    expect(parseSkuCsv('produto;valor\nx;1').headerError).toMatch(/sku/);
  });
});
