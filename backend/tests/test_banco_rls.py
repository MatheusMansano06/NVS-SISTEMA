from uuid import uuid4

import pytest
from psycopg.errors import InsufficientPrivilege
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, ProgrammingError

from app.nucleo.banco import transacao


@pytest.fixture
def duas_empresas(dono):
    a, b = str(uuid4()), str(uuid4())
    with dono.begin() as c:
        c.execute(text("insert into empresas(id, nome) values (:a, 'A'), (:b, 'B')"), {"a": a, "b": b})
        c.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) values "
            "(:a, 'ml', '1', 'a'), (:b, 'ml', '2', 'b')"), {"a": a, "b": b})
    return a, b


def test_empresa_so_ve_as_proprias_contas(duas_empresas):
    a, _ = duas_empresas
    with transacao(a) as c:
        ids = c.execute(text("select id_externo from contas_marketplace")).scalars().all()
    assert ids == ["1"]


def test_sem_empresa_definida_nao_ve_nada(duas_empresas):
    with transacao() as c:
        assert c.execute(text("select count(*) from contas_marketplace")).scalar_one() == 0


def test_nao_grava_conta_em_outra_empresa(duas_empresas):
    a, b = duas_empresas
    with pytest.raises(ProgrammingError), transacao(a) as c:
        c.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) "
            "values (cast(:b as uuid), 'ml', '9', 'x')"), {"b": b})


def test_mesma_conta_externa_nao_vai_para_duas_empresas(duas_empresas, dono):
    a, _ = duas_empresas
    with pytest.raises(IntegrityError), dono.begin() as c:
        c.execute(text(
            "insert into contas_marketplace(empresa_id, marketplace, id_externo, apelido) "
            "values (cast(:a as uuid), 'ml', '2', 'dup')"), {"a": a})


@pytest.fixture
def contas(duas_empresas, dono):
    a, b = duas_empresas
    with dono.begin() as c:
        ca, cb = c.execute(text("select id from contas_marketplace order by id_externo")).scalars().all()
        for conta, emp in ((ca, a), (cb, b)):
            c.execute(text(
                "insert into credenciais_conta(conta_id, empresa_id, access_token_cifrado, refresh_token_cifrado, "
                "expira_em, versao_chave) values (:c, :e, 'x', 'y', now(), 1)"), {"c": conta, "e": emp})
            c.execute(text("insert into escrita_modulos(conta_id, empresa_id, modulo) values (:c, :e, 'm')"),
                      {"c": conta, "e": emp})
    return a, b, str(ca), str(cb)


@pytest.mark.parametrize("tabela", ["credenciais_conta", "escrita_modulos"])
def test_rls_isola_tabelas_filhas(contas, tabela):
    a, _, ca, _ = contas
    with transacao(a) as c:
        ids = c.execute(text(f"select conta_id from {tabela}")).scalars().all()
    assert [str(i) for i in ids] == [ca]


def test_nao_aponta_conta_de_outra_empresa(contas):
    a, _, _, cb = contas
    with pytest.raises(IntegrityError), transacao(a) as c:
        c.execute(text("insert into escrita_modulos(conta_id, empresa_id, modulo) "
                       "values (cast(:c as uuid), cast(:e as uuid), 'outro')"), {"c": cb, "e": a})
    with pytest.raises(IntegrityError), transacao(a) as c:
        c.execute(text(
            "insert into credenciais_conta(conta_id, empresa_id, access_token_cifrado, refresh_token_cifrado, "
            "expira_em, versao_chave) values (cast(:c as uuid), cast(:e as uuid), 'x', 'y', now(), 1)"),
            {"c": cb, "e": a})


def test_auditoria_nao_le_de_outra_empresa(duas_empresas):
    a, b = duas_empresas
    for e in (a, b):
        with transacao(e) as c:
            c.execute(text("insert into auditoria(empresa_id, acao) values (cast(:e as uuid), 'x')"), {"e": e})
    with transacao(a) as c:
        assert c.execute(text("select count(*) from auditoria")).scalar_one() == 1
        assert c.execute(text("select count(*) from auditoria where empresa_id = cast(:b as uuid)"),
                         {"b": b}).scalar_one() == 0


def test_empresa_nao_vaza_para_proxima_transacao(duas_empresas):
    a, _ = duas_empresas
    with transacao(a) as c:
        assert c.execute(text("select count(*) from contas_marketplace")).scalar_one() == 1
    with transacao() as c:
        assert c.execute(text("select count(*) from contas_marketplace")).scalar_one() == 0


@pytest.mark.parametrize("sql", ["delete from auditoria", "update auditoria set acao = 'y'"])
def test_auditoria_so_aceita_insercao(duas_empresas, sql):
    a, _ = duas_empresas
    with transacao(a) as c:
        c.execute(text("insert into auditoria(empresa_id, acao) values (cast(:a as uuid), 'x')"), {"a": a})
    with pytest.raises(ProgrammingError) as erro, transacao(a) as c:
        c.execute(text(sql))
    assert isinstance(erro.value.orig, InsufficientPrivilege)
