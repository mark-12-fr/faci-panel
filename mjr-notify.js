(function () {
    if (window.MJR_notify) return;

    const VAPID_PUBLIC_KEY = 'BFtf7OOJhwgFropnI9-gshc0TgwbPjy2-AEjdqs1s2kBLig70bcsTK_xsYY1P6f1eLxztvH_Fc0VUkMhbVHIp0g';

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

    function arm() {
        ensurePermission();
        document.removeEventListener('click', arm);
        document.removeEventListener('keydown', arm);
        document.removeEventListener('touchstart', arm);
    }
    document.addEventListener('click', arm, { once: true, passive: true });
    document.addEventListener('keydown', arm, { once: true });
    document.addEventListener('touchstart', arm, { once: true, passive: true });

    function ensureToastStyles() {
        if (document.getElementById('mjrNotifyToastStyles')) return;
        const style = document.createElement('style');
        style.id = 'mjrNotifyToastStyles';
        style.textContent = `
            #mjrNotifyToast {
                position: fixed; top: 80px; right: 24px; max-width: 380px;
                background: #fff; color: #111827;
                border-left: 4px solid #3b82f6;
                padding: 14px 18px; border-radius: 10px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.15);
                z-index: 100000;
                transform: translateY(-8px) scale(0.98); opacity: 0;
                transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.16,1,0.3,1);
                font-family: 'Inter', system-ui, sans-serif;
                pointer-events: auto;
            }
            #mjrNotifyToast.show { transform: translateY(0) scale(1); opacity: 1; }
            #mjrNotifyToast .mjr-notify-title { font-weight: 700; margin-bottom: 4px; font-size: 0.9rem; color: #111827; }
            #mjrNotifyToast .mjr-notify-body  { font-size: 0.82rem; color: #6b7280; line-height: 1.4; }
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

        if (permissionGranted) {
            try {
                const n = new Notification(title, {
                    body: body,
                    tag: tag,
                    icon: '/logo-192.png',
                    badge: '/logo-192.png',
                    silent: true
                });
                setTimeout(() => { try { n.close(); } catch (e) {} }, 6000);
            } catch (e) {}
        }
    }

    let lastLocalSaveAt = 0;
    function markLocalSave() { lastLocalSaveAt = Date.now(); }
    function isLikelyOwnChange() { return (Date.now() - lastLocalSaveAt) < 2500; }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
    }

    async function setupPush(userType, userId) {
        if (!userType || !userId) return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

        try {
            const reg = await navigator.serviceWorker.register('/mjr-sw.js');
            await navigator.serviceWorker.ready;

            const ok = await ensurePermission();
            if (!ok) return;

            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });
            }

            const sb = (typeof window.supabaseClient !== 'undefined' && window.supabaseClient)
                    || (typeof supabaseClient !== 'undefined' ? supabaseClient : null);
            if (!sb) return;

            const cleanId = String(userId).replace(/['"]+/g, '').trim();
            const subscriptionJson = JSON.parse(JSON.stringify(sub));

            await sb.from('push_subscriptions').upsert({
                user_type: userType,
                user_id: cleanId,
                endpoint: sub.endpoint,
                subscription: subscriptionJson,
                updated_at: new Date().toISOString()
            }, { onConflict: 'endpoint' });

            await sb.from('push_subscriptions')
                .delete()
                .eq('user_type', userType)
                .eq('user_id', cleanId)
                .neq('endpoint', sub.endpoint);
        } catch (err) {
            console.warn('Push subscription failed:', err);
        }
    }

    // Look up the facilitator's own teacher_id (from localStorage, or fetch it
    // from their record so it works even before the next login).
    async function getFaciTeacherId(sb) {
        let tid = localStorage.getItem('faci_teacher_id');
        if (tid) return tid;
        const faciId = localStorage.getItem('faci_id');
        if (!sb || !faciId) return null;
        try {
            const { data } = await sb.from('facilitators')
                .select('teacher_id')
                .or(`id.eq.${faciId},account_id.eq.${faciId}`)
                .single();
            if (data && data.teacher_id) {
                tid = data.teacher_id;
                localStorage.setItem('faci_teacher_id', tid);
                return tid;
            }
        } catch (err) {}
        return null;
    }

    // Resolve the facilitator's own section row. Section titles can repeat
    // across teachers, so prefer the row whose teacher_id matches the
    // facilitator's; fall back to the title-only match for older sessions.
    async function resolveFaciSection(sb, title, columns) {
        if (!sb || !title) return null;
        const cols = columns || 'id, semester, quarter, teacher_id';
        const cacheKey = 'section_' + title;
        // Offline: replay the last known section row (id / semester / quarter /
        // teacher_id) so every page still resolves its section without a network.
        if (!navigator.onLine && window.MJR_cacheGet) {
            const cachedOffline = window.MJR_cacheGet(cacheKey);
            if (cachedOffline) return cachedOffline;
        }
        try {
            // Always scope to the facilitator's OWN teacher_id when known.
            // Never fall back to an arbitrary row — that points the faci at
            // another tenant's identically-titled section.
            const teacherId = await getFaciTeacherId(sb);
            let q = sb.from('sections').select(cols).eq('title', title);
            if (teacherId) q = q.eq('teacher_id', teacherId);
            const { data } = await q;
            const rows = data || [];
            let result = null;
            if (rows.length === 1) result = rows[0];
            else if (rows.length && teacherId) {
                const mine = rows.find(r => String(r.teacher_id) === String(teacherId));
                if (mine) result = mine;
            }
            if (result && window.MJR_cacheSet) window.MJR_cacheSet(cacheKey, result);
            return result;
        } catch (err) {
            // Network failed — fall back to the cached section row if we have one.
            if (window.MJR_cacheGet) {
                const cachedErr = window.MJR_cacheGet(cacheKey);
                if (cachedErr) return cachedErr;
            }
            console.error('resolveFaciSection failed', err);
            return null;
        }
    }

    window.MJR_notify = notify;
    window.MJR_markLocalSave = markLocalSave;
    window.MJR_isLikelyOwnChange = isLikelyOwnChange;
    window.MJR_setupPush = setupPush;
    window.MJR_getFaciTeacherId = getFaciTeacherId;
    window.MJR_resolveFaciSection = resolveFaciSection;
})();
