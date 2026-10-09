from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.nucleo import sessao
from app.nucleo.dependencias import conexao

mini = FastAPI()


@mini.get("/x")
def rota(conn: Connection = Depends(conexao)) -> dict:
    return {"empresa": conn.execute(text("select current_setting('app.empresa_id', true)")).scalar_one()}


@pytest.fixture
def semeado(dono):
    with dono.begin() as c:
        u = str(c.execute(text("insert into usuarios(email, senha_hash) values ('m@x.com','h') returning id")).scalar_one())
        o = str(c.execute(text("insert into usuarios(email, senha_hash) values ('o@x.com','h') returning id")).scalar_one())
        e = str(c.execute(text("insert into empresas(nome) values ('Loja') returning id")).scalar_one())
        c.execute(text("insert into membros(usuario_id, empresa_id, papel) "
                       "values (cast(:u as uuid), cast(:e as uuid), 'dono')"), {"u": u, "e": e})
    return u, o, e


def _get(usuario_id, empresa_id=None):
    cab = {"x-empresa": empresa_id} if empresa_id else {}
    with TestClient(mini) as c:
        if usuario_id:
            c.cookies.set(sessao.COOKIE, sessao.emitir(usuario_id))
        return c.get("/x", headers=cab)


def test_sem_cabecalho_da_400(semeado):
    assert _get(semeado[0]).status_code == 400


def test_cabecalho_nao_uuid_da_400(semeado):
    assert _get(semeado[0], "nao-e-uuid").status_code == 400


def test_nao_membro_da_403(semeado):
    assert _get(semeado[1], semeado[2]).status_code == 403
    assert _get(semeado[0], str(uuid4())).status_code == 403


def test_membro_da_200_e_define_empresa(semeado):
    r = _get(semeado[0], semeado[2])
    assert r.status_code == 200 and r.json() == {"empresa": semeado[2]}


def test_sem_cookie_da_401(semeado):
    assert _get(None, semeado[2]).status_code == 401
