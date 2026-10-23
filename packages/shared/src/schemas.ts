import { z } from 'zod';
import { isValidCnpj, onlyDigits } from './cnpj.js';
import { ROLES } from './permissions.js';
import { teamSetupSchema } from './operation.js';

export const emailSchema = z.string().trim().toLowerCase().email('E-mail inválido').max(254);

export const passwordSchema = z
  .string()
  .min(10, 'Use ao menos 10 caracteres')
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use letras e números');

export const cnpjSchema = z
  .string()
  .transform(onlyDigits)
  .refine(isValidCnpj, 'CNPJ inválido');

export const phoneSchema = z
  .string()
  .transform(onlyDigits)
  .transform((v) => (v.startsWith('55') && v.length > 11 ? v.slice(2) : v))
  .refine((v) => /^[1-9]{2}9?\d{8}$/.test(v), 'Telefone inválido (use DDD + número)');

/** Cadastro inicial: a senha provisória é o CNPJ e deve ser trocada no primeiro acesso. */
export const registerAccountSchema = z.object({
  email: emailSchema,
  phone: phoneSchema,
  cnpj: cnpjSchema,
  /** Equipe que entra por nome + PIN (Análise/Operação). Opcional: dá para cadastrar no 1º acesso. */
  team: teamSetupSchema.optional(),
});
export type RegisterAccountInput = z.infer<typeof registerAccountSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Senha provisória é o CNPJ: aceita com ou sem pontuação (normalizado no servidor).
  password: z.string().min(1, 'Informe a senha').max(128),
  remember: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'A nova senha deve ser diferente da atual',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(ROLES).default('member'),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: (typeof ROLES)[number];
  isActive: boolean;
  createdAt: string;
}

/**
 * Recursos que o Painel Master libera por empresa (e que cada plano inclui); o que não estiver liberado aparece como
 * "em breve". Dashboard, Cadastro de SKUs, Integrações e Equipe são a base e ficam sempre ligados.
 */
export const TENANT_FEATURES = ['financeiro', 'dre', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes', 'full', 'viabilidade', 'radar_ads', 'radar_produtos'] as const;
export type TenantFeature = (typeof TENANT_FEATURES)[number];
export const TENANT_FEATURE_INFO: Record<TenantFeature, { label: string; text: string; area: 'Análise' | 'Anúncios' | 'Operação' }> = {
  financeiro: { label: 'Análise Financeira', text: 'Margem de contribuição venda a venda, composição e exportação.', area: 'Análise' },
  dre: { label: 'DRE', text: 'Resultado do mês, custos da empresa e custo real da equipe.', area: 'Análise' },
  vendas: { label: 'Vendas', text: 'Pedidos, formas de pagamento, estados e DIFAL.', area: 'Análise' },
  precificador: { label: 'Precificador', text: 'Simula preço, tarifa, frete e margem antes de anunciar.', area: 'Análise' },
  radar_frete: { label: 'Flex e Radar de Frete', text: 'Frete pago por anúncio e oportunidades de Flex.', area: 'Análise' },
  viabilidade: { label: 'Estudo de Viabilidade', text: 'Extensão do Chrome: data, vendas, tipo e visitas de qualquer anúncio do ML.', area: 'Análise' },
  anuncios: { label: 'Meus anúncios', text: 'Lista de anúncios com margem, edição, estoque e preço.', area: 'Anúncios' },
  promocoes: { label: 'Central de Promoção', text: 'Inscrever anúncios nas campanhas do ML vendo a margem.', area: 'Anúncios' },
  marketing: { label: 'Central de Marketing', text: 'Raio-X das ferramentas do ML (atacado, cupom, ofertas, Ads…).', area: 'Anúncios' },
  radar_ads: { label: 'Radar ADS', text: 'Regras e metas para as campanhas do Mercado Ads, com alertas.', area: 'Anúncios' },
  radar_produtos: { label: 'Produto Campeão', text: 'Ranking diário dos produtos que passaram no estudo de viabilidade do agente.', area: 'Análise' },
  devolucoes: { label: 'Central de Devoluções', text: 'Conferência, contestação, B.I e estoque virtual das devoluções.', area: 'Operação' },
  full: { label: 'Supervisão Full', text: 'Separação das listas do Full com bipagem e impressão das etiquetas.', area: 'Operação' },
};
export const TENANT_FEATURE_LABELS: Record<TenantFeature, string> = Object.fromEntries(
  TENANT_FEATURES.map((f) => [f, TENANT_FEATURE_INFO[f].label]),
) as Record<TenantFeature, string>;
/** Padrão de empresa nova e de plano novo: tudo, menos o que ainda está em teste (Full, Viabilidade, Radar ADS e Produto Campeão). */
export const DEFAULT_TENANT_FEATURES: TenantFeature[] = TENANT_FEATURES.filter((f) => f !== 'full' && f !== 'viabilidade' && f !== 'radar_ads' && f !== 'radar_produtos');

export interface SessionDto {
  user: UserDto;
  tenant: { id: string; name: string; slug: string; features: TenantFeature[] };
  mustChangePassword: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { fieldErrors?: Record<string, string[]> } };
}

/** Exclusão definitiva da empresa (somente o dono): confirma com o CNPJ e a senha. */
export const deleteAccountSchema = z.object({
  cnpj: z.string().transform(onlyDigits),
  password: z.string().min(1).max(128),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
