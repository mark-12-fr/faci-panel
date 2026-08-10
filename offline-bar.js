/*
 * offline-bar.js — one smooth offline/sync indicator for EVERY page.
 * ===================================================================
 * Replaces the three hand-rolled, inconsistent bars (login.html /
 * attendance.html / record.html) with a single floating pill that:
 *
 *   1. Renders FOUR states, each with its own icon, colours and motion:
 *        - offline, nothing queued   → "You're offline — changes will sync later"
 *        - offline, N queued         → "N change(s) saved — will sync when back"
 *        - online, N queued          → spinner + "Syncing N change(s)…"
 *        - queue just emptied online → green "All changes synced" toast, auto-hide
 *   2. Animates in/out smoothly (slide + fade on the app's own
 *      cubic-bezier(0.16,1,0.3,1) curve) — never a hard show/hide.
 *   3. Never flickers: re-renders only when the STATE actually changes
 *      (force-renrenders when the queue count changes within a state).
 *   4. Is fully self-contained: injects its own <style> and inline SVG
 *      icons, so it works on pages that use Font Awesome AND pages that
 *      use lucide (index.html) — and offline, with zero dependencies.
 *   5. Can be dismissed with a tap (it re-appears on the next state change).
 *   6. Respects prefers-reduced-motion.
 *
 * It plugs into the existing pieces:
 *   - window.__offlineSync (offlineSyncUtility.js) → queue counts + flush
 *   - window "online"/"offline" events → connectivity
 * On pages without __offlineSync (index/profile) it simply reflects
 * connectivity — read-only pages have nothing to queue anyway.
 */
