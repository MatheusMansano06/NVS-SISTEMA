import base64

import pytest
from pydantic import ValidationError

from app.nucleo.configuracao import Configuracao

SEGREDO = "s" * 32
CHAVE = "1:" + base64.b64encode(b"k" * 32).decode()


def _cfg(**extra):
    base = dict(database_url="postgres://u:p@h/d", app_senha="s", segredo_sessao=SEGREDO, chaves_token=CHAVE)
    return Configuracao(**(base | extra))


def test_normaliza_url_do_railway_e_deriva_url_do_app():
    c = _cfg()
    assert c.database_url == "postgresql+psycopg://u:p@h/d"
    assert c.url_app == "postgresql+psycopg://nvs_app:s@h/d"


def test_segredo_curto_e_recusado_sem_ecoar_o_valor():
    with pytest.raises(ValidationError) as erro:
        _cfg(segredo_sessao="curto-demais")
    assert "32 caracteres" in str(erro.value) and "curto-demais" not in str(erro.value)


@pytest.mark.parametrize("chaves", [
    "1:" + base64.b64encode(b"k" * 16).decode(),
    "x:" + base64.b64encode(b"k" * 32).decode(),
    "1:nao-e-base64!",
    "sem-dois-pontos",
    CHAVE + ",2:" + base64.b64encode(b"k" * 31).decode(),
])
def test_chaves_invalidas_sao_recusadas(chaves):
    with pytest.raises(ValidationError) as erro:
        _cfg(chaves_token=chaves)
    assert "chaves_token" in str(erro.value) and "nao-e-base64" not in str(erro.value)


def test_chaves_validas_com_rotacao_sao_aceitas():
    assert _cfg(chaves_token=CHAVE + ",2:" + base64.b64encode(b"z" * 32).decode())
