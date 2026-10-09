import base64
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("NVS_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5433/nvs_test")
os.environ.setdefault("NVS_APP_SENHA", "senha_teste")
os.environ.setdefault("NVS_SEGREDO_SESSAO", "segredo-de-teste")
os.environ.setdefault("NVS_CHAVES_TOKEN", "1:" + base64.b64encode(b"k" * 32).decode())
os.environ.setdefault("NVS_ML_CLIENT_ID", "123")
os.environ.setdefault("NVS_ML_CLIENT_SECRET", "segredo-ml")
os.environ.setdefault("NVS_ML_REDIRECT_URI", "https://x.test/api/contas/ml/callback")
os.environ.setdefault("NVS_COOKIE_SEGURO", "0")

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from app.main import app  # noqa: E402
from app.nucleo import limitador  # noqa: E402
from app.nucleo.configuracao import configuracao  # noqa: E402

RAIZ = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def dono():
    motor = create_engine(configuracao().database_url)
    with motor.connect().execution_options(isolation_level="AUTOCOMMIT") as c:
        c.execute(text("drop schema public cascade"))
        c.execute(text("create schema public"))
    command.upgrade(Config(str(RAIZ / "banco" / "alembic.ini")), "head")
    yield motor


@pytest.fixture(autouse=True)
def limpo(dono):
    with dono.begin() as c:
        c.execute(text(
            "truncate usuarios, empresas, oauth_estados, auditoria, notificacoes_recebidas "
            "restart identity cascade"))
    limitador._tentativas.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def cliente():
    with TestClient(app, headers={"x-requested-with": "nvs"}) as c:
        yield c
