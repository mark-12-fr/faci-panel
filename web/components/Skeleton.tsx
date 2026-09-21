"use client";

import type { CSSProperties } from "react";
import "./Skeleton.css";

/* Skeleton loaders — shimmering placeholders that match the shape of the real
   content (bars, pills, circles, text lines, table rows). Drop one of these in
   wherever a page waits on a network round-trip instead of showing a spinner. */

interface Dims {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

export function SkeletonBar({ width, height, style }: Dims) {
  return (
    <span
      className="sk-bar sk-inline"
      style={{ width: width || "100%", height: height || "15px", ...style }}
    />
  );
}

export function SkeletonBadge({ width, style }: Dims) {
  return (
    <span
      className="sk-badge sk-inline"
      style={{ width: width || "84px", ...style }}
    />
  );
}

export function SkeletonCircle({ size, style }: Dims & { size?: number | string }) {
  return (
    <span
      className="sk-circle sk-inline"
      style={{ width: size || "56px", height: size || "56px", ...style }}
    />
  );
}

export function SkeletonText({
  lines = 2,
  lastWidth = "58%",
  style,
}: {
  lines?: number;
  lastWidth?: string;
  style?: CSSProperties;
}) {
  return (
    <span className="sk-text-wrap" style={style}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="sk-text" style={{ width: i === lines - 1 ? lastWidth : "100%" }} />
      ))}
    </span>
  );
}

export function SkeletonBlock({ height, style }: Dims & { height?: number | string }) {
  return (
    <div
      className="sk-block"
      style={{ height: height || "64px", marginBottom: 10, ...style }}
    />
  );
}

