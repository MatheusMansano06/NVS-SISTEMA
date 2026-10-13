import type { OperatorDto, PersonSessionDto, TeamDto, TeamMemberInput, TeamMode } from '@nvs/shared';
import { http } from '../../shared/http';

export const teamApi = {
  // entrada (sessão da empresa aberta)
  team: () => http<TeamDto>('/api/v1/team'),
  setup: (team: TeamMemberInput[]) => http<void>('/api/v1/team/setup', { body: team }),
  login: (operatorId: string, pin: string, mode: TeamMode) => http<PersonSessionDto>('/api/v1/team/login', { body: { operatorId, pin, mode } }),
  me: () => http<PersonSessionDto>('/api/v1/team/me'),
  changePin: (current: string, next: string) => http<PersonSessionDto>('/api/v1/team/pin', { body: { current, next } }),
  logout: () => http<void>('/api/v1/team/logout', { method: 'POST', body: {} }),
  // cadastro (MASTER)
  list: () => http<OperatorDto[]>('/api/v1/team/members'),
  create: (m: TeamMemberInput) => http<OperatorDto>('/api/v1/team/members', { body: m }),
  update: (id: string, p: Partial<TeamMemberInput> & { active?: boolean }) =>
    http<OperatorDto>(`/api/v1/team/members/${id}`, { method: 'PATCH', body: p }),
  resetPin: (id: string) => http<void>(`/api/v1/team/members/${id}/reset-pin`, { method: 'POST', body: {} }),
};
