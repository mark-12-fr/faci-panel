"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { getItem, isLoggedIn } from "@/lib/session";
import {
  attScore,
  componentScores,
  finalGrade,
  passingFor,
  setSubjectConfigs,
  weightsFor,
} from "@/lib/grading";
import { useFaciSession } from "@/hooks/useFaciSession";
import { setupPush, armPermissionOnGesture } from "@/lib/notify";
import { useAlert } from "@/components/CustomAlert";
import BottomNav from "@/components/BottomNav";
import "./page.css";

// ── helpers (ported from index.html) ─────────────────────────────────────────
const initials = (name?: string) =>
  (name || "?").trim().split(/\s+/).map((p) => p[0]).join("").slice(0, 2);

const filled = (v: any) => v !== null && v !== undefined && v !== "";

/** Merge ALL of a student's records across quarters (latest non-empty wins). */
function mergeStudentRecord(records: any[], studentId: string): any | null {
  const recs = records
    .filter((r) => r.student_id === studentId)
    .sort(
      (a, b) =>
        Number(String(a.quarter || 0).replace(/[^1-4]/g, "") || 0) -
        Number(String(b.quarter || 0).replace(/[^1-4]/g, "") || 0)
    );
  if (!recs.length) return null;
  return recs.reduce((acc: any, curr: any) => {
    Object.keys(curr).forEach((k) => {
      if (filled(curr[k])) acc[k] = curr[k];
    });
    return acc;
  }, {});
}

interface DrawerState {
  open: boolean;
  type: string;
}

