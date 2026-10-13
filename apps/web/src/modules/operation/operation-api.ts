import type { OperatorDto, OperatorSessionDto, StationDto } from '@nvs/shared';
import { http } from '../../shared/http';

export const operationApi = {
  // Análise
  list: () => http<OperatorDto[]>('/api/v1/operators'),
  create: (name: string) => http<OperatorDto>('/api/v1/operators', { body: { name } }),
  update: (id: string, p: { name?: string; active?: boolean }) => http<OperatorDto>(`/api/v1/operators/${id}`, { method: 'PATCH', body: p }),
  resetPin: (id: string) => http<void>(`/api/v1/operators/${id}/reset-pin`, { method: 'POST', body: {} }),
  startStation: () => http<void>('/api/v1/station/start', { method: 'POST', body: {} }),
  // Computador da operação
  station: () => http<StationDto>('/api/v1/station'),
  login: (operatorId: string, pin: string) => http<OperatorSessionDto>('/api/v1/station/login', { body: { operatorId, pin } }),
  exitStation: () => http<void>('/api/v1/station/exit', { method: 'POST', body: {} }),
  me: () => http<OperatorSessionDto>('/api/v1/operator/me'),
  changePin: (current: string, next: string) => http<OperatorSessionDto>('/api/v1/operator/pin', { body: { current, next } }),
  logout: () => http<void>('/api/v1/operator/logout', { method: 'POST', body: {} }),
};
