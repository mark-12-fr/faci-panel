"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPatch } from "@/lib/api";
import { clearSession, getItem, isLoggedIn, setItem } from "@/lib/session";
import { API_BASE } from "@/lib/config";
import { getToken } from "@/lib/session";
import { useFaciSession } from "@/hooks/useFaciSession";
import { setupPush, armPermissionOnGesture } from "@/lib/notify";
import BottomNav from "@/components/BottomNav";
import "./profile.css";

interface CoFaci {
  full_name: string;
  avatar_url?: string | null;
}

export default function ProfilePage() {
  useFaciSession();

  const [name, setName] = useState("Loading...");
  const [avatar, setAvatar] = useState("");
  const [section, setSection] = useState("...");
  const [subject, setSubject] = useState("...");
  const [subjectBadge, setSubjectBadge] = useState("...");
  const [coFacis, setCoFacis] = useState<CoFaci[] | null>(null);
  const [coError, setCoError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      window.location.href = "/login";
      return;
    }
    armPermissionOnGesture();
    setupPush();

    const sec = getItem("faci_section") || "";
    const subj = getItem("faci_subject") || "Subject";
    let fullName = getItem("faci_name") || "Loading...";
    setSection(sec);
    setSubject(subj);
    setSubjectBadge(subj.substring(0, 10));
    setName(fullName);

    (async () => {
      try {
        const me = await apiGet("/api/faci/me");
        if (me) {
          fullName = me.full_name || fullName;
          setName(fullName);
          setItem("faci_name", fullName);
          if (me.teacher_id) setItem("faci_teacher_id", String(me.teacher_id));
          setAvatar(
            me.avatar_url && String(me.avatar_url).trim() !== ""
              ? me.avatar_url
              : `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=1e3a8a&color=fff&size=150&bold=true`
          );
        }
      } catch {
        setAvatar(
          `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=1e3a8a&color=fff&size=150&bold=true`
        );
      }

      try {
        const resp = await apiGet("/api/faci/co-facilitators");
        const list: CoFaci[] = (resp.co_facilitators || []).filter(
          (f: CoFaci) => f.full_name !== fullName
        );
        setCoFacis(list);
      } catch {
        setCoError(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onAvatarClick() {
    fileRef.current?.click();
  }

  function uploadAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement("canvas");
        const MAX = 150;
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > MAX) {
            height *= MAX / width;
            width = MAX;
          }
        } else {
          if (height > MAX) {
            width *= MAX / height;
            height = MAX;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL("image/jpeg", 0.7);
        try {
          await apiPatch("/api/faci/me", { avatar_url: compressed });
          setAvatar(compressed);
          setItem("faci_img_url", compressed);
          window.alert("Profile picture updated successfully!");
        } catch {
          window.alert("Failed to update profile picture. Please check your connection.");
        } finally {
          setUploading(false);
        }
      };
      img.onerror = () => {
        setUploading(false);
        window.alert("That image couldn't be loaded. Please try a different file.");
      };
      img.src = ev.target?.result as string;
    };
    reader.onerror = () => {
      setUploading(false);
      window.alert("Couldn't read that image file. Please try again.");
    };
    reader.readAsDataURL(file);
  }

  async function faciLogout() {
    if (!window.confirm("Are you sure you want to sign out?")) return;
    // Best-effort presence → Inactive before clearing (keepalive-safe).
    try {
      const token = getToken();
      if (token) {
        await fetch(`${API_BASE}/api/faci/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: "Inactive" }),
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
    clearSession();
    window.location.href = "/login";
  }

  return (
    <div className="profile-page">
      <div className="profile-header fade-in-up">
        <div
          className="profile-avatar-container"
          onClick={onAvatarClick}
          title="Click to change profile picture"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={avatar}
            id="faciAvatar"
            className="profile-avatar"
            alt="Avatar"
            style={{ opacity: uploading ? 0.5 : 1 }}
          />
          <div className="profile-overlay">
            <i className="fa-solid fa-camera" style={{ marginBottom: 3 }} /> Change
          </div>
          <input
            ref={fileRef}
            type="file"
            style={{ display: "none" }}
            accept="image/png, image/jpeg"
            onChange={uploadAvatar}
          />
        </div>
        <h2 className="profile-name">{name}</h2>
        <p className="profile-role">Student Facilitator</p>
        <div className="badge-container">
          <span className="badge badge-blue">{section}</span>
          <span className="badge badge-purple">{subjectBadge}</span>
        </div>
      </div>

      <div className="content-container">
        <h3 className="section-title fade-in-up delay-1">My Information</h3>
        <div className="info-card fade-in-up delay-1">
          <div className="info-row">
            <div className="icon-box bg-blue-light">
              <i className="fa-solid fa-graduation-cap" />
            </div>
            <div className="info-text">
              <p className="info-label">Role</p>
              <p className="info-value">Student Facilitator</p>
            </div>
          </div>
          <div className="info-row">
            <div className="icon-box bg-blue-light">
              <i className="fa-solid fa-thumbtack" />
            </div>
            <div className="info-text">
              <p className="info-label">Assigned Section</p>
              <p className="info-value">{section}</p>
            </div>
          </div>
          <div className="info-row">
            <div className="icon-box bg-blue-light">
              <i className="fa-solid fa-book" />
            </div>
            <div className="info-text">
              <p className="info-label">Subject</p>
              <p className="info-value">{subject}</p>
            </div>
          </div>
        </div>

        <h3 className="section-title fade-in-up delay-2">Co-Facilitators</h3>
        <div className="info-card fade-in-up delay-2">
          {coError ? (
            <div style={{ textAlign: "center", padding: 15, color: "#ef4444", fontSize: "0.8rem" }}>
              Failed to load co-facilitators.
            </div>
          ) : coFacis === null ? (
            <div style={{ textAlign: "center", padding: 15, color: "var(--text-sub)", fontSize: "0.8rem" }}>
              <i className="fa-solid fa-spinner fa-spin" /> Loading partners...
            </div>
          ) : coFacis.length === 0 ? (
            <div
              style={{ textAlign: "center", padding: "20px 10px", color: "var(--text-sub)", fontSize: "0.85rem" }}
            >
              <i
                className="fa-solid fa-user-shield"
                style={{ fontSize: "1.5rem", marginBottom: 8, display: "block", opacity: 0.5 }}
              />
              You are the only facilitator assigned to this section.
            </div>
          ) : (
            coFacis.map((f, i) => {
              const av =
                f.avatar_url ||
                `https://ui-avatars.com/api/?name=${encodeURIComponent(f.full_name)}&background=e2e8f0&color=475569`;
              return (
                <div className="co-faci-row" key={i}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={av} className="co-faci-avatar" alt="Avatar" />
                  <div>
                    <p className="co-faci-name">{f.full_name}</p>
                    <span className="co-faci-role-text">Co-Facilitator</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <button className="logout-btn fade-in-up delay-3" onClick={faciLogout}>
          <i className="fa-solid fa-arrow-right-from-bracket" /> Log out
        </button>
      </div>

      <BottomNav active="profile" />
    </div>
  );
}
