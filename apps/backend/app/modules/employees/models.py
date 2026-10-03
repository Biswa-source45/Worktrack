from datetime import date, datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, false, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base

STATUS_ACTIVE = "active"
STATUS_INACTIVE = "inactive"


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    permissions: Mapped[list[str]] = mapped_column(default=list)
    is_system: Mapped[bool] = mapped_column(default=False, server_default=false())


class Master(Base):
    """Shared shape of the name-only lookup tables."""

    __abstract__ = True

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))


class Department(Master):
    __tablename__ = "departments"


class Designation(Master):
    __tablename__ = "designations"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'inactive')", name="status"),
        CheckConstraint("failed_attempts >= 0", name="failed_attempts"),
        # Same rule as normalize_mobile: one spelling per number, so uniqueness holds.
        CheckConstraint(r"mobile ~ '^\+[1-9][0-9]{7,14}$'", name="mobile_e164"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    emp_code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(120))
    mobile: Mapped[str] = mapped_column(String(16))
    email: Mapped[str | None] = mapped_column(String(254))
    password_hash: Mapped[str] = mapped_column(String(255))
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"))
    designation_id: Mapped[int] = mapped_column(ForeignKey("designations.id"))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    # M2 adds the foreign keys to branches and shifts, which do not exist yet.
    home_branch_id: Mapped[int | None]
    shift_id: Mapped[int | None]
    manager_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    field_eligible: Mapped[bool] = mapped_column(default=False, server_default=false())
    status: Mapped[str] = mapped_column(String(16), default=STATUS_ACTIVE, server_default="active")
    joined_on: Mapped[date]
    must_change_password: Mapped[bool] = mapped_column(default=True, server_default="true")
    failed_attempts: Mapped[int] = mapped_column(default=0, server_default="0")
    locked_until: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    role: Mapped[Role] = relationship(lazy="joined")
    designation: Mapped[Designation] = relationship(lazy="joined")
    department: Mapped[Department | None] = relationship(lazy="joined")


# Case-insensitive uniqueness, so "ENG-1" and "eng-1" cannot both exist.
Index("uq_roles_name_lower", func.lower(Role.name), unique=True)
Index("uq_departments_name_lower", func.lower(Department.name), unique=True)
Index("uq_designations_name_lower", func.lower(Designation.name), unique=True)
Index("uq_users_emp_code_lower", func.lower(User.emp_code), unique=True)
Index("uq_users_mobile", User.mobile, unique=True)
Index("uq_users_email_lower", func.lower(User.email), unique=True)
Index("ix_users_manager_id", User.manager_id)
