import type { ToursDto } from '@nvs/shared';
import { http } from '../http';

// uma consulta por sessão do navegador; as telas compartilham o resultado
let seen: Promise<Set<string>> | null = null;

export const toursApi = {
  seen(): Promise<Set<string>> {
    seen ??= http<ToursDto>('/api/v1/tours')
      .then((r) => new Set(r.seen))
      .catch(() => new Set<string>()); // falhou: não mostra (melhor que insistir a cada tela)
    return seen;
  },
  async save(id: string, status: 'done' | 'skipped') {
    (await toursApi.seen()).add(id);
    await http<void>(`/api/v1/tours/${id}`, { method: 'PUT', body: { status } }).catch(() => undefined);
  },
};
