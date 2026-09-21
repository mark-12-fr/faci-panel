"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { getItem, isLoggedIn } from "@/lib/session";
import { useFaciSession } from "@/hooks/useFaciSession";
import { setupPush, armPermissionOnGesture } from "@/lib/notify";
import { haptic } from "@/lib/haptic";
import { enqueue, isNetworkError, startAutoFlush } from "@/lib/offline-queue";
import { setSubjectConfigs, finalGrade, passingFor, attScore } from "@/lib/grading";
import { useAlert } from "@/components/CustomAlert";
import { RecordSkeleton } from "@/components/Skeleton";
import BottomNav from "@/components/BottomNav";
import "./record.css";

// Every score-holding column, in canonical order.
const REC_FIELDS: string[] = [
  ...Array.from({ length: 25 }, (_, i) => `module_${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `activity_${i + 1}`),
  "at",
  "pt_1",
  "pt_2",
  "qe",
];
const REC_FIELD_LABEL = (f: string) =>
  f.replace("module_", "M").replace("activity_", "A").toUpperCase().replace("_", " ");

const filled = (v: any) => v !== null && v !== undefined && v !== "";

// Draft scores survive an accidental close/refresh mid-entry. Keyed by section +
// quarter; only editable (not carried / already-submitted) fields are drafted.
const recDraftKey = (section: string, quarter: string) => `faci_rec_draft_${section}_${quarter}`;
const loadRecDraft = (section: string, quarter: string): Record<string, Record<string, string>> => {
  try {
    const r = localStorage.getItem(recDraftKey(section, quarter));
    return r ? JSON.parse(r) : {};
  } catch {
    return {};
  }
};
const saveRecDraftField = (section: string, quarter: string, studentId: string, field: string, value: string) => {
  try {
    const d = loadRecDraft(section, quarter);
    if (!d[studentId]) d[studentId] = {};
    if (value === "") delete d[studentId][field];
    else d[studentId][field] = value;
    if (Object.keys(d[studentId]).length === 0) delete d[studentId];
    localStorage.setItem(recDraftKey(section, quarter), JSON.stringify(d));
  } catch {}
};
const clearRecDraft = (section: string, quarter: string) => {
  try { localStorage.removeItem(recDraftKey(section, quarter)); } catch {}
};

interface Cell {
  field: string;
  value: string;
  disabled: boolean;
  carried: boolean;
}
interface Row {
  student: any;
  index: number;
  recordId?: string;
  cells: Cell[];
}

export default function RecordPage() {
  useFaciSession();
  const { alert, showAlert } = useAlert();

  const [headerSection, setHeaderSection] = useState("...");
  const [infoSemester, setInfoSemester] = useState("...");
  const [infoSubject, setInfoSubject] = useState("...");
  const [infoQuarter, setInfoQuarter] = useState("Q1");
  const [infoTotal, setInfoTotal] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [grades, setGrades] = useState<Record<string, number | null>>({}); // live grade per student
  const [attendance, setAttendance] = useState<any[]>([]); // for the attendance grade component
  const [dataVersion, setDataVersion] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "empty" | "error">("loading");
  const [search, setSearch] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "success">("idle");

  const [toast, setToast] = useState<{ show: boolean; msg: string }>({ show: false, msg: "" });

  const currentQuarterRef = useRef("1");
  const sectionIdRef = useRef<string | null>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  // Drawer
  const [drawer, setDrawer] = useState<{
    open: boolean;
    studentId: string;
    studentName: string;
    cells: { field: string; label: string; value: string; disabled: boolean }[];
    ver: number;
  }>({ open: false, studentId: "", studentName: "", cells: [], ver: 0 });
  const drawerRef = useRef<HTMLDivElement>(null);

  function showToast(msg: string) {
    setToast({ show: true, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3500);
  }

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoggedIn()) {
      window.location.href = "/login";
      return;
    }
    armPermissionOnGesture();
    setupPush();
    const sectionTitle = getItem("faci_section") || "";
    const subject = getItem("faci_subject") || "Subject";
    setHeaderSection(sectionTitle);
    setInfoSubject(subject.substring(0, 15));
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replay offline-queued submits — now, and whenever the connection returns.
  useEffect(() => {
    return startAutoFlush((n) =>
      showAlert("Back online", `${n} offline submission${n > 1 ? "s" : ""} synced.`, "#10b981")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    setLoadState("loading");
    try {
      const secResp = await apiGet("/api/faci/section");
      const section = secResp.section;
      if (section) {
        setInfoSemester(section.semester || "1st Sem");
        sectionIdRef.current = String(section.id);
        currentQuarterRef.current = section.quarter ? String(section.quarter) : "1";
        setInfoQuarter(
          currentQuarterRef.current === "Prelim" ||
            currentQuarterRef.current === "Midterm" ||
            currentQuarterRef.current === "Final"
            ? currentQuarterRef.current
            : "Q" + currentQuarterRef.current
        );
      }
      if (!sectionIdRef.current) {
        setRows([]);
        setLoadState("empty");
        return;
      }
      const [studentsResp, recordsResp, subjectsResp, attendanceResp] = await Promise.all([
        apiGet("/api/faci/students"),
        apiGet("/api/faci/class-records"),
        apiGet("/api/faci/subjects").catch(() => ({ subjects: [] })), // for live-grade weights
        apiGet("/api/faci/attendance").catch(() => ({ attendance: [] })), // for the attendance component
      ]);
      const students = studentsResp.students || [];
      const records = recordsResp.records || [];
      setSubjectConfigs(subjectsResp.subjects || []);
      setAttendance(attendanceResp.attendance || []);
      setInfoTotal(students.length);
      if (!students.length) {
        setRows([]);
        setLoadState("empty");
        return;
      }
      const quarter = currentQuarterRef.current;
      const draft = loadRecDraft(getItem("faci_section") || "sec", quarter);
      const built: Row[] = students.map((student: any, i: number) => {
        const studentRecs = records.filter((r: any) => r.student_id === student.id);
        const currentRec =
          studentRecs.find((r: any) => String(r.quarter) === String(quarter)) ||
          studentRecs.find((r: any) => r.quarter === null || r.quarter === undefined) ||
          null;
        const fallbackRecs = studentRecs
          .filter((r: any) => r !== currentRec)
          .sort(
            (a: any, b: any) =>
              Number(String(b.quarter || 0).replace(/[^1-4]/g, "") || 0) -
              Number(String(a.quarter || 0).replace(/[^1-4]/g, "") || 0)
          );
        const fallbackValue = (field: string) => {
          for (const r of fallbackRecs) if (filled(r[field])) return r[field];
          return null;
        };
        const cells: Cell[] = REC_FIELDS.map((field) => {
          const currentVal = currentRec ? currentRec[field] : null;
          const hasCurrent = filled(currentVal);
          const carried = hasCurrent ? null : fallbackValue(field);
          // Restore a draft value only into a still-editable (unsubmitted, not
          // carried) field, so drafts never mask real/locked scores.
          const draftVal = !hasCurrent && carried === null ? draft[student.id]?.[field] : undefined;
          const displayVal = hasCurrent ? currentVal : carried !== null ? carried : draftVal ?? "";
          return {
            field,
            value: displayVal === "" || displayVal === null || displayVal === undefined ? "" : String(displayVal),
            disabled: hasCurrent || carried !== null,
            carried: !hasCurrent && carried !== null,
          };
        });
        return { student, index: i + 1, recordId: currentRec?.id, cells };
      });
      setRows(built);
      recomputeAllGrades(built);
      setDataVersion((v) => v + 1);
      setLoadState("ok");
    } catch (e) {
      console.error("Error loading records:", e);
      setLoadState("error");
    }
  }

  // ── Drawer ────────────────────────────────────────────────────────────────
  function openDrawer(studentId: string, studentName: string) {
    const rowEl = tableRef.current?.querySelector(`.student-data-row[data-uuid="${studentId}"]`);
    if (!rowEl) return;
    const cells = REC_FIELDS.map((field) => {
      const input = rowEl.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
      return {
        field,
        label: REC_FIELD_LABEL(field),
        value: input?.value || "",
        disabled: !!input?.disabled,
      };
    });
    setDrawer((d) => ({ open: true, studentId, studentName, cells, ver: d.ver + 1 }));
  }
  function closeDrawer() {
    setDrawer((d) => ({ ...d, open: false }));
  }
  function applyDrawerScores() {
    const rowEl = tableRef.current?.querySelector(
      `.student-data-row[data-uuid="${drawer.studentId}"]`
    );
    if (!rowEl) return;
    const sectionName = getItem("faci_section") || "sec";
    drawerRef.current?.querySelectorAll<HTMLInputElement>("input[data-field]").forEach((di) => {
      const field = di.getAttribute("data-field")!;
      const target = rowEl.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
      if (target && !target.disabled) {
        target.value = di.value;
        if (di.value !== "") {
          target.style.backgroundColor = "#eff6ff";
          target.style.borderColor = "var(--accent-blue)";
        }
        saveRecDraftField(sectionName, currentQuarterRef.current, drawer.studentId, field, di.value.trim());
      }
    });
    recomputeGrade(drawer.studentId); // programmatic .value doesn't fire onInput
    closeDrawer();
    showToast("Scores applied to table. Don't forget to Submit!");
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  // ── Live grade ──────────────────────────────────────────────────────────────
  function attendanceScoreFor(fullName: string): number {
    const key = String(fullName || "").trim().toLowerCase();
    let present = 0;
    let late = 0;
    let total = 0;
    for (const a of attendance) {
      if (String(a.student_name || "").trim().toLowerCase() !== key) continue;
      const st = String(a.status || "").toLowerCase();
      if (st === "present") present++;
      else if (st === "late" || st === "excused") late++;
      total++;
    }
    return attScore({ present, late, total });
  }

  // Live grade read straight from a row's current inputs (called as the faci types).
  function recomputeGrade(studentId: string) {
    const rowEl = tableRef.current?.querySelector<HTMLTableRowElement>(
      `.student-data-row[data-uuid="${studentId}"]`
    );
    const rec: Record<string, any> = {};
    rowEl?.querySelectorAll<HTMLInputElement>(".score-input").forEach((inp) => {
      const v = inp.value.trim();
      if (v !== "") rec[inp.dataset.field!] = v;
    });
    const student = rows.find((r) => r.student.id === studentId)?.student;
    const g = REC_FIELDS.some((f) => filled(rec[f]))
      ? finalGrade(rec, getItem("faci_subject") || "", attendanceScoreFor(student?.full_name || ""))
      : null;
    setGrades((m) => ({ ...m, [studentId]: g }));
  }

  // Recompute every row's grade from the live DOM — after a bulk change (photo
  // scan) whose programmatic .value writes don't fire onInput.
  function refreshGradesFromDom() {
    const g: Record<string, number | null> = {};
    tableRef.current?.querySelectorAll<HTMLTableRowElement>(".student-data-row").forEach((rowEl) => {
      const sid = rowEl.dataset.uuid!;
      const rec: Record<string, any> = {};
      rowEl.querySelectorAll<HTMLInputElement>(".score-input").forEach((inp) => {
        const v = inp.value.trim();
        if (v !== "") rec[inp.dataset.field!] = v;
      });
      const student = rows.find((r) => r.student.id === sid)?.student;
      g[sid] = REC_FIELDS.some((f) => filled(rec[f]))
        ? finalGrade(rec, getItem("faci_subject") || "", attendanceScoreFor(student?.full_name || ""))
        : null;
    });
    setGrades(g);
  }

  // Initial (and post-bulk) grades computed from row cells, not the DOM (which
  // may not have rendered the new rows yet).
  function recomputeAllGrades(builtRows: Row[]) {
    const g: Record<string, number | null> = {};
    builtRows.forEach((r) => {
      const rec: Record<string, any> = {};
      r.cells.forEach((c) => {
        if (c.value !== "") rec[c.field] = c.value;
      });
      g[r.student.id] = REC_FIELDS.some((f) => filled(rec[f]))
        ? finalGrade(rec, getItem("faci_subject") || "", attendanceScoreFor(r.student.full_name || ""))
        : null;
    });
    setGrades(g);
  }

  // As the faci types a score: refresh that student's live grade and save a draft.
  function onScoreInput(studentId: string, field: string, value: string) {
    recomputeGrade(studentId);
    saveRecDraftField(getItem("faci_section") || "sec", currentQuarterRef.current, studentId, field, value);
  }

  // Enter / ↓ → next student's same field; ↑ → previous. Speeds a column of entry.
  function onScoreKeyDown(e: ReactKeyboardEvent<HTMLInputElement>, field: string) {
    if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const dir = e.key === "ArrowUp" ? -1 : 1;
    const tr = e.currentTarget.closest("tr");
    let next = (dir > 0 ? tr?.nextElementSibling : tr?.previousElementSibling) as HTMLElement | null;
    while (next && (next.style.display === "none" || !next.classList.contains("student-data-row")))
      next = (dir > 0 ? next.nextElementSibling : next.previousElementSibling) as HTMLElement | null;
    const target = next?.querySelector<HTMLInputElement>(`.score-input[data-field="${field}"]`);
    if (target && !target.disabled) {
      target.focus();
      target.select();
    }
  }

  async function handleSubmit() {
    const sectionId = sectionIdRef.current;
    if (!sectionId) {
      showAlert("Session Error", "Session invalid. Please refresh the page.", "#f59e0b");
      return;
    }
    const dateStr = new Date().toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const quarter = currentQuarterRef.current;

    let hasNewInput = false;
    const records: any[] = [];
    tableRef.current?.querySelectorAll<HTMLTableRowElement>(".student-data-row").forEach((row) => {
      const studUuid = row.dataset.uuid!;
      const recordId = row.dataset.recordid;
      const scores: Record<string, number | null> = {};
      row.querySelectorAll<HTMLInputElement>(".score-input").forEach((input) => {
        if (input.dataset.carried === "1") return;
        const val = input.value.trim();
        scores[input.dataset.field!] = val === "" ? null : parseFloat(val);
        if (val !== "" && !input.disabled) hasNewInput = true;
      });
      const rec: any = { student_id: studUuid, section_id: sectionId, date: dateStr, quarter, scores };
      if (recordId) rec.id = recordId;
      records.push(rec);
    });

    if (!hasNewInput) {
      showAlert(
        "No New Data",
        "Please input at least one new score before submitting. Existing scores are locked.",
        "#ef4444"
      );
      return;
    }

    setSubmitState("submitting");
    const sectionName = getItem("faci_section") || "sec";
    // Lock the newly-filled inputs + clear the draft + confirm with a haptic —
    // shared by the online-saved and the offline-queued paths.
    const markSubmitted = () => {
      clearRecDraft(sectionName, quarter);
      haptic([10, 30, 10]);
      setSubmitState("success");
      tableRef.current?.querySelectorAll<HTMLInputElement>(".score-input").forEach((input) => {
        if (input.value.trim() !== "") {
          input.disabled = true;
          input.title = "Score submitted. Only the Teacher can edit this.";
          input.style.backgroundColor = "";
          input.style.borderColor = "transparent";
        }
      });
    };
    try {
      await apiPost("/api/faci/class-records", records);
      markSubmitted();
      setTimeout(() => {
        loadData();
        setSubmitState("idle");
      }, 2000);
    } catch (e: any) {
      // No connection → queue it; it syncs automatically once back online.
      if (isNetworkError(e)) {
        enqueue("/api/faci/class-records", records, `Scores • ${dateStr}`);
        markSubmitted();
        showAlert(
          "Saved offline",
          "No connection right now — these scores will submit automatically once you're back online.",
          "#f59e0b"
        );
      } else {
        showAlert("System Error", "Failed to submit records: " + (e?.message || ""), "#ef4444");
        setSubmitState("idle");
      }
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────
  const searchLower = search.toLowerCase();

  return (
    <div className="record-page">
      {loadState === "loading" && <RecordSkeleton />}

      {loadState !== "loading" && (
        <>
      <div className="header-section fade-in-up">
        <div className="status-lock">
          <i className="fa-solid fa-lock" /> Class Record
        </div>
        <div className="header-flex">
          <div>
            <h1>Class Record</h1>
            <p style={{ fontSize: "0.8rem", color: "var(--text-sub)" }}>
              All scores — <span>{headerSection}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="info-card fade-in-up delay-1">
        <div className="info-box">
          <p>Semester</p>
          <h3>{infoSemester}</h3>
        </div>
        <div className="info-box">
          <p>Subject</p>
          <h3>{infoSubject}</h3>
        </div>
        <div className="info-box">
          <p>Quarter</p>
          <span className="quarter-badge">{infoQuarter}</span>
        </div>
        <div className="info-box">
          <p>Total Students</p>
          <h3>{infoTotal}</h3>
        </div>
        <div className="info-box full">
          <p>Section</p>
          <span className="section-tag">{headerSection}</span>
        </div>
      </div>

      <div className="search-bar fade-in-up delay-2">
        <i className="fa-solid fa-magnifying-glass" style={{ color: "var(--text-sub)" }} />
        <input
          type="text"
          placeholder="Search student name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-scroll-container fade-in-up delay-3">
        <div className="horizontal-scroll">
          <table>
            <thead>
              <tr>
                <th className="sticky-col-1" rowSpan={2}>#</th>
                <th className="sticky-col-2" rowSpan={2}>STUDENT NAME</th>
                <th colSpan={25} style={{ background: "#f1f5f9" }}>MODULES</th>
                <th colSpan={10} style={{ background: "#e0f2fe" }}>ACTIVITIES</th>
                <th rowSpan={2} style={{ background: "#f8fafc" }}>AT</th>
                <th rowSpan={2} style={{ background: "#f8fafc" }}>PT 1</th>
                <th rowSpan={2} style={{ background: "#f8fafc" }}>PT 2</th>
                <th rowSpan={2} style={{ background: "#f8fafc" }}>QE</th>
                <th rowSpan={2} style={{ background: "#eef2ff" }}>GRADE</th>
              </tr>
              <tr style={{ fontSize: "0.6rem" }}>
                {Array.from({ length: 25 }, (_, i) => (
                  <th key={`m${i}`}>{i + 1}</th>
                ))}
                {Array.from({ length: 10 }, (_, i) => (
                  <th key={`a${i}`} style={{ background: "#f0f9ff" }}>
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={tableRef}>
              {loadState === "empty" && (
                <tr>
                  <td colSpan={42} style={{ color: "var(--text-sub)", textAlign: "center", padding: 20 }}>
                    No students assigned yet.
                  </td>
                </tr>
              )}
              {loadState === "error" && (
                <tr>
                  <td colSpan={42} style={{ color: "red", textAlign: "center" }}>
                    Failed to load data.
                  </td>
                </tr>
              )}
              {loadState === "ok" &&
                rows.map((row) => {
                  const hidden = !String(row.student.full_name || "").toLowerCase().includes(searchLower);
                  return (
                    <tr
                      className="student-data-row"
                      data-uuid={row.student.id}
                      data-recordid={row.recordId || undefined}
                      data-id-no={(row.student as any).id_no || undefined}
                      style={hidden ? { display: "none" } : undefined}
                      key={`${row.student.id}-${dataVersion}`}
                    >
                      <td className="td-sticky-1">{row.index}</td>
                      <td className="td-sticky-2 search-target">
                        <strong
                          className="clickable-name"
                          onClick={() => openDrawer(row.student.id, row.student.full_name)}
                        >
                          {row.student.full_name}
                        </strong>
                      </td>
                      {row.cells.map((c) => (
                        <td key={c.field}>
                          <input
                            type="number"
                            inputMode="decimal"
                            className="score-input"
                            data-field={c.field}
                            data-carried={c.carried ? "1" : undefined}
                            defaultValue={c.value}
                            disabled={c.disabled}
                            onKeyDown={c.disabled ? undefined : (e) => onScoreKeyDown(e, c.field)}
                            onInput={
                              c.disabled
                                ? undefined
                                : (e) => onScoreInput(row.student.id, c.field, (e.target as HTMLInputElement).value)
                            }
                            title={
                              c.disabled
                                ? c.carried
                                  ? "Carried over from a previous quarter. Edit via the teacher panel."
                                  : "Score submitted. Only the Teacher can edit this."
                                : undefined
                            }
                          />
                        </td>
                      ))}
                      {(() => {
                        const g = grades[row.student.id] ?? null;
                        const pass = g !== null && g >= passingFor(getItem("faci_subject") || "");
                        return (
                          <td
                            className="grade-live-cell"
                            style={{
                              fontWeight: 700,
                              textAlign: "center",
                              color: g === null ? "var(--text-sub)" : pass ? "#059669" : "#dc2626",
                              background: g === null ? undefined : pass ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)",
                            }}
                          >
                            {g === null ? "—" : g}
                          </td>
                        );
                      })()}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      <button
        className="submit-btn fade-in-up delay-4"
        onClick={handleSubmit}
        disabled={submitState === "submitting"}
        style={submitState === "success" ? { background: "#10b981" } : undefined}
      >
        {submitState === "submitting" ? (
          <>
            <i className="fa-solid fa-spinner fa-spin" /> Submitting...
          </>
        ) : submitState === "success" ? (
          <>
            <i className="fa-solid fa-check" /> Submitted Successfully!
          </>
        ) : (
          <>
            <i className="fa-solid fa-paper-plane" /> Submit New Scores
          </>
        )}
      </button>

      <BottomNav active="records" />

      {/* Toast */}
      <div className={`toast-notification${toast.show ? " show" : ""}`}>
        <i className="fa-solid fa-arrows-rotate" />
        <span>{toast.msg}</span>
      </div>

      {/* Drawer editor */}
      <div className={`drawer-overlay${drawer.open ? " show" : ""}`} onClick={closeDrawer} />
      <div className={`bottom-drawer${drawer.open ? " show" : ""}`}>
        <div className="drawer-header">
          <h3>
            <i className="fa-solid fa-user-pen" /> {drawer.studentName}
          </h3>
          <button onClick={closeDrawer} className="close-drawer-btn">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="drawer-body" ref={drawerRef} key={drawer.ver}>
          {[
            { title: "Modules", filter: (f: string) => f.startsWith("module_") },
            { title: "Activities", filter: (f: string) => f.startsWith("activity_") },
            { title: "Assessments", filter: (f: string) => ["at", "pt_1", "pt_2", "qe"].includes(f) },
          ].map((grp) => (
            <div key={grp.title}>
              <div className="drawer-section-title">{grp.title}</div>
              <div className="drawer-grid">
                {drawer.cells
                  .filter((c) => grp.filter(c.field))
                  .map((c) => (
                    <div className="drawer-input-group" key={c.field}>
                      <label>{c.label}</label>
                      <input type="number" data-field={c.field} defaultValue={c.value} disabled={c.disabled} />
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
        <div className="drawer-footer">
          <button className="apply-drawer-btn" onClick={applyDrawerScores}>
            <i className="fa-solid fa-check" /> Apply to Table
          </button>
        </div>
      </div>

      {alert}
        </>
      )}
    </div>
  );
}
