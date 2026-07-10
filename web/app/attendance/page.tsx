"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { getItem, isLoggedIn } from "@/lib/session";
import { useFaciSession } from "@/hooks/useFaciSession";
import { setupPush, armPermissionOnGesture } from "@/lib/notify";
import { useAlert } from "@/components/CustomAlert";
import BottomNav from "@/components/BottomNav";
import "./attendance.css";

type Status = "Present" | "Absent" | "Late";

const toDateInputValue = (d: Date) =>
  d.getFullYear() +
  "-" +
  String(d.getMonth() + 1).padStart(2, "0") +
  "-" +
  String(d.getDate()).padStart(2, "0");

const toDisplayDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });

export default function AttendancePage() {
  useFaciSession();
  const { alert, showAlert } = useAlert();

  const todayRef = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  const [dateValue, setDateValue] = useState(toDateInputValue(new Date()));
  const [headerDetails, setHeaderDetails] = useState("Loading Details...");
  const [subjectDisplay, setSubjectDisplay] = useState("...");
  const [students, setStudents] = useState<any[]>([]);
  const [sectionRow, setSectionRow] = useState<any>(null);
  const [quarter, setQuarter] = useState("1");
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [locked, setLocked] = useState(false);
  const [lockReason, setLockReason] = useState<"submitted" | "past" | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "empty" | "error" | "nosection">(
    "loading"
  );
  const [search, setSearch] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "success">("idle");

  const dateStr = useMemo(() => toDisplayDate(new Date(dateValue + "T00:00:00")), [dateValue]);

  // Initial load: section + students (once).
  useEffect(() => {
    if (!isLoggedIn() || !getItem("faci_section")) {
      window.location.href = "/login";
      return;
    }
    armPermissionOnGesture();
    setupPush();
    const subject = getItem("faci_subject") || "Subject";
    setSubjectDisplay(subject.substring(0, 7) + "...");

    (async () => {
      try {
        const [secResp, studentsResp] = await Promise.all([
          apiGet("/api/faci/section"),
          apiGet("/api/faci/students"),
        ]);
        const section = secResp.section;
        if (!section) {
          setLoadState("nosection");
          return;
        }
        setSectionRow(section);
        const q = section.quarter ? String(section.quarter) : "1";
        setQuarter(q);
        const semester = section.semester || "1st Sem";
        setHeaderDetails(`${semester} • ${getItem("faci_section")} • Q${q}`);

        const studs = studentsResp.students || [];
        setStudents(studs);
        if (!studs.length) {
          setLoadState("empty");
          return;
        }
        await loadAttendance(toDateInputValue(new Date()), studs);
      } catch (e) {
        console.error("Error fetching students:", e);
        setLoadState("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAttendance(dv: string, studs: any[]) {
    setLoadState("loading");
    const dStr = toDisplayDate(new Date(dv + "T00:00:00"));
    try {
      const resp = await apiGet(`/api/faci/attendance?date=${encodeURIComponent(dStr)}`);
      const rows: any[] = resp.attendance || [];

      const picked = new Date(dv + "T00:00:00");
      picked.setHours(0, 0, 0, 0);
      const isPastDate = picked < todayRef;
      const isAlreadySubmitted = rows.length > 0;
      const isLocked = isAlreadySubmitted || isPastDate;

      // Prefill marks from existing rows (match by id_no or name).
      const nextMarks: Record<string, Status> = {};
      studs.forEach((s) => {
        const record = rows.find(
          (a) => (s.id_no && a.student_id_no === s.id_no) || a.student_name === s.full_name
        );
        if (record && (record.status === "Present" || record.status === "Absent" || record.status === "Late")) {
          nextMarks[s.id] = record.status;
        }
      });
      setMarks(nextMarks);
      setLocked(isLocked);
      setLockReason(isAlreadySubmitted ? "submitted" : isPastDate ? "past" : null);
      setSubmitState("idle");
      setLoadState("ok");
    } catch (e) {
      console.error("Error fetching attendance:", e);
      setLoadState("error");
    }
  }

  function onDateChange(newValue: string) {
    if (!newValue) return;
    const picked = new Date(newValue + "T00:00:00");
    picked.setHours(0, 0, 0, 0);
    if (picked > todayRef) {
      showAlert(
        "Action Restricted",
        "You cannot log attendance for a schedule that has not yet occurred.",
        "#f59e0b"
      );
      return;
    }
    setDateValue(newValue);
    loadAttendance(newValue, students);
  }

  function mark(studentId: string, status: Status) {
    if (locked) return;
    setMarks((m) => ({ ...m, [studentId]: status }));
  }

  const stats = useMemo(() => {
    let present = 0;
    let absent = 0;
    let late = 0;
    Object.values(marks).forEach((s) => {
      if (s === "Present") present++;
      else if (s === "Absent") absent++;
      else if (s === "Late") late++;
    });
    return { present, absent, late, total: students.length };
  }, [marks, students.length]);

  async function handleSubmit() {
    if (locked) {
      showAlert(
        "Record Locked",
        "You cannot modify attendance for past dates or already finalized sessions.",
        "#64748b"
      );
      return;
    }
    const allMarked = students.length > 0 && students.every((s) => marks[s.id]);
    if (!allMarked) {
      showAlert(
        "Incomplete Data",
        "Please mark the attendance status for all students before submitting.",
        "#ef4444"
      );
      return;
    }
    setSubmitState("submitting");
    try {
      const items = students.map((s) => ({
        student_name: s.full_name,
        student_id_no: s.id_no || "",
        status: marks[s.id],
      }));
      await apiPost("/api/faci/attendance", {
        date: dateStr,
        subject: getItem("faci_subject") || "",
        quarter,
        items,
      });
      setSubmitState("success");
      setLocked(true);
      setLockReason("submitted");
    } catch (e: any) {
      showAlert("Submission Failed", String(e?.message || "Please try again."), "#ef4444");
      setSubmitState("idle");
    }
  }

  const filteredStudents = students.filter((s) =>
    String(s.full_name || "").toLowerCase().includes(search.toLowerCase())
  );

  const submitLabel = () => {
    if (submitState === "submitting")
      return (
        <>
          <i className="fa-solid fa-spinner fa-spin" /> Submitting...
        </>
      );
    if (submitState === "success")
      return (
        <>
          <i className="fa-solid fa-check" /> Submitted Successfully!
        </>
      );
    if (lockReason === "submitted")
      return (
        <>
          <i className="fa-solid fa-lock" /> Record Finalized
        </>
      );
    if (lockReason === "past")
      return (
        <>
          <i className="fa-solid fa-lock" /> Locked (Past Date)
        </>
      );
    return (
      <>
        <i className="fa-solid fa-paper-plane" /> Submit Attendance
      </>
    );
  };

  const submitBg =
    submitState === "success"
      ? "#10b981"
      : locked
      ? "#94a3b8"
      : "var(--accent-blue)";

  return (
    <div className="attendance-page">
      <div className="attendance-header fade-in-up">
        <div className="status-lock">
          <i className="fa-solid fa-lock" /> Attendance Record
        </div>
        <h1>Attendance</h1>
        <p>{headerDetails}</p>
      </div>

      <div className="controls-row fade-in-up delay-1">
        <div className="date-input" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px" }}>
          <i className="fa-regular fa-calendar" style={{ color: "var(--text-sub)" }} />
          <input
            type="date"
            value={dateValue}
            max={toDateInputValue(new Date())}
            onChange={(e) => onDateChange(e.target.value)}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: "0.9rem",
              fontWeight: 700,
              background: "transparent",
              color: "var(--text-main)",
              fontFamily: "inherit",
            }}
          />
        </div>
        <div className="subject-select">
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 700,
              color: "var(--accent-blue)",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>{subjectDisplay}</span> <i className="fa-solid fa-chevron-down" />
          </div>
        </div>
      </div>

      <div className="mini-stats-grid fade-in-up delay-2">
        <div className="mini-card total">
          <h3>{stats.total}</h3>
          <p>Total</p>
        </div>
        <div className="mini-card present">
          <h3>{stats.present}</h3>
          <p>Present</p>
        </div>
        <div className="mini-card absent">
          <h3>{stats.absent}</h3>
          <p>Absent</p>
        </div>
        <div className="mini-card late">
          <h3>{stats.late}</h3>
          <p>Late</p>
        </div>
      </div>

      <div className="search-container fade-in-up delay-3">
        <i className="fa-solid fa-magnifying-glass" style={{ color: "var(--text-sub)" }} />
        <input
          type="text"
          placeholder="Search student name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="fade-in-up delay-4">
        {loadState === "loading" && (
          <div style={{ textAlign: "center", padding: 20 }}>
            <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: "2rem" }} />
          </div>
        )}
        {loadState === "nosection" && (
          <div style={{ textAlign: "center", padding: 20, color: "red" }}>
            Error: Section not found or restricted.
          </div>
        )}
        {loadState === "empty" && (
          <div style={{ textAlign: "center", padding: 20 }}>No students assigned yet to this section.</div>
        )}
        {loadState === "error" && (
          <div style={{ textAlign: "center", padding: 20, color: "red" }}>
            Failed to load students. Please check your connection.
          </div>
        )}
        {loadState === "ok" &&
          filteredStudents.map((s, i) => {
            const num = String(i + 1).padStart(2, "0");
            const delay = Math.min(0.1 + i * 0.04, 0.6);
            const current = marks[s.id];
            const btn = (status: Status, cls: string, label: string) => (
              <button
                className={`opt-btn ${cls}${current === status ? " active" : ""}`}
                disabled={locked}
                style={locked ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
                onClick={() => mark(s.id, status)}
              >
                {label}
              </button>
            );
            return (
              <div
                className="student-card student-item fade-in-up"
                style={{ animationDelay: `${delay}s` }}
                key={s.id}
              >
                <div className="student-info">
                  <div className="student-name">
                    <h4 className="s-name">
                      <span style={{ color: "var(--accent-blue)", opacity: 0.5 }}>{num}</span>{" "}
                      {s.full_name}
                    </h4>
                    <p className="s-id">{s.id_no || ""}</p>
                  </div>
                </div>
                <div className="attendance-options">
                  {btn("Present", "present", "Present")}
                  {btn("Absent", "absent", "Absent")}
                  {btn("Late", "late", "Late")}
                </div>
              </div>
            );
          })}
      </div>

      <button
        className="submit-btn fade-in-up delay-5"
        style={{ background: submitBg }}
        onClick={handleSubmit}
        disabled={submitState === "submitting"}
      >
        {submitLabel()}
      </button>

      <BottomNav active="attendance" />
      {alert}
    </div>
  );
}
