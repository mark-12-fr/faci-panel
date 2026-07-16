/**
 * api/vision-analyze.js — Vercel Serverless Function: photo → structured data.
 * =====================================================================
 * Takes a photo of an attendance sheet, sends it to a vision LLM, and returns
 * each recognized student's attendance status (Present / Absent / Late /
 * Excused) matched against the roster the caller passed in. The client shows a
 * preview + review UI so a facilitator can correct any AI mistake before
 * applying to the actual attendance form.
 *
 * Primary provider: Google Gemini (fast, free-tier friendly, native vision).
 * Optional fallback: Groq (Llama 4 Scout / Maverick) — only used if Gemini
 * is unconfigured or hitting its free-tier rate limit AND GROQ_API_KEY is set.
 *
 * Required Vercel env vars (either one is enough; Gemini is preferred):
 *   GEMINI_API_KEY   — primary provider.
 *   GROQ_API_KEY     — optional fallback.
 * Optional model overrides:
 *   GEMINI_VISION_MODEL     — pin a specific Gemini model
 *   GROQ_VISION_MODEL       — pin a specific Groq vision model
 *
 * Request (POST JSON):
 *   {
 *     type: "attendance" | "record",
 *     imageBase64: "...",         // no "data:image/...;base64," prefix
 *     mimeType: "image/jpeg",     // MUST be provided; jpeg/png/webp
 *     roster: ["ALISEN, JOHN REN ALAGOS", ...]  // canonical names to match
 *   }
 *
 * Response (200) for "attendance":
 *   {
 *     students: [
 *       { name: "ALISEN, JOHN REN ALAGOS", status: "Present", confidence: 0.95 },
 *       ...
 *     ],
 *     unmatched: [...],
 *     notes: "..."
 *   }
 *
 * Response (200) for "record":
 *   {
 *     students: [
 *       {
 *         name: "ALISEN, JOHN REN ALAGOS",
 *         scores: { module_1: 8, module_2: 10, ..., pt_1: 45, qe: 47 },
 *         confidence: 0.85
 *       },
 *       ...
 *     ],
 *     unmatched: [...],
 *     notes: "..."
 *   }
 */

const GROQ_MODELS = [
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct'
];
// Prioritized list of Gemini model IDs to try. The list is generous on purpose:
// Google renames/retires models over time, so we walk down until one accepts the
// request. Auto-follow aliases first, then explicit stable IDs, then older
// still-available fallbacks.
const GEMINI_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash'
];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB after base64 decode — Vercel body limit is 4.5MB raw
const MAX_ROSTER = 200;

function buildAttendancePrompt(roster) {
    return (
        "You are analyzing a photo of a classroom attendance sheet from a school in the Philippines. " +
        "For each student on the ROSTER below, find their attendance cell and read the LETTER written in it:\n\n" +
        "  LETTER 'P' → \"Present\"\n" +
        "  LETTER 'A' → \"Absent\"\n" +
        "  LETTER 'L' → \"Late\"\n" +
        "  LETTER 'E' → \"Excused\"\n" +
        "  EMPTY / BLANK cell → \"Absent\"\n\n" +
        "NOTE: A small dot (.) or faint mark that is NOT clearly one of the letters P, A, L, E counts as BLANK → \"Absent\".\n" +
        "Only a clear, intentional letter P, A, L, or E should be read as marked.\n\n" +
        "CRITICAL — You MUST return ALL " + roster.length + " roster students:\n" +
        "  • students[] MUST have exactly " + roster.length + " entries in ROSTER ORDER. No omissions, no duplicates.\n" +
        "  • Read each row left-to-right, match to the roster name, then read the attendance letter.\n" +
        "  • If you CANNOT find a student's row, include them as Absent with confidence 0.2.\n\n" +
        "MATCHING RULES:\n" +
        "  • Match photo names to the closest roster name (tolerate missing accents, wrong middle initial).\n" +
        "  • Never invent names not on the roster. Names must match EXACTLY.\n\n" +
        "OUTPUT — STRICT JSON ONLY, no prose, no markdown:\n" +
        '{\n' +
        '  "students": [\n' +
        '    { "name": "<exact roster name>", "status": "Present", "confidence": 1.0 },\n' +
        '    { "name": "<exact roster name>", "status": "Absent", "confidence": 0.9 }\n' +
        '  ],\n' +
        '  "unmatched": [],\n' +
        '  "notes": ""\n' +
        '}\n\n' +
        "ROSTER (" + roster.length + " names — return exactly this many):\n" +
        roster.map((n, i) => (i + 1) + '. ' + n).join('\n')
    );
}

// Every score-holding field on the class_records table. The client and API
// both refer to this list to validate what the AI is allowed to return.
const RECORD_FIELDS = (function () {
    const arr = [];
    for (let i = 1; i <= 25; i++) arr.push('module_' + i);
    for (let i = 1; i <= 10; i++) arr.push('activity_' + i);
    arr.push('at', 'pt_1', 'pt_2', 'qe');
    return arr;
})();
const RECORD_FIELD_SET = new Set(RECORD_FIELDS);

// Shared, reusable guidance blocks so the multi-field and auto-detect prompts
// give the vision model the SAME careful rules for reading handwritten digits
// and for refusing to invent a score in a blank cell. Keeping them in one
// place means an accuracy tweak improves every mode at once.
const DIGIT_READING_RULES =
    "═══ HOW TO READ EACH HANDWRITTEN NUMBER ═══\n" +
    "  • First COUNT the digits in the cell: '8' is ONE digit; '10', '12', '15' are TWO digits.\n" +
    "    A one-digit and a two-digit number look DIFFERENT — do NOT round '8' up to '10'.\n" +
    "  • Digit shapes for the usual confusions:\n" +
    "      8 = two stacked loops    |  10 = a '1' then a '0' (TWO separate marks)\n" +
    "      0 = plain closed oval    |  6  = a loop at the BOTTOM only\n" +
    "      5 = flat top + curve     |  0  = closed oval  (so '15' is NOT '10')\n" +
    "      7 = flat top + diagonal  |  1  = a single vertical stroke\n" +
    "  • Numbers range 0..200. If a digit is genuinely ambiguous, give your best guess and LOWER confidence.\n";

const BLANK_CELL_RULES =
    "═══ BLANK CELLS — NEVER INVENT A SCORE ═══\n" +
    "  • A cell that is empty, blank, a dash '-', a dot '.', a tick/check, or has NO clearly written\n" +
    "    number is UNANSWERED. For an unanswered cell you MUST omit that field for that student —\n" +
    "    do NOT write 0, do NOT guess, do NOT copy the value from the row above/below or a\n" +
    "    neighbouring column.\n" +
    "  • Leaving a score OUT is always better than inventing one. If a student left a cell blank,\n" +
    "    they must come back with NO value for that field.\n";

