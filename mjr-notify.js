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

    window.MJR_notify = notify;
    window.MJR_markLocalSave = markLocalSave;
    window.MJR_isLikelyOwnChange = isLikelyOwnChange;
    window.MJR_setupPush = setupPush;
})();
