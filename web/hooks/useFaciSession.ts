"use client";
// ── useFaciSession — port of faci-session.js ────────────────────────────────
// Opens a facilitator_logs row on entry, heartbeats a time_out + keep-alive
// every 30s, re-verifies the account each heartbeat / on tab focus (logging out
// if the teacher deleted it, re-syncing section/subject if reassigned), and
// stamps out on hide/unload.

import { useEffect } from "react";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";
import { API_BASE } from "@/lib/config";
import { clearSession, getItem, getToken, isLoggedIn, setItem } from "@/lib/session";

const HEARTBEAT_MS = 30000;
const LOG_ID_KEY = "faci_log_id";

// Best-effort "Inactive" presence write on unload — uses fetch keepalive so it
// survives the page going away (the teacher panel reads this online/offline
// status). Mirrors the legacy pagehide → status:'Inactive' update.
function beaconInactive() {
  try {
    const token = getToken();
    if (!token) return;
    fetch(`${API_BASE}/api/faci/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "Inactive" }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export function useFaciSession() {
  useEffect(() => {
    if (!isLoggedIn()) return;

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let accountChecking = false;

    const forceLogout = () => {
      clearSession();
      try {
        sessionStorage.removeItem(LOG_ID_KEY);
      } catch {}
      if (heartbeat) clearInterval(heartbeat);
      window.location.replace("/login");
    };

    async function verifyAccount(allowReload: boolean) {
      if (accountChecking || !isLoggedIn()) return;
      accountChecking = true;
      try {
        const me = await apiGet("/api/faci/me");
        let changed = false;
        if (me.section && me.section !== getItem("faci_section")) {
          setItem("faci_section", me.section);
          changed = true;
        }
        if (me.subject && me.subject !== getItem("faci_subject")) {
          setItem("faci_subject", me.subject);
          changed = true;
        }
        if (changed && allowReload) window.location.reload();
      } catch (e) {
        // 404 → account deleted → hard logout. 401 already redirects in api().
        // Network / other errors: stay logged in with cached assignment.
        if (e instanceof ApiError && e.status === 404) forceLogout();
      } finally {
        accountChecking = false;
      }
    }

    async function openSession() {
      try {
        const r = await apiPost<{ id: number }>("/api/faci/session");
        if (r && r.id) sessionStorage.setItem(LOG_ID_KEY, String(r.id));
      } catch {}
    }

    async function stampOut() {
      let id: string | null = null;
      try {
        id = sessionStorage.getItem(LOG_ID_KEY);
      } catch {}
      if (!id) return;
      try {
        await apiPatch(`/api/faci/session/${id}`);
      } catch {}
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        stampOut();
        apiPost("/api/faci/heartbeat").catch(() => {}); // status → Active
        verifyAccount(true);
      } else {
        stampOut();
        apiPatch("/api/faci/me", { status: "Inactive" }).catch(() => {});
      }
    };

    const onPageHide = () => {
      stampOut();
      beaconInactive();
    };

    (async () => {
      await verifyAccount(true);
      if (cancelled || !isLoggedIn()) return;
      await openSession();
      apiPost("/api/faci/heartbeat").catch(() => {});
      heartbeat = setInterval(() => {
        stampOut();
        apiPost("/api/faci/heartbeat").catch(() => {});
        verifyAccount(false);
      }, HEARTBEAT_MS);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onPageHide);
    })();

    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    };
  }, []);
}
