import base64
import os

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

from app.main import app  # noqa: E402


@pytest.fixture
def cliente():
    with TestClient(app, headers={"x-requested-with": "nvs"}) as c:
        yield c
