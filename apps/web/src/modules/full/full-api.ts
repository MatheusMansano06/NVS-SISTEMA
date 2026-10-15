import type {
  WmsPrinterStatusDto,
  WmsBatchDto,
  WmsFindCandidateDto,
  WmsFindDto,
  WmsInboundResultDto,
  WmsItemDto,
  WmsListDetailDto,
  WmsListSummaryDto,
  WmsMarketplace,
  WmsOverviewDto,
  WmsProductDto,
  WmsProductPageDto,
  WmsRankingDto,
  WmsScanResultDto,
  WmsSettingsDto,
  WmsShortageDto,
} from '@nvs/shared';
import { http } from '../../shared/http';

const enc = encodeURIComponent;

/** Marketplace em uso na Supervisão Full (Mercado Livre ou Shopee), lembrado por navegador. */
let current: WmsMarketplace = (() => {
  try {
    return localStorage.getItem('nvs:full:mp') === 'shopee' ? 'shopee' : 'ml';
  } catch {
    return 'ml';
  }
})();
export const getFullMarketplace = () => current;
export function setFullMarketplace(m: WmsMarketplace) {
  current = m;
  try {
    localStorage.setItem('nvs:full:mp', m);
  } catch {
    /* sem storage */
  }
}
const q = () => `marketplace=${current}`;

