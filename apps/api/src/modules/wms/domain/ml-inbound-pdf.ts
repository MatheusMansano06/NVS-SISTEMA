/**
 * Leitura do PDF de envio Full do Mercado Livre ("Lista de produtos e instruções de preparação").
 * Portado do NVS-WMS (parsers/ml_pdf_parser.py), mas por posição do texto: cada produto começa na
 * linha "Código ML: X Código universal: Y SKU:" (coluna PRODUTO) e a quantidade fica na coluna UNIDADES.
 */
export interface PdfText {
  page: number;
  x: number;
  y: number;
  str: string;
}

export interface InboundItem {
  sku: string;
  /** Código ML (inventory_id): é o código de barras da etiqueta do Full. */
  mlCode: string | null;
  /** Código universal (EAN), quando o anúncio tem. */
  ean: string | null;
  description: string;
  qty: number;
}

export interface InboundDoc {
  /** "Frete #68874755" → 68874755. */
  ref: string | null;
  /** Total declarado no cabeçalho (confere com a soma lida). */
  declaredUnits: number | null;
  items: InboundItem[];
}

const ROW_TOLERANCE = 3;

export function parseInboundText(texts: PdfText[]): InboundDoc {
  const all = texts.filter((t) => t.str.trim());
  const joined = all.map((t) => t.str).join(' ');
  const ref = /Frete\s*#\s*(\d+)/i.exec(joined)?.[1] ?? null;
  const declared = /Total de unidades:\s*([\d.]+)/i.exec(joined)?.[1];

  // colunas pelo cabeçalho da tabela (pode faltar em páginas seguintes: usa o da 1ª)
  const unitsX = all.find((t) => /^UNIDADES$/i.test(t.str.trim()))?.x ?? null;
  const identX = all.find((t) => /^IDENTIFI/i.test(t.str.trim()))?.x ?? null;
  const productLimit = unitsX !== null ? unitsX - 5 : 200;

  const items: InboundItem[] = [];
  const pages = [...new Set(all.map((t) => t.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const onPage = all.filter((t) => t.page === page);
    const product = onPage.filter((t) => t.x < productLimit).sort((a, b) => b.y - a.y || a.x - b.x);
    const numbers = onPage.filter(
      (t) => unitsX !== null && t.x >= unitsX - 20 && (identX === null || t.x < identX - 5) && /^\d[\d.,]*$/.test(t.str.trim()),
    );
    let block: { start: PdfText; lines: string[] } | null = null;
    const flush = () => {
      if (!block) return;
      const item = toItem(block.lines, numbers, block.start);
      if (item) items.push(item);
      block = null;
    };
    for (const t of product) {
      if (/digo ML:/i.test(t.str)) {
        flush();
        block = { start: t, lines: [t.str] };
      } else if (block) {
        // texto do rodapé/próximo cabeçalho não entra (linhas em maiúsculas de seção)
        if (/^(PRODUTO|Lista de produtos)/i.test(t.str.trim())) continue;
        block.lines.push(t.str);
      }
    }
    flush();
  }
  return { ref, declaredUnits: declared ? Number(declared.replace(/\./g, '')) : null, items: dedupe(items) };
}

function toItem(lines: string[], numbers: PdfText[], start: PdfText): InboundItem | null {
  const text = lines.join('\n');
  const mlCode = /digo\s+ML:\s*([A-Z0-9]+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
  const ean = /universal:\s*\n?\s*(\d{8,14})/i.exec(text)?.[1] ?? null;
  const skuMatch = /SKU:\s*\n?\s*(\S+)/i.exec(text);
  const sku = skuMatch?.[1]?.trim().toUpperCase();
  if (!sku) return null;
  // descrição: o que vem depois da linha do SKU
  const after = text.slice((skuMatch!.index ?? 0) + skuMatch![0].length).split('\n').map((l) => l.trim()).filter(Boolean);
  const description = after.join(' ').slice(0, 200);
  const qtyText = numbers
    .filter((n) => Math.abs(n.y - start.y) <= ROW_TOLERANCE)
    .sort((a, b) => a.x - b.x)[0]?.str;
  const qty = qtyText ? Number(qtyText.replace(/[^\d]/g, '')) : NaN;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return { sku, mlCode, ean, description, qty };
}

/** Mesmo (SKU, Código ML) em páginas diferentes soma; Códigos ML diferentes são anúncios distintos. */
function dedupe(items: InboundItem[]): InboundItem[] {
  const map = new Map<string, InboundItem>();
  for (const i of items) {
    const key = `${i.sku}|${i.mlCode ?? ''}`;
    const prev = map.get(key);
    if (prev) prev.qty += i.qty;
    else map.set(key, { ...i });
  }
  return [...map.values()];
}

/**
 * Divide em listas de até `maxUnits` unidades (maior quantidade primeiro, preenchimento guloso).
 * Item que sozinho passa do limite vira uma lista própria.
 */
export function splitIntoLists<T extends { qty: number }>(items: T[], maxUnits = 1000): T[][] {
  const sorted = [...items].sort((a, b) => b.qty - a.qty);
  const lists: T[][] = [];
  let current: T[] = [];
  let total = 0;
  for (const it of sorted) {
    if (!current.length || total + it.qty <= maxUnits) {
      current.push(it);
      total += it.qty;
    } else {
      lists.push(current);
      current = [it];
      total = it.qty;
    }
  }
  if (current.length) lists.push(current);
  return lists;
}
