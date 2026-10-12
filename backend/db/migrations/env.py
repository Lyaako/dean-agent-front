"""Apply versioned SQL as the separate migration owner."""

import os

from alembic import context
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool


engine = create_engine(os.environ["DATABASE_URL"], poolclass=NullPool)
with engine.connect() as connection, connection.begin():
    connection.execute(text("SET LOCAL ROLE backend_migration"))
    context.configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()

