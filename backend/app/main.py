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
