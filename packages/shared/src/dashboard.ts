import { z } from 'zod';
import { MARKETPLACES, type Marketplace } from './onboarding.js';

export const PERIODS = ['today', 'yesterday', '7d', '30d', 'this_month', 'last_month', 'invoice'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  today: 'Hoje',
  yesterday: 'Ontem',
  '7d': '7 dias',
  '30d': '30 dias',
  this_month: 'Este mês',
  last_month: 'Mês passado',
  invoice: 'Fatura atual',
};

export const dashboardQuerySchema = z.object({
  period: z.enum(PERIODS).default('today'),
  marketplace: z.enum(MARKETPLACES).optional(),
  accountId: z.string().uuid().optional(),
  /** Ignora o cache (botão "atualizar"). */
  fresh: z.coerce.boolean().optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export interface KpiSet {
  revenue: number; // faturamento bruto (pedidos pagos)
  net: number; // líquido do marketplace = faturamento - tarifas - frete
  grossProfit: number; // lucro bruto = líquido - custo dos produtos
  margin: number; // lucro bruto / faturamento (0..1)
  orders: number;
  units: number;
  avgTicket: number;
  /** Investido em Mercado Ads no período. */
  adSpend: number;
  /** TACOS: investimento em Ads / faturamento bruto (0..1). */
  tacos: number;
  /** Lucro bruto depois de descontar o investimento em Ads. */
  profitAfterAds: number;
  marginAfterAds: number;
}

/** Situação da leitura do Mercado Ads nas contas do filtro. */
export interface AdsInfoDto {
  status: 'ok' | 'sem_anunciante' | 'sem_permissao' | 'erro' | 'sem_dados';
  message: string | null;
}

export interface SeriesPoint {
  /** Início do intervalo (ISO, fuso de São Paulo). */
  bucket: string;
  revenue: number;
  profit: number;
}

export interface TopProduct {
  sku: string;
  title: string;
  pictureUrl: string | null;
  permalink: string | null;
  units: number;
  avgPrice: number;
  avgCost: number;
  revenue: number;
  share: number; // fração do faturamento do período (0..1)
  profit: number;
  margin: number;
}

export interface PausedListing {
  id: string;
  title: string;
  pictureUrl: string | null;
  permalink: string | null;
  price: number | null;
  availableQuantity: number | null;
  outOfStock: boolean;
  accountNickname: string;
}

export interface DashboardDto {
  range: { from: string; to: string; previousFrom: string; previousTo: string };
  granularity: 'hour' | 'day';
  kpis: KpiSet;
  previous: KpiSet;
  series: SeriesPoint[];
  topProducts: TopProduct[];
  /** Anúncios pausados (sem estoque primeiro). Independe do período. */
  paused: { total: number; outOfStock: number; items: PausedListing[] };
  accounts: { id: string; marketplace: Marketplace; nickname: string }[];
  isDemo: boolean;
  /** Há pedidos reais sem custo de produto cadastrado (lucro/margem consideram custo zero). */
  missingCosts: boolean;
  ads: AdsInfoDto;
  /** Fatura atual: período real do ciclo da fatura do ML (quando o filtro é "Fatura atual"). */
  invoiceLabel: string | null;
  generatedAt: string;
}
