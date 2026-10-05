from datetime import date, timedelta, timezone

from app.core.security import utcnow

# India has one time zone and no daylight saving, so a fixed offset is exact. (zoneinfo would
# need the tzdata package on Windows.)
IST = timezone(timedelta(hours=5, minutes=30), "IST")


def today_ist() -> date:
    """Today's date in India, from the server clock (invariant 1)."""
    return utcnow().astimezone(IST).date()
