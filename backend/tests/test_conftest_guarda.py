import pytest

from tests.conftest import exigir_banco_de_teste


def test_guarda_recusa_banco_que_nao_e_de_teste():
    with pytest.raises(AssertionError, match="nvs_prod"):
        exigir_banco_de_teste("postgresql+psycopg://u:p@h:5432/nvs_prod")


def test_guarda_aceita_banco_de_teste():
    exigir_banco_de_teste("postgresql+psycopg://u:p@h:5433/nvs_test")
