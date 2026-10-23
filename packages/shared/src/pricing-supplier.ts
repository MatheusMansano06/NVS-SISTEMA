import { z } from 'zod';

/**
 * Precificador › Viabilidade: fornecedores como pastas e importação da cotação (planilha ou PDF) em fichas.
 * O custo da ficha = preço da cotação × (1 + % do fornecedor) — o % cobre IPI/ST/frete de compra que a cotação não traz.
 */

export const savePricingSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao fornecedor').max(200),
  costMarkupPct: z.number().min(0).max(100),
});
export type SavePricingSupplierInput = z.infer<typeof savePricingSupplierSchema>;

export interface PricingSupplierDto extends SavePricingSupplierInput {
  id: string;
}

export const importQuoteSchema = z.object({
  supplierId: z.string().uuid(),
  /** Nome da cotação (ex.: "Orçamento Wester 10/2026"), gravado em cada ficha. */
  quoteRef: z.string().trim().max(200).nullable().default(null),
  taxPct: z.number().min(0).max(50),
  packaging: z.number().min(0).max(10_000_000),
  items: z
    .array(z.object({ title: z.string().trim().min(1).max(200), supplierCost: z.number().min(0).max(10_000_000) }))
    .min(1, 'Nenhum item para importar')
    .max(500),
});
export type ImportQuoteInput = z.infer<typeof importQuoteSchema>;

export const quotePdfSchema = z.object({ pdfBase64: z.string().min(100).max(14_000_000) });

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Custo da ficha a partir do preço da cotação e do % do fornecedor. */
export const costWithMarkup = (supplierCost: number, markupPct: number) => round2(supplierCost * (1 + markupPct / 100));

const MONEY = /^(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))$|^(?:R\$\s*)?(\d+)\.(\d{2})$/;

/** "1.234,56", "R$ 79,90" ou "79.90" → número; qualquer outra coisa (código, quantidade, texto) → null. */
export function parseQuoteMoney(cell: string): number | null {
  const m = MONEY.exec(cell.trim());
  if (!m) return null;
  return m[1] !== undefined ? Number(`${m[1].replace(/\./g, '')}.${m[2]}`) : Number(`${m[3]}.${m[4]}`);
}

export interface QuoteRow {
  title: string;
  supplierCost: number;
}

const HEAD_TITLE = /produto|descri|^item$|^nome/i;
const HEAD_PRICE = /pre[cç]o|valor|custo|unit/i;
const HEAD_TOTAL = /total/i;
const SKIP = /^(sub\s*-?\s*total|total|frete|desconto|impostos?|ipi|icms|st|valor total)\b/i;
/** Unidade ou "R$" no fim do nome (antes do preço). */
const UNIT = /^(un|und|unid|pc|p[cç]s|cx|kg|r\$)$/i;
/** Código do item no começo da linha (001, W-12, AB123). */
const CODE = /^(?=[^\s]*\d)[a-z0-9][a-z0-9.\-/]{0,14}$/i;

/**
 * Linhas da cotação (células de planilha ou textos de uma linha do PDF) → itens com nome e preço.
 * Com cabeçalho reconhecido usa as colunas dele (preço unitário antes do total); sem cabeçalho,
 * o nome é o texto da linha e o preço é o primeiro valor em dinheiro.
 */
export function parseQuoteRows(rows: string[][]): QuoteRow[] {
  const cells = rows.map((r) => r.map((c) => c.trim()));
  const headAt = cells.findIndex((r) => r.some((c) => HEAD_TITLE.test(c)) && r.some((c) => HEAD_PRICE.test(c)));
  const out: QuoteRow[] = [];

  if (headAt >= 0) {
    const head = cells[headAt]!;
    const titleCol = head.findIndex((c) => HEAD_TITLE.test(c));
    const priceCols = head.map((c, i) => (HEAD_PRICE.test(c) ? i : -1)).filter((i) => i >= 0);
    const priceCol = priceCols.find((i) => !HEAD_TOTAL.test(head[i]!)) ?? priceCols[0]!;
    for (const r of cells.slice(headAt + 1).filter((r) => r.length === head.length)) {
      const title = r[titleCol] ?? '';
      const raw = r[priceCol] ?? '';
      const cost = parseQuoteMoney(raw) ?? (/^\d+([.,]\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : null);
      if (title && cost !== null && !SKIP.test(title)) out.push({ title, supplierCost: cost });
    }
    if (out.length) return out;
  }

  for (const r of cells) {
    const at = r.findIndex((c) => parseQuoteMoney(c) !== null);
    if (at < 0) continue;
    // nome = o que vem antes do preço, sem o código do começo e sem quantidade/unidade do fim
    const words = r.slice(0, at).filter(Boolean);
    while (words.length && UNIT.test(words.at(-1)!)) words.pop();
    if (words.length > 1 && /^\d+$/.test(words.at(-1)!)) words.pop();
    while (words.length && UNIT.test(words.at(-1)!)) words.pop();
    if (words.length > 1 && CODE.test(words[0]!)) words.shift();
    const title = words.join(' ').replace(/\s+/g, ' ').trim();
    if (!title || SKIP.test(title) || title.length < 3) continue;
    out.push({ title: title.slice(0, 200), supplierCost: parseQuoteMoney(r[at]!)! });
  }
  return out;
}

/** CSV com ";" ou "," (detecta pelo cabeçalho), aspas duplas respeitadas. */
export function csvRows(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c.trim()));
}
