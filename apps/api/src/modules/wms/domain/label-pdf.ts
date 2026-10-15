import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';

/**
 * Etiquetas do Full em PDF (impressão pelo navegador, em qualquer impressora): o mesmo conteúdo do ZPL (zpl.ts),
 * desenhado em vetor no tamanho real. ML: Code128 do Código ML + código legível + descrição + SKU. Shopee: QR.
 * Formatos: rolo de 1 coluna (uma etiqueta por página), rolo de 2 colunas (duas por página, lado a lado) e
 * folha A4 de etiquetas adesivas (grade centralizada).
 */
export type LabelFormat = 'rolo_1col' | 'rolo_2col' | 'a4';

export interface LabelLayout {
  format: LabelFormat;
  /** Largura de UMA etiqueta (no rolo de 2 colunas, de cada coluna). */
  widthMm: number;
  heightMm: number;
}

export interface LabelSpec {
  marketplace: 'ml' | 'shopee';
  code: string;
  description: string;
  sku: string;
  qty: number;
}

const PT = 72 / 25.4; // pontos por mm
const A4 = { w: 210, h: 297 };
const A4_MARGIN = { x: 5, y: 5 }; // área mínima livre na borda da folha

/** Posições (em mm, canto superior esquerdo) de cada etiqueta, página a página. */
export function labelSlots(layout: LabelLayout, count: number): { pageW: number; pageH: number; pages: { x: number; y: number }[][] } {
  const { widthMm: w, heightMm: h } = layout;
  const pages: { x: number; y: number }[][] = [];
  if (layout.format === 'rolo_1col') {
    for (let i = 0; i < count; i++) pages.push([{ x: 0, y: 0 }]);
    return { pageW: w, pageH: h, pages };
  }
  if (layout.format === 'rolo_2col') {
    for (let i = 0; i < count; i += 2) pages.push(i + 1 < count ? [{ x: 0, y: 0 }, { x: w, y: 0 }] : [{ x: 0, y: 0 }]);
    return { pageW: 2 * w, pageH: h, pages };
  }
  const cols = Math.max(1, Math.floor((A4.w - 2 * A4_MARGIN.x) / w));
  const rows = Math.max(1, Math.floor((A4.h - 2 * A4_MARGIN.y) / h));
  const left = (A4.w - cols * w) / 2;
  const top = (A4.h - rows * h) / 2;
  for (let i = 0; i < count; i++) {
    const n = i % (cols * rows);
    if (n === 0) pages.push([]);
    pages[pages.length - 1]!.push({ x: left + (n % cols) * w, y: top + Math.floor(n / cols) * h });
  }
  return { pageW: A4.w, pageH: A4.h, pages };
}

