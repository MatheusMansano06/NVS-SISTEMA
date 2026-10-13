import { z } from 'zod';

// ================= DIFAL (estimativa gerencial)
// Diferencial de alíquota do ICMS em vendas interestaduais a consumidor final. NÃO substitui o
// cálculo do contador: não considera base dupla (LC 190/2022), FECP nem benefícios de cada estado.

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE',
  'PI', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SP', 'SE', 'TO'] as const;
export type UF = (typeof UFS)[number];

export const UF_NAME: Record<UF, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

/** Alíquotas internas padrão (%), valores gerais 2024/2025 — editáveis por empresa. */
export const DEFAULT_INTERNAL_RATES: Record<UF, number> = {
  AC: 19, AL: 20, AP: 18, AM: 20, BA: 20.5, CE: 20, DF: 20, ES: 17, GO: 19, MA: 23, MT: 17, MS: 17, MG: 18, PA: 19,
  PB: 20, PR: 19.5, PE: 20.5, PI: 22.5, RJ: 22, RN: 20, RO: 19.5, RR: 20, RS: 17, SC: 17, SP: 18, SE: 20, TO: 20,
};

/** Sul/Sudeste exceto ES: origem aqui → destino N/NE/CO/ES paga 7%; demais 12%. */
const SOUTH_SOUTHEAST_EXCEPT_ES = new Set<UF>(['PR', 'RS', 'SC', 'MG', 'RJ', 'SP']);

export interface DifalSettingsDto {
  originUf: UF;
  imported: boolean;
  /** Alíquota interna de cada UF (padrão + ajustes da empresa). */
  internalRates: Record<UF, number>;
}

export const difalSettingsSchema = z.object({
  originUf: z.enum(UFS),
  imported: z.boolean(),
  internalRates: z.partialRecord(z.enum(UFS), z.coerce.number().min(0).max(40)).default({}),
});

export function interstateRate(origin: UF, dest: UF, imported: boolean): number {
  if (imported) return 4;
  return SOUTH_SOUTHEAST_EXCEPT_ES.has(origin) && !SOUTH_SOUTHEAST_EXCEPT_ES.has(dest) ? 7 : 12;
}

export interface DifalLineDto {
  uf: UF;
  orders: number;
  base: number;
  interstate: number;
  internal: number;
  rate: number;
  difal: number;
}

export interface DifalResultDto {
  lines: DifalLineDto[];
  total: number;
  /** Base só das vendas interestaduais (as que pagam DIFAL). */
  interstateBase: number;
  base: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeDifal(entries: { uf: UF; orders: number; base: number }[], s: DifalSettingsDto): DifalResultDto {
  let total = 0;
  let base = 0;
  let interstateBase = 0;
  const lines = entries.map((e) => {
    base += e.base;
    const internal = s.internalRates[e.uf] ?? DEFAULT_INTERNAL_RATES[e.uf];
    if (e.uf === s.originUf) return { uf: e.uf, orders: e.orders, base: e.base, interstate: 0, internal, rate: 0, difal: 0 };
    const interstate = interstateRate(s.originUf, e.uf, s.imported);
    const rate = Math.max(0, internal - interstate);
    const difal = round2((e.base * rate) / 100);
    total += difal;
    interstateBase += e.base;
    return { uf: e.uf, orders: e.orders, base: e.base, interstate, internal, rate, difal };
  });
  lines.sort((a, b) => b.difal - a.difal || b.base - a.base);
  return { lines, total: round2(total), interstateBase: round2(interstateBase), base: round2(base) };
}

// ================= Aba Vendas

export const SALES_PERIODS = ['7d', '30d', '90d', 'this_month', 'last_month'] as const;
export type SalesPeriod = (typeof SALES_PERIODS)[number];

export const PAYMENT_GROUPS = ['pix', 'credit', 'debit', 'balance', 'other'] as const;
export type PaymentGroup = (typeof PAYMENT_GROUPS)[number];
export const PAYMENT_LABEL: Record<PaymentGroup, string> = {
  pix: 'Pix',
  credit: 'Cartão de crédito',
  debit: 'Débito',
  balance: 'Saldo Mercado Pago',
  other: 'Outros',
};

/** Agrupa o payment_type do Mercado Pago. */
export function paymentGroup(type: string | null | undefined): PaymentGroup {
  switch (type) {
    case 'bank_transfer':
    case 'pix':
      return 'pix';
    case 'credit_card':
      return 'credit';
    case 'debit_card':
    case 'prepaid_card':
      return 'debit';
    case 'account_money':
      return 'balance';
    default:
      return 'other';
  }
}

export const salesQuerySchema = z.object({
  period: z.enum(SALES_PERIODS).default('30d'),
  listingId: z.string().regex(/^[A-Z]{3}\d+$/).optional(),
  accountId: z.string().uuid().optional(),
});

export const salesOrdersQuerySchema = salesQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  payment: z.enum(PAYMENT_GROUPS).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface SalesOverviewDto {
  range: { from: string; to: string };
  kpis: { orders: number; units: number; revenue: number; profit: number | null; profitPct: number | null; cancelled: number };
  /** Preenchido quando filtrado por um anúncio. */
  listing: { id: string; title: string; sku: string | null; pictureUrl: string | null; stock: number | null; sold: number | null } | null;
  payments: { group: PaymentGroup; orders: number }[];
  shipping: { bucket: string; orders: number }[];
  states: { uf: UF; orders: number; revenue: number }[];
  /** Pedidos pagos com UF conhecida / total (o histórico vai sendo completado em segundo plano). */
  located: { orders: number; total: number };
  difal: DifalResultDto & { settings: DifalSettingsDto; projection: number | null };
  months: { month: string; orders: number; revenue: number; profit: number | null; difal: number }[];
}

export interface SaleOrderDto {
  id: string;
  orderedAt: string;
  status: 'paid' | 'cancelled' | 'returned';
  buyer: string | null;
  packId: string | null;
  payment: PaymentGroup;
  installments: number | null;
  logistic: string | null;
  city: string | null;
  uf: string | null;
  zip: string | null;
  items: { title: string; sku: string; quantity: number; unitPrice: number; listingId: string | null }[];
  revenue: number;
  fee: number;
  freight: number;
  tax: number;
  cost: number | null;
  profit: number | null;
}

export interface SaleOrdersDto {
  items: SaleOrderDto[];
  total: number;
}