// The single most damaging record-scan error: an OFF-BY-ONE row shift, where a
// blank leading row gets skipped so every student ends up with the NEXT
// student's scores. This note (shared by every prompt mode) forbids compressing
// blank rows. Kept separate so all modes get the same wording.
const ROW_ALIGNMENT_NOTE =
    "═══ BLANK ROWS KEEP THEIR PLACE — NEVER SHIFT SCORES UP ═══\n" +
    "  • MANY students are blank in these columns (they have not submitted) — that is normal.\n" +
    "  • A blank row STILL occupies its position. NEVER skip a blank row, and NEVER pull the row\n" +
    "    BELOW it upward to fill it. If the 1st student's row is blank, the 1st student has NO\n" +
    "    score — do NOT give them the 2nd student's numbers.\n" +
    "  • The worst possible mistake is an off-by-one shift: every student getting the NEXT\n" +
    "    student's scores. Before you finish, sanity-check that each number really sits on ITS\n" +
    "    OWN student's row, not the row above or below.\n";

// Build the ROSTER section shared by every record-prompt mode. When ID numbers
// are available it anchors each row on its ID — the unique per-row marker in
// the leftmost column — which is the strongest defence against the model
// drifting onto the wrong row. Row-drift/off-by-one is exactly why some rows
// misread while the rest are fine.
function _rosterBlock(roster, rosterIds) {
    const ids = Array.isArray(rosterIds) ? rosterIds : [];
    const haveIds = ids.some((x) => String(x || '').trim());
    if (haveIds) {
        const lines = roster.map((n, i) => {
            const id = String(ids[i] || '').trim();
            return (i + 1) + '. ' + (id ? '[ID ' + id + '] ' : '') + n;
        }).join('\n');
        return (
            "═══ ANCHOR EACH ROW ON ITS ID NUMBER ═══\n" +
            "  • If the ID Number (or Student Name) column IS visible in this photo, use it as your\n" +
            "    anchor: for each roster entry below, FIND the row whose ID/name matches, then read\n" +
            "    THAT row's scores. The ID is unique per student — the surest way to stay on the right row.\n" +
            "  • If the ID/name column is NOT visible (the photo shows only score columns), then the\n" +
            "    roster below is in the EXACT top-to-bottom order of the rows: 1st entry = 1st row,\n" +
            "    2nd entry = 2nd row, counting EVERY row — including blank ones.\n" +
            "  • Re-check the anchor before recording each row; a score belongs to the student on THAT\n" +
            "    physical row, never the row above or below.\n" +
            "  • CRITICAL: in your output, put the ID Number you actually read on each row into that\n" +
            "    student's \"id\" field, copied EXACTLY from the sheet. We use it to place the scores on\n" +
            "    the right student, so read it as carefully as the scores. Leave \"id\" empty only if the\n" +
            "    ID column is genuinely not visible in the photo.\n\n" +
            ROW_ALIGNMENT_NOTE + "\n" +
            "ROSTER (match each to its row by ID Number when visible, else by exact top-to-bottom order; the name must match exactly):\n" +
            lines
        );
    }
    return (
        ROW_ALIGNMENT_NOTE + "\n" +
        "The roster below is in the EXACT top-to-bottom order of the sheet's rows — 1st entry = 1st\n" +
        "row, 2nd = 2nd row, counting EVERY row including blank ones.\n\n" +
        "ROSTER (match names to these exact strings):\n" +
        roster.map((n, i) => (i + 1) + '. ' + n).join('\n')
    );
}

