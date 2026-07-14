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

var CACHE_NAME = 'acadtrack-faci-v1';
var CACHE_URLS = [
  '/login.html',
  '/index.html',
  '/attendance.html',
  '/record.html',
  '/profile.html',
  '/offlineSyncUtility.js',
  '/grading.js',
  '/faci-session.js',
  '/mjr-notify.js',
  '/mjr-guard.js',
  '/manifest.json',
  '/logo.jpg',
  '/logo-192.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(CACHE_URLS).catch(function () {
                // Non-critical — proceed even if some files fail
            });
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_NAME; })
                    .map(function (n) { return caches.delete(n); })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

self.addEventListener('fetch', (event) => {
    // Only handle GET requests (API calls should go to network)
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then(function (response) {
                // Cache successful responses for future offline use
                if (response.status === 200) {
                    var copy = response.clone();
                    caches.open(CACHE_NAME).then(function (cache) {
                        cache.put(event.request, copy);
                    });
                }
                return response;
            })
            .catch(function () {
                // Offline — serve from cache
                return caches.match(event.request).then(function (cached) {
                    return cached || new Response('Offline', { status: 503 });
                });
            })
    );
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
