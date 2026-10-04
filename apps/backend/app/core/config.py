from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# One .env at the repo root is shared by every app.
ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"
PLACEHOLDER_PREFIX = "dev-only-"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    app_env: Literal["development", "test", "production"]
    database_url: str
    redis_url: str
    s3_endpoint_url: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    s3_region: str = "us-east-1"
    cors_origins: Annotated[list[str], NoDecode] = []
    allow_mock_location: bool = False
    jwt_secret: str
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    login_max_failures: int = 5
    login_lock_minutes: int = 15
    login_ip_limit: int = 20
    login_ip_window_minutes: int = 15
    # Ended sign-in sessions are kept this long for the admin's sessions list, then deleted.
    session_retention_days: int = 90

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @model_validator(mode="after")
    def _no_dev_switches_in_production(self) -> Self:
        # Invariant 8: dev-only switches must never be on in production.
        if self.app_env == "production" and self.allow_mock_location:
            raise ValueError("ALLOW_MOCK_LOCATION must be false when APP_ENV=production")
        return self

    @model_validator(mode="after")
    def _strong_jwt_secret(self) -> Self:
        # HS256 needs a 256-bit key; the .env.example placeholder must never reach production.
        if len(self.jwt_secret) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters")
        if self.app_env == "production" and self.jwt_secret.startswith(PLACEHOLDER_PREFIX):
            raise ValueError("JWT_SECRET must be changed from the .env.example placeholder")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
