/* ui-enhance.js — shared UX layer for the static faci-panel pages.
 *   1. Pull-to-refresh on touch devices (window.MJR_pullRefresh override)
 *   2. Skeleton loaders ([data-skeleton-rows], [data-skeleton-blocks], [data-skeleton-bar])
 *   3. Zoom lock (pinch + double-tap)
 * Loaded in <head> without defer. */
(function () {
  "use strict";

  if (window.__uiEnhanceLoaded) return;
  window.__uiEnhanceLoaded = true;

  var CSS = [
    /* ── Pull-to-refresh indicator ──────────────────────────────────────── */
    "#uiPull{position:fixed;top:0;left:50%;z-index:970;width:44px;height:44px;border-radius:50%;background:#fff;color:#3b82f6;display:flex;align-items:center;justify-content:center;font-size:1.1rem;box-shadow:0 8px 18px -6px rgba(15,23,42,.3);transform:translate(-50%,-60px);transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s ease;opacity:0;}",
    "#uiPull.spin{animation:uiPullSpin .8s linear infinite;}",
    "@keyframes uiPullSpin{from{transform:translate(-50%,0) rotate(0);}to{transform:translate(-50%,0) rotate(360deg);}}",
    /* ── Skeleton loaders ───────────────────────────────────────────────── */
    ".sk-bar{height:15px;border-radius:6px;background:#e2e8f0;position:relative;overflow:hidden;}",
    ".sk-block{background:#e2e8f0;border-radius:10px;position:relative;overflow:hidden;margin-bottom:10px;}",
    ".sk-badge{height:22px;border-radius:999px;background:#e2e8f0;position:relative;overflow:hidden;}",
    ".sk-circle{width:56px;height:56px;border-radius:50%;background:#e2e8f0;position:relative;overflow:hidden;}",
    ".sk-text{height:12px;border-radius:6px;background:#e2e8f0;position:relative;overflow:hidden;display:block;margin-bottom:7px;}",
    ".sk-avatar{background:linear-gradient(90deg,#e2e8f0 20%,#f1f5f9 50%,#e2e8f0 80%);background-size:200% 100%;animation:uiShimmerBg 1.3s linear infinite;}",
    "@keyframes uiShimmerBg{0%{background-position:200% 0;}100%{background-position:-200% 0;}}",
    ".sk-bar::after,.sk-block::after,.sk-badge::after,.sk-circle::after,.sk-text::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:uiShimmer 1.3s infinite;}",
    "@keyframes uiShimmer{100%{transform:translateX(100%);}}",
    ".skeleton-row td{padding:9px 4px;}",
    ".skeleton-row .sk-bar{width:80%;margin:0 auto;}",
    ".skeleton-row td:first-child .sk-bar,.skeleton-row td:nth-child(2) .sk-bar{width:90%;margin-left:6px;}",
    ".sk-inline{display:inline-block;vertical-align:middle;}",
    "html,body{touch-action:manipulation;}"
  ].join("\n");

  var styleEl = document.createElement("style");
  styleEl.id = "uiEnhanceStyle";
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  /* ── Pull-to-refresh (touch devices only) ────────────────────────────── */
  var pullEl = document.createElement("div");
  pullEl.id = "uiPull";
  pullEl.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(pullEl);
  });

  var TRIGGER = 72;
  var pulling = false;
  var startY = 0;
  var pullY = 0;

  function pullReset() {
    pulling = false;
    pullY = 0;
    pullEl.style.transform = "translate(-50%,-60px)";
    pullEl.style.opacity = "0";
    pullEl.classList.remove("spin");
    pullEl.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
  }

  function ignorePull(target) {
    return !!(target && target.closest && target.closest(
      ".ss-root, .ss-list, .drawer, .drawer-overlay, .confirm-overlay, .custom-alert-overlay, .paste-overlay, .drawer-backdrop"
    ));
  }

  if (window.matchMedia && matchMedia("(pointer: coarse)").matches) {
    window.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1 || ignorePull(e.target)) return;
      if (window.scrollY > 0 || document.documentElement.scrollTop > 0) return;
      pulling = true;
      startY = e.touches[0].clientY;
      pullY = 0;
    }, { passive: true });

    window.addEventListener("touchmove", function (e) {
      if (!pulling) return;
      var dy = e.touches[0].clientY - startY;
      if (dy <= 0) return;
      pullY = Math.min(dy, 110);
      var shift = Math.min(pullY, 64);
      pullEl.style.transform = "translate(-50%,-" + (64 - shift) + "px)";
      pullEl.style.opacity = String(Math.min(pullY / TRIGGER, 1));
      pullEl.querySelector("i").style.transform = "rotate(" + (pullY / TRIGGER) * 180 + "deg)";
      if (pullY >= TRIGGER) pullEl.style.color = "#16a34a";
      else pullEl.style.color = "#3b82f6";
    }, { passive: true });

    window.addEventListener("touchend", function () {
      if (!pulling) return;
      if (pullY >= TRIGGER) {
        pullEl.classList.add("spin");
        pullEl.style.opacity = "1";
        pullEl.style.color = "#3b82f6";
        pullEl.innerHTML = '<i class="fa-solid fa-spinner"></i>';
        pulling = false;
        var done = function () { pullReset(); };
        var p = null;
        if (window.MJR_pullRefresh) {
          try { p = window.MJR_pullRefresh(); } catch (err) { p = null; }
        }
        if (p && typeof p.then === "function") p.then(done).catch(done);
        else { window.location.reload(); }
      } else {
        pullReset();
      }
    }, { passive: true });
  }

  /* ── Skeleton loaders ────────────────────────────────────────────────── */
  function skBar(w) {
    return '<div class="sk-bar" style="width:' + (w || "80%") + '"></div>';
  }

  function skeletonRows(n, cols) {
    var out = "";
    for (var r = 0; r < n; r++) {
      out += '<tr class="skeleton-row">';
      for (var c = 0; c < cols; c++) {
        out += "<td>" + (c === 1 ? skBar("70%") : c === 0 ? skBar("55%") : skBar("70%")) + "</td>";
      }
      out += "</tr>";
    }
    return out;
  }

  function skeletonBlocks(n) {
    var out = "";
    for (var i = 0; i < n; i++) out += '<div class="sk-block" style="height:' + (72 - i * 4) + 'px"></div>';
    return out;
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-skeleton-rows]").forEach(function (el) {
      if (!el.children.length) {
        var n = parseInt(el.getAttribute("data-skeleton-rows"), 10) || 5;
        var cols = parseInt(el.getAttribute("data-skeleton-cols"), 10) || 5;
        el.innerHTML = skeletonRows(n, cols);
      }
    });
    document.querySelectorAll("[data-skeleton-blocks]").forEach(function (el) {
      if (!el.children.length) {
        el.innerHTML = skeletonBlocks(parseInt(el.getAttribute("data-skeleton-blocks"), 10) || 4);
      }
    });
    document.querySelectorAll("[data-skeleton-bar]").forEach(function (el) {
      if (!el.children.length) {
        el.innerHTML = '<span class="sk-bar sk-inline" style="width:' + (el.getAttribute("data-skeleton-bar") || "72px") + '"></span>';
      }
    });
    document.querySelectorAll("[data-skeleton-text]").forEach(function (el) {
      if (!el.children.length) {
        var n = parseInt(el.getAttribute("data-skeleton-text"), 10) || 2;
        var out = "";
        for (var i = 0; i < n; i++) out += '<span class="sk-text" style="width:' + (i === n - 1 ? "58%" : "100%") + '"></span>';
        el.innerHTML = out;
      }
    });
    document.querySelectorAll("[data-skeleton-badge]").forEach(function (el) {
      if (!el.children.length) {
        el.innerHTML = '<span class="sk-badge sk-inline" style="width:' + (el.getAttribute("data-skeleton-badge") || "84px") + '"></span>';
      }
    });
    document.querySelectorAll("[data-skeleton-circle]").forEach(function (el) {
      if (!el.children.length) {
        var d = el.getAttribute("data-skeleton-circle") || "56px";
        el.innerHTML = '<span class="sk-circle sk-inline" style="width:' + d + ';height:' + d + '"></span>';
      }
    });
  });

  /* ── Zoom lock (pinch + double-tap) ──────────────────────────────────── */
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  document.addEventListener("gesturechange", function (e) { e.preventDefault(); });
  document.addEventListener("touchmove", function (e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  /* ── Self-recovery: stuck-loading watchdog + reload on reconnect ─────── */
  // A page that is still showing its loading skeletons after STUCK_MS (a hung
  // request, a script error before the data arrived) used to leave the
  // facilitator staring at grey bars with no way forward. Now it says so and
  // offers a one-tap retry; and when the connection comes back after a failed or
  // stuck load, the page reloads ITSELF once. Reloads are rate-limited (15 s) so
  // a page that keeps failing can never loop, and a page that loaded fine is
  // never reloaded (typed-but-unsubmitted input is safe).
  var STUCK_MS = 15000;
  var RELOAD_KEY = "mjr_auto_reload_at";
  var SKELETON_SEL = ".sk-bar, .sk-block, .sk-text, .sk-badge, .sk-circle, .skeleton-row";
  var recoverBar = null;
  var recoverHideTimer = null;

  function skeletonsVisible() {
    var els = document.querySelectorAll(SKELETON_SEL);
    for (var i = 0; i < els.length; i++) {
      if (els[i].getClientRects().length) return true; // actually on screen, not display:none
    }
    return false;
  }

  function safeReload(force) {
    try {
      var last = +sessionStorage.getItem(RELOAD_KEY) || 0;
      if (!force && Date.now() - last < 15000) return false;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch (e) {}
    window.location.reload();
    return true;
  }

  function showRecoverBar(text, autoHideMs) {
    if (!document.body) return;
    if (!recoverBar) {
      recoverBar = document.createElement("div");
      recoverBar.id = "mjr-recover-bar";
      recoverBar.setAttribute("role", "status");
      recoverBar.style.cssText =
        "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147482999;display:flex;" +
        "align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:9px 10px 9px 16px;border-radius:999px;" +
        "background:#0f172a;color:#fff;font-family:inherit;font-size:13px;font-weight:600;line-height:1.3;" +
        "box-shadow:0 10px 30px rgba(15,23,42,.25);border:1px solid rgba(251,191,36,.55)";
      var msg = document.createElement("span");
      msg.id = "mjr-recover-text";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Retry";
      btn.style.cssText =
        "border:none;border-radius:999px;padding:6px 14px;background:#fbbf24;color:#111827;" +
        "font-family:inherit;font-size:12px;font-weight:700;cursor:pointer";
      btn.addEventListener("click", function () { safeReload(true); });
      recoverBar.appendChild(msg);
      recoverBar.appendChild(btn);
      document.body.appendChild(recoverBar);
    }
    recoverBar.querySelector("#mjr-recover-text").textContent = text;
    recoverBar.style.display = "flex";
    if (recoverHideTimer) clearTimeout(recoverHideTimer);
    if (autoHideMs) recoverHideTimer = setTimeout(hideRecoverBar, autoHideMs);
  }

  function hideRecoverBar() {
    if (recoverBar) recoverBar.style.display = "none";
  }

  // Pages call this from their "failed to load" catch block.
  window.MJR_markLoadFailed = function () {
    window.__mjrLoadFailedAt = Date.now();
    showRecoverBar(
      navigator.onLine === false ? "You're offline — this page will reload when you're back." : "Couldn't load your data.",
      12000
    );
  };

  function watchdog() {
    if (navigator.onLine === false || !skeletonsVisible()) return;
    window.__mjrStuckAt = Date.now();
    showRecoverBar("Taking longer than usual…");
    // Keep watching and drop the notice the moment the data does arrive.
    var iv = setInterval(function () {
      if (!skeletonsVisible()) {
        clearInterval(iv);
        window.__mjrStuckAt = 0;
        hideRecoverBar();
      }
    }, 1000);
  }
  document.addEventListener("DOMContentLoaded", function () { setTimeout(watchdog, STUCK_MS); });

  window.addEventListener("online", function () {
    var failedRecently = window.__mjrLoadFailedAt && Date.now() - window.__mjrLoadFailedAt < 120000;
    if (failedRecently || window.__mjrStuckAt || skeletonsVisible()) safeReload(false);
  });
})();
