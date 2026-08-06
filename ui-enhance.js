/* ui-enhance.js — shared UX layer for the static faci-panel pages.
 *   1. Dark mode toggle (persisted per-device, injected before first paint)
 *   2. Offline / pending-sync badge (uses window.__offlineSync when present)
 *   3. Pull-to-refresh on touch devices (window.MJR_pullRefresh override)
 *   4. Skeleton loaders ([data-skeleton-rows], [data-skeleton-blocks], [data-skeleton-bar])
 * Must run BEFORE first paint to set the theme without a flash, so it is
 * loaded in <head> without defer. */
(function () {
  "use strict";

  if (window.__uiEnhanceLoaded) return;
  window.__uiEnhanceLoaded = true;

  var THEME_KEY = "faci_theme";
  var theme = null;
  try { theme = localStorage.getItem(THEME_KEY); } catch (e) { theme = null; }
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");

  var CSS = [
    /* ── Dark theme (slate palette) ────────────────────────────────────── */
    "html[data-theme=dark]{color-scheme:dark;}",
    "html[data-theme=dark] body{background:#0f172a;color:#e2e8f0;}",
    "html[data-theme=dark] :root{--panel-bg:#1e293b;--text-main:#f1f5f9;--text-sub:#94a3b8;--premium-shadow:0 10px 15px -3px rgba(0,0,0,.4),0 4px 6px -2px rgba(0,0,0,.3);--hover-shadow:0 12px 22px -8px rgba(0,0,0,.5);}",
    "html[data-theme=dark] .info-card,html[data-theme=dark] .overview-panel,html[data-theme=dark] .performance-panel,html[data-theme=dark] .stat-card,html[data-theme=dark] .mini-card,html[data-theme=dark] .qs-bar,html[data-theme=dark] .search-bar,html[data-theme=dark] .table-scroll-container,html[data-theme=dark] .action-card,html[data-theme=dark] .student-card,html[data-theme=dark] .student-item,html[data-theme=dark] .info-box,html[data-theme=dark] .profile-avatar-container,html[data-theme=dark] .subject-select,html[data-theme=dark] .date-input,html[data-theme=dark] .quick-bar,html[data-theme=dark] .roll-mode,html[data-theme=dark] .opt-btn,html[data-theme=dark] .mark-all,html[data-theme=dark] .badge-container,html[data-theme=dark] .gb-card,html[data-theme=dark] .perf-row{background:#1e293b;border-color:#334155;}",
    "html[data-theme=dark] .search-bar input,html[data-theme=dark] .date-input input,html[data-theme=dark] .score-input{color:#e2e8f0;background:#0f172a;border-color:#334155;}",
    "html[data-theme=dark] .score-input:focus{background:#172238;border-color:var(--accent-blue);}",
    "html[data-theme=dark] .score-input:disabled{background-color:#1a2537;color:#64748b;border-color:#334155;}",
    "html[data-theme=dark] table th{background:#1a2537;color:#94a3b8;border-color:#334155;}",
    "html[data-theme=dark] table td{border-color:#263141;color:#e2e8f0;}",
    "html[data-theme=dark] .sticky-col-1,html[data-theme=dark] .sticky-col-2,html[data-theme=dark] .td-sticky-1,html[data-theme=dark] .td-sticky-2{background:#16203a;}",
    "html[data-theme=dark] thead .sticky-col-1,html[data-theme=dark] thead .sticky-col-2,html[data-theme=dark] tfoot .sticky-col-1,html[data-theme=dark] tfoot .sticky-col-2,html[data-theme=dark] tfoot td{background:#1a2537;}",
    "html[data-theme=dark] .qs-field-select,html[data-theme=dark] .qs-score-select,html[data-theme=dark] .ss-trigger{background:#172238;color:#60a5fa;border-color:#3b82f6;}",
    "html[data-theme=dark] .ss-chevron{color:#60a5fa;}",
    "html[data-theme=dark] .ss-list{background:#1e293b;border-color:#334155;}",
    "html[data-theme=dark] .ss-option{color:#e2e8f0;}",
    "html[data-theme=dark] .ss-option:hover{background:#223250;}",
    "html[data-theme=dark] .ss-option.ss-selected{background:#1e3a5f;color:#93c5fd;}",
    "html[data-theme=dark] .bottom-nav{background:#0f172a;border-top-color:#1e293b;}",
    "html[data-theme=dark] .nav-item{color:#94a3b8;}",
    "html[data-theme=dark] .nav-item.active i,html[data-theme=dark] .nav-item:active i{background:rgba(59,130,246,.25);}",
    "html[data-theme=dark] .confirm-card,html[data-theme=dark] .custom-alert-box,html[data-theme=dark] .drawer,html[data-theme=dark] .paste-card{background:#1e293b;color:#e2e8f0;}",
    "html[data-theme=dark] .confirm-card h3,html[data-theme=dark] .custom-alert-title,html[data-theme=dark] .drawer-header{color:#f1f5f9;}",
    "html[data-theme=dark] .confirm-card p,html[data-theme=dark] .custom-alert-msg,html[data-theme=dark] .drawer-body{color:#94a3b8;}",
    "html[data-theme=dark] .confirm-cancel{background:#273449;color:#cbd5e1;}",
    "html[data-theme=dark] .confirm-cancel:active{background:#334155;}",
    "html[data-theme=dark] .toast-notification,html[data-theme=dark] .quick-input-badge{background:#1e293b;color:#e2e8f0;}",
    "html[data-theme=dark] .draft-indicator{color:#94a3b8;}",
    "html[data-theme=dark] .info-label,html[data-theme=dark] .info-value,html[data-theme=dark] .student-name,html[data-theme=dark] .s-name,html[data-theme=dark] .s-id,html[data-theme=dark] .profile-name,html[data-theme=dark] .profile-role{color:#f1f5f9;}",
    "html[data-theme=dark] .clickable-name{color:#60a5fa;}",
    "html[data-theme=dark] .sk-bar,html[data-theme=dark] .sk-block{background:#263141;}",
    "html[data-theme=dark] .drawer-input-group input{background:#0f172a;color:#e2e8f0;border-color:#334155;}",
    "html[data-theme=dark] .badge-score,html[data-theme=dark] .gb-final{background:#1a2537;}",
    "html[data-theme=dark] .perf-empty,html[data-theme=dark] .drawer-empty,html[data-theme=dark] .gb-empty{color:#94a3b8;}",
    /* ── Theme toggle button ────────────────────────────────────────────── */
    "#uiThemeBtn{position:fixed;top:12px;right:12px;z-index:950;width:42px;height:42px;border-radius:50%;border:1px solid #e2e8f0;background:#fff;color:#334155;font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 14px -4px rgba(15,23,42,.25);-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .18s cubic-bezier(.34,1.56,.64,1);}",
    "#uiThemeBtn:active{transform:scale(.9);}",
    "html[data-theme=dark] #uiThemeBtn{background:#1e293b;border-color:#334155;color:#fbbf24;}",
    /* ── Offline / pending-sync badge ───────────────────────────────────── */
    "#uiStatusBadge{position:fixed;left:50%;bottom:72px;transform:translateX(-50%) translateY(8px);z-index:960;display:none;align-items:center;gap:6px;padding:7px 14px;border-radius:20px;font-size:.72rem;font-weight:800;box-shadow:0 8px 18px -6px rgba(15,23,42,.35);opacity:0;transition:opacity .2s ease,transform .2s cubic-bezier(.34,1.56,.64,1);-webkit-tap-highlight-color:transparent;}",
    "#uiStatusBadge.show{display:flex;opacity:1;transform:translateX(-50%) translateY(0);}",
    "#uiStatusBadge.offline{background:#dc2626;color:#fff;}",
    "#uiStatusBadge.pending{background:#d97706;color:#fff;}",
    /* ── Pull-to-refresh indicator ──────────────────────────────────────── */
    "#uiPull{position:fixed;top:0;left:50%;z-index:970;width:44px;height:44px;border-radius:50%;background:#fff;color:#3b82f6;display:flex;align-items:center;justify-content:center;font-size:1.1rem;box-shadow:0 8px 18px -6px rgba(15,23,42,.3);transform:translate(-50%,-60px);transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s ease;opacity:0;}",
    "#uiPull.spin{animation:uiPullSpin .8s linear infinite;}",
    "@keyframes uiPullSpin{from{transform:translate(-50%,0) rotate(0);}to{transform:translate(-50%,0) rotate(360deg);}}",
    /* ── Skeleton loaders ───────────────────────────────────────────────── */
    ".sk-bar{height:15px;border-radius:6px;background:#e2e8f0;position:relative;overflow:hidden;}",
    ".sk-block{background:#e2e8f0;border-radius:10px;position:relative;overflow:hidden;margin-bottom:10px;}",
    ".sk-bar::after,.sk-block::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:uiShimmer 1.3s infinite;}",
    "@keyframes uiShimmer{100%{transform:translateX(100%);}}",
    ".skeleton-row td{padding:9px 4px;}",
    ".skeleton-row .sk-bar{width:80%;margin:0 auto;}",
    ".skeleton-row td:first-child .sk-bar,.skeleton-row td:nth-child(2) .sk-bar{width:90%;margin-left:6px;}",
    ".sk-inline{display:inline-block;vertical-align:middle;}"
  ].join("\n");

  var styleEl = document.createElement("style");
  styleEl.id = "uiEnhanceStyle";
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  /* ── Theme toggle ────────────────────────────────────────────────────── */
  function setTheme(t) {
    var el = document.documentElement;
    if (t === "dark") {
      el.setAttribute("data-theme", "dark");
      btn.innerHTML = '<i class="fa-solid fa-sun"></i>';
      btn.title = "Switch to light mode";
    } else {
      el.removeAttribute("data-theme");
      btn.innerHTML = '<i class="fa-solid fa-moon"></i>';
      btn.title = "Switch to dark mode";
    }
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }

  var btn = document.createElement("button");
  btn.id = "uiThemeBtn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Toggle dark mode");
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(btn);
    var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    if (cur === "dark") btn.innerHTML = '<i class="fa-solid fa-sun"></i>';
    else btn.innerHTML = '<i class="fa-solid fa-moon"></i>';
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      setTheme(next);
    });
  });

  /* ── Offline / pending-sync badge ────────────────────────────────────── */
  var badge = document.createElement("div");
  badge.id = "uiStatusBadge";
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(badge);
  });

  function renderBadge() {
    var online = navigator.onLine !== false;
    if (!online) {
      badge.className = "offline show";
      badge.innerHTML = '<i class="fa-solid fa-wifi"></i> Offline — changes queued';
      return;
    }
    if (window.__offlineSync && window.__offlineSync.pendingCount) {
      window.__offlineSync.pendingCount().then(function (n) {
        if (n > 0) {
          badge.className = "pending show";
          badge.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> ' + n + ' pending to sync';
        } else {
          badge.className = "";
          badge.innerHTML = "";
        }
      }).catch(function () {});
      return;
    }
    badge.className = "";
    badge.innerHTML = "";
  }

  window.addEventListener("online", renderBadge);
  window.addEventListener("offline", renderBadge);

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
      el.innerHTML = '<span class="sk-bar sk-inline" style="width:' + (el.getAttribute("data-skeleton-bar") || "72px") + '"></span>';
    });
  });

  document.addEventListener("DOMContentLoaded", renderBadge);
})();
