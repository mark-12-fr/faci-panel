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
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
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
        "Return the attendance status for EVERY student on the ROSTER below.\n\n" +
        "SIMPLE BINARY RULE (this is the whole task — don't overthink it):\n" +
        "  • Cell has ANY mark inside it (a slash '/', a check '✓', an 'x'/'X', a dot, the letter 'P', " +
        "any pen stroke, any tick, any scribble — anything at all that is NOT completely blank) " +
        "→ status = \"Present\".\n" +
        "  • Cell is COMPLETELY BLANK / EMPTY / just the empty box → status = \"Absent\".\n\n" +
        "EXCEPTIONS (only when clearly labeled with a specific letter):\n" +
        "  • Cell explicitly contains the letter 'L' or the word 'Late' → status = \"Late\".\n" +
        "  • Cell explicitly contains 'E', 'Ex', or 'Excused' → status = \"Excused\".\n" +
        "Everything else that is NOT blank counts as Present (even if the mark is faint, tiny, " +
        "smudged, or you're unsure what it is — a mark is a mark).\n\n" +
        "CRITICAL — RETURN EVERY ROSTER STUDENT (all " + roster.length + " of them):\n" +
        "  • students[] MUST have exactly " + roster.length + " entries, in the same order as the " +
        "ROSTER below. No duplicates, no omissions.\n" +
        "  • Read each row LEFT-TO-RIGHT and match it to the corresponding roster name. Then " +
        "inspect the attendance cell to the right of the name for that day/column.\n" +
        "  • If you cannot find a student's row at all in the photo, still include them as Absent " +
        "with confidence 0.2 so the facilitator sees them.\n\n" +
        "MATCHING RULES:\n" +
        "  • The ROSTER below is the ground truth. Match each row in the photo to the CLOSEST " +
        "roster name (tolerate OCR errors: missing accents, wrong middle initial, transposed letters).\n" +
        "  • Never invent students not on the roster. Names must match the roster string EXACTLY.\n\n" +
        "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose, no markdown fences, no code blocks. " +
        "Exactly this shape:\n" +
        "{\n" +
        '  "students": [ { "name": "<exact roster name>", "status": "Present"|"Absent"|"Late"|"Excused", "confidence": <0..1> } ],\n' +
        '  "unmatched": [ "<any name text seen in the photo that does NOT match a roster name>" ],\n' +
        '  "notes": "<optional one-line observation, e.g. photo blur>"\n' +
        "}\n\n" +
        "ROSTER (" + roster.length + " names — return exactly this many entries):\n" +
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

function buildRecordPrompt(roster) {
    return (
        "You are analyzing a photo of a classroom RECORD / GRADE BOOK page from a school in the " +
        "Philippines. Rows are students, columns are score-holding fields. Read the header row to " +
        "identify each column, then read the score cell for each student × column pair, and match " +
        "each recognized student to the ROSTER below.\n\n" +
        "COLUMN → FIELD MAPPING (map the header text you see to the exact field key below):\n" +
        "- 'MODULE 1' / 'M1' / 'Mod 1' → module_1  (same pattern up to module_25)\n" +
        "- 'ACTIVITY 1' / 'A1' / 'Act 1' → activity_1  (same pattern up to activity_10)\n" +
        "- 'AT' / 'Attendance' → at\n" +
        "- 'PT 1' / 'PT1' / 'Performance Task 1' → pt_1\n" +
        "- 'PT 2' / 'PT2' / 'Performance Task 2' → pt_2\n" +
        "- 'QE' / 'Q.E.' / 'Quarterly Exam' / 'Exam' → qe\n" +
        "- If a header does not clearly map to one of the above field keys, IGNORE that entire column.\n\n" +
        "SCORE READING RULES:\n" +
        "- Only include a numeric value if you can read the cell clearly. Empty/blank cells, dashes, " +
        "'-', or clearly-unreadable cells are OMITTED (do not include the field at all for that student).\n" +
        "- Numbers must be non-negative and at most 200. Decimals are allowed but rare; prefer integers.\n" +
        "- If you're not confident about a value, still return your best guess and lower the confidence.\n\n" +
        "MATCHING RULES:\n" +
        "- The ROSTER below is the ground truth. Match each detected student's name to the CLOSEST " +
        "roster entry, tolerating small OCR mistakes.\n" +
        "- Only include a student in the `students` array if you can confidently match them to a " +
        "roster name. Any name you see but can't match goes into `unmatched` verbatim.\n" +
        "- Never invent students not seen in the photo. Never include duplicates.\n\n" +
        "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose, no markdown fences. Exactly this shape:\n" +
        "{\n" +
        '  "students": [ { "name": "<exact roster name>", "scores": { "<field_key>": <number>, ... }, "confidence": <0..1> } ],\n' +
        '  "unmatched": [ "<name text seen in photo>" ],\n' +
        '  "notes": "<optional one-line observation>"\n' +
        "}\n\n" +
        "ROSTER (match names to these exact strings):\n" +
        roster.map((n, i) => (i + 1) + '. ' + n).join('\n')
    );
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
async function geminiVision(apiKey, prompt, imageBase64, mimeType) {
    const pinned = process.env.GEMINI_VISION_MODEL;
    const models = pinned ? [pinned] : GEMINI_MODELS;
    let lastErr = null;
    // Try each model up to twice: once WITH responseMimeType=application/json,
    // then WITHOUT it if the model rejects the field (Gemini sometimes returns
    // 400 INVALID_ARGUMENT on that param for older/preview models).
    for (const m of models) {
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
                    const e = new Error('rate limit');
                    e.code = 429;
                    throw e;
                }
                // If the model rejected responseMimeType, retry without it. Any
                // other 400 → next model. 404/403 → next model.
                if (useJsonMime && r.status === 400 && /responseMimeType|response_mime_type/i.test(lastErr)) {
                    continue;
                }
                break; // give up on this model, try the next
            } catch (e) {
                if (e && e.code === 429) throw e;
                lastErr = '[' + m + '] ' + String((e && e.message) || e);
                break;
            }
        }
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
function sanitizeRecordStudents(list, rosterSet) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
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
    const roster = Array.isArray(body.roster) ? body.roster.map((n) => String(n || '').trim()).filter(Boolean) : [];

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

    const prompt = type === 'record' ? buildRecordPrompt(roster) : buildAttendancePrompt(roster);

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
            rawReply = await geminiVision(geminiKey, prompt, imageBase64, mimeType);
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
    const students = type === 'record'
        ? sanitizeRecordStudents(parsed && parsed.students, rosterSet)
        : sanitizeStudents(parsed && parsed.students, rosterSet);
    const unmatched = Array.isArray(parsed && parsed.unmatched)
        ? parsed.unmatched.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 30)
        : [];
    const notes = String((parsed && parsed.notes) || '').trim().slice(0, 240);

    res.status(200).json({ students, unmatched, notes });
};
