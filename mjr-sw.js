/*
 * MJR Service Worker — push notifications + offline app-shell caching.
 *
 * Two independent jobs:
 *   1. Push notifications (unchanged from before the offline attempt below).
 *   2. Offline app shell: precache the 5 pages plus their same-origin JS/
 *      images and a short fixed list of vendor CDN scripts, so the app can
 *      be opened — even a fully closed tab, zero network — once it has
 *      been visited online at least once.
 *
 * A previous attempt at #2 intercepted EVERY GET request (including
 * cross-origin Supabase/Render API calls) and caused a black screen in
 * production: an API's JSON GET got treated like a page navigation, and any
 * cache miss (e.g. a URL Vercel's cleanUrls rewrote, like "/login" vs a
 * precached "/login.html") fell through to a bare `Response('Offline')` —
 * a blank body, which is exactly a black screen when that happens to be the
 * navigation request itself. That attempt was reverted.
 *
 * This version is scoped narrowly to avoid repeating that:
 *   - Cross-origin requests are NEVER intercepted, except the small fixed
 *     VENDOR_URLS list (precached once, served cache-first). Every
 *     Supabase / Render / Gemini call always goes straight to the network.
 *   - Same-origin requests are only handled for navigations and known
 *     static-asset extensions — never a same-origin /api/* route.
 *   - Cache-first with background revalidation: a cache HIT responds
 *     instantly (this is what makes offline opening possible) while a fresh
 *     copy is fetched in the background for next time. A cache MISS falls
 *     back to the network, and only if that ALSO fails do we show a
 *     friendly "never opened on this device yet" page — never a blank one.
 */

var CACHE_NAME = 'acadtrack-faci-shell-v2';

// Same-origin app shell. Both the extensionless path (what real in-app
// navigation requests under Vercel's cleanUrls) and the .html path (what the
// installed PWA's manifest start_url, and any stale bookmark, requests) are
// listed so either form hits the cache.
var SHELL_URLS = [
    '/', '/index.html',
    '/login', '/login.html',
    '/attendance', '/attendance.html',
    '/record', '/record.html',
    '/profile', '/profile.html',
    '/grading.js',
    '/faci-session.js',
    '/mjr-notify.js',
    '/mjr-guard.js',
    '/mjr-offline.js',
    '/offlineSyncUtility.js',
    '/manifest.json',
    '/logo.jpg',
    '/logo-192.png'
];

// Cross-origin vendor scripts the pages depend on just to boot (bcrypt for
// offline login, the Supabase client, icons). Precached once at install and
// served cache-first after that — the one deliberate exception to "never
// touch cross-origin traffic" below, because without them the shell HTML
// loads but immediately breaks with no network to fetch them fresh.
var VENDOR_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/bcryptjs@2.4.3/dist/bcrypt.min.js',
    'https://unpkg.com/@supabase/supabase-js@2',
    'https://unpkg.com/lucide@latest'
];

var OFFLINE_FALLBACK_HTML =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Offline — AcadTrack</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;' +
    'padding:24px;text-align:center}div{max-width:340px}h1{font-size:1.25rem;margin:0 0 8px}' +
    'p{color:#94a3b8;font-size:.9rem;line-height:1.5;margin:0 0 20px}' +
    'button{background:#3b82f6;color:#fff;border:none;padding:10px 20px;border-radius:8px;' +
    'font-size:.9rem;font-weight:600;cursor:pointer}</style></head><body>' +
    '<div><h1>You’re offline</h1>' +
    '<p>This page hasn’t been opened on this device yet, so there’s nothing saved to ' +
    'show. Connect to the internet once to load it, and it’ll work offline after that.</p>' +
    '<button onclick="location.reload()">Try again</button></div></body></html>';

function isNavigation(request) {
    if (request.mode === 'navigate') return true;
    var accept = request.headers.get('accept');
    return !!(accept && accept.indexOf('text/html') !== -1);
}

var SAME_ORIGIN_ASSET_RE = /\.(js|css|json|png|jpg|jpeg|svg|webp|ico)$/i;

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            // Cache each URL independently (not addAll) so one missing/slow
            // file can't abort caching the rest — runtime caching fills any
            // gaps in on the next successful visit anyway.
            return Promise.all(
                SHELL_URLS.concat(VENDOR_URLS).map(function (url) {
                    return fetch(url, { mode: 'cors' }).then(function (response) {
                        if (response && response.ok) return cache.put(url, response);
                    }).catch(function () { /* non-critical */ });
                })
            );
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

self.addEventListener('activate', function (event) {
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

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return; // POST/PUT/DELETE always go straight to network

    var url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return;
    }
    var isVendor = VENDOR_URLS.indexOf(request.url) !== -1;

    if (url.origin !== self.location.origin) {
        if (!isVendor) return; // every other cross-origin call: untouched, straight to network
    } else if (!isNavigation(request) && !SAME_ORIGIN_ASSET_RE.test(url.pathname)) {
        return; // same-origin but not a page or known asset (e.g. a same-origin /api/* GET): untouched
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.match(request).then(function (cached) {
                // Vendor scripts are requested by <script> tags in no-cors
                // mode, which yields an opaque (unreadable, always "not ok")
                // response — re-fetch those explicitly in cors mode so the
                // background refresh can actually tell whether it succeeded.
                var networkFetch = (isVendor ? fetch(request.url, { mode: 'cors' }) : fetch(request))
                    .then(function (response) {
                        if (response && response.ok) cache.put(request, response.clone()).catch(function () {});
                        return response;
                    })
                    .catch(function () { return null; });

                if (cached) {
                    // Instant response from cache — this is what makes the
                    // app open with no network. Refresh the cache in the
                    // background so the next open (online or offline) has
                    // whatever changed since.
                    event.waitUntil(networkFetch);
                    return cached;
                }

                return networkFetch.then(function (response) {
                    if (response) return response;
                    if (isNavigation(request)) {
                        return new Response(OFFLINE_FALLBACK_HTML, {
                            status: 200,
                            headers: { 'Content-Type': 'text/html; charset=utf-8' }
                        });
                    }
                    return new Response('', { status: 503 });
                });
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
