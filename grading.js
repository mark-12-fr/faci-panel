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
    // How many Module columns the panels show. The database still has
    // module_1..25, so raising this only re-exposes columns that were never
    // dropped; grades only ever count the module_* values a record actually has.
    // Keep in sync with MODULE_COUNT in the teacher panel's class-record page.
    window.MJR_MODULE_COUNT = 15;
    window.MJR_SUBJECT_CFG = window.MJR_SUBJECT_CFG || {};

    function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
    function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

    /**
     * Load a SINGLE teacher's subject configs into the in-memory map.
     * teacherId is REQUIRED: the teacher panel passes the logged-in user_id,
     * the faci panel passes its section's teacher_id. Without it we refuse to
     * load, because the anon read policy would otherwise return EVERY teacher's
     * subjects — and since the map is keyed by subject name, one teacher's
     * weights/passing could then be applied to another teacher's data. No id →
     * keep the safe defaults (30/50/20/0/75) instead of mixing teachers.
     */
    window.MJR_loadSubjectConfigs = async function (sb, teacherId) {
        if (!teacherId) return window.MJR_SUBJECT_CFG;
        try {
            var q = sb.from('subjects').select('name, ww_percent, pt_percent, exam_percent, attendance_percent, passing_grade, ww_total, pt_total, exam_total')
                .eq('teacher_id', teacherId);
            var res = await q;
            if (res.error || !res.data) return window.MJR_SUBJECT_CFG;
            var map = {};
            res.data.forEach(function (r) {
                map[norm(r.name)] = {
                    ww: num(r.ww_percent, DEFAULT.ww),
                    pt: num(r.pt_percent, DEFAULT.pt),
                    exam: num(r.exam_percent, DEFAULT.exam),
                    att: num(r.attendance_percent, DEFAULT.att),
                    passing: num(r.passing_grade, DEFAULT.passing),
                    wwTotal: num(r.ww_total, 0),
                    ptTotal: num(r.pt_total, 0),
                    examTotal: num(r.exam_total, 0)
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
            passing: num(c.passing, DEFAULT.passing),
            wwTotal: num(c.wwTotal, 0), ptTotal: num(c.ptTotal, 0), examTotal: num(c.examTotal, 0)
        } : { ww: DEFAULT.ww, pt: DEFAULT.pt, exam: DEFAULT.exam, att: DEFAULT.att, passing: DEFAULT.passing, wwTotal: 0, ptTotal: 0, examTotal: 0 };
    };

    /** Passing threshold for a subject (default 75). */
    window.MJR_passingFor = function (subjectName) { return window.MJR_weightsFor(subjectName).passing; };

    /** Component scores (each capped at 100) from a merged record.
     *  Written Works = Modules + Activities. The Achievement Test (AT) belongs to
     *  the EXAM with the Quarterly Exam (each out of 50 → combined out of 100),
     *  NOT Written Works — so the exam component is (AT + QE) as a % of 100. */
    window.MJR_componentScores = function (record, subjectName) {
        var totalWW = 0, totalPT = 0, atTotal = 0, totalQE = num(record && record.qe, 0);
        for (var k in (record || {})) {
            var v = record[k];
            if (v === null || v === undefined || v === '') continue;
            if (k.indexOf('module_') === 0 || k.indexOf('activity_') === 0) totalWW += num(v, 0);
            else if (k === 'at') atTotal += num(v, 0);
            else if (k.indexOf('pt_') === 0) totalPT += num(v, 0);
        }
        var examRaw = atTotal + totalQE; // AT (/50) + QE (/50) → out of 100
        // When a subject sets a per-component "perfect score" (total possible),
        // that component's % is (raw / total) * 100; else raw capped at 100.
        var w = (subjectName !== undefined && subjectName !== null) ? window.MJR_weightsFor(subjectName) : null;
        var pct = function (raw, total) { return total > 0 ? Math.min((raw / total) * 100, 100) : Math.min(raw, 100); };
        return {
            ww: pct(totalWW, w ? w.wwTotal : 0),
            pt: pct(totalPT, w ? w.ptTotal : 0),
            qe: Math.min((totalQE / 50) * 100, 100),
            exam: pct(examRaw, w ? w.examTotal : 0),
            rawWW: totalWW, rawPT: totalPT, rawQE: totalQE, rawAT: atTotal, rawExam: examRaw
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
        var s = window.MJR_componentScores(record, subjectName);
        var att = (attScore === null || attScore === undefined) ? 100 : attScore;

        // IN-PROGRESS grading: only components that have actually been GIVEN count.
        // A component whose columns are all blank is "not handed out yet" — it is
        // excluded and its weight is redistributed across the given components, so
        // an empty PT/QE won't drag the grade down before it's administered. A
        // blank is grace; enter a 0 for a real zero. When every component is
        // filled the active weights sum to 100 → identical to the plain grade.
        var has = function (pred) {
            for (var k in (record || {})) {
                if (pred(k)) { var v = record[k]; if (v !== null && v !== undefined && v !== '') return true; }
            }
            return false;
        };
        var wwG = has(function (k) { return k.indexOf('module_') === 0 || k.indexOf('activity_') === 0; });
        var ptG = has(function (k) { return k.indexOf('pt_') === 0; });
        var atG = has(function (k) { return k === 'at'; });
        var qeG = has(function (k) { return k === 'qe'; });
        var exG = atG || qeG;

        // Exam % from the parts actually given (AT and QE are each half of
        // examTotal — default 50 each), so an unentered QE doesn't halve the exam.
        var examPct = s.exam;
        if (exG) {
            var partMax = w.examTotal > 0 ? w.examTotal / 2 : 50;
            var denom = partMax * ((atG ? 1 : 0) + (qeG ? 1 : 0));
            examPct = denom > 0 ? Math.min(((s.rawAT + s.rawQE) / denom) * 100, 100) : 0;
        }

        var score = 0, activeW = 0;
        if (wwG) { score += s.ww * w.ww; activeW += w.ww; }
        if (ptG) { score += s.pt * w.pt; activeW += w.pt; }
        if (exG) { score += examPct * w.exam; activeW += w.exam; }
        if (w.att > 0) { score += att * w.att; activeW += w.att; }

        if (activeW <= 0) return 0; // nothing entered yet
        return Math.round(score / activeW);
    };

    /** True when every weighted component has been given (Exam needs BOTH AT and
     *  QE), so MJR_finalGrade is the FINAL grade — used to show an in-progress tag. */
    window.MJR_isGradeComplete = function (record, subjectName) {
        var w = window.MJR_weightsFor(subjectName);
        var has = function (pred) {
            for (var k in (record || {})) {
                if (pred(k)) { var v = record[k]; if (v !== null && v !== undefined && v !== '') return true; }
            }
            return false;
        };
        if (w.ww > 0 && !has(function (k) { return k.indexOf('module_') === 0 || k.indexOf('activity_') === 0; })) return false;
        if (w.pt > 0 && !has(function (k) { return k.indexOf('pt_') === 0; })) return false;
        if (w.exam > 0 && !(has(function (k) { return k === 'at'; }) && has(function (k) { return k === 'qe'; }))) return false;
        return true;
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
