import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { hasPermission, type Permission, type Role } from '@nvs/shared';
import type { Env } from './config/env.js';
import { Database } from './shared/infrastructure/database.js';
import { MemoryCache, type Cache } from './shared/kernel/cache.js';
import { EventBus } from './shared/kernel/event-bus.js';
import { AppError, ForbiddenError, UnauthorizedError } from './shared/kernel/errors.js';
import { PgTenantRepository, TenantDirectory } from './modules/tenancy/index.js';
import { IdentityService, PgUserRepository, identityRoutes } from './modules/identity/index.js';
import { OnboardingService, PgOnboardingRepository, onboardingRoutes } from './modules/onboarding/index.js';
import {
  DashboardService,
  PgSalesRepository,
  PgSkuRepository,
  SalesIngestion,
  SkuCostService,
  FinanceService,
  financeRoutes,
  PgSalesAnalyticsRepository,
  SalesAnalyticsService,
  salesAnalyticsRoutes,
  SalesRetention,
  salesRoutes,
  skuRoutes,
} from './modules/sales/index.js';
import {
  HttpMlApi,
  MlIntegrationService,
  PgMlRepository,
  PgListingRepository,
  ListingService,
  PromotionService,
  ListingEditorService,
  PricingService,
  PgCategoryCache,
  CachedMlLookups,
  FlexService,
  FreightRadarService,
  pricingRoutes,
  listingRoutes,
  mercadoLivreRoutes,
  type MlApi,
} from './modules/mercado-livre/index.js';
import { TokenCipher } from './shared/infrastructure/token-cipher.js';
import { serveWeb } from './shared/infrastructure/web-static.js';
import { healthRoutes } from './modules/health/presentation/routes.js';
import { OperatorService, PERSON_COOKIE, PgOperatorRepository, operationRoutes } from './modules/operation/index.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; tenantId: string; role: Role; mcp?: boolean; typ?: 'person'; mode?: 'analise' | 'operacao' };
    user: { sub: string; tenantId: string; role: Role; mcp?: boolean; typ?: 'person'; mode?: 'analise' | 'operacao' };
  }
}
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Integração Mercado Livre (null quando não configurada no ambiente). */
    ml: MlIntegrationService | null;
    /** Retenção das vendas (13 meses de detalhe; depois, totais mensais). */
    retention: SalesRetention;
    /** Radar de Frete (null sem ML configurado). */
    radar: FreightRadarService | null;
    requirePermission: (
      p: Permission,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AppDeps {
  env: Env;
  db?: Database;
  cache?: Cache;
  /** Substitui a API do Mercado Livre (testes). */
  mlApi?: MlApi;
}

/** Composition root: monta os módulos e injeta dependências. */
export async function buildApp({ env, db, cache, mlApi }: AppDeps): Promise<FastifyInstance> {
  const database = db ?? new Database(env.DATABASE_URL);
  const events = new EventBus();
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    bodyLimit: 100_000,
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        // fotos dos anúncios vêm do CDN do Mercado Livre
        'img-src': ["'self'", 'data:', 'https://*.mlstatic.com'],
      },
    },
  });
  await app.register(cors, { origin: env.CORS_ORIGIN.split(','), credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
    cookie: { cookieName: 'nvs_session', signed: false },
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new UnauthorizedError('Token ausente ou inválido');
    }
    // tokens da Operação (estação/operador) nunca valem como sessão da Análise
    if (req.user.typ) throw new UnauthorizedError('Token ausente ou inválido');
  });
  app.decorate('requirePermission', (permission: Permission) => async (req: FastifyRequest) => {
    await app.authenticate(req, undefined as never);
    if (!hasPermission(req.user.role, permission)) throw new ForbiddenError();
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as Error;
    if (err instanceof AppError) {
      const details = (err as { details?: unknown }).details;
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({
      error: {
        code: status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: status >= 500 ? 'Erro interno' : err.message,
      },
    });
  });

  // ---- composição dos módulos
  const sharedCache = cache ?? new MemoryCache();
  const tenants = new TenantDirectory(new PgTenantRepository(database), sharedCache);
  const identity = new IdentityService(database, new PgUserRepository(), tenants, events);

  await app.register(healthRoutes(database));
  const dashboard = new DashboardService(database, new PgSalesRepository(), sharedCache);
  await app.register(salesRoutes(dashboard), { prefix: '/api/v1' });
  const skuCosts = new SkuCostService(database, new PgSkuRepository(), sharedCache);
  await app.register(skuRoutes(skuCosts), { prefix: '/api/v1' });
  await app.register(financeRoutes(new FinanceService(database, sharedCache)), { prefix: '/api/v1' });
  await app.register(salesAnalyticsRoutes(new SalesAnalyticsService(database, new PgSalesAnalyticsRepository())), { prefix: '/api/v1' });

  const mlConfigured = Boolean(
    env.ML_CLIENT_ID && env.ML_CLIENT_SECRET && env.ML_REDIRECT_URI && env.TOKEN_ENCRYPTION_KEY,
  );
  const mlClient: MlApi | null = mlConfigured
    ? (mlApi ??
      new HttpMlApi({
        clientId: env.ML_CLIENT_ID!,
        clientSecret: env.ML_CLIENT_SECRET!,
        redirectUri: env.ML_REDIRECT_URI!,
      }))
    : null;
  const ml = mlConfigured
    ? new MlIntegrationService(
        database,
        new PgMlRepository(database),
        mlClient!,
        new TokenCipher(env.TOKEN_ENCRYPTION_KEY!),
        new SalesIngestion(),
        events,
        app.log,
        { clientId: env.ML_CLIENT_ID!, usePkce: env.ML_USE_PKCE },
      )
    : null;
  app.decorate('ml', ml);
  app.decorate('retention', new SalesRetention(database, app.log));
  await app.register(mercadoLivreRoutes(ml), { prefix: '/api/v1' });
  const mlLookups = mlClient ? new CachedMlLookups(mlClient, sharedCache) : null;
  const listingService = ml && mlClient && mlLookups ? new ListingService(database, new PgListingRepository(), ml, mlClient, mlLookups) : null;
  const flexService = listingService && ml && mlClient ? new FlexService(database, listingService, ml, mlClient, sharedCache) : null;
  const radarService = ml && mlLookups ? new FreightRadarService(database, ml, new PgMlRepository(database), mlLookups, app.log) : null;
  app.decorate('radar', radarService);
  await app.register(
    listingRoutes(
      listingService,
      ml && mlClient ? new PromotionService(database, new PgListingRepository(), ml, mlClient, sharedCache) : null,
      listingService && ml && mlClient ? new ListingEditorService(listingService, ml, mlClient) : null,
      flexService,
      radarService,
    ),
    { prefix: '/api/v1' },
  );
  await app.register(pricingRoutes(ml && mlClient ? new PricingService(database, ml, mlClient, new PgCategoryCache(database), mlLookups!) : null), { prefix: '/api/v1' });
  const operators = new OperatorService(database, new PgOperatorRepository());
  await app.register(
    operationRoutes(operators, {
      secureCookies: env.NODE_ENV === 'production',
      tenantName: async (id) => (await database.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [id])).rows[0]?.name ?? '',
    }),
    { prefix: '/api/v1' },
  );
  const onboarding = new OnboardingService(database, new PgOnboardingRepository(), events);
  await app.register(onboardingRoutes(onboarding), { prefix: '/api/v1' });
  await app.register(identityRoutes(identity, {
      secureCookies: env.NODE_ENV === 'production',
      authRateLimit: env.AUTH_RATE_LIMIT_MAX,
      onRegisterTeam: (db, ids, team) => operators.setup(ids.tenantId, ids.userId, team, db),
      logoutCookies: [PERSON_COOKIE],
    }), {
    prefix: '/api/v1',
  });

  await serveWeb(app, env.WEB_DIST_DIR);

  app.addHook('onClose', async () => {
    if (!db) await database.close();
  });
  return app;
}
