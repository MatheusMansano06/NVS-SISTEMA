import type { ReturnBiDto, ReturnCheckInput, ReturnDetailDto, ReturnEvidenceDto, ReturnListDto, ReturnSummaryDto } from '@nvs/shared';
import { http } from '../../shared/http';

const enc = encodeURIComponent;

export const returnsApi = {
  summary: () => http<ReturnSummaryDto>('/api/v1/returns/summary'),
  list: (q: { status?: string; reason?: string; shipping?: string; q?: string; page?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return http<ReturnListDto>(`/api/v1/returns?${p}`);
  },
  bi: (days: number) => http<ReturnBiDto>(`/api/v1/returns/bi?days=${days}`),
  sync: () => http<{ started: boolean }>('/api/v1/returns/sync', { body: {} }),
  find: (code: string, label?: string) => http<{ matches: ReturnDetailDto[] }>('/api/v1/returns/find', { body: { code, label } }),
  detail: (id: string) => http<ReturnDetailDto>(`/api/v1/returns/${id}`),
  check: (id: string, b: ReturnCheckInput) => http<ReturnDetailDto>(`/api/v1/returns/${id}/check`, { body: b }),
  stockDone: (id: string) => http<ReturnDetailDto>(`/api/v1/returns/${id}/stock-done`, { body: {} }),
  toManual: (id: string) => http<ReturnDetailDto>(`/api/v1/returns/${id}/manual-ticket`, { body: {} }),
  ticketOpened: (id: string, protocol?: string, note?: string) => http<ReturnDetailDto>(`/api/v1/returns/${id}/ticket-opened`, { body: { protocol, note } }),
  reasons: (id: string) => http<{ id: string; text: string }[]>(`/api/v1/returns/${id}/dispute-reasons`),
  dispute: (id: string, b: { reason: string; message: string }) => http<ReturnDetailDto>(`/api/v1/returns/${id}/dispute`, { body: b }),
  accept: (id: string) => http<ReturnDetailDto>(`/api/v1/returns/${id}/accept`, { body: {} }),
  addEvidence: (id: string, mime: string, dataBase64: string) => http<ReturnEvidenceDto[]>(`/api/v1/returns/${id}/evidence`, { body: { mime, dataBase64 } }),
  evidenceUrl: (evId: string) => `/api/v1/returns/evidence/${enc(evId)}`,
  deleteEvidence: (evId: string) => http<void>(`/api/v1/returns/evidence/${enc(evId)}`, { method: 'DELETE' }),
  replies: () => http<{ id: string; text: string }[]>('/api/v1/returns/replies'),
  addReply: (text: string) => http<{ id: string; text: string }>('/api/v1/returns/replies', { body: { text } }),
  deleteReply: (id: string) => http<void>(`/api/v1/returns/replies/${enc(id)}`, { method: 'DELETE' }),
};

/** Foto do celular/câmera: reduz para no máx. 1600 px (JPEG) antes de enviar — 4 MB viram ~300 KB. */
export async function photoToJpegBase64(file: File): Promise<{ mime: string; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { mime: 'image/jpeg', data: url.split(',')[1] ?? '' };
}
