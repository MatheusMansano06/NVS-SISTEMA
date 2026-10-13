import { z } from 'zod';

/** PIN padrão de pessoa nova (ou resetada). Trocar é opcional. */
export const DEFAULT_PIN = '1234';
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

/** Onde a pessoa entra: Análise (sistema completo), Operação (expedição) ou nas duas. */
export const TEAM_AREAS = ['analise', 'operacao', 'ambos'] as const;
export type TeamArea = (typeof TEAM_AREAS)[number];
export type TeamMode = 'analise' | 'operacao';
export const TEAM_AREA_LABELS: Record<TeamArea, string> = { analise: 'Análise', operacao: 'Operação', ambos: 'Análise e Operação' };
export const areaAllows = (area: TeamArea, mode: TeamMode) => area === 'ambos' || area === mode;

const pin = z.string().regex(/^\d{4}$/, 'O PIN tem 4 números');
const name = z.string().trim().min(1, 'Informe o nome').max(60);
const area = z.enum(TEAM_AREAS);

export const teamMemberSchema = z.object({ name, area, master: z.boolean().default(false) });
export type TeamMemberInput = z.infer<typeof teamMemberSchema>;
/** Equipe inicial (no cadastro da conta): pelo menos um MASTER, sem nomes repetidos. */
export const teamSetupSchema = z
  .array(teamMemberSchema)
  .min(1, 'Cadastre pelo menos uma pessoa')
  .max(50)
  .refine((t) => t.some((m) => m.master), { message: 'Marque pelo menos um MASTER' })
  .refine((t) => new Set(t.map((m) => m.name.trim().toLowerCase())).size === t.length, { message: 'Há nomes repetidos' });

export const createOperatorSchema = teamMemberSchema;
export const updateOperatorSchema = z.object({
  name: name.optional(),
  area: area.optional(),
  master: z.boolean().optional(),
  active: z.boolean().optional(),
});
export const pinLoginSchema = z.object({ operatorId: z.string().uuid(), pin, mode: z.enum(['analise', 'operacao']) });
export const changePinSchema = z
  .object({ current: pin, next: pin })
  .refine((v) => v.next !== v.current, { message: 'O novo PIN precisa ser diferente do atual', path: ['next'] })
  .refine((v) => !/^(\d)\1{3}$/.test(v.next), { message: 'Evite números repetidos (ex.: 0000)', path: ['next'] });

export interface OperatorDto {
  id: string;
  name: string;
  area: TeamArea;
  master: boolean;
  active: boolean;
  /** Ainda usa o PIN padrão 1234. */
  defaultPin: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Tela de escolha de nome: só o necessário (nada de dados sensíveis). */
export interface TeamDto {
  tenant: { name: string };
  /** Conta sem nenhum MASTER ativo: precisa cadastrar a equipe antes de entrar. */
  setupNeeded: boolean;
  members: { id: string; name: string; area: TeamArea }[];
}

export interface PersonSessionDto {
  person: { id: string; name: string; area: TeamArea; master: boolean; defaultPin: boolean };
  mode: TeamMode;
}
