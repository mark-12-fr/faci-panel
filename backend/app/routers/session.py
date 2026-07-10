"""
session.py — Facilitator session heartbeat logging (facilitator_logs).
=====================================================================
Port of faci-session.js: open a log row on session start (time_in) and stamp
time_out on heartbeats / page hide. IDs are the table's serial integer.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Facilitator, FacilitatorLog
from ..schemas import SessionOpenResponse
from ..security import get_current_faci

router = APIRouter(prefix="/api/faci/session", tags=["session"])


@router.post("", response_model=SessionOpenResponse)
async def open_session(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    log = FacilitatorLog(facilitator_id=faci.id, time_in=datetime.now(timezone.utc))
    db.add(log)
    await db.commit()
    await db.refresh(log)
    return SessionOpenResponse(id=log.id)


@router.patch("/{log_id}")
async def stamp_out(
    log_id: int,
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    # Only stamp out the caller's own log rows.
    result = await db.execute(
        select(FacilitatorLog).where(
            FacilitatorLog.id == log_id,
            FacilitatorLog.facilitator_id == faci.id,
        )
    )
    log = result.scalar_one_or_none()
    if log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Log not found.")
    await db.execute(
        update(FacilitatorLog)
        .where(FacilitatorLog.id == log_id)
        .values(time_out=datetime.now(timezone.utc))
    )
    await db.commit()
    return {"ok": True}
