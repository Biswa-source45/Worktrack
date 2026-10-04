"""One canonical E.164 spelling per phone number, wherever a number comes in."""

from datetime import date

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.employees.schemas import EmployeeCreate, normalize_mobile
from tests.factories import ADMIN, FIELD, OFFICE, PASSWORD, make_user
from tests.modules.auth.test_login import LOGIN
from tests.modules.employees.helpers import EMPLOYEES, actor, error_code, post_employee
from tests.modules.employees.test_import import csv_file, row, upload

INDIA = "+919876543210"
FORMATS = [
    "9876543210",
    "+919876543210",
    "+91 98765 43210",
    "98765-43210",
    "(98765) 43210",
    "09876543210",
    "919876543210",
    "0091 98765 43210",
    "+91.98765.43210",
]


@pytest.mark.parametrize("raw", FORMATS)
def test_every_indian_format_becomes_the_same_number(raw: str) -> None:
    assert normalize_mobile(raw) == INDIA


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+14155552671", "+14155552671"),
        ("001 415 555 2671", "+14155552671"),
        ("+44 20 7946 0958", "+442079460958"),
        ("+12345678", "+12345678"),  # 8 digits, the shortest allowed
        ("+123456789012345", "+123456789012345"),  # 15 digits, the longest allowed
    ],
)
def test_foreign_numbers_are_kept(raw: str, expected: str) -> None:
    assert normalize_mobile(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "12345",
        "5876543210",  # Indian mobiles start with 6-9
        "abc",
        "+0123456789",  # country code cannot start with 0
        "",
        "   ",
        "98765abc10",
        "+1234567",  # 7 digits
        "+1234567890123456",  # 16 digits
        "05876543210",
        "9876543210 ext 5",
        "++919876543210",
        "91 98765 43210 0",
        "٩٨٧٦٥٤٣٢١٠",  # non-ASCII digits are not accepted
    ],
)
def test_invalid_numbers_are_rejected(raw: str) -> None:
    with pytest.raises(ValueError, match="Enter a valid mobile number"):
        normalize_mobile(raw)


def test_the_admin_script_path_stores_the_canonical_number() -> None:
    # scripts/create_admin.py builds an EmployeeCreate, so it gets the same normalisation.
    data = EmployeeCreate(
        emp_code="admin-1",
        name="Admin",
        mobile="098765 43210",
        designation_id=1,
        role_id=1,
        joined_on=date(2026, 1, 1),
    )
    assert data.mobile == INDIA


# --- uniqueness across formats ----------------------------------------------------------------


async def test_create_rejects_the_same_number_in_another_format(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    first = await post_employee(client, db, headers, mobile="9876543210")
    assert first.status_code == 201
    assert first.json()["employee"]["mobile"] == INDIA
    for other in FORMATS:
        second = await post_employee(client, db, headers, mobile=other)
        assert second.status_code == 409, other
        assert error_code(second) == "DUPLICATE"
        assert second.json()["error"]["details"] == {"fields": ["mobile"]}


async def test_patch_rejects_a_number_that_collides_in_another_format(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_user(db, FIELD, mobile="9876543210")
    target = await make_user(db, FIELD)
    response = await client.patch(
        f"{EMPLOYEES}/{target.id}", json={"mobile": "+91 98765 43210"}, headers=headers
    )
    assert response.status_code == 409
    assert response.json()["error"]["details"] == {"fields": ["mobile"]}


async def test_patch_stores_the_canonical_number(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(
        f"{EMPLOYEES}/{target.id}", json={"mobile": "09123456780"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["mobile"] == "+919123456780"


async def test_import_rejects_a_number_already_stored_in_another_format(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_user(db, OFFICE, mobile="9876543210")
    body = (
        await upload(client, headers, csv_file([row(mobile="+91 98765-43210")]), dry_run=True)
    ).json()
    assert [(e["row"], e["message"].split(":")[0]) for e in body["errors"]] == [(2, "mobile")]


async def test_import_rejects_two_formats_of_one_number_inside_the_file(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    rows = [row(mobile="9876543210"), row(mobile="+919876543210"), row(mobile="09876543210")]
    body = (await upload(client, headers, csv_file(rows), dry_run=False)).json()
    assert body["created"] == 0
    assert [(e["row"], e["message"].split(":")[0]) for e in body["errors"]] == [
        (3, "mobile"),
        (4, "mobile"),
    ]


async def test_import_stores_the_canonical_number(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    body = (
        await upload(
            client, headers, csv_file([row(emp_code="CAN-1", mobile="98765 43210")]), dry_run=False
        )
    ).json()
    assert body["errors"] == []
    listing = await client.get(EMPLOYEES, params={"q": "CAN-1"}, headers=headers)
    assert [e["mobile"] for e in listing.json()["items"]] == ["+919876543210"]


# --- login ------------------------------------------------------------------------------------


@pytest.mark.parametrize("identifier", FORMATS)
async def test_login_works_with_every_format_of_the_stored_number(
    client: httpx.AsyncClient, db: AsyncSession, identifier: str
) -> None:
    user = await make_user(db, ADMIN, mobile=INDIA)
    assert user.mobile == INDIA
    response = await client.post(
        LOGIN, json={"identifier": identifier, "password": PASSWORD, "client": "web"}
    )
    assert response.status_code == 200


async def test_an_employee_code_that_is_not_a_mobile_number_still_logs_in(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, ADMIN, emp_code="ADMIN-01", mobile=INDIA)
    response = await client.post(
        LOGIN, json={"identifier": "admin-01", "password": PASSWORD, "client": "web"}
    )
    assert response.status_code == 200


async def test_a_different_number_does_not_log_in(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, ADMIN, mobile=INDIA)
    response = await client.post(
        LOGIN, json={"identifier": "9876543211", "password": PASSWORD, "client": "web"}
    )
    assert response.status_code == 401
