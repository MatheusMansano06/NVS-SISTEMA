from fastapi import FastAPI

from app.modulos.autenticacao import autenticacao_rotas
from app.modulos.saude import saude_rotas


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    for modulo in (saude_rotas, autenticacao_rotas):
        app.include_router(modulo.router)
    return app


app = criar_app()
