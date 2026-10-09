from fastapi import FastAPI

from app.modulos.saude import saude_rotas


def criar_app() -> FastAPI:
    app = FastAPI(title="NVS", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(saude_rotas.router)
    return app


app = criar_app()
