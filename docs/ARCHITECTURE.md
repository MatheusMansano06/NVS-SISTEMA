# Arquitetura

## Visão geral

Monólito modular: um único deployable (`apps/api`) dividido em módulos de negócio isolados.
Escala horizontalmente porque a API é stateless (JWT) — basta replicar instâncias atrás de um
load balancer. Cache e barramento de eventos estão atrás de portas, prontos para Redis/fila.

## Módulos (`apps/api/src/modules/<modulo>`)

```
domain/          entidades e contratos (sem dependências de framework/DB)
application/     casos de uso / serviços
infrastructure/  adaptadores (PostgreSQL, cache…)
presentation/    rotas HTTP, validação e DTOs
index.ts         API pública do módulo
```

Regras (impostas por ESLint — `no-restricted-imports`):

1. Dependências apontam para dentro: presentation → application → domain.
2. Um módulo só importa outro **via `index.ts`**; nunca camadas internas.
3. Comunicação desacoplada entre módulos via `EventBus` (`shared/kernel`).
4. Cada módulo mantém seus próprios testes ao lado do código.

Módulos atuais: `health`, `tenancy` (empresas), `identity` (usuários, auth, RBAC).
`src/app.ts` é o composition root onde os módulos são montados.

### Criando um módulo

1. Crie `modules/<nome>/{domain,application,infrastructure,presentation}` e `index.ts`.
2. Adicione a migration em `database/migrations/NNNN_<nome>.sql` (com `tenant_id` + RLS).
3. Acrescente permissões em `packages/shared/src/permissions.ts`.
4. Registre as rotas em `src/app.ts` com prefixo `/api/v1`.

## Multi-tenancy

Schema compartilhado, coluna `tenant_id` em toda tabela de negócio e **Row Level Security** no
PostgreSQL. `Database.withTenant()` abre uma transação e define `app.tenant_id`; a política RLS
(`FORCE`) filtra leituras e bloqueia escritas cruzadas — mesmo se uma query esquecer o `WHERE`.
Tabela `tenants` é global (sem RLS). O papel do banco da aplicação **não** pode ser superuser
(superusers ignoram RLS).

## Segurança

- Senhas: scrypt com salt por usuário; comparação em tempo constante; login resiste a enumeração.
- JWT de vida curta; RBAC por permissão (`requirePermission`), matriz em `packages/shared`.
- Helmet, CORS restrito, rate limit global e estrito em auth, limite de body, validação Zod.
- Erros 5xx não vazam detalhes. Secrets só por variável de ambiente (`.env` fora do git).

## Performance

- Pool de conexões, índices compostos iniciados por `tenant_id`, paginação obrigatória (`limit ≤ 100`).
- `TenantDirectory` cacheia resolução de tenant (porta `Cache`; trocar por Redis ao escalar).
- Eventos publicados de forma assíncrona (não bloqueiam a resposta).

## Banco de dados

Migrations SQL puras em `database/migrations`, aplicadas em ordem, uma transação por arquivo,
com checksum para detectar alteração de migration já aplicada. Nunca edite uma migration aplicada:
crie uma nova.

## Próximos passos sugeridos

Refresh tokens e revogação, auditoria, Redis (cache/rate limit/fila), observabilidade
(OpenTelemetry), testes E2E do frontend, deploy (IaC) em `infrastructure/`.
