"""
config.py — Application settings for the AcadTrack Facilitator API.
===================================================================
All secrets and environment-specific values are read from environment
variables (or a local `.env` file during development). Nothing sensitive
is ever hard-coded — see `.env.example` for the full list.
"""
from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Database ────────────────────────────────────────────────────────────
    # Full async SQLAlchemy URL to the Supabase Postgres instance, e.g.
    #   postgresql+asyncpg://postgres.<ref>:<password>@<host>:6543/postgres
    # Get it from Supabase → Project Settings → Database → Connection string
    # (use the "Connection pooling" / Transaction URI and swap the scheme to
    # `postgresql+asyncpg`). See .env.example for details.
    DATABASE_URL: str = Field(default="")

    # ── Auth ────────────────────────────────────────────────────────────────
    JWT_SECRET: str = Field(default="change-me-in-production")
    JWT_ALGORITHM: str = Field(default="HS256")
    # 30 days — facilitators stay logged in on their device (matches the old
    # localStorage-based "stay signed in" behaviour).
    JWT_EXPIRE_MINUTES: int = Field(default=60 * 24 * 30)

    # ── CORS ────────────────────────────────────────────────────────────────
    # Comma-separated list of allowed frontend origins. Defaults cover local
    # Next.js dev. Add the deployed web origin in production.
    CORS_ORIGINS: List[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )

    # ── AI / Vision providers (optional — features degrade gracefully) ───────
    GROQ_API_KEY: str = Field(default="")
    GROQ_MODEL: str = Field(default="")
    GROQ_VISION_MODEL: str = Field(default="")
    GEMINI_API_KEY: str = Field(default="")
    GEMINI_MODEL: str = Field(default="")
    GEMINI_VISION_MODEL: str = Field(default="")

    # ── Web Push (VAPID) — optional ─────────────────────────────────────────
    VAPID_PUBLIC_KEY: str = Field(default="")
    VAPID_PRIVATE_KEY: str = Field(default="")
    VAPID_SUBJECT: str = Field(default="mailto:admin@acadtrack.app")

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value):
        """Allow CORS_ORIGINS to be provided as a comma-separated string."""
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
