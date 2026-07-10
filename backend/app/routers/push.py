"""
push.py — Web Push (VAPID) subscription registration for facilitators.
=====================================================================
Port of MJR_setupPush: upsert the browser's push subscription keyed by its
endpoint, then remove this facilitator's other (stale) endpoints so only the
current device stays subscribed. Sending pushes is done elsewhere (teacher
panel / scheduled jobs); this just keeps subscriptions current.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import and_, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import Facilitator, PushSubscription
from ..schemas import PushSubscribeRequest
from ..security import get_current_faci

router = APIRouter(prefix="/api/faci/push", tags=["push"])


@router.get("/vapid-public-key")
async def vapid_public_key():
    """Expose the VAPID public key so the client can subscribe. Empty when push
    isn't configured (the client then simply skips push, as before)."""
    return {"key": settings.VAPID_PUBLIC_KEY}


@router.post("/subscribe")
async def subscribe(
    body: PushSubscribeRequest,
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    user_id = str(faci.id)
    now = datetime.now(timezone.utc)

    stmt = pg_insert(PushSubscription).values(
        user_type="faci",
        user_id=user_id,
        endpoint=body.endpoint,
        subscription=body.subscription,
        updated_at=now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["endpoint"],
        set_={
            "user_type": "faci",
            "user_id": user_id,
            "subscription": body.subscription,
            "updated_at": now,
        },
    )
    await db.execute(stmt)

    # Drop this facilitator's other endpoints so only the current device stays.
    await db.execute(
        delete(PushSubscription).where(
            and_(
                PushSubscription.user_type == "faci",
                PushSubscription.user_id == user_id,
                PushSubscription.endpoint != body.endpoint,
            )
        )
    )
    await db.commit()
    return {"ok": True}
