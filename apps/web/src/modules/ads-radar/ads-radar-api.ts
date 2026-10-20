import type {
  AdCampaignDetailDto, AdCampaignDto, AdEventDto, AdGoalDto, AdGoalInput, AdRuleDto, AdRuleInput, AdSimulateInput, AdSimulationDto,
  AdsRadarOverviewDto,
} from '@nvs/shared';
import { http } from '../../shared/http';

const base = '/api/v1/ads-radar';

export const adsRadarApi = {
  overview: () => http<AdsRadarOverviewDto>(`${base}/overview`),
  campaigns: () => http<AdCampaignDto[]>(`${base}/campaigns`),
  campaign: (accountId: string, campaignId: number) => http<AdCampaignDetailDto>(`${base}/campaigns/${accountId}/${campaignId}`),
  rules: () => http<AdRuleDto[]>(`${base}/rules`),
  createRule: (body: AdRuleInput) => http<{ id: string }>(`${base}/rules`, { body }),
  updateRule: (id: string, body: AdRuleInput) => http<void>(`${base}/rules/${id}`, { method: 'PUT', body }),
  deleteRule: (id: string) => http<void>(`${base}/rules/${id}`, { method: 'DELETE' }),
  simulate: (body: AdSimulateInput, signal?: AbortSignal) => http<AdSimulationDto>(`${base}/rules/simulate`, { body, signal }),
  goals: () => http<AdGoalDto[]>(`${base}/goals`),
  saveGoal: (body: AdGoalInput) => http<{ id: string }>(`${base}/goals`, { method: 'PUT', body }),
  deleteGoal: (id: string) => http<void>(`${base}/goals/${id}`, { method: 'DELETE' }),
  events: (limit = 50) => http<AdEventDto[]>(`${base}/events?limit=${limit}`),
  markRead: (ids: string[] | null = null) => http<void>(`${base}/events/read`, { body: { ids } }),
  sync: () => http<{ started: boolean }>(`${base}/sync`, { body: {} }),
};