function buildRecordPrompt(roster, targetFields, rosterIds) {
    // Normalize to an array of valid field keys.
    const fields = (Array.isArray(targetFields) ? targetFields : (targetFields ? [targetFields] : []))
        .map(f => String(f || '').trim())
        .filter(f => RECORD_FIELD_SET.has(f));

    // Multi-field mode: the facilitator told us EXACTLY which columns this
    // photo covers (e.g. Module 1 + Module 2). Read only those columns.
    if (fields.length >= 2) {
        const labelList = fields.map(f => _fieldLabel(f) + ' (key: "' + f + '")').join('\n  • ');
        const schemaScores = fields.map(f => '"' + f + '": <number>').join(', ');
        return (
            "You are a METICULOUS PROCTOR reading a handwritten Filipino classroom grade book. " +
            "The facilitator has told you this photo contains scores for EXACTLY these " + fields.length +
            " columns (ignore every OTHER column in the photo):\n  • " + labelList + "\n\n" +

            "═══ MATCH EACH COLUMN BY ITS HEADER — DO NOT GUESS BY POSITION ═══\n" +
            "This is the most important rule. Getting two columns' values swapped is the single most\n" +
            "common mistake, so guard against it deliberately:\n" +
            "  • Do NOT assume the columns appear in the same order I listed them above.\n" +
            "  • FIRST read the table's HEADER row. For EACH target column, find the physical column in\n" +
            "    the photo whose header text matches that field's label — e.g. the value for MODULE 3\n" +
            "    must come from the column headed 'M3' / 'MODULE 3', and MODULE 4 from the column headed\n" +
            "    'M4' / 'MODULE 4'. Never store a value under a neighbouring column's key.\n" +
            "  • If two target columns sit next to each other, trace each one down from its header\n" +
            "    carefully so you do not read MODULE 3's cell into module_4 or vice-versa.\n" +
            "  • If you cannot clearly tell which field a column's header refers to, OMIT that column\n" +
            "    rather than guess where it goes.\n\n" +

            "YOUR JOB: for each student on the ROSTER below, find their row, then read the handwritten " +
            "number in EACH matched column for that row and store it under THAT column's field key.\n\n" +

            DIGIT_READING_RULES + "\n" +
            BLANK_CELL_RULES + "\n" +

            "═══ MORE RULES ═══\n" +
            "  • Each student's numbers are INDEPENDENT — do NOT copy one student's value to the next.\n" +
            "  • Match names to the ROSTER exactly (tolerate small OCR errors in the name).\n" +
            "  • Only include a student who has AT LEAST ONE readable score among these columns.\n\n" +

            "OUTPUT — STRICT JSON ONLY, no prose, no markdown:\n" +
            "{\n" +
            '  "students": [ { "name": "<exact roster name>", "id": "<ID Number written in THIS row, exactly; empty if the ID column is not visible>", "scores": { ' + schemaScores + ' }, "confidence": <0..1> } ],\n' +
            '  "unmatched": [ "<name text seen in photo>" ],\n' +
            '  "notes": "<optional one-line observation>"\n' +
            "}\n\n" +
            _rosterBlock(roster, rosterIds)
        );
    }

    // Single-field mode (fields.length === 1) or legacy single string.
    const targetField = fields.length === 1 ? fields[0] : null;
    const targetLabel = _fieldLabel(targetField);
    if (targetField && RECORD_FIELD_SET.has(targetField)) {
        // Single-field mode: the facilitator has already told us which column
        // this photo is for. Just read ONE column of numbers matched to
        // student names -- much easier for the vision model than parsing
        // arbitrary column headers.
        return (
            "You are a METICULOUS PROCTOR reading a handwritten Filipino classroom grade book. " +
            "The facilitator has told you this photo contains scores for ONE specific field: " +
            targetLabel + " (field key: \"" + targetField + "\"). You must read every student's " +
            "score in that ONE column with the care of a person double-checking their own work.\n\n" +

            "═══ STEP-BY-STEP PROCEDURE (do NOT skip any step) ═══\n\n" +

            "STEP 1 — LOCATE the " + targetLabel + " column. If the photo shows a table with a " +
            "header row, identify the column labeled " + targetLabel + " (or its short form like " +
            targetField.replace('_', ' ').toUpperCase() + "). Every score you extract must come " +
            "from THIS column and no other.\n\n" +

            "STEP 2 — For each student on the ROSTER below, find their row in the photo (the row " +
            "whose Student Name matches the roster name). Then find the CELL that is on that row " +
            "AND in the " + targetLabel + " column. That intersection is the cell you must read.\n\n" +

            "STEP 3 — Before writing any number, count the DIGITS in the cell:\n" +
            "  • 0 digits → the cell is BLANK. Do NOT write a score for this student.\n" +
            "  • 1 digit  → single-digit number (0 through 9).\n" +
            "  • 2 digits → two-digit number (10 through 99).\n" +
            "  • 3 digits → three-digit number (100+; rare).\n" +
            "\n" +
            "  ★ '8' has ONE digit. '10' has TWO. '15' has TWO. These look DIFFERENT.\n" +
            "  ★ Do NOT round '8' to '10' or '15' to '10' just because '10' is common.\n\n" +

            "STEP 4 — For each digit you see, verify its SHAPE:\n" +
            "  • 0: closed oval or circle, no straight lines through the middle.\n" +
            "  • 1: a single vertical stroke (may have a tiny top serif or bottom flag).\n" +
            "  • 2: curved top and a flat or diagonal bottom (like a 'z').\n" +
            "  • 3: two right-facing bumps stacked (or open on the LEFT).\n" +
            "  • 4: crossed lines forming a closed top, plus a vertical line down (open '4' also common).\n" +
            "  • 5: flat horizontal top, then a downward stroke, then a bottom curve.\n" +
            "  • 6: a downward curve that closes at the bottom into a loop.\n" +
            "  • 7: a flat top with a diagonal stroke going down-left.\n" +
            "  • 8: two closed loops stacked (top loop and bottom loop).\n" +
            "  • 9: closed loop at the top and a straight or curved stroke down.\n\n" +

            "STEP 5 — Sanity-check common confusions:\n" +
            "  • '10' vs '8'  → 10 is TWO digits, 8 is ONE digit. If you see two clearly separate " +
            "shapes in the cell, it's TWO digits.\n" +
            "  • '15' vs '10' → the second digit is '5' (flat top + curve) NOT '0' (closed loop). " +
            "Look at the second digit shape.\n" +
            "  • '9'  vs '10' → 9 is ONE digit, 10 is TWO.\n" +
            "  • '7'  vs '1'  → 7 has a flat top-bar and a diagonal; 1 is a single vertical.\n" +
            "  • '0'  vs '6'  → 0 is a plain closed oval; 6 has a loop at the bottom only.\n\n" +

            "STEP 6 — CONFIDENCE. Assign confidence honestly:\n" +
            "  • 0.9+  → the digits are unambiguous and clearly written.\n" +
            "  • 0.7   → readable but with minor ambiguity you had to reason about.\n" +
            "  • 0.4-0.6 → you're not sure between two possibilities (e.g. '8' vs '3'). Flag it.\n" +
            "  • 0.2   → almost illegible / smudged / could be anything.\n\n" +

            "═══ DO-NOT LIST ═══\n" +
            "  ✗ Do NOT default a whole column to the same value. Each student's cell is INDEPENDENT.\n" +
            "  ✗ Do NOT copy the COLUMN HEADER as a score (headers may be numbers like '1', '10').\n" +
            "  ✗ Do NOT guess when you can't see clearly — return LOW confidence instead.\n" +
            "  ✗ Do NOT invent students not on the roster.\n" +
            "  ✗ Do NOT skip blank cells — just omit scores[\"" + targetField + "\"] for that student.\n" +
            "  ✗ Do NOT shift scores up/down — a score belongs to the student on THAT row, not the row above or below.\n\n" +

            "═══ OUTPUT ═══\n" +
            "Reply with STRICT JSON ONLY (no prose, no markdown, no code fences):\n" +
            "{\n" +
            '  "students": [ { "name": "<exact roster name>", "id": "<ID Number written in THIS row, exactly; empty if the ID column is not visible>", "scores": { "' + targetField +
                '": <number> }, "confidence": <0..1> } ],\n' +
            '  "unmatched": [ "<name text seen in photo>" ],\n' +
            '  "notes": "<optional one-line observation, e.g. photo blur>"\n' +
            "}\n\n" +

            "Match student names in the photo to the ROSTER (ground truth). Tolerate small OCR " +
            "errors in names, but names in `students[].name` MUST match the roster string EXACTLY.\n\n" +

            _rosterBlock(roster, rosterIds)
        );
    }

    // Multi-field / auto-detect mode (original behavior).
    return (
        "You are analyzing a photo of a classroom RECORD / GRADE BOOK page from a school in the Philippines. " +
        "Rows are students, columns are score-holding fields.\n\n" +
        "IMPORTANT — Only include a student in the students array if you can read AT LEAST ONE score " +
        "for them. Students with ALL blank cells should NOT appear in the output.\n\n" +
        "STEP 1: Identify the header row. Read each column header and map it to the exact field key below.\n" +
        "STEP 2: Read each student row from top to bottom. Match the name in the photo to the closest roster name.\n" +
        "STEP 3: For each matched student, read the score from each column and record it under the correct field key.\n" +
        "STEP 4: If EVERY cell in that student's row is blank/empty, OMIT that student entirely.\n\n" +
        "COLUMN → FIELD MAPPING (map the header text you see to the exact field key below):\n" +
        "- 'MODULE 1' / 'M1' / 'Mod 1' → module_1  (same pattern up to module_25)\n" +
        "- 'ACTIVITY 1' / 'A1' / 'Act 1' → activity_1  (same pattern up to activity_10)\n" +
        "- 'AT' / 'Attendance' → at\n" +
        "- 'PT 1' / 'PT1' / 'Performance Task 1' → pt_1\n" +
        "- 'PT 2' / 'PT2' / 'Performance Task 2' → pt_2\n" +
        "- 'QE' / 'Q.E.' / 'Quarterly Exam' / 'Exam' → qe\n" +
        "- If a header does not clearly map to one of the above field keys, IGNORE that entire column.\n" +
        "- Bind every score to the field key of the column HEADER above it — NEVER to a neighbouring\n" +
        "  column. Reading Module 3's cell into module_4 (or vice-versa) is the most common mistake:\n" +
        "  trace each value straight up to its own header before writing it.\n\n" +
        "NAME MATCHING RULES:\n" +
        "- Find each student's name in the leftmost column(s) of the photo. Match it to the EXACT ROSTER NAME below.\n" +
        "- Write the EXACT roster string in the \"name\" field — do NOT modify the name.\n" +
        "- NEVER invent a name not on the roster. NEVER fabricate a score for a blank cell.\n\n" +
        BLANK_CELL_RULES + "\n" +
        DIGIT_READING_RULES + "\n" +
        "SCORE READING RULES:\n" +
        "- Decimals are allowed but rare; prefer integers.\n" +
        "- If you're not confident about a value, still return your best guess and lower the confidence.\n" +
        "- A COMMON MISTAKE is assigning a score from one student to the next student. Double-check " +
        "that each score is on the CORRECT row and in the CORRECT column.\n\n" +
        "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose, no markdown fences. Exactly this shape:\n" +
        "{\n" +
        '  "students": [\n' +
        '    { "name": "<exact roster name>", "id": "<ID Number written in THIS row, exactly; empty if the ID column is not visible>", "scores": { "<field_key>": <number>, ... }, "confidence": <0..1> },\n' +
        '    ...\n' +
        '  ],\n' +
        '  "unmatched": [ "<name text seen in photo but not matched>" ],\n' +
        '  "notes": "<optional observation>"\n' +
        "}\n\n" +
        _rosterBlock(roster, rosterIds)
    );
}

