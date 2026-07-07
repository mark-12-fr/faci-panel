/**
 * api/vision-analyze.js — Vercel Serverless Function: photo → structured data.
 * =====================================================================
 * Takes a photo of an attendance sheet, sends it to Gemini Vision, and returns
 * each recognized student's attendance status (Present / Absent / Late /
 * Excused) matched against the roster the caller passed in. The client shows a
 * preview + review UI so a facilitator can correct any AI mistake before
 * applying to the actual attendance form.
 *
 * Required Vercel env var:
 *   GEMINI_API_KEY   — Google AI Studio key with Gemini access.
 * Optional:
 *   GEMINI_VISION_MODEL — pin a specific model (default: gemini-2.0-flash).
 *
 * Request (POST JSON):
 *   {
 *     type: "attendance",
 *     imageBase64: "...",         // no "data:image/...;base64," prefix
 *     mimeType: "image/jpeg",     // MUST be provided; jpeg/png/webp
 *     roster: ["ALISEN, JOHN REN ALAGOS", ...]  // canonical names to match
 *   }
 *
 * Response (200):
 *   {
 *     students: [
 *       { name: "ALISEN, JOHN REN ALAGOS", status: "Present", confidence: 0.95 },
 *       ...
 *     ],
 *     unmatched: ["... any names the AI saw but couldn't match to the roster"],
 *     notes: "one-line AI observation (optional)"
 *   }
 */

const DEFAULT_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
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

async function geminiVision(apiKey, prompt, imageBase64, mimeType) {
    const pinned = process.env.GEMINI_VISION_MODEL;
    const models = pinned ? [pinned] : DEFAULT_MODELS;
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

    if (type !== 'attendance') {
        res.status(400).json({ error: 'Only type="attendance" is supported right now.' });
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        res.status(503).json({
            error: 'Gemini vision is not configured on Vercel yet. Add GEMINI_API_KEY in the faci-panel Vercel project environment variables.'
        });
        return;
    }

    const prompt = buildAttendancePrompt(roster);

    let rawReply;
    try {
        rawReply = await geminiVision(apiKey, prompt, imageBase64, mimeType);
    } catch (e) {
        if (e && e.code === 429) {
            res.status(429).json({ error: 'The AI hit its free-tier rate limit. Please wait a moment and try again.' });
            return;
        }
        console.error('Gemini vision upstream error:', (e && e.message) || e);
        res.status(502).json({ error: 'The AI vision service is having trouble right now. Please try again in a moment.' });
        return;
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
    const students = sanitizeStudents(parsed && parsed.students, rosterSet);
    const unmatched = Array.isArray(parsed && parsed.unmatched)
        ? parsed.unmatched.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 30)
        : [];
    const notes = String((parsed && parsed.notes) || '').trim().slice(0, 240);

    res.status(200).json({ students, unmatched, notes });
};
