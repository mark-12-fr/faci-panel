"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { API_BASE } from "@/lib/config";
import { getItem, getToken, isLoggedIn } from "@/lib/session";
import { useFaciSession } from "@/hooks/useFaciSession";
import { setupPush, armPermissionOnGesture } from "@/lib/notify";
import { useAlert } from "@/components/CustomAlert";
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
interface ReviewStudent {
  name: string;
  scores: Record<string, number>;
  confidence: number;
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

  // Field picker / source picker
  const [fieldPicker, setFieldPicker] = useState<{ open: boolean; selected: Set<string> }>({
    open: false,
    selected: new Set(),
  });
  const [sourcePicker, setSourcePicker] = useState<{ open: boolean; label: string }>({
    open: false,
    label: "",
  });
  const targetFieldsRef = useRef<string[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  // Analyze overlay
  const [analyze, setAnalyze] = useState<{ open: boolean; pct: number }>({ open: false, pct: 0 });
  const analyzeRef = useRef<{ raf: number | null; start: number; abort: AbortController | null; cancelled: boolean }>({
    raf: null,
    start: 0,
    abort: null,
    cancelled: false,
  });

  // Review modal
  const [review, setReview] = useState<{
    open: boolean;
    thumb: string;
    students: ReviewStudent[];
    unmatched: string[];
    notes: string;
    lowConfCount: number;
  }>({ open: false, thumb: "", students: [], unmatched: [], notes: "", lowConfCount: 0 });
  const [reviewSearch, setReviewSearch] = useState("");
  const reviewListRef = useRef<HTMLDivElement>(null);

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

  async function loadData() {
    setLoadState("loading");
    try {
      const secResp = await apiGet("/api/faci/section");
      const section = secResp.section;
      if (section) {
        setInfoSemester(section.semester || "1st Sem");
        sectionIdRef.current = String(section.id);
        currentQuarterRef.current = section.quarter ? String(section.quarter) : "1";
        setInfoQuarter("Q" + currentQuarterRef.current);
      }
      if (!sectionIdRef.current) {
        setRows([]);
        setLoadState("empty");
        return;
      }
      const [studentsResp, recordsResp] = await Promise.all([
        apiGet("/api/faci/students"),
        apiGet("/api/faci/class-records"),
      ]);
      const students = studentsResp.students || [];
      const records = recordsResp.records || [];
      setInfoTotal(students.length);
      if (!students.length) {
        setRows([]);
        setLoadState("empty");
        return;
      }
      const quarter = currentQuarterRef.current;
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
          const displayVal = hasCurrent ? currentVal : carried !== null ? carried : "";
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
    drawerRef.current?.querySelectorAll<HTMLInputElement>("input[data-field]").forEach((di) => {
      const field = di.getAttribute("data-field")!;
      const target = rowEl.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
      if (target && !target.disabled) {
        target.value = di.value;
        if (di.value !== "") {
          target.style.backgroundColor = "#eff6ff";
          target.style.borderColor = "var(--accent-blue)";
        }
      }
    });
    closeDrawer();
    showToast("Scores applied to table. Don't forget to Submit!");
  }

  // ── Submit ────────────────────────────────────────────────────────────────
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
    try {
      await apiPost("/api/faci/class-records", records);
      setSubmitState("success");
      // Lock the newly-filled inputs, then reload so carry-over recomputes.
      tableRef.current?.querySelectorAll<HTMLInputElement>(".score-input").forEach((input) => {
        if (input.value.trim() !== "") {
          input.disabled = true;
          input.title = "Score submitted. Only the Teacher can edit this.";
          input.style.backgroundColor = "";
          input.style.borderColor = "transparent";
        }
      });
      setTimeout(() => {
        loadData();
        setSubmitState("idle");
      }, 2000);
    } catch (e: any) {
      showAlert("System Error", "Failed to submit records: " + (e?.message || ""), "#ef4444");
      setSubmitState("idle");
    }
  }

  // ── Photo → field picker → source picker ────────────────────────────────
  function triggerRecordPhoto() {
    setFieldPicker({ open: true, selected: new Set() });
  }
  function toggleFieldTile(field: string) {
    setFieldPicker((fp) => {
      const s = new Set(fp.selected);
      if (s.has(field)) s.delete(field);
      else s.add(field);
      return { ...fp, selected: s };
    });
  }
  function confirmFieldSelection() {
    if (fieldPicker.selected.size === 0) return;
    targetFieldsRef.current = REC_FIELDS.filter((f) => fieldPicker.selected.has(f));
    setFieldPicker((fp) => ({ ...fp, open: false }));
    setTimeout(openSourcePicker, 80);
  }
  function chooseAutoDetect() {
    targetFieldsRef.current = [];
    setFieldPicker((fp) => ({ ...fp, open: false }));
    setTimeout(openSourcePicker, 80);
  }
  function targetSummary() {
    const tf = targetFieldsRef.current;
    if (!tf.length) return "Auto-detect fields from column headers";
    return "Target field" + (tf.length === 1 ? "" : "s") + ": " + tf.map(REC_FIELD_LABEL).join(", ");
  }
  function openSourcePicker() {
    setSourcePicker({ open: true, label: targetSummary() });
  }
  function chooseSource(source: "camera" | "gallery") {
    setSourcePicker((sp) => ({ ...sp, open: false }));
    setTimeout(() => {
      (source === "camera" ? cameraInputRef : galleryInputRef).current?.click();
    }, 80);
  }

  // ── Analyze progress ────────────────────────────────────────────────────
  function startAnalyzeProgress() {
    const a = analyzeRef.current;
    a.start = Date.now();
    a.cancelled = false;
    a.abort = new AbortController();
    setAnalyze({ open: true, pct: 0 });
    const tick = () => {
      const elapsed = Date.now() - a.start;
      const pct = Math.min(85, (elapsed / 30000) * 85);
      setAnalyze((s) => ({ ...s, pct }));
      if (pct < 85) a.raf = requestAnimationFrame(tick);
    };
    a.raf = requestAnimationFrame(tick);
  }
  function finishAnalyzeProgress() {
    const a = analyzeRef.current;
    if (a.raf) cancelAnimationFrame(a.raf);
    a.raf = null;
    setAnalyze((s) => ({ ...s, pct: 100 }));
  }
  function resetAnalyzeProgress() {
    const a = analyzeRef.current;
    if (a.raf) cancelAnimationFrame(a.raf);
    a.raf = null;
    a.abort = null;
    setAnalyze({ open: false, pct: 0 });
  }
  function cancelAnalyze() {
    const a = analyzeRef.current;
    a.cancelled = true;
    a.abort?.abort();
    resetAnalyzeProgress();
  }

  async function fileToBase64Jpeg(file: File): Promise<{ base64: string; mimeType: string; thumb: string }> {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("Could not read file."));
      r.readAsDataURL(file);
    });
    const img: HTMLImageElement = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Could not decode the image. Try another photo."));
      im.src = dataUrl;
    });
    const side = 2400;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("Empty image.");
    if (Math.max(w, h) > side) {
      const scale = side / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const outDataUrl = canvas.toDataURL("image/jpeg", 0.92);
    return { base64: outDataUrl.split(",")[1] || "", mimeType: "image/jpeg", thumb: outDataUrl };
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/^image\//i.test(file.type || "")) {
      showAlert("Not an image", "Please pick a photo (JPEG, PNG, or WebP).", "#ef4444");
      return;
    }
    const roster = rows.map((r) => String(r.student.full_name || "").trim()).filter(Boolean);
    if (roster.length === 0) {
      showAlert("No students yet", "Wait for the class list to load first, then try again.", "#f59e0b");
      return;
    }

    startAnalyzeProgress();
    const a = analyzeRef.current;
    try {
      const { base64, mimeType, thumb } = await fileToBase64Jpeg(file);
      if (a.cancelled) return;
      const tf = targetFieldsRef.current;
      const res = await fetch(`${API_BASE}/api/vision-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        signal: a.abort ? a.abort.signal : null,
        body: JSON.stringify({
          type: "record",
          imageBase64: base64,
          mimeType,
          roster,
          targetFields: tf,
          targetField: tf.length === 1 ? tf[0] : "",
        }),
      });
      let payload: any = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (!res.ok) {
        const baseMsg = payload?.error || "Analyze failed (" + res.status + ")";
        const upstream = payload?.upstream ? "\n\nDetail: " + payload.upstream : "";
        throw new Error(baseMsg + upstream);
      }
      finishAnalyzeProgress();
      await new Promise((r) => setTimeout(r, 400));
      openReview(payload, thumb);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      console.error("Record photo analyze error:", err);
      showAlert("Could not analyze photo", String(err?.message || err) || "Please try another photo.", "#ef4444");
    } finally {
      resetAnalyzeProgress();
    }
  }

  // ── Review modal ────────────────────────────────────────────────────────
  function openReview(payload: any, thumb: string) {
    const students: ReviewStudent[] = Array.isArray(payload.students) ? payload.students : [];
    const unmatched: string[] = Array.isArray(payload.unmatched) ? payload.unmatched : [];
    const notes = String(payload.notes || "").trim();
    const LOW = 0.6;
    let lowConfCount = 0;
    students.forEach((st) => {
      const conf = Number(st.confidence) || 0;
      if (conf < LOW) {
        const shown = REC_FIELDS.filter((f) => filled(st.scores?.[f]));
        lowConfCount += shown.length;
      }
    });
    setReviewSearch("");
    setReview({ open: true, thumb, students, unmatched, notes, lowConfCount });
  }
  function closeReview() {
    setReview((r) => ({ ...r, open: false }));
  }
  function jumpToFirstLowConf() {
    const first = reviewListRef.current?.querySelector<HTMLElement>(
      ".rev-student-card.needs-check:not(.rev-hidden)"
    );
    if (!first) return;
    first.scrollIntoView({ behavior: "smooth", block: "center" });
    const orig = first.style.boxShadow;
    first.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.5)";
    setTimeout(() => {
      first.style.boxShadow = orig;
    }, 900);
  }
  function applyReviewedRecord() {
    const rowByName = new Map<string, HTMLElement>();
    tableRef.current?.querySelectorAll<HTMLElement>(".student-data-row").forEach((row) => {
      const nameEl = row.querySelector(".clickable-name");
      if (nameEl) rowByName.set((nameEl.textContent || "").trim(), row);
    });
    let applied = 0;
    let skippedLocked = 0;
    reviewListRef.current?.querySelectorAll<HTMLElement>(".rev-student-card").forEach((card) => {
      const name = card.dataset.name || "";
      const row = rowByName.get(name);
      if (!row) return;
      card.querySelectorAll<HTMLInputElement>(".rev-field input").forEach((inp) => {
        const field = inp.dataset.field!;
        const raw = String(inp.value || "").trim();
        if (!raw) return;
        const n = Number(raw);
        if (!isFinite(n) || n < 0) return;
        const target = row.querySelector<HTMLInputElement>(`input.score-input[data-field="${field}"]`);
        if (!target || target.disabled) {
          skippedLocked++;
          return;
        }
        target.value = String(n);
        applied++;
      });
    });
    closeReview();
    const msg =
      "Applied " +
      applied +
      " score(s)." +
      (skippedLocked ? " Skipped " + skippedLocked + " locked cell(s)." : "") +
      " Please review and press Submit New Scores to save.";
    showAlert("Applied to table", msg, "#22c55e");
  }

  // ── Derived ─────────────────────────────────────────────────────────────
  const totalScores = review.students.reduce((s, st) => s + Object.keys(st.scores || {}).length, 0);
  const searchLower = search.toLowerCase();
  const reviewSearchLower = reviewSearch.trim().toLowerCase();

  const fieldGroups: { title: string; entries: [string, string][] }[] = [
    { title: "Modules", entries: Array.from({ length: 25 }, (_, i) => [`module_${i + 1}`, `M${i + 1}`]) },
    { title: "Activities", entries: Array.from({ length: 10 }, (_, i) => [`activity_${i + 1}`, `A${i + 1}`]) },
    { title: "Other", entries: [["at", "AT"], ["pt_1", "PT 1"], ["pt_2", "PT 2"], ["qe", "QE"]] },
  ];

  return (
    <div className="record-page">
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

      <button type="button" className="upload-record-btn fade-in-up delay-2" onClick={triggerRecordPhoto}>
        <i className="fa-solid fa-camera" />
        Upload Record Photo
      </button>
      <div className="upload-sub-hint fade-in-up delay-2">
        Pick a field, then take (or pick) a photo of that column. AI will read only that column&apos;s scores.
      </div>
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFile} />
      <input ref={galleryInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />

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
              {loadState === "loading" && (
                <tr>
                  <td colSpan={41} style={{ textAlign: "center", padding: 30 }}>
                    <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: "2rem" }} />
                  </td>
                </tr>
              )}
              {loadState === "empty" && (
                <tr>
                  <td colSpan={41} style={{ color: "var(--text-sub)", textAlign: "center", padding: 20 }}>
                    No students assigned yet.
                  </td>
                </tr>
              )}
              {loadState === "error" && (
                <tr>
                  <td colSpan={41} style={{ color: "red", textAlign: "center" }}>
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
                            className="score-input"
                            data-field={c.field}
                            data-carried={c.carried ? "1" : undefined}
                            defaultValue={c.value}
                            disabled={c.disabled}
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

      {/* Field picker */}
      <div
        className={`review-overlay${fieldPicker.open ? " show" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setFieldPicker((fp) => ({ ...fp, open: false }));
        }}
      >
        <div className="review-box">
          <div className="review-handle" />
          <div className="review-head">
            <h3>Which column(s) is this photo for?</h3>
            <button className="review-close" onClick={() => setFieldPicker((fp) => ({ ...fp, open: false }))}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
          <div className="review-body">
            <div style={{ fontSize: "0.82rem", color: "var(--text-sub)", marginBottom: 10 }}>
              Tap one or more columns your photo shows (e.g. Module 1 &amp; 2), then Continue. Selecting the
              exact columns is far more accurate than auto-detect.
            </div>
            <button type="button" className="fp-auto-btn" onClick={chooseAutoDetect}>
              <i className="fa-solid fa-wand-magic-sparkles" /> Auto-detect from column headers
            </button>
            <div className="fp-or">— or pick specific columns —</div>
            <div>
              {fieldGroups.map((g) => (
                <div key={g.title}>
                  <div className="fp-section-title">{g.title}</div>
                  <div className="fp-grid">
                    {g.entries.map(([field, label]) => (
                      <button
                        key={field}
                        type="button"
                        className={`fp-tile${fieldPicker.selected.has(field) ? " selected" : ""}`}
                        onClick={() => toggleFieldTile(field)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="fp-continue-bar">
            <button type="button" className="fp-clear" onClick={() => setFieldPicker((fp) => ({ ...fp, selected: new Set() }))}>
              Clear
            </button>
            <button
              type="button"
              className="fp-continue"
              disabled={fieldPicker.selected.size === 0}
              onClick={confirmFieldSelection}
            >
              {fieldPicker.selected.size === 0 ? "Continue" : `Continue (${fieldPicker.selected.size} selected)`}
            </button>
          </div>
        </div>
      </div>

      {/* Source picker */}
      <div
        className={`review-overlay${sourcePicker.open ? " show" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSourcePicker((sp) => ({ ...sp, open: false }));
        }}
      >
        <div className="review-box">
          <div className="review-handle" />
          <div className="review-head">
            <h3>How do you want to add the photo?</h3>
            <button className="review-close" onClick={() => setSourcePicker((sp) => ({ ...sp, open: false }))}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
          <div className="review-body">
            <div style={{ fontSize: "0.82rem", color: "var(--text-sub)", marginBottom: 12, textAlign: "center" }}>
              {sourcePicker.label}
            </div>
            <div className="source-picker-grid">
              <button type="button" className="source-tile" onClick={() => chooseSource("camera")}>
                <i className="fa-solid fa-camera" />
                <span className="tile-label">Take a Photo</span>
                <span className="tile-sub">Open the camera now</span>
              </button>
              <button type="button" className="source-tile" onClick={() => chooseSource("gallery")}>
                <i className="fa-solid fa-images" />
                <span className="tile-label">From Gallery</span>
                <span className="tile-sub">Pick an existing photo</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Analyze overlay */}
      <div className={`analyze-overlay${analyze.open ? " show" : ""}`}>
        <div className="analyze-box">
          <p>Analyzing, please wait...</p>
          <div className="analyze-track">
            <div className="analyze-track-bar" style={{ width: `${analyze.pct}%` }} />
          </div>
          <span className="analyze-pct">{Math.round(analyze.pct)}%</span>
          <button className="analyze-cancel-btn" onClick={cancelAnalyze}>
            Cancel
          </button>
        </div>
      </div>

      {/* Review modal */}
      <div
        className={`review-overlay${review.open ? " show" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeReview();
        }}
      >
        <div className="review-box">
          <div className="review-handle" />
          <div className="review-head">
            <h3>Review AI results</h3>
            <button className="review-close" onClick={closeReview}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
          <div className="review-body">
            <div className="review-thumb-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {review.thumb && <img src={review.thumb} className="review-thumb" alt="Preview" />}
            </div>
            <div className="rev-summary">
              Detected <strong>{review.students.length}</strong> student
              {review.students.length === 1 ? "" : "s"}, <strong>{totalScores}</strong> score
              {totalScores === 1 ? "" : "s"}.
            </div>
            {review.lowConfCount > 0 && (
              <div className="double-check-banner show">
                <span>⚠️ Please double-check</span>
                <span className="dc-count">{review.lowConfCount}</span>
                <span>score(s) below</span>
                <button type="button" className="dc-jump" onClick={jumpToFirstLowConf}>
                  Jump to first ↓
                </button>
              </div>
            )}
            {(review.notes || review.unmatched.length > 0 || targetFieldsRef.current.length >= 0) && (
              <div className="review-notes" style={{ display: "block" }}>
                {targetFieldsRef.current.length ? (
                  <div style={{ color: "var(--accent-blue)", fontWeight: 800, marginBottom: 4 }}>
                    <i className="fa-solid fa-bullseye" /> Target field
                    {targetFieldsRef.current.length === 1 ? "" : "s"}:{" "}
                    {targetFieldsRef.current.map(REC_FIELD_LABEL).join(", ")}
                  </div>
                ) : (
                  <div style={{ color: "var(--text-sub)", marginBottom: 4 }}>
                    <i className="fa-solid fa-magnifying-glass" /> Auto-detected fields from column headers.
                  </div>
                )}
                {review.notes && (
                  <div>
                    <i className="fa-solid fa-circle-info" /> {review.notes}
                  </div>
                )}
                {review.unmatched.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <strong>Not matched to roster:</strong> {review.unmatched.join(", ")}
                  </div>
                )}
              </div>
            )}
            <div className="rev-search">
              <i className="fa-solid fa-magnifying-glass" />
              <input
                type="text"
                placeholder="Search student name..."
                value={reviewSearch}
                onChange={(e) => setReviewSearch(e.target.value)}
              />
              <span className="rev-count" />
              <button
                type="button"
                className={`clear-btn${reviewSearch ? " show" : ""}`}
                onClick={() => setReviewSearch("")}
              >
                <i className="fa-solid fa-xmark-circle" />
              </button>
            </div>
            <div ref={reviewListRef} id="reviewList">
              {review.students.length === 0 ? (
                <div className="review-empty">
                  No students were confidently recognized. Please try a clearer photo.
                </div>
              ) : (
                review.students.map((st, idx) => {
                  const scores = st.scores && typeof st.scores === "object" ? st.scores : {};
                  const shown = REC_FIELDS.filter((f) => filled(scores[f]));
                  if (shown.length === 0) return null;
                  const conf = Number(st.confidence) || 0;
                  const confPct = Math.round(conf * 100);
                  const cardLowConf = conf < 0.6;
                  const revHidden = reviewSearchLower && !st.name.toLowerCase().includes(reviewSearchLower);
                  return (
                    <div
                      className={`rev-student-card${cardLowConf ? " needs-check" : ""}${revHidden ? " rev-hidden" : ""}`}
                      data-name={st.name}
                      key={`${st.name}-${idx}`}
                    >
                      <div className="rev-student-head">
                        <span className="name">{st.name}</span>
                        <span className={`conf ${cardLowConf ? "low-conf" : ""}`}>AI conf {confPct}%</span>
                      </div>
                      <div className="rev-fields">
                        {shown.map((f) => (
                          <div className={`rev-field${cardLowConf ? " low-conf-field" : ""}`} key={f}>
                            <span className="flabel">{REC_FIELD_LABEL(f)}</span>
                            <input type="number" step="any" min={0} data-field={f} defaultValue={String(scores[f])} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="review-actions">
            <button type="button" className="review-btn cancel" onClick={closeReview}>
              Cancel
            </button>
            <button
              type="button"
              className="review-btn apply"
              disabled={review.students.length === 0}
              onClick={applyReviewedRecord}
            >
              Apply to Table
            </button>
          </div>
        </div>
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
    </div>
  );
}
