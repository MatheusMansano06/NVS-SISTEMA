import re
from pathlib import Path

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.main import app
from app.nucleo.seguranca_http import PUBLICAS


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
