"""
vision.py — Photo → structured data (attendance letters / record scores).
========================================================================
Python port of the Vercel `api/vision-analyze.js` serverless function — same
request/response contract and Gemini-primary / Groq-fallback strategy, with an
accuracy-hardened read path on top:

  • greedy decoding (temperature 0) + HIGH media resolution + thinking models
  • record scans: 2 independent reads, per-cell majority-of-3 tie-break when
    the reads disagree; cells with no majority are confidence-flagged (0.35)
    so the review modal forces the facilitator to verify them
  • attendance scans: verification re-read; disagreements are flagged

Primary provider : Google Gemini    (GEMINI_API_KEY)
Optional fallback: Groq (Llama 4)    (GROQ_API_KEY)
Model overrides  : GEMINI_VISION_MODEL, GROQ_VISION_MODEL
"""
import json
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import settings
from ..models import CLASS_RECORD_SCORE_FIELDS, Facilitator
from ..security import get_current_faci

router = APIRouter(prefix="/api", tags=["vision"])

GROQ_MODELS = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
]
GEMINI_MODELS = [
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-exp",
    "gemini-1.5-flash",
]
RECORD_MODEL_ORDER = [
    "gemini-2.5-pro",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-exp",
    "gemini-1.5-flash",
]
MAX_IMAGE_BYTES = 6 * 1024 * 1024  # 6 MB after base64 decode
MAX_ROSTER = 200

RECORD_FIELDS: List[str] = list(CLASS_RECORD_SCORE_FIELDS)
RECORD_FIELD_SET = set(RECORD_FIELDS)


class _RateLimit(Exception):
    def __init__(self, raw: str = ""):
        super().__init__(raw or "rate limit")
        self.raw = raw


class _Upstream(Exception):
    def __init__(self, raw: str = ""):
        super().__init__(raw or "upstream error")
        self.raw = raw


# ── Request model (camelCase keys, matching the legacy client) ───────────────

class VisionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: str = ""
    image_base64: str = Field(default="", alias="imageBase64")
    mime_type: str = Field(default="", alias="mimeType")
    roster: List[str] = Field(default_factory=list)
    target_fields: List[str] = Field(default_factory=list, alias="targetFields")
    target_field: str = Field(default="", alias="targetField")


# ── Prompt builders ─────────────────────────────────────────────────────────

def _field_label(f: Optional[str]) -> str:
    if not f:
        return ""
    if f.startswith("module_"):
        return "MODULE " + f.split("_")[1]
    if f.startswith("activity_"):
        return "ACTIVITY " + f.split("_")[1]
    return {
        "at": "AT (Attendance)",
        "pt_1": "PT 1 (Performance Task 1)",
        "pt_2": "PT 2 (Performance Task 2)",
        "qe": "QE (Quarterly Exam)",
    }.get(f, f)


def _roster_lines(roster: List[str]) -> str:
    return "\n".join(f"{i + 1}. {n}" for i, n in enumerate(roster))


def build_attendance_prompt(roster: List[str]) -> str:
    return (
        "You are analyzing a photo of a classroom attendance sheet from a school in the Philippines. "
        "For each student on the ROSTER below, find their attendance cell and read the LETTER written in it:\n\n"
        "  LETTER 'P' → \"Present\"\n"
        "  LETTER 'A' → \"Absent\"\n"
        "  LETTER 'L' → \"Late\"\n"
        "  LETTER 'E' → \"Excused\"\n"
        "  EMPTY / BLANK cell → \"Absent\"\n\n"
        "NOTE: A small dot (.) or faint mark that is NOT clearly one of the letters P, A, L, E counts as BLANK → \"Absent\".\n"
        "Only a clear, intentional letter P, A, L, or E should be read as marked.\n\n"
        f"CRITICAL — You MUST return ALL {len(roster)} roster students:\n"
        f"  • students[] MUST have exactly {len(roster)} entries in ROSTER ORDER. No omissions, no duplicates.\n"
        "  • Read each row left-to-right, match to the roster name, then read the attendance letter.\n"
        "  • If you CANNOT find a student's row, include them as Absent with confidence 0.2.\n\n"
        "MATCHING RULES:\n"
        "  • Match photo names to the closest roster name (tolerate missing accents, wrong middle initial).\n"
        "  • Never invent names not on the roster. Names must match EXACTLY.\n\n"
        "OUTPUT — STRICT JSON ONLY, no prose, no markdown:\n"
        "{\n"
        '  "students": [\n'
        '    { "name": "<exact roster name>", "status": "Present", "confidence": 1.0 },\n'
        '    { "name": "<exact roster name>", "status": "Absent", "confidence": 0.9 }\n'
        "  ],\n"
        '  "unmatched": [],\n'
        '  "notes": ""\n'
        "}\n\n"
        f"ROSTER ({len(roster)} names — return exactly this many):\n"
        + _roster_lines(roster)
    )


