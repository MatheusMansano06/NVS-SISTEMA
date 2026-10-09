from alembic import context
from sqlalchemy import create_engine

from app.nucleo.configuracao import configuracao

with create_engine(configuracao().database_url).connect() as conexao:
    context.configure(connection=conexao, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()
    conexao.commit()
