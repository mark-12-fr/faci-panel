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
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB after base64 decode — Vercel body limit is 4.5MB raw
const MAX_ROSTER = 200;

function buildAttendancePrompt(roster) {
    return (
        "You are analyzing a photo of a classroom attendance sheet from a school in the Philippines. " +
        "Your job is to detect which students are Present, Absent, Late, or Excused, then match each " +
        "recognized student to the ROSTER below.\n\n" +
        "ATTENDANCE MARK CONVENTIONS to recognize (all common in Philippine school attendance sheets):\n" +
        "- A slash '/', check mark '✓', 'P', or the box being ticked → PRESENT.\n" +
        "- A dot '•', an 'X', an 'A', a blank left intentionally, or an obviously empty box → ABSENT.\n" +
        "- 'L' or 'Late' written in the box → LATE.\n" +
        "- 'E', 'Ex', or 'Excused' → EXCUSED.\n" +
        "- If the mark is unreadable or unclear, still return your best guess but lower the confidence.\n\n" +
        "MATCHING RULES:\n" +
        "- The photo may have handwriting; the ROSTER below is the ground truth. Match each detected " +
        "student to the CLOSEST roster name, tolerating small OCR mistakes (missing accents, wrong " +
        "middle initial, transposed letters).\n" +
        "- Only include a student in the `students` array if you can confidently match them to a " +
        "roster name. Any name you see but can't match goes into `unmatched` verbatim.\n" +
        "- Never invent students not seen in the photo. Never include duplicates.\n\n" +
        "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose, no markdown fences, no code block. " +
        "Exactly this shape:\n" +
        "{\n" +
        '  "students": [ { "name": "<exact roster name>", "status": "Present"|"Absent"|"Late"|"Excused", "confidence": <0..1> } ],\n' +
        '  "unmatched": [ "<name text seen in photo>" ],\n' +
        '  "notes": "<optional one-line observation, e.g. photo blur or missing students>"\n' +
        "}\n\n" +
        "ROSTER (match names to these exact strings):\n" +
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
                    max_tokens: 4096,
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
    for (const m of models) {
        try {
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
                        generationConfig: {
                            temperature: 0.1,
                            responseMimeType: 'application/json',
                            maxOutputTokens: 4096
                        }
                    })
                }
            );
            const data = await r.json().catch(() => ({}));
            if (r.status === 200) {
                const parts = (((data.candidates || [{}])[0] || {}).content || {}).parts || [];
                const text = parts.map((p) => (p && p.text) || '').join('').trim();
                if (text) return text;
                lastErr = 'empty reply';
            } else {
                lastErr = r.status + ' ' + JSON.stringify(data).slice(0, 300);
                if (r.status === 429 || /RESOURCE_EXHAUSTED/i.test(lastErr)) {
                    const e = new Error('rate limit');
                    e.code = 429;
                    throw e;
                }
            }
        } catch (e) {
            if (e && e.code === 429) throw e;
            lastErr = String((e && e.message) || e);
        }
    }
    throw new Error(lastErr || 'No usable Gemini model.');
}

function parseVisionJSON(raw) {
    // The model was asked for strict JSON, but be defensive: strip code fences
    // if any, then parse the first {...} block we find.
    let s = String(raw || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
    return JSON.parse(s);
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

    // Step 1: Gemini (primary)
    let rawReply = null;
    if (geminiKey) {
        try {
            rawReply = await geminiVision(geminiKey, prompt, imageBase64, mimeType);
        } catch (e) {
            const msg = String((e && e.message) || '').toLowerCase();
            const isLimit = e && e.code === 429 || ['429', 'limit', 'rate', 'quota', 'resource_exhausted'].some((x) => msg.includes(x));
            if (!(groqKey && isLimit)) {
                console.error('Gemini vision upstream error:', (e && e.message) || e);
                res.status(502).json({ error: 'The AI vision service is having trouble right now. Please try again in a moment.' });
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
            console.error('Groq vision upstream error:', (e && (e.raw || e.message)) || e);
            res.status(502).json({ error: 'The AI vision service is having trouble right now. Please try again in a moment.' });
            return;
        }
    }

    let parsed;
    try {
        parsed = parseVisionJSON(rawReply);
    } catch (e) {
        console.error('Vision parse error:', e && e.message, '| raw:', String(rawReply || '').slice(0, 400));
        res.status(502).json({ error: 'The AI reply was not valid JSON. Please try another photo.' });
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
