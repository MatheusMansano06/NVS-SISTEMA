import type {
  TenantFeature,
  AdminDto,
  AnnouncementDto,
  AuditDto,
  CouponDto,
  InvoiceDto,
  PlanDto,
  PlatformOverviewDto,
  SubscriptionStatus,
  TenantDetailDto,
  TenantRowDto,
} from '@nvs/shared';
import { http } from '../../shared/http';

const A = '/api/v1/admin';

export const masterApi = {
  me: () => http<AdminDto>(`${A}/me`),
  login: (email: string, password: string) => http<AdminDto>(`${A}/auth/login`, { body: { email, password } }),
  logout: () => http<void>(`${A}/auth/logout`, { method: 'POST' }),
  overview: () => http<PlatformOverviewDto>(`${A}/overview`),
  tenants: (q = '') => http<TenantRowDto[]>(`${A}/tenants${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  tenant: (id: string) => http<TenantDetailDto>(`${A}/tenants/${id}`),
  tenantStatus: (id: string, status: 'active' | 'suspended') => http<void>(`${A}/tenants/${id}/status`, { body: { status } }),
  tenantFeature: (id: string, feature: TenantFeature, enabled: boolean) => http<void>(`${A}/tenants/${id}/features`, { body: { feature, enabled } }),
  resetFeatures: (id: string) => http<void>(`${A}/tenants/${id}/features/reset`, { body: {} }),
  resetPassword: (tenantId: string, userId: string) =>
    http<{ email: string; temporaryPassword: string }>(`${A}/tenants/${tenantId}/users/${userId}/reset-password`, { method: 'POST' }),
  saveSubscription: (
    tenantId: string,
    body: { planId: string | null; price: number | null; status: SubscriptionStatus; trialEndsOn: string | null; billingDay: number; couponCode: string | null; notes: string | null },
  ) => http<void>(`${A}/tenants/${tenantId}/subscription`, { method: 'PUT', body }),
  plans: () => http<PlanDto[]>(`${A}/plans`),
  savePlan: (body: { name: string; price: number; description: string | null; active: boolean; features: TenantFeature[] }, id?: string) =>
    http<void>(`${A}/plans${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
  coupons: () => http<CouponDto[]>(`${A}/coupons`),
  saveCoupon: (body: Omit<CouponDto, 'id' | 'redemptions'>, id?: string) => http<void>(`${A}/coupons${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
  deleteCoupon: (id: string) => http<void>(`${A}/coupons/${id}`, { method: 'DELETE' }),
  invoices: (f: { situation?: string; period?: string; tenantId?: string } = {}) =>
    http<InvoiceDto[]>(`${A}/invoices?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])}`),
  generate: (period: string) => http<{ created: number; skipped: number }>(`${A}/invoices/generate`, { body: { period } }),
  createInvoice: (body: { tenantId: string; period: string; description: string; amount: number; dueDate: string }) => http<void>(`${A}/invoices`, { body }),
  pay: (id: string, method: string, paidOn: string | null) => http<void>(`${A}/invoices/${id}/pay`, { body: { method, paidOn } }),
  invoiceStatus: (id: string, status: 'pending' | 'canceled') => http<void>(`${A}/invoices/${id}/status`, { body: { status } }),
  announcements: () => http<AnnouncementDto[]>(`${A}/announcements`),
  announce: (body: { title: string; body: string; level: string; audience: 'all' | 'tenants'; tenantIds: string[]; startsAt: string | null; endsAt: string | null }) =>
    http<void>(`${A}/announcements`, { body }),
  announcementActive: (id: string, active: boolean) => http<void>(`${A}/announcements/${id}/active`, { body: { active } }),
  admins: () => http<AdminDto[]>(`${A}/admins`),
  createAdmin: (body: { email: string; name: string; password: string }) => http<AdminDto>(`${A}/admins`, { body }),
  adminActive: (id: string, active: boolean) => http<void>(`${A}/admins/${id}/active`, { body: { active } }),
  audit: () => http<AuditDto[]>(`${A}/audit`),
};

export const SUB_LABEL: Record<SubscriptionStatus, string> = { trial: 'Teste grátis', active: 'Ativa', past_due: 'Em atraso', canceled: 'Cancelada' };
export const SITUATION_LABEL = { pending: 'A vencer', overdue: 'Em atraso', paid: 'Paga', canceled: 'Cancelada' } as const;
export const brDate = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
