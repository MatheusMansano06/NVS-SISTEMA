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