function _fieldLabel(f) {
    if (!f) return '';
    if (f.startsWith('module_')) return 'MODULE ' + f.split('_')[1];
    if (f.startsWith('activity_')) return 'ACTIVITY ' + f.split('_')[1];
    if (f === 'at') return 'AT (Attendance)';
    if (f === 'pt_1') return 'PT 1 (Performance Task 1)';
    if (f === 'pt_2') return 'PT 2 (Performance Task 2)';
    if (f === 'qe') return 'QE (Quarterly Exam)';
    return f;
}

/**
 * Call Groq's OpenAI-compatible chat completions with a vision model.
 * Groq's Llama 4 Scout / Maverick models accept image_url content parts,
 * same shape as OpenAI. Uses `response_format: json_object` to force strict
 * JSON, and iterates through model fallbacks if the pinned one is retired.
 */
async function groqVision(apiKey, prompt, imageBase64, mimeType) {
    const pinned = process.env.GROQ_VISION_MODEL;
    const models = (pinned ? [pinned] : []).concat(GROQ_MODELS.filter((m) => m !== pinned));
    const dataUrl = 'data:' + mimeType + ';base64,' + imageBase64;
    let lastErr = null;
    for (const m of models) {
        try {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: m,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: dataUrl } }
                        ]
                    }],
                    temperature: 0.1,
                    max_tokens: 16384,
                    response_format: { type: 'json_object' }
                })
            });
            if (r.status === 200) {
                const data = await r.json();
                const reply = ((((data.choices || [{}])[0] || {}).message || {}).content || '').trim();
                if (reply) return reply;
                lastErr = 'empty reply';
            } else {
                const txt = await r.text();
                lastErr = r.status + ' ' + txt.slice(0, 300);
                // Rate/quota errors: propagate so the caller can decide to try Gemini.
                if (r.status === 429 || /rate|quota|limit/i.test(txt)) {
                    const e = new Error('rate limit');
                    e.code = 429;
                    throw e;
                }
                // Model-not-found / bad-request: try the next model.
                if (r.status !== 400 && r.status !== 404) break;
            }
        } catch (e) {
            if (e && e.code === 429) throw e;
            lastErr = String((e && e.message) || e);
        }
    }
    const err = new Error(lastErr || 'Groq returned no reply');
    err.raw = lastErr || '';
    throw err;
}

/**
 * Optional Gemini fallback — used only if GEMINI_API_KEY is set AND Groq is
 * missing or rate-limited. Same output contract as groqVision.
 */
