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

export interface SessionDto {
  user: UserDto;
  tenant: { id: string; name: string; slug: string };
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
