# NVS Sistema Tech

Plataforma SaaS multi-tenant — Modular Monolith, Clean Architecture, PostgreSQL.

```
apps/api          Backend (Fastify + TypeScript) — módulos em src/modules
apps/web          Frontend (React + Vite + TypeScript)
packages/shared   Contratos compartilhados: schemas Zod, tipos, RBAC
database          Migrations SQL + runner
infrastructure    Dockerfiles, nginx
docs              Documentação técnica
```

## Começando

Requisitos: Node 22+, PostgreSQL 15+ (ou Docker).

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL / JWT_SECRET
docker compose up -d db       # ou use um PostgreSQL local
npm run db:migrate
npm run dev                   # API :3333 · Web :5173
```

Stack completa em containers: `JWT_SECRET=<min 32 chars> docker compose up --build` (web em :8080).

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run dev` | API + Web em modo watch |
| `npm run build` | Build de shared, api e web |
| `npm test` | Testes (integração usa o banco `TEST_DATABASE_URL`, separado do dev) |
| `npm run db:migrate:test` | Aplica migrations no banco de testes |
| `npm run lint` / `typecheck` | ESLint (inclui fronteiras de módulos) / tsc |
| `npm run db:migrate` / `db:status` | Aplica / lista migrations |

## Endpoints (v1)

`GET /health` · `GET /ready` · `POST /api/v1/tenants` · `POST /api/v1/auth/login` ·
`GET /api/v1/auth/me` · `GET|POST /api/v1/users` (RBAC)

Arquitetura e como criar um módulo novo: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
