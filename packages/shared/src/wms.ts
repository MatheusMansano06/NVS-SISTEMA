import { z } from 'zod';

/** Supervisão Full (portado do NVS-WMS): lotes do envio Full → listas de separação → bipagem → etiquetas. */
export const WMS_MARKETPLACES = ['ml', 'shopee'] as const;
export type WmsMarketplace = (typeof WMS_MARKETPLACES)[number];
export type WmsListStatus = 'open' | 'in_progress' | 'completed';
export type WmsItemStatus = 'pending' | 'in_progress' | 'complete' | 'partial' | 'out_of_stock';
export type WmsLifecycle = 'pendente' | 'em_andamento' | 'finalizado';
/** Unidades máximas por lista ao dividir o envio. */
export const WMS_LIST_MAX_UNITS = 1000;
/** Lotes ativos ao mesmo tempo; o mais antigo é arquivado ao passar disso. */
export const WMS_MAX_ACTIVE_BATCHES = 10;

export const WMS_ITEM_STATUS_LABELS: Record<WmsItemStatus, string> = {
  pending: 'Pendente',
  in_progress: 'Separando',
  complete: 'Completo',
  partial: 'Parcial',
  out_of_stock: 'Sem estoque',
};

const code = z.string().trim().min(1, 'Bipe ou digite o código').max(200);
const sku = z.string().trim().min(1).max(100);

export const wmsInboundSchema = z.object({
  marketplace: z.enum(WMS_MARKETPLACES).default('ml'),
  fullDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data do envio'),
  /** PDF do envio (base64, até ~10 MB). */
  pdfBase64: z.string().min(100).max(14_000_000),
  /** Arquivar o lote mais antigo quando passar do limite de lotes ativos. */
  archiveOldestId: z.string().uuid().optional(),
});
export const wmsScanSchema = z.object({
  barcode: code,
  focusSku: sku.optional(),
  /** box: uma bipada marca a quantidade informada (ou tudo). */
  mode: z.enum(['unit', 'box']).default('unit'),
  /** No modo caixa: quantas unidades achou (vazio = todas). */
  qty: z.number().int().min(0).max(100_000).optional(),
});
export const wmsSkuSchema = z.object({ sku });
export const wmsShortageSchema = z.object({ sku, qtyFound: z.number().int().min(0), notes: z.string().trim().max(300).optional() });
export const wmsOutOfStockSchema = z.object({ sku, notes: z.string().trim().max(300).optional() });
export const wmsLinkBarcodeSchema = z.object({ barcode: code, sku });

/** Etiquetas em PDF no tamanho da etiqueta, impressas pelo navegador em qualquer impressora (sem agente nem ERP). */
export const WMS_LABEL_FORMATS = ['rolo_1col', 'rolo_2col', 'a4'] as const;
export type WmsLabelFormat = (typeof WMS_LABEL_FORMATS)[number];
/** Formatos de etiqueta no PDF, com a medida padrão de cada um (dá para ajustar). */
export const WMS_LABEL_FORMAT_INFO: Record<WmsLabelFormat, { label: string; text: string; widthMm: number; heightMm: number }> = {
  rolo_1col: { label: 'Rolo de 1 coluna', text: 'Uma etiqueta por vez (ex.: 50 × 25 mm). Impressora térmica de rolo.', widthMm: 50, heightMm: 25 },
  rolo_2col: { label: 'Rolo de 2 colunas', text: 'Duas etiquetas lado a lado (ex.: 40 × 25 mm cada). Impressora térmica de rolo.', widthMm: 40, heightMm: 25 },
  a4: { label: 'Folha A4 de etiquetas', text: 'Folha adesiva em impressora comum (ex.: Pimaco A4356, 63,5 × 25,4 mm, 33 por folha).', widthMm: 63.5, heightMm: 25.4 },
};
export interface WmsSettingsDto {
  labelFormat: WmsLabelFormat;
  /** Medida de UMA etiqueta (no rolo de 2 colunas, de cada coluna). */
  labelWidthMm: number;
  labelHeightMm: number;
}
export const wmsSettingsSchema = z.object({
  labelFormat: z.enum(WMS_LABEL_FORMATS),
  labelWidthMm: z.number().min(20, 'Mínimo 20 mm').max(120, 'Máximo 120 mm'),
  labelHeightMm: z.number().min(15, 'Mínimo 15 mm').max(80, 'Máximo 80 mm'),
});

export const wmsLifecycleSchema = z.object({ lifecycle: z.enum(['em_andamento', 'finalizado']) });
export const wmsNotesSchema = z.object({ notes: z.string().trim().max(300).nullable() });

export interface WmsListSummaryDto {
  id: string;
  code: string;
  batchId: string | null;
  marketplace: WmsMarketplace;
  status: WmsListStatus;
  operatorId: string | null;
  operatorName: string | null;
  itemsTotal: number;
  itemsPicked: number;
  skuCount: number;
  completedAt: string | null;
  createdAt: string;
}

export interface WmsBatchDto {
  id: string;
  name: string;
  marketplace: WmsMarketplace;
  fullDate: string;
  inboundRef: string | null;
  status: 'active' | 'archived';
  lifecycle: WmsLifecycle;
  totalItems: number;
  totalPicked: number;
  pct: number;
  lists: WmsListSummaryDto[];
  createdAt: string;
}

