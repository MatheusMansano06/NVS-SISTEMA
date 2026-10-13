import type { InboundDoc, InboundItem, PdfText } from './ml-inbound-pdf.js';

/**
 * Leitura do "Shopee Picking List - Shopee Fulfillment" (envio Full da Shopee), portado do NVS-WMS
 * (parsers/shopee), mas por posição na folha em vez de texto corrido.
 *
 * Colunas: SKU do vendedor | Shopee SKU ID (2 linhas) | Nome do Produto | Variação | SKU do Armazém | Qnt. Aprovada.
 * Cada linha da tabela começa no Shopee SKU ID ("26141745660_2"); a quantidade é o número mais à direita
 * da linha. Duas armadilhas conhecidas dos PDFs da Shopee:
 *  - bug Skia (camada dupla): a página vem com duas camadas sobrepostas, cada uma com o próprio cabeçalho
 *    e colunas deslocadas, e a quantidade quebrada dígito a dígito na vertical ("1","0","0" = 100).
 *    Separar a página em camadas pelo cabeçalho ("No.") resolve.
 *  - EAN-13 do armazém quebrado em duas linhas ("78978464" + "16859"): fica na coluna do armazém, à
 *    esquerda da quantidade, então nunca é lido como quantidade.
 */
const ID_RE = /\d{8,}_\d+/;
const ID2_RE = /^\d{8,}$/;
const DIGITS = /^\d+$/;
const ROW_TOL = 1.5;
/** Altura máxima de uma linha da tabela (até 5 linhas de texto de ~26 pt). */
const MAX_ROW_HEIGHT = 135;

export function parseShopeeInboundText(texts: PdfText[]): InboundDoc {
  const all = texts.filter((t) => t.str.trim());
  const joined = all.map((t) => t.str).join(' ');
  const ref = /INBRFSP\d+/.exec(joined)?.[0] ?? null;

  // total declarado: número à direita de "Total" na mesma altura (repete em toda página)
  let declared: number | null = null;
  for (const t of all.filter((x) => x.str.trim() === 'Total')) {
    const n = all.find((x) => x.page === t.page && x.x > t.x && Math.abs(x.y - t.y) < 2 && DIGITS.test(x.str.trim()));
    if (n) {
      declared = Number(n.str.trim());
      break;
    }
  }

  const items: InboundItem[] = [];
  for (const layer of layers(all)) items.push(...parseLayer(layer));
  return { ref, declaredUnits: declared, items: dedupe(items) };
}

/** Cada página dividida em camadas: uma por cabeçalho da tabela (a ordem do texto no PDF é preservada). */
function layers(all: PdfText[]): PdfText[][] {
  const out: PdfText[][] = [];
  let current: PdfText[] = [];
  let page = -1;
  for (const t of all) {
    if (t.page !== page || t.str.trim() === 'No.') {
      if (current.length) out.push(current);
      current = [];
      page = t.page;
    }
    current.push(t);
  }
  if (current.length) out.push(current);
  return out;
}

function parseLayer(layer: PdfText[]): InboundItem[] {
  const header = (re: RegExp) => layer.find((t) => re.test(t.str.trim()))?.x ?? null;
  const idX = header(/^Shopee SKU ID/);
  if (idX === null) return [];
  const varX = header(/^Varia/) ?? idX + 280;
  const armX = header(/^Amarz|^Armaz/) ?? varX + 68;
  // rodapé ("Notas", "Total 11820") e instruções ficam fora; não servem de limite: na camada com bug Skia
  // a última linha da tabela continua por baixo do rodapé
  const footerYs = layer.filter((t) => /^(Notas|Total)$/.test(t.str.trim())).map((t) => t.y);
  const cells = layer.filter((t) => t.x >= 30 && !footerYs.some((y) => Math.abs(t.y - y) < 1));

  const anchors = cells.filter((t) => ID_RE.test(t.str)).sort((a, b) => b.y - a.y);
  const out: InboundItem[] = [];
  anchors.forEach((anchor, i) => {
    const bottom = i + 1 < anchors.length ? anchors[i + 1]!.y + ROW_TOL : anchor.y - MAX_ROW_HEIGHT;
    const row = cells.filter((t) => t !== anchor && t.y <= anchor.y + ROW_TOL && t.y > bottom);
    const m = ID_RE.exec(anchor.str)!;
    const prefix = anchor.str.slice(0, m.index).trim(); // "VISCAMVISION 26141745660_2" (vendedor colado no ID)
    const idCol = prefix ? idX : anchor.x;

    const id2 = row.filter((t) => ID2_RE.test(t.str.trim()) && Math.abs(t.x - idCol) < 6).sort((a, b) => b.y - a.y)[0];
    const rest = row.filter((t) => t !== id2);
    const top = (xs: PdfText[]) => xs.sort((a, b) => b.y - a.y || a.x - b.x);

    const vendor = [prefix, ...top(rest.filter((t) => t.x < idX - 5)).map((t) => t.str.trim())].join('');
    // quantidade: coluna mais à direita da linha. No bug Skia ela vem em dígitos empilhados (1 por linha de
    // texto) e o último pode cair na faixa da linha seguinte: segue a pilha a partir da altura do ID,
    // descendo de linha em linha, até começar outra linha da tabela.
    const numbers = rest.filter((t) => t.x > varX && DIGITS.test(t.str.trim()));
    const qx = Math.max(...numbers.map((t) => t.x));
    const column = cells
      .filter((t) => Math.abs(t.x - qx) < 3 && DIGITS.test(t.str.trim()) && t.y <= anchor.y + ROW_TOL)
      .sort((a, b) => b.y - a.y);
    const stack: PdfText[] = [];
    for (const t of column) {
      if (!stack.length) {
        if (Math.abs(t.y - anchor.y) > ROW_TOL) break; // a quantidade começa na mesma altura do ID
        stack.push(t);
        if (t.str.trim().length > 1) break; // número inteiro numa linha só (página normal)
        continue;
      }
      const gap = stack[stack.length - 1]!.y - t.y;
      const nextRow = anchors.some((o) => o !== anchor && Math.abs(o.y - t.y) <= ROW_TOL);
      if (t.str.trim().length !== 1 || gap < 15 || gap > 35 || nextRow) break;
      stack.push(t);
    }
    const qty = stack.length ? Number(stack.map((t) => t.str.trim()).join('')) : 0;
    const qtySet = new Set(stack);
    const name = top(rest.filter((t) => t.x >= idX - 5 && t.x < varX - 5 && !ID2_RE.test(t.str.trim()))).map((t) => t.str.trim());
    const variation = top(rest.filter((t) => t.x >= varX - 5 && t.x < armX - 5)).map((t) => t.str.trim());
    const warehouse = top(rest.filter((t) => t.x >= armX - 5 && !qtySet.has(t))).map((t) => t.str.trim()).join('');
    // coluna do armazém com código real (EAN, às vezes quebrado em 2 linhas) em vez de "Item without GTIN"
    const ean = /^\d{8,14}$/.test(warehouse) ? warehouse : null;

    if (!vendor || qty <= 0) return;
    out.push({
      sku: vendor.toUpperCase(),
      mlCode: m[0] + (id2?.str.trim() ?? ''),
      ean,
      description: [name.join(' '), variation.join(' ')].filter(Boolean).join(' · ').slice(0, 200),
      qty,
    });
  });
  return out;
}

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

/** Dígito verificador do EAN-13 (usado nos testes de regressão do código do armazém). */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}
