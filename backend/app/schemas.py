"""schemas.py — Pydantic request/response models for the Facilitator API."""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ── Auth ────────────────────────────────────────────────────────────────────

class FaciLoginRequest(BaseModel):
    account_id: str
    password: str


class FaciPublic(BaseModel):
    id: str
    full_name: Optional[str] = None
    section: Optional[str] = None
    subject: Optional[str] = None
    teacher_id: Optional[str] = None
    avatar_url: Optional[str] = None
    status: Optional[str] = None
    last_login: Optional[str] = None


class FaciLoginResponse(BaseModel):
    message: str
    token: str
    faci: FaciPublic


class FaciUpdate(BaseModel):
    """Profile self-update. Only provided fields are changed."""
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None
    password: Optional[str] = None
    status: Optional[str] = None


# ── Attendance ──────────────────────────────────────────────────────────────

class AttendanceItem(BaseModel):
    student_name: str
    student_id_no: str
    status: str
    remarks: Optional[str] = None


class AttendanceSaveRequest(BaseModel):
    date: str
    subject: Optional[str] = None
    quarter: Optional[str] = None
    items: List[AttendanceItem]


# ── Class records ───────────────────────────────────────────────────────────

class ClassRecordUpsert(BaseModel):
    """A single class_records upsert. Score fields are validated against the
    known column list in the router before writing."""
    model_config = ConfigDict(extra="allow")

    id: Optional[str] = None
    student_id: str
    section_id: str
    quarter: Optional[str] = None
    date: Optional[str] = None
    scores: Dict[str, Any] = Field(default_factory=dict)


# ── Push ────────────────────────────────────────────────────────────────────

class PushSubscribeRequest(BaseModel):
    endpoint: str
    subscription: Dict[str, Any]


# ── Session ─────────────────────────────────────────────────────────────────

class SessionOpenResponse(BaseModel):
    id: int
