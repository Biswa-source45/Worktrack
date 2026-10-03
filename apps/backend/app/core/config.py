from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# One .env at the repo root is shared by every app.
ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"


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


@lru_cache
def get_settings() -> Settings:
    return Settings()
