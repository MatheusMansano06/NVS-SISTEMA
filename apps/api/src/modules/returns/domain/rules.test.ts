import { describe, expect, it } from 'vitest';
import { extractCodes } from './codes.js';
import { decide, pending, shipping, status } from './rules.js';

const ret = (o: Partial<{ responsible: string; canDispute: boolean; platformCost: number | null }> = {}) => ({
  responsible: 'vendedor', canDispute: true, platformCost: 20, ...o,
});
const seen = { productCorrect: true, complete: true, unused: true, resellable: true, ourError: false };

describe('decisão da conferência (regras do NOVAES-ESTOQUE)', () => {
  it('avariado (nosso, não revendável) → B, avaria, vale contestar', () => {
    const d = decide(ret(), { ...seen, unused: false, resellable: false }, 50, null, 1);
    expect(d).toMatchObject({ class: 'B', dispute: true, manualTicket: false, productLoss: 50, reverseFreight: 20 });
    expect(d.stockMoves).toEqual([{ sku: 'vendido', deposit: 'avaria', type: 'E' }]);
  });
  it('voltou perfeito mas o ML cobra o vendedor → A, contestar o frete reverso', () => {
    const d = decide(ret(), seen, 50);
    expect(d).toMatchObject({ class: 'A', dispute: true, productLoss: 0 });
    expect(d.stockMoves).toEqual([{ sku: 'vendido', deposit: 'vendavel', type: 'E' }]);
  });
  it('arrependimento sem cobrança e produto perfeito → nada a contestar', () => {
    expect(decide(ret({ responsible: 'comprador', platformCost: null }), seen)).toMatchObject({ class: 'A', dispute: false, manualTicket: false });
  });
  it('divergente (não é o que enviamos) → C, perda do vendido, entra a sobra na avaria', () => {
    const d = decide(ret(), { ...seen, productCorrect: false, skuReceived: 'OUTRO' }, 80, 30, 2);
    expect(d).toMatchObject({ class: 'C', dispute: true, productLoss: 160 });
    expect(d.stockMoves).toEqual([{ sku: 'recebido', deposit: 'avaria', type: 'E' }]);
  });
  it('erro nosso: assumir, sem contestar; perda pelo que voltou estragado', () => {
    const d = decide(ret(), { ...seen, productCorrect: false, ourError: true, resellable: false, skuReceived: 'X' }, 80, 30);
    expect(d).toMatchObject({ class: 'B', dispute: false, manualTicket: false, productLoss: 30 });
    expect(d.stockMoves).toHaveLength(3);
  });
  it('vale contestar mas o ML não deixa → chamado manual', () => {
    expect(decide(ret({ canDispute: false }), { ...seen, resellable: false })).toMatchObject({ dispute: false, manualTicket: true });
  });
  it('sem custo cadastrado: perda desconhecida (null), não zero', () => {
    expect(decide(ret(), { ...seen, resellable: false }, null).productLoss).toBeNull();
  });
});

describe('status da operação', () => {
  const r = (stage: string, destination = 'vendedor', inMediation = false) => ({ stage, destination, inMediation });
  const check = { stockMoves: [{}], stockDoneAt: null, dispute: true, manualTicket: false, ticketOpenedAt: null };
  it('fila do operador', () => {
    expect(status(r('em_transito'), null, false)).toBe('a_caminho');
    expect(status(r('entregue'), null, false)).toBe('aguardando_conferencia');
    expect(status(r('em_transito', 'cd_plataforma'), null, false)).toBe('com_a_plataforma');
    expect(status(r('encerrada', 'cd_plataforma'), null, false)).toBe('finalizada');
    expect(status(r('entregue'), check, false)).toBe('precisa_acao');
    expect(pending(check, false)).toEqual(['lancar_estoque', 'contestar']);
    expect(status(r('entregue'), { ...check, stockDoneAt: new Date() }, true)).toBe('em_mediacao');
    expect(status(r('entregue'), { ...check, stockDoneAt: new Date() }, true, true)).toBe('resolvida');
    expect(status(r('encerrada'), { ...check, stockDoneAt: new Date() }, true)).toBe('finalizada');
  });
  it('a caminho: comprador postou ou não', () => {
    expect(shipping('label_generated')).toBe('aguardando_postagem');
    expect(shipping('shipped')).toBe('postado');
    expect(shipping('delivered')).toBe('sem_info');
  });
});

describe('leitura do que foi bipado', () => {
  it('QR do ML (JSON), mesmo com prefixo de simbologia', () => {
    expect(extractCodes(']C1{"id":"43215678901","t":"lm"}')).toContain('43215678901');
  });
  it('DANFE (chave de 44 dígitos) e URL da SEFAZ', () => {
    const key = '35260912345678000190550010000123451000123456';
    expect(extractCodes(key)).toContain(key);
    expect(extractCodes(`https://www.fazenda.sp.gov.br/nfce/qrcode?p=${key}|2|1|1|ABC`)).toContain(key);
  });
  it('rastreio e números longos, sem repetir e sem códigos curtos', () => {
    const c = extractCodes('BR123456789BR');
    expect(c).toContain('BR123456789BR');
    expect(extractCodes('ab')).toEqual([]);
    expect(extractCodes('{"id":"555"}')).not.toContain('555');
  });
});
