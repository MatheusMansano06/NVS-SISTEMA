import { z } from 'zod';

/** Central de Devoluções (portada do NOVAES-ESTOQUE): devoluções do ML, conferência na bancada e contestação. */
export type ReturnStage = 'solicitada' | 'em_transito' | 'entregue' | 'encerrada' | 'cancelada';
export type ReturnReason = 'arrependimento' | 'nao_serviu' | 'diferente' | 'defeito' | 'incompleto' | 'danificado' | 'nao_recebido' | 'falha_entrega' | 'outro';
export type ReturnResponsible = 'comprador' | 'vendedor' | 'a_definir';
export type ReturnDestination = 'vendedor' | 'cd_plataforma' | 'sem_retorno';
export type ReturnClass = 'A' | 'B' | 'C';
export type MediationResult = 'em_andamento' | 'ganha' | 'perdida' | 'parcial';

/** Em que pé está cada devolução, para quem opera a bancada (a ordem é a da fila de trabalho). */
export const RETURN_STATUSES = ['a_caminho', 'aguardando_conferencia', 'precisa_acao', 'em_mediacao', 'com_a_plataforma', 'resolvida', 'finalizada'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export type ReturnShipping = 'aguardando_postagem' | 'postado' | 'sem_info';
export type ReturnPending = 'lancar_estoque' | 'contestar' | 'chamado_manual';

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  a_caminho: 'A caminho',
  aguardando_conferencia: 'Aguardando conferência',
  precisa_acao: 'Precisa de ação',
  em_mediacao: 'Em mediação',
  com_a_plataforma: 'Com o ML (Full)',
  resolvida: 'Resolvida',
  finalizada: 'Finalizada',
};
export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  arrependimento: 'Arrependimento',
  nao_serviu: 'Não serviu',
  diferente: 'Diferente do anúncio',
  defeito: 'Defeito',
  incompleto: 'Incompleto',
  danificado: 'Danificado',
  nao_recebido: 'Não recebido',
  falha_entrega: 'Falha na entrega',
  outro: 'Outro',
};
export const RETURN_CLASS_LABELS: Record<ReturnClass, string> = {
  A: 'A · volta para a venda',
  B: 'B · avaria',
  C: 'C · divergente (não é o que enviamos)',
};
export const RETURN_PENDING_LABELS: Record<ReturnPending, string> = {
  lancar_estoque: 'Ajustar estoque',
  contestar: 'Contestar no ML',
  chamado_manual: 'Abrir chamado no ML',
};
export const RETURN_SHIPPING_LABELS: Record<ReturnShipping, string> = {
  aguardando_postagem: 'Comprador ainda não postou',
  postado: 'Postado, vindo',
  sem_info: 'Sem informação',
};

