import type { MediationResult, ReturnDestination, ReturnReason, ReturnResponsible, ReturnStage } from '@nvs/shared';

/**
 * Reclamação do ML com devolução → registro único (portado de central/mercado_livre/normalizar.py).
 * Endpoints de pós-venda: /post-purchase/v1/claims, /v2/claims/{id}/returns, charges/return-cost, affects-reputation,
 * /claims/reasons/{id} (triagem do motivo) e /returns/{id}/reviews (condição do produto após a revisão).
 */
export interface ReturnRecord {
  externalId: string;
  orderId: string;
  packId: string | null;
  tracking: string | null;
  stage: ReturnStage;
  platformStatus: string;
  inMediation: boolean;
  canDispute: boolean;
  awaitingReview: boolean;
  reason: ReturnReason;
  reasonPlatform: string;
  responsible: ReturnResponsible;
  destination: ReturnDestination;
  platformCost: number | null;
  affectsReputation: boolean | null;
  productCondition: string | null;
  mediationResult: MediationResult | null;
  coverageApplied: boolean | null;
  sellerDeadline: Date | null;
  items: { itemId: string | null; variationId: string | null; sku: string | null; name: string | null; qty: number }[];
  openedAt: Date;
  updatedAt: Date;
  codes: string[];
  raw: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const STAGE: Record<string, ReturnStage> = {
  pending: 'solicitada', label_generated: 'solicitada', scheduled: 'solicitada',
  shipped: 'em_transito', pending_delivered: 'em_transito', not_delivered: 'em_transito',
  delivered: 'entregue', return_to_buyer: 'encerrada',
  cancelled: 'cancelada', pending_cancel: 'cancelada', expired: 'cancelada',
  pending_expiration: 'cancelada', failed: 'cancelada', pending_failure: 'cancelada',
};
/** rules_engine_triage do motivo → (motivo, responsável). */
const TRIAGE: Record<string, [ReturnReason, ReturnResponsible]> = {
  repentant: ['arrependimento', 'comprador'],
  different: ['diferente', 'vendedor'],
  defective: ['defeito', 'vendedor'],
  not_working: ['defeito', 'vendedor'],
  incomplete: ['incompleto', 'vendedor'],
};
const DESTINATION: Record<string, ReturnDestination> = { seller_address: 'vendedor', warehouse: 'cd_plataforma' };
/** Já em mediação o ML não oferece open_dispute, mas deixa mandar prova ao mediador: também é contestar. */
const DISPUTE_ACTIONS = new Set(['return_review_fail', 'open_dispute', 'send_message_to_mediator']);
export const REVIEW_OK = new Set(['return_review_ok', 'return_review_unified_ok']);

const date = (iso: string | null | undefined) => (iso ? new Date(iso) : null);
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

export function sellerActions(claim: Json): { action: string; due_date?: string }[] {
  return (claim?.players ?? []).filter((p: Json) => p.type === 'seller').flatMap((p: Json) => p.available_actions ?? []);
}

function condition(review: Json): string | null {
  for (const r of review?.reviews ?? []) for (const rr of r.resource_reviews ?? []) if (rr.product_condition) return rr.product_condition;
  return null;
}

function mediation(claim: Json): MediationResult | null {
  if (claim.stage !== 'dispute') return null;
  if (claim.status === 'opened') return 'em_andamento';
  const benefited = new Set<string>(claim.resolution?.benefited ?? []);
  if (benefited.size === 1 && benefited.has('respondent')) return 'ganha'; // respondent = o vendedor
  return benefited.has('respondent') ? 'parcial' : 'perdida';
}

export function normalizeClaim(p: { claim: Json; ret: Json; cost: Json | null; reputation: Json | null; triage: string | null; order: Json | null; review: Json | null }): ReturnRecord {
  const { claim, ret, cost, reputation, triage, order, review } = p;
  const shipment = (ret.shipments ?? [])[0] ?? {};
  const orderItems = new Map<string, Json>((order?.order_items ?? []).map((i: Json) => [String(i.item.id), i.item]));
  const [reason, triageResponsible] = TRIAGE[triage ?? ''] ?? (['outro', 'a_definir'] as [ReturnReason, ReturnResponsible]);
  const costAmount = cost?.amount ?? null;
  const responsible: ReturnResponsible = costAmount ? 'vendedor' : triageResponsible; // o ML já está cobrando: não há o que discutir
  const actions = sellerActions(claim);
  const deadlines = actions.map((a) => date(a.due_date)).filter((d): d is Date => d !== null);
  const affects = reputation?.affects_reputation;
  const claimUpdated = new Date(claim.last_updated);
  const retUpdated = date(ret.last_updated) ?? claimUpdated;
  const shipments = ret.shipments ?? [];
  return {
    externalId: String(claim.id),
    orderId: String(claim.resource_id),
    packId: str(order?.pack_id),
    tracking: str(shipment.tracking_number),
    stage: STAGE[ret.status] ?? 'solicitada',
    platformStatus: ret.status ?? claim.status,
    inMediation: claim.stage === 'dispute',
    canDispute: actions.some((a) => DISPUTE_ACTIONS.has(a.action)),
    awaitingReview: actions.some((a) => REVIEW_OK.has(a.action)),
    reason,
    reasonPlatform: String(claim.reason_id ?? ''),
    responsible,
    destination: ret.subtype === 'low_cost' || !shipments.length ? 'sem_retorno' : (DESTINATION[shipment.destination?.name] ?? 'vendedor'),
    platformCost: costAmount === null ? null : Number(costAmount),
    affectsReputation: affects === 'affected' ? true : affects === 'not_affected' ? false : null,
    productCondition: condition(review),
    mediationResult: mediation(claim),
    coverageApplied: claim.resolution?.applied_coverage ?? null,
    sellerDeadline: deadlines.length ? new Date(Math.min(...deadlines.map((d) => d.getTime()))) : null,
    items: (ret.orders ?? []).map((o: Json) => ({
      itemId: str(o.item_id),
      variationId: str(o.variation_id),
      sku: str(orderItems.get(String(o.item_id))?.seller_sku),
      name: str(orderItems.get(String(o.item_id))?.title),
      qty: Number(o.return_quantity ?? 1),
    })),
    openedAt: new Date(claim.date_created),
    updatedAt: claimUpdated > retUpdated ? claimUpdated : retUpdated,
    // tudo que pode estar na etiqueta que chega na bancada (o comprador às vezes reusa a caixa da ida)
    codes: [claim.id, claim.resource_id, order?.pack_id, ret.id, order?.shipping?.id, ...shipments.flatMap((e: Json) => [e.shipment_id, e.tracking_number])]
      .map(str)
      .filter((c): c is string => c !== null),
    raw: { claim, ret, cost, reputation, triage, review },
  };
}

/** Pacote que não chegou ao comprador e voltou: não abre reclamação, só o pedido com envio "returned". */
export function normalizeNotDelivered(order: Json): ReturnRecord {
  const shipping = String(order.shipping.id);
  return {
    externalId: `envio-${shipping}`,
    orderId: String(order.id),
    packId: str(order.pack_id),
    tracking: null,
    stage: 'entregue',
    platformStatus: 'not_delivered/returned',
    inMediation: false,
    canDispute: false,
    awaitingReview: false,
    reason: 'nao_recebido',
    reasonPlatform: 'pacote_nao_entregue',
    responsible: 'a_definir',
    destination: 'vendedor',
    platformCost: null,
    affectsReputation: false,
    productCondition: null,
    mediationResult: null,
    coverageApplied: null,
    sellerDeadline: null,
    items: (order.order_items ?? []).map((i: Json) => ({
      itemId: str(i.item?.id),
      variationId: str(i.item?.variation_id),
      sku: str(i.item?.seller_sku),
      name: str(i.item?.title),
      qty: Number(i.quantity ?? 1),
    })),
    openedAt: new Date(order.date_created),
    updatedAt: new Date(order.last_updated ?? order.date_created),
    codes: [order.id, order.pack_id, shipping].map(str).filter((c): c is string => c !== null),
    raw: { order },
  };
}
