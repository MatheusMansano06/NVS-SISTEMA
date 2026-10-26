import { z } from 'zod';

/**
 * Radar ADS: regras e metas sobre as campanhas do Mercado Ads. As métricas são calculadas a partir dos totais do
 * período (nunca da média de porcentagens diárias), com as mesmas fórmulas do ML:
 *   ACOS = investimento ÷ venda com Ads · TACOS = investimento ÷ (venda com Ads + venda orgânica dos mesmos itens).
 */

/** Totais de um período (campanha, anúncio ou conta). */
export interface AdTotals {
  cost: number;
  clicks: number;
  prints: number;
  directAmount: number;
  indirectAmount: number;
  units: number;
  organicUnits: number;
  organicAmount: number;
}

export const EMPTY_AD_TOTALS: AdTotals = {
  cost: 0, clicks: 0, prints: 0, directAmount: 0, indirectAmount: 0, units: 0, organicUnits: 0, organicAmount: 0,
};

export function sumAdTotals(rows: readonly AdTotals[]): AdTotals {
  const t = { ...EMPTY_AD_TOTALS };
  for (const r of rows) for (const k of Object.keys(t) as (keyof AdTotals)[]) t[k] += r[k];
  return t;
}

export const AD_METRICS = [
  'tacos', 'acos', 'acos_vs_alvo', 'roas', 'investimento', 'vendas_ads', 'receita_total', 'cpc', 'ctr', 'conversao',
  'cliques', 'impressoes', 'unidades',
] as const;
export type AdMetric = (typeof AD_METRICS)[number];

/** unit: como mostrar o valor — % (porcentagem), pp (pontos percentuais), x (vezes), brl (reais) ou un (contagem). */
export const AD_METRIC_INFO: Record<AdMetric, { label: string; unit: '%' | 'pp' | 'x' | 'brl' | 'un' }> = {
  tacos: { label: 'TACOS', unit: '%' },
  acos: { label: 'ACOS', unit: '%' },
  acos_vs_alvo: { label: 'ACOS acima do alvo', unit: 'pp' },
  roas: { label: 'ROAS', unit: 'x' },
  investimento: { label: 'Investimento', unit: 'brl' },
  vendas_ads: { label: 'Vendas com Ads', unit: 'brl' },
  receita_total: { label: 'Receita total', unit: 'brl' },
  cpc: { label: 'CPC', unit: 'brl' },
  ctr: { label: 'CTR', unit: '%' },
  conversao: { label: 'Conversão', unit: '%' },
  cliques: { label: 'Cliques', unit: 'un' },
  impressoes: { label: 'Impressões', unit: 'un' },
  unidades: { label: 'Unidades vendidas', unit: 'un' },
};

const ratio = (a: number, b: number, scale = 1) => (b > 0 ? Math.round((a / b) * scale * 100) / 100 : null);

/** Valor da métrica nos totais; null quando não dá para calcular (ex.: ACOS sem venda, alvo sem campanha). */
export function adMetric(metric: AdMetric, t: AdTotals, ctx: { acosTarget?: number | null } = {}): number | null {
  const adsSales = t.directAmount + t.indirectAmount;
  switch (metric) {
    case 'tacos': return ratio(t.cost, adsSales + t.organicAmount, 100);
    case 'acos': return ratio(t.cost, adsSales, 100);
    case 'acos_vs_alvo': {
      const acos = ratio(t.cost, adsSales, 100);
      return acos === null || ctx.acosTarget == null ? null : Math.round((acos - ctx.acosTarget) * 100) / 100;
    }
    case 'roas': return ratio(adsSales, t.cost);
    case 'investimento': return Math.round(t.cost * 100) / 100;
    case 'vendas_ads': return Math.round(adsSales * 100) / 100;
    case 'receita_total': return Math.round((adsSales + t.organicAmount) * 100) / 100;
    case 'cpc': return ratio(t.cost, t.clicks);
    case 'ctr': return ratio(t.clicks, t.prints, 100);
    case 'conversao': return ratio(t.units, t.clicks, 100);
    case 'cliques': return t.clicks;
    case 'impressoes': return t.prints;
    case 'unidades': return t.units;
  }
}

