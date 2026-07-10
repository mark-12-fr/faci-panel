// ── grading.ts — single source of truth for grade weights ───────────────────
// Faithful TypeScript port of the legacy grading.js. Weights per subject come
// from the teacher's `subjects` config (loaded via the API) so faci grades
// match the teacher panel exactly; falls back to the DepEd default otherwise.

export interface Weights {
  ww: number;
  pt: number;
  exam: number;
  att: number;
  passing: number;
}

export const GRADE_DEFAULT: Weights = { ww: 30, pt: 50, exam: 20, att: 0, passing: 75 };

let SUBJECT_CFG: Record<string, Weights> = {};

const norm = (s: any) => String(s == null ? "" : s).trim().toLowerCase();
const num = (v: any, d: number) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

/** Populate the in-memory subject→weights map from the API `subjects` rows. */
export function setSubjectConfigs(subjects: any[]): Record<string, Weights> {
  const map: Record<string, Weights> = {};
  (subjects || []).forEach((r) => {
    map[norm(r.name)] = {
      ww: num(r.ww_percent, GRADE_DEFAULT.ww),
      pt: num(r.pt_percent, GRADE_DEFAULT.pt),
      exam: num(r.exam_percent, GRADE_DEFAULT.exam),
      att: num(r.attendance_percent, GRADE_DEFAULT.att),
      passing: num(r.passing_grade, GRADE_DEFAULT.passing),
    };
  });
  SUBJECT_CFG = map;
  return SUBJECT_CFG;
}

export function weightsFor(subjectName: string): Weights {
  const c = SUBJECT_CFG[norm(subjectName)];
  return c
    ? {
        ww: num(c.ww, GRADE_DEFAULT.ww),
        pt: num(c.pt, GRADE_DEFAULT.pt),
        exam: num(c.exam, GRADE_DEFAULT.exam),
        att: num(c.att, GRADE_DEFAULT.att),
        passing: num(c.passing, GRADE_DEFAULT.passing),
      }
    : { ...GRADE_DEFAULT };
}

export function passingFor(subjectName: string): number {
  return weightsFor(subjectName).passing;
}

export interface ComponentScores {
  ww: number;
  pt: number;
  qe: number;
  rawWW: number;
  rawPT: number;
  rawQE: number;
}

/** Component scores (each capped at 100) from a merged class record. */
export function componentScores(record: any): ComponentScores {
  let totalWW = 0;
  let totalPT = 0;
  const totalQE = num(record && record.qe, 0);
  for (const k in record || {}) {
    const v = record[k];
    if (v === null || v === undefined || v === "") continue;
    if (k.indexOf("module_") === 0 || k.indexOf("activity_") === 0 || k === "at") totalWW += num(v, 0);
    else if (k.indexOf("pt_") === 0) totalPT += num(v, 0);
  }
  return {
    ww: Math.min(totalWW, 100),
    pt: Math.min(totalPT, 100),
    qe: Math.min((totalQE / 50) * 100, 100),
    rawWW: totalWW,
    rawPT: totalPT,
    rawQE: totalQE,
  };
}

/** Attendance score 0–100 from {present, late, total}. No records → 100. */
export function attScore(att: { present?: number; late?: number; total?: number } | null | undefined): number {
  if (!att || !att.total) return 100;
  const present = num(att.present, 0);
  const late = num(att.late, 0);
  return Math.min(((present + 0.5 * late) / att.total) * 100, 100);
}

/** Final grade 0–100 for a merged record under a subject's weights. */
export function finalGrade(record: any, subjectName: string, attendanceScore?: number | null): number {
  const w = weightsFor(subjectName);
  const s = componentScores(record);
  const att = attendanceScore === null || attendanceScore === undefined ? 100 : attendanceScore;
  return Math.round(
    s.ww * (w.ww / 100) + s.pt * (w.pt / 100) + s.qe * (w.exam / 100) + att * (w.att / 100)
  );
}