def build_record_prompt(roster: List[str], target_fields) -> str:
    raw = target_fields if isinstance(target_fields, list) else ([target_fields] if target_fields else [])
    fields = [f for f in (str(x or "").strip() for x in raw) if f in RECORD_FIELD_SET]

    if len(fields) >= 2:
        label_list = "\n  • ".join(f'{_field_label(f)} (key: "{f}")' for f in fields)
        schema_scores = ", ".join(f'"{f}": <number>' for f in fields)
        return (
            "You are a METICULOUS PROCTOR reading a handwritten Filipino classroom grade book. "
            f"The facilitator has told you this photo contains scores for EXACTLY these {len(fields)} "
            "columns (ignore every OTHER column in the photo):\n  • " + label_list + "\n\n"
            "YOUR JOB: for each student on the ROSTER below, find their row, then read the handwritten "
            "number in EACH of the above columns for that row. Put each into scores using its field key.\n\n"
            "═══ RULES (follow strictly) ═══\n"
            "  • Read the columns in the SAME left-to-right order they appear in the photo. Do NOT swap "
            "columns — a value under Module 1 must go to module_1, not module_2.\n"
            "  • Count digits per cell: '8' is ONE digit, '10'/'15' are TWO. Do NOT round '8' to '10'.\n"
            "  • Common confusions — check the SHAPES: the second digit of '15' is a 5 (flat top + curve), "
            "not a 0 (closed loop); '7' has a flat top bar, '1' is a single vertical stroke; "
            "'0' is a plain oval, '6' has its loop at the bottom only.\n"
            "  • Each student's numbers are INDEPENDENT — do NOT copy one student's value to the next.\n"
            "  • Blank / empty / unreadable cell → OMIT that one field for that student (do NOT guess 0).\n"
            "  • Numbers are 0..200. If a digit is ambiguous, return your best guess and LOWER confidence.\n"
            "  • Match names to the ROSTER exactly (tolerate small OCR errors in the name).\n"
            "  • Only include a student who has AT LEAST ONE readable score among these columns.\n\n"
            "OUTPUT — STRICT JSON ONLY, no prose, no markdown:\n"
            "{\n"
            '  "students": [ { "name": "<exact roster name>", "scores": { ' + schema_scores + ' }, "confidence": <0..1> } ],\n'
            '  "unmatched": [ "<name text seen in photo>" ],\n'
            '  "notes": "<optional one-line observation>"\n'
            "}\n\n"
            "ROSTER (match names to these exact strings):\n"
            + _roster_lines(roster)
        )

    target_field = fields[0] if len(fields) == 1 else None
    target_label = _field_label(target_field)
    if target_field and target_field in RECORD_FIELD_SET:
        return (
            "You are a METICULOUS PROCTOR reading a handwritten Filipino classroom grade book. "
            "The facilitator has told you this photo contains scores for ONE specific field: "
            + target_label + ' (field key: "' + target_field + '"). You must read every student\'s '
            "score in that ONE column with the care of a person double-checking their own work.\n\n"
            "═══ STEP-BY-STEP PROCEDURE (do NOT skip any step) ═══\n\n"
            "STEP 1 — LOCATE the " + target_label + " column. If the photo shows a table with a "
            "header row, identify the column labeled " + target_label + " (or its short form like "
            + target_field.replace("_", " ").upper() + "). Every score you extract must come "
            "from THIS column and no other.\n\n"
            "STEP 2 — For each student on the ROSTER below, find their row in the photo (the row "
            "whose Student Name matches the roster name). Then find the CELL that is on that row "
            "AND in the " + target_label + " column. That intersection is the cell you must read.\n\n"
            "STEP 3 — Before writing any number, count the DIGITS in the cell:\n"
            "  • 0 digits → the cell is BLANK. Do NOT write a score for this student.\n"
            "  • 1 digit  → single-digit number (0 through 9).\n"
            "  • 2 digits → two-digit number (10 through 99).\n"
            "  • 3 digits → three-digit number (100+; rare).\n"
            "\n"
            "  ★ '8' has ONE digit. '10' has TWO. '15' has TWO. These look DIFFERENT.\n"
            "  ★ Do NOT round '8' to '10' or '15' to '10' just because '10' is common.\n\n"
            "STEP 4 — For each digit you see, verify its SHAPE:\n"
            "  • 0: closed oval or circle, no straight lines through the middle.\n"
            "  • 1: a single vertical stroke (may have a tiny top serif or bottom flag).\n"
            "  • 2: curved top and a flat or diagonal bottom (like a 'z').\n"
            "  • 3: two right-facing bumps stacked (or open on the LEFT).\n"
            "  • 4: crossed lines forming a closed top, plus a vertical line down (open '4' also common).\n"
            "  • 5: flat horizontal top, then a downward stroke, then a bottom curve.\n"
            "  • 6: a downward curve that closes at the bottom into a loop.\n"
            "  • 7: a flat top with a diagonal stroke going down-left.\n"
            "  • 8: two closed loops stacked (top loop and bottom loop).\n"
            "  • 9: closed loop at the top and a straight or curved stroke down.\n\n"
            "STEP 5 — Sanity-check common confusions:\n"
            "  • '10' vs '8'  → 10 is TWO digits, 8 is ONE digit. If you see two clearly separate "
            "shapes in the cell, it's TWO digits.\n"
            "  • '15' vs '10' → the second digit is '5' (flat top + curve) NOT '0' (closed loop). "
            "Look at the second digit shape.\n"
            "  • '9'  vs '10' → 9 is ONE digit, 10 is TWO.\n"
            "  • '7'  vs '1'  → 7 has a flat top-bar and a diagonal; 1 is a single vertical.\n"
            "  • '0'  vs '6'  → 0 is a plain closed oval; 6 has a loop at the bottom only.\n\n"
            "STEP 6 — CONFIDENCE. Assign confidence honestly:\n"
            "  • 0.9+  → the digits are unambiguous and clearly written.\n"
            "  • 0.7   → readable but with minor ambiguity you had to reason about.\n"
            "  • 0.4-0.6 → you're not sure between two possibilities (e.g. '8' vs '3'). Flag it.\n"
            "  • 0.2   → almost illegible / smudged / could be anything.\n\n"
            "═══ DO-NOT LIST ═══\n"
            "  ✗ Do NOT default a whole column to the same value. Each student's cell is INDEPENDENT.\n"
            "  ✗ Do NOT copy the COLUMN HEADER as a score (headers may be numbers like '1', '10').\n"
            "  ✗ Do NOT guess when you can't see clearly — return LOW confidence instead.\n"
            "  ✗ Do NOT invent students not on the roster.\n"
            '  ✗ Do NOT skip blank cells — just omit scores["' + target_field + '"] for that student.\n'
            "  ✗ Do NOT shift scores up/down — a score belongs to the student on THAT row, not the row above or below.\n\n"
            "═══ OUTPUT ═══\n"
            "Reply with STRICT JSON ONLY (no prose, no markdown, no code fences):\n"
            "{\n"
            '  "students": [ { "name": "<exact roster name>", "scores": { "' + target_field
            + '": <number> }, "confidence": <0..1> } ],\n'
            '  "unmatched": [ "<name text seen in photo>" ],\n'
            '  "notes": "<optional one-line observation, e.g. photo blur>"\n'
            "}\n\n"
            "Match student names in the photo to the ROSTER (ground truth). Tolerate small OCR "
            "errors in names, but names in `students[].name` MUST match the roster string EXACTLY.\n\n"
            "ROSTER (match names to these exact strings):\n"
            + _roster_lines(roster)
        )

    return (
        "You are analyzing a photo of a classroom RECORD / GRADE BOOK page from a school in the Philippines. "
        "Rows are students, columns are score-holding fields.\n\n"
        "IMPORTANT — Only include a student in the students array if you can read AT LEAST ONE score "
        "for them. Students with ALL blank cells should NOT appear in the output.\n\n"
        "STEP 1: Identify the header row. Read each column header and map it to the exact field key below.\n"
        "STEP 2: Read each student row from top to bottom. Match the name in the photo to the closest roster name.\n"
        "STEP 3: For each matched student, read the score from each column and record it under the correct field key.\n"
        "STEP 4: If EVERY cell in that student's row is blank/empty, OMIT that student entirely.\n\n"
        "COLUMN → FIELD MAPPING (map the header text you see to the exact field key below):\n"
        "- 'MODULE 1' / 'M1' / 'Mod 1' → module_1  (same pattern up to module_25)\n"
        "- 'ACTIVITY 1' / 'A1' / 'Act 1' → activity_1  (same pattern up to activity_10)\n"
        "- 'AT' / 'Attendance' → at\n"
        "- 'PT 1' / 'PT1' / 'Performance Task 1' → pt_1\n"
        "- 'PT 2' / 'PT2' / 'Performance Task 2' → pt_2\n"
        "- 'QE' / 'Q.E.' / 'Quarterly Exam' / 'Exam' → qe\n"
        "- If a header does not clearly map to one of the above field keys, IGNORE that entire column.\n\n"
        "NAME MATCHING RULES:\n"
        "- Find each student's name in the leftmost column(s) of the photo. Match it to the EXACT ROSTER NAME below.\n"
        '- Write the EXACT roster string in the "name" field — do NOT modify the name.\n'
        "- NEVER invent a name not on the roster. NEVER fabricate a score for a blank cell.\n\n"
        "SCORE READING RULES:\n"
        "- Only include a numeric value if you can CLEARLY read the digits. Empty/blank cells, dashes, "
        "'-', or unreadable cells are OMITTED (do not include the field at all).\n"
        "- Numbers must be non-negative and at most 200. Decimals are allowed but rare; prefer integers.\n"
        "- If you're not confident about a value, still return your best guess and lower the confidence.\n"
        "- Make sure each score is in the CORRECT column — double-check alignment left-to-right.\n"
        "- A COMMON MISTAKE is assigning a score from one student to the next student. Double-check "
        "that each score is on the CORRECT row and in the CORRECT column.\n\n"
        "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose, no markdown fences. Exactly this shape:\n"
        "{\n"
        '  "students": [\n'
        '    { "name": "<exact roster name>", "scores": { "<field_key>": <number>, ... }, "confidence": <0..1> },\n'
        "    ...\n"
        "  ],\n"
        '  "unmatched": [ "<name text seen in photo but not matched>" ],\n'
        '  "notes": "<optional observation>"\n'
        "}\n\n"
        "ROSTER (use these exact names for matching):\n"
        + _roster_lines(roster)
    )