export default function DashboardPage() {
  useFaciSession();
  const { alert, showAlert } = useAlert();

  const [ready, setReady] = useState(false);
  const [greeting, setGreeting] = useState("Good day,\nFacilitator!");
  const [sectionTag, setSectionTag] = useState("Section");
  const [subjectTag, setSubjectTag] = useState("");
  const [avatar, setAvatar] = useState("");
  const [currentDate, setCurrentDate] = useState("");

  const [semester, setSemester] = useState("1st");
  const [quarter, setQuarter] = useState("1");

  const [students, setStudents] = useState<any[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [attendanceToday, setAttendanceToday] = useState<any[]>([]);
  const [attRate, setAttRate] = useState<Record<string, number>>({});
  const [faciSubject, setFaciSubject] = useState("");
  const [noSection, setNoSection] = useState(false);
  const [statsError, setStatsError] = useState(false);

  const [drawer, setDrawer] = useState<DrawerState>({ open: false, type: "" });

  useEffect(() => {
    if (!isLoggedIn()) {
      window.location.href = "/login";
      return;
    }

    armPermissionOnGesture();
    setupPush();

    const cachedName = getItem("faci_name") || "User";
    const cachedImg = getItem("faci_img_url");
    setAvatar(
      cachedImg && cachedImg.trim() !== ""
        ? cachedImg
        : `https://ui-avatars.com/api/?name=${encodeURIComponent(cachedName)}&background=1e3a8a&color=fff`
    );

    const d = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const exactTodayDate = `${dd}/${mm}/${yyyy}`;
    setCurrentDate(
      d
        .toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" })
        .toUpperCase()
    );

    (async () => {
      // 1. Live profile
      try {
        const me = await apiGet("/api/faci/me");
        if (me) {
          const firstName = String(me.full_name || "Facilitator").split(" ")[0];
          const hr = new Date().getHours();
          const partOfDay = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
          setGreeting(`${partOfDay},\n${firstName}!`);
          setSectionTag(me.section || "");
          setSubjectTag(me.subject || "Subject");
          if (me.avatar_url && String(me.avatar_url).trim() !== "") {
            setAvatar(me.avatar_url);
          } else {
            setAvatar(
              `https://ui-avatars.com/api/?name=${encodeURIComponent(me.full_name || "User")}&background=1e3a8a&color=fff`
            );
          }
        }
      } catch {
        /* keep cached */
      }

      // 2. Section + stats
      try {
        const secResp = await apiGet("/api/faci/section");
        const section = secResp.section;
        if (!section) {
          setNoSection(true);
          setGreeting("No active section");
          setSectionTag("—");
          setSubjectTag("—");
          showAlert(
            "Section unavailable",
            "Your assigned section is no longer available — it may have been removed by your teacher. Please contact them to be assigned to a new section.",
            "#f59e0b"
          );
          setReady(true);
          return;
        }

        setSemester(
          (String(section.semester || "1st Sem").replace(/\s*sem(ester)?\.?\s*$/i, "").trim()) || "1st"
        );
        setQuarter(String(section.quarter || "1"));

        const subject = getItem("faci_subject") || subjectTag || "";
        setFaciSubject(subject);

        const [studentsResp, recordsResp, subjectsResp] = await Promise.all([
          apiGet("/api/faci/students"),
          apiGet("/api/faci/class-records"),
          apiGet("/api/faci/subjects"),
        ]);
        const studs = studentsResp.students || [];
        const recs = recordsResp.records || [];
        setStudents(studs);
        setRecords(recs);
        setSubjectConfigs(subjectsResp.subjects || []);

        // Attendance rate — only when this subject weights attendance (>0).
        const rate: Record<string, number> = {};
        if (weightsFor(subject).att > 0) {
          try {
            const allResp = await apiGet("/api/faci/attendance");
            const agg: Record<string, { present: number; late: number; total: number }> = {};
            (allResp.attendance || []).forEach((a: any) => {
              const idk = a.student_id_no ? "id:" + String(a.student_id_no).trim() : null;
              const nmk = a.student_name ? "nm:" + String(a.student_name).trim().toLowerCase() : null;
              if (!idk && !nmk) return;
              // One bucket per student, registered under BOTH keys: rows saved
              // with an id_no and rows saved with only a name (or an id_no that
              // was later edited) must land in the same counts — otherwise the
              // absences silently vanish and attScore() defaults the student to
              // a perfect attendance component in the grade.
              const bucket =
                (idk && agg[idk]) || (nmk && agg[nmk]) || { present: 0, late: 0, total: 0 };
              if (idk) agg[idk] = bucket;
              if (nmk) agg[nmk] = bucket;
              bucket.total++;
              if (a.status === "Present") bucket.present++;
              else if (a.status === "Late") bucket.late++;
            });
            studs.forEach((st: any) => {
              const idk = st.id_no ? "id:" + String(st.id_no).trim() : null;
              const nmk = st.full_name ? "nm:" + String(st.full_name).trim().toLowerCase() : null;
              const rec = (idk && agg[idk]) || (nmk && agg[nmk]) || null;
              rate[st.id] = attScore(rec as any);
            });
          } catch {
            /* attendance optional */
          }
        }
        setAttRate(rate);

        // Today's attendance
        const todayResp = await apiGet(`/api/faci/attendance?date=${encodeURIComponent(exactTodayDate)}`);
        setAttendanceToday(todayResp.attendance || []);
        setReady(true);
      } catch (e) {
        console.error("Error fetching stats:", e);
        setStatsError(true);
        setReady(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── derived stats ──────────────────────────────────────────────────────────
  const totalStudents = students.length;

  const { modulesDone, activitiesDone, pendingModules, pendingActivities } = useMemo(() => {
    let md = 0;
    let ad = 0;
    records.forEach((record) => {
      for (let i = 1; i <= 25; i++) if (filled(record[`module_${i}`])) md++;
      for (let i = 1; i <= 10; i++) if (filled(record[`activity_${i}`])) ad++;
    });
    const totMod = totalStudents * 25;
    const totAct = totalStudents * 10;
    return {
      modulesDone: md,
      activitiesDone: ad,
      pendingModules: totMod > 0 ? totMod - md : 0,
      pendingActivities: totAct > 0 ? totAct - ad : 0,
    };
  }, [records, totalStudents]);

  const { present, absentLate } = useMemo(() => {
    let p = 0;
    let al = 0;
    attendanceToday.forEach((r) => {
      if (r.status === "Present") p++;
      if (r.status === "Absent" || r.status === "Late") al++;
    });
    return { present: p, absentLate: al };
  }, [attendanceToday]);

  function gradeFor(student: any) {
    const merged = mergeStudentRecord(records, student.id);
    if (!merged) return { grade: 0, ww: 0, pt: 0, qe: 0 };
    const sc = componentScores(merged);
    const att = attRate[student.id] != null ? attRate[student.id] : 100;
    const grade = finalGrade(merged, faciSubject, att);
    return { grade, ww: sc.rawWW, pt: sc.rawPT, qe: sc.rawQE };
  }

  const performance = useMemo(() => {
    if (!students.length) return { highest: 0, lowest: 0, ranked: [] as any[] };
    const scored = students.map((s) => ({ student: s, ...gradeFor(s) }));
    const highest = scored.reduce((m, s) => (s.grade > m ? s.grade : m), 0);
    const graded = scored.filter((s) => s.grade > 0);
    const lowest = graded.length ? graded.reduce((m, s) => (s.grade < m ? s.grade : m), Infinity) : 0;
    const ranked = [...scored].sort(
      (a, b) =>
        b.grade - a.grade ||
        b.ww + b.pt + b.qe - (a.ww + a.pt + a.qe) ||
        String(a.student.full_name || "").localeCompare(String(b.student.full_name || ""))
    );
    return { highest, lowest, ranked };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, records, attRate, faciSubject]);

  // ── drawer content ──────────────────────────────────────────────────────────
  const drawerTitle = (() => {
    switch (drawer.type) {
      case "students":
        return "My Students";
      case "attendance":
        return "Today's Attendance";
      case "modules":
        return "Modules";
      case "activities":
        return "Activities";
      case "exams":
        return "Performance Tasks & Exam";
      case "missing":
        return "Missing Scores";
      default:
        return "Details";
    }
  })();

  function renderDrawerBody() {
    const type = drawer.type;
    if (type === "students") {
      if (!students.length) return <div className="drawer-empty">No students assigned yet.</div>;
      return students.map((s) => (
        <div className="drawer-row" key={s.id}>
          <div className="avatar">{initials(s.full_name)}</div>
          <div className="info">
            <div className="name">{s.full_name}</div>
            <div className="sub">{s.id_no || ""}</div>
          </div>
        </div>
      ));
    }

    if (type === "attendance") {
      const byKey: Record<string, any> = {};
      attendanceToday.forEach((r) => {
        // Register under BOTH keys so a row still matches its student when
        // the id_no drifted (edited later / saved name-only) — same reason as
        // the attendance-rate aggregation above.
        const idk = (r.student_id_no || "").trim();
        const nmk = (r.student_name || "").trim().toLowerCase();
        if (idk) byKey[idk] = r;
        if (nmk) byKey["name:" + nmk] = r;
      });
      const groups: Record<string, { student: any; remarks: string }[]> = {
        Present: [],
        Late: [],
        Absent: [],
        Excused: [],
        Unmarked: [],
      };
      students.forEach((s) => {
        const k1 = (s.id_no || "").trim();
        const k2 = "name:" + (s.full_name || "").trim().toLowerCase();
        const r = byKey[k1] || byKey[k2];
        const status = r ? r.status : "Unmarked";
        (groups[status] || groups.Unmarked).push({ student: s, remarks: r ? r.remarks : "" });
      });
      const badgeFor: Record<string, string> = {
        Present: "badge-present",
        Late: "badge-late",
        Absent: "badge-absent",
        Excused: "badge-excused",
      };
      const sections = ["Present", "Late", "Absent", "Excused"]
        .filter((label) => groups[label].length)
        .map((label) => (
          <div key={label}>
            <div className="drawer-section-title">
              {label} ({groups[label].length})
            </div>
            {groups[label].map(({ student, remarks }) => (
              <div className="drawer-row" key={student.id}>
                <div className="avatar">{initials(student.full_name)}</div>
                <div className="info">
                  <div className="name">{student.full_name}</div>
                  <div className="sub">{remarks || ""}</div>
                </div>
                <span className={`badge ${badgeFor[label]}`}>{label}</span>
              </div>
            ))}
          </div>
        ));
      const unmarked = groups.Unmarked;
      const hasAny = sections.length || unmarked.length;
      return (
        <>
          {sections}
          {unmarked.length > 0 && (
            <>
              <div className="drawer-section-title">Not yet marked ({unmarked.length})</div>
              {unmarked.map(({ student }) => (
                <div className="drawer-row" key={student.id}>
                  <div className="avatar">{initials(student.full_name)}</div>
                  <div className="info">
                    <div className="name">{student.full_name}</div>
                  </div>
                </div>
              ))}
            </>
          )}
          {!hasAny && <div className="drawer-empty">No attendance recorded today yet.</div>}
        </>
      );
    }

    if (type === "modules" || type === "activities") {
      const isMod = type === "modules";
      const count = isMod ? 25 : 10;
      const prefix = isMod ? "module_" : "activity_";
      const noun = isMod ? "Module" : "Activity";
      const sectionLabel = isMod ? "Modules" : "Activities";
      const rows = students.map((s) => {
        const rec = mergeStudentRecord(records, s.id);
        if (!rec) return { student: s, done: 0, lastIndex: 0, nextIndex: 1 as number | null };
        let done = 0;
        let lastIndex = 0;
        for (let i = 1; i <= count; i++) {
          if (filled(rec[prefix + i])) {
            done++;
            lastIndex = i;
          }
        }
        const nextIndex = lastIndex < count ? lastIndex + 1 : null;
        return { student: s, done, lastIndex, nextIndex };
      });
      const submitted = rows.filter((r) => r.done > 0).sort((a, b) => b.done - a.done);
      const pending = rows.filter((r) => r.done === 0);
      if (!submitted.length && !pending.length)
        return <div className="drawer-empty">No data yet.</div>;
      return (
        <>
          {submitted.length > 0 && (
            <>
              <div className="drawer-section-title">
                Submitted {sectionLabel.toLowerCase()} ({submitted.length})
              </div>
              {submitted.map((r) => (
                <div className="drawer-row" key={r.student.id}>
                  <div className="avatar">{initials(r.student.full_name)}</div>
                  <div className="info">
                    <div className="name">{r.student.full_name}</div>
                    <div className="meta-line">
                      <span className="dot ok" />
                      Latest: <b>{noun} {r.lastIndex}</b>
                    </div>
                    {r.nextIndex ? (
                      <div className="meta-line">
                        <span className="dot next" />
                        Next: <b>{noun} {r.nextIndex}</b>
                      </div>
                    ) : (
                      <div className="meta-line">
                        <span className="dot ok" />
                        <b>All {count} submitted</b>
                      </div>
                    )}
                  </div>
                  <span className="badge badge-score">
                    {r.done}/{count}
                  </span>
                </div>
              ))}
            </>
          )}
          {pending.length > 0 && (
            <>
              <div className="drawer-section-title">Pending ({pending.length})</div>
              {pending.map((r) => (
                <div className="drawer-row" key={r.student.id}>
                  <div className="avatar">{initials(r.student.full_name)}</div>
                  <div className="info">
                    <div className="name">{r.student.full_name}</div>
                    <div className="meta-line">
                      <span className="dot no" />
                      No {sectionLabel.toLowerCase()} submitted yet
                    </div>
                  </div>
                  <span className="badge badge-absent">0/{count}</span>
                </div>
              ))}
            </>
          )}
        </>
      );
    }

    if (type === "exams") {
      if (!students.length) return <div className="drawer-empty">No data yet.</div>;
      const ptChip = (label: string, v: any) => {
        const empty = !filled(v);
        return (
          <span className={`chip ${empty ? "miss" : "has"}`}>
            <span className="lbl">{label}</span>
            {empty ? "—" : v}
          </span>
        );
      };
      return students.map((s) => {
        const rec = mergeStudentRecord(records, s.id) || {};
        return (
          <div className="drawer-row" key={s.id}>
            <div className="avatar">{initials(s.full_name)}</div>
            <div className="info">
              <div className="name">{s.full_name}</div>
              <div className="chips">
                {ptChip("PT1", rec.pt_1)}
                {ptChip("PT2", rec.pt_2)}
                {ptChip("QE", rec.qe)}
                {ptChip("AT", rec.at)}
              </div>
            </div>
          </div>
        );
      });
    }

    if (type === "missing") {
      const fields: { key: string; label: string }[] = [];
      for (let i = 1; i <= 25; i++) fields.push({ key: "module_" + i, label: "M" + i });
      for (let i = 1; i <= 10; i++) fields.push({ key: "activity_" + i, label: "A" + i });
      fields.push(
        { key: "at", label: "AT" },
        { key: "pt_1", label: "PT1" },
        { key: "pt_2", label: "PT2" },
        { key: "qe", label: "QE" }
      );
      const recOf = (s: any) => mergeStudentRecord(records, s.id) || {};
      const activeFields = fields.filter((f) => students.some((s) => filled(recOf(s)[f.key])));
      const rows = students
        .map((s) => {
          const rec = recOf(s);
          const missing = activeFields.filter((f) => !filled(rec[f.key]));
          return { student: s, missing };
        })
        .filter((r) => r.missing.length > 0)
        .sort((a, b) => b.missing.length - a.missing.length);

      if (!activeFields.length) return <div className="drawer-empty">No scores entered yet.</div>;
      if (!rows.length)
        return <div className="drawer-empty">All students are complete — no missing scores. 🎉</div>;
      return rows.map((r) => {
        const labs = r.missing.map((f) => f.label);
        const shown =
          labs.length > 8 ? labs.slice(0, 8).join(", ") + " +" + (labs.length - 8) : labs.join(", ");
        return (
          <div className="drawer-row" key={r.student.id}>
            <div className="avatar">{initials(r.student.full_name)}</div>
            <div className="info">
              <div className="name">{r.student.full_name}</div>
              <div className="sub">Missing: {shown}</div>
            </div>
            <span className="badge badge-absent">{r.missing.length}</span>
          </div>
        );
      });
    }

    return null;
  }

  const openDrawer = (type: string) => {
    setDrawer({ open: true, type });
    document.body.style.overflow = "hidden";
  };
  const closeDrawer = () => {
    setDrawer((d) => ({ ...d, open: false }));
    document.body.style.overflow = "";
  };

  const statNum = (v: number | string) =>
    ready ? v : <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: "1rem" }} />;

  return (
    <div className="dashboard-page">
      <div className="dashboard-header fade-in-up">
        <div className="header-content">
          <p className="date">{currentDate || "Loading Date..."}</p>
          <h1 style={{ whiteSpace: "pre-line" }}>
            {greeting} <span className="hand-emoji">{noSection ? "📭" : "👋"}</span>
          </h1>
          <div className="tag-row">
            <span className="tag tag-primary">{sectionTag || "Section"}</span>
            <span className="tag tag-secondary">
              {subjectTag || <i className="fa-solid fa-spinner fa-spin" />}
            </span>
          </div>
        </div>
        <div className="profile-avatar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatar} alt="Profile Picture" />
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card blue fade-in-up delay-1" onClick={() => openDrawer("students")}>
          <h2>{statNum(statsError ? "!" : totalStudents)}</h2>
          <p className="stat-label">My Students</p>
          <p className="stat-sub">{sectionTag || "Section"}</p>
        </div>
        <div className="stat-card green fade-in-up delay-1" onClick={() => openDrawer("attendance")}>
          <h2>{statNum(statsError ? "!" : present)}</h2>
          <p className="stat-label">Present Today</p>
          <p className="absent" style={{ color: absentLate > 0 ? "#dc2626" : "#16a34a" }}>
            {statsError ? "Error" : `${absentLate} absent/late`}
          </p>
        </div>
        <div className="stat-card yellow fade-in-up delay-2" onClick={() => openDrawer("modules")}>
          <h2>{statNum(statsError ? "!" : modulesDone)}</h2>
          <p className="stat-label">Modules Done</p>
          <p className="pending">
            {pendingModules > 0 ? `${pendingModules} pending` : modulesDone > 0 ? "All done" : "0 pending"}
          </p>
        </div>
        <div className="stat-card purple fade-in-up delay-2" onClick={() => openDrawer("activities")}>
          <h2>{statNum(statsError ? "!" : activitiesDone)}</h2>
          <p className="stat-label">Activities</p>
          <p className="done">
            {pendingActivities > 0
              ? `${pendingActivities} pending`
              : activitiesDone > 0
              ? "All done"
              : "Waiting"}
          </p>
        </div>
      </div>

      <div className="section-title fade-in-up delay-3">Section Overview</div>
      <div className="overview-panel fade-in-up delay-3">
        <div className="overview-item">
          <h3>{semester}</h3>
          <p>Semester</p>
        </div>
        <div className="overview-item">
          <h3>{quarter}</h3>
          <p>Quarter</p>
        </div>
        <div className="overview-item">
          <h3>{totalStudents}</h3>
          <p>Students</p>
        </div>
      </div>

      <div className="section-title fade-in-up delay-4">Quick Actions</div>
      <div className="actions-grid">
        <div className="action-card fade-in-up delay-4" onClick={() => openDrawer("missing")}>
          <div className="action-icon" style={{ color: "#ef4444", background: "#fef2f2" }}>
            <i className="fa-solid fa-triangle-exclamation" />
          </div>
          <div className="action-text">
            <h4>Missing</h4>
            <p>Incomplete scores</p>
          </div>
        </div>
        <div className="action-card fade-in-up delay-4" onClick={() => openDrawer("modules")}>
          <div className="action-icon" style={{ color: "#eab308", background: "#fefce8" }}>
            <i className="fa-solid fa-book-open" />
          </div>
          <div className="action-text">
            <h4>Modules</h4>
            <p>Submitted today</p>
          </div>
        </div>
        <div className="action-card fade-in-up delay-4" onClick={() => openDrawer("activities")}>
          <div className="action-icon" style={{ color: "#a855f7", background: "#faf5ff" }}>
            <i className="fa-solid fa-pencil" />
          </div>
          <div className="action-text">
            <h4>Activities</h4>
            <p>Submitted today</p>
          </div>
        </div>
        <div className="action-card fade-in-up delay-4" onClick={() => openDrawer("exams")}>
          <div className="action-icon" style={{ color: "#ec4899", background: "#fdf2f8" }}>
            <i className="fa-solid fa-award" />
          </div>
          <div className="action-text">
            <h4>PT &amp; Exam</h4>
            <p>Performance tasks</p>
          </div>
        </div>
      </div>

      <div className="section-title fade-in-up delay-4">Top Students</div>
      <div className="performance-panel fade-in-up delay-4">
        <div className="perf-stats perf-stats-two">
          <div className="perf-stat">
            <span className="perf-val">{performance.highest}</span>
            <span className="perf-label">Highest</span>
          </div>
          <div className="perf-stat">
            <span className="perf-val perf-val-low">{performance.lowest}</span>
            <span className="perf-label">Lowest</span>
          </div>
        </div>
        <div className="perf-top">
          {!ready ? (
            <div className="perf-empty">
              <i className="fa-solid fa-spinner fa-spin" /> Loading ranking...
            </div>
          ) : statsError ? (
            <div className="perf-empty">Could not load ranking. Please refresh.</div>
          ) : !performance.ranked.length ? (
            <div className="perf-empty">No students yet.</div>
          ) : performance.ranked.every((t) => t.grade === 0) ? (
            <div className="perf-empty">Scores will appear once they&apos;re entered.</div>
          ) : (
            performance.ranked.map((t, i) => {
              const cls = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
              return (
                <div className="perf-row" key={t.student.id}>
                  <div className={`perf-rank ${cls}`}>{i + 1}</div>
                  <div className="perf-name">{t.student.full_name || "Unknown"}</div>
                  <div className="perf-grade">{t.grade}</div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className={`drawer-backdrop${drawer.open ? " show" : ""}`} onClick={closeDrawer} />
      <div className={`drawer${drawer.open ? " show" : ""}`}>
        <div className="drawer-handle" />
        <div className="drawer-header">
          <h3>{drawerTitle}</h3>
          <button className="drawer-close" onClick={closeDrawer} aria-label="Close">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="drawer-body">{drawer.open && renderDrawerBody()}</div>
      </div>

      <BottomNav active="home" />
      {alert}
    </div>
  );
}
