"""
deps.py — shared helpers for resolving a facilitator's assigned section.
=======================================================================
Server-side port of the frontend `MJR_resolveFaciSection` logic: section
titles can repeat across teachers, so a facilitator's section is always the
one whose `teacher_id` matches theirs. Never falls back to an arbitrary
same-titled row belonging to another teacher.
"""
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Facilitator, Section


async def resolve_section(db: AsyncSession, faci: Facilitator) -> Optional[Section]:
    """Return the Section row assigned to this facilitator, or None."""
    if not faci.section:
        return None
    stmt = select(Section).where(Section.title == faci.section)
    if faci.teacher_id is not None:
        stmt = stmt.where(Section.teacher_id == faci.teacher_id)
    rows = (await db.execute(stmt)).scalars().all()
    if len(rows) == 1:
        return rows[0]
    if not rows:
        return None
    if faci.teacher_id is not None:
        for r in rows:
            if str(r.teacher_id) == str(faci.teacher_id):
                return r
    return None


async def require_section(db: AsyncSession, faci: Facilitator) -> Section:
    """Like resolve_section but raises 404 when the section is unavailable —
    matches the "Section unavailable" state in the legacy UI."""
    section = await resolve_section(db, faci)
    if section is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Your assigned section is no longer available.",
        )
    return section
