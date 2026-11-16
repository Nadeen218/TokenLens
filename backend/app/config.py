"""Simple application configuration loaded from .env."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", extra="ignore")

    database_url: str
    redis_url: str
    jwt_secret_key: str
    access_token_expire_minutes: int = 120

    google_api_key: str | None = None
    azure_api_key: str | None = None
    cors_allowed_origins: str = "*"


settings = Settings()