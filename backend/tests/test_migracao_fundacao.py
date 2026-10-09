import pytest
from sqlalchemy import text

from app.nucleo.banco import transacao
from tests.auxiliares import semear_conta


def test_role_da_app_nao_fura_rls(dono):
    with dono.connect() as c:
        r = c.execute(text(
            "select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin "
            "from pg_roles where rolname = 'nvs_app'")).one()
    assert tuple(r) == (False, False, False, False, True)


@pytest.mark.parametrize("tabela, colunas", [
    ("membros", {"criado_em", "atualizado_em"}),
    ("escrita_modulos", {"criado_em", "atualizado_em"}),
    ("oauth_estados", {"criado_em"}),
])
def test_timestamps_nao_nulos_com_default(dono, tabela, colunas):
    with dono.connect() as c:
        linhas = c.execute(text(
            "select column_name, is_nullable, column_default from information_schema.columns "
            "where table_name = :t and column_name = any(:cs)"), {"t": tabela, "cs": list(colunas)}).all()
    assert {linha[0] for linha in linhas} == colunas
    assert all(linha[1] == "NO" and "now()" in linha[2] for linha in linhas)


def test_conta_ml_existe_sem_contexto_de_empresa(dono):
    semear_conta(dono, "now() + interval '1 hour'")
    with transacao() as conn:
        assert conn.execute(text("select conta_ml_existe('42')")).scalar_one() is True
        assert conn.execute(text("select conta_ml_existe('43')")).scalar_one() is False


def test_conta_ml_existe_nao_e_executavel_por_public(dono):
    with dono.connect() as c:
        assert c.execute(text(
            "select has_function_privilege('nvs_app', 'conta_ml_existe(text)', 'execute'), "
            "has_function_privilege('public', 'conta_ml_existe(text)', 'execute')")).one() == (True, False)


def test_nvs_app_continua_sem_ler_contas_direto(dono):
    semear_conta(dono, "now() + interval '1 hour'")
    with transacao() as conn:
        assert conn.execute(text("select count(*) from contas_marketplace")).scalar_one() == 0
