import { z } from 'zod';

/**
 * Pesquisa de viabilidade (Precificador › Viabilidade): a planilha de viabilidade da mentoria dentro do sistema.
 * Usa as tabelas fixas do Mercado Livre — funciona sem conta conectada, para pesquisar produto que ainda não vende.
 *   abaixo de R$ 79: o comprador paga o frete e o vendedor paga um custo fixo por faixa de preço × peso;
 *   a partir de R$ 79: frete grátis, pago pelo vendedor, por faixa de preço × peso.
 */

/** Limite superior (kg, exclusivo) de cada faixa de peso. A última vai ao infinito. */
const WEIGHT_UPPER = [0.3, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15, 17, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, Infinity];

/** Faixas de preço: as 3 primeiras (< R$ 79) cobram custo fixo, as 5 seguintes cobram o frete. */
const PRICE_BANDS = [
  { min: 0, max: 19, kind: 'fixed' },
  { min: 19, max: 49, kind: 'fixed' },
  { min: 49, max: 79, kind: 'fixed' },
  { min: 79, max: 100, kind: 'freight' },
  { min: 100, max: 120, kind: 'freight' },
  { min: 120, max: 150, kind: 'freight' },
  { min: 150, max: 200, kind: 'freight' },
  { min: 200, max: Infinity, kind: 'freight' },
] as const;

/** Linha = faixa de peso; coluna = faixa de preço (mesma ordem de PRICE_BANDS). Tabela do ML usada na planilha. */
const TABLE: readonly (readonly number[])[] = [
  [5.65, 6.55, 7.75, 12.35, 14.35, 16.45, 18.45, 20.95],
  [5.95, 6.65, 7.85, 13.25, 15.45, 17.65, 19.85, 22.55],
  [6.05, 6.75, 7.95, 13.85, 16.15, 18.45, 20.75, 23.65],
  [6.15, 6.85, 8.05, 14.15, 16.45, 18.85, 21.15, 24.65],
  [6.25, 6.95, 8.15, 14.45, 16.85, 19.25, 21.65, 24.65],
  [6.35, 7.95, 8.55, 15.75, 18.35, 21.05, 23.65, 26.25],
  [6.45, 8.15, 8.95, 17.05, 19.85, 22.65, 25.55, 28.35],
  [6.55, 8.35, 9.75, 18.45, 21.55, 24.65, 27.75, 30.75],
  [6.65, 8.55, 9.95, 25.45, 28.55, 32.65, 35.75, 39.75],
  [6.75, 8.75, 10.15, 27.05, 31.05, 36.05, 40.05, 44.05],
  [6.85, 8.95, 10.35, 28.85, 33.65, 38.45, 43.25, 48.05],
  [6.95, 9.15, 10.55, 29.65, 34.55, 39.55, 44.45, 49.35],
  [7.05, 9.55, 10.95, 41.25, 48.05, 54.95, 61.75, 68.65],
  [7.15, 9.95, 11.35, 42.15, 49.25, 56.25, 63.25, 70.25],
  [7.25, 10.15, 11.55, 45.05, 52.45, 59.95, 67.45, 74.95],
  [7.35, 10.35, 11.75, 48.55, 56.05, 63.55, 70.75, 78.65],
  [7.45, 10.55, 11.95, 54.75, 63.85, 72.95, 82.05, 91.15],
  [7.65, 10.95, 12.15, 64.05, 75.05, 84.75, 95.35, 105.95],
  [7.75, 11.15, 12.35, 65.95, 75.45, 85.55, 96.25, 106.95],
  [7.85, 11.35, 12.55, 67.75, 78.95, 88.95, 99.15, 107.05],
  [7.95, 11.55, 12.75, 70.25, 81.05, 92.05, 102.55, 110.75],
  [8.05, 11.75, 12.95, 74.95, 86.45, 98.15, 109.35, 118.15],
  [8.15, 11.95, 13.15, 80.25, 92.95, 105.05, 117.15, 126.55],
  [8.25, 12.15, 13.35, 83.95, 97.05, 109.85, 122.45, 132.25],
  [8.35, 12.35, 13.55, 93.25, 107.45, 122.05, 136.05, 146.95],
  [8.45, 12.55, 13.75, 106.55, 123.95, 139.55, 155.55, 167.95],
  [8.55, 12.75, 13.95, 119.25, 138.05, 156.05, 173.95, 187.95],
  [8.65, 12.75, 14.15, 126.55, 146.15, 165.65, 184.65, 199.45],
  [8.75, 12.75, 14.35, 166.15, 192.45, 217.55, 242.55, 261.95],
];

/** Divisor do peso cubado do ML: altura × largura × comprimento (cm) / 6000 = kg. */
export const CUBIC_DIVISOR = 6000;

export interface PricingStudyInput {
  price: number | null;
  cost: number | null;
  /** Comissão da categoria (%), ex.: 11,5 no Clássico. */
  feePct: number;
  taxPct: number;
  packaging: number;
  /** cm */
  height: number | null;
  width: number | null;
  length: number | null;
  /** kg */
  weightKg: number | null;
}

