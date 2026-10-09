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


def consumir_estado(conn: Connection, state: str, usuario_id: str) -> str | None:
    # filtrar por usuário no próprio UPDATE evita que outro usuário queime o state alheio
    return conn.execute(text(
        "update oauth_estados set usado_em = now() where state_hash = :h and usado_em is null "
        "and expira_em > now() and usuario_id = cast(:u as uuid) returning empresa_id::text"),
        {"h": _hash(state), "u": usuario_id}).scalar()


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
