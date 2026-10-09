from sqlalchemy import Connection, text

from app.nucleo import senhas

_HASH_FALSO = senhas.gerar("hash-para-igualar-o-tempo")


def cadastrar(conn: Connection, email: str, senha: str, nome_empresa: str) -> tuple[str, str]:
    usuario_id = str(conn.execute(text(
        "insert into usuarios(email, senha_hash) values (:e, :h) returning id"),
        {"e": email, "h": senhas.gerar(senha)}).scalar_one())
    empresa_id = str(conn.execute(text(
        "insert into empresas(nome) values (:n) returning id"), {"n": nome_empresa}).scalar_one())
    conn.execute(text(
        "insert into membros(usuario_id, empresa_id, papel) "
        "values (cast(:u as uuid), cast(:e as uuid), 'dono')"), {"u": usuario_id, "e": empresa_id})
    return usuario_id, empresa_id


def autenticar(conn: Connection, email: str, senha: str) -> str | None:
    linha = conn.execute(text("select id, senha_hash from usuarios where email = :e"), {"e": email}).first()
    if linha is None:
        senhas.conferir(_HASH_FALSO, senha)
        return None
    return str(linha.id) if senhas.conferir(linha.senha_hash, senha) else None


def perfil(conn: Connection, usuario_id: str) -> dict:
    email = conn.execute(text("select email from usuarios where id = cast(:u as uuid)"),
                         {"u": usuario_id}).scalar_one()
    empresas = conn.execute(text(
        "select e.id::text as id, e.nome, m.papel from membros m join empresas e on e.id = m.empresa_id "
        "where m.usuario_id = cast(:u as uuid) order by e.nome"), {"u": usuario_id}).mappings().all()
    return {"email": email, "empresas": [dict(e) for e in empresas]}
