import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from app.core.config import get_settings
from app.core.db import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Model modules are imported here as they are added, so autogenerate sees them.
from app.modules.audit import models as _audit  # noqa: E402, F401
from app.modules.auth import models as _auth  # noqa: E402, F401
from app.modules.branches import models as _branches  # noqa: E402, F401
from app.modules.devices import models as _devices  # noqa: E402, F401
from app.modules.employees import models as _employees  # noqa: E402, F401
from app.modules.face import models as _face  # noqa: E402, F401
from app.modules.org_settings import models as _org_settings  # noqa: E402, F401
from app.modules.schedule import models as _schedule  # noqa: E402, F401
from app.modules.shifts import models as _shifts  # noqa: E402, F401

target_metadata = Base.metadata
database_url = get_settings().database_url


def run_migrations_offline() -> None:
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def include_object(obj: object, name: str | None, type_: str, *_: object) -> bool:
    # spatial_ref_sys belongs to PostGIS, not to our models.
    return not (type_ == "table" and name == "spatial_ref_sys")


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection, target_metadata=target_metadata, include_object=include_object
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = create_async_engine(database_url, poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_async_migrations())
