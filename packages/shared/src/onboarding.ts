import { z } from 'zod';

export const MARKETPLACES = ['mercado_livre', 'shopee', 'tiktok_shop'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

/** Marketplaces já liberados para conexão. Os demais aparecem como "em breve". */
export const AVAILABLE_MARKETPLACES: readonly Marketplace[] = ['mercado_livre'];

export const ONBOARDING_STEPS = ['welcome', 'platform', 'authorize', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const saveOnboardingSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  marketplace: z
    .enum(MARKETPLACES)
    .refine((m) => AVAILABLE_MARKETPLACES.includes(m), 'Plataforma ainda não disponível')
    .optional(),
});
export type SaveOnboardingInput = z.infer<typeof saveOnboardingSchema>;

export interface OnboardingDto {
  step: OnboardingStep;
  marketplace: Marketplace | null;
  completed: boolean;
}

// ================= Tours guiados (Gertrudez ensina)
export const tourIdSchema = z.string().regex(/^[a-z0-9-]{2,40}$/);
export const saveTourSchema = z.object({ status: z.enum(['done', 'skipped']) });
/** Tours já vistos pelo usuário (concluídos ou pulados). */
export interface ToursDto {
  seen: string[];
}
