import { z } from 'zod';
import { staffCostSchema, type StaffMember } from './team-cost.js';

/**
 * DRE simplificado (Demonstração do Resultado): do que você vendeu até o que sobrou no bolso.
 * O que vem do marketplace é automático; o resto a empresa lança como custo variável, despesa fixa ou financeira.
 */
export const DRE_KINDS = ['custo_variavel', 'despesa_fixa', 'despesa_financeira'] as const;
export type DreKind = (typeof DRE_KINDS)[number];
export const DRE_KIND_LABELS: Record<DreKind, string> = {
  custo_variavel: 'Custo variável',
  despesa_fixa: 'Despesa fixa',
  despesa_financeira: 'Despesa financeira',
};

export const DRE_BASES = ['mensal', 'pedido', 'percentual', 'unico'] as const;
export type DreBasis = (typeof DRE_BASES)[number];
export const DRE_BASIS_LABELS: Record<DreBasis, string> = {
  mensal: 'Todo mês',
  pedido: 'Por pedido vendido',
  percentual: '% do faturamento',
  unico: 'Só uma vez',
};

export const DRE_CATEGORIES = ['pessoas', 'estrutura', 'sistemas', 'servicos', 'marketing', 'logistica', 'financeiro', 'outros'] as const;
export type DreCategory = (typeof DRE_CATEGORIES)[number];
export const DRE_CATEGORY_LABELS: Record<DreCategory, string> = {
  pessoas: 'Pessoas',
  estrutura: 'Estrutura',
  sistemas: 'Sistemas e apps',
  servicos: 'Serviços',
  marketing: 'Marketing',
  logistica: 'Logística e embalagem',
  financeiro: 'Bancos e juros',
  outros: 'Outros',
};

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (AAAA-MM)');

export const dreEntrySchema = z
  .object({
    name: z.string().trim().min(1, 'Dê um nome ao gasto').max(80),
    kind: z.enum(DRE_KINDS),
    category: z.enum(DRE_CATEGORIES),
    basis: z.enum(DRE_BASES),
    amount: z.coerce.number().finite().min(0, 'O valor não pode ser negativo').max(10_000_000),
    startMonth: month,
    endMonth: month.nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    /** pessoa da equipe: dados da calculadora de custo real */
    details: staffCostSchema.nullable().optional(),
  })
  .refine((e) => !e.endMonth || e.endMonth >= e.startMonth, { message: 'O fim deve ser depois do início', path: ['endMonth'] })
  .refine((e) => e.basis !== 'percentual' || e.amount <= 100, { message: 'Percentual até 100%', path: ['amount'] });
export type DreEntryInput = z.infer<typeof dreEntrySchema>;

export const dreQuerySchema = z.object({
  month,
  accountId: z.string().uuid().optional(),
  /** vendas sem custo cadastrado: estima custo e imposto pela média das vendas com custo */
  estimarCusto: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** compara com o mês anterior (o Dashboard dispensa) */
  comparar: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  fresh: z.coerce.boolean().optional(),
});
export type DreQuery = z.infer<typeof dreQuerySchema>;

export interface DreEntryDto {
  id: string;
  name: string;
  kind: DreKind;
  category: DreCategory;
  basis: DreBasis;
  amount: number;
  startMonth: string;
  endMonth: string | null;
  notes: string | null;
  details: StaffMember | null;
}

/** Blocos que tiram dinheiro (ou o trazem, na receita), na ordem do DRE. */
export const DRE_SECTIONS = ['receita', 'deducoes', 'cmv', 'variaveis', 'fixas', 'financeiras'] as const;
export type DreSectionId = (typeof DRE_SECTIONS)[number];
/** Resultados parciais: cada um aparece depois do bloco indicado. */
export const DRE_SUBTOTALS = ['receita_liquida', 'lucro_bruto', 'margem_contribuicao', 'lucro_operacional', 'lucro_liquido'] as const;
export type DreSubtotalId = (typeof DRE_SUBTOTALS)[number];
export const DRE_FLOW: (DreSectionId | DreSubtotalId)[] = [
  'receita', 'deducoes', 'receita_liquida', 'cmv', 'lucro_bruto', 'variaveis', 'margem_contribuicao', 'fixas', 'lucro_operacional', 'financeiras', 'lucro_liquido',
];

export interface DreItem {
  key: string;
  label: string;
  valor: number;
  /** calculado pelo sistema (vendas do marketplace); false = lançado pela empresa */
  auto: boolean;
  entryId?: string;
  /** como o valor foi obtido, ex.: "R$ 0,80 × 1.200 pedidos" */
  detail?: string;
  /** parte estimada (vendas sem custo cadastrado) */
  estimated?: boolean;
}

export interface DreSection {
  id: DreSectionId;
  total: number;
  items: DreItem[];
}

export interface DreDto {
  month: string;
  range: { from: string; to: string };
  isCurrentMonth: boolean;
  daysInMonth: number;
  elapsedDays: number;
  sections: DreSection[];
  subtotals: Record<DreSubtotalId, number>;
  receitaBruta: number;
  pedidos: number;
  unidades: number;
  /** faturamento necessário para pagar as despesas fixas e financeiras (lucro zero); null sem margem positiva */
  pontoEquilibrio: number | null;
  /** mês em andamento: fechamento se o ritmo de vendas continuar (fixas já contam o mês inteiro) */
  projecao: { receitaBruta: number; lucroLiquido: number } | null;
  cobertura: { semCustoQtd: number; semCustoValor: number; estimado: boolean };
  previous: { month: string; receitaBruta: number; lucroLiquido: number; margemContribuicao: number } | null;
  lancamentos: number;
  generatedAt: string;
}
