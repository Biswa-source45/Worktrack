import csv
import io
import itertools
import json
from datetime import date
from typing import Any

import httpx
import pytest
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.employees.models import User
from tests.factories import (
    ADMIN,
    ASSIGNER,
    FIELD,
    OFFICE,
    SUPER_ADMIN,
    login,
    make_department,
    make_user,
)
from tests.modules.employees.helpers import EMPLOYEES, actor, audit_rows, error_code

IMPORT = f"{EMPLOYEES}/import"
HEADER = [
    "emp_code",
    "name",
    "mobile",
    "email",
    "designation",
    "department",
    "role",
    "manager_emp_code",
    "joined_on",
    "field_eligible",
]
_counter = itertools.count(1)


def row(**overrides: Any) -> list[Any]:
    """One valid data row (unique code, mobile and email) with the given columns overridden."""
    n = next(_counter)
    values: dict[str, Any] = {
        "emp_code": f"IMP{n:04d}",
        "name": f"Imported Person {n}",
        "mobile": f"7{n:09d}",
        "email": f"imp{n}@example.com",
        "designation": "Engineer",
        "department": "",
        "role": FIELD,
        "manager_emp_code": "",
        "joined_on": "2026-03-01",
        "field_eligible": "yes",
        **overrides,
    }
    return [values[column] for column in HEADER]


def csv_file(rows: list[list[Any]], header: list[str] | None = None) -> bytes:
    out = io.StringIO()
    csv.writer(out).writerows([header or HEADER, *rows])
    return out.getvalue().encode()


def xlsx_file(rows: list[list[Any]], header: list[str] | None = None) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    for r in [header or HEADER, *rows]:
        sheet.append(r)
    out = io.BytesIO()
    workbook.save(out)
    return out.getvalue()


async def upload(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    content: bytes,
    filename: str = "people.csv",
    dry_run: bool | None = None,
) -> httpx.Response:
    params = {} if dry_run is None else {"dry_run": str(dry_run).lower()}
    return await client.post(
        IMPORT, params=params, files={"file": (filename, content)}, headers=headers
    )


async def user_count(db: AsyncSession) -> int:
    return int(await db.scalar(select(func.count()).select_from(User)) or 0)


async def by_code(db: AsyncSession, code: str) -> User | None:
    return (await db.execute(select(User).where(User.emp_code == code))).scalar_one_or_none()


# --- template ---------------------------------------------------------------------------------


