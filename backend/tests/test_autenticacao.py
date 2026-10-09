from sqlalchemy import text

CADASTRO = {"email": "a@x.com", "senha": "senha-longa-123", "nome_empresa": "Loja A"}


def test_cadastro_cria_sessao_empresa_e_auditoria(cliente, dono):
    r = cliente.post("/api/auth/cadastro", json=CADASTRO)
    assert r.status_code == 201
    eu = cliente.get("/api/auth/eu").json()
    assert eu["email"] == "a@x.com"
    assert eu["empresas"][0]["papel"] == "dono"
    with dono.connect() as c:
        assert c.execute(text("select count(*) from auditoria where acao = 'cadastro'")).scalar_one() == 1


def test_email_duplicado_da_409(cliente):
    cliente.post("/api/auth/cadastro", json=CADASTRO)
    assert cliente.post("/api/auth/cadastro", json=CADASTRO).status_code == 409


def test_senha_curta_da_422(cliente):
    r = cliente.post("/api/auth/cadastro", json=CADASTRO | {"senha": "curta"})
    assert r.status_code == 422


def test_login_certo_e_errado(cliente):
    cliente.post("/api/auth/cadastro", json=CADASTRO)
    cliente.cookies.clear()
    errado = {"email": "a@x.com", "senha": "errada-errada-1"}
    assert cliente.post("/api/auth/entrar", json=errado).status_code == 401
    certo = {"email": "a@x.com", "senha": CADASTRO["senha"]}
    assert cliente.post("/api/auth/entrar", json=certo).status_code == 200
    assert cliente.get("/api/auth/eu").status_code == 200


def test_bloqueia_na_sexta_tentativa_errada(cliente):
    cliente.post("/api/auth/cadastro", json=CADASTRO)
    errado = {"email": "a@x.com", "senha": "errada-errada-1"}
    codigos = [cliente.post("/api/auth/entrar", json=errado).status_code for _ in range(6)]
    assert codigos == [401, 401, 401, 401, 401, 429]


def test_eu_sem_sessao_da_401(cliente):
    assert cliente.get("/api/auth/eu").status_code == 401
