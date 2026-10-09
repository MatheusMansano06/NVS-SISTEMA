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
