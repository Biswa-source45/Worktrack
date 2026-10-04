"""Create the first Super Admin (the only way to bootstrap an empty system).

    uv run python scripts/create_admin.py --emp-code ADMIN-1 --name "Full Name" --mobile 9876543210

The password comes from WORKTRACK_ADMIN_PASSWORD or a prompt. The first login forces a change.
"""

import argparse
import asyncio
import getpass
import os
import sys
from datetime import date
from pathlib import Path

# `python scripts/x.py` puts scripts/ on the path, not the backend root that holds `app`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.errors import AppError
from app.modules.audit.service import AuditCtx
from app.modules.auth.permissions import SUPER_ADMIN_ROLE
from app.modules.employees.models import Designation, Role
from app.modules.employees.schemas import EmployeeCreate
from app.modules.employees.service import create_employee


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--emp-code", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--mobile", required=True)
    parser.add_argument("--email")
    parser.add_argument("--designation", default="MD", help="an existing designation (default MD)")
    args = parser.parse_args()

    password = os.environ.get("WORKTRACK_ADMIN_PASSWORD") or getpass.getpass("Password: ")
    engine = create_async_engine(get_settings().database_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            role_id = await session.scalar(select(Role.id).where(Role.name == SUPER_ADMIN_ROLE))
            designation_id = await session.scalar(
                select(Designation.id).where(Designation.name == args.designation)
            )
            if role_id is None or designation_id is None:
                print("Run the migrations first (alembic upgrade head).", file=sys.stderr)
                return 1
            try:
                data = EmployeeCreate(
                    emp_code=args.emp_code,
                    name=args.name,
                    mobile=args.mobile,
                    email=args.email,
                    designation_id=designation_id,
                    role_id=role_id,
                    joined_on=date.today(),
                    password=password,
                )
                user, _ = await create_employee(session, None, AuditCtx(None, "cli"), data)
            except (ValidationError, AppError) as exc:
                print(f"Could not create the admin: {exc}", file=sys.stderr)
                return 1
            print(f"Created Super Admin {user.emp_code} (id {user.id}).")
            return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