export interface PricingStudyResult {
  /** Peso cubado (kg), ou null sem as 3 medidas. */
  cubicKg: number | null;
  /** Peso cobrado = maior entre real e cubado. */
  billedKg: number | null;
  billedBy: 'real' | 'cubic' | null;
  /** Rótulo da faixa de peso usada, ex.: "0,5 a 1 kg". */
  weightBand: string | null;
  commission: number;
  /** Custo fixo do ML (venda abaixo de R$ 79). */
  fixedFee: number;
  /** Frete pago pelo vendedor (venda a partir de R$ 79). */
  freight: number;
  tax: number;
  packaging: number;
  cost: number;
  /** Margem de contribuição por unidade (R$); null sem preço ou sem custo. */
  margin: number | null;
  /** Fração (0,15 = 15%). */
  marginPct: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const kgLabel = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

function weightIndex(kg: number) {
  return WEIGHT_UPPER.findIndex((u) => kg < u);
}

function bandLabel(i: number) {
  const lo = i === 0 ? 0 : WEIGHT_UPPER[i - 1]!;
  const hi = WEIGHT_UPPER[i]!;
  if (i === 0) return `até ${kgLabel(hi)} kg`;
  return hi === Infinity ? `mais de ${kgLabel(lo)} kg` : `${kgLabel(lo)} a ${kgLabel(hi)} kg`;
}

function priceIndex(price: number) {
  return PRICE_BANDS.findIndex((b) => price >= b.min && price < b.max);
}

/** Peso que o ML cobra: o maior entre o real e o cubado. */
export function billedWeight(p: Pick<PricingStudyInput, 'height' | 'width' | 'length' | 'weightKg'>) {
  const cubicKg = p.height && p.width && p.length ? (p.height * p.width * p.length) / CUBIC_DIVISOR : null;
  const real = p.weightKg && p.weightKg > 0 ? p.weightKg : null;
  if (real === null && cubicKg === null) return { cubicKg, billedKg: null, billedBy: null };
  const byCubic = cubicKg !== null && (real === null || cubicKg > real);
  return { cubicKg, billedKg: byCubic ? cubicKg! : real!, billedBy: byCubic ? ('cubic' as const) : ('real' as const) };
}

/** Custo do ML (fixo ou frete) para um preço e peso cobrado. Sem peso, considera zero. */
function mlShipping(price: number, billedKg: number | null) {
  if (billedKg === null) return { fixedFee: 0, freight: 0 };
  const v = TABLE[weightIndex(billedKg)]![priceIndex(price)]!;
  return PRICE_BANDS[priceIndex(price)]!.kind === 'fixed' ? { fixedFee: v, freight: 0 } : { fixedFee: 0, freight: v };
}

export function computePricingStudy(p: PricingStudyInput): PricingStudyResult {
  const w = billedWeight(p);
  const price = p.price && p.price > 0 ? p.price : 0;
  const { fixedFee, freight } = price ? mlShipping(price, w.billedKg) : { fixedFee: 0, freight: 0 };
  const commission = r2((price * p.feePct) / 100);
  const tax = r2((price * p.taxPct) / 100);
  const cost = p.cost ?? 0;
  const margin = price && p.cost !== null ? r2(price - cost - commission - fixedFee - freight - tax - p.packaging) : null;
  return {
    ...w,
    weightBand: w.billedKg === null ? null : bandLabel(weightIndex(w.billedKg)),
    commission,
    fixedFee,
    freight,
    tax,
    packaging: p.packaging,
    cost,
    margin,
    marginPct: margin === null ? null : margin / price,
  };
}

/**
 * Menor preço que entrega a margem alvo (%). Como o custo do ML muda por faixa de preço,
 * resolve a conta em cada faixa e fica com o primeiro preço que cai dentro da própria faixa.
 */
export function priceForStudyMargin(p: PricingStudyInput, targetPct: number): number | null {
  if (p.cost === null) return null;
  const denom = 1 - p.feePct / 100 - p.taxPct / 100 - targetPct / 100;
  if (denom <= 0.01) return null;
  const { billedKg } = billedWeight(p);
  for (const band of PRICE_BANDS) {
    const ship = billedKg === null ? 0 : TABLE[weightIndex(billedKg)]![PRICE_BANDS.indexOf(band)]!;
    const price = Math.ceil(((p.cost + p.packaging + ship) / denom) * 100) / 100;
    if (price >= band.min && price < band.max) return price;
    // a conta caiu abaixo da faixa: o piso da faixa já entrega a margem (custo do ML é fixo dentro dela)
    if (price < band.min) return band.min;
  }
  return null;
}

const money = z.number().min(0).max(10_000_000);
const optMoney = money.nullable();
const optCm = z.number().min(0).max(1000).nullable();

export const savePricingStudySchema = z.object({
  title: z.string().trim().min(1, 'Dê um nome ao produto').max(200),
  link: z.string().trim().max(1000).nullable().default(null),
  supplier: z.string().trim().max(200).nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
  feePct: z.number().min(0).max(50),
  taxPct: z.number().min(0).max(50),
  packaging: money,
  cost: optMoney,
  price: optMoney,
  height: optCm,
  width: optCm,
  length: optCm,
  weightKg: z.number().min(0).max(5000).nullable(),
  targetPct: z.number().min(0).max(90).nullable().default(null),
  /** Categoria escolhida na lista do ML (opcional: a comissão também pode ser digitada). */
  categoryId: z.string().regex(/^MLB\d+$/).nullable().default(null),
  categoryName: z.string().trim().max(300).nullable().default(null),
  feeClassic: z.number().min(0).max(50).nullable().default(null),
  feePremium: z.number().min(0).max(50).nullable().default(null),
  /** Tipo cuja tarifa preencheu a comissão; null = digitada à mão. */
  listingType: z.enum(['gold_special', 'gold_pro']).nullable().default(null),
});
export type SavePricingStudyInput = z.infer<typeof savePricingStudySchema>;

export interface PricingStudyDto extends SavePricingStudyInput {
  id: string;
  margin: number | null;
  marginPct: number | null;
  createdAt: string;
  updatedAt: string;
}
