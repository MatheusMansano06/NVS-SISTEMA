from collections.abc import Iterator
from urllib.parse import urlencode

import httpx

from app.nucleo.configuracao import configuracao

API = "https://api.mercadolibre.com"


class RefreshInvalido(Exception):
    pass


def cliente_http() -> Iterator[httpx.Client]:
    with httpx.Client(timeout=10) as http:
        yield http


def url_autorizacao(state: str) -> str:
    c = configuracao()
    consulta = urlencode({"response_type": "code", "client_id": c.ml_client_id,
                          "redirect_uri": c.ml_redirect_uri, "state": state})
    return f"https://auth.mercadolivre.com.br/authorization?{consulta}"


def _token(http: httpx.Client, dados: dict) -> httpx.Response:
    c = configuracao()
    return http.post(f"{API}/oauth/token", headers={"accept": "application/json"},
                     data={"client_id": c.ml_client_id, "client_secret": c.ml_client_secret, **dados})


def trocar_codigo(http: httpx.Client, code: str) -> dict:
    r = _token(http, {"grant_type": "authorization_code", "code": code,
                      "redirect_uri": configuracao().ml_redirect_uri})
    r.raise_for_status()
    return r.json()


def renovar(http: httpx.Client, refresh_token: str) -> dict:
    r = _token(http, {"grant_type": "refresh_token", "refresh_token": refresh_token})
    if r.status_code == 400 and r.json().get("error") == "invalid_grant":
        raise RefreshInvalido
    r.raise_for_status()
    return r.json()


def perfil(http: httpx.Client, access_token: str) -> dict:
    r = http.get(f"{API}/users/me", headers={"Authorization": f"Bearer {access_token}"})
    r.raise_for_status()
    return r.json()
