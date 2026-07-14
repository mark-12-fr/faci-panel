"""
vision.py — Photo → structured data (attendance letters / record scores).
========================================================================
Python port of the Vercel `api/vision-analyze.js` serverless function — same
request/response contract and Gemini-primary / Groq-fallback strategy, with an
accuracy-hardened read path on top:

  • greedy decoding (temperature 0) + HIGH media resolution + thinking models
  • strict responseSchema on Gemini (student names constrained to the exact
    roster strings), dropped gracefully per model on 400
  • record scans: 2 DECORRELATED reads (the verification pass re-reads the
    sheet bottom-up on a rotated model order so both passes can't repeat the
    same first-impression error), then a targeted per-cell majority-of-3
    tie-break that names the disputed rows; cells with no majority are
    confidence-flagged (0.35) so the review modal forces the facilitator to
    verify them
  • attendance scans: decorrelated verification re-read; disagreements flagged
  • row-order cross-check in every prompt (class sheets are roster-ordered)
  • image-before-text part order (Gemini single-image best practice)
  • per-cell confidence: one doubtful cell flags the student (min over cells)
  • row cross-check: two students claiming the same sheet row within one pass
    flags both (physically impossible → the pass slipped rows there)
  • multi-column scans verify COLUMN-MAJOR — a row-shift made reading
    row-by-row is almost never repeated reading column-by-column

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
CHUNK_SIZE = 35

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
    roster_ids: List[str] = Field(default_factory=list, alias="rosterIds")
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


def _roster_lines(roster: List[str], roster_ids: Optional[List[str]] = None) -> str:
    if roster_ids and len(roster_ids) == len(roster):
        return "\n".join(f"{i + 1}. [{rid}] {n}" for i, (n, rid) in enumerate(zip(roster, roster_ids)))
    return "\n".join(f"{i + 1}. {n}" for i, n in enumerate(roster))


def _id_anchor_section(roster_ids: Optional[List[str]]) -> str:
    if not roster_ids:
        return ""
    return (
        "\n\n═══ ID-ANCHORED MATCHING — PRIMARY & ONLY RELIABLE METHOD ═══\n"
        "The ID number is the ONLY unique identifier for each student. Names may be "
        "abbreviated, misspelled, or share parts between students.\n\n"
        "ID MATCHING RULES (follow STRICTLY):\n"
        "  [1] Find the ID number column on the sheet. It contains codes like "
        "\"04-2526-121141\".\n"
        "  [2] For each student in the ROSTER below, locate their ID number on the "
        "sheet. That row belongs to that student — NO EXCEPTIONS.\n"
        "  [3] Read the score(s) from THAT SAME ROW only. Do NOT shift up or down.\n"
        "  [4] Use the student's name only as a secondary verification — NOT for "
        "matching.\n"
        "  [5] If the photo does NOT show ID numbers, fall back to name matching.\n"
    )


def _layout_note() -> str:
    return (
        "\n═══ SHEET LAYOUT (standard Filipino grade sheet) ═══\n"
        "Column order: # | STUDENT NAME | ID NUMBER | O | 1 | 2 | ... | 25 | "
        "1 | 2 | ... | 10 | AT | PT 1 | PT 2 | QE\n"
        "NOTE: Column 'O' (Orientation) comes BEFORE Module 1. Do NOT read 'O' "
        "as Module 1. Module 1 is the column AFTER 'O'.\n"
    )


ROW_ORDER_NOTE = (
    "\n═══ ROW ALIGNMENT — CRITICAL ═══\n"
    "Class sheets list students in EXACTLY the same ORDER as the ROSTER below (alphabetical).\n"
    "Row 1 in the photo = roster entry 1. Row 2 = roster entry 2. And so on.\n"
    "Use this ONE-TO-ONE alignment as your PRIMARY sanity check: if a score seems "
    "misaligned (e.g. you read a value but the next student's score looks like it "
    "should belong to the previous student), STOP and re-check the row mapping.\n"
    "A single row-shift error will misalign EVERY score below it — this is the MOST "
    "COMMON and MOST DANGEROUS mistake. Verify the alignment before writing any scores.\n"
)


def verification_prompt(prompt: str, column_major: bool = False) -> str:
    """Decorrelated second read: scanning the sheet in a different order breaks
    correlated first-impression errors (row shifts, repeated misreads). For
    multi-column scans the strongest decorrelation is COLUMN-MAJOR reading —
    a row-shift error made while reading row-by-row is almost never repeated
    when reading the same table column-by-column."""
    if column_major:
        return (
            "INDEPENDENT VERIFICATION PASS — this time read the table COLUMN BY COLUMN: "
            "finish one requested column from top to bottom (tracking which row each value "
            "sits on), then move to the next column, and only then assemble the per-student "
            "results. Apply every rule below as if reading the photo for the first time.\n\n"
            + prompt
        )
    return (
        "INDEPENDENT VERIFICATION PASS — re-read the sheet starting from the BOTTOM row "
        "and working UPWARD, so you do not repeat a first-impression error. Apply every "
        "rule below as if reading the photo for the first time.\n\n" + prompt
    )


def focus_prompt(prompt: str, disputed: List[str]) -> str:
    """Targeted tie-break read: tell the model exactly which rows earlier passes
    disagreed on so it spends its attention there."""
    names = "\n".join(f"  • {n}" for n in disputed[:40])
    return (
        "TIE-BREAK PASS — two earlier reads of this photo DISAGREED on the following "
        "students' cells. Re-examine THESE rows with extra care (count the digits, check "
        "each digit's shape) before answering. Still output every student you can read, "
        "not just these:\n" + names + "\n\n" + prompt
    )


# ── Gemini structured-output schemas ─────────────────────────────────────────
# Constraining `name` to the exact roster strings eliminates name drift (case,
# spacing, accents) at the decoder level; sanitizers below stay as the backstop.

def build_record_schema(roster: List[str], target_fields: List[str]) -> dict:
    fields = [f for f in (target_fields or RECORD_FIELDS) if f in RECORD_FIELD_SET]
    return {
        "type": "OBJECT",
        "properties": {
            "students": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        # `row` = the sheet row this student was read from (the
                        # '#' column when printed, else ordinal position). Two
                        # students claiming the same row is physically
                        # impossible — used server-side to flag row-alignment
                        # slips for review.
                        "row": {"type": "NUMBER"},
                        "name": {"type": "STRING", "enum": list(roster)},
                        "scores": {
                            "type": "OBJECT",
                            "properties": {f: {"type": "NUMBER"} for f in fields},
                        },
                        # Per-cell 0..1 confidence keyed like `scores` — lets the
                        # model doubt ONE cell without tanking the whole student.
                        "cell_confidence": {
                            "type": "OBJECT",
                            "properties": {f: {"type": "NUMBER"} for f in fields},
                        },
                        "confidence": {"type": "NUMBER"},
                    },
                    "required": ["name", "scores"],
                    "propertyOrdering": ["row", "name", "scores", "cell_confidence", "confidence"],
                },
            },
            "unmatched": {"type": "ARRAY", "items": {"type": "STRING"}},
            "notes": {"type": "STRING"},
        },
        "required": ["students"],
        "propertyOrdering": ["students", "unmatched", "notes"],
    }



def build_record_prompt(roster: List[str], target_fields, roster_ids: Optional[List[str]] = None) -> str:
    raw = target_fields if isinstance(target_fields, list) else ([target_fields] if target_fields else [])
    fields = [f for f in (str(x or "").strip() for x in raw) if f in RECORD_FIELD_SET]

    if len(fields) >= 2:
        label_list = "\n  • ".join(f'{_field_label(f)} (key: "{f}")' for f in fields)
        schema_scores = ", ".join(f'"{f}": <number>' for f in fields)
        return (
            "You are a METICULOUS PROCTOR reading a handwritten Filipino classroom grade book. "
            f"The facilitator has told you this photo contains scores for EXACTLY these {len(fields)} "
            "columns (ignore every OTHER column in the photo):\n  • " + label_list + "\n\n"
            + _id_anchor_section(roster_ids)
            + "═══ 100% ACCURACY REQUIRED ═══\n"
            "This is a REAL grade sheet. There is NO room for error. Every digit you "
            "output directly affects a student's final grade.\n\n"
            "ROW ALIGNMENT IS EVERYTHING:\n"
            "  • The ID number in the photo is the GROUND TRUTH for which row belongs "
            "to which student. Do NOT guess based on name alone.\n"
            "  • If the ID matches, that entire row's scores belong to that student.\n"
            "  • NEVER shift a score up or down by one row. Row-shift errors are the "
            "#1 cause of wrong grades. DOUBLE-CHECK every row before writing scores.\n\n"
            "YOUR JOB: for each student on the ROSTER below, find their row, then read the handwritten "
            "number in EACH of the above columns for that row. Put each into scores using its field key.\n\n"
            "═══ RULES (follow strictly) ═══\n"
            "  ★ CRITICAL: EVERY student on the roster MUST appear in students[]. "
            "No exceptions. If a cell is blank/unreadable, omit that field key from that student's scores object.\n"
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
            + ROW_ORDER_NOTE + "\n"
            + _layout_note()
            + "OUTPUT — STRICT JSON ONLY, no prose, no markdown:\n"
            "{\n"
            '  "students": [ { "row": <sheet row number for this student>, "name": "<exact roster name>", '
            '"scores": { ' + schema_scores + ' }, "cell_confidence": { "<field>": <0..1 for that cell> }, '
            '"confidence": <0..1 overall> } ],\n'
            '  "unmatched": [ "<name text seen in photo>" ],\n'
            '  "notes": "<optional one-line observation>"\n'
            "}\n"
            '"row" is the row you read the student from (the # column if printed, else counting data rows '
            "from 1). Two students can NEVER share a row.\n\n"
            "ROSTER (match names to these exact strings):\n"
            + _roster_lines(roster, roster_ids)
        )

    target_field = fields[0] if len(fields) == 1 else None
    target_label = _field_label(target_field)
    if target_field and target_field in RECORD_FIELD_SET:
        return (
            "You are a METICULOUS PROCTOR reading a handwritten Filipino classroom grade book. "
            "The facilitator has told you this photo contains scores for ONE specific field: "
            + target_label + ' (field key: "' + target_field + '"). You must read every student\'s '
            "score in that ONE column with the care of a person double-checking their own work.\n\n"
            + _id_anchor_section(roster_ids)
            + "═══ 100% ACCURACY REQUIRED ═══\n"
            "This is a REAL grade sheet. There is NO room for error. Every digit you "
            "output directly affects a student's final grade. Read each cell as if "
            "a person's academic record depends on it — because it does.\n\n"
            "ROW ALIGNMENT IS EVERYTHING:\n"
            "  • The ID number in the photo is the GROUND TRUTH for which row belongs "
            "to which student. Do NOT guess based on name alone.\n"
            "  • If the ID matches, that entire row's scores belong to that student.\n"
            "  • NEVER shift a score up or down by one row. Row-shift errors are the "
            "#1 cause of wrong grades. DOUBLE-CHECK every row before writing scores.\n\n"
            + "═══ STEP-BY-STEP PROCEDURE (do NOT skip any step) ═══\n\n"
            "STEP 0 — EVERY student on the roster MUST appear in students[]. "
            "No exceptions. If a cell is blank/unreadable, omit scores[\"" + target_field + "\"] for that student.\n\n"
            "STEP 1 — LOCATE the " + target_label + " column. If the photo shows a table with a "
            "header row, identify the column labeled " + target_label + " (or its short form like "
            + target_field.replace("_", " ").upper() + "). Every score you extract must come "
            "from THIS column and no other.\n\n"
            "STEP 2 — For each student on the ROSTER below, find their row in the photo (the row "
            "whose Student Name matches the roster name). Then find the CELL that is on that row "
            "AND in the " + target_label + " column. That intersection is the cell you must read.\n"
            + ROW_ORDER_NOTE + "\n"
            + _layout_note()
            + "STEP 3 — Before writing any number, count the DIGITS in the cell:\n"
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
            '  "students": [ { "row": <sheet row number>, "name": "<exact roster name>", "scores": { "'
            + target_field + '": <number> }, "cell_confidence": { "' + target_field
            + '": <0..1> }, "confidence": <0..1> } ],\n'
            '  "unmatched": [ "<name text seen in photo>" ],\n'
            '  "notes": "<optional one-line observation, e.g. photo blur>"\n'
            "}\n"
            '"row" is the row you read the student from (the # column if printed, else counting data rows '
            "from 1). Two students can NEVER share a row.\n\n"
            "Match student names in the photo to the ROSTER (ground truth). Tolerate small OCR "
            "errors in names, but names in `students[].name` MUST match the roster string EXACTLY.\n\n"
            "ROSTER (match names to these exact strings):\n"
            + _roster_lines(roster, roster_ids)
        )

    return (
        "You are analyzing a photo of a classroom RECORD / GRADE BOOK page from a school in the Philippines. "
        "Rows are students, columns are score-holding fields.\n\n"
        + _id_anchor_section(roster_ids)
        + "═══ 100% ACCURACY REQUIRED ═══\n"
        "This is a REAL grade sheet. There is NO room for error. Every digit you "
        "output directly affects a student's final grade.\n\n"
        "ROW ALIGNMENT IS EVERYTHING:\n"
        "  • The ID number in the photo is the GROUND TRUTH for which row belongs "
        "to which student. Do NOT guess based on name alone.\n"
        "  • If the ID matches, that entire row's scores belong to that student.\n"
        "  • NEVER shift a score up or down by one row. Row-shift errors are the "
        "#1 cause of wrong grades. DOUBLE-CHECK every row before writing scores.\n\n"
        "CRITICAL: EVERY student on the roster MUST appear in students[]. "
        "No exceptions. If a cell is blank/unreadable, omit that field from that student's scores object.\n\n"
        "STEP 1: Identify the header row. Read each column header and map it to the exact field key below.\n"
        "STEP 2: Read each student row from top to bottom. Match the name in the photo to the closest roster name.\n"
        "STEP 3: For each matched student, read the score from each column and record it under the correct field key.\n"
        "STEP 4: If a student has NO readable scores, still include them with an empty scores object.\n\n"
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
        "- NEVER invent a name not on the roster. NEVER fabricate a score for a blank cell.\n"
        + ROW_ORDER_NOTE + "\n"
        + _layout_note()
        + "SCORE READING RULES:\n"
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
        '    { "row": <sheet row number>, "name": "<exact roster name>", "scores": { "<field_key>": <number>, ... }, '
        '"cell_confidence": { "<field_key>": <0..1>, ... }, "confidence": <0..1> },\n'
        "    ...\n"
        "  ],\n"
        '  "unmatched": [ "<name text seen in photo but not matched>" ],\n'
        '  "notes": "<optional observation>"\n'
        "}\n\n"
        "ROSTER (use these exact names for matching):\n"
        + _roster_lines(roster, roster_ids)
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


async def gemini_vision(
    api_key: str,
    prompt: str,
    image_b64: str,
    mime_type: str,
    prefer_accurate: bool = False,
    response_schema: Optional[dict] = None,
    rotate: int = 0,
) -> str:
    pinned = settings.GEMINI_VISION_MODEL
    if pinned:
        models = [pinned]
    else:
        models = RECORD_MODEL_ORDER if prefer_accurate else GEMINI_MODELS
        if rotate:
            # Decorrelate consensus passes: starting the fallback chain on a
            # different model keeps pass errors independent (two greedy reads of
            # the SAME model mostly agree with each other, right or wrong).
            r = rotate % len(models)
            models = models[r:] + models[:r]
    last_err = None
    models_tried = 0
    models_rate_limited = 0
    async with httpx.AsyncClient(timeout=120) as client:
        for m in models:
            models_tried += 1
            model_rate_limited = False
            # Per-model parameter negotiation. Start with everything that helps
            # accuracy — strict-JSON output, an exact response schema (names
            # constrained to the roster strings), HIGH media resolution (more
            # image tokens = far better small-handwritten-digit legibility on
            # dense tables), and thinking on 2.5 models (reasoning before
            # answering measurably reduces row/column mix-ups). If a model 400s
            # on a specific parameter, drop just that flag and retry the model.
            flags = {"json": True, "schema": bool(response_schema), "hires": True, "think": "2.5" in m}
            for _attempt in range(5):
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
                        if flags["schema"]:
                            gen["responseSchema"] = response_schema
                    if flags["hires"]:
                        gen["mediaResolution"] = "MEDIA_RESOLUTION_HIGH"
                    if flags["think"]:
                        gen["thinkingConfig"] = {"thinkingBudget": -1}  # dynamic
                    r = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}",
                        headers={"Content-Type": "application/json"},
                        json={
                            "contents": [{
                                # Image BEFORE the text: Gemini's documented
                                # best practice for single-image prompts —
                                # measurably better grounding of the
                                # instructions in the picture.
                                "parts": [
                                    {"inline_data": {"mime_type": mime_type, "data": image_b64}},
                                    {"text": prompt},
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
                        if flags["schema"] and re.search(r"response_?schema|enum|too (?:large|long)", last_err, re.I):
                            flags["schema"] = False
                            continue
                        if flags["think"] and re.search(r"thinking", last_err, re.I):
                            flags["think"] = False
                            continue
                        if flags["hires"] and re.search(r"media_?resolution", last_err, re.I):
                            flags["hires"] = False
                            continue
                        if flags["json"] and re.search(r"response_?mime_?type", last_err, re.I):
                            flags["json"] = False
                            continue
                        if flags["schema"]:
                            # Unrecognized 400 while a schema is attached — the
                            # schema is the most likely culprit; retry without it
                            # before giving up on this model.
                            flags["schema"] = False
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
            out.append({"name": name, "scores": {}, "confidence": 0.2})
            continue
        seen.add(name)
        # Student confidence = the WORST cell: overall confidence min'd with
        # every per-cell confidence for a field we kept. One doubtful cell must
        # flag the student for review even when the rest are clear.
        conf = _clamp_conf(item.get("confidence"))
        raw_cc = item.get("cell_confidence") if isinstance(item.get("cell_confidence"), dict) else {}
        for field, cval in raw_cc.items():
            if field in scores:
                conf = min(conf, _clamp_conf(cval))
        entry: Dict[str, Any] = {"name": name, "scores": scores, "confidence": conf}
        # `row` = which sheet row the model read this student from. Kept for the
        # duplicate-row cross-check downstream; stripped before the response.
        try:
            row = int(float(item.get("row")))
            if 1 <= row <= 500:
                entry["row"] = row
        except (TypeError, ValueError):
            pass
        out.append(entry)
    return out


def record_disputed_names(a: List[dict], b: List[dict]) -> List[str]:
    """Roster names whose shared cells the two passes read differently."""
    bmap = {s["name"]: (s.get("scores") or {}) for s in b}
    disputed: List[str] = []
    for s in a:
        sb = bmap.get(s["name"])
        if not sb:
            continue
        for f, v in (s.get("scores") or {}).items():
            if f in sb and float(sb[f]) != float(v):
                disputed.append(s["name"])
                break
    return disputed


def flag_duplicate_rows(merged: List[dict], passes: List[List[dict]]) -> None:
    """Two students can never occupy the same sheet row. If any single pass
    read two roster names off one row number, that pass slipped rows somewhere
    around that point — cap every implicated student's confidence so the
    review modal flags them for a human check. (Rows are compared only WITHIN
    a pass; different passes may legitimately count rows differently.)"""
    suspect: set = set()
    for p in passes:
        rows_seen: Dict[int, str] = {}
        for s in p:
            r = s.get("row")
            if r is None:
                continue
            other = rows_seen.get(r)
            if other is not None and other != s["name"]:
                suspect.add(other)
                suspect.add(s["name"])
            else:
                rows_seen[r] = s["name"]
    for s in merged:
        if s["name"] in suspect:
            s["confidence"] = min(s["confidence"], 0.45)


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
            out.append({"name": name, "scores": {}, "confidence": 0.2})
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
    roster_ids = [str(x or "").strip() for x in body.roster_ids] if body.roster_ids else []
    if roster_ids and len(roster_ids) != len(roster):
        roster_ids = []

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

    # Chunk large record rosters for better accuracy
    if type_ == "record" and len(roster) > CHUNK_SIZE:
        all_students: List[dict] = []
        all_unmatched: List[str] = []
        all_notes: List[str] = []
        for i in range(0, len(roster), CHUNK_SIZE):
            chunk_names = roster[i:i + CHUNK_SIZE]
            chunk_ids = roster_ids[i:i + CHUNK_SIZE] if roster_ids else None
            prompt = build_record_prompt(chunk_names, target_fields, chunk_ids)
            schema = build_record_schema(chunk_names, target_fields)

            raw_reply = None
            if gemini_key:
                try:
                    raw_reply = await gemini_vision(
                        gemini_key, prompt, image_b64, mime_type,
                        prefer_accurate=True, response_schema=schema,
                    )
                except (_RateLimit, _Upstream):
                    pass

            if not raw_reply and groq_key:
                try:
                    raw_reply = await groq_vision(groq_key, prompt, image_b64, mime_type)
                except (_RateLimit, _Upstream):
                    pass

            if raw_reply:
                try:
                    parsed = parse_vision_json(raw_reply)
                    chunk_set = set(chunk_names)
                    chunk_students = sanitize_record_students(parsed.get("students"), chunk_set)
                    if chunk_students:
                        all_students.extend(chunk_students)
                    if isinstance(parsed.get("unmatched"), list):
                        all_unmatched.extend(str(n or "").strip() for n in parsed["unmatched"] if str(n or "").strip())
                    n = str(parsed.get("notes") or "").strip()[:240]
                    if n:
                        all_notes.append(n)
                except Exception:
                    pass
        return JSONResponse({
            "students": all_students,
            "unmatched": all_unmatched[:30],
            "notes": " | ".join(all_notes)[:480],
        })

    if type_ == "record":
        prompt = build_record_prompt(roster, target_fields, roster_ids if roster_ids else None)
        schema = build_record_schema(roster, target_fields)
    else:
        prompt = build_record_prompt(roster, target_fields, roster_ids if roster_ids else None)
        schema = build_record_schema(roster, target_fields)

    # Step 1: Gemini (primary)
    raw_reply = None
    if gemini_key:
        try:
            # Accuracy-first model ordering for BOTH scan types — attendance
            # letters deserve the same care as record scores.
            raw_reply = await gemini_vision(
                gemini_key, prompt, image_b64, mime_type,
                prefer_accurate=True, response_schema=schema,
            )
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
    students = sanitize_record_students(parsed.get("students"), roster_set)
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
            # Pass 2 is DECORRELATED from pass 1: it re-reads the sheet
            # bottom-up on a rotated model order, so the two passes cannot
            # simply repeat the same first-impression mistake.
            # Multi-column scans verify COLUMN-MAJOR (strongest row-shift
            # decorrelation); single-column scans verify bottom-up.
            raw_reply2 = await gemini_vision(
                gemini_key, verification_prompt(prompt, column_major=len(target_fields) >= 2),
                image_b64, mime_type,
                prefer_accurate=True, response_schema=schema, rotate=1,
            )
            parsed2 = parse_vision_json(raw_reply2)
            students2 = sanitize_record_students(parsed2.get("students"), roster_set)
            passes = [students, students2]
            disputed = record_disputed_names(students, students2) if students2 else []
            if disputed:
                try:
                    # Pass 3 tie-break is TARGETED: it names the disputed rows
                    # so the strongest model spends its attention exactly there.
                    raw_reply3 = await gemini_vision(
                        gemini_key, focus_prompt(prompt, disputed), image_b64, mime_type,
                        prefer_accurate=True, response_schema=schema,
                    )
                    parsed3 = parse_vision_json(raw_reply3)
                    students3 = sanitize_record_students(parsed3.get("students"), roster_set)
                    if students3:
                        passes.append(students3)
                except Exception:  # noqa: BLE001
                    pass  # tie-break is best-effort; 2-pass merge still applies
            students = merge_record_consensus(passes, target_fields)
            flag_duplicate_rows(students, passes)
            notes2 = str(parsed2.get("notes") or "").strip()
            if notes2 and notes2 not in notes:
                notes = (notes + " | " if notes else "") + notes2
                notes = notes[:240]
        except Exception:  # noqa: BLE001
            pass  # best-effort; fall back to single pass

    if type_ == "record":
        # Row cross-check also covers the single-pass path (Groq fallback / no
        # explicit fields) — after a consensus merge the entries carry no `row`
        # key, so this is a no-op there. Then strip internal keys: the response
        # contract stays exactly {name, scores, confidence}.
        flag_duplicate_rows(students, [students])
        for s in students:
            s.pop("row", None)

    return JSONResponse({"students": students, "unmatched": unmatched, "notes": notes})
