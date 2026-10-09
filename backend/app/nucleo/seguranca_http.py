from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.nucleo.sessao import COOKIE, ler

WEBHOOK_ML = "/api/ml/notificacoes"
PUBLICAS = {"/api/saude", "/api/auth/cadastro", "/api/auth/entrar", WEBHOOK_ML}
ESCRITA = {"POST", "PUT", "PATCH", "DELETE"}
CABECALHOS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}


class SegurancaHttp(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        caminho = request.url.path
        # o webhook do ML vem de fora do navegador e não carrega o cabeçalho
        if (request.method in ESCRITA and caminho != WEBHOOK_ML
                and request.headers.get("x-requested-with") != "nvs"):
            resposta = JSONResponse({"detail": "csrf"}, status_code=403)
        elif (caminho.startswith("/api/") and caminho not in PUBLICAS
                and ler(request.cookies.get(COOKIE)) is None):
            resposta = JSONResponse({"detail": "nao autenticado"}, status_code=401)
        else:
            resposta = await call_next(request)
        resposta.headers.update(CABECALHOS)
        return resposta
