from uuid import uuid4

import pytest
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


def test_auditoria_so_aceita_insercao(duas_empresas):
    a, _ = duas_empresas
    with transacao(a) as c:
        c.execute(text("insert into auditoria(empresa_id, acao) values (cast(:a as uuid), 'x')"), {"a": a})
    with pytest.raises(ProgrammingError), transacao(a) as c:
        c.execute(text("delete from auditoria"))
