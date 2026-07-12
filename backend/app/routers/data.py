"""
data.py — Facilitator-scoped data endpoints.
============================================
Every route derives the caller from the JWT and scopes strictly to that
facilitator's assigned section / teacher, exactly like the legacy client did
(`MJR_resolveFaciSection`, `.eq('teacher_id', ...)`), but enforced server-side.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..deps import require_section, resolve_section
from ..models import (
    CLASS_RECORD_SCORE_FIELDS,
    Attendance,
    ClassRecord,
    Facilitator,
    Profile,
    Section,
    Student,
    Subject,
)
from ..schemas import AttendanceSaveRequest, ClassRecordUpsert
from ..security import get_current_faci
from ..utils import orm_list, orm_to_dict

router = APIRouter(prefix="/api/faci", tags=["data"])

_ALLOWED_RECORD_FIELDS = set(CLASS_RECORD_SCORE_FIELDS)


# ── Section / students ──────────────────────────────────────────────────────

@router.get("/section")
async def get_section(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    section = await resolve_section(db, faci)
    if section is None:
        # 204-like: the UI shows a "section unavailable" state rather than error
        return {"section": None}
    return {"section": orm_to_dict(section)}


@router.get("/students")
async def get_students(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    section = await require_section(db, faci)
    rows = (
        await db.execute(
            select(Student)
            .where(Student.section_id == section.id)
            .order_by(Student.full_name.asc())
        )
    ).scalars().all()
    return {"students": orm_list(rows)}


# ── Class records ───────────────────────────────────────────────────────────

@router.get("/class-records")
async def get_class_records(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    section = await require_section(db, faci)
    rows = (
        await db.execute(
            select(ClassRecord).where(ClassRecord.section_id == section.id)
        )
    ).scalars().all()
    return {"records": orm_list(rows)}


@router.post("/class-records")
async def upsert_class_records(
    records: List[ClassRecordUpsert],
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    """Bulk upsert (INSERT … ON CONFLICT (id) DO UPDATE) matching the legacy
    `class_records.upsert(recordData)`. Only known score columns are written."""
    section = await require_section(db, faci)
    section_id = str(section.id)

    written = 0
    for rec in records:
        values = {
            "student_id": rec.student_id,
            # Force the row into THIS facilitator's section — never trust a
            # client-supplied section_id that isn't theirs.
            "section_id": section_id,
        }
        if rec.id:
            values["id"] = rec.id
        if rec.date is not None:
            values["date"] = rec.date
        if rec.quarter is not None:
            values["quarter"] = rec.quarter
        for key, val in (rec.scores or {}).items():
            if key in _ALLOWED_RECORD_FIELDS:
                values[key] = val

        stmt = pg_insert(ClassRecord).values(**values)
        update_cols = {k: stmt.excluded[k] for k in values if k != "id"}
        # Forcing section_id above only fixes the *written* value — it does NOT
        # stop a body carrying another section's record id from hijacking that
        # row via the id conflict. Scope the update to rows already in THIS
        # facilitator's section, so an out-of-section id is a no-op instead.
        stmt = stmt.on_conflict_do_update(
            index_elements=["id"],
            set_=update_cols,
            where=(ClassRecord.section_id == section_id),
        )
        await db.execute(stmt)
        written += 1

    await db.commit()
    return {"message": "Records saved", "count": written}


# ── Attendance ──────────────────────────────────────────────────────────────

@router.get("/attendance")
async def get_attendance(
    date: Optional[str] = Query(default=None),
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    """Attendance rows for this facilitator's section + teacher. When `date` is
    given, only that day's rows (the attendance page); otherwise all rows (the
    dashboard's attendance-rate aggregate)."""
    section = await require_section(db, faci)
    stmt = select(Attendance).where(Attendance.section == faci.section)
    if faci.teacher_id is not None:
        stmt = stmt.where(Attendance.teacher_id == faci.teacher_id)
    if date is not None:
        stmt = stmt.where(Attendance.date == date)
    rows = (await db.execute(stmt)).scalars().all()
    return {"attendance": orm_list(rows)}


@router.post("/attendance")
async def save_attendance(
    body: AttendanceSaveRequest,
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    """Replace this facilitator's attendance for a given date, exactly like the
    legacy delete-then-insert (scoped by section + teacher_id + date)."""
    await require_section(db, faci)
    section = faci.section
    teacher_id = faci.teacher_id

    del_stmt = (
        delete(Attendance)
        .where(Attendance.section == section)
        .where(Attendance.date == body.date)
    )
    if teacher_id is not None:
        del_stmt = del_stmt.where(Attendance.teacher_id == teacher_id)
    await db.execute(del_stmt)

    for item in body.items:
        db.add(
            Attendance(
                date=body.date,
                section=section,
                subject=body.subject or faci.subject,
                facilitator_id=str(faci.id),
                teacher_id=teacher_id,
                student_name=item.student_name,
                student_id_no=item.student_id_no,
                status=item.status,
                remarks=item.remarks,
                quarter=body.quarter,
            )
        )
    await db.commit()
    return {"message": "Attendance submitted", "count": len(body.items)}


# ── Grade config (subjects) / teacher / co-facilitators ─────────────────────

@router.get("/subjects")
async def get_subjects(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    """Per-subject grade weights set by the teacher — the single source of truth
    that keeps faci grades identical to the teacher panel."""
    if faci.teacher_id is None:
        return {"subjects": []}
    rows = (
        await db.execute(select(Subject).where(Subject.teacher_id == faci.teacher_id))
    ).scalars().all()
    return {"subjects": orm_list(rows)}


@router.get("/teacher")
async def get_teacher(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    if faci.teacher_id is None:
        return {"teacher": None}
    row = (
        await db.execute(select(Profile).where(Profile.id == faci.teacher_id))
    ).scalar_one_or_none()
    return {"teacher": orm_to_dict(row) if row else None}


@router.get("/co-facilitators")
async def get_co_facilitators(
    faci: Facilitator = Depends(get_current_faci),
    db: AsyncSession = Depends(get_db),
):
    """Other facilitators assigned to the same section under the same teacher."""
    stmt = select(Facilitator).where(Facilitator.section == faci.section)
    if faci.teacher_id is not None:
        stmt = stmt.where(Facilitator.teacher_id == faci.teacher_id)
    rows = (await db.execute(stmt.order_by(Facilitator.full_name.asc()))).scalars().all()
    out = []
    for r in rows:
        d = orm_to_dict(r)
        d.pop("password", None)  # never expose hashes
        out.append(d)
    return {"co_facilitators": out}
