"use client";
// ── Guard — port of mjr-guard.js ────────────────────────────────────────────
// Blocks the context menu + DevTools shortcuts and masks the URL with a
// daily-rotating hash token (skipped on the login route and OAuth callbacks).
// Renders nothing. The legacy ".html link stripping" is unnecessary here since
// Next.js routes are already clean.

import { useEffect } from "react";

export default function Guard() {
  useEffect(() => {
    const block = (e: Event) => {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const key = (e.key || "").toLowerCase();
      if (e.keyCode === 123 || key === "f12") return block(e);
      if ((e.ctrlKey || e.metaKey) && key === "u") return block(e);
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (key === "i" || key === "j" || key === "c")) {
        return block(e);
      }
      if ((e.ctrlKey || e.metaKey) && key === "s") return block(e);
    };

    document.addEventListener("contextmenu", block, { capture: true });
    document.addEventListener("keydown", onKeyDown, { capture: true });

    const computeToken = () => {
      const seed =
        new Date().toISOString().slice(0, 10) + "|" + (window.location.pathname || "").toLowerCase();
      let h = 2166136261;
      for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const a = (h >>> 0).toString(36);
      const b = ((h ^ 0xdeadbeef) >>> 0).toString(36);
      return (a + b).slice(0, 12);
    };

    const maskUrl = () => {
      try {
        const path = (window.location.pathname || "").toLowerCase();
        if (/\/(login|sign)$/i.test(path) || path === "/login") return;
        const hash = window.location.hash || "";
        if (hash.indexOf("access_token") !== -1) return;
        const token = computeToken();
        if (hash === "#" + token) return;
        window.history.replaceState(
          {},
          "",
          window.location.pathname + window.location.search + "#" + token
        );
      } catch {}
    };

    maskUrl();

    return () => {
      document.removeEventListener("contextmenu", block, { capture: true } as any);
      document.removeEventListener("keydown", onKeyDown, { capture: true } as any);
    };
  }, []);

  return null;
}
