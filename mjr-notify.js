/*
 * MJR cross-device notify helper
 *
 * - Asks the user (on their first click/keypress) for permission to send
 *   OS-level Notifications.
 * - Exposes window.MJR_notify({ title, body, tag }) — pops the OS notif
 *   (when granted), always shows an in-app toast as a fallback, and plays
 *   a short WebAudio chime so the user hears it even if the OS sound is
 *   muted.
 * - markLocalSave() / isLikelyOwnChange() helpers let pages suppress
 *   self-triggered realtime echoes (the originating client should not
 *   notify itself).
 *
 * Works on any device where the tab is open or the PWA is running.
 * For true background push (closed tab), Web Push + a service worker
 * push subscription server would be needed — out of scope here.
 */
(function () {
    if (window.MJR_notify) return; // already loaded on this page

    const hasNotificationAPI = (typeof Notification !== 'undefined');
    let permissionGranted = hasNotificationAPI && Notification.permission === 'granted';
    let permissionRequested = false;

    function ensurePermission() {
        if (!hasNotificationAPI) return Promise.resolve(false);
        if (Notification.permission === 'granted') {
            permissionGranted = true;
            return Promise.resolve(true);
        }
        if (Notification.permission === 'denied' || permissionRequested) {
            return Promise.resolve(false);
        }
        permissionRequested = true;
        try {
            return Notification.requestPermission().then(p => {
                permissionGranted = p === 'granted';
                return permissionGranted;
            });
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    // First user gesture unlocks both Notification permission and AudioContext.
    function arm() {
        ensurePermission();
        document.removeEventListener('click', arm);
        document.removeEventListener('keydown', arm);
        document.removeEventListener('touchstart', arm);
    }
    document.addEventListener('click', arm, { once: true, passive: true });
    document.addEventListener('keydown', arm, { once: true });
    document.addEventListener('touchstart', arm, { once: true, passive: true });

    function playChime() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const now = ctx.currentTime;

            function blip(freq, start, dur, peak) {
                const osc = ctx.createOscillator();
                const g = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, now + start);
                g.gain.setValueAtTime(0.0001, now + start);
                g.gain.exponentialRampToValueAtTime(peak, now + start + 0.03);
                g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
                osc.connect(g);
                g.connect(ctx.destination);
                osc.start(now + start);
                osc.stop(now + start + dur + 0.02);
            }

            blip(880, 0.00, 0.18, 0.20);
            blip(1320, 0.12, 0.22, 0.18);

            setTimeout(() => { try { ctx.close(); } catch (e) {} }, 800);
        } catch (e) { /* ignore */ }
    }

    function ensureToastStyles() {
        if (document.getElementById('mjrNotifyToastStyles')) return;
        const style = document.createElement('style');
        style.id = 'mjrNotifyToastStyles';
        style.textContent = `
            #mjrNotifyToast {
                position: fixed; top: 20px; right: 20px; max-width: 340px;
                background: #1e293b; color: #fff;
                border-left: 4px solid #3b82f6;
                padding: 14px 18px; border-radius: 12px;
                box-shadow: 0 12px 28px rgba(0,0,0,0.35);
                z-index: 100000;
                transform: translateY(-20px); opacity: 0;
                transition: opacity 0.25s ease, transform 0.25s ease;
                font-family: 'Inter', system-ui, sans-serif;
                pointer-events: auto;
            }
            #mjrNotifyToast.show { transform: translateY(0); opacity: 1; }
            #mjrNotifyToast .mjr-notify-title { font-weight: 700; margin-bottom: 4px; font-size: 0.95rem; }
            #mjrNotifyToast .mjr-notify-body  { font-size: 0.85rem; opacity: 0.9; line-height: 1.35; }
            @media (max-width: 640px) {
                #mjrNotifyToast { left: 16px; right: 16px; max-width: none; }
            }
        `;
        document.head.appendChild(style);
    }

    function showToast(title, body) {
        ensureToastStyles();
        let toast = document.getElementById('mjrNotifyToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'mjrNotifyToast';
            document.body.appendChild(toast);
        }
        toast.innerHTML = `
            <div class="mjr-notify-title">${title}</div>
            <div class="mjr-notify-body">${body}</div>
        `;
        // restart the show animation
        toast.classList.remove('show');
        void toast.offsetWidth;
        toast.classList.add('show');
        clearTimeout(toast._mjrHideTimer);
        toast._mjrHideTimer = setTimeout(() => toast.classList.remove('show'), 5500);
    }

    function notify(opts) {
        const title = (opts && opts.title) || 'MJR';
        const body  = (opts && opts.body)  || '';
        const tag   = (opts && opts.tag)   || 'mjr-notif';

        showToast(title, body);
        playChime();

        if (permissionGranted) {
            try {
                const n = new Notification(title, {
                    body: body,
                    tag: tag,
                    icon: '/logo-192.png',
                    badge: '/logo-192.png',
                    silent: false
                });
                setTimeout(() => { try { n.close(); } catch (e) {} }, 6000);
            } catch (e) { /* ignore */ }
        }
    }

    /* Self-echo suppression: pages call markLocalSave() right before a
       Supabase write so the realtime echo arrives within the suppression
       window and we skip notifying the originator. */
    let lastLocalSaveAt = 0;
    function markLocalSave() { lastLocalSaveAt = Date.now(); }
    function isLikelyOwnChange() { return (Date.now() - lastLocalSaveAt) < 2500; }

    window.MJR_notify = notify;
    window.MJR_requestNotifyPermission = ensurePermission;
    window.MJR_markLocalSave = markLocalSave;
    window.MJR_isLikelyOwnChange = isLikelyOwnChange;
})();
