import hashlib

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.nucleo.banco import transacao
from app.nucleo.configuracao import configuracao

router = APIRouter(prefix="/api/ml")


class Notificacao(BaseModel):
    resource: str = Field(min_length=1, max_length=200)
    user_id: int
    topic: str = Field(min_length=1, max_length=64)
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