# ── Providers ───────────────────────────────────────────────────────────────

async def groq_vision(api_key: str, prompt: str, image_b64: str, mime_type: str) -> str:
    pinned = settings.GROQ_VISION_MODEL
    models = ([pinned] if pinned else []) + [m for m in GROQ_MODELS if m != pinned]
    data_url = f"data:{mime_type};base64,{image_b64}"
    last_err = None
    async with httpx.AsyncClient(timeout=90) as client:
        for m in models:
            try:
                r = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": m,
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": data_url}},
                            ],
                        }],
                        "temperature": 0,
                        "max_tokens": 16384,
                        "response_format": {"type": "json_object"},
                    },
                )
                if r.status_code == 200:
                    data = r.json()
                    reply = (((data.get("choices") or [{}])[0] or {}).get("message") or {}).get("content", "").strip()
                    if reply:
                        return reply
                    last_err = "empty reply"
                else:
                    txt = r.text
                    last_err = f"{r.status_code} {txt[:300]}"
                    if r.status_code == 429 or re.search(r"rate|quota|limit", txt, re.I):
                        raise _RateLimit(last_err)
                    if r.status_code not in (400, 404):
                        break
            except _RateLimit:
                raise
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
    raise _Upstream(last_err or "Groq returned no reply")


async def gemini_vision(api_key: str, prompt: str, image_b64: str, mime_type: str, prefer_accurate: bool = False) -> str:
    pinned = settings.GEMINI_VISION_MODEL
    models = [pinned] if pinned else (RECORD_MODEL_ORDER if prefer_accurate else GEMINI_MODELS)
    last_err = None
    models_tried = 0
    models_rate_limited = 0
    async with httpx.AsyncClient(timeout=120) as client:
        for m in models:
            models_tried += 1
            model_rate_limited = False
            # Per-model parameter negotiation. Start with everything that helps
            # accuracy — strict-JSON output, HIGH media resolution (more image
            # tokens = far better small-handwritten-digit legibility on dense
            # tables), and thinking on 2.5 models (reasoning before answering
            # measurably reduces row/column mix-ups). If a model 400s on a
            # specific parameter, drop just that flag and retry the same model.
            flags = {"json": True, "hires": True, "think": "2.5" in m}
            for _attempt in range(4):
                try:
                    gen: Dict[str, Any] = {
                        # temperature 0: greedy decoding. OCR-style transcription
                        # has one right answer — sampling only adds noise.
                        "temperature": 0,
                        # 2.0/1.5 models cap output at 8192 and 400 on more.
                        "maxOutputTokens": 32768 if "2.5" in m else 8192,
                    }
                    if flags["json"]:
                        gen["responseMimeType"] = "application/json"
                    if flags["hires"]:
                        gen["mediaResolution"] = "MEDIA_RESOLUTION_HIGH"
                    if flags["think"]:
                        gen["thinkingConfig"] = {"thinkingBudget": -1}  # dynamic
                    r = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}",
                        headers={"Content-Type": "application/json"},
                        json={
                            "contents": [{
                                "parts": [
                                    {"text": prompt},
                                    {"inline_data": {"mime_type": mime_type, "data": image_b64}},
                                ]
                            }],
                            "generationConfig": gen,
                        },
                    )
                    try:
                        data = r.json()
                    except Exception:  # noqa: BLE001
                        data = {}
                    if r.status_code == 200:
                        parts = (((data.get("candidates") or [{}])[0] or {}).get("content") or {}).get("parts") or []
                        # Skip thought-summary parts (present when thinking is on).
                        text = "".join((p or {}).get("text", "") for p in parts if not (p or {}).get("thought")).strip()
                        if text:
                            return text
                        last_err = f"[{m}] empty reply"
                        break
                    last_err = f"[{m}] {r.status_code} {json.dumps(data)[:300]}"
                    if r.status_code == 429 or re.search(r"RESOURCE_EXHAUSTED", last_err, re.I):
                        model_rate_limited = True
                        break
                    if r.status_code == 400:
                        if flags["think"] and re.search(r"thinking", last_err, re.I):
                            flags["think"] = False
                            continue
                        if flags["hires"] and re.search(r"media_?resolution", last_err, re.I):
                            flags["hires"] = False
                            continue
                        if flags["json"] and re.search(r"response_?mime_?type", last_err, re.I):
                            flags["json"] = False
                            continue
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = f"[{m}] {e}"
                    break
            if model_rate_limited:
                models_rate_limited += 1
    if models_tried > 0 and models_rate_limited == models_tried:
        raise _RateLimit(last_err or "rate limit")
    raise _Upstream(last_err or "No usable Gemini model.")