// ---- entradas
export const returnFindSchema = z.object({
  code: z.string().trim().min(3, 'Bipe ou digite o código').max(2000),
  /** Código bipado que não foi achado e que o operador vinculou digitando a venda: fica para o próximo bipe. */
  label: z.string().trim().max(2000).optional(),
});
export const returnCheckSchema = z.object({
  productCorrect: z.boolean(),
  complete: z.boolean(),
  unused: z.boolean(),
  resellable: z.boolean(),
  ourError: z.boolean().default(false),
  skuReceived: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type ReturnCheckInput = z.infer<typeof returnCheckSchema>;
export const returnDisputeSchema = z.object({
  reason: z.string().trim().min(1, 'Escolha o motivo').max(40),
  reasonText: z.string().trim().max(200).optional(),
  message: z.string().trim().min(10, 'Explique em pelo menos 10 caracteres').max(2000),
});
export const returnTicketSchema = z.object({ protocol: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional() });
export const returnReplySchema = z.object({ text: z.string().trim().min(1).max(300) });
export const returnListQuerySchema = z.object({
  status: z.string().max(200).optional(),
  reason: z.string().max(30).optional(),
  shipping: z.enum(['aguardando_postagem', 'postado', 'sem_info']).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

// ---- saídas
export interface ReturnItemDto {
  itemId: string | null;
  sku: string | null;
  name: string | null;
  qty: number;
  pictureUrl: string | null;
}

export interface ReturnCheckDto {
  class: ReturnClass;
  productCorrect: boolean;
  complete: boolean;
  unused: boolean;
  resellable: boolean;
  ourError: boolean;
  skuReceived: string | null;
  note: string | null;
  /** Ajustes de estoque que a conferência pede (ex.: SKU vendido → depósito vendável). */
  stockMoves: { sku: 'vendido' | 'recebido'; deposit: 'vendavel' | 'avaria'; type: 'E' | 'S' }[];
  dispute: boolean;
  decision: string;
  manualTicket: boolean;
  ticketOpenedAt: string | null;
  ticketProtocol: string | null;
  productLoss: number | null;
  reverseFreight: number | null;
  stockDoneAt: string | null;
  checkedBy: string | null;
  checkedAt: string;
}

export interface ReturnRowDto {
  id: string;
  externalId: string;
  orderId: string;
  packId: string | null;
  tracking: string | null;
  stage: ReturnStage;
  platformStatus: string;
  inMediation: boolean;
  canDispute: boolean;
  /** O ML ainda espera a revisão do vendedor ("Já revisei" aberto). */
  awaitingReview: boolean;
  reason: ReturnReason;
  reasonPlatform: string;
  responsible: ReturnResponsible;
  destination: ReturnDestination;
  platformCost: number | null;
  affectsReputation: boolean | null;
  productCondition: string | null;
  mediationResult: MediationResult | null;
  sellerDeadline: string | null;
  items: ReturnItemDto[];
  openedAt: string;
  updatedAt: string;
  status: ReturnStatus;
  pending: ReturnPending[];
  shipping: ReturnShipping | null;
  check: ReturnCheckDto | null;
  disputed: boolean;
  /** Prejuízo: frete reverso + produto perdido (pela conferência) ou o que o ML cobra. */
  loss: number | null;
  /** Painel do vendedor no ML (a reclamação fica atrás do login). */
  link: string;
}

export interface ReturnListDto {
  total: number;
  counts: Record<ReturnStatus, number>;
  onTheWay: Record<ReturnShipping, number>;
  items: ReturnRowDto[];
}

export interface ReturnSummaryDto {
  attention: { dispute: number; manualTickets: number; stock: number; awaitingCheck: number; deadline24h: number };
  counts: Record<ReturnStatus, number>;
  onTheWay: Record<ReturnShipping, number>;
  latest: ReturnRowDto[];
  lastSync: string | null;
  connected: boolean;
}

export interface ReturnEvidenceDto {
  id: string;
  mime: string;
  size: number;
  addedAt: string;
}

export interface ReturnDisputeDto {
  id: string;
  reason: string;
  message: string;
  ok: boolean;
  path: string | null;
  warning: string | null;
  error: string | null;
  sentAt: string;
  sentBy: string | null;
}

export interface ReturnDetailDto {
  row: ReturnRowDto;
  evidence: ReturnEvidenceDto[];
  disputes: ReturnDisputeDto[];
  /** Fotos que a contestação exige (o ML pede ao menos uma foto). */
  evidenceRequired: boolean;
}

export interface ReturnFindDto {
  matches: ReturnDetailDto[];
}

export interface ReturnBiDto {
  days: number;
  from: string;
  to: string;
  total: number;
  totalPrevious: number;
  money: ReturnMoneyDto;
  moneyPrevious: ReturnMoneyDto;
  reasons: { reason: ReturnReason; qty: number; pct: number }[];
  products: { sku: string | null; name: string | null; pictureUrl: string | null; qty: number; loss: number }[];
  mediations: { ganha: number; perdida: number; parcial: number; em_andamento: number };
  classes: Record<ReturnClass, number>;
  statuses: Partial<Record<ReturnStatus, number>>;
  series: { day: string; total: number; resolved: number; open: number; cost: number }[];
}

export interface ReturnMoneyDto {
  /** Frete reverso que o ML cobrou (ou está cobrando). */
  reverseFreight: number;
  freightRefunded: number;
  freightInMediation: number;
  /** Produto que voltou quebrado/divergente (conferido) ou estimado pelo motivo. */
  productLoss: number;
  recovered: number;
  totalCost: number;
  /** Devoluções com perda sem custo cadastrado (Cadastro de SKUs). */
  withoutCost: number;
}

export interface ReturnSyncDto {
  claims: number;
  saved: number;
  failures: number;
}
