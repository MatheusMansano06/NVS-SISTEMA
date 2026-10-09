from itsdangerous import BadSignature, URLSafeTimedSerializer

from app.nucleo.configuracao import configuracao

COOKIE = "nvs_sessao"
IDADE_SEGUNDOS = 12 * 3600


def _serializador() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(configuracao().segredo_sessao, salt="nvs.sessao")


def emitir(usuario_id: str) -> str:
    return _serializador().dumps({"u": usuario_id})


def ler(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _serializador().loads(token, max_age=IDADE_SEGUNDOS)["u"]
    except BadSignature:
        return None
