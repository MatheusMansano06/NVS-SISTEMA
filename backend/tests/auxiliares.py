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
