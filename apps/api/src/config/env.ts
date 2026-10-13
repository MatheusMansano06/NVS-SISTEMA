import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3333),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter ao menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Tentativas por minuto/IP nas rotas de autenticação (proteção contra força bruta). */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Pasta do build do frontend servida pela API (produção). */
  WEB_DIST_DIR: z.string().optional(),
  /** Integração Mercado Livre (opcional até a integração ser ativada). */
  ML_CLIENT_ID: z.string().optional(),
  ML_CLIENT_SECRET: z.string().optional(),
  ML_REDIRECT_URI: z.union([z.string().url().startsWith('https://'), z.literal('')]).optional(),
  /** PKCE no OAuth do ML (deve refletir a opção na configuração do app no DevCenter). */
  ML_USE_PKCE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Chave AES-256 (64 hex) para criptografar tokens de marketplaces em repouso. */
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'TOKEN_ENCRYPTION_KEY precisa ter 64 caracteres hex').optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Configuração inválida: ${parsed.error.message}`);
  }
  return parsed.data;
}
