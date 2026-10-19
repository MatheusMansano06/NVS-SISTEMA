import { z } from 'zod';

/**
 * Gerador de EAN interno (Cadastro de SKUs › Códigos EAN).
 * Regra GS1: códigos começados em "2" são de CIRCULAÇÃO RESTRITA — a GS1 não os atribui a nenhuma empresa, então
 * nunca colidem com um GTIN oficial. Usamos o "20" (uso interno da empresa; 21–29 costumam ser de peso/preço
 * variável no varejo) + 10 dígitos sequenciais por empresa + dígito verificador = EAN-13 válido.
 * Servem para estoque, bipagem e etiquetas internas; NÃO valem como GTIN em marketplace. Quando a empresa licenciar
 * um prefixo na GS1 Brasil (789/790), cada código interno recebe o GTIN oficial e continua valendo como apelido.
 */
export const INTERNAL_EAN_PREFIX = '20';
const SEQ_DIGITS = 13 - 1 - INTERNAL_EAN_PREFIX.length; // 10
export const INTERNAL_EAN_MAX_SEQ = 10 ** SEQ_DIGITS - 1;

/** Dígito verificador GS1 (módulo 10, pesos 3/1 da direita para a esquerda) para 7, 11, 12 ou 13 dígitos de base. */
export function gs1CheckDigit(base: string): number {
  if (!/^\d+$/.test(base)) throw new Error('Base do código deve ter só dígitos');
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const d = Number(base[base.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** EAN-13 (ou GTIN-8/12/14) com o dígito verificador correto. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Prefixo 2xx (EAN-13) = circulação restrita, uso interno. */
export const isRestrictedCirculation = (code: string) => code.length === 13 && code.startsWith('2');

/** Código interno nº `seq` da empresa: 20 + seq com 10 dígitos + verificador. */
export function internalEan(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > INTERNAL_EAN_MAX_SEQ) throw new Error('Sequência fora da faixa');
  const base = INTERNAL_EAN_PREFIX + String(seq).padStart(SEQ_DIGITS, '0');
  return base + gs1CheckDigit(base);
}

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = L.map((p) => [...p].reverse().map((b) => (b === '1' ? '0' : '1')).join(''));
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Os 95 módulos do EAN-13 ("1" = barra), com as guardas — para desenhar o código no navegador. */
export function ean13Modules(code: string): string {
  if (!/^\d{13}$/.test(code) || !isValidGtin(code)) throw new Error('EAN-13 inválido');
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  const left = d.slice(1, 7).map((n, i) => (parity[i] === 'L' ? L[n] : G[n])).join('');
  const right = d.slice(7).map((n) => R[n]).join('');
  return `101${left}01010${right}101`;
}

/** Problema do GTIN oficial informado (null = ok). Prefixo 789/790 = GS1 Brasil (outros países são aceitos). */
export function officialGtinProblem(code: string): string | null {
  if (!/^\d+$/.test(code)) return 'O GTIN tem só números.';
  if (![8, 12, 13, 14].includes(code.length)) return 'O GTIN tem 8, 12, 13 ou 14 dígitos.';
  if (!isValidGtin(code)) return 'Dígito verificador não confere: confira o número.';
  if (code.length === 13 && code.startsWith('2')) return 'Códigos começados em 2 são internos, não oficiais.';
  return null;
}

const sku = z.string().trim().max(100).transform((s) => s.toUpperCase() || null);
const description = z.string().trim().max(200).transform((s) => s || null);

/** Cada item vira um código; sem SKU = código "livre", para associar depois. */
export const generateEansSchema = z.object({
  items: z.array(z.object({ sku: sku.nullable().default(null), description: description.nullable().default(null) })).min(1).max(200),
});
export type GenerateEansInput = z.infer<typeof generateEansSchema>;

/** Edição de um código: associar/trocar/liberar o SKU, descrição da etiqueta e GTIN oficial. Campos ausentes ficam como estão. */
export const updateEanSchema = z.object({
  sku: sku.nullable().optional(),
  description: description.nullable().optional(),
  gtin: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((g) => g == null || g === '' || officialGtinProblem(g) === null, { message: 'GTIN oficial inválido' }),
});
export type UpdateEanInput = z.infer<typeof updateEanSchema>;

export const listEansSchema = z.object({
  q: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

export interface InternalEanDto {
  code: string;
  /** null = código livre (ainda sem SKU). */
  sku: string | null;
  description: string | null;
  /** GTIN oficial (GS1) quando a empresa registrar o produto. */
  gtin: string | null;
  /** true = também está no Master Data do Full (vale na bipagem). */
  inMasterData: boolean;
  createdAt: string;
}

export interface InternalEanListDto {
  items: InternalEanDto[];
  total: number;
  free: number;
}

export interface GenerateEansResult {
  created: InternalEanDto[];
  /** SKUs que já tinham código (devolvidos sem gerar outro). */
  existing: InternalEanDto[];
}
