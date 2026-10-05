from datetime import datetime

from geoalchemy2 import Geography, Geometry, WKBElement, WKTElement
from sqlalchemy import CheckConstraint, Float, Index, String, cast, func, true
from sqlalchemy.orm import Mapped, column_property, mapped_column

from app.core.db import Base

RADIUS_MIN_M = 30
RADIUS_MAX_M = 500


class Branch(Base):
    __tablename__ = "branches"
    __table_args__ = (
        CheckConstraint(f"radius_m BETWEEN {RADIUS_MIN_M} AND {RADIUS_MAX_M}", name="radius_m"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(String(255))
    # Geography, not geometry: distances come out in metres. The type adds the GiST index.
    # Written as WKT, read back as WKB.
    location: Mapped[WKBElement | WKTElement] = mapped_column(Geography("POINT", srid=4326))
    radius_m: Mapped[int]
    is_active: Mapped[bool] = mapped_column(default=True, server_default=true())
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    # Read in the same SELECT as the row, so the API never parses WKB in Python.
    lat: Mapped[float] = column_property(
        func.ST_Y(cast(location, Geometry("POINT", srid=4326)), type_=Float)
    )
    lng: Mapped[float] = column_property(
        func.ST_X(cast(location, Geometry("POINT", srid=4326)), type_=Float)
    )


Index("uq_branches_name_lower", func.lower(Branch.name), unique=True)
