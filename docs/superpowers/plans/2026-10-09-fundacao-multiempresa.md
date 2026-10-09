# Fundação multi-empresa — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend multi-empresa seguro: cadastro e login, empresas, conta de Mercado Livre conectada por OAuth com token cifrado, isolamento por Row Level Security e recebimento idempotente de webhooks, rodando no Railway.

**Architecture:** FastAPI síncrono (threadpool) com SQLAlchemy Core + `text()` e psycopg 3. Postgres com RLS: a API conecta com o papel `nvs_app` (sem `BYPASSRLS`) e cada transação define `app.empresa_id`. Segurança padrão-negado: middleware exige sessão assinada e o cabeçalho anti-CSRF; rotas públicas são uma lista explícita. Trilhas isoladas em `app/modulos/<trilha>/`.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, psycopg 3, Alembic, pydantic-settings, argon2-cffi, cryptography (AES-GCM), itsdangerous, httpx, pytest, ruff, bandit, pip-audit, PostgreSQL 16, Docker, Railway.

**Spec:** `docs/especificacoes/modelo-de-dados.md` (§1, §2, §7, §8, §10) e `CLAUDE.md`.

## Global Constraints

- Python `>=3.11`; Postgres 16; SQLAlchemy 2 **síncrono** com `psycopg` 3 (sem ORM, SQL em `text()`).
- Nomes de arquivo claros e únicos: `<trilha>_rotas.py`, `<trilha>_servico.py`, `<trilha>_esquemas.py`, `test_<trilha>_*.py`. Nada de `service.py` repetido.
- Comentário só quando o porquê não é óbvio. Funções curtas. Sem abstração para um único uso.
- Segredos **só** em variáveis de ambiente (`NVS_*`), nunca no repositório nem no chat.
- Chave primária `uuid`; dinheiro `numeric(14,2)`; tempo `timestamptz` em UTC.
- Toda tabela de negócio tem `empresa_id` e RLS **ativa e forçada**; a aplicação conecta como `nvs_app`.
- Não guardar dado pessoal de comprador.
- App do ML com credenciais próprias; **escrita nos marketplaces desligada** por padrão.
- Uma trilha só usa outra pelo `*_servico.py` público; nunca importa `app.modulos.<outra>`.
- Fora desta fundação (planos próprios depois): catálogo, pedidos, agregados, finanças, front-end, Shopee, 2FA.

## Estrutura de arquivos

```
NVS-NOVO/
├── .gitignore
├── .github/workflows/ci.yml
├── infra/docker-compose.yml                 Postgres de teste (porta 5433)
├── infra/Dockerfile
├── banco/alembic.ini
├── banco/migracoes/env.py
├── banco/migracoes/versions/0001_fundacao.py
└── backend/
    ├── pyproject.toml
    ├── app/
    │   ├── main.py                          monta o app
    │   ├── nucleo/
    │   │   ├── configuracao.py              variáveis NVS_*
    │   │   ├── banco.py                     motor, transacao(), definir_empresa()
    │   │   ├── senhas.py                    argon2
    │   │   ├── cifra.py                     AES-GCM com versão de chave
    │   │   ├── sessao.py                    cookie assinado
    │   │   ├── limitador.py                 limite de tentativas de login
    │   │   ├── auditoria.py                 registrar()
    │   │   ├── dependencias.py              usuario_atual, empresa_atual, conexao
    │   │   └── seguranca_http.py            padrão-negado, CSRF, cabeçalhos
    │   ├── integracoes/mercado_livre/ml_cliente.py
    │   └── modulos/
    │       ├── saude/saude_rotas.py
    │       ├── autenticacao/{autenticacao_rotas,autenticacao_servico,autenticacao_esquemas}.py
    │       ├── contas/{contas_rotas,contas_servico,contas_tokens}.py
    │       └── notificacoes/notificacoes_rotas.py
    └── tests/ (conftest.py, auxiliares.py, test_*.py)
```

---

### Task 1: Esqueleto, configuração e rota de saúde

**Files:**
- Create: `.gitignore`, `infra/docker-compose.yml`, `backend/pyproject.toml`
- Create: `backend/app/__init__.py`, `backend/app/nucleo/__init__.py`, `backend/app/nucleo/configuracao.py`
- Create: `backend/app/modulos/__init__.py`, `backend/app/modulos/saude/__init__.py`, `backend/app/modulos/saude/saude_rotas.py`
- Create: `backend/app/main.py`, `backend/tests/__init__.py`, `backend/tests/conftest.py`
- Test: `backend/tests/test_saude.py`, `backend/tests/test_configuracao.py`

**Interfaces:**
- Produces: `configuracao() -> Configuracao` com campos `database_url, app_senha, segredo_sessao, chaves_token, ml_client_id, ml_client_secret, ml_redirect_uri, cookie_seguro, frontend_url` e propriedade `url_app`. `app.main.app` (FastAPI) e `criar_app()`.

- [ ] **Step 1: Criar arquivos de projeto**

`.gitignore`:
```
.env
__pycache__/
*.pyc
.venv/
venv/
.pytest_cache/
.ruff_cache/
*.egg-info/
```

`infra/docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: nvs_test
    ports: ["5433:5432"]
```

`backend/pyproject.toml`:
```toml
[project]
name = "nvs-backend"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "sqlalchemy>=2.0",
  "psycopg[binary]>=3.2",
  "alembic>=1.13",
  "pydantic[email]>=2.8",
  "pydantic-settings>=2.4",
  "argon2-cffi>=23.1",
  "cryptography>=43",
  "itsdangerous>=2.2",
  "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.6", "bandit>=1.7", "pip-audit>=2.7"]

[tool.setuptools.packages.find]
include = ["app*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "S"]

[tool.ruff.lint.per-file-ignores]
"tests/*" = ["S101", "S105", "S106", "S608"]
"banco/**" = ["S608"]
```

- [ ] **Step 2: Escrever os testes que falham**

`backend/tests/__init__.py`: arquivo vazio.

`backend/tests/conftest.py`:
```python
import base64
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("NVS_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5433/nvs_test")
os.environ.setdefault("NVS_APP_SENHA", "senha_teste")
os.environ.setdefault("NVS_SEGREDO_SESSAO", "segredo-de-teste")
os.environ.setdefault("NVS_CHAVES_TOKEN", "1:" + base64.b64encode(b"k" * 32).decode())
os.environ.setdefault("NVS_ML_CLIENT_ID", "123")
os.environ.setdefault("NVS_ML_CLIENT_SECRET", "segredo-ml")
os.environ.setdefault("NVS_ML_REDIRECT_URI", "https://x.test/api/contas/ml/callback")
os.environ.setdefault("NVS_COOKIE_SEGURO", "0")

from app.main import app  # noqa: E402


@pytest.fixture
def cliente():
    with TestClient(app, headers={"x-requested-with": "nvs"}) as c:
        yield c
```

`backend/tests/test_saude.py`:
```python
def test_saude(cliente):
    r = cliente.get("/api/saude")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
```

