import pytest
from pydantic import ValidationError

from app.core.config import Settings

BASE = {
    "app_env": "development",
    "database_url": "postgresql+asyncpg://u:p@h/d",
    "redis_url": "redis://h/0",
    "s3_endpoint_url": "http://h:9000",
    "s3_access_key": "k",
    "s3_secret_key": "s",
    "s3_bucket": "b",
    "jwt_secret": "x" * 40,
}


def make(**overrides: object) -> Settings:
    return Settings(_env_file=None, **{**BASE, **overrides})  # type: ignore[arg-type]


def test_mock_location_is_allowed_in_development() -> None:
    assert make(allow_mock_location=True).allow_mock_location is True


def test_mock_location_defaults_to_off() -> None:
    assert make().allow_mock_location is False


def test_production_refuses_mock_location() -> None:
    with pytest.raises(ValidationError, match="ALLOW_MOCK_LOCATION"):
        make(app_env="production", allow_mock_location=True)


def test_production_starts_with_dev_switches_off() -> None:
    assert make(app_env="production").app_env == "production"


def test_unknown_environment_is_rejected() -> None:
    with pytest.raises(ValidationError):
        make(app_env="staging")


def test_cors_origins_are_split_on_commas() -> None:
    settings = make(cors_origins="http://localhost:3000, https://admin.example.com")
    assert settings.cors_origins == ["http://localhost:3000", "https://admin.example.com"]


def test_short_jwt_secret_is_rejected() -> None:
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        make(jwt_secret="short")


def test_production_rejects_the_example_jwt_secret() -> None:
    with pytest.raises(ValidationError, match="placeholder"):
        make(app_env="production", jwt_secret="dev-only-" + "x" * 40)
