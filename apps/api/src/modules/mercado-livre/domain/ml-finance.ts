/**
 * Regras financeiras do Mercado Livre portadas do NVS-WMS (financeiro_ml/calc.py + aggregator.py).
 * Funções puras: recebem os payloads do ML e devolvem números prontos.
 */
export type LogisticBucket = 'full' | 'flex' | 'places_coleta' | 'me1' | 'outros';

export interface MlPayment {
  status?: string | null;
  payment_type?: string | null;
  installments?: number | null;
  shipping_cost?: number | null;
  transaction_amount_refunded?: number | null;
}

export interface MlShipment {
  logistic_type?: string | null;
  mode?: string | null;
  shipping_option?: { cost?: number | null; list_cost?: number | null } | null;
  receiver_cost?: number | null;
  receiver_shipping_cost?: number | null;
  receiver_address?: {
    zip_code?: string | null;
    city?: { name?: string | null } | null;
    state?: { id?: string | null; name?: string | null } | null;
  } | null;
}

/** Destino do envio: UF (de "BR-SP"), cidade e CEP. */
export function shipmentAddress(s: MlShipment): { uf: string | null; city: string | null; zip: string | null } {
  const a = s.receiver_address;
  const uf = a?.state?.id?.replace(/^BR-/, '').toUpperCase() ?? null;
  return {
    uf: uf && /^[A-Z]{2}$/.test(uf) ? uf : null,
    city: a?.city?.name ?? null,
    zip: a?.zip_code ?? null,
  };
}

export interface MlShipmentCosts {
  receiver?: { save?: number | null; discounts?: { type?: string }[] | null } | null;
  senders?: { user_id?: number | null; cost?: number | null; save?: number | null }[] | null;
}

export interface MlDiscounts {
  details?: { type?: string; items?: { amounts?: { seller?: number | null } | null }[] | null }[] | null;
}

const PAGAMENTO_EFETIVADO = new Set(['approved', 'refunded', 'charged_back', 'in_mediation']);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Modalidade logística (breakdown): ME1, Full, Flex, Coleta ou Outros. */
export function logisticBucket(logisticType?: string | null, shippingMode?: string | null): LogisticBucket {
  if (shippingMode === 'me1') return 'me1';
  if (logisticType === 'fulfillment') return 'full';
  if (logisticType === 'self_service') return 'flex';
  if (logisticType === 'drop_off' || logisticType === 'cross_docking' || logisticType === 'xd_drop_off') return 'places_coleta';
  return 'outros';
}

/**
 * Frete pago pelo comprador: maior valor explícito entre pagamentos EFETIVADOS e o envio
 * (tentativas canceladas/rejeitadas não cobraram frete).
 */
export function buyerShippingCost(payments: MlPayment[] | null | undefined, shipment: MlShipment | null): number {
  const candidates: number[] = [];
  for (const p of payments ?? []) {
    if (p.status && !PAGAMENTO_EFETIVADO.has(p.status)) continue;
    candidates.push(n(p.shipping_cost));
  }
  if (shipment) {
    candidates.push(n(shipment.shipping_option?.cost));
    if (shipment.receiver_cost != null) candidates.push(n(shipment.receiver_cost));
    if (shipment.receiver_shipping_cost != null) candidates.push(n(shipment.receiver_shipping_cost));
  }
  return Math.max(0, ...candidates);
}

/** Frete Flex subsidiado a partir dos custos do envio (quando o comprador aparece com frete zero). */
export function buyerFreightFromCosts(costs: MlShipmentCosts, sellerId: number, logisticType?: string | null): number | null {
  const receiver = costs.receiver;
  const senders = costs.senders;
  if (!receiver || !Array.isArray(senders)) return null;
  let sender = senders.find((s) => s?.user_id === sellerId);
  if (!sender && senders.length === 1 && senders[0]?.user_id == null) sender = senders[0];
  if (!sender || typeof sender.cost !== 'number') return null;
  const senderCost = sender.cost;
  const senderSave = n(sender.save);
  const receiverSave = n(receiver.save);
  if ([senderCost, senderSave, receiverSave].some((v) => v < 0)) return null;
  const types = new Set((receiver.discounts ?? []).map((d) => d?.type));
  if (types.has('loyal') && senderCost === 0 && receiverSave > 0) return receiverSave;
  if (types.has('ratio') && senderCost > 0 && senderSave > 0 && logisticType === 'self_service') return senderSave;
  return null;
}

/**
 * Fretes do envio: comprador (FC) e vendedor (FV = custo de tabela − FC, nunca negativo).
 * `uncertain` = FC zerado sem os custos do envio para confirmar (não assume zero às cegas).
 */
export function shipmentFreight(p: {
  payments: MlPayment[] | null | undefined;
  shipment: MlShipment;
  costs: MlShipmentCosts | null;
  sellerId: number;
}): { buyer: number; seller: number; bucket: LogisticBucket; uncertain: boolean } {
  let buyer = buyerShippingCost(p.payments, p.shipment);
  const listCost = n(p.shipment.shipping_option?.list_cost);
  let uncertain = false;
  if (buyer === 0) {
    if (p.costs) buyer = buyerFreightFromCosts(p.costs, p.sellerId, p.shipment.logistic_type) ?? 0;
    else uncertain = true;
  }
  return {
    buyer: round2(buyer),
    seller: round2(Math.max(0, listCost - buyer)),
    bucket: logisticBucket(p.shipment.logistic_type, p.shipment.mode),
    uncertain,
  };
}

/** Cupom bancado pelo vendedor (campanhas onde o seller paga o desconto). */
export function sellerCoupon(discounts: MlDiscounts | null | undefined): number {
  let total = 0;
  for (const d of discounts?.details ?? []) {
    if (d?.type !== 'coupon') continue;
    for (const it of d.items ?? []) total += n(it?.amounts?.seller);
  }
  return round2(total);
}

/** Devolução parcial: valor estornado nos pagamentos, exceto em pedido cancelado (aí é total). */
export function partialRefund(status: string, payments: MlPayment[] | null | undefined): number {
  if (status === 'cancelled') return 0;
  return round2((payments ?? []).reduce((s, p) => s + n(p.transaction_amount_refunded), 0));
}

/** Linha do ICMS-DIFAL na fatura do ML ("Cobrança do diferencial de alíquota interestadual (ICMS-DIFAL)"). */
const DIFAL_LABEL = /difal|diferencial de al[ií]quota/i;

/** DIFAL cobrado no período = soma das cobranças de DIFAL − estornos de DIFAL nas bonificações. */
export function billedDifal(s: { bill_includes?: { charges?: { label?: string | null; amount?: number | null }[] | null; bonuses?: { label?: string | null; amount?: number | null }[] | null } | null }): number {
  const sum = (lines: { label?: string | null; amount?: number | null }[] | null | undefined) =>
    (lines ?? []).filter((l) => DIFAL_LABEL.test(l.label ?? '')).reduce((a, l) => a + Math.abs(n(l.amount)), 0);
  return round2(Math.max(0, sum(s.bill_includes?.charges) - sum(s.bill_includes?.bonuses)));
}
