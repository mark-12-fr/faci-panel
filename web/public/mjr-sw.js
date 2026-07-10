/*
 * MJR Push Service Worker
 *
 * Receives Web Push events from the server and displays an OS-level
 * notification — works even when the tab is closed or the browser is
 * minimized, as long as the browser process is alive (or, on mobile,
 * the PWA is installed).
 *
 * Triggered by the /api/push-notify Vercel function in the teacher
 * panel, which is fired by Supabase Database Webhooks on insert/update
 * of `attendance` and `class_records`.
 */
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { title: 'MJR', body: event.data ? event.data.text() : '' };
    }

    const title = payload.title || 'MJR';
    const options = {
        body: payload.body || '',
        icon: '/logo-192.png',
        badge: '/logo-192.png',
        tag: payload.tag || 'mjr-push',
        renotify: true,
        silent: true,
        requireInteraction: false,
        data: {
            url: payload.url || '/',
            ts: Date.now()
        }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    client.navigate(targetUrl);
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
