import { z } from 'zod';

/** PIN padrão de operador novo (ou resetado); obrigatório trocar no primeiro acesso. */
export const DEFAULT_PIN = '1234';
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

const pin = z.string().regex(/^\d{4}$/, 'O PIN tem 4 números');
const name = z.string().trim().min(1, 'Informe o nome').max(60);

export const createOperatorSchema = z.object({ name });
export const updateOperatorSchema = z.object({ name: name.optional(), active: z.boolean().optional() });
export const pinLoginSchema = z.object({ operatorId: z.string().uuid(), pin });
export const changePinSchema = z
  .object({ current: pin, next: pin })
  .refine((v) => v.next !== DEFAULT_PIN, { message: 'Escolha um PIN diferente de 1234', path: ['next'] })
  .refine((v) => v.next !== v.current, { message: 'O novo PIN precisa ser diferente do atual', path: ['next'] })
  .refine((v) => !/^(\d)\1{3}$/.test(v.next), { message: 'Evite números repetidos (ex.: 0000)', path: ['next'] });

export interface OperatorDto {
  id: string;
  name: string;
  active: boolean;
  mustChangePin: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** O que a tela de escolha do operador vê: só nome (nada de dados sensíveis). */
export interface StationDto {
  tenant: { name: string };
  operators: { id: string; name: string }[];
}

export interface OperatorSessionDto {
  operator: { id: string; name: string; mustChangePin: boolean };
  tenant: { id: string; name: string };
}
