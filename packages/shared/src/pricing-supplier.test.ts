import { describe, expect, it } from 'vitest';
import { costWithMarkup, csvRows, parseQuoteMoney, parseQuoteRows } from './pricing-supplier.js';

describe('parseQuoteMoney', () => {
  it('lê valores em real e recusa código ou quantidade', () => {
    expect(parseQuoteMoney('R$ 1.234,56')).toBe(1234.56);
    expect(parseQuoteMoney('79,90')).toBe(79.9);
    expect(parseQuoteMoney('79.90')).toBe(79.9);
    expect(parseQuoteMoney('12345')).toBeNull();
    expect(parseQuoteMoney('2')).toBeNull();
  });
});

describe('costWithMarkup', () => {
  it('soma o % do fornecedor ao preço da cotação', () => {
    expect(costWithMarkup(40, 11)).toBe(44.4);
    expect(costWithMarkup(33.33, 0)).toBe(33.33);
  });
});

describe('parseQuoteRows', () => {
  it('usa o cabeçalho e pega o preço unitário, não o total', () => {
    const rows = csvRows('Código;Descrição;Qtd;Valor Unit.;Valor Total\nW1;Rabeta completa Fan;10;45,90;459,00\nW2;Tampa lateral CG;5;12,50;62,50\n;Total;;;521,50');
    expect(parseQuoteRows(rows)).toEqual([
      { title: 'Rabeta completa Fan', supplierCost: 45.9 },
      { title: 'Tampa lateral CG', supplierCost: 12.5 },
    ]);
  });

  it('sem cabeçalho (linhas do PDF): junta o texto e pega o primeiro valor', () => {
    const rows = [
      ['Orçamento 123', 'Wester Peças'],
      ['001', 'Rabeta traseira', 'Fan 125 2009', '2', 'UN', 'R$ 38,70', 'R$ 77,40'],
      ['SUBTOTAL', 'R$ 77,40'],
    ];
    expect(parseQuoteRows(rows)).toEqual([{ title: 'Rabeta traseira Fan 125 2009', supplierCost: 38.7 }]);
  });

  it('PDF quebrado em palavras: mantém o número do modelo e tira código e quantidade', () => {
    const rows = [
      ['Cod', 'Descricao', 'Qtd', 'Unit', 'Total'],
      ['001', 'Rabeta', 'completa', 'Fan', '125', '10', 'R$', '45,90', 'R$', '459,00'],
      ['TOTAL', 'R$', '521,50'],
    ];
    expect(parseQuoteRows(rows)).toEqual([{ title: 'Rabeta completa Fan 125', supplierCost: 45.9 }]);
  });
});

describe('csvRows', () => {
  it('aceita vírgula e aspas', () => {
    expect(csvRows('nome,preco\n"Kit, 2 peças",10.50\n')).toEqual([['nome', 'preco'], ['Kit, 2 peças', '10.50']]);
  });
});