export const fullApi = {
  overview: () => http<WmsOverviewDto>(`/api/v1/wms/overview?${q()}`),
  ranking: (batchId?: string) => http<WmsRankingDto>(`/api/v1/wms/ranking?${q()}${batchId ? `&batchId=${batchId}` : ''}`),
  batches: () => http<{ batches: WmsBatchDto[]; loose: WmsListSummaryDto[] }>(`/api/v1/wms/batches?${q()}`),
  batch: (id: string) => http<WmsBatchDto>(`/api/v1/wms/batches/${id}`),
  lifecycle: (id: string, lifecycle: 'em_andamento' | 'finalizado') => http<void>(`/api/v1/wms/batches/${id}/lifecycle`, { method: 'PATCH', body: { lifecycle } }),
  archive: (id: string, archived: boolean) => http<void>(`/api/v1/wms/batches/${id}/archive`, { body: { archived } }),
  deleteBatch: (id: string) => http<void>(`/api/v1/wms/batches/${id}`, { method: 'DELETE' }),
  lists: () => http<WmsListSummaryDto[]>(`/api/v1/wms/lists?${q()}`),
  list: (id: string) => http<WmsListDetailDto>(`/api/v1/wms/lists/${id}`),
  claim: (id: string) => http<void>(`/api/v1/wms/lists/${id}/claim`, { body: {} }),
  release: (id: string) => http<void>(`/api/v1/wms/lists/${id}/release`, { body: {} }),
  deleteList: (id: string) => http<void>(`/api/v1/wms/lists/${id}`, { method: 'DELETE' }),
  shortages: () => http<WmsShortageDto[]>('/api/v1/wms/shortages'),
  shortageStatus: (itemId: string, status: 'pendente' | 'concluido') => http<void>(`/api/v1/wms/shortages/${itemId}/status`, { method: 'PATCH', body: { status } }),
  removeShortage: (itemId: string) => http<void>(`/api/v1/wms/shortages/${itemId}`, { method: 'DELETE' }),
  removeAllShortages: () => http<{ removed: number }>('/api/v1/wms/shortages', { method: 'DELETE' }),
  scan: (id: string, b: { barcode: string; focusSku?: string; mode?: 'unit' | 'box'; qty?: number }) =>
    http<WmsScanResultDto>(`/api/v1/wms/lists/${id}/scan`, { body: b }),
  undo: (id: string, sku: string) => http<WmsItemDto>(`/api/v1/wms/lists/${id}/undo`, { body: { sku } }),
  shortage: (id: string, sku: string, qtyFound: number, notes?: string) =>
    http<WmsScanResultDto>(`/api/v1/wms/lists/${id}/shortage`, { body: { sku, qtyFound, notes } }),
  outOfStock: (id: string, sku: string, notes?: string) => http<WmsScanResultDto>(`/api/v1/wms/lists/${id}/out-of-stock`, { body: { sku, notes } }),
  resetItem: (id: string, sku: string) => http<WmsItemDto>(`/api/v1/wms/lists/${id}/reset-item`, { body: { sku } }),
  manualPick: (id: string, sku: string, mode: 'unit' | 'box') => http<WmsScanResultDto>(`/api/v1/wms/lists/${id}/manual-pick`, { body: { sku, mode } }),
  transfer: (itemId: string) => http<{ listId: string; code: string }>(`/api/v1/wms/items/${itemId}/transfer`, { body: {} }),
  notes: (itemId: string, notes: string | null) => http<void>(`/api/v1/wms/items/${itemId}/notes`, { method: 'PATCH', body: { notes } }),
  linkBarcode: (barcode: string, sku: string) => http<void>('/api/v1/wms/barcodes', { body: { barcode, sku } }),
  find: (term: string) => http<WmsFindDto>(`/api/v1/wms/find?${q()}&q=${enc(term)}`),
  pending: () => http<WmsFindCandidateDto[]>(`/api/v1/wms/pending?${q()}`),
  // etiquetas em PDF no formato da empresa (impressas pelo navegador)
  labelsPdfUrl: (id: string, sku?: string, qty?: number) =>
    `/api/v1/wms/lists/${id}/labels.pdf${sku ? `?sku=${enc(sku)}${qty ? `&qty=${qty}` : ''}` : ''}`,
  markPrinted: (id: string, sku: string) => http<void>(`/api/v1/wms/lists/${id}/printed`, { body: { sku } }),
  testPdfUrl: () => '/api/v1/wms/printer/test.pdf',
  settings: () => http<WmsSettingsDto>('/api/v1/wms/settings'),
  saveSettings: (b: WmsSettingsDto) => http<WmsSettingsDto>('/api/v1/wms/settings', { method: 'PUT', body: b }),
  printer: () => http<WmsPrinterStatusDto>('/api/v1/wms/printer'),
  printerConfirm: () => http<void>('/api/v1/wms/printer/confirm', { body: {} }),
  inbound: (b: { fullDate: string; pdfBase64: string; archiveOldestId?: string }) =>
    http<WmsInboundResultDto>('/api/v1/wms/inbound', { body: { marketplace: current, ...b } }),
  // Master Data
  products: (q: string, page: number) => http<WmsProductPageDto>(`/api/v1/wms/products?q=${enc(q)}&page=${page}`),
  createProduct: (b: { sku: string; description?: string; codes: string[] }) => http<WmsProductDto>('/api/v1/wms/products', { body: b }),
  updateProduct: (sku: string, b: { description?: string | null; noPhysicalBarcode?: boolean }) =>
    http<WmsProductDto>(`/api/v1/wms/products/${enc(sku)}`, { method: 'PATCH', body: b }),
  deleteProduct: (sku: string) => http<void>(`/api/v1/wms/products/${enc(sku)}`, { method: 'DELETE' }),
  addCode: (sku: string, barcode: string) => http<{ product: WmsProductDto; alsoOn: string[] }>(`/api/v1/wms/products/${enc(sku)}/codes`, { body: { barcode } }),
  removeCode: (sku: string, barcode: string) => http<WmsProductDto>(`/api/v1/wms/products/${enc(sku)}/codes/${enc(barcode)}`, { method: 'DELETE' }),
  importProducts: (csv: string, onlyListings: boolean) =>
    http<{ products: number; codes: number; skipped: number }>('/api/v1/wms/products/import', { body: { csv, onlyListings } }),
  clearProducts: (password: string) => http<{ products: number; codes: number }>('/api/v1/wms/products/clear', { body: { password } }),
};

/** Configuração de impressão da empresa (lida uma vez por sessão; `refresh` após salvar). */
let settingsCache: Promise<WmsSettingsDto> | null = null;
export function loadPrintSettings(refresh = false): Promise<WmsSettingsDto> {
  if (!settingsCache || refresh) {
    settingsCache = fullApi.settings().catch((err: unknown) => {
      settingsCache = null;
      throw err;
    });
  }
  return settingsCache;
}

/** Arquivo → base64 (sem o prefixo data:). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo'));
    r.readAsDataURL(file);
  });
}