(function () {
    if (document.getElementById('mjr-offline-bar')) return;

    var STYLE_ID = 'mjr-offline-bar-style';
    var HIDE_AFTER_MS = 2600;   // how long the "synced" toast stays
    var ANIM_MS = 320;          // must match the CSS transition duration

    // ── injected CSS (no external fonts/icons needed) ──────────────────────
    if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '#mjr-offline-bar{position:fixed;top:12px;left:50%;z-index:2147483000;' +
            'transform:translate(-50%,0);pointer-events:none;' +
            'transition:transform ' + ANIM_MS + 'ms cubic-bezier(0.16,1,0.3,1),opacity ' + ANIM_MS + 'ms ease;' +
            'will-change:transform,opacity}' +
            '#mjr-offline-bar.mjr-ob-hidden{transform:translate(-50%,-18px);opacity:0}' +
            '#mjr-offline-bar.mjr-ob-show{transform:translate(-50%,0);opacity:1;pointer-events:auto}' +
            '.mjr-ob-inner{display:flex;align-items:center;gap:10px;padding:8px 16px 8px 8px;' +
            'border-radius:999px;font-family:inherit;font-size:13px;font-weight:600;line-height:1.25;' +
            'box-shadow:0 10px 30px rgba(15,23,42,.16),0 2px 8px rgba(15,23,42,.08);' +
            'border:1px solid;cursor:pointer;user-select:none;-webkit-user-select:none;' +
            'max-width:calc(100vw - 32px);' +
            'transition:background-color .25s ease,border-color .25s ease,color .25s ease}' +
            '.mjr-ob-icon{flex:0 0 auto;position:relative;display:flex;align-items:center;justify-content:center;' +
            'width:28px;height:28px;border-radius:50%;color:#fff}' +
            '.mjr-ob-icon svg{width:15px;height:15px;display:block}' +
            '.mjr-ob-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.mjr-ob-spinner{width:15px;height:15px;border-radius:50%;' +
            'border:2px solid rgba(255,255,255,.35);border-top-color:#fff;' +
            'animation:mjr-ob-spin .8s linear infinite}' +
            '@keyframes mjr-ob-spin{to{transform:rotate(360deg)}}' +
            '@keyframes mjr-ob-ping{0%{transform:scale(1);opacity:.55}80%{transform:scale(1.9);opacity:0}' +
            '100%{transform:scale(1.9);opacity:0}}' +
            '@keyframes mjr-ob-pop{0%{transform:scale(.5);opacity:0}60%{transform:scale(1.15)}' +
            '100%{transform:scale(1);opacity:1}}' +
            '.mjr-ob-ping{position:absolute;inset:0;border-radius:50%;' +
            'animation:mjr-ob-ping 1.6s cubic-bezier(0,0,.2,1) infinite}' +
            '.mjr-ob-icon.pop svg{animation:mjr-ob-pop .35s cubic-bezier(0.16,1,0.3,1)}' +
            /* state colours */
            '#mjr-offline-bar.mjr-ob-mode-offline .mjr-ob-inner{background:#fffbeb;border-color:#fde68a;color:#92400e}' +
            '#mjr-offline-bar.mjr-ob-mode-offline .mjr-ob-icon{background:#f59e0b}' +
            '#mjr-offline-bar.mjr-ob-mode-offline .mjr-ob-icon .mjr-ob-ping{background:#fbbf24}' +
            '#mjr-offline-bar.mjr-ob-mode-syncing .mjr-ob-inner{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}' +
            '#mjr-offline-bar.mjr-ob-mode-syncing .mjr-ob-icon{background:#3b82f6}' +
            '#mjr-offline-bar.mjr-ob-mode-synced .mjr-ob-inner{background:#f0fdf4;border-color:#bbf7d0;color:#166534}' +
            '#mjr-offline-bar.mjr-ob-mode-synced .mjr-ob-icon{background:#22c55e}' +
            '@media (prefers-reduced-motion:reduce){' +
            '#mjr-offline-bar,.mjr-ob-icon svg,.mjr-ob-spinner,.mjr-ob-ping{' +
            'animation:none!important;transition:none!important}}';
        document.head.appendChild(style);
    }

    // ── inline SVG icons (no Font Awesome / lucide dependency) ─────────────
    var ICONS = {
        wifiSlash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
        spinner: '<span class="mjr-ob-spinner"></span>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    };

    // ── state ──────────────────────────────────────────────────────────────
    var state = { online: navigator.onLine, queued: 0 };
    var prevQueued = 0;
    var lastMode = 'idle';
    var prevDrained = false;
    var shownAs = null;          // last state string we rendered
    var dismissed = false;       // user tapped the pill
    var hideTimer = null;

    function plural(n) { return n === 1 ? 'change' : 'changes'; }

    function currentMode() {
        if (state.online && state.queued === 0) return 'idle';
        if (state.online) return 'syncing';
        return state.queued > 0 ? 'offline-queued' : 'offline';
    }

    // ── DOM ────────────────────────────────────────────────────────────────
    var el = document.createElement('div');
    el.id = 'mjr-offline-bar';
    el.className = 'mjr-ob-hidden';
    el.setAttribute('role', 'status');
    el.innerHTML = '<div class="mjr-ob-inner"><span class="mjr-ob-icon">' +
        ICONS.wifiSlash + '</span><span class="mjr-ob-text"></span></div>';
    document.body.appendChild(el);

    var iconEl = el.querySelector('.mjr-ob-icon');
    var textEl = el.querySelector('.mjr-ob-text');

    function showSyncedToast() {
        iconEl.innerHTML = ICONS.check;
        iconEl.className = 'mjr-ob-icon pop';
        textEl.textContent = 'All changes synced';
        el.className = 'mjr-ob-show mjr-ob-mode-synced';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            el.className = 'mjr-ob-hidden';
        }, HIDE_AFTER_MS);
    }

    function render(force) {
        var mode = currentMode();
        var justDrained = state.online && state.queued === 0
            && (prevQueued > 0 || lastMode === 'syncing' || lastMode === 'offline-queued');
        prevQueued = state.queued;
        lastMode = mode;

        // Queue just emptied while we were watching → brief success toast.
        if (justDrained && !prevDrained) {
            prevDrained = true;
            showSyncedToast();
            return;
        }
        prevDrained = false;

        if (mode === 'idle') {
            dismissed = false;
            el.className = 'mjr-ob-hidden';
            return;
        }
        if (!force && mode === shownAs) return;
        shownAs = mode;
        dismissed = false;

        if (mode === 'syncing') {
            iconEl.innerHTML = ICONS.spinner;
            iconEl.className = 'mjr-ob-icon';
            textEl.textContent = 'Syncing ' + state.queued + ' ' + plural(state.queued) + '\u2026';
            el.className = 'mjr-ob-show mjr-ob-mode-syncing';
        } else {
            iconEl.innerHTML = ICONS.wifiSlash + '<span class="mjr-ob-ping"></span>';
            iconEl.className = 'mjr-ob-icon';
            textEl.textContent = state.queued > 0
                ? state.queued + ' ' + plural(state.queued) + ' saved \u2014 will sync when you\u2019re back online'
                : 'You\u2019re offline \u2014 changes will sync when you\u2019re back';
            el.className = 'mjr-ob-show mjr-ob-mode-offline';
        }
    }

    // ── events ──────────────────────────────────────────────────────────────
    function setQueued(n) {
        var changed = n !== state.queued;
        state.queued = n;
        if (changed) render(true);
    }

    function onConnectivity() {
        var cameBack = state.online !== navigator.onLine && navigator.onLine;
        state.online = navigator.onLine;
        if (cameBack && window.__offlineSync
            && typeof window.__offlineSync.flush === 'function') {
            try { window.__offlineSync.flush(); } catch (e) {}
        }
        render();
    }

    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);

    if (window.__offlineSync) {
        window.__offlineSync.onchange = function (items) {
            setQueued(items ? items.length : 0);
        };
        window.__offlineSync.pendingCount().then(function (c) {
            setQueued(c || 0);
        });
    }

    el.addEventListener('click', function () {
        if (el.className.indexOf('mjr-ob-hidden') !== -1) return;
        dismissed = true;
        el.className = 'mjr-ob-hidden';
    });

    render(true);
})();