/** PDF com as etiquetas de todos os itens, na ordem (cada item repetido `qty` vezes). */
export function buildLabelsPdf(items: LabelSpec[], layout: LabelLayout): Promise<Buffer> {
  const labels = items.flatMap((it) => Array.from({ length: Math.max(0, it.qty) }, () => it));
  const { pageW, pageH, pages } = labelSlots(layout, labels.length);
  const doc = new PDFDocument({ size: [pageW * PT, pageH * PT], margin: 0, autoFirstPage: false, info: { Title: 'Etiquetas Full', Producer: 'NVS', Creator: 'NVS' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  let n = 0;
  for (const slots of pages) {
    doc.addPage({ size: [pageW * PT, pageH * PT], margin: 0 });
    for (const s of slots) {
      const it = labels[n++]!;
      const box = { x: s.x, y: s.y, w: layout.widthMm, h: layout.heightMm };
      if (it.marketplace === 'shopee') drawShopee(doc, box, it);
      else drawMl(doc, box, it);
    }
  }
  // sem etiqueta nenhuma: uma página em branco (PDF válido)
  if (!pages.length) doc.addPage({ size: [pageW * PT, pageH * PT], margin: 0 });
  doc.end();
  return done;
}

type Box = { x: number; y: number; w: number; h: number };
type Doc = InstanceType<typeof PDFDocument>;
const clean = (s: string, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function drawMl(doc: Doc, b: Box, it: LabelSpec) {
  const code = clean(it.code, 60);
  const pad = Math.min(1.5, b.w * 0.04);
  const scale = Math.min(b.h / 25, b.w / 40, 1.6); // tipografia proporcional ao tamanho da etiqueta
  // código de barras: módulo de até 0,33 mm, com zona de silêncio de ~2,5 mm (encolhe se não couber)
  const sbs = (bwipjs.raw({ bcid: 'code128', text: code })[0] as { sbs: number[] }).sbs;
  const modules = sbs.reduce((s, v) => s + v, 0);
  let quiet = 2.5;
  let mod = Math.min(0.33, (b.w - 2 * quiet) / modules);
  if (mod < 0.19) {
    quiet = 1;
    mod = (b.w - 2 * quiet) / modules;
  }
  const barH = b.h * 0.3;
  const barW = mod * modules;
  let x = b.x + (b.w - barW) / 2;
  const y = b.y + pad;
  sbs.forEach((width, i) => {
    if (i % 2 === 0) doc.rect(x * PT, y * PT, width * mod * PT, barH * PT);
    x += width * mod;
  });
  doc.fill('#000');
  let ty = y + barH + 0.6;
  const codeSize = 8 * scale;
  doc.font('Helvetica-Bold').fontSize(codeSize);
  const shown = fit(doc, code, b.w * PT);
  doc.text(shown, (b.x + (b.w - doc.widthOfString(shown) / PT) / 2) * PT, ty * PT, { lineBreak: false });
  ty += (codeSize / PT) * 1.15;
  const textSize = 6.4 * scale;
  const lineH = (textSize / PT) * 1.15;
  const skuY = b.y + b.h - pad - lineH;
  doc.font('Helvetica').fontSize(textSize).text(clean(it.description, 120), (b.x + pad) * PT, ty * PT, {
    width: (b.w - 2 * pad) * PT,
    height: Math.max(lineH, Math.min(2.4 * lineH, skuY - ty)) * PT,
    ellipsis: true,
    lineGap: 0,
  });
  doc.font('Helvetica-Bold').fontSize(textSize);
  doc.text(fit(doc, `SKU: ${clean(it.sku, 60)}`, (b.w - 2 * pad) * PT), (b.x + pad) * PT, skuY * PT, { lineBreak: false });
}

function drawShopee(doc: Doc, b: Box, it: LabelSpec) {
  const code = clean(it.code, 60);
  const pad = Math.min(1.5, b.w * 0.04);
  const scale = Math.min(b.h / 25, b.w / 40, 1.6);
  const q = bwipjs.raw({ bcid: 'qrcode', text: code })[0]! as { pixs: number[]; pixx: number; pixy: number };
  const size = Math.min(b.h - 2 * pad, b.w * 0.38);
  const cell = size / q.pixx;
  const qy = b.y + (b.h - size) / 2;
  for (let r = 0; r < q.pixy; r++) {
    for (let c = 0; c < q.pixx; c++) if (q.pixs[r * q.pixx + c]) doc.rect((b.x + pad + c * cell) * PT, (qy + r * cell) * PT, cell * PT + 0.05, cell * PT + 0.05);
  }
  doc.fill('#000');
  const tx = b.x + 2 * pad + size;
  const tw = b.w - (tx - b.x) - pad;
  const textSize = 6 * scale;
  const lineH = (textSize / PT) * 1.15;
  doc.font('Helvetica-Bold').fontSize(textSize).text(clean(it.description, 120), tx * PT, (b.y + pad) * PT, { width: tw * PT, height: 3.4 * lineH * PT, ellipsis: true, lineGap: 0 });
  doc.font('Helvetica').fontSize(textSize);
  const lines = [`seller sku: ${clean(it.sku, 60)}`, `barcode: ${code}`];
  lines.forEach((l, i) => doc.text(fit(doc, l, tw * PT), tx * PT, (b.y + b.h - pad - (lines.length - i) * lineH) * PT, { lineBreak: false }));
}

/** Corta o texto (com "…") para caber numa linha da largura dada, na fonte atual. */
function fit(doc: Doc, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t}…`;
}
