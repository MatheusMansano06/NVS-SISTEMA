import re
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Configuracao(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NVS_", env_file=".env", extra="ignore")

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

    @property
    def url_app(self) -> str:
        url = make_url(self.database_url).set(username="nvs_app", password=self.app_senha)
        return url.render_as_string(hide_password=False)


@lru_cache
def configuracao() -> Configuracao:
    return Configuracao()