async def test_template_is_a_csv_with_the_expected_columns(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(f"{IMPORT}/template", headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert next(csv.reader(io.StringIO(response.text))) == HEADER


# --- dry run and commit -----------------------------------------------------------------------


@pytest.mark.parametrize("dry_run", [None, True])
async def test_dry_run_validates_without_inserting(
    client: httpx.AsyncClient, db: AsyncSession, dry_run: bool | None
) -> None:
    _, headers = await actor(client, db)
    before = await user_count(db)
    rows = [row(), row()]
    response = await upload(client, headers, csv_file(rows), dry_run=dry_run)
    assert response.status_code == 200
    assert response.json() == {
        "dry_run": True,
        "total_rows": 2,
        "created": 0,
        "errors": [],
        "credentials": [],
    }
    assert await user_count(db) == before
    assert await audit_rows(db, "employee.import") == []


async def test_commit_creates_users_and_returns_working_credentials(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db, "Imported Dept")
    rows = [
        row(emp_code="imp-a", email="Imp.A@Example.com", department="imported dept"),
        row(emp_code="IMP-B", field_eligible="no", email=""),
        row(emp_code="IMP-C", field_eligible="TRUE", role=OFFICE.upper()),
    ]
    response = await upload(client, headers, csv_file(rows), dry_run=False)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["dry_run"], body["total_rows"], body["created"], body["errors"]) == (
        False,
        3,
        3,
        [],
    )
    creds = {c["emp_code"]: c for c in body["credentials"]}
    assert set(creds) == {"IMP-A", "IMP-B", "IMP-C"}
    assert all(len(c["temporary_password"]) == 12 for c in creds.values())
    assert len({c["temporary_password"] for c in creds.values()}) == 3

    a = await by_code(db, "IMP-A")
    b = await by_code(db, "IMP-B")
    c = await by_code(db, "IMP-C")
    assert a is not None
    assert b is not None
    assert c is not None
    assert a.email == "imp.a@example.com"
    assert a.department_id == dept.id
    assert (a.field_eligible, b.field_eligible, c.field_eligible) == (True, False, True)
    assert c.role.name == OFFICE
    assert all(u.must_change_password for u in (a, b, c))
    assert b.email is None

    for user in (a, b):
        first_login = await login(
            client, user, password=creds[user.emp_code]["temporary_password"], kind="mobile"
        )
        assert first_login.status_code == 200
        assert first_login.json()["must_change_password"] is True


async def test_manager_can_be_an_existing_user_or_an_earlier_row(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    existing = await make_user(db, ASSIGNER, emp_code="BOSS-1")
    rows = [
        row(emp_code="TOP-1", manager_emp_code="boss-1"),
        row(emp_code="MID-1", manager_emp_code="top-1"),
        row(emp_code="LOW-1", manager_emp_code="MID-1"),
    ]
    response = await upload(client, headers, csv_file(rows), dry_run=False)
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 3
    top = await by_code(db, "TOP-1")
    mid = await by_code(db, "MID-1")
    low = await by_code(db, "LOW-1")
    assert top is not None
    assert mid is not None
    assert low is not None
    assert top.manager_id == existing.id
    assert mid.manager_id == top.id
    assert low.manager_id == mid.id


async def test_manager_listed_later_in_the_file_is_not_found(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    rows = [row(emp_code="EARLY-1", manager_emp_code="LATE-1"), row(emp_code="LATE-1")]
    body = (await upload(client, headers, csv_file(rows), dry_run=False)).json()
    assert body["created"] == 0
    assert [e["row"] for e in body["errors"]] == [2]
    assert "manager_emp_code" in body["errors"][0]["message"]


async def test_xlsx_with_numeric_and_date_cells(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    rows = [
        row(emp_code="XL-1", mobile=9876543210.0, joined_on=date(2026, 4, 5), field_eligible=True),
        row(emp_code="XL-2", mobile=9876543211, joined_on=date(2026, 4, 6), field_eligible=False),
    ]
    response = await upload(client, headers, xlsx_file(rows), "people.XLSX", dry_run=False)
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 2
    one = await by_code(db, "XL-1")
    two = await by_code(db, "XL-2")
    assert one is not None
    assert two is not None
    assert (one.mobile, one.joined_on, one.field_eligible) == ("9876543210", date(2026, 4, 5), True)
    assert (two.mobile, two.field_eligible) == ("9876543211", False)


async def test_csv_with_bom_odd_headers_and_blank_lines(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    header = ["Emp Code", "NAME", "Mobile", "Email", "Designation", "Department", "Role"]
    header += ["Manager Emp Code", "Joined On", "Field Eligible"]
    content = b"\xef\xbb\xbf" + csv_file([row(), [""] * 10, row(emp_code="BAD CODE!")], header)
    body = (await upload(client, headers, content, dry_run=True)).json()
    assert body["total_rows"] == 2  # the blank line is skipped
    assert [e["row"] for e in body["errors"]] == [4]  # but spreadsheet row numbers are kept


async def test_header_only_file_imports_nothing(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    body = (await upload(client, headers, csv_file([]), dry_run=False)).json()
    assert (body["total_rows"], body["created"], body["errors"]) == (0, 0, [])


async def test_exactly_100_rows_are_accepted(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, csv_file([row() for _ in range(100)]), dry_run=True)
    assert response.status_code == 200
    assert response.json()["total_rows"] == 100
    assert response.json()["errors"] == []


# --- all-or-nothing and row errors ------------------------------------------------------------


async def test_commit_with_an_invalid_row_inserts_nothing(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    before = await user_count(db)
    rows = [row(emp_code="OK-1"), row(emp_code="OK-2"), row(role="No Such Role")]
    response = await upload(client, headers, csv_file(rows), dry_run=False)
    assert response.status_code == 200
    body = response.json()
    assert body["created"] == 0
    assert body["credentials"] == []
    assert [e["row"] for e in body["errors"]] == [4]
    assert await user_count(db) == before
    assert await audit_rows(db, "employee.import") == []
    assert await audit_rows(db, "employee.create") == []


@pytest.mark.parametrize(
    ("overrides", "needle"),
    [
        ({"designation": "Wizard"}, "designation"),
        ({"department": "Nowhere"}, "department"),
        ({"role": "Nope"}, "role"),
        ({"manager_emp_code": "GHOST-1"}, "manager_emp_code"),
        ({"mobile": "123"}, "mobile"),
        ({"email": "not-an-email"}, "email"),
        ({"joined_on": "yesterday"}, "joined_on"),
        ({"emp_code": "bad code!"}, "emp_code"),
        ({"name": ""}, "name"),
    ],
)
async def test_row_level_validation_errors(
    client: httpx.AsyncClient, db: AsyncSession, overrides: dict[str, Any], needle: str
) -> None:
    _, headers = await actor(client, db)
    rows = [row(), row(**overrides)]
    body = (await upload(client, headers, csv_file(rows), dry_run=True)).json()
    assert body["created"] == 0
    assert [e["row"] for e in body["errors"]] == [3]
    assert needle in body["errors"][0]["message"]


async def test_inactive_existing_manager_is_not_accepted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_user(db, ASSIGNER, emp_code="OLD-BOSS", status="inactive")
    body = (
        await upload(client, headers, csv_file([row(manager_emp_code="OLD-BOSS")]), dry_run=True)
    ).json()
    assert [e["row"] for e in body["errors"]] == [2]


async def test_duplicates_inside_the_file_are_reported_on_the_later_row(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    first = row(emp_code="SAME-1", mobile="7000000001", email="same@example.com")
    clones = [
        row(emp_code="same-1"),
        row(mobile="7000000001"),
        row(email="SAME@example.com"),
    ]
    body = (await upload(client, headers, csv_file([first, *clones]), dry_run=True)).json()
    assert [(e["row"], e["message"].split(":")[0]) for e in body["errors"]] == [
        (3, "emp_code"),
        (4, "mobile"),
        (5, "email"),
    ]


async def test_duplicates_against_existing_users_are_reported(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_user(db, OFFICE, emp_code="TAKEN-1", mobile="7000000002", email="taken@example.com")
    rows = [
        row(emp_code="taken-1"),
        row(mobile="7000000002"),
        row(email="TAKEN@example.com"),
    ]
    body = (await upload(client, headers, csv_file(rows), dry_run=False)).json()
    assert body["created"] == 0
    assert [(e["row"], e["message"].split(":")[0]) for e in body["errors"]] == [
        (2, "emp_code"),
        (3, "mobile"),
        (4, "email"),
    ]


async def test_a_row_can_have_several_errors(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    body = (
        await upload(
            client, headers, csv_file([row(role="Nope", designation="Nope")]), dry_run=True
        )
    ).json()
    assert [e["row"] for e in body["errors"]] == [2, 2]


async def test_admin_cannot_import_a_role_with_more_access(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ADMIN)
    body = (await upload(client, headers, csv_file([row(role=SUPER_ADMIN)]), dry_run=False)).json()
    assert body["created"] == 0
    assert "cannot assign" in body["errors"][0]["message"]


async def test_super_admin_can_import_a_super_admin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    body = (await upload(client, headers, csv_file([row(role=SUPER_ADMIN)]), dry_run=False)).json()
    assert body["created"] == 1


# --- bad files ---------------------------------------------------------------------------------


async def test_missing_required_column_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    header = [c for c in HEADER if c != "mobile"]
    content = csv_file([[v for c, v in zip(HEADER, row(), strict=True) if c != "mobile"]], header)
    response = await upload(client, headers, content)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_FILE"
    assert "mobile" in response.json()["error"]["message"]


@pytest.mark.parametrize("filename", ["people.txt", "people.xls", "people", "people.csv.exe"])
async def test_wrong_extension_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, filename: str
) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, csv_file([row()]), filename)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_FILE"


async def test_empty_file_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, b"")
    assert response.status_code == 422
    assert error_code(response) == "INVALID_FILE"


async def test_non_utf8_csv_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, b"emp_code,name\n\xe9\xff,x\n")
    assert response.status_code == 422
    assert error_code(response) == "INVALID_FILE"


@pytest.mark.parametrize("content", [b"this is not a workbook", b"PK\x03\x04garbage"])
async def test_corrupt_xlsx_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, content: bytes
) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, content, "people.xlsx")
    assert response.status_code == 422
    assert error_code(response) == "INVALID_FILE"


async def test_more_than_100_rows_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, csv_file([row() for _ in range(101)]), dry_run=False)
    assert response.status_code == 422
    assert error_code(response) == "TOO_MANY_ROWS"


async def test_file_over_1_mb_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await upload(client, headers, b"a" * 1_000_001)
    assert response.status_code == 413
    assert error_code(response) == "FILE_TOO_LARGE"


async def test_missing_file_field_is_a_validation_error(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(IMPORT, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


# --- audit and permissions --------------------------------------------------------------------


async def test_import_is_audited_and_credentials_are_never_stored(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    response = await upload(client, headers, csv_file([row(), row()]), "march.csv", dry_run=False)
    credentials = response.json()["credentials"]
    assert len(credentials) == 2

    (summary,) = await audit_rows(db, "employee.import")
    assert summary.actor_id == admin.id
    assert summary.after == {"file": "march.csv", "created": 2}
    assert len(await audit_rows(db, "employee.create")) == 2

    stored = json.dumps(
        [[r.before, r.after] for r in (await db.execute(select(AuditLog))).scalars()]
    )
    for credential in credentials:
        assert credential["temporary_password"] not in stored


async def test_import_endpoints_need_employees_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    before = await user_count(db)
    assert (await upload(client, headers, csv_file([row()]), dry_run=False)).status_code == 403
    assert (await client.get(f"{IMPORT}/template", headers=headers)).status_code == 403
    assert (await upload(client, {}, csv_file([row()]))).status_code == 401
    assert (await client.get(f"{IMPORT}/template")).status_code == 401
    assert await user_count(db) == before
