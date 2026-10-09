import re
from pathlib import Path

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.main import app
from app.nucleo.seguranca_http import PUBLICAS, WEBHOOK_ML


def test_escrita_sem_cabecalho_anti_csrf_da_403():
    with TestClient(app) as c:
        r = c.post("/api/auth/entrar", json={"email": "a@x.com", "senha": "x"})
    assert r.status_code == 403


def test_toda_rota_exige_sessao_exceto_as_publicas(cliente):
    for rota in app.routes:
        if isinstance(rota, APIRoute) and rota.path not in PUBLICAS:
            for metodo in rota.methods:
                r = cliente.request(metodo, rota.path)
                assert r.status_code == 401, f"{metodo} {rota.path} nao exige sessao"


def test_cabecalhos_de_seguranca(cliente):
    r = cliente.get("/api/saude")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "max-age" in r.headers["strict-transport-security"]


def test_trilhas_nao_importam_outras_trilhas():
    base = Path(__file__).resolve().parents[1] / "app" / "modulos"
    for trilha in (p for p in base.iterdir() if p.is_dir() and p.name != "__pycache__"):
        for arquivo in trilha.rglob("*.py"):
            for outra in re.findall(r"app\.modulos\.(\w+)", arquivo.read_text(encoding="utf-8")):
                assert outra == trilha.name, f"{arquivo.name} importa a trilha {outra}"


def _cabecalhos_presentes(r):
    for h in ("x-content-type-options", "x-frame-options", "strict-transport-security"):
        assert h in r.headers, h


def test_401_e_403_tambem_levam_cabecalhos_de_seguranca(cliente):
    _cabecalhos_presentes(cliente.get("/api/contas"))
    with TestClient(app) as c:
        r = c.post("/api/auth/entrar", json={"email": "a@x.com", "senha": "x"})
    assert r.status_code == 403
    _cabecalhos_presentes(r)


def test_webhook_e_publico_e_isento_de_csrf():
    assert WEBHOOK_ML in PUBLICAS
    with TestClient(app) as c:
        r = c.post(WEBHOOK_ML, json={"resource": "/o/1", "user_id": 1, "topic": "t", "application_id": 999})
    assert r.status_code == 400  # passou do CSRF e da sessão; foi recusado pela rota


def test_cookie_forjado_da_401(cliente):
    from app.nucleo.sessao import COOKIE
    cliente.cookies.set(COOKIE, "forjado.abc")
    assert cliente.get("/api/contas").status_code == 401