async function geminiVision(apiKey, prompt, imageBase64, mimeType, opts) {
    const pinned = process.env.GEMINI_VISION_MODEL;
    // For record photos we prefer a stronger model first because small
    // handwritten digits (8 vs 10 vs 15) reward every extra bit of visual
    // reasoning. Attendance's simple P/A/L letters don't need it, so keep
    // flash-lite for that (faster + cheaper).
    const preferAccurate = !!(opts && opts.preferAccurate);
    const RECORD_MODEL_ORDER = [
        'gemini-2.5-pro',
        'gemini-flash-latest',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash',
        'gemini-2.0-flash-exp',
        'gemini-1.5-flash'
    ];
    // An explicit model list (opts.models) wins — the chunked record path uses
    // it to stick to FAST, high-rate-limit flash models and skip the slow,
    // heavily rate-limited 2.5-pro, so several chunks can finish within the
    // function's time budget instead of timing out (504).
    const models = pinned ? [pinned]
        : (opts && Array.isArray(opts.models) && opts.models.length) ? opts.models
        : (preferAccurate ? RECORD_MODEL_ORDER : GEMINI_MODELS);
    let lastErr = null;
    // Track whether EVERY model we tried came back rate-limited. Only then do
    // we surface a 429 to the caller -- a per-model 429 should just skip to
    // the next model. This matters for gemini-2.5-pro which is heavily rate-
    // limited on the free tier; the fallbacks (flash-latest, 2.5-flash) still
    // have plenty of headroom.
    let modelsTried = 0;
    let modelsRateLimited = 0;
    // Try each model up to twice: once WITH responseMimeType=application/json,
    // then WITHOUT it if the model rejects the field (Gemini sometimes returns
    // 400 INVALID_ARGUMENT on that param for older/preview models).
    for (const m of models) {
        modelsTried++;
        let modelRateLimited = false;
        for (const useJsonMime of [true, false]) {
            try {
                // 4k was not enough for a 50-student roster in JSON; bump to
                // 32k so we can comfortably fit ~200 students with room for
                // scores. Gemini 2.5 Flash supports up to 65535.
                const gen = { temperature: 0.1, maxOutputTokens: 32768 };
                if (useJsonMime) gen.responseMimeType = 'application/json';
                const r = await fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + apiKey,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: prompt },
                                    { inline_data: { mime_type: mimeType, data: imageBase64 } }
                                ]
                            }],
                            generationConfig: gen
                        })
                    }
                );
                const data = await r.json().catch(() => ({}));
                if (r.status === 200) {
                    const parts = (((data.candidates || [{}])[0] || {}).content || {}).parts || [];
                    const text = parts.map((p) => (p && p.text) || '').join('').trim();
                    if (text) return text;
                    lastErr = '[' + m + '] empty reply';
                    break; // next model
                }
                lastErr = '[' + m + '] ' + r.status + ' ' + JSON.stringify(data).slice(0, 300);
                if (r.status === 429 || /RESOURCE_EXHAUSTED/i.test(lastErr)) {
                    // This ONE model is rate-limited; skip to the next model.
                    // Only propagate a 429 to the caller after every model in
                    // the fallback list has been tried and rate-limited.
                    modelRateLimited = true;
                    break;
                }
                // If the model rejected responseMimeType, retry without it. Any
                // other 400 → next model. 404/403 → next model.
                if (useJsonMime && r.status === 400 && /responseMimeType|response_mime_type/i.test(lastErr)) {
                    continue;
                }
                break; // give up on this model, try the next
            } catch (e) {
                lastErr = '[' + m + '] ' + String((e && e.message) || e);
                break;
            }
        }
        if (modelRateLimited) modelsRateLimited++;
    }
    // Every model rate-limited → surface a 429 to the caller (so the handler
    // can fall through to Groq if it's configured). Otherwise raise the last
    // non-429 error we saw.
    if (modelsTried > 0 && modelsRateLimited === modelsTried) {
        const e = new Error(lastErr || 'rate limit');
        e.code = 429;
        e.raw = lastErr || '';
        throw e;
    }
    const err = new Error(lastErr || 'No usable Gemini model.');
    err.raw = lastErr || '';
    throw err;
}

// Strip JSON-comments (// line, /* block */) that live OUTSIDE of string
// literals. Gemini occasionally emits a comment mid-response even when
// asked for strict JSON; JSON.parse can't handle either kind.
function _stripJsonComments(s) {
    let out = '';
    let i = 0;
    const n = s.length;
    let inStr = false;
    let esc = false;
    while (i < n) {
        const c = s[i];
        if (inStr) {
            out += c;
            if (esc) { esc = false; }
            else if (c === '\\') { esc = true; }
            else if (c === '"') { inStr = false; }
            i++;
            continue;
        }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        // Line comment
        if (c === '/' && s[i + 1] === '/') {
            i += 2;
            while (i < n && s[i] !== '\n') i++;
            continue;
        }
        // Block comment
        if (c === '/' && s[i + 1] === '*') {
            i += 2;
            while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function parseVisionJSON(raw) {
    // The model was asked for strict JSON, but be defensive: strip code fences,
    // strip invisible chars + JSON comments, normalize smart quotes, drop
    // trailing commas, and finally try to close truncated brackets before
    // giving up. Gemini + Groq have all been observed doing at least one of
    // these things.
    let s = String(raw || '').trim();
    // Strip any leading/trailing code fences (```json ... ``` OR ``` ... ```).
    s = s.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '').trim();
    // Kill zero-width / BOM chars that JSON.parse tokenizes as unknown.
    s = s.replace(/[﻿​‌‍⁠]/g, '');
    // Extract the outermost {...} block ONLY if there's clearly a prose prefix
    // (i.e. the first non-whitespace char isn't `{`). Doing this
    // unconditionally would slice off a truncated tail and prevent salvage.
    if (s.length && s[0] !== '{') {
        const start = s.indexOf('{');
        if (start !== -1) s = s.slice(start);
    }
    // Same for prose SUFFIX: only trim to last `}` when the string ends
    // with non-JSON content beyond a fully closed object.
    if (s.length && s[s.length - 1] !== '}' && s[s.length - 1] !== ']') {
        // Look for a fully-balanced object; if there is one, keep it.
        const balanced = _findBalancedPrefix(s);
        if (balanced) s = balanced;
    }

    const attempts = [];
    attempts.push(s);
    // Lenient pass: strip comments, normalize smart quotes → ASCII, drop
    // trailing commas before ] or }.
    let s2 = _stripJsonComments(s)
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*(?=[}\]])/g, '');
    attempts.push(s2);
    // Best-effort salvage: if the AI response was cut off (maxOutputTokens),
    // trim to the last complete top-level object in students[] and close
    // whatever brackets remain open. Better a partial student list than none.
    const salvaged = _salvageTruncatedJson(s2);
    if (salvaged) attempts.push(salvaged);

    let lastErr;
    for (const candidate of attempts) {
        try { return JSON.parse(candidate); }
        catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('unparseable');
}

