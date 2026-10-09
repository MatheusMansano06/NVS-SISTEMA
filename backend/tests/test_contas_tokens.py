import pytest
from sqlalchemy import text

from app.integracoes.mercado_livre import ml_cliente as ml
from app.modulos.contas.contas_tokens import ContaPrecisaReautorizar, token_valido
from app.nucleo.cifra import decifrar
from tests.auxiliares import cliente_ml_falso, semear_conta


def test_token_vivo_nao_chama_o_ml(dono):
    empresa_id, conta_id = semear_conta(dono, "now() + interval '1 hour'")
    chamadas: list = []
    assert token_valido(conta_id, empresa_id, cliente_ml_falso(chamadas)) == "acesso-velho"
    assert chamadas == []


def test_token_expirado_renova_e_guarda_o_novo_refresh(dono):
    empresa_id, conta_id = semear_conta(dono, "now() - interval '1 minute'")
    assert token_valido(conta_id, empresa_id, cliente_ml_falso()) == "tok-acesso"
    with dono.connect() as c:
        linha = c.execute(text("select refresh_token_cifrado, versao_chave from credenciais_conta")).one()
    assert decifrar(linha[0], linha[1], conta_id) == "tok-refresh"


def test_invalid_grant_marca_conta_para_reautorizar(dono, monkeypatch):
    empresa_id, conta_id = semear_conta(dono, "now() - interval '1 minute'")

    def falha(http, refresh):
        raise ml.RefreshInvalido

    monkeypatch.setattr(ml, "renovar", falha)
    with pytest.raises(ContaPrecisaReautorizar):
        token_valido(conta_id, empresa_id, cliente_ml_falso())
    with dono.connect() as c:
        assert c.execute(text("select status from contas_marketplace")).scalar_one() == "reautorizar"