/** Janelas: "hoje" é parcial; as de dias fecham ontem; "mes" vai do dia 1 até hoje. */
export const AD_WINDOWS = ['hoje', 'ontem', '3d', '7d', '14d', '30d', 'mes'] as const;
export type AdWindow = (typeof AD_WINDOWS)[number];
export const AD_WINDOW_LABELS: Record<AdWindow, string> = {
  hoje: 'hoje (parcial)', ontem: 'ontem', '3d': 'últimos 3 dias', '7d': 'últimos 7 dias', '14d': 'últimos 14 dias',
  '30d': 'últimos 30 dias', mes: 'mês atual',
};

/** sobe / cai: variação (%) contra a janela anterior de mesmo tamanho. */
export const AD_OPS = ['maior', 'menor', 'sobe', 'cai'] as const;
export type AdOp = (typeof AD_OPS)[number];
export const AD_OP_LABELS: Record<AdOp, string> = { maior: 'maior que', menor: 'menor que', sobe: 'subiu mais de', cai: 'caiu mais de' };

export const adConditionSchema = z.object({
  metric: z.enum(AD_METRICS),
  window: z.enum(AD_WINDOWS),
  op: z.enum(AD_OPS),
  value: z.number().finite(),
});
export type AdCondition = z.infer<typeof adConditionSchema>;

export const AD_RULE_SCOPES = ['conta', 'campanhas', 'campanha'] as const;
export type AdRuleScope = (typeof AD_RULE_SCOPES)[number];

export const adRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    accountId: z.string().uuid().nullable().default(null),
    scope: z.enum(AD_RULE_SCOPES),
    campaignId: z.number().int().positive().nullable().default(null),
    conditions: z.array(adConditionSchema).min(1).max(5),
    enabled: z.boolean().default(true),
    cooldownHours: z.number().int().min(1).max(720).default(24),
  })
  .refine((r) => (r.scope === 'campanha') === (r.campaignId !== null), { message: 'Escolha a campanha da regra', path: ['campaignId'] });
export type AdRuleInput = z.infer<typeof adRuleInputSchema>;

export const AD_GOAL_KINDS = ['gasto_mes', 'gasto_ano', 'tacos'] as const;
export type AdGoalKind = (typeof AD_GOAL_KINDS)[number];

export const adGoalInputSchema = z
  .object({
    accountId: z.string().uuid().nullable().default(null),
    kind: z.enum(AD_GOAL_KINDS),
    periodStart: z.string().regex(/^\d{4}-\d{2}-01$/).nullable().default(null),
    target: z.number().positive(),
  })
  .refine((g) => (g.kind === 'tacos') === (g.periodStart === null), { message: 'Meta de gasto precisa do período', path: ['periodStart'] })
  .refine((g) => g.kind !== 'gasto_ano' || g.periodStart?.endsWith('-01-01'), { message: 'Meta do ano começa em janeiro', path: ['periodStart'] })
  .refine((g) => g.kind !== 'tacos' || g.target <= 100, { message: 'TACOS vai até 100%', path: ['target'] });
export type AdGoalInput = z.infer<typeof adGoalInputSchema>;

/** ok · atencao (a 85% do limite) · estourado (passou do limite). */
export type AdStatus = 'ok' | 'atencao' | 'estourado';

export const adSimulateSchema = z
  .object({
    accountId: z.string().uuid().nullable().default(null),
    scope: z.enum(AD_RULE_SCOPES),
    campaignId: z.number().int().positive().nullable().default(null),
    conditions: z.array(adConditionSchema).min(1).max(5),
    cooldownHours: z.number().int().min(1).max(720).default(24),
    days: z.number().int().min(7).max(60).default(30),
  })
  .refine((r) => (r.scope === 'campanha') === (r.campaignId !== null), { message: 'Escolha a campanha da regra', path: ['campaignId'] });
