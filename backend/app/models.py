"""
models.py — SQLAlchemy ORM models mapped 1:1 to the existing Supabase schema.
============================================================================
Column names and types mirror the live database EXACTLY (verified against the
`student-management` Supabase project), including its quirks:

  * `attendance.date`, `attendance.facilitator_id`, `class_records.date` are
    TEXT (not date/uuid) — kept as-is so existing rows read/write identically.
  * `facilitator_logs.id` is a serial INTEGER.
  * `class_records` has module_1..module_25, activity_1..activity_10, plus
    `at`, `pt_1`, `pt_2`, `qe`.

No migrations are created or run — this maps onto the data already there.
"""
from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    Integer,
    Numeric,
    String,
    Text,
    Time,
    text as sa_text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PGUUID

from .database import Base


def _uuid_pk():
    return Column(PGUUID(as_uuid=True), primary_key=True, server_default=sa_text("gen_random_uuid()"))


class Profile(Base):
    __tablename__ = "profiles"
    id = Column(PGUUID(as_uuid=True), primary_key=True)
    full_name = Column(Text, nullable=True)
    email = Column(Text, nullable=True)
    avatar_url = Column(Text, nullable=True)
    theme = Column(Text, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True))


class Facilitator(Base):
    __tablename__ = "facilitators"
    id = _uuid_pk()
    full_name = Column(Text)
    section = Column(Text)
    subject = Column(Text)
    account_id = Column(Text, unique=True)
    teacher_id = Column(PGUUID(as_uuid=True), nullable=True)
    avatar_url = Column(Text, nullable=True)
    last_login = Column(TIMESTAMP(timezone=True), nullable=True)
    status = Column(Text, nullable=True)
    password = Column(Text, nullable=True)  # bcrypt hash
    created_at = Column(TIMESTAMP(timezone=True))


class Section(Base):
    __tablename__ = "sections"
    id = _uuid_pk()
    teacher_id = Column(PGUUID(as_uuid=True))
    title = Column(Text)
    subject = Column(Text)
    room = Column(Text)
    semester = Column(Text, nullable=True)
    school_year = Column(String, nullable=True)
    quarter = Column(Text, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True))


class Student(Base):
    __tablename__ = "students"
    id = _uuid_pk()
    section_id = Column(PGUUID(as_uuid=True))
    full_name = Column(Text)
    gender = Column(Text, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True))


class Attendance(Base):
    __tablename__ = "attendance"
    id = _uuid_pk()
    date = Column(Text)  # stored as text in the live DB
    section = Column(Text)
    subject = Column(Text)
    facilitator_id = Column(Text, nullable=True)  # text in the live DB
    student_name = Column(Text)
    student_id_no = Column(Text)
    status = Column(Text)
    remarks = Column(Text, nullable=True)
    quarter = Column(Text, nullable=True)
    teacher_id = Column(PGUUID(as_uuid=True), nullable=True)
    created_at = Column(TIMESTAMP(timezone=True))


class ClassRecord(Base):
    __tablename__ = "class_records"
    id = _uuid_pk()
    student_id = Column(PGUUID(as_uuid=True))
    section_id = Column(PGUUID(as_uuid=True))
    at = Column(Numeric, nullable=True)
    pt_1 = Column(Numeric, nullable=True)
    pt_2 = Column(Numeric, nullable=True)
    qe = Column(Numeric, nullable=True)
    date = Column(Text, nullable=True)
    quarter = Column(Text, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True))


# module_1..module_25 and activity_1..activity_10 are numeric/nullable and are
# attached in a loop to keep the model readable. Assigning a Column onto an
# existing declarative class is a supported SQLAlchemy pattern.
for _n in range(1, 26):
    setattr(ClassRecord, f"module_{_n}", Column(Numeric, nullable=True))
for _n in range(1, 11):
    setattr(ClassRecord, f"activity_{_n}", Column(Numeric, nullable=True))

# Column names the record page reads/writes, exposed for validation & upsert.
CLASS_RECORD_SCORE_FIELDS = (
    [f"module_{n}" for n in range(1, 26)]
    + [f"activity_{n}" for n in range(1, 11)]
    + ["at", "pt_1", "pt_2", "qe"]
)


class FacilitatorLog(Base):
    __tablename__ = "facilitator_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    facilitator_id = Column(PGUUID(as_uuid=True), nullable=True)
    time_in = Column(TIMESTAMP(timezone=True), server_default=sa_text("now()"))
    time_out = Column(TIMESTAMP(timezone=True), nullable=True)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id = _uuid_pk()
    user_type = Column(Text)  # 'teacher' | 'faci'
    user_id = Column(Text)
    endpoint = Column(Text, unique=True)
    subscription = Column(JSONB)
    created_at = Column(TIMESTAMP(timezone=True))
    updated_at = Column(TIMESTAMP(timezone=True))
    __table_args__ = (
        CheckConstraint("user_type = ANY (ARRAY['teacher'::text, 'faci'::text])"),
    )


class Subject(Base):
    __tablename__ = "subjects"
    id = _uuid_pk()
    teacher_id = Column(PGUUID(as_uuid=True))
    name = Column(Text)
    ww_percent = Column(Numeric, server_default=sa_text("30"))
    pt_percent = Column(Numeric, server_default=sa_text("50"))
    exam_percent = Column(Numeric, server_default=sa_text("20"))
    attendance_percent = Column(Numeric, server_default=sa_text("0"))
    passing_grade = Column(Numeric, server_default=sa_text("75"))
    created_at = Column(TIMESTAMP(timezone=True))


class Schedule(Base):
    __tablename__ = "schedules"
    id = _uuid_pk()
    user_id = Column(PGUUID(as_uuid=True))
    subject = Column(Text)
    time = Column(Text)
    details = Column(Text)
    created_at = Column(TIMESTAMP(timezone=True))


class Notice(Base):
    __tablename__ = "notices"
    id = _uuid_pk()
    user_id = Column(PGUUID(as_uuid=True), nullable=True)
    text = Column(Text)
    date = Column(Date)
    time = Column(Time, nullable=True)
    color = Column(Text, server_default=sa_text("'blue'::text"))
    created_at = Column(TIMESTAMP(timezone=True))


class Note(Base):
    __tablename__ = "notes"
    id = _uuid_pk()
    user_id = Column(PGUUID(as_uuid=True))
    content = Column(Text)
    created_at = Column(TIMESTAMP(timezone=True))
