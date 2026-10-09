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


def test_sem_linha_de_credenciais_pede_reautorizacao(dono):
    empresa_id, conta_id = semear_conta(dono, "now() + interval '1 hour'")
    with dono.begin() as c:
        c.execute(text("delete from credenciais_conta"))
    with pytest.raises(ContaPrecisaReautorizar):
        token_valido(conta_id, empresa_id, cliente_ml_falso())


def test_5xx_na_renovacao_nao_altera_status_nem_credenciais(dono):
    import httpx
    empresa_id, conta_id = semear_conta(dono, "now() - interval '1 minute'")
    with dono.connect() as c:
        antes = c.execute(text("select access_token_cifrado, refresh_token_cifrado, expira_em "
                               "from credenciais_conta")).one()
    http = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(503)))
    with pytest.raises(httpx.HTTPStatusError):
        token_valido(conta_id, empresa_id, http)
    with dono.connect() as c:
        assert c.execute(text("select status from contas_marketplace")).scalar_one() == "ativa"
        assert c.execute(text("select access_token_cifrado, refresh_token_cifrado, expira_em "
                              "from credenciais_conta")).one() == antes
