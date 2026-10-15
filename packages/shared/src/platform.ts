import { z } from 'zod';

/** Painel Master (dono do NVS Tech): empresas, mensalidades, cupons, planos, comunicados e administradores. */

export const adminLoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
export const adminCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(10, 'A senha da master precisa ter ao menos 10 caracteres').max(200),
});

export const planSchema = z.object({
  name: z.string().trim().min(2).max(60),
  price: z.number().min(0).max(1_000_000),
  description: z.string().trim().max(300).nullish(),
  active: z.boolean().default(true),
});

export const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, 'Código: 3 a 30 letras, números, - ou _'),
  description: z.string().trim().max(200).nullish(),
  kind: z.enum(['percent', 'fixed']),
  value: z.number().positive().max(1_000_000),
  duration: z.enum(['once', 'months', 'forever']),
  months: z.number().int().min(1).max(60).nullish(),
  maxRedemptions: z.number().int().positive().nullish(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  active: z.boolean().default(true),
}).refine((c) => c.kind !== 'percent' || c.value <= 100, { message: 'Percentual até 100%', path: ['value'] })
  .refine((c) => c.duration !== 'months' || !!c.months, { message: 'Diga por quantos meses', path: ['months'] });

export const subscriptionSchema = z.object({
  planId: z.string().uuid().nullish(),
  price: z.number().min(0).max(1_000_000).nullish(),
  status: z.enum(['trial', 'active', 'past_due', 'canceled']),
  trialEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  billingDay: z.number().int().min(1).max(28),
  couponCode: z.string().trim().toUpperCase().max(30).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

export const invoiceCreateSchema = z.object({
  tenantId: z.string().uuid(),
  period: z.string().regex(/^\d{4}-\d{2}-01$/),
  description: z.string().trim().min(2).max(120),
  amount: z.number().min(0).max(1_000_000),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const invoicePaySchema = z.object({
  method: z.enum(['pix', 'boleto', 'cartao', 'transferencia', 'outro']),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().trim().max(300).nullish(),
});

export const announcementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  level: z.enum(['info', 'success', 'warning', 'danger']),
  audience: z.enum(['all', 'tenants']),
  tenantIds: z.array(z.string().uuid()).max(500).default([]),
  startsAt: z.string().datetime({ offset: true }).nullish(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
});

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'canceled';
export type InvoiceSituation = 'pending' | 'overdue' | 'paid' | 'canceled';

export interface AdminDto { id: string; email: string; name: string; isActive: boolean; lastLoginAt: string | null; createdAt: string }

export interface PlatformOverviewDto {
  tenants: { total: number; active: number; suspended: number; newLast30: number; mlConnected: number };
  subscriptions: Record<SubscriptionStatus, number> & { none: number };
  mrr: number;
  invoices: { pending: number; pendingTotal: number; overdue: number; overdueTotal: number; paidThisMonth: number };
  recent: { id: string; name: string; createdAt: string }[];
}

export interface TenantRowDto {
  id: string;
  name: string;
  cnpj: string | null;
  phone: string | null;
  status: 'active' | 'suspended';
  createdAt: string;
  ownerEmail: string | null;
  users: number;
  mlConnected: boolean;
  subscription: { status: SubscriptionStatus; planName: string | null; price: number | null } | null;
  overdue: number;
  /** Recursos liberados para a empresa (TENANT_FEATURES). */
  features: string[];
}

export interface TenantDetailDto extends TenantRowDto {
  people: { id: string; name: string; email: string; role: string; isActive: boolean; mustChangePassword: boolean; createdAt: string }[];
  mlAccounts: { nickname: string; marketplace: string }[];
  sales30: { orders: number; revenue: number };
  subscriptionDetail: {
    planId: string | null; price: number | null; status: SubscriptionStatus; trialEndsOn: string | null; billingDay: number;
    couponCode: string | null; couponCyclesLeft: number | null; notes: string | null;
  } | null;
  invoices: InvoiceDto[];
}

export interface InvoiceDto {
  id: string;
  tenantId: string;
  tenantName: string;
  period: string;
  description: string;
  amount: number;
  discount: number;
  total: number;
  couponCode: string | null;
  dueDate: string;
  situation: InvoiceSituation;
  paidAt: string | null;
  method: string | null;
  notes: string | null;
}

export interface PlanDto { id: string; name: string; price: number; description: string | null; active: boolean; subscribers: number }
export interface CouponDto {
  id: string; code: string; description: string | null; kind: 'percent' | 'fixed'; value: number; duration: 'once' | 'months' | 'forever';
  months: number | null; maxRedemptions: number | null; redemptions: number; validUntil: string | null; active: boolean;
}
export interface AnnouncementDto {
  id: string; title: string; body: string; level: 'info' | 'success' | 'warning' | 'danger'; audience: 'all' | 'tenants';
  tenantIds: string[]; startsAt: string; endsAt: string | null; active: boolean; dismissals: number; createdAt: string;
}
/** O que o usuário da empresa vê: comunicados da master e avisos automáticos (ex.: mensalidade em atraso). */
export interface UserNoticeDto { id: string; title: string; body: string; level: 'info' | 'success' | 'warning' | 'danger'; automatic: boolean }
export interface AuditDto { id: string; adminName: string | null; action: string; target: string | null; details: Record<string, unknown>; createdAt: string }
