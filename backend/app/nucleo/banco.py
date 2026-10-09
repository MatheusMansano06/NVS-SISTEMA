from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Connection, Engine, create_engine, text

from app.nucleo.configuracao import configuracao


@lru_cache
def motor() -> Engine:
    return create_engine(configuracao().url_app, pool_size=5, max_overflow=5, pool_pre_ping=True)


def definir_empresa(conn: Connection, empresa_id: str) -> None:
    conn.execute(text("select set_config('app.empresa_id', :v, true)"), {"v": empresa_id})


@contextmanager
def transacao(empresa_id: str | None = None) -> Iterator[Connection]:
    with motor().begin() as conn:
        if empresa_id:
            definir_empresa(conn, empresa_id)
        yield conn
