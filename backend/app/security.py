"""
security.py — Password hashing (bcrypt) and JWT session tokens.
==============================================================
Facilitator passwords are bcrypt-hashed in the database (created by the old
Flask backend). We verify against those existing hashes unchanged, and when a
new password is set we hash it the same way, so credentials keep working.

On successful login the API issues a signed JWT that the Next.js frontend
stores and sends as `Authorization: Bearer <token>`. Every faci-scoped
endpoint resolves the caller from that token and loads their CURRENT
assignment from the database, so a teacher reassigning or deleting a
facilitator is always respected server-side.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .database import get_db
from .models import Facilitator

_bearer = HTTPBearer(auto_error=False)


# ── Passwords ───────────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: Optional[str]) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# ── JWT ─────────────────────────────────────────────────────────────────────

def create_access_token(faci_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(faci_id),
        "role": "faci",
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired. Please log in again.",
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session token.",
        )


# ── Current-facilitator dependency ──────────────────────────────────────────

async def get_current_faci(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> Facilitator:
    """Resolve the authenticated facilitator from the Bearer token.

    Raises 401 when no/invalid token is supplied, and 404 (surfaced as a hard
    logout by the frontend) when the account no longer exists — mirroring the
    legacy `verifyAccountExists` behaviour.
    """
    if creds is None or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
        )
    payload = _decode_token(creds.credentials)
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")
    try:
        faci_uuid = UUID(str(sub))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")

    result = await db.execute(select(Facilitator).where(Facilitator.id == faci_uuid))
    faci = result.scalar_one_or_none()
    if faci is None:
        # Account was deleted by the teacher — force a logout on the client.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account no longer exists.",
        )
    return faci
