import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLabelsZpl } from './zpl.js';

// golden do NVS-WMS: o ZPL que já sai certo na Zebra física
const golden = JSON.parse(readFileSync(new URL('./__fixtures__/picking-zpl.golden.json', import.meta.url), 'utf8')) as Record<string, string>;
const ITEM = { code: 'MLB123456', sku: 'PROTENIS', description: 'Protetor de Tênis Moto' };
const ESPECIAL = 'Peça ^com ~caracteres ZPL e acentuação ção ' + 'x'.repeat(120);
const LONGA = 'Retrovisor Esportivo Universal Para Motos Com Parafusos Inclusos';

const CASES: Record<string, Parameters<typeof buildLabelsZpl>[0]> = {
  ml_qtd1: { ...ITEM, marketplace: 'ml', qty: 1 },
  ml_qtd2: { ...ITEM, marketplace: 'ml', qty: 2 },
  ml_qtd3: { ...ITEM, marketplace: 'ml', qty: 3 },
  ml_qtd5: { ...ITEM, marketplace: 'ml', qty: 5 },
  ml_qtd0_vira_1: { ...ITEM, marketplace: 'ml', qty: 1 },
  ml_reimpressao_qtd4: { ...ITEM, marketplace: 'ml', qty: 4 },
  ml_sem_ml_code_usa_sku: { ...ITEM, code: 'PROTENIS', marketplace: 'ml', qty: 1 },
  ml_descricao_especial: { ...ITEM, description: ESPECIAL, marketplace: 'ml', qty: 2 },
  ml_sem_sessao: { ...ITEM, marketplace: 'ml', qty: 1 },
  shopee_qtd1: { ...ITEM, marketplace: 'shopee', qty: 1 },
  shopee_qtd2: { ...ITEM, marketplace: 'shopee', qty: 2 },
  shopee_qtd3: { ...ITEM, marketplace: 'shopee', qty: 3 },
  shopee_descricao_longa: { ...ITEM, description: LONGA, marketplace: 'shopee', qty: 2 },
};

describe('etiquetas do Full idênticas ao NVS-WMS', () => {
  for (const [name, args] of Object.entries(CASES)) {
    it(name, () => expect(buildLabelsZpl(args)).toBe(golden[name]));
  }
});