# ── JSON parsing / salvage ──────────────────────────────────────────────────

def _strip_json_comments(s: str) -> str:
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "/":
            i += 2
            while i < n and s[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            i += 2
            while i < n and not (s[i] == "*" and i + 1 < n and s[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _find_balanced_prefix(s: str) -> Optional[str]:
    d = 0
    in_str = esc = False
    for i, c in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
            continue
        if c in "{[":
            d += 1
        elif c in "}]":
            d -= 1
            if d == 0:
                return s[: i + 1]
    return None


def _salvage_truncated_json(s: str) -> Optional[str]:
    d = 0
    in_str = esc = False
    cut = -1
    current_stack: List[str] = []
    stack_at_cut: Optional[List[str]] = None
    for i, c in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
            continue
        if c in "{[":
            current_stack.append(c)
            d += 1
            continue
        if c in "}]":
            if current_stack:
                current_stack.pop()
            d -= 1
            continue
        if c == "," and d == 2 and current_stack and current_stack[-1] == "[":
            cut = i
            stack_at_cut = current_stack[:]
    if d == 0 and not in_str and not current_stack:
        return None
    if cut == -1 or not stack_at_cut:
        return None
    trimmed = s[:cut]
    for ch in reversed(stack_at_cut):
        trimmed += "}" if ch == "{" else "]"
    return trimmed


_ZERO_WIDTH = re.compile(r"[﻿​‌‍⁠]")


def parse_vision_json(raw: str) -> dict:
    s = str(raw or "").strip()
    s = re.sub(r"```(?:json|JSON)?\s*", "", s).replace("```", "").strip()
    s = _ZERO_WIDTH.sub("", s)
    if s and s[0] != "{":
        start = s.find("{")
        if start != -1:
            s = s[start:]
    if s and s[-1] not in "}]":
        balanced = _find_balanced_prefix(s)
        if balanced:
            s = balanced

    attempts = [s]
    s2 = _strip_json_comments(s)
    s2 = s2.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    s2 = re.sub(r",\s*(?=[}\]])", "", s2)
    attempts.append(s2)
    salvaged = _salvage_truncated_json(s2)
    if salvaged:
        attempts.append(salvaged)

    last_err: Optional[Exception] = None
    for candidate in attempts:
        try:
            return json.loads(candidate)
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise last_err or ValueError("unparseable")


# ── Sanitizers ──────────────────────────────────────────────────────────────

def _clamp_conf(v) -> float:
    try:
        conf = float(v)
    except (TypeError, ValueError):
        return 0.0
    if conf != conf or conf < 0:  # NaN or negative
        return 0.0
    return 1.0 if conf > 1 else conf


def sanitize_students(lst, roster_set) -> List[dict]:
    if not isinstance(lst, list):
        return []
    seen = set()
    valid = {"Present", "Absent", "Late", "Excused"}
    out = []
    for item in lst:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        status = str(item.get("status") or "").strip()
        if not name or name not in roster_set or status not in valid or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "status": status, "confidence": _clamp_conf(item.get("confidence"))})
    return out


def sanitize_record_students(lst, roster_set) -> List[dict]:
    if not isinstance(lst, list):
        return []
    seen = set()
    out = []
    for item in lst:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name not in roster_set or name in seen:
            continue
        raw_scores = item.get("scores") if isinstance(item.get("scores"), dict) else {}
        scores: Dict[str, float] = {}
        for field, val in raw_scores.items():
            if field not in RECORD_FIELD_SET:
                continue
            try:
                num = float(val)
            except (TypeError, ValueError):
                continue
            if num != num or num < 0 or num > 200:
                continue
            scores[field] = round(num * 100) / 100
        if not scores:
            continue
        seen.add(name)
        out.append({"name": name, "scores": scores, "confidence": _clamp_conf(item.get("confidence"))})
    return out


def record_passes_disagree(a: List[dict], b: List[dict]) -> bool:
    """True when the two passes read a different number for any shared cell."""
    bmap = {s["name"]: (s.get("scores") or {}) for s in b}
    for s in a:
        sb = bmap.get(s["name"])
        if not sb:
            continue
        for f, v in (s.get("scores") or {}).items():
            if f in sb and float(sb[f]) != float(v):
                return True
    return False


def merge_record_consensus(passes: List[List[dict]], target_fields) -> List[dict]:
    """Per-cell majority vote across 2–3 independent read passes.

    For every (student, field) cell: if the passes that read it all agree →
    high confidence; if 2 of 3 agree → take the majority; if there is no
    majority → keep the first pass's value but drop confidence to 0.35 so the
    review modal flags the cell in red and the facilitator must eyeball it.
    """
    raw = target_fields if isinstance(target_fields, list) else [target_fields]
    fields = [f for f in raw if f in RECORD_FIELD_SET]
    passes = [p for p in passes if p]
    if not passes:
        return []
    if len(passes) == 1:
        return passes[0]
    by_pass = [{s["name"]: s for s in p} for p in passes]
    names: List[str] = []
    for bp in by_pass:
        for n in bp:
            if n not in names:
                names.append(n)
    out = []
    for name in names:
        present = [bp[name] for bp in by_pass if name in bp]
        all_fields = fields if fields else [
            f for f in dict.fromkeys(f for e in present for f in (e.get("scores") or {}))
            if f in RECORD_FIELD_SET
        ]
        merged: Dict[str, float] = {}
        any_conflict = any_majority = any_agree = False
        for f in all_fields:
            vals = [float((e.get("scores") or {})[f]) for e in present if f in (e.get("scores") or {})]
            if not vals:
                continue
            if len(vals) == 1:
                merged[f] = vals[0]
                continue
            counts: Dict[float, int] = {}
            for v in vals:
                counts[v] = counts.get(v, 0) + 1
            best_v, best_c = max(counts.items(), key=lambda kv: kv[1])
            if best_c == len(vals):
                merged[f] = best_v
                any_agree = True
            elif best_c >= 2:
                merged[f] = best_v
                any_majority = True
            else:
                merged[f] = vals[0]
                any_conflict = True
        if not merged:
            continue
        if any_conflict:
            confidence = 0.35
        elif any_majority:
            confidence = 0.9
        elif any_agree:
            confidence = 0.95
        else:
            confidence = max(0.55, float(present[0].get("confidence") or 0.55))
        out.append({"name": name, "scores": merged, "confidence": confidence})
    return out


def _safe_upstream_message(raw) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    s = re.sub(r"(key=)[^&\s\"]+", r"\1[redacted]", s, flags=re.I)
    s = re.sub(r"AIzaSy[a-zA-Z0-9_-]{10,}", "[redacted-key]", s)
    s = re.sub(r"gsk_[a-zA-Z0-9_-]{10,}", "[redacted-key]", s)
    if len(s) > 260:
        s = s[:260] + "…"
    return s


_MIME_RE = re.compile(r"^image/(jpeg|jpg|png|webp|heic|heif)$", re.I)


@router.post("/vision-analyze")
async def vision_analyze(
    body: VisionRequest,
    faci: Facilitator = Depends(get_current_faci),
):
    type_ = (body.type or "").lower()
    image_b64 = (body.image_base64 or "").strip()
    mime_type = (body.mime_type or "").strip().lower()
    roster = [n for n in (str(x or "").strip() for x in body.roster) if n]

    raw_fields = body.target_fields if isinstance(body.target_fields, list) else []
    target_fields = [str(f or "").strip() for f in raw_fields]
    if not target_fields and body.target_field.strip():
        target_fields = [body.target_field.strip()]
    tf_set = {f for f in target_fields if f in RECORD_FIELD_SET}
    target_fields = [f for f in RECORD_FIELDS if f in tf_set]

    if type_ not in ("attendance", "record"):
        return JSONResponse({"error": 'type must be "attendance" or "record".'}, status_code=400)
    if not image_b64:
        return JSONResponse({"error": "Missing imageBase64."}, status_code=400)
    if not _MIME_RE.match(mime_type):
        return JSONResponse({"error": "Unsupported image mimeType. Use JPEG, PNG, or WebP."}, status_code=400)
    if len(image_b64) > MAX_IMAGE_BYTES * 1.35:
        return JSONResponse({"error": "Image too large. Please retake a smaller / clearer photo."}, status_code=413)
    if not roster:
        return JSONResponse({"error": "Missing roster."}, status_code=400)
    if len(roster) > MAX_ROSTER:
        return JSONResponse({"error": f"Roster too large (max {MAX_ROSTER})."}, status_code=400)

    gemini_key = settings.GEMINI_API_KEY
    groq_key = settings.GROQ_API_KEY
    not_configured = (
        "AI vision is not configured yet. Add GEMINI_API_KEY (or GROQ_API_KEY) to the "
        "backend environment variables."
    )
    if not gemini_key and not groq_key:
        return JSONResponse({"error": not_configured}, status_code=503)

    prompt = build_record_prompt(roster, target_fields) if type_ == "record" else build_attendance_prompt(roster)

    # Step 1: Gemini (primary)
    raw_reply = None
    if gemini_key:
        try:
            # Accuracy-first model ordering for BOTH scan types — attendance
            # letters deserve the same care as record scores.
            raw_reply = await gemini_vision(gemini_key, prompt, image_b64, mime_type, prefer_accurate=True)
        except _RateLimit as e:
            if not groq_key:
                return JSONResponse(
                    {"error": "The AI vision service is having trouble right now. Please try again in a moment.",
                     "upstream": _safe_upstream_message(e.raw)},
                    status_code=502,
                )
            # rate-limited → fall through to Groq
        except _Upstream as e:
            return JSONResponse(
                {"error": "The AI vision service is having trouble right now. Please try again in a moment.",
                 "upstream": _safe_upstream_message(e.raw)},
                status_code=502,
            )

    # Step 2: Groq (fallback)
    if not raw_reply:
        if not groq_key:
            return JSONResponse({"error": not_configured}, status_code=503)
        try:
            raw_reply = await groq_vision(groq_key, prompt, image_b64, mime_type)
        except _RateLimit:
            return JSONResponse(
                {"error": "The AI hit its free-tier rate limit. Please wait a moment and try again."},
                status_code=429,
            )
        except _Upstream as e:
            return JSONResponse(
                {"error": "The AI vision service is having trouble right now. Please try again in a moment.",
                 "upstream": _safe_upstream_message(e.raw)},
                status_code=502,
            )

    try:
        parsed = parse_vision_json(raw_reply)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"error": "The AI reply was not valid JSON. Please try another photo.",
             "upstream": _safe_upstream_message(f"parse:{e} | raw:{str(raw_reply or '')[:220]}")},
            status_code=502,
        )

    roster_set = set(roster)
    if type_ == "record":
        students = sanitize_record_students(parsed.get("students"), roster_set)
    else:
        students = sanitize_students(parsed.get("students"), roster_set)
    unmatched = []
    if isinstance(parsed.get("unmatched"), list):
        unmatched = [str(n or "").strip() for n in parsed["unmatched"] if str(n or "").strip()][:30]
    notes = str(parsed.get("notes") or "").strip()[:240]

    # Multi-pass consensus (record + explicit fields + gemini available):
    # every scan is read at least twice; if the two reads disagree on any cell
    # a third read breaks the tie, and cells with no 2-of-3 majority are
    # confidence-flagged so the review modal forces a human check.
    if type_ == "record" and len(target_fields) >= 1 and gemini_key and students:
        try:
            raw_reply2 = await gemini_vision(gemini_key, prompt, image_b64, mime_type, prefer_accurate=True)
            parsed2 = parse_vision_json(raw_reply2)
            students2 = sanitize_record_students(parsed2.get("students"), roster_set)
            passes = [students, students2]
            if students2 and record_passes_disagree(students, students2):
                try:
                    raw_reply3 = await gemini_vision(gemini_key, prompt, image_b64, mime_type, prefer_accurate=True)
                    parsed3 = parse_vision_json(raw_reply3)
                    students3 = sanitize_record_students(parsed3.get("students"), roster_set)
                    if students3:
                        passes.append(students3)
                except Exception:  # noqa: BLE001
                    pass  # tie-break is best-effort; 2-pass merge still applies
            students = merge_record_consensus(passes, target_fields)
            notes2 = str(parsed2.get("notes") or "").strip()
            if notes2 and notes2 not in notes:
                notes = (notes + " | " if notes else "") + notes2
                notes = notes[:240]
        except Exception:  # noqa: BLE001
            pass  # best-effort; fall back to single pass

    # Attendance verification pass: re-read once; agreements lock in at high
    # confidence, disagreements drop to 0.35 so the letter gets double-checked.
    if type_ == "attendance" and gemini_key and students:
        try:
            raw_reply2 = await gemini_vision(gemini_key, prompt, image_b64, mime_type, prefer_accurate=True)
            parsed2 = parse_vision_json(raw_reply2)
            students2 = sanitize_students(parsed2.get("students"), roster_set)
            if students2:
                second = {s["name"]: s for s in students2}
                merged_att = []
                for s in students:
                    other = second.pop(s["name"], None)
                    if other is None:
                        merged_att.append(s)
                    elif other["status"] == s["status"]:
                        merged_att.append({**s, "confidence": max(s["confidence"], other["confidence"], 0.9)})
                    else:
                        merged_att.append({**s, "confidence": 0.35})
                merged_att.extend(second.values())
                students = merged_att
        except Exception:  # noqa: BLE001
            pass  # best-effort; single pass is still returned

    return JSONResponse({"students": students, "unmatched": unmatched, "notes": notes})