`backend/tests/test_configuracao.py`:
```python
from app.nucleo.configuracao import Configuracao


def test_normaliza_url_do_railway_e_deriva_url_do_app():
    c = Configuracao(database_url="postgres://u:p@h/d", app_senha="s",
                     segredo_sessao="x", chaves_token="1:abc")
    assert c.database_url == "postgresql+psycopg://u:p@h/d"
    assert c.url_app == "postgresql+psycopg://nvs_app:s@h/d"
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -e ".[dev]" && pytest -q`
Expected: FAIL com `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 4: Implementar**

`backend/app/__init__.py`, `backend/app/nucleo/__init__.py`, `backend/app/modulos/__init__.py`, `backend/app/modulos/saude/__init__.py`: arquivos vazios.

`backend/app/nucleo/configuracao.py`:
```python
import re
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Configuracao(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NVS_", env_file=".env", extra="ignore")

    database_url: str
    app_senha: str
    segredo_sessao: str
    chaves_token: str
    ml_client_id: str = ""
    ml_client_secret: str = ""
    ml_redirect_uri: str = ""
    cookie_seguro: bool = True
    frontend_url: str = "/"

    @field_validator("database_url")
    @classmethod
    def _driver(cls, v: str) -> str:
        return re.sub(r"^postgres(ql)?://", "postgresql+psycopg://", v)

    @property
    def url_app(self) -> str:
        url = make_url(self.database_url).set(username="nvs_app", password=self.app_senha)
        return url.render_as_string(hide_password=False)


@lru_cache
def configuracao() -> Configuracao:
    return Configuracao()
```

`backend/app/modulos/saude/saude_rotas.py`:
```python
from fastapi import APIRouter

router = APIRouter(prefix="/api")


@router.get("/saude")
def saude() -> dict[str, bool]:
    return {"ok": True}
```

`backend/app/main.py`:
```python
from fastapi import FastAPI

from app.modulos.saude import saude_rotas


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(saude_rotas.router)
    return app


app = criar_app()
```

- [ ] **Step 5: Rodar e ver passar; commit**

Run: `pytest -q` — Expected: `2 passed`
```bash
git add -A && git commit -m "feat(base): esqueleto, configuração e rota de saúde"
```

---

### Task 2: Peças de segurança puras (senha, cifra, sessão, limite)

**Files:**
- Create: `backend/app/nucleo/senhas.py`, `cifra.py`, `sessao.py`, `limitador.py`
- Test: `backend/tests/test_nucleo_seguranca.py`

**Interfaces:**
- Produces: `senhas.gerar(s: str) -> str`, `senhas.conferir(hash: str, s: str) -> bool`; `cifra.cifrar(texto: str, contexto: str) -> tuple[bytes, int]`, `cifra.decifrar(dado: bytes, versao: int, contexto: str) -> str`; `sessao.COOKIE: str`, `sessao.emitir(usuario_id: str) -> str`, `sessao.ler(token: str | None) -> str | None`; `limitador.permitido(chave: str) -> bool`, `limitador.limpar(chave: str) -> None`.

- [ ] **Step 1: Escrever o teste que falha**

`backend/tests/test_nucleo_seguranca.py`:
```python
import pytest

from app.nucleo import limitador
from app.nucleo.cifra import cifrar, decifrar
from app.nucleo.senhas import conferir, gerar
from app.nucleo.sessao import emitir, ler


def test_senha_confere_so_a_correta():
    h = gerar("correta-123456")
    assert h.startswith("$argon2")
    assert conferir(h, "correta-123456")
    assert not conferir(h, "errada")


def test_cifra_ida_e_volta_sem_texto_aberto():
    dado, versao = cifrar("segredo", "conta-1")
    assert b"segredo" not in dado
    assert decifrar(dado, versao, "conta-1") == "segredo"


def test_cifra_presa_ao_contexto():
    dado, versao = cifrar("s", "conta-a")
    with pytest.raises(Exception):  # noqa: B017 — InvalidTag
        decifrar(dado, versao, "conta-b")


def test_sessao_assinada():
    token = emitir("u1")
    assert ler(token) == "u1"
    assert ler(token + "x") is None
    assert ler(None) is None


def test_limitador_bloqueia_na_sexta_e_libera_ao_limpar():
    limitador._tentativas.clear()
    assert all(limitador.permitido("k") for _ in range(5))
    assert not limitador.permitido("k")
    limitador.limpar("k")
    assert limitador.permitido("k")
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pytest tests/test_nucleo_seguranca.py -q` — Expected: FAIL `ImportError` (módulos não existem)

- [ ] **Step 3: Implementar**

`backend/app/nucleo/senhas.py`:
```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_ph = PasswordHasher()


def gerar(senha: str) -> str:
    return _ph.hash(senha)


def conferir(hash_: str, senha: str) -> bool:
    try:
        return _ph.verify(hash_, senha)
    except VerifyMismatchError:
        return False
```

`backend/app/nucleo/cifra.py`:
```python
import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.nucleo.configuracao import configuracao


def _chaves() -> dict[int, bytes]:
    pares = (p.split(":", 1) for p in configuracao().chaves_token.split(","))
    return {int(v): base64.b64decode(k) for v, k in pares}


def cifrar(texto: str, contexto: str) -> tuple[bytes, int]:
    chaves = _chaves()
    versao = max(chaves)
    nonce = os.urandom(12)
    dado = AESGCM(chaves[versao]).encrypt(nonce, texto.encode(), contexto.encode())
    return nonce + dado, versao


def decifrar(dado: bytes, versao: int, contexto: str) -> str:
    dado = bytes(dado)
    return AESGCM(_chaves()[versao]).decrypt(dado[:12], dado[12:], contexto.encode()).decode()
```

`backend/app/nucleo/sessao.py`:
```python
from itsdangerous import BadSignature, URLSafeTimedSerializer

from app.nucleo.configuracao import configuracao

COOKIE = "nvs_sessao"
IDADE_SEGUNDOS = 12 * 3600


def _serializador() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(configuracao().segredo_sessao, salt="nvs.sessao")


def emitir(usuario_id: str) -> str:
    return _serializador().dumps({"u": usuario_id})


def ler(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _serializador().loads(token, max_age=IDADE_SEGUNDOS)["u"]
    except BadSignature:
        return None
```

`backend/app/nucleo/limitador.py`:
```python
import time
from collections import defaultdict, deque

# ponytail: em memória, vale por processo; com mais de uma réplica trocar por Redis.
_tentativas: dict[str, deque[float]] = defaultdict(deque)


def permitido(chave: str, maximo: int = 5, janela: float = 900) -> bool:
    agora = time.monotonic()
    fila = _tentativas[chave]
    while fila and agora - fila[0] > janela:
        fila.popleft()
    if len(fila) >= maximo:
        return False
    fila.append(agora)
    return True


def limpar(chave: str) -> None:
    _tentativas.pop(chave, None)
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pytest tests/test_nucleo_seguranca.py -q` — Expected: `5 passed`

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(nucleo): senha argon2, cifra AES-GCM, sessão assinada e limitador"
```

---

### Task 3: Banco — migração, papéis e Row Level Security

**Files:**
- Create: `banco/alembic.ini`, `banco/migracoes/env.py`, `banco/migracoes/versions/0001_fundacao.py`
- Create: `backend/app/nucleo/banco.py`
- Modify (substituir inteiro): `backend/tests/conftest.py`
- Test: `backend/tests/test_banco_rls.py`

**Interfaces:**
- Consumes: `configuracao().database_url`, `.url_app`, `.app_senha` (Task 1).
- Produces: `banco.motor() -> Engine` (papel `nvs_app`); `banco.transacao(empresa_id: str | None = None)` — gerenciador de contexto que devolve `Connection` dentro de transação; `banco.definir_empresa(conn, empresa_id: str) -> None`. Fixtures `dono` (Engine do dono do esquema) e `cliente`. Tabelas: `usuarios, empresas, membros, contas_marketplace, credenciais_conta, oauth_estados, escrita_modulos, auditoria, notificacoes_recebidas`.

- [ ] **Step 1: Subir o Postgres de teste**

Run: `docker compose -f infra/docker-compose.yml up -d`
Expected: container `postgres` rodando na porta 5433.

- [ ] **Step 2: Substituir o conftest e escrever o teste que falha**

`backend/tests/conftest.py` (arquivo completo):
```python
import base64
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("NVS_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5433/nvs_test")
os.environ.setdefault("NVS_APP_SENHA", "senha_teste")
os.environ.setdefault("NVS_SEGREDO_SESSAO", "segredo-de-teste")
os.environ.setdefault("NVS_CHAVES_TOKEN", "1:" + base64.b64encode(b"k" * 32).decode())
os.environ.setdefault("NVS_ML_CLIENT_ID", "123")
os.environ.setdefault("NVS_ML_CLIENT_SECRET", "segredo-ml")
os.environ.setdefault("NVS_ML_REDIRECT_URI", "https://x.test/api/contas/ml/callback")
os.environ.setdefault("NVS_COOKIE_SEGURO", "0")

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from app.main import app  # noqa: E402
from app.nucleo import limitador  # noqa: E402
from app.nucleo.configuracao import configuracao  # noqa: E402

RAIZ = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def dono():
    motor = create_engine(configuracao().database_url)
    with motor.connect().execution_options(isolation_level="AUTOCOMMIT") as c:
        c.execute(text("drop schema public cascade"))
        c.execute(text("create schema public"))
    command.upgrade(Config(str(RAIZ / "banco" / "alembic.ini")), "head")
    yield motor


@pytest.fixture(autouse=True)
def limpo(dono):
    with dono.begin() as c:
        c.execute(text(
            "truncate usuarios, empresas, oauth_estados, auditoria, notificacoes_recebidas "
            "restart identity cascade"))
    limitador._tentativas.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def cliente():
    with TestClient(app, headers={"x-requested-with": "nvs"}) as c:
        yield c
```

`backend/tests/test_banco_rls.py`:
```python
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, ProgrammingError

from app.nucleo.banco import transacao


@pytest.fixture
def duas_empresas(dono):
    a, b = str(uuid4()), str(uuid4())
    with dono.begin() as c:
        c.execute(text("insert into empresas(id, nome) values (:a, 'A'), (:b, 'B')"), {"a": a, "b": b})
        c.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) values "
            "(:a, 'ml', '1', 'a'), (:b, 'ml', '2', 'b')"), {"a": a, "b": b})
    return a, b


def test_empresa_so_ve_as_proprias_contas(duas_empresas):
    a, _ = duas_empresas
    with transacao(a) as c:
        ids = c.execute(text("select id_externo from contas_marketplace")).scalars().all()
    assert ids == ["1"]


def test_sem_empresa_definida_nao_ve_nada(duas_empresas):
    with transacao() as c:
        assert c.execute(text("select count(*) from contas_marketplace")).scalar_one() == 0


def test_nao_grava_conta_em_outra_empresa(duas_empresas):
    a, b = duas_empresas
    with pytest.raises(ProgrammingError), transacao(a) as c:
        c.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) "
            "values (cast(:b as uuid), 'ml', '9', 'x')"), {"b": b})


def test_mesma_conta_externa_nao_vai_para_duas_empresas(duas_empresas, dono):
    a, _ = duas_empresas
    with pytest.raises(IntegrityError), dono.begin() as c:
        c.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) "
            "values (cast(:a as uuid), 'ml', '2', 'dup')"), {"a": a})


def test_auditoria_so_aceita_insercao(duas_empresas):
    a, _ = duas_empresas
    with transacao(a) as c:
        c.execute(text("insert into auditoria(empresa_id, acao) values (cast(:a as uuid), 'x')"), {"a": a})
    with pytest.raises(ProgrammingError), transacao(a) as c:
        c.execute(text("delete from auditoria"))
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pytest tests/test_banco_rls.py -q`
Expected: FAIL (alembic.ini inexistente / `app.nucleo.banco` inexistente)

- [ ] **Step 4: Implementar**

`banco/alembic.ini`:
```ini
[alembic]
script_location = %(here)s/migracoes
```

`banco/migracoes/env.py`:
```python
from alembic import context
from sqlalchemy import create_engine

from app.nucleo.configuracao import configuracao

with create_engine(configuracao().database_url).connect() as conexao:
    context.configure(connection=conexao, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()
    conexao.commit()
```

`banco/migracoes/versions/0001_fundacao.py`:
```python
"""fundação: identidade, contas, credenciais, auditoria, RLS"""
import sqlalchemy as sa
from alembic import op

from app.nucleo.configuracao import configuracao

revision = "0001"
down_revision = None

ESTRUTURA = [
    "create extension if not exists citext",
    """create table usuarios (
        id uuid primary key default gen_random_uuid(),
        email citext not null unique,
        senha_hash text not null,
        dois_fatores boolean not null default false,
        criado_em timestamptz not null default now(),
        atualizado_em timestamptz not null default now())""",
    """create table empresas (
        id uuid primary key default gen_random_uuid(),
        nome text not null,
        cnpj text,
        criado_em timestamptz not null default now(),
        atualizado_em timestamptz not null default now())""",
    """create table membros (
        usuario_id uuid not null references usuarios on delete cascade,
        empresa_id uuid not null references empresas on delete cascade,
        papel text not null check (papel in ('dono','admin','operador','leitura')),
        criado_em timestamptz not null default now(),
        primary key (usuario_id, empresa_id))""",
    """create table contas_marketplace (
        id uuid primary key default gen_random_uuid(),
        empresa_id uuid not null references empresas on delete cascade,
        marketplace text not null check (marketplace in ('ml','shopee')),
        id_externo text not null,
        apelido text not null,
        imposto_percentual numeric(5,2) not null default 0,
        status text not null default 'ativa' check (status in ('ativa','reautorizar','desligada')),
        criado_em timestamptz not null default now(),
        atualizado_em timestamptz not null default now(),
        unique (marketplace, id_externo))""",
    """create table credenciais_conta (
        conta_id uuid primary key references contas_marketplace on delete cascade,
        empresa_id uuid not null,
        access_token_cifrado bytea not null,
        refresh_token_cifrado bytea not null,
        expira_em timestamptz not null,
        escopos text not null default '',
        versao_chave int not null,
        atualizado_em timestamptz not null default now())""",
    """create table escrita_modulos (
        conta_id uuid not null references contas_marketplace on delete cascade,
        empresa_id uuid not null,
        modulo text not null,
        habilitada boolean not null default false,
        primary key (conta_id, modulo))""",
    """create table oauth_estados (
        state_hash text primary key,
        empresa_id uuid not null,
        usuario_id uuid not null,
        marketplace text not null,
        expira_em timestamptz not null,
        usado_em timestamptz)""",
    """create table auditoria (
        id bigserial primary key,
        empresa_id uuid,
        usuario_id uuid,
        acao text not null,
        entidade text,
        entidade_id text,
        detalhes jsonb not null default '{}',
        ip text,
        criado_em timestamptz not null default now())""",
    """create table notificacoes_recebidas (
        id bigserial primary key,
        marketplace text not null,
        user_id_externo text not null,
        topico text not null,
        recurso text not null,
        hash text not null,
        recebido_em timestamptz not null default now(),
        processado_em timestamptz)""",
    "create unique index notificacoes_pendentes_hash on notificacoes_recebidas (hash) "
    "where processado_em is null",
]

CONTEXTO = "nullif(current_setting('app.empresa_id', true), '')::uuid"
COM_RLS = ["contas_marketplace", "credenciais_conta", "escrita_modulos"]


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("select set_config('nvs.senha', :s, false)"), {"s": configuracao().app_senha})
    conn.execute(sa.text(
        "do $$ begin if not exists (select from pg_roles where rolname = 'nvs_app') then "
        "execute format('create role nvs_app login password %L', current_setting('nvs.senha')); "
        "end if; end $$"))
    for sql in ESTRUTURA:
        conn.execute(sa.text(sql))
    for t in COM_RLS:
        conn.execute(sa.text(f"alter table {t} enable row level security"))
        conn.execute(sa.text(f"alter table {t} force row level security"))
        conn.execute(sa.text(f"create policy isolamento on {t} using (empresa_id = {CONTEXTO})"))
    conn.execute(sa.text("alter table auditoria enable row level security"))
    conn.execute(sa.text("alter table auditoria force row level security"))
    conn.execute(sa.text(f"create policy le_propria on auditoria for select using (empresa_id = {CONTEXTO})"))
    conn.execute(sa.text(
        f"create policy grava on auditoria for insert with check (empresa_id is null or empresa_id = {CONTEXTO})"))
    conn.execute(sa.text("grant usage on schema public to nvs_app"))
    conn.execute(sa.text("grant select, insert, update, delete on all tables in schema public to nvs_app"))
    conn.execute(sa.text("grant usage on all sequences in schema public to nvs_app"))
    conn.execute(sa.text("revoke update, delete on auditoria from nvs_app"))


def downgrade() -> None:
    raise NotImplementedError("fundação não tem volta; recrie o banco")
```

`backend/app/nucleo/banco.py`:
```python
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Connection, Engine, create_engine, text

from app.nucleo.configuracao import configuracao


@lru_cache
def motor() -> Engine:
    return create_engine(configuracao().url_app, pool_size=5, max_overflow=5, pool_pre_ping=True)


def definir_empresa(conn: Connection, empresa_id: str) -> None:
    conn.execute(text("select set_config('app.empresa_id', :v, true)"), {"v": empresa_id})


@contextmanager
def transacao(empresa_id: str | None = None) -> Iterator[Connection]:
    with motor().begin() as conn:
        if empresa_id:
            definir_empresa(conn, empresa_id)
        yield conn
```

- [ ] **Step 5: Rodar e ver passar; commit**

Run: `pytest tests/test_banco_rls.py -q` — Expected: `5 passed`
```bash
git add -A && git commit -m "feat(banco): migração da fundação com papéis e RLS"
```

---

### Task 4: Auditoria, dependências e autenticação (cadastro, login, /eu)

**Files:**
- Create: `backend/app/nucleo/auditoria.py`, `backend/app/nucleo/dependencias.py`
- Create: `backend/app/modulos/autenticacao/__init__.py`, `autenticacao_esquemas.py`, `autenticacao_servico.py`, `autenticacao_rotas.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_autenticacao.py`

**Interfaces:**
- Consumes: `banco.transacao`, `banco.definir_empresa` (Task 3); `senhas.gerar/conferir`, `sessao.COOKIE/emitir/ler`, `limitador.permitido/limpar` (Task 2).
- Produces: `auditoria.registrar(conn, acao: str, usuario_id: str | None = None, empresa_id: str | None = None, entidade: str | None = None, entidade_id: str | None = None, detalhes: dict | None = None, ip: str | None = None) -> None`; `dependencias.usuario_atual(request) -> str`, `dependencias.empresa_atual(request, usuario_id) -> str` (lê cabeçalho `x-empresa`, confere em `membros`, 403 se não for membro), `dependencias.conexao(empresa_id) -> Iterator[Connection]`; rotas `POST /api/auth/cadastro` (201 → `{usuario_id, empresa_id}`), `POST /api/auth/entrar`, `GET /api/auth/eu`.

- [ ] **Step 1: Escrever o teste que falha**

`backend/tests/test_autenticacao.py`:
```python
from sqlalchemy import text

CADASTRO = {"email": "a@x.com", "senha": "senha-longa-123", "nome_empresa": "Loja A"}


def test_cadastro_cria_sessao_empresa_e_auditoria(cliente, dono):
    r = cliente.post("/api/auth/cadastro", json=CADASTRO)
    assert r.status_code == 201
    eu = cliente.get("/api/auth/eu").json()
    assert eu["email"] == "a@x.com"
    assert eu["empresas"][0]["papel"] == "dono"
    with dono.connect() as c:
        assert c.execute(text("select count(*) from auditoria where acao = 'cadastro'")).scalar_one() == 1


def test_email_duplicado_da_409(cliente):
    cliente.post("/api/auth/cadastro", json=CADASTRO)
    assert cliente.post("/api/auth/cadastro", json=CADASTRO).status_code == 409


def test_senha_curta_da_422(cliente):
    r = cliente.post("/api/auth/cadastro", json=CADASTRO | {"senha": "curta"})
    assert r.status_code == 422


def test_login_certo_e_errado(cliente):
    cliente.post("/api/auth/cadastro", json=CADASTRO)
    cliente.cookies.clear()
    errado = {"email": "a@x.com", "senha": "errada-errada-1"}
    assert cliente.post("/api/auth/entrar", json=errado).status_code == 401
    certo = {"email": "a@x.com", "senha": CADASTRO["senha"]}
    assert cliente.post("/api/auth/entrar", json=certo).status_code == 200
    assert cliente.get("/api/auth/eu").status_code == 200


def test_bloqueia_na_sexta_tentativa_errada(cliente):
    cliente.post("/api/auth/cadastro", json=CADASTRO)
    errado = {"email": "a@x.com", "senha": "errada-errada-1"}
    codigos = [cliente.post("/api/auth/entrar", json=errado).status_code for _ in range(6)]
    assert codigos == [401, 401, 401, 401, 401, 429]


def test_eu_sem_sessao_da_401(cliente):
    assert cliente.get("/api/auth/eu").status_code == 401
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pytest tests/test_autenticacao.py -q` — Expected: FAIL (404 nas rotas / import)

- [ ] **Step 3: Implementar**

`backend/app/nucleo/auditoria.py`:
```python
import json

from sqlalchemy import Connection, text


def registrar(conn: Connection, acao: str, usuario_id: str | None = None,
              empresa_id: str | None = None, entidade: str | None = None,
              entidade_id: str | None = None, detalhes: dict | None = None,
              ip: str | None = None) -> None:
    conn.execute(text(
        "insert into auditoria(empresa_id, usuario_id, acao, entidade, entidade_id, detalhes, ip) "
        "values (cast(:e as uuid), cast(:u as uuid), :a, :en, :ei, cast(:d as jsonb), :ip)"),
        {"e": empresa_id, "u": usuario_id, "a": acao, "en": entidade, "ei": entidade_id,
         "d": json.dumps(detalhes or {}), "ip": ip})
```

`backend/app/nucleo/dependencias.py`:
```python
from collections.abc import Iterator
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from sqlalchemy import Connection, text

from app.nucleo.banco import transacao
from app.nucleo.sessao import COOKIE, ler


def usuario_atual(request: Request) -> str:
    usuario_id = ler(request.cookies.get(COOKIE))
    if usuario_id is None:
        raise HTTPException(401, "nao autenticado")
    return usuario_id


def empresa_atual(request: Request, usuario_id: str = Depends(usuario_atual)) -> str:
    try:
        empresa_id = str(UUID(request.headers.get("x-empresa", "")))
    except ValueError:
        raise HTTPException(400, "empresa invalida") from None
    with transacao() as conn:
        membro = conn.execute(text(
            "select 1 from membros where usuario_id = cast(:u as uuid) and empresa_id = cast(:e as uuid)"),
            {"u": usuario_id, "e": empresa_id}).first()
    if membro is None:
        raise HTTPException(403, "sem acesso a empresa")
    return empresa_id


def conexao(empresa_id: str = Depends(empresa_atual)) -> Iterator[Connection]:
    with transacao(empresa_id) as conn:
        yield conn
```

`backend/app/modulos/autenticacao/__init__.py`: vazio.

`backend/app/modulos/autenticacao/autenticacao_esquemas.py`:
```python
from pydantic import BaseModel, EmailStr, Field


class Cadastro(BaseModel):
    email: EmailStr
    senha: str = Field(min_length=10, max_length=128)
    nome_empresa: str = Field(min_length=2, max_length=120)


class Entrada(BaseModel):
    email: EmailStr
    senha: str = Field(max_length=128)
```

`backend/app/modulos/autenticacao/autenticacao_servico.py`:
```python
from sqlalchemy import Connection, text

from app.nucleo import senhas

_HASH_FALSO = senhas.gerar("hash-para-igualar-o-tempo")


def cadastrar(conn: Connection, email: str, senha: str, nome_empresa: str) -> tuple[str, str]:
    usuario_id = str(conn.execute(text(
        "insert into usuarios(email, senha_hash) values (:e, :h) returning id"),
        {"e": email, "h": senhas.gerar(senha)}).scalar_one())
    empresa_id = str(conn.execute(text(
        "insert into empresas(nome) values (:n) returning id"), {"n": nome_empresa}).scalar_one())
    conn.execute(text(
        "insert into membros(usuario_id, empresa_id, papel) "
        "values (cast(:u as uuid), cast(:e as uuid), 'dono')"), {"u": usuario_id, "e": empresa_id})
    return usuario_id, empresa_id


def autenticar(conn: Connection, email: str, senha: str) -> str | None:
    linha = conn.execute(text("select id, senha_hash from usuarios where email = :e"), {"e": email}).first()
    if linha is None:
        senhas.conferir(_HASH_FALSO, senha)
        return None
    return str(linha.id) if senhas.conferir(linha.senha_hash, senha) else None


def perfil(conn: Connection, usuario_id: str) -> dict:
    email = conn.execute(text("select email from usuarios where id = cast(:u as uuid)"),
                         {"u": usuario_id}).scalar_one()
    empresas = conn.execute(text(
        "select e.id::text as id, e.nome, m.papel from membros m join empresas e on e.id = m.empresa_id "
        "where m.usuario_id = cast(:u as uuid) order by e.nome"), {"u": usuario_id}).mappings().all()
    return {"email": email, "empresas": [dict(e) for e in empresas]}
```

`backend/app/modulos/autenticacao/autenticacao_rotas.py`:
```python
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError

from app.modulos.autenticacao import autenticacao_servico as servico
from app.modulos.autenticacao.autenticacao_esquemas import Cadastro, Entrada
from app.nucleo import limitador, sessao
from app.nucleo.auditoria import registrar
from app.nucleo.banco import definir_empresa, transacao
from app.nucleo.configuracao import configuracao
from app.nucleo.dependencias import usuario_atual

router = APIRouter(prefix="/api/auth")


def _definir_cookie(resp: Response, usuario_id: str) -> None:
    resp.set_cookie(sessao.COOKIE, sessao.emitir(usuario_id), max_age=sessao.IDADE_SEGUNDOS,
                    httponly=True, samesite="lax", secure=configuracao().cookie_seguro)


@router.post("/cadastro", status_code=201)
def cadastro(dados: Cadastro, resp: Response, request: Request) -> dict:
    ip = request.client.host if request.client else None
    try:
        with transacao() as conn:
            usuario_id, empresa_id = servico.cadastrar(conn, dados.email, dados.senha, dados.nome_empresa)
            definir_empresa(conn, empresa_id)
            registrar(conn, "cadastro", usuario_id, empresa_id, "empresa", empresa_id, ip=ip)
    except IntegrityError:
        raise HTTPException(409, "e-mail ja cadastrado") from None
    _definir_cookie(resp, usuario_id)
    return {"usuario_id": usuario_id, "empresa_id": empresa_id}


@router.post("/entrar")
def entrar(dados: Entrada, resp: Response, request: Request) -> dict:
    ip = request.client.host if request.client else "?"
    chave = f"{ip}:{dados.email.lower()}"
    if not limitador.permitido(chave):
        raise HTTPException(429, "muitas tentativas")
    with transacao() as conn:
        usuario_id = servico.autenticar(conn, dados.email, dados.senha)
        if usuario_id:
            registrar(conn, "login", usuario_id, ip=ip)
    if usuario_id is None:
        raise HTTPException(401, "credenciais invalidas")
    limitador.limpar(chave)
    _definir_cookie(resp, usuario_id)
    return {"usuario_id": usuario_id}


@router.get("/eu")
def eu(usuario_id: str = Depends(usuario_atual)) -> dict:
    with transacao() as conn:
        return servico.perfil(conn, usuario_id)
```

`backend/app/main.py` (substituir):
```python
from fastapi import FastAPI

from app.modulos.autenticacao import autenticacao_rotas
from app.modulos.saude import saude_rotas


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    for modulo in (saude_rotas, autenticacao_rotas):
        app.include_router(modulo.router)
    return app


app = criar_app()
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pytest tests/test_autenticacao.py -q` — Expected: `6 passed`

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(autenticacao): cadastro, login, perfil e auditoria"
```

---

### Task 5: Padrão-negado, CSRF e cabeçalhos de segurança

**Files:**
- Create: `backend/app/nucleo/seguranca_http.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_seguranca_http.py`

**Interfaces:**
- Consumes: `sessao.COOKIE`, `sessao.ler` (Task 2).
- Produces: `seguranca_http.PUBLICAS: set[str]` (`/api/saude`, `/api/auth/cadastro`, `/api/auth/entrar`, `/api/ml/notificacoes`) e `SegurancaHttp` (middleware). Regra: método de escrita sem `x-requested-with: nvs` → 403 (exceto o webhook); rota `/api/*` fora de `PUBLICAS` sem sessão válida → 401.

- [ ] **Step 1: Escrever o teste que falha**

`backend/tests/test_seguranca_http.py`:
```python
import re
from pathlib import Path

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.main import app
from app.nucleo.seguranca_http import PUBLICAS


def test_escrita_sem_cabecalho_anti_csrf_da_403():
    with TestClient(app) as c:
        r = c.post("/api/auth/entrar", json={"email": "a@x.com", "senha": "x"})
    assert r.status_code == 403


def test_toda_rota_exige_sessao_exceto_as_publicas(cliente):
    for rota in app.routes:
        if isinstance(rota, APIRoute) and rota.path not in PUBLICAS:
            for metodo in rota.methods:
                r = cliente.request(metodo, rota.path)
                assert r.status_code == 401, f"{metodo} {rota.path} nao exige sessao"


def test_cabecalhos_de_seguranca(cliente):
    r = cliente.get("/api/saude")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "max-age" in r.headers["strict-transport-security"]


def test_trilhas_nao_importam_outras_trilhas():
    base = Path(__file__).resolve().parents[1] / "app" / "modulos"
    for trilha in (p for p in base.iterdir() if p.is_dir() and p.name != "__pycache__"):
        for arquivo in trilha.rglob("*.py"):
            for outra in re.findall(r"app\.modulos\.(\w+)", arquivo.read_text(encoding="utf-8")):
                assert outra == trilha.name, f"{arquivo.name} importa a trilha {outra}"
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pytest tests/test_seguranca_http.py -q`
Expected: FAIL (`app.nucleo.seguranca_http` inexistente)

- [ ] **Step 3: Implementar**

`backend/app/nucleo/seguranca_http.py`:
```python
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.nucleo.sessao import COOKIE, ler

PUBLICAS = {"/api/saude", "/api/auth/cadastro", "/api/auth/entrar", "/api/ml/notificacoes"}
ESCRITA = {"POST", "PUT", "PATCH", "DELETE"}
CABECALHOS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}


class SegurancaHttp(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        caminho = request.url.path
        # o webhook do ML vem de fora do navegador e não carrega o cabeçalho
        if (request.method in ESCRITA and caminho != "/api/ml/notificacoes"
                and request.headers.get("x-requested-with") != "nvs"):
            return JSONResponse({"detail": "csrf"}, status_code=403)
        if (caminho.startswith("/api/") and caminho not in PUBLICAS
                and ler(request.cookies.get(COOKIE)) is None):
            return JSONResponse({"detail": "nao autenticado"}, status_code=401)
        resposta = await call_next(request)
        resposta.headers.update(CABECALHOS)
        return resposta
```

`backend/app/main.py` (substituir):
```python
from fastapi import FastAPI

from app.modulos.autenticacao import autenticacao_rotas
from app.modulos.saude import saude_rotas
from app.nucleo.seguranca_http import SegurancaHttp


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SegurancaHttp)
    for modulo in (saude_rotas, autenticacao_rotas):
        app.include_router(modulo.router)
    return app


app = criar_app()
```

- [ ] **Step 4: Rodar tudo e ver passar**

Run: `pytest -q` — Expected: todos passam (os testes da Task 4 continuam verdes: o cliente já manda o cabeçalho e o cookie).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(seguranca): padrão-negado, anti-CSRF e cabeçalhos"
```

---

### Task 6: Cliente do Mercado Livre e renovação de token com trava

**Files:**
- Create: `backend/app/integracoes/__init__.py`, `backend/app/integracoes/mercado_livre/__init__.py`, `ml_cliente.py`
- Create: `backend/app/modulos/contas/__init__.py`, `backend/app/modulos/contas/contas_tokens.py`
- Create: `backend/tests/auxiliares.py`
- Test: `backend/tests/test_ml_cliente.py`, `backend/tests/test_contas_tokens.py`

**Interfaces:**
- Consumes: `cifra.cifrar/decifrar` (Task 2), `banco.transacao` (Task 3), `configuracao()` (Task 1).
- Produces: `ml_cliente.url_autorizacao(state: str) -> str`; `ml_cliente.trocar_codigo(http: httpx.Client, code: str) -> dict`; `ml_cliente.renovar(http, refresh_token: str) -> dict` (levanta `RefreshInvalido` em `400 invalid_grant`); `ml_cliente.perfil(http, access_token: str) -> dict`; `ml_cliente.cliente_http() -> Iterator[httpx.Client]` (dependência FastAPI); `contas_tokens.salvar_credenciais(conn, conta_id: str, empresa_id: str, t: dict) -> None`; `contas_tokens.token_valido(conta_id: str, empresa_id: str, http) -> str`; `contas_tokens.ContaPrecisaReautorizar` (exceção). Em `tests/auxiliares.py`: `cliente_ml_falso(chamadas: list | None = None) -> httpx.Client` e `semear_conta(dono, expira_sql: str) -> tuple[str, str]` (devolve `(empresa_id, conta_id)`).

- [ ] **Step 1: Escrever os testes que falham**

`backend/tests/auxiliares.py`:
```python
from uuid import uuid4

import httpx
from sqlalchemy import text

from app.nucleo.cifra import cifrar


def cliente_ml_falso(chamadas: list | None = None) -> httpx.Client:
    def tratar(req: httpx.Request) -> httpx.Response:
        if chamadas is not None:
            chamadas.append(req.url.path)
        if req.url.path == "/oauth/token":
            return httpx.Response(200, json={
                "access_token": "tok-acesso", "refresh_token": "tok-refresh",
                "expires_in": 21600, "user_id": 42, "scope": "read write"})
        if req.url.path == "/users/me":
            return httpx.Response(200, json={"id": 42, "nickname": "LOJA42"})
        return httpx.Response(404)
    return httpx.Client(transport=httpx.MockTransport(tratar))


def semear_conta(dono, expira_sql: str) -> tuple[str, str]:
    empresa_id, conta_id = str(uuid4()), str(uuid4())
    acesso, versao = cifrar("acesso-velho", conta_id)
    refresh, _ = cifrar("refresh-velho", conta_id)
    with dono.begin() as c:
        c.execute(text("insert into empresas(id, nome) values (:e, 'E')"), {"e": empresa_id})
        c.execute(text(
            "insert into contas_marketplace(id, empresa_id, marketplace, id_externo, apelido) "
            "values (:c, :e, 'ml', '42', 'x')"), {"c": conta_id, "e": empresa_id})
        c.execute(text(
            "insert into credenciais_conta(conta_id, empresa_id, access_token_cifrado, "
            "refresh_token_cifrado, expira_em, versao_chave) "
            f"values (:c, :e, :a, :r, {expira_sql}, :v)"),
            {"c": conta_id, "e": empresa_id, "a": acesso, "r": refresh, "v": versao})
    return empresa_id, conta_id
```

`backend/tests/test_ml_cliente.py`:
```python
import httpx
import pytest

from app.integracoes.mercado_livre import ml_cliente as ml


def _cliente(resposta: httpx.Response) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda req: resposta))


def test_url_de_autorizacao_leva_state_e_client_id():
    url = ml.url_autorizacao("abc")
    assert url.startswith("https://auth.mercadolivre.com.br/authorization?")
    assert "state=abc" in url and "client_id=123" in url


def test_trocar_codigo_devolve_tokens():
    http = _cliente(httpx.Response(200, json={"access_token": "a", "refresh_token": "r", "user_id": 42}))
    assert ml.trocar_codigo(http, "cod")["user_id"] == 42


def test_refresh_invalido_so_em_invalid_grant():
    http = _cliente(httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(ml.RefreshInvalido):
        ml.renovar(http, "r")


def test_erro_transitorio_nao_vira_refresh_invalido():
    http = _cliente(httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        ml.renovar(http, "r")
```

`backend/tests/test_contas_tokens.py`:
```python
import pytest
from sqlalchemy import text

from app.integracoes.mercado_livre import ml_cliente as ml
from app.modulos.contas.contas_tokens import ContaPrecisaReautorizar, token_valido
from app.nucleo.cifra import decifrar
from tests.auxiliares import cliente_ml_falso, semear_conta


def test_token_vivo_nao_chama_o_ml(dono):
    empresa_id, conta_id = semear_conta(dono, "now() + interval '1 hour'")
    chamadas: list = []
    assert token_valido(conta_id, empresa_id, cliente_ml_falso(chamadas)) == "acesso-velho"
    assert chamadas == []


def test_token_expirado_renova_e_guarda_o_novo_refresh(dono):
    empresa_id, conta_id = semear_conta(dono, "now() - interval '1 minute'")
    assert token_valido(conta_id, empresa_id, cliente_ml_falso()) == "tok-acesso"
    with dono.connect() as c:
        linha = c.execute(text("select refresh_token_cifrado, versao_chave from credenciais_conta")).one()
    assert decifrar(linha[0], linha[1], conta_id) == "tok-refresh"


def test_invalid_grant_marca_conta_para_reautorizar(dono, monkeypatch):
    empresa_id, conta_id = semear_conta(dono, "now() - interval '1 minute'")

    def falha(http, refresh):
        raise ml.RefreshInvalido

    monkeypatch.setattr(ml, "renovar", falha)
    with pytest.raises(ContaPrecisaReautorizar):
        token_valido(conta_id, empresa_id, cliente_ml_falso())
    with dono.connect() as c:
        assert c.execute(text("select status from contas_marketplace")).scalar_one() == "reautorizar"
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pytest tests/test_ml_cliente.py tests/test_contas_tokens.py -q`
Expected: FAIL `ModuleNotFoundError: app.integracoes`

- [ ] **Step 3: Implementar**

`backend/app/integracoes/__init__.py` e `backend/app/integracoes/mercado_livre/__init__.py`: vazios. `backend/app/modulos/contas/__init__.py`: vazio.

`backend/app/integracoes/mercado_livre/ml_cliente.py`:
```python
from collections.abc import Iterator
from urllib.parse import urlencode

import httpx

from app.nucleo.configuracao import configuracao

API = "https://api.mercadolibre.com"


class RefreshInvalido(Exception):
    pass


def cliente_http() -> Iterator[httpx.Client]:
    with httpx.Client(timeout=10) as http:
        yield http


def url_autorizacao(state: str) -> str:
    c = configuracao()
    consulta = urlencode({"response_type": "code", "client_id": c.ml_client_id,
                          "redirect_uri": c.ml_redirect_uri, "state": state})
    return f"https://auth.mercadolivre.com.br/authorization?{consulta}"


def _token(http: httpx.Client, dados: dict) -> httpx.Response:
    c = configuracao()
    return http.post(f"{API}/oauth/token", headers={"accept": "application/json"},
                     data={"client_id": c.ml_client_id, "client_secret": c.ml_client_secret, **dados})


def trocar_codigo(http: httpx.Client, code: str) -> dict:
    r = _token(http, {"grant_type": "authorization_code", "code": code,
                      "redirect_uri": configuracao().ml_redirect_uri})
    r.raise_for_status()
    return r.json()


def renovar(http: httpx.Client, refresh_token: str) -> dict:
    r = _token(http, {"grant_type": "refresh_token", "refresh_token": refresh_token})
    if r.status_code == 400 and r.json().get("error") == "invalid_grant":
        raise RefreshInvalido
    r.raise_for_status()
    return r.json()


def perfil(http: httpx.Client, access_token: str) -> dict:
    r = http.get(f"{API}/users/me", headers={"Authorization": f"Bearer {access_token}"})
    r.raise_for_status()
    return r.json()
```

`backend/app/modulos/contas/contas_tokens.py`:
```python
import httpx
from sqlalchemy import Connection, text

from app.integracoes.mercado_livre import ml_cliente as ml
from app.nucleo.banco import transacao
from app.nucleo.cifra import cifrar, decifrar


class ContaPrecisaReautorizar(Exception):
    pass


def salvar_credenciais(conn: Connection, conta_id: str, empresa_id: str, t: dict) -> None:
    acesso, versao = cifrar(t["access_token"], conta_id)
    refresh, _ = cifrar(t["refresh_token"], conta_id)
    conn.execute(text(
        "insert into credenciais_conta(conta_id, empresa_id, access_token_cifrado, refresh_token_cifrado, "
        "expira_em, escopos, versao_chave) values (cast(:c as uuid), cast(:e as uuid), :a, :r, "
        "now() + :s * interval '1 second', :esc, :v) "
        "on conflict (conta_id) do update set access_token_cifrado = excluded.access_token_cifrado, "
        "refresh_token_cifrado = excluded.refresh_token_cifrado, expira_em = excluded.expira_em, "
        "escopos = excluded.escopos, versao_chave = excluded.versao_chave, atualizado_em = now()"),
        {"c": conta_id, "e": empresa_id, "a": acesso, "r": refresh,
         "s": int(t["expires_in"]), "esc": t.get("scope", ""), "v": versao})


def token_valido(conta_id: str, empresa_id: str, http: httpx.Client) -> str:
    reautorizar = False
    # a trava segura uma conexão durante a chamada ao ML; é por conta, então só serializa a mesma conta
    with transacao(empresa_id) as conn:
        conn.execute(text("select pg_advisory_xact_lock(hashtextextended(:c, 0))"), {"c": conta_id})
        r = conn.execute(text(
            "select access_token_cifrado, refresh_token_cifrado, versao_chave, "
            "expira_em > now() + interval '60 seconds' as vivo "
            "from credenciais_conta where conta_id = cast(:c as uuid)"), {"c": conta_id}).one()
        if r.vivo:
            return decifrar(r.access_token_cifrado, r.versao_chave, conta_id)
        try:
            novos = ml.renovar(http, decifrar(r.refresh_token_cifrado, r.versao_chave, conta_id))
        except ml.RefreshInvalido:
            conn.execute(text("update contas_marketplace set status = 'reautorizar' "
                              "where id = cast(:c as uuid)"), {"c": conta_id})
            reautorizar = True
        else:
            salvar_credenciais(conn, conta_id, empresa_id, novos)
            return novos["access_token"]
    if reautorizar:
        raise ContaPrecisaReautorizar(conta_id)
    raise AssertionError("inalcancavel")
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pytest tests/test_ml_cliente.py tests/test_contas_tokens.py -q` — Expected: `7 passed`

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(ml): cliente OAuth e renovação de token com trava por conta"
```

---

### Task 7: Contas — listar, conectar o ML por OAuth e travar escrita

**Files:**
- Create: `backend/app/modulos/contas/contas_servico.py`, `contas_rotas.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_contas.py`

**Interfaces:**
- Consumes: `dependencias.conexao/empresa_atual/usuario_atual` (Task 4), `contas_tokens.salvar_credenciais` e `ml_cliente.*` (Task 6), `banco.transacao`, `auditoria.registrar`.
- Produces: `GET /api/contas` (header `x-empresa`) → lista; `POST /api/contas/ml/iniciar` → `{url}`; `GET /api/contas/ml/callback?code&state` → 303 para `frontend_url`; `contas_servico.exigir_escrita(conn, conta_id: str, modulo: str) -> None` (levanta `HTTPException(403)` se não habilitada).

- [ ] **Step 1: Escrever o teste que falha**

`backend/tests/test_contas.py`:
```python
import re
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.integracoes.mercado_livre.ml_cliente import cliente_http
from app.main import app
from app.modulos.contas.contas_servico import exigir_escrita
from app.nucleo.banco import transacao
from tests.auxiliares import cliente_ml_falso, semear_conta

CADASTRO = {"email": "a@x.com", "senha": "senha-longa-123", "nome_empresa": "Loja A"}


def _logar(cliente, email="a@x.com") -> str:
    r = cliente.post("/api/auth/cadastro", json=CADASTRO | {"email": email})
    return r.json()["empresa_id"]


def _iniciar(cliente, empresa_id) -> str:
    url = cliente.post("/api/contas/ml/iniciar", headers={"x-empresa": empresa_id}).json()["url"]
    return re.search(r"state=([^&]+)", url).group(1)


@pytest.fixture(autouse=True)
def ml_falso():
    app.dependency_overrides[cliente_http] = cliente_ml_falso


def test_conectar_ml_cria_conta_e_cifra_o_token(cliente, dono):
    empresa_id = _logar(cliente)
    state = _iniciar(cliente, empresa_id)
    r = cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert r.status_code == 303
    contas = cliente.get("/api/contas", headers={"x-empresa": empresa_id}).json()
    assert [(c["marketplace"], c["id_externo"], c["apelido"]) for c in contas] == [("ml", "42", "LOJA42")]
    with dono.connect() as c:
        bruto = c.execute(text("select access_token_cifrado from credenciais_conta")).scalar_one()
        assert c.execute(text("select count(*) from auditoria where acao = 'conta_conectada'")).scalar_one() == 1
    assert b"tok-acesso" not in bytes(bruto)


def test_state_so_vale_uma_vez(cliente):
    empresa_id = _logar(cliente)
    state = _iniciar(cliente, empresa_id)
    cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    r = cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert r.status_code == 400


def test_state_de_outro_usuario_e_recusado(cliente):
    state = _iniciar(cliente, _logar(cliente))
    with TestClient(app, headers={"x-requested-with": "nvs"}) as outro:
        _logar(outro, "b@x.com")
        r = outro.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert r.status_code == 400


def test_conta_ml_nao_vai_para_segunda_empresa(cliente):
    state = _iniciar(cliente, (empresa_a := _logar(cliente)))
    cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert empresa_a
    with TestClient(app, headers={"x-requested-with": "nvs"}) as outro:
        empresa_b = _logar(outro, "b@x.com")
        r = outro.get(f"/api/contas/ml/callback?code=c&state={_iniciar(outro, empresa_b)}",
                      follow_redirects=False)
    assert r.status_code == 409


def test_empresa_de_outro_usuario_da_403(cliente):
    empresa_a = _logar(cliente)
    with TestClient(app, headers={"x-requested-with": "nvs"}) as outro:
        _logar(outro, "b@x.com")
        assert outro.get("/api/contas", headers={"x-empresa": empresa_a}).status_code == 403


def test_escrita_nasce_bloqueada_e_libera_por_modulo(dono):
    empresa_id, conta_id = semear_conta(dono, "now() + interval '1 hour'")
    with pytest.raises(HTTPException) as erro, transacao(empresa_id) as conn:
        exigir_escrita(conn, conta_id, "anuncios")
    assert erro.value.status_code == 403
    with dono.begin() as c:
        c.execute(text("insert into escrita_modulos(conta_id, empresa_id, modulo, habilitada) "
                       "values (:c, :e, 'anuncios', true)"), {"c": conta_id, "e": empresa_id})
    with transacao(empresa_id) as conn:
        exigir_escrita(conn, conta_id, "anuncios")
    assert uuid4()
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pytest tests/test_contas.py -q`
Expected: FAIL `ModuleNotFoundError: app.modulos.contas.contas_servico`

- [ ] **Step 3: Implementar**

`backend/app/modulos/contas/contas_servico.py`:
```python
import hashlib
import secrets

from fastapi import HTTPException
from sqlalchemy import Connection, text

from app.modulos.contas.contas_tokens import salvar_credenciais


def _hash(state: str) -> str:
    return hashlib.sha256(state.encode()).hexdigest()


def criar_estado(conn: Connection, empresa_id: str, usuario_id: str) -> str:
    state = secrets.token_urlsafe(32)
    conn.execute(text(
        "insert into oauth_estados(state_hash, empresa_id, usuario_id, marketplace, expira_em) "
        "values (:h, cast(:e as uuid), cast(:u as uuid), 'ml', now() + interval '10 minutes')"),
        {"h": _hash(state), "e": empresa_id, "u": usuario_id})
    return state


def consumir_estado(conn: Connection, state: str) -> tuple[str, str] | None:
    linha = conn.execute(text(
        "update oauth_estados set usado_em = now() where state_hash = :h and usado_em is null "
        "and expira_em > now() returning empresa_id::text, usuario_id::text"), {"h": _hash(state)}).first()
    return (linha[0], linha[1]) if linha else None


def salvar_conta_ml(conn: Connection, empresa_id: str, tokens: dict, apelido: str) -> str:
    externo = str(tokens["user_id"])
    existente = conn.execute(text(
        "select id::text from contas_marketplace where marketplace = 'ml' and id_externo = :x"),
        {"x": externo}).scalar()
    if existente:
        conn.execute(text("update contas_marketplace set status = 'ativa', apelido = :a, "
                          "atualizado_em = now() where id = cast(:i as uuid)"), {"a": apelido, "i": existente})
        conta_id = existente
    else:
        conta_id = conn.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) "
            "values (cast(:e as uuid), 'ml', :x, :a) returning id::text"),
            {"e": empresa_id, "x": externo, "a": apelido}).scalar_one()
    salvar_credenciais(conn, conta_id, empresa_id, tokens)
    return conta_id


def listar(conn: Connection) -> list[dict]:
    linhas = conn.execute(text(
        "select id::text as id, marketplace, id_externo, apelido, imposto_percentual::float8 as "
        "imposto_percentual, status from contas_marketplace order by criado_em")).mappings().all()
    return [dict(linha) for linha in linhas]


def exigir_escrita(conn: Connection, conta_id: str, modulo: str) -> None:
    liberada = conn.execute(text(
        "select habilitada from escrita_modulos where conta_id = cast(:c as uuid) and modulo = :m"),
        {"c": conta_id, "m": modulo}).scalar()
    if not liberada:
        raise HTTPException(403, "escrita desligada para este modulo")
```

`backend/app/modulos/contas/contas_rotas.py`:
```python
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy import Connection
from sqlalchemy.exc import IntegrityError

from app.integracoes.mercado_livre import ml_cliente as ml
from app.modulos.contas import contas_servico as servico
from app.nucleo.auditoria import registrar
from app.nucleo.banco import transacao
from app.nucleo.configuracao import configuracao
from app.nucleo.dependencias import conexao, empresa_atual, usuario_atual

router = APIRouter(prefix="/api/contas")


@router.get("")
def listar(conn: Connection = Depends(conexao)) -> list[dict]:
    return servico.listar(conn)


@router.post("/ml/iniciar")
def iniciar_ml(empresa_id: str = Depends(empresa_atual), usuario_id: str = Depends(usuario_atual)) -> dict:
    with transacao() as conn:
        state = servico.criar_estado(conn, empresa_id, usuario_id)
    return {"url": ml.url_autorizacao(state)}


@router.get("/ml/callback")
def callback_ml(code: str, state: str, usuario_id: str = Depends(usuario_atual),
                http: httpx.Client = Depends(ml.cliente_http)) -> RedirectResponse:
    with transacao() as conn:
        estado = servico.consumir_estado(conn, state)
    if estado is None or estado[1] != usuario_id:
        raise HTTPException(400, "state invalido ou expirado")
    empresa_id = estado[0]
    tokens = ml.trocar_codigo(http, code)
    apelido = ml.perfil(http, tokens["access_token"]).get("nickname", f"ML {tokens['user_id']}")
    try:
        with transacao(empresa_id) as conn:
            conta_id = servico.salvar_conta_ml(conn, empresa_id, tokens, apelido)
            registrar(conn, "conta_conectada", usuario_id, empresa_id, "conta", conta_id)
    except IntegrityError:
        raise HTTPException(409, "conta ja conectada a outra empresa") from None
    return RedirectResponse(f"{configuracao().frontend_url}?conta=ml", status_code=303)
```

`backend/app/main.py` (substituir):
```python
from fastapi import FastAPI

from app.modulos.autenticacao import autenticacao_rotas
from app.modulos.contas import contas_rotas
from app.modulos.saude import saude_rotas
from app.nucleo.seguranca_http import SegurancaHttp


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SegurancaHttp)
    for modulo in (saude_rotas, autenticacao_rotas, contas_rotas):
        app.include_router(modulo.router)
    return app


app = criar_app()
```

- [ ] **Step 4: Rodar tudo e ver passar**

Run: `pytest -q` — Expected: todos passam.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(contas): conectar ML por OAuth, listar contas e trava de escrita"
```

---

### Task 8: Webhook de notificações do ML (idempotente)

**Files:**
- Create: `backend/app/modulos/notificacoes/__init__.py`, `notificacoes_rotas.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_notificacoes.py`

**Interfaces:**
- Consumes: `banco.transacao`, `configuracao().ml_client_id`.
- Produces: `POST /api/ml/notificacoes` (público) → `200 {}`; grava em `notificacoes_recebidas` sem duplicar enquanto houver uma pendente igual; `400` se `application_id` não for o do nosso app.

- [ ] **Step 1: Escrever o teste que falha**

`backend/tests/test_notificacoes.py`:
```python
from sqlalchemy import text

CORPO = {"resource": "/orders/1", "user_id": 42, "topic": "orders_v2", "application_id": 123}


def _contar(dono) -> int:
    with dono.connect() as c:
        return c.execute(text("select count(*) from notificacoes_recebidas")).scalar_one()


def test_grava_e_nao_duplica_pendente(cliente, dono):
    assert cliente.post("/api/ml/notificacoes", json=CORPO).status_code == 200
    assert cliente.post("/api/ml/notificacoes", json=CORPO).status_code == 200
    assert _contar(dono) == 1


def test_processada_permite_nova_notificacao_do_mesmo_recurso(cliente, dono):
    cliente.post("/api/ml/notificacoes", json=CORPO)
    with dono.begin() as c:
        c.execute(text("update notificacoes_recebidas set processado_em = now()"))
    cliente.post("/api/ml/notificacoes", json=CORPO)
    assert _contar(dono) == 2


def test_application_id_de_outro_app_e_recusado(cliente, dono):
    r = cliente.post("/api/ml/notificacoes", json=CORPO | {"application_id": 999})
    assert r.status_code == 400
    assert _contar(dono) == 0


def test_webhook_aceita_chamada_sem_sessao_e_sem_cabecalho_csrf():
    from fastapi.testclient import TestClient

    from app.main import app
    with TestClient(app) as c:
        assert c.post("/api/ml/notificacoes", json=CORPO).status_code == 200
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pytest tests/test_notificacoes.py -q` — Expected: FAIL (404)

- [ ] **Step 3: Implementar**

`backend/app/modulos/notificacoes/__init__.py`: vazio.

`backend/app/modulos/notificacoes/notificacoes_rotas.py`:
```python
import hashlib

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.nucleo.banco import transacao
from app.nucleo.configuracao import configuracao

router = APIRouter(prefix="/api/ml")


class Notificacao(BaseModel):
    resource: str
    user_id: int
    topic: str
    application_id: int | None = None


@router.post("/notificacoes")
def receber(n: Notificacao) -> dict:
    # o ML não assina o aviso; só confere o app e deixa o processamento para a tarefa, que consulta a API
    if str(n.application_id) != configuracao().ml_client_id:
        raise HTTPException(400, "aplicacao invalida")
    hash_ = hashlib.sha256(f"{n.user_id}|{n.topic}|{n.resource}".encode()).hexdigest()
    with transacao() as conn:
        conn.execute(text(
            "insert into notificacoes_recebidas(marketplace, user_id_externo, topico, recurso, hash) "
            "values ('ml', :u, :t, :r, :h) on conflict (hash) where processado_em is null do nothing"),
            {"u": str(n.user_id), "t": n.topic, "r": n.resource, "h": hash_})
    return {}
```

`backend/app/main.py` (substituir):
```python
from fastapi import FastAPI

from app.modulos.autenticacao import autenticacao_rotas
from app.modulos.contas import contas_rotas
from app.modulos.notificacoes import notificacoes_rotas
from app.modulos.saude import saude_rotas
from app.nucleo.seguranca_http import SegurancaHttp


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SegurancaHttp)
    for modulo in (saude_rotas, autenticacao_rotas, contas_rotas, notificacoes_rotas):
        app.include_router(modulo.router)
    return app


app = criar_app()
```

- [ ] **Step 4: Rodar tudo e ver passar**

Run: `pytest -q` — Expected: todos passam (inclusive `test_toda_rota_exige_sessao_exceto_as_publicas`: o webhook está em `PUBLICAS`).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(notificacoes): webhook do ML idempotente"
```

---

### Task 9: Qualidade e segurança no CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: todo o backend e os testes.
- Produces: pipeline que roda lint, bandit, pip-audit, gitleaks e pytest em todo push.

- [ ] **Step 1: Rodar as verificações localmente**

Run (de `backend/`, com o venv ativo):
```bash
ruff check . ../banco
bandit -r app -ll
pip-audit
```
Expected: `ruff` sem erros, `bandit` sem achados de severidade média ou alta, `pip-audit` sem vulnerabilidades conhecidas. Corrija o que aparecer antes de seguir.

- [ ] **Step 2: Criar o workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]

jobs:
  segredos:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }

  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: nvs_test }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      NVS_DATABASE_URL: postgresql+psycopg://postgres:postgres@localhost:5432/nvs_test
    defaults:
      run: { working-directory: backend }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e ".[dev]"
      - run: ruff check . ../banco
      - run: bandit -r app -ll
      - run: pip-audit
      - run: pytest -q
```

- [ ] **Step 3: Rodar a suíte completa local**

Run: `pytest -q`
Expected: todos os testes passam.

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "ci: lint, bandit, pip-audit, gitleaks e testes"
```

- [ ] **Step 5: Publicar no GitHub (ação do dono do projeto)**

O dono cria o repositório **privado** no GitHub e roda:
```bash
git remote add origin <url-do-repositorio>
git push -u origin main
```
Expected: o workflow `ci` roda e fica verde. Ligar o Dependabot em Settings → Code security.

---

### Task 10: Dockerfile e deploy no Railway

**Files:**
- Create: `infra/Dockerfile`
- Modify: nenhuma configuração versionada (segredos só no painel do Railway)

**Interfaces:**
- Consumes: projeto Railway "NVS NOVO" (serviço `nvs-novo`, Postgres), domínio `nvs-novo-production.up.railway.app`.
- Produces: `GET https://nvs-novo-production.up.railway.app/api/saude` → `{"ok": true}`; migração aplicada; conta de ML conectável.

- [ ] **Step 1: Criar o Dockerfile**

`infra/Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY backend ./backend
COPY banco ./banco
RUN pip install --no-cache-dir ./backend && useradd -m nvs
USER nvs
CMD ["sh", "-c", "alembic -c banco/alembic.ini upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
```

- [ ] **Step 2: Conferir que a imagem sobe localmente**

Run (da raiz do repositório):
```bash
docker build -f infra/Dockerfile -t nvs-novo .
```
Expected: build termina sem erro.

- [ ] **Step 3: Gerar os segredos no seu terminal (não cole no chat)**

Run:
```bash
python -c "import secrets,base64;print('NVS_SEGREDO_SESSAO='+secrets.token_urlsafe(48));print('NVS_APP_SENHA='+secrets.token_urlsafe(24));print('NVS_CHAVES_TOKEN=1:'+base64.b64encode(secrets.token_bytes(32)).decode())"
```
Expected: três linhas `NOME=valor`. Guarde também uma cópia da `NVS_CHAVES_TOKEN` fora do Railway: **perdê-la torna os tokens ilegíveis**.

- [ ] **Step 4: Definir as variáveis no serviço `nvs-novo` (painel do Railway)**

Variáveis do serviço:
```
NVS_DATABASE_URL     = ${{Postgres.DATABASE_URL}}
NVS_SEGREDO_SESSAO   = (gerado no passo 3)
NVS_APP_SENHA        = (gerado no passo 3)
NVS_CHAVES_TOKEN     = (gerado no passo 3)
NVS_ML_CLIENT_ID     = (Client ID do app do ML)
NVS_ML_CLIENT_SECRET = (Client Secret do app do ML)
NVS_ML_REDIRECT_URI  = https://nvs-novo-production.up.railway.app/api/contas/ml/callback
NVS_COOKIE_SEGURO    = 1
NVS_FRONTEND_URL     = /
```
Em Settings → Build: Dockerfile em `infra/Dockerfile`, contexto na raiz.

- [ ] **Step 5: Publicar e testar**

Run (da raiz, com o Railway CLI logado e ligado ao serviço `nvs-novo`):
```bash
railway up --service nvs-novo
```
Depois:
```bash
curl https://nvs-novo-production.up.railway.app/api/saude
```
Expected: `{"ok":true}`. No app do ML, ajuste **URIs de redirect** para `https://nvs-novo-production.up.railway.app/api/contas/ml/callback` e a **URL de notificações** para `https://nvs-novo-production.up.railway.app/api/ml/notificacoes`. Commit final:
```bash
git add -A && git commit -m "feat(deploy): Dockerfile para Railway"
```

---

## Auto-revisão

**Cobertura da spec (`modelo-de-dados.md`):**
- §1 identidade/empresas/membros → Tasks 3, 4. `configuracoes_empresa` → fora (plano das telas de configuração).
- §2 contas, credenciais, oauth_estados, escrita_modulos, renovação com trava → Tasks 3, 6, 7.
- §3 a §6 (catálogo, pedidos, agregados, finanças) → **fora desta fundação**, planos próprios.
- §7 sincronização/auditoria → `auditoria` (Tasks 3, 4, 7) e `notificacoes_recebidas` (Tasks 3, 8). `sincronizacoes` → plano do motor de sincronização.
- §8 RLS → Task 3. §10 verificações: 1 isolamento (Task 3), 2 conta única (Tasks 3, 7), 3 token cifrado (Tasks 6, 7), 5 webhook (Task 8), 6 escrita bloqueada (Task 7). A 4 (custo retroativo) pertence ao plano do catálogo.

**Refinamento da spec:** o webhook deduplica **enquanto houver uma notificação pendente igual** (índice parcial), em vez de único por `(conta_id, topico, recurso, hash)`. Motivo: o ML reenvia o mesmo recurso a cada mudança e não pode perder a última; e o aviso chega só com o `user_id` externo, sem a conta resolvida.

**Tabelas sem RLS, de propósito:** `usuarios`, `empresas`, `membros` (precisam ser lidas antes de escolher a empresa; acesso sempre filtrado por usuário no serviço), `oauth_estados` (só hash e ids, consumida antes de saber a empresa) e `notificacoes_recebidas` (chega sem empresa; resolvida pela tarefa de sincronização).

**Consistência de tipos:** `transacao(empresa_id)`, `definir_empresa`, `registrar`, `cifrar/decifrar`, `token_valido`, `salvar_credenciais`, `exigir_escrita`, `PUBLICAS` e `cliente_http` têm a mesma assinatura em todas as tasks que os usam. Variáveis de ambiente usam sempre o prefixo `NVS_` (incluindo `NVS_ML_CLIENT_ID` e `NVS_ML_CLIENT_SECRET`).
