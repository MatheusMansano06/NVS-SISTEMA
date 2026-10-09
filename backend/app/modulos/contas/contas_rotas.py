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
        empresa_id = servico.consumir_estado(conn, state, usuario_id)
    if empresa_id is None:
        raise HTTPException(400, "state invalido ou expirado")
    tokens = ml.trocar_codigo(http, code)
    apelido = ml.perfil(http, tokens["access_token"]).get("nickname", f"ML {tokens['user_id']}")
    try:
        with transacao(empresa_id) as conn:
            conta_id = servico.salvar_conta_ml(conn, empresa_id, tokens, apelido)
            registrar(conn, "conta_conectada", usuario_id, empresa_id, "conta", conta_id)
    except IntegrityError as erro:
        if (getattr(erro.orig, "sqlstate", None) != "23505"
                or erro.orig.diag.constraint_name != "contas_marketplace_marketplace_id_externo_key"):
            raise
        raise HTTPException(409, "conta ja conectada a outra empresa") from None
    return RedirectResponse(f"{configuracao().frontend_url}?conta=ml", status_code=303)