// Return the substring from position 0 through the first fully-balanced
// top-level object, or null if the string never balances.
function _findBalancedPrefix(s) {
    let d = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) { esc = false; }
            else if (c === '\\') { esc = true; }
            else if (c === '"') { inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{' || c === '[') d++;
        else if (c === '}' || c === ']') {
            d--;
            if (d === 0) return s.slice(0, i + 1);
        }
    }
    return null;
}

// If the JSON was truncated in the middle of an object, trim to the last
// safe cut point (a comma at depth 2 = inside students[]) and then close
// the brackets that were actually open AT THAT POINT (not at end-of-input).
// Yields a shorter-but-parseable object with the students we did fully see.
function _salvageTruncatedJson(s) {
    // First pass: is the whole string balanced? If yes, no salvage needed.
    // Also find the last comma at depth 2 (top-level of students[]).
    let d = 0, inStr = false, esc = false;
    let cut = -1;
    const stackAtCut = [];
    let currentStack = [];
    let stackAtCutSnapshot = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) { esc = false; }
            else if (c === '\\') { esc = true; }
            else if (c === '"') { inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{' || c === '[') { currentStack.push(c); d++; continue; }
        if (c === '}' || c === ']') { currentStack.pop(); d--; continue; }
        // A comma at depth 2 while directly inside students[] is a safe cut.
        // Depth 2 here means: main {, then students [, so d===2.
        if (c === ',' && d === 2 && currentStack[currentStack.length - 1] === '[') {
            cut = i;
            stackAtCutSnapshot = currentStack.slice();
        }
    }
    // Balanced already → nothing to salvage.
    if (d === 0 && !inStr && currentStack.length === 0) return null;
    if (cut === -1 || !stackAtCutSnapshot) return null;

    // Trim to the safe cut position (exclusive of the comma) and close the
    // brackets that were open THEN, in reverse (LIFO) order.
    let trimmed = s.slice(0, cut);
    for (let i = stackAtCutSnapshot.length - 1; i >= 0; i--) {
        trimmed += (stackAtCutSnapshot[i] === '{') ? '}' : ']';
    }
    return trimmed;
}

function sanitizeStudents(list, rosterSet) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const validStatuses = new Set(['Present', 'Absent', 'Late', 'Excused']);
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
        const status = String(item.status || '').trim();
        if (!name || !rosterSet.has(name) || !validStatuses.has(status)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        let conf = Number(item.confidence);
        if (!isFinite(conf) || conf < 0) conf = 0;
        if (conf > 1) conf = 1;
        out.push({ name, status, confidence: conf });
    }
    return out;
}

/**
 * Sanitize the AI's per-student score payload:
 *   - drop names not in the roster
 *   - drop unknown field keys
 *   - drop non-numeric, negative, or absurdly-large values (>200)
 *   - clamp confidence to [0..1]
 *   - dedupe by name (first entry wins)
 */
// Normalize an ID Number for tolerant matching (ignore case, spaces, dashes).
function _normId(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Map normalized ID Number -> canonical roster name, from parallel arrays.
function buildIdMap(names, ids) {
    const m = new Map();
    if (!Array.isArray(names) || !Array.isArray(ids)) return m;
    for (let i = 0; i < names.length; i++) {
        const nid = _normId(ids[i]);
        if (nid && !m.has(nid)) m.set(nid, names[i]);
    }
    return m;
}

// idMap (optional): when the model reports the ID Number it read on each row,
// we trust THAT over its name claim and reassign the scores to whichever roster
// student owns that ID. This repairs an off-by-one / row-shift at the source —
// the ID uniquely identifies the student no matter which row the model thought
// it was reading. Requires the ID column to be visible in the photo.
function sanitizeRecordStudents(list, rosterSet, idMap) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        let name = String(item.name || '').trim();
        if (idMap && idMap.size) {
            const nid = _normId(item.id);
            if (nid && idMap.has(nid)) name = idMap.get(nid); // ID wins over the name claim
        }
        if (!name || !rosterSet.has(name) || seen.has(name)) continue;

        const rawScores = item.scores && typeof item.scores === 'object' ? item.scores : {};
        const scores = {};
        for (const field of Object.keys(rawScores)) {
            if (!RECORD_FIELD_SET.has(field)) continue;
            const n = Number(rawScores[field]);
            if (!isFinite(n) || n < 0 || n > 200) continue;
            // Round to 2 dp so integer-shaped fields don't display awkward floats.
            scores[field] = Math.round(n * 100) / 100;
        }
        // Only keep a student who has at least one usable score.
        if (Object.keys(scores).length === 0) continue;

        let conf = Number(item.confidence);
        if (!isFinite(conf) || conf < 0) conf = 0;
        if (conf > 1) conf = 1;

        seen.add(name);
        out.push({ name, scores, confidence: conf });
    }
    return out;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const type = String(body.type || '').toLowerCase();
    const imageBase64 = String(body.imageBase64 || '').trim();
    const mimeType = String(body.mimeType || '').trim().toLowerCase();
    // Parse roster names + their optional parallel ID numbers TOGETHER, so
    // dropping an empty name also drops its ID and the two arrays stay aligned
    // (a name-only filter would shift every ID after the gap onto the wrong
    // student — the ID anchoring then hurts instead of helps).
    const _rawRoster = Array.isArray(body.roster) ? body.roster : [];
    const _rawIds = Array.isArray(body.rosterIds) ? body.rosterIds : [];
    const roster = [];
    const rosterIds = [];
    for (let i = 0; i < _rawRoster.length; i++) {
        const nm = String(_rawRoster[i] || '').trim();
        if (!nm) continue;
        roster.push(nm);
        rosterIds.push(String(_rawIds[i] || '').trim());
    }
    // Optional: target field(s) for record uploads. Accepts either
    // targetFields (array of field keys, e.g. ["module_1","module_2"]) or the
    // legacy single targetField string. When provided, the prompt only reads
    // those specific columns -- far more accurate than auto-detecting headers.
    let targetFields = Array.isArray(body.targetFields)
        ? body.targetFields.map((f) => String(f || '').trim())
        : [];
    const legacyTargetField = String(body.targetField || '').trim();
    if (targetFields.length === 0 && legacyTargetField) targetFields = [legacyTargetField];
    // Keep only valid, de-duplicated field keys, in canonical order.
    const _tfSet = new Set(targetFields.filter((f) => RECORD_FIELD_SET.has(f)));
    targetFields = RECORD_FIELDS.filter((f) => _tfSet.has(f));

    if (type !== 'attendance' && type !== 'record') {
        res.status(400).json({ error: 'type must be "attendance" or "record".' });
        return;
    }
    if (!imageBase64) {
        res.status(400).json({ error: 'Missing imageBase64.' });
        return;
    }
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(mimeType)) {
        res.status(400).json({ error: 'Unsupported image mimeType. Use JPEG, PNG, or WebP.' });
        return;
    }
    if (imageBase64.length > MAX_IMAGE_BYTES * 1.35) {
        res.status(413).json({ error: 'Image too large. Please retake a smaller / clearer photo.' });
        return;
    }
    if (roster.length === 0) {
        res.status(400).json({ error: 'Missing roster.' });
        return;
    }
    if (roster.length > MAX_ROSTER) {
        res.status(400).json({ error: 'Roster too large (max ' + MAX_ROSTER + ').' });
        return;
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!geminiKey && !groqKey) {
        res.status(503).json({
            error: 'AI vision is not configured on Vercel yet. Add GEMINI_API_KEY (or GROQ_API_KEY) in the faci-panel Vercel project environment variables.'
        });
        return;
    }

    // ═══ CHUNK LARGE RECORD ROSTERS ═══
    // A single read of a whole big sheet (e.g. 55 students) gets sloppy toward
    // the BOTTOM — the last rows come back with wrong, swapped, or invented
    // scores while the first/middle rows are fine (the model loses row
    // alignment and its output degrades over a long response). Read the roster
    // in smaller chunks so it only tracks ~20 rows at a time; the ID anchoring
    // keeps each chunk locked to the right rows.
    //
    // Chunks run in PARALLEL, not one-after-another: sequential chunks summed
    // their times and blew past the function timeout (504) on a big class.
    // Parallel makes total time ≈ the slowest single call. Each chunk is read
    // TWICE by two DIFFERENT fast models and reconciled: digits the two models
    // disagree on come back low-confidence and get flagged for double-check in
    // the review UI, which is how the facilitator spots a misread number
    // without hunting the whole sheet. All passes fire at once, so even with
    // two passes per chunk the whole thing finishes in ~one call's time.
    // ID Number → canonical roster name, so a score the model tagged with a
    // wrong name but the RIGHT ID (a row shift) gets reassigned to its true
    // owner. Empty when the roster has no IDs; then we fall back to name/order.
    const idMap = buildIdMap(roster, rosterIds);

    const CHUNK_SIZE = 20;
    if (type === 'record' && roster.length > CHUNK_SIZE) {
        // Two decorrelated model orders — different primaries so they make
        // different mistakes (that difference is exactly what flags an
        // ambiguous digit). Each keeps a fallback so a single 429 doesn't
        // drop the pass entirely.
        const PASS_A_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
        const PASS_B_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];

        const rosterSet = new Set(roster);
        const onePass = async (prompt, models, chunkNames) => {
            let raw;
            if (geminiKey) {
                try {
                    raw = await geminiVision(geminiKey, prompt, imageBase64, mimeType, { models: models });
                } catch (e) {
                    const msg = String((e && (e.raw || e.message)) || e).toLowerCase();
                    const isLimit = (e && e.code === 429) || ['429', 'limit', 'rate', 'quota', 'resource_exhausted'].some((x) => msg.includes(x));
                    if (!(groqKey && isLimit)) throw e; // non-limit, or no Groq → propagate
                }
            }
            if (!raw) raw = await groqVision(groqKey, prompt, imageBase64, mimeType);
            // Reconcile by the ID the model read (fixes row shifts), sanitize
            // against the FULL roster (names are unique), then keep only students
            // THIS chunk asked about so a stray out-of-chunk name can't leak in.
            return sanitizeRecordStudents(parseVisionJSON(raw).students, rosterSet, idMap)
                .filter((s) => chunkNames.has(s.name));
        };

        const chunks = [];
        for (let i = 0; i < roster.length; i += CHUNK_SIZE) {
            chunks.push({ names: roster.slice(i, i + CHUNK_SIZE), ids: rosterIds.slice(i, i + CHUNK_SIZE) });
        }

        // Fire every chunk's two passes at once. Each chunk resolves to its
        // reconciled student list, or an error marker if BOTH passes failed.
        const results = await Promise.all(chunks.map(async (ch) => {
            const prompt = buildRecordPrompt(ch.names, targetFields, ch.ids);
            const chunkNames = new Set(ch.names);
            const [ra, rb] = await Promise.all([
                onePass(prompt, PASS_A_MODELS, chunkNames).catch((e) => ({ __err: (e && (e.raw || e.message)) || String(e) })),
                onePass(prompt, PASS_B_MODELS, chunkNames).catch((e) => ({ __err: (e && (e.raw || e.message)) || String(e) }))
            ]);
            const aOk = Array.isArray(ra), bOk = Array.isArray(rb);
            if (!aOk && !bOk) return { ok: false, err: (ra && ra.__err) || (rb && rb.__err) || 'chunk failed' };
            // Both passes → consensus (agreement raises confidence, disagreement
            // lowers it and flags the cell). One pass → use it as-is.
            const students = (aOk && bOk) ? mergeRecordConsensus(ra, rb, targetFields) : (aOk ? ra : rb);
            return { ok: true, students: students };
        }));

        const merged = [];
        const seenNames = new Set();
        let anySuccess = false;
        let lastErr = null;

        for (const r of results) {
            if (!r.ok) { lastErr = r.err; console.error('Record chunk failed:', lastErr); continue; }
            anySuccess = true;
            for (const s of r.students) {
                if (seenNames.has(s.name)) continue;
                seenNames.add(s.name);
                merged.push(s);
            }
        }

        // Only error out if EVERY chunk failed. A partial result (some chunks
        // succeeded) is still useful — the review UI shows what we got.
        if (!anySuccess) {
            const isLimit = /429|limit|rate|quota|resource_exhausted/i.test(String(lastErr || ''));
            res.status(isLimit ? 429 : 502).json({
                error: isLimit
                    ? 'The AI hit its free-tier rate limit. Please wait a moment and try again.'
                    : 'The AI vision service is having trouble right now. Please try again in a moment.',
                upstream: safeUpstreamMessage(lastErr)
            });
            return;
        }

        res.status(200).json({
            students: merged,
            unmatched: [],
            notes: ''
        });
        return;
    }

    const prompt = type === 'record'
        ? buildRecordPrompt(roster, targetFields, rosterIds)
        : buildAttendancePrompt(roster);

    // Sanitize an upstream error message before sending it back to the client.
    // We include enough detail that a facilitator can screenshot + report it,
    // but strip anything that could look like a key or a full URL.
    function safeUpstreamMessage(raw) {
        let s = String(raw || '').trim();
        if (!s) return '';
        // Redact anything that looks like an API key or query key= value.
        s = s.replace(/(key=)[^&\s"]+/gi, '$1[redacted]');
        s = s.replace(/AIzaSy[a-zA-Z0-9_-]{10,}/g, '[redacted-key]');
        s = s.replace(/gsk_[a-zA-Z0-9_-]{10,}/g, '[redacted-key]');
        // Cap length so we don't dump 10KB HTML.
        if (s.length > 260) s = s.slice(0, 260) + '…';
        return s;
    }

    // Step 1: Gemini (primary)
    let rawReply = null;
    if (geminiKey) {
        try {
            rawReply = await geminiVision(geminiKey, prompt, imageBase64, mimeType, { preferAccurate: type === 'record' });
        } catch (e) {
            const detail = (e && (e.raw || e.message)) || String(e);
            const msg = String(detail || '').toLowerCase();
            const isLimit = e && e.code === 429 || ['429', 'limit', 'rate', 'quota', 'resource_exhausted'].some((x) => msg.includes(x));
            if (!(groqKey && isLimit)) {
                console.error('Gemini vision upstream error:', detail);
                res.status(502).json({
                    error: 'The AI vision service is having trouble right now. Please try again in a moment.',
                    upstream: safeUpstreamMessage(detail)
                });
                return;
            }
            // rate-limited → fall through to Groq
        }
    }

    // Step 2: Groq (fallback — only if configured)
    if (!rawReply) {
        if (!groqKey) {
            res.status(503).json({
                error: 'AI vision is not configured on Vercel yet. Add GEMINI_API_KEY (or GROQ_API_KEY) in the faci-panel Vercel project environment variables.'
            });
            return;
        }
        try {
            rawReply = await groqVision(groqKey, prompt, imageBase64, mimeType);
        } catch (e) {
            if (e && e.code === 429) {
                res.status(429).json({ error: 'The AI hit its free-tier rate limit. Please wait a moment and try again.' });
                return;
            }
            const detail = (e && (e.raw || e.message)) || String(e);
            console.error('Groq vision upstream error:', detail);
            res.status(502).json({
                error: 'The AI vision service is having trouble right now. Please try again in a moment.',
                upstream: safeUpstreamMessage(detail)
            });
            return;
        }
    }

    let parsed;
    try {
        parsed = parseVisionJSON(rawReply);
    } catch (e) {
        console.error('Vision parse error:', e && e.message, '| raw:', String(rawReply || '').slice(0, 400));
        // Surface a preview of what the AI actually said so we can see if it
        // refused ("I'm not able to analyze this…"), replied with prose, or
        // returned near-JSON we can't quite parse. Sanitized to protect keys.
        res.status(502).json({
            error: 'The AI reply was not valid JSON. Please try another photo.',
            upstream: safeUpstreamMessage('parse:' + (e && e.message ? e.message + ' | ' : '') + 'raw:' + String(rawReply || '').slice(0, 220))
        });
        return;
    }

    const rosterSet = new Set(roster);
    let students = type === 'record'
        ? sanitizeRecordStudents(parsed && parsed.students, rosterSet, idMap)
        : sanitizeStudents(parsed && parsed.students, rosterSet);
    let unmatched = Array.isArray(parsed && parsed.unmatched)
        ? parsed.unmatched.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 30)
        : [];
    let notes = String((parsed && parsed.notes) || '').trim().slice(0, 240);

    // ═══ TWO-PASS CONSENSUS ═══
    // For explicit-field record extraction (one OR several chosen columns),
    // run the model a SECOND time and compare per-student per-field. Only
    // high-confidence when both passes agree (that's the meaningful accuracy
    // signal for handwritten OCR). Disagreements are surfaced as low
    // confidence so the review UI's "double-check" flag corresponds to real
    // uncertainty. We skip the second pass on attendance (P/A/L is trivial)
    // and on auto-detect record mode (too many free-form fields to align).
    const doConsensus = type === 'record' && targetFields.length >= 1
        && geminiKey && students.length > 0;
    if (doConsensus) {
        try {
            const rawReply2 = await geminiVision(geminiKey, prompt, imageBase64, mimeType, { preferAccurate: true });
            const parsed2 = parseVisionJSON(rawReply2);
            const students2 = sanitizeRecordStudents(parsed2 && parsed2.students, rosterSet, idMap);
            students = mergeRecordConsensus(students, students2, targetFields);
            const notes2 = String((parsed2 && parsed2.notes) || '').trim();
            if (notes2 && notes.indexOf(notes2) === -1) {
                notes = (notes ? notes + ' | ' : '') + notes2;
                if (notes.length > 240) notes = notes.slice(0, 240);
            }
        } catch (e) {
            // Consensus is best-effort. If the second pass fails (rate limit,
            // network, parse error), fall back to the first pass silently -
            // the review UI still shows the first pass's confidences.
            console.error('Consensus second-pass error (falling back to single pass):', (e && e.message) || e);
        }
    }

    res.status(200).json({ students, unmatched, notes });
};

