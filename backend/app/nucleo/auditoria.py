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
