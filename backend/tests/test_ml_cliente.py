import httpx
import pytest

from app.integracoes.mercado_livre import ml_cliente as ml


def _cliente(resposta: httpx.Response) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda req: resposta))


def test_url_de_autorizacao_leva_state_e_client_id():
    url = ml.url_autorizacao("abc")
    assert url.startswith("https://auth.mercadolivre.com.br/authorization?")
    assert "state=abc" in url and "client_id=123" in url


def test_trocar_codigo_devolve_tokens():
    http = _cliente(httpx.Response(200, json={"access_token": "a", "refresh_token": "r", "user_id": 42}))
    assert ml.trocar_codigo(http, "cod")["user_id"] == 42


def test_refresh_invalido_so_em_invalid_grant():
    http = _cliente(httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(ml.RefreshInvalido):
        ml.renovar(http, "r")


def test_erro_transitorio_nao_vira_refresh_invalido():
    http = _cliente(httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        ml.renovar(http, "r")


def test_400_sem_json_cai_no_raise_for_status():
    http = _cliente(httpx.Response(400, content=b"<html>bad</html>"))
    with pytest.raises(httpx.HTTPStatusError):
        ml.renovar(http, "r")