export type AdSimulateInput = z.infer<typeof adSimulateSchema>;

// ---------------------------------------------------------------- respostas da API

/** Resumo de um período: as métricas que a tela mostra em todo lugar. */
export interface AdKpisDto {
  cost: number;
  adsSales: number;
  totalSales: number;
  tacos: number | null;
  acos: number | null;
  roas: number | null;
  clicks: number;
}

export interface AdCampaignDto {
  accountId: string;
  campaignId: number;
  name: string;
  /** Situação no ML (active, paused…). */
  mlStatus: string;
  /** Situação no Radar: pior resultado das regras que valem para ela (sem regra, ACOS de 7 dias contra o alvo). */
  status: AdStatus;
  acosTarget: number | null;
  budget: number | null;
  strategy: string | null;
  last7: AdKpisDto;
  /** TACOS dia a dia dos últimos 7 dias (null sem venda). */
  trend: (number | null)[];
  rules: number;
}

export interface AdGoalDto {
  id: string;
  accountId: string | null;
  kind: AdGoalKind;
  periodStart: string | null;
  target: number;
  /** Gasto do período (metas de gasto) ou TACOS do mês (objetivo de TACOS). */
  current: number | null;
  /** Só nas metas de gasto. */
  pace: { idealToDate: number; projected: number; elapsed: number; paceDiff: number; status: 'acima' | 'no_ritmo' | 'abaixo' } | null;
  status: AdStatus;
}

export interface AdRuleDto {
  id: string;
  name: string;
  accountId: string | null;
  scope: AdRuleScope;
  campaignId: number | null;
  conditions: AdCondition[];
  enabled: boolean;
  cooldownHours: number;
  /** Agora: campanhas (ou a conta) em cada situação. */
  now: Record<AdStatus, number>;
  lastFiredAt: string | null;
}

export interface AdEventDto {
  id: string;
  ruleId: string;
  ruleName: string;
  accountId: string | null;
  campaignId: number | null;
  firedAt: string;
  message: string;
  read: boolean;
}

export interface AdsRadarOverviewDto {
  /** Situação da leitura: sem anunciante / sem permissão vêm da leitura do investimento. */
  account: { status: 'ok' | 'sem_anunciante' | 'sem_permissao' | 'erro' | 'sem_conta'; syncedAt: string | null; backfilled: boolean; error: string | null };
  today: string;
  last7: AdKpisDto;
  prev7: AdKpisDto;
  campaigns: Record<AdStatus, number> & { total: number };
  goals: AdGoalDto[];
  rules: AdRuleDto[];
  unread: number;
}

export interface AdDailyDto {
  day: string;
  cost: number;
  adsSales: number;
  totalSales: number;
  tacos: number | null;
  acos: number | null;
}

export interface AdItemDto {
  itemId: string;
  title: string | null;
  thumbnail: string | null;
  status: string | null;
  price: number | null;
  last7: AdKpisDto;
}

export interface AdCampaignDetailDto {
  campaign: AdCampaignDto;
  series: AdDailyDto[];
  rules: AdRuleDto[];
  events: AdEventDto[];
  items: AdItemDto[];
}

export interface AdSimulationDto {
  days: number;
  /** Disparos no período, somando todas as campanhas avaliadas. */
  total: number;
  targets: { campaignId: number | null; name: string; hits: string[] }[];
}

/** Formata o valor de uma métrica para mensagens ("5,2%", "R$ 1.234,50", "9,8x", "+1,2 p.p."). */
export function formatAdMetric(metric: AdMetric, v: number): string {
  const n = (x: number, d = 1) => x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  switch (AD_METRIC_INFO[metric].unit) {
    case '%': return `${n(v)}%`;
    case 'pp': return `${v > 0 ? '+' : ''}${n(v)} p.p.`;
    case 'x': return `${n(v)}x`;
    case 'brl': return `R$ ${n(v, 2)}`;
    case 'un': return Math.round(v).toLocaleString('pt-BR');
  }
}