export function SkeletonRows({ rows = 5, cols = 41 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr className="skeleton-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <span
                className="sk-bar"
                style={{ width: c === 1 ? "90%" : c === 0 ? "70%" : "80%", margin: "0 auto" }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ── Page-specific skeleton layouts ──────────────────────────────────────────

export function DashboardSkeleton() {
  return (
    <div className="dashboard-page">
      {/* Header skeleton */}
      <div className="sk-dashboard-header fade-in-up">
        <div style={{ flex: 1 }}>
          <SkeletonBar width="40%" height="10px" style={{ marginBottom: 10 }} />
          <SkeletonBar width="70%" height="22px" style={{ marginBottom: 6 }} />
          <SkeletonBar width="50%" height="22px" style={{ marginBottom: 12 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <SkeletonBadge width="80px" />
            <SkeletonBadge width="70px" />
          </div>
        </div>
        <SkeletonCircle size="55px" />
      </div>

      {/* Stats grid skeleton */}
      <div className="stats-grid" style={{ marginTop: 15 }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="sk-stat-card fade-in-up" style={{ animationDelay: `${i * 0.05}s` }}>
            <SkeletonBar width="45%" height="26px" style={{ marginBottom: 8 }} />
            <SkeletonBar width="70%" height="10px" style={{ marginBottom: 4 }} />
            <SkeletonBar width="50%" height="10px" />
          </div>
        ))}
      </div>

      {/* Section overview skeleton */}
      <div className="sk-section-title fade-in-up" style={{ animationDelay: "0.25s" }} />
      <div className="sk-overview fade-in-up" style={{ animationDelay: "0.3s" }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ textAlign: "center" }}>
            <SkeletonBar width="50%" height="16px" style={{ margin: "0 auto 6px" }} />
            <SkeletonBar width="65%" height="8px" style={{ margin: "0 auto" }} />
          </div>
        ))}
      </div>

      {/* Quick actions skeleton */}
      <div className="sk-section-title fade-in-up" style={{ animationDelay: "0.35s" }} />
      <div className="stats-grid fade-in-up" style={{ animationDelay: "0.4s" }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 15, background: "#fff", borderRadius: 12, boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
            <SkeletonBar width="44px" height="44px" style={{ borderRadius: 10, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <SkeletonBar width="60%" height="12px" style={{ marginBottom: 6 }} />
              <SkeletonBar width="80%" height="8px" />
            </div>
          </div>
        ))}
      </div>

      {/* Top students skeleton */}
      <div className="sk-section-title fade-in-up" style={{ animationDelay: "0.45s" }} />
      <div className="sk-overview fade-in-up" style={{ animationDelay: "0.5s", padding: "18px 20px" }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#f8fafc", borderRadius: 10, marginBottom: 8, border: "1px solid #e2e8f0" }}>
            <SkeletonBar width="26px" height="26px" style={{ borderRadius: "50%", flexShrink: 0 }} />
            <SkeletonBar width="60%" height="12px" style={{ flex: 1 }} />
            <SkeletonBar width="30px" height="14px" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AttendanceSkeleton() {
  return (
    <div className="attendance-page">
      {/* Header */}
      <div className="fade-in-up" style={{ marginBottom: 20 }}>
        <SkeletonBadge width="140px" style={{ marginBottom: 10 }} />
        <SkeletonBar width="55%" height="24px" style={{ marginBottom: 6 }} />
        <SkeletonBar width="80%" height="12px" />
      </div>

      {/* Controls row */}
      <div className="fade-in-up" style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 10, marginBottom: 15, animationDelay: "0.1s" }}>
        <div style={{ padding: 12, borderRadius: 10, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
          <SkeletonBar width="60%" height="14px" />
        </div>
        <div style={{ padding: 12, borderRadius: 10, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
          <SkeletonBar width="70%" height="14px" />
        </div>
      </div>

      {/* Mini stats */}
      <div className="fade-in-up" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 20, animationDelay: "0.15s" }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ padding: "12px 5px", textAlign: "center", borderRadius: 10, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
            <SkeletonBar width="40%" height="18px" style={{ margin: "0 auto 6px" }} />
            <SkeletonBar width="60%" height="8px" style={{ margin: "0 auto" }} />
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="fade-in-up" style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", marginBottom: 20, animationDelay: "0.2s" }}>
        <SkeletonBar width="16px" height="16px" style={{ borderRadius: "50%", flexShrink: 0 }} />
        <SkeletonBar width="70%" height="12px" />
      </div>

      {/* Student cards */}
      {[1, 2, 3].map((i) => (
        <div key={i} className="fade-in-up" style={{ padding: 15, borderRadius: 12, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", marginBottom: 12, animationDelay: `${0.25 + i * 0.05}s` }}>
          <div style={{ marginBottom: 12 }}>
            <SkeletonBar width="70%" height="13px" style={{ marginBottom: 6 }} />
            <SkeletonBar width="40%" height="9px" />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <SkeletonBar width="33%" height="30px" style={{ borderRadius: 20 }} />
            <SkeletonBar width="33%" height="30px" style={{ borderRadius: 20 }} />
            <SkeletonBar width="33%" height="30px" style={{ borderRadius: 20 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecordSkeleton() {
  return (
    <div className="record-page">
      {/* Header */}
      <div className="fade-in-up" style={{ marginBottom: 20 }}>
        <SkeletonBadge width="120px" style={{ marginBottom: 10 }} />
        <SkeletonBar width="50%" height="24px" style={{ marginBottom: 6 }} />
        <SkeletonBar width="70%" height="12px" />
      </div>

      {/* Info card */}
      <div className="fade-in-up" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 15, padding: 15, borderRadius: 12, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", marginBottom: 20, borderTop: "4px solid #3b82f6", animationDelay: "0.1s" }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i}>
            <SkeletonBar width="60%" height="8px" style={{ marginBottom: 6 }} />
            <SkeletonBar width="80%" height="14px" />
          </div>
        ))}
        <div style={{ gridColumn: "1 / -1" }}>
          <SkeletonBar width="50%" height="8px" style={{ marginBottom: 6 }} />
          <SkeletonBadge width="100px" />
        </div>
      </div>

      {/* Upload button */}
      <div className="fade-in-up" style={{ padding: 14, borderRadius: 12, border: "2px dashed #3b82f6", background: "linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%)", marginBottom: 20, animationDelay: "0.15s" }}>
        <SkeletonBar width="60%" height="14px" style={{ margin: "0 auto" }} />
      </div>

      {/* Search */}
      <div className="fade-in-up" style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", marginBottom: 15, animationDelay: "0.2s" }}>
        <SkeletonBar width="16px" height="16px" style={{ borderRadius: "50%", flexShrink: 0 }} />
        <SkeletonBar width="70%" height="12px" />
      </div>

      {/* Table skeleton */}
      <div className="fade-in-up" style={{ borderRadius: 12, background: "#fff", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", overflow: "hidden", border: "1px solid #e2e8f0", animationDelay: "0.25s" }}>
        <div style={{ padding: 12 }}>
          <SkeletonBar width="100%" height="32px" style={{ marginBottom: 4, borderRadius: 4 }} />
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: 4, padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
              <SkeletonBar width="32px" height="12px" />
              <SkeletonBar width="108px" height="12px" />
              {Array.from({ length: 8 }, (_, j) => (
                <SkeletonBar key={j} width="64px" height="28px" style={{ borderRadius: 4 }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="profile-page">
      {/* Header */}
      <div className="fade-in-up" style={{ background: "#fff", padding: "40px 20px 30px", textAlign: "center", borderBottom: "1px solid #e2e8f0", marginBottom: 20 }}>
        <div style={{ width: 100, height: 100, margin: "0 auto 15px", borderRadius: "50%", padding: 4, background: "linear-gradient(135deg, #1e3a8a, #3b82f6)" }}>
          <SkeletonCircle size="92px" />
        </div>
        <SkeletonBar width="55%" height="20px" style={{ margin: "0 auto 8px" }} />
        <SkeletonBar width="40%" height="12px" style={{ margin: "0 auto 15px" }} />
        <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
          <SkeletonBadge width="80px" />
          <SkeletonBadge width="70px" />
        </div>
      </div>

      {/* Info section */}
      <div style={{ padding: "0 15px" }}>
        <div className="sk-section-title fade-in-up" style={{ animationDelay: "0.1s" }} />
        <div className="fade-in-up" style={{ background: "#fff", borderRadius: 12, boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", padding: "5px 20px", marginBottom: 25, animationDelay: "0.15s" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 15, padding: "15px 0", borderBottom: i < 3 ? "1px solid #f1f5f9" : "none" }}>
              <SkeletonBar width="40px" height="40px" style={{ borderRadius: 10, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <SkeletonBar width="35%" height="8px" style={{ marginBottom: 6 }} />
                <SkeletonBar width="60%" height="13px" />
              </div>
            </div>
          ))}
        </div>

        {/* Co-facilitators */}
        <div className="sk-section-title fade-in-up" style={{ animationDelay: "0.2s" }} />
        <div className="fade-in-up" style={{ background: "#fff", borderRadius: 12, boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", padding: "5px 20px", marginBottom: 25, animationDelay: "0.25s" }}>
          {[1, 2].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: i < 2 ? "1px solid #f1f5f9" : "none" }}>
              <SkeletonCircle size="36px" />
              <div>
                <SkeletonBar width="120px" height="12px" style={{ marginBottom: 4 }} />
                <SkeletonBar width="80px" height="8px" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}