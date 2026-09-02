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

    // Round to 2 decimals the way a spreadsheet's ROUND(x, 2) does. The +1e-9
    // nudge absorbs binary float error so 11.185 rounds to 11.19 like the Excel.
    function round2(n) { return Math.round((n + 1e-9) * 100) / 100; }

    // Percentage Score for a component (raw / perfect × 100, capped 100, 2 dp).
    function componentPct(raw, perfect) {
        return perfect > 0 ? round2(Math.min((raw / perfect) * 100, 100)) : round2(Math.min(raw, 100));
    }

    // The school's transmutation table (Initial Grade → Final/Quarterly Grade),
    // [lower, upper, grade], high→low. MUST stay identical to the teacher panel's
    // TRANSMUTATION in lib/grading.ts (transcribed from the teacher's Excel).
    var MJR_TRANSMUTATION = [
        [99.5,100,100],[98.32,99.49,99],[97.14,98.31,98],[95.96,97.13,97],[94.78,95.95,96],
        [93.6,94.77,95],[92.42,93.59,94],[91.24,92.41,93],[90.06,91.23,92],[88.88,90.05,91],
        [87.7,88.87,90],[86.52,87.69,89],[85.34,86.51,88],[84.16,85.33,87],[82.98,84.15,86],
        [81.8,82.97,85],[80.62,81.79,84],[79.44,80.61,83],[78.26,79.43,82],[77.08,78.25,81],
        [75.9,77.07,80],[74.72,75.89,79],[73.54,74.71,78],[72.36,73.53,77],[71.18,72.35,76],
        [70,71.17,75],[65.34,69.99,74],[60.67,65.33,73],[56.01,60.66,72],[51.34,56,71],
        [46.67,51.33,70],[42.01,46.66,69],[37.34,42,68],[32.68,37.33,67],[28.01,32.67,66],
        [23.35,28,65],[18.68,23.34,64],[14.01,18.67,63],[9.35,14,62],[4.68,9.34,61],[0,4.67,60]
    ];

    /** Convert an Initial Grade to the Final/Quarterly Grade via the school's
     *  transmutation table. Always transmute the Initial Grade — never derive the
     *  Final Grade straight from raw scores. */
    window.MJR_transmute = function (initial) {
        if (initial >= 100) return 100;
        for (var i = 0; i < MJR_TRANSMUTATION.length; i++) if (initial >= MJR_TRANSMUTATION[i][0]) return MJR_TRANSMUTATION[i][2];
        return 60;
    };

    /** Full breakdown: each component's PS and WS, the Initial Grade (sum of WS,
     *  2 dp) and the transmuted Final Grade. Raw → % → weighted → initial →
     *  transmute → final; nothing is derived from a flat total. Blank components
     *  score 0 (the transmutation lifts a low Initial back up). */
    window.MJR_gradeBreakdown = function (record, subjectName, attScore) {
        var w = window.MJR_weightsFor(subjectName);
        var s = window.MJR_componentScores(record, subjectName);
        var att = (attScore === null || attScore === undefined) ? 100 : round2(Math.min(Math.max(attScore, 0), 100));
        var wwPS = componentPct(s.rawWW, w.wwTotal);
        var ptPS = componentPct(s.rawPT, w.ptTotal);
        var examPS = componentPct(s.rawExam, w.examTotal);
        var wwWS = round2(wwPS * (w.ww / 100));
        var ptWS = round2(ptPS * (w.pt / 100));
        var examWS = round2(examPS * (w.exam / 100));
        var attWS = round2(att * (w.att / 100));
        var initial = round2(wwWS + ptWS + examWS + attWS);
        return { wwPS: wwPS, wwWS: wwWS, ptPS: ptPS, ptWS: ptWS, examPS: examPS, examWS: examWS,
                 attPS: att, attWS: attWS, initial: initial, final: window.MJR_transmute(initial) };
    };

    /** Initial Grade (weighted sum, 2 decimals, before transmutation). */
    window.MJR_initialGrade = function (record, subjectName, attScore) {
        return window.MJR_gradeBreakdown(record, subjectName, attScore).initial;
    };

    /**
     * Final / Quarterly Grade (whole number): the Initial Grade transmuted via
     * the school's table — the SAME grade the teacher panel shows. attScore is
     * the 0–100 attendance score; pass null/undefined when a page hasn't loaded
     * attendance (treated as 100). Attendance is irrelevant when its weight is 0.
     */
    window.MJR_finalGrade = function (record, subjectName, attScore) {
        return window.MJR_gradeBreakdown(record, subjectName, attScore).final;
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