/**
 * Merge two independent extractions of the same record photo across one OR
 * more chosen fields. Per student, per field:
 *   - both passes present + equal   → keep the value.
 *   - both present but different     → keep pass-1's value, mark field as
 *                                      "disagreed".
 *   - only one pass has the value    → keep it.
 * Per-student confidence (the review UI flags on this):
 *   - any field disagreed            → 0.35 (needs check).
 *   - every shared field agreed      → 0.95 (strong).
 *   - otherwise (single-witness)     → floor 0.55 (moderate).
 * targetFields may be an array (multi) or a single string (back-compat).
 */
function mergeRecordConsensus(a, b, targetFields) {
    const fields = (Array.isArray(targetFields) ? targetFields : [targetFields])
        .filter(f => RECORD_FIELD_SET.has(f));
    const byName = new Map();
    a.forEach(s => byName.set(s.name, { a: s, b: null }));
    b.forEach(s => {
        if (byName.has(s.name)) byName.get(s.name).b = s;
        else byName.set(s.name, { a: null, b: s });
    });
    const out = [];
    for (const [name, pair] of byName) {
        const sa = pair.a;
        const sb = pair.b;
        if (!sa && !sb) continue;
        if (sa && !sb) { out.push(sa); continue; }
        if (!sa && sb) { out.push(sb); continue; }

        // Both passes saw this student — reconcile each field.
        const scoresA = (sa.scores && typeof sa.scores === 'object') ? sa.scores : {};
        const scoresB = (sb.scores && typeof sb.scores === 'object') ? sb.scores : {};
        const mergedScores = {};
        let anyDisagree = false;
        let anyShared = false;
        let anySingle = false;
        // Consider every field the caller cares about, plus any the model
        // returned (defensive) — but only keep known fields.
        const allFields = fields.length ? fields
            : Array.from(new Set([...Object.keys(scoresA), ...Object.keys(scoresB)])).filter(f => RECORD_FIELD_SET.has(f));
        for (const f of allFields) {
            const va = scoresA[f], vb = scoresB[f];
            const av = (va !== undefined && va !== null);
            const bv = (vb !== undefined && vb !== null);
            if (av && bv) {
                anyShared = true;
                mergedScores[f] = Number(va);
                if (Number(va) !== Number(vb)) anyDisagree = true;
            } else if (av) {
                mergedScores[f] = Number(va); anySingle = true;
            } else if (bv) {
                mergedScores[f] = Number(vb); anySingle = true;
            }
        }
        if (Object.keys(mergedScores).length === 0) continue;
        let confidence;
        if (anyDisagree) confidence = 0.35;
        else if (anyShared) confidence = 0.95;
        else confidence = Math.max(0.55, Number(sa.confidence) || 0.55);   // single-witness only
        out.push({ name, scores: mergedScores, confidence });
    }
    return out;
}
