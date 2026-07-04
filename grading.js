/**
 * grading.js — AcadTrack single source of truth for grade weights.
 * ================================================================
 * Grades are NO LONGER hardcoded. Each subject's weights (Written Work,
 * Performance Tasks, Exam, Attendance) and passing grade are set by the
 * teacher in the Grading System page and stored in the `subjects` table.
 * This module loads those per-subject configs and computes grades from
 * them, so the teacher panel and the facilitator panel stay in sync.
 *
 * If a subject has no custom config, it falls back to the classic DepEd
 * default (WW 30 / PT 50 / Exam 20 / Attendance 0, passing 75), so any
 * existing data keeps the exact same grade until the teacher customizes.
 *
 * Exposes (on window):
 *   MJR_GRADE_DEFAULT          — the fallback weights object
 *   MJR_loadSubjectConfigs()   — fetch + cache all of a teacher's subject configs
 *   MJR_weightsFor(name)       — weights for a subject name (or default)
 *   MJR_componentScores(rec)   — {ww,pt,qe} component scores (0–100) from a record
 *   MJR_attScore(att)          — attendance score (0–100) from {present,late,total}
 *   MJR_finalGrade(rec,name,attScore) — final grade 0–100 using that subject's weights
 */
(function () {
    var DEFAULT = { ww: 30, pt: 50, exam: 20, att: 0, passing: 75 };
    window.MJR_GRADE_DEFAULT = DEFAULT;
    window.MJR_SUBJECT_CFG = window.MJR_SUBJECT_CFG || {};

    function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
    function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

    /**
     * Load every subject config for a teacher into the in-memory map.
     * Pass teacherId on the teacher panel; omit it on the faci panel
     * (RLS + the subject name still scope it correctly).
     */
    window.MJR_loadSubjectConfigs = async function (sb, teacherId) {
        try {
            var q = sb.from('subjects').select('name, ww_percent, pt_percent, exam_percent, attendance_percent, passing_grade');
            if (teacherId) q = q.eq('teacher_id', teacherId);
            var res = await q;
            if (res.error || !res.data) return window.MJR_SUBJECT_CFG;
            var map = {};
            res.data.forEach(function (r) {
                map[norm(r.name)] = {
                    ww: num(r.ww_percent, DEFAULT.ww),
                    pt: num(r.pt_percent, DEFAULT.pt),
                    exam: num(r.exam_percent, DEFAULT.exam),
                    att: num(r.attendance_percent, DEFAULT.att),
                    passing: num(r.passing_grade, DEFAULT.passing)
                };
            });
            window.MJR_SUBJECT_CFG = map;
        } catch (e) { /* keep whatever we had; default still applies */ }
        return window.MJR_SUBJECT_CFG;
    };

    /**
     * Fetch ALL rows for a query, paginating past Supabase's default 1000-row
     * API cap. Without this, a teacher with many students silently loses their
     * most-recently-entered rows (e.g. Q4 class_records) once the total passes
     * 1000, so a whole quarter can vanish from the dashboard.
     *
     * builderFn receives a fresh `sb.from(table)` and must return it with
     * .select()/filters applied (NOT .range()); include a stable .order() so
     * pages don't overlap. Returns the complete array (throws on error).
     */
    window.MJR_fetchAll = async function (sb, table, builderFn, pageSize) {
        var size = pageSize || 1000;
        var from = 0, all = [], done = false;
        while (!done) {
            var res = await builderFn(sb.from(table)).range(from, from + size - 1);
            if (res.error) throw res.error;
            var rows = res.data || [];
            all = all.concat(rows);
            if (rows.length < size) done = true; else from += size;
        }
        return all;
    };

    /** Weights for a subject name; falls back to the classic default. */
    window.MJR_weightsFor = function (subjectName) {
        var c = window.MJR_SUBJECT_CFG[norm(subjectName)];
        return c ? {
            ww: num(c.ww, DEFAULT.ww), pt: num(c.pt, DEFAULT.pt),
            exam: num(c.exam, DEFAULT.exam), att: num(c.att, DEFAULT.att),
            passing: num(c.passing, DEFAULT.passing)
        } : { ww: DEFAULT.ww, pt: DEFAULT.pt, exam: DEFAULT.exam, att: DEFAULT.att, passing: DEFAULT.passing };
    };

    /** Passing threshold for a subject (default 75). */
    window.MJR_passingFor = function (subjectName) { return window.MJR_weightsFor(subjectName).passing; };

    /** Component scores (each capped at 100) from a merged record. */
    window.MJR_componentScores = function (record) {
        var totalWW = 0, totalPT = 0, totalQE = num(record && record.qe, 0);
        for (var k in (record || {})) {
            var v = record[k];
            if (v === null || v === undefined || v === '') continue;
            if (k.indexOf('module_') === 0 || k.indexOf('activity_') === 0 || k === 'at') totalWW += num(v, 0);
            else if (k.indexOf('pt_') === 0) totalPT += num(v, 0);
        }
        return {
            ww: Math.min(totalWW, 100),
            pt: Math.min(totalPT, 100),
            qe: Math.min((totalQE / 50) * 100, 100),
            rawWW: totalWW, rawPT: totalPT, rawQE: totalQE
        };
    };

    /**
     * Attendance score 0–100 from {present, late, total}. Present = full,
     * Late = half credit, Absent = none. No records → 100 (no penalty), so
     * a class that hasn't taken attendance isn't punished.
     */
    window.MJR_attScore = function (att) {
        if (!att || !att.total) return 100;
        var present = num(att.present, 0), late = num(att.late, 0);
        return Math.min((present + 0.5 * late) / att.total * 100, 100);
    };

    /**
     * Final grade 0–100 for a merged record under a subject's weights.
     * attScore is the 0–100 attendance score; pass null/undefined when a
     * page hasn't loaded attendance (treated as 100 = no penalty). When the
     * Attendance weight is 0 (the default) attScore is irrelevant anyway.
     */
    window.MJR_finalGrade = function (record, subjectName, attScore) {
        var w = window.MJR_weightsFor(subjectName);
        var s = window.MJR_componentScores(record);
        var att = (attScore === null || attScore === undefined) ? 100 : attScore;
        return Math.round(
            s.ww * (w.ww / 100) +
            s.pt * (w.pt / 100) +
            s.qe * (w.exam / 100) +
            att * (w.att / 100)
        );
    };

    // Auto-load this teacher's subject configs once the page's Supabase client
    // and identity are available, so every page's grades/AI become dynamic
    // without per-page wiring. Teacher panel keys on user_id; faci on
    // faci_teacher_id (the anon read policy allows it). Pages that need configs
    // earlier (dashboard, performance, faci load) also load them explicitly.
    function autoLoad() {
        try {
            var sb = window.supabaseClient;
            var uid = (window.localStorage &&
                (localStorage.getItem('user_id') || localStorage.getItem('faci_teacher_id'))) || null;
            if (sb && window.MJR_loadSubjectConfigs) window.MJR_loadSubjectConfigs(sb, uid || undefined);
        } catch (e) { /* default weights still apply */ }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoLoad);
    else autoLoad();
})();
