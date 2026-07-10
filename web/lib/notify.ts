"use client";
// ── notify.ts — port of mjr-notify.js (toast + web push) ────────────────────
// In-app toast + optional Web Push registration. Push now registers through the
// FastAPI backend (which stores the subscription) instead of Supabase directly.
// Degrades silently when push isn't configured/permitted — same as before.

import { apiGet, apiPost } from "./api";

let permissionRequested = false;

function ensureToastStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("mjrNotifyToastStyles")) return;
  const style = document.createElement("style");
  style.id = "mjrNotifyToastStyles";
  style.textContent = `
    #mjrNotifyToast {
      position: fixed; top: 20px; right: 20px; max-width: 340px;
      background: #1e293b; color: #fff; border-left: 4px solid #3b82f6;
      padding: 14px 18px; border-radius: 12px;
      box-shadow: 0 12px 28px rgba(0,0,0,0.35); z-index: 100000;
      transform: translateY(-20px); opacity: 0;
      transition: opacity 0.25s ease, transform 0.25s ease;
      font-family: 'Inter', system-ui, sans-serif; pointer-events: auto;
    }
    #mjrNotifyToast.show { transform: translateY(0); opacity: 1; }
    #mjrNotifyToast .mjr-notify-title { font-weight: 700; margin-bottom: 4px; font-size: 0.95rem; }
    #mjrNotifyToast .mjr-notify-body  { font-size: 0.85rem; opacity: 0.9; line-height: 1.35; }
    @media (max-width: 640px) { #mjrNotifyToast { left: 16px; right: 16px; max-width: none; } }
  `;
  document.head.appendChild(style);
}

export function notify(opts: { title?: string; body?: string; tag?: string }) {
  const title = (opts && opts.title) || "MJR";
  const body = (opts && opts.body) || "";
  ensureToastStyles();
  let toast = document.getElementById("mjrNotifyToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "mjrNotifyToast";
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<div class="mjr-notify-title"></div><div class="mjr-notify-body"></div>`;
  (toast.querySelector(".mjr-notify-title") as HTMLElement).textContent = title;
  (toast.querySelector(".mjr-notify-body") as HTMLElement).textContent = body;
  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");
  const anyToast = toast as any;
  clearTimeout(anyToast._mjrHideTimer);
  anyToast._mjrHideTimer = setTimeout(() => toast!.classList.remove("show"), 5500);

  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      const n = new Notification(title, {
        body,
        tag: (opts && opts.tag) || "mjr-notif",
        icon: "/logo-192.png",
        badge: "/logo-192.png",
        silent: true,
      });
      setTimeout(() => {
        try {
          n.close();
        } catch {}
      }, 6000);
    } catch {}
  }
}

async function ensurePermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied" || permissionRequested) return false;
  permissionRequested = true;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Register the service worker + push subscription for the logged-in faci. */
export async function setupPush() {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    let key = "";
    try {
      const r = await apiGet<{ key: string }>("/api/faci/push/vapid-public-key");
      key = (r && r.key) || "";
    } catch {
      return;
    }
    if (!key) return; // push not configured on the backend

    const reg = await navigator.serviceWorker.register("/mjr-sw.js");
    await navigator.serviceWorker.ready;
    if (!(await ensurePermission())) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await apiPost("/api/faci/push/subscribe", {
      endpoint: sub.endpoint,
      subscription: JSON.parse(JSON.stringify(sub)),
    });
  } catch (err) {
    console.warn("Push subscription failed:", err);
  }
}

/** Arm notification permission on first user gesture (matches legacy behaviour). */
export function armPermissionOnGesture() {
  const arm = () => {
    ensurePermission();
    document.removeEventListener("click", arm);
    document.removeEventListener("keydown", arm);
    document.removeEventListener("touchstart", arm);
  };
  document.addEventListener("click", arm, { once: true, passive: true });
  document.addEventListener("keydown", arm, { once: true });
  document.addEventListener("touchstart", arm, { once: true, passive: true });
}
