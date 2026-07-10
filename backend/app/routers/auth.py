"""
auth.py — Facilitator authentication + self profile.
====================================================
POST /api/faci/login   : verify account_id + bcrypt password → JWT + faci info
GET  /api/faci/me      : current facilitator (used for the account-exists check)
PATCH /api/faci/me     : update own profile (name, avatar, password, status)
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Facilitator
from ..schemas import FaciLoginRequest, FaciLoginResponse, FaciPublic, FaciUpdate
from ..security import (
    create_access_token,
    get_current_faci,
    hash_password,
    verify_password,
)
from ..utils import orm_to_dict

router = APIRouter(prefix="/api/faci", tags=["auth"])


def _faci_public(faci: Facilitator) -> FaciPublic:
    return FaciPublic(
        id=str(faci.id),
        full_name=faci.full_name,
        section=faci.section,
        subject=faci.subject,
        teacher_id=str(faci.teacher_id) if faci.teacher_id else None,
        avatar_url=faci.avatar_url,
        status=faci.status,
        last_login=faci.last_login.isoformat() if faci.last_login else None,
    )


@router.post("/login", response_model=FaciLoginResponse)
async def faci_login(body: FaciLoginRequest, db: AsyncSession = Depends(get_db)):
    account_id = (body.account_id or "").strip()
    password = (body.password or "").strip()
    if not account_id or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Please enter both Facilitator ID and Password.",
        )

    result = await db.execute(
        select(Facilitator).where(Facilitator.account_id == account_id)
    )
    faci = result.scalar_one_or_none()
    if faci is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Account ID.")
    if not verify_password(password, faci.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect Password.")

    # Non-critical login metadata update (matches the legacy behaviour).
    faci.last_login = datetime.now(timezone.utc)
    faci.status = "Active"
    await db.commit()
    await db.refresh(faci)

    token = create_access_token(str(faci.id))
    return FaciLoginResponse(
        message="Login successful",
        token=token,
        faci=_faci_public(faci),
    )


@router.get("/me", response_model=FaciPublic)
async def faci_me(faci: Facilitator = Depends(get_current_faci)):
    return _faci_public(faci)


@router.patch("/me")
async def update_me(
    body: FaciUpdate,
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    if body.full_name is not None:
        faci.full_name = body.full_name
    if body.avatar_url is not None:
        faci.avatar_url = body.avatar_url
    if body.status is not None:
        faci.status = body.status
    if body.password:
        faci.password = hash_password(body.password)
    await db.commit()
    await db.refresh(faci)
    return {"message": "Profile updated", "faci": orm_to_dict(faci) | {"password": None}}


@router.post("/heartbeat")
async def heartbeat(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    """Keep the facilitator marked Active and refresh last_login — the port of
    the pages' periodic `status: 'Active', last_login` update."""
    faci.status = "Active"
    faci.last_login = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True}
