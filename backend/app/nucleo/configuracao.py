import base64
import binascii
import re
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Configuracao(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NVS_", env_file=".env", extra="ignore",
                                      hide_input_in_errors=True)

    database_url: str
    app_senha: str
    segredo_sessao: str
    chaves_token: str
    ml_client_id: str = ""
    ml_client_secret: str = ""
    ml_redirect_uri: str = ""
    cookie_seguro: bool = True
    frontend_url: str = "/"

    @field_validator("database_url")
    @classmethod
    def _driver(cls, v: str) -> str:
        return re.sub(r"^postgres(ql)?://", "postgresql+psycopg://", v)

    @field_validator("segredo_sessao")
    @classmethod
    def _segredo(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("segredo_sessao precisa ter ao menos 32 caracteres")
        return v

    @field_validator("chaves_token")
    @classmethod
    def _chaves(cls, v: str) -> str:
        for item in v.split(","):
            versao, _, chave = item.partition(":")
            try:
                int(versao)
                tamanho = len(base64.b64decode(chave, validate=True))
            except (ValueError, binascii.Error):
                raise ValueError("chaves_token deve ser <int>:<base64>,... ") from None
            if tamanho != 32:
                raise ValueError("cada chave de chaves_token deve ter exatamente 32 bytes")
        return v

    @property
    def url_app(self) -> str:
        url = make_url(self.database_url).set(username="nvs_app", password=self.app_senha)
        return url.render_as_string(hide_password=False)


@lru_cache
def configuracao() -> Configuracao:
    return Configuracao()