export interface WmsItemDto {
  id: string;
  sku: string;
  mlCode: string | null;
  ean: string | null;
  description: string;
  qtyRequired: number;
  qtyPicked: number;
  shortageQty: number;
  status: WmsItemStatus;
  labelsPrinted: boolean;
  labelsReady: boolean;
  notes: string | null;
  /** Foto do anúncio com esse SKU (do cadastro de anúncios), quando houver. */
  pictureUrl: string | null;
}

export interface WmsListDetailDto {
  list: WmsListSummaryDto;
  items: WmsItemDto[];
  /** Próximo item a separar (o primeiro pendente). */
  current: WmsItemDto | null;
}

/** Uma falta do picking (item da lista que não foi achado inteiro), como no Relatório de Faltas do NVS-WMS. */
export interface WmsShortageDto {
  itemId: string;
  sku: string;
  description: string;
  listId: string;
  listCode: string;
  batchName: string | null;
  marketplace: WmsMarketplace;
  qty: number;
  notes: string | null;
  operatorName: string | null;
  at: string | null;
  status: 'pendente' | 'concluido';
}

export const wmsShortageStatusSchema = z.object({ status: z.enum(['pendente', 'concluido']) });

export interface WmsOverviewDto {
  marketplace: WmsMarketplace;
  lists: { total: number; open: number; inProgress: number; completed: number };
  units: { total: number; picked: number };
  shortage: { units: number; skus: number };
  batches: { id: string; name: string; status: 'active' | 'archived' }[];
}

export interface WmsRankingDto {
  operators: { name: string; total: number }[];
}

/** Resultado de uma bipada (mesma linguagem do NVS-WMS). */
export type WmsScanResultDto =
  | { status: 'ok' | 'complete' | 'excess'; item: WmsItemDto }
  | { status: 'unknown_barcode'; barcode: string; canLink: boolean }
  | { status: 'wrong_sku'; barcode: string; ownerSku: string; ownerDescription: string | null; expectedSku: string }
  | { status: 'ambiguous'; barcode: string; candidates: WmsItemDto[] }
  | { status: 'transfer_available'; barcode: string; itemId: string; sku: string; ownerName: string }
  | { status: 'wrong_list'; barcode: string; sku: string; description: string | null };

/** Busca do operador (EAN, SKU ou título) em todas as listas. */
export interface WmsFindDto {
  action: 'open' | 'transfer_available' | 'already_done' | 'in_progress_other' | 'multiple' | 'not_found' | 'not_in_lists';
  sku: string | null;
  match: WmsFindCandidateDto | null;
  candidates: WmsFindCandidateDto[];
}
export interface WmsFindCandidateDto {
  itemId: string;
  sku: string;
  mlCode: string | null;
  description: string;
  listId: string;
  listCode: string;
  operatorName: string | null;
  qtyPicked: number;
  qtyRequired: number;
  status: WmsItemStatus;
}

export interface WmsInboundResultDto {
  status: 'ok' | 'needs_archive';
  batch?: WmsBatchDto;
  /** Quando há lotes demais ativos: o mais antigo, para confirmar o arquivamento. */
  oldest?: { id: string; name: string; pending: number };
  /** Total lido do PDF × total declarado pelo ML (alerta se não bater). */
  units?: number;
  declaredUnits?: number | null;
}

// ---- Master Data (produtos e códigos de barras do Full)
const productSku = z.string().trim().min(1, 'Informe o SKU').max(100).transform((s) => s.toUpperCase());
const barcode = z.string().trim().min(1, 'Código vazio').max(200);
export const wmsProductCreateSchema = z.object({
  sku: productSku,
  description: z.string().trim().max(300).optional(),
  codes: z.array(barcode).max(20).default([]),
});
export const wmsProductUpdateSchema = z.object({
  description: z.string().trim().max(300).nullable().optional(),
  noPhysicalBarcode: z.boolean().optional(),
});
export const wmsProductCodeSchema = z.object({ barcode });
/** CSV: SKU;Descrição;EAN1;EAN2;… (soma ao cadastro; não apaga nada). */
export const wmsProductImportSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  /** Só SKUs que existem nos anúncios do Mercado Livre da conta (descrição vazia ganha o título do anúncio). */
  onlyListings: z.boolean().default(false),
});
/** Apagar todo o Master Data: exige a senha da conta da empresa. */
export const wmsProductClearSchema = z.object({ password: z.string().min(1, 'Digite a senha da conta').max(128) });

export interface WmsProductDto {
  sku: string;
  description: string | null;
  noPhysicalBarcode: boolean;
  codes: string[];
  /** Foto de um anúncio com esse SKU, quando houver. */
  pictureUrl: string | null;
}
export interface WmsProductPageDto {
  total: number;
  items: WmsProductDto[];
}

/** Impressora na tela do operador: formato da etiqueta + conferência do dia (etiqueta de teste confirmada). */
export interface WmsPrinterStatusDto {
  settings: WmsSettingsDto;
  /** Conferência de hoje (vale para todos do turno). */
  checkedToday: { by: string; at: string; format: string | null } | null;
  /** Há listas abertas ou em andamento (Full em curso): a conferência é exigida. */
  fullRunning: boolean;
}
