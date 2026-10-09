from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError

from app.modulos.autenticacao import autenticacao_servico as servico
from app.modulos.autenticacao.autenticacao_esquemas import Cadastro, Entrada
from app.nucleo import limitador, sessao
from app.nucleo.auditoria import registrar
from app.nucleo.banco import definir_empresa, transacao
from app.nucleo.configuracao import configuracao
from app.nucleo.dependencias import usuario_atual

router = APIRouter(prefix="/api/auth")


def _definir_cookie(resp: Response, usuario_id: str) -> None:
    resp.set_cookie(sessao.COOKIE, sessao.emitir(usuario_id), max_age=sessao.IDADE_SEGUNDOS,
                    httponly=True, samesite="lax", secure=configuracao().cookie_seguro)


@router.post("/cadastro", status_code=201)
def cadastro(dados: Cadastro, resp: Response, request: Request) -> dict:
    ip = request.client.host if request.client else None
    try:
        with transacao() as conn:
            usuario_id, empresa_id = servico.cadastrar(conn, dados.email, dados.senha, dados.nome_empresa)
            definir_empresa(conn, empresa_id)
            registrar(conn, "cadastro", usuario_id, empresa_id, "empresa", empresa_id, ip=ip)
    except IntegrityError:
        raise HTTPException(409, "e-mail ja cadastrado") from None
    _definir_cookie(resp, usuario_id)
    return {"usuario_id": usuario_id, "empresa_id": empresa_id}


@router.post("/entrar")
def entrar(dados: Entrada, resp: Response, request: Request) -> dict:
    ip = request.client.host if request.client else "?"
    email = dados.email.lower()
    chave = f"{ip}:{email}"
    # o limite só por e-mail barra quem troca de IP para adivinhar a senha de uma conta
    if not limitador.permitido(chave) or not limitador.permitido(f"email:{email}", 20):
        raise HTTPException(429, "muitas tentativas")
    with transacao() as conn:
        usuario_id = servico.autenticar(conn, dados.email, dados.senha)
        if usuario_id:
            registrar(conn, "login", usuario_id, ip=ip)
    if usuario_id is None:
        raise HTTPException(401, "credenciais invalidas")
    limitador.limpar(chave)
    _definir_cookie(resp, usuario_id)
    return {"usuario_id": usuario_id}


@router.get("/eu")
def eu(usuario_id: str = Depends(usuario_atual)) -> dict:
    with transacao() as conn:
        return servico.perfil(conn, usuario_id)
