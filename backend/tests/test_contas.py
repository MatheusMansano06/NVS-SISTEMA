import re
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.integracoes.mercado_livre.ml_cliente import cliente_http
from app.main import app
from app.modulos.contas.contas_servico import exigir_escrita
from app.nucleo.banco import transacao
from tests.auxiliares import cliente_ml_falso, semear_conta

CADASTRO = {"email": "a@x.com", "senha": "senha-longa-123", "nome_empresa": "Loja A"}


def _logar(cliente, email="a@x.com") -> str:
    r = cliente.post("/api/auth/cadastro", json=CADASTRO | {"email": email})
    return r.json()["empresa_id"]


def _iniciar(cliente, empresa_id) -> str:
    url = cliente.post("/api/contas/ml/iniciar", headers={"x-empresa": empresa_id}).json()["url"]
    return re.search(r"state=([^&]+)", url).group(1)


@pytest.fixture(autouse=True)
def ml_falso():
    app.dependency_overrides[cliente_http] = cliente_ml_falso


def test_conectar_ml_cria_conta_e_cifra_o_token(cliente, dono):
    empresa_id = _logar(cliente)
    state = _iniciar(cliente, empresa_id)
    r = cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert r.status_code == 303
    contas = cliente.get("/api/contas", headers={"x-empresa": empresa_id}).json()
    assert [(c["marketplace"], c["id_externo"], c["apelido"]) for c in contas] == [("ml", "42", "LOJA42")]
    with dono.connect() as c:
        bruto = c.execute(text("select access_token_cifrado from credenciais_conta")).scalar_one()
        assert c.execute(text("select count(*) from auditoria where acao = 'conta_conectada'")).scalar_one() == 1
    assert b"tok-acesso" not in bytes(bruto)


def test_state_so_vale_uma_vez(cliente):
    empresa_id = _logar(cliente)
    state = _iniciar(cliente, empresa_id)
    cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    r = cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert r.status_code == 400


def test_state_de_outro_usuario_e_recusado(cliente):
    state = _iniciar(cliente, _logar(cliente))
    with TestClient(app, headers={"x-requested-with": "nvs"}) as outro:
        _logar(outro, "b@x.com")
        r = outro.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert r.status_code == 400


def test_conta_ml_nao_vai_para_segunda_empresa(cliente):
    state = _iniciar(cliente, (empresa_a := _logar(cliente)))
    cliente.get(f"/api/contas/ml/callback?code=c&state={state}", follow_redirects=False)
    assert empresa_a
    with TestClient(app, headers={"x-requested-with": "nvs"}) as outro:
        empresa_b = _logar(outro, "b@x.com")
        r = outro.get(f"/api/contas/ml/callback?code=c&state={_iniciar(outro, empresa_b)}",
                      follow_redirects=False)
    assert r.status_code == 409


def test_empresa_de_outro_usuario_da_403(cliente):
    empresa_a = _logar(cliente)
    with TestClient(app, headers={"x-requested-with": "nvs"}) as outro:
        _logar(outro, "b@x.com")
        assert outro.get("/api/contas", headers={"x-empresa": empresa_a}).status_code == 403


def test_escrita_nasce_bloqueada_e_libera_por_modulo(dono):
    empresa_id, conta_id = semear_conta(dono, "now() + interval '1 hour'")
    with pytest.raises(HTTPException) as erro, transacao(empresa_id) as conn:
        exigir_escrita(conn, conta_id, "anuncios")
    assert erro.value.status_code == 403
    with dono.begin() as c:
        c.execute(text("insert into escrita_modulos(conta_id, empresa_id, modulo, habilitada) "
                       "values (:c, :e, 'anuncios', true)"), {"c": conta_id, "e": empresa_id})
    with transacao(empresa_id) as conn:
        exigir_escrita(conn, conta_id, "anuncios")
    assert uuid4()
