import type { ReturnCheckInput, ReturnClass, ReturnPending, ReturnShipping, ReturnStatus } from '@nvs/shared';

/** Regras da conferência e da operação (portadas de central/conferencia/regras.py e central/operacao/regras.py). */
type Move = { sku: 'vendido' | 'recebido'; deposit: 'vendavel' | 'avaria'; type: 'E' | 'S' };

/** A = volta vendável · B = avaria (nosso produto, sem condição de venda) · C = divergente (não é o que enviamos). */
export function classify(c: ReturnCheckInput): ReturnClass {
  if (!(c.productCorrect || c.ourError)) return 'C';
  return c.resellable ? 'A' : 'B';
}

/**
 * Ajustes de estoque. A venda baixou o SKU VENDIDO; é ele que volta ao saldo, mesmo quando enviamos outro
 * (o enviado por engano nunca saiu do saldo do sistema — só volta para a prateleira).
 */
export function stockMoves(cls: ReturnClass, c: ReturnCheckInput): Move[] {
  if (cls === 'A') return [{ sku: 'vendido', deposit: 'vendavel', type: 'E' }];
  if (cls === 'B' && !c.ourError) return [{ sku: 'vendido', deposit: 'avaria', type: 'E' }];
  if (cls === 'B') {
    return [
      { sku: 'vendido', deposit: 'vendavel', type: 'E' },
      { sku: 'recebido', deposit: 'vendavel', type: 'S' },
      { sku: 'recebido', deposit: 'avaria', type: 'E' },
    ];
  }
  return c.skuReceived ? [{ sku: 'recebido', deposit: 'avaria', type: 'E' }] : [];
}

/** Custo do produto perdido: A nada · B o que voltou estragado · C o vendido, que não voltou. null = sem custo cadastrado. */
export function productLoss(cls: ReturnClass, c: ReturnCheckInput, costSold: number | null, costReceived: number | null, qty: number): number | null {
  if (cls === 'A') return 0;
  const cost = cls === 'B' && c.ourError ? costReceived : costSold;
  return cost === null ? null : Math.round(cost * qty * 100) / 100;
}

export interface Decision {
  class: ReturnClass;
  stockMoves: Move[];
  dispute: boolean;
  manualTicket: boolean;
  decision: string;
  productLoss: number | null;
  reverseFreight: number | null;
}

export function decide(
  ret: { responsible: string; canDispute: boolean; platformCost: number | null },
  c: ReturnCheckInput,
  costSold: number | null = null,
  costReceived: number | null = null,
  qty = 1,
): Decision {
  const cls = classify(c);
  const worth = cls === 'B' || cls === 'C' || ret.responsible === 'vendedor';
  let dispute = false;
  let manualTicket = false;
  let decision: string;
  if (c.ourError) {
    decision = 'Erro nosso (enviamos o produto errado): assumir, não contestar.';
  } else if (worth && !ret.canDispute) {
    manualTicket = true;
    decision = 'Vale contestar, mas o ML não deixa agora: fica na lista de chamados manuais com o prejuízo registrado.';
  } else if (cls === 'B' || cls === 'C') {
    dispute = true;
    decision = 'Produto voltou avariado ou diferente do enviado: contestar para recuperar o valor.';
  } else if (worth) {
    dispute = true;
    decision = 'O comprador alegou problema, mas o produto voltou perfeito: contestar para não pagar o frete reverso.';
  } else {
    decision = 'Sem cobrança para a empresa e produto recuperado: nada a contestar.';
  }
  return {
    class: cls,
    stockMoves: stockMoves(cls, c),
    dispute,
    manualTicket,
    decision,
    productLoss: productLoss(cls, c, costSold, costReceived, qty),
    reverseFreight: ret.platformCost,
  };
}

const FINAL = new Set(['encerrada', 'cancelada']);

export interface CheckState {
  stockMoves: unknown[];
  stockDoneAt: Date | string | null;
  dispute: boolean;
  manualTicket: boolean;
  ticketOpenedAt: Date | string | null;
}

export function pending(check: CheckState | null, disputed: boolean): ReturnPending[] {
  if (!check) return [];
  const out: ReturnPending[] = [];
  if (check.stockMoves.length && !check.stockDoneAt) out.push('lancar_estoque');
  if (check.dispute && !disputed) out.push('contestar');
  if (check.manualTicket && !check.ticketOpenedAt) out.push('chamado_manual');
  return out;
}

/** A ordem importa: o que depende da mão do operador aparece antes do que depende da plataforma. */
export function status(
  ret: { destination: string; stage: string; inMediation: boolean },
  check: CheckState | null,
  disputed: boolean,
  accepted = false,
): ReturnStatus {
  if (pending(check, disputed).length) return 'precisa_acao';
  if (!check) {
    if (ret.destination !== 'vendedor') return FINAL.has(ret.stage) ? 'finalizada' : 'com_a_plataforma';
    if (ret.stage === 'entregue') return 'aguardando_conferencia';
    if (!FINAL.has(ret.stage)) return 'a_caminho';
  }
  if (FINAL.has(ret.stage)) return 'finalizada';
  // aceitar resolve a pendência de contestar, mas não abre mediação
  if (ret.inMediation || (disputed && !accepted)) return 'em_mediacao';
  return 'resolvida';
}

/** Dentro de "a caminho": o comprador ainda não postou × já postou e está vindo. */
export function shipping(platformStatus: string): ReturnShipping {
  const s = platformStatus.toUpperCase();
  if (s === 'SHIPPED') return 'postado';
  return ['LABEL_GENERATED', 'PENDING', 'OPENED'].includes(s) ? 'aguardando_postagem' : 'sem_info';
}
