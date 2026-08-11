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
 *
 * v2 of this attempt (rewritten here) shipped a SECOND, Safari-only bug:
 * Vercel's cleanUrls 308-redirects "/login.html" -> "/login", and v2 fetched
 * BOTH forms at install time, caching the ".html" entry as whatever the
 * fetch() call followed the redirect to — a Response with `redirected: true`.
 * Per spec, a service worker must not fulfill a NAVIGATION with a redirected
 * Response; Chromium quietly allows it, but Safari correctly rejects it
 * ("Response served by service worker has redirections"), which broke the
 * PWA's manifest start_url ("/login.html") on iOS on the very first launch.
 * Fixed by never fetching/caching a URL that redirects at all: every ".html"
 * request is normalized to its canonical extensionless form (for both the
 * cache lookup AND the network fetch) before it ever reaches the cache.
 *
 * v4: all precache/revalidation fetches now force `cache: 'reload'`, so the
 * shell is always seeded from a genuinely fresh network response instead of
 * whatever Vercel/the browser's own HTTP cache happened to be holding. Cache
 * name bumped so devices that installed an earlier, buggier version start
 * clean instead of carrying over anything cached under the old logic.
 *
 * v5: the "has redirections" Safari crash was STILL reachable for anyone whose
 * device was stuck on a pre-v3 worker (its redirected "/index.html" cache
 * entry served the "Home" link's navigation). Two defences make it impossible
 * from here on, independent of any stale cache:
 *   1. NAVIGATIONS ARE NOW NETWORK-FIRST. When online, a page navigation is
 *      always served fresh from the network under its canonical URL; the cache
 *      (the part that ever held a redirected response) is touched ONLY as an
 *      offline fallback — never while there's a network.
 *   2. stripRedirect(): any response we are about to hand back for a
 *      navigation is rebuilt from its body if its `redirected` flag is set, so
 *      a navigation can NEVER be fulfilled with a redirected response again,
 *      no matter where the response came from. Static assets stay cache-first
 *      (instant load); they aren't navigations, so the restriction can't bite.
 */

var CACHE_NAME = 'acadtrack-faci-shell-v22';

// Same-origin app shell — ONLY canonical, non-redirecting paths. Never list
// a ".html" path here: Vercel's cleanUrls 308-redirects it, and fetch()
// follows that transparently, producing a `redirected: true` Response that
// Safari refuses to use for a navigation (see note above). "/login.html" etc.
// are still served correctly offline — canonicalPath() below maps them to
// these same entries at request time instead.
var SHELL_URLS = [
    '/',
    '/login',
    '/attendance',
    '/record',
    '/profile',
    '/grading.js',
    '/faci-session.js',
    '/mjr-notify.js',
    '/mjr-guard.js',
    '/mjr-offline.js',
    '/offline-bar.js',
    '/offlineSyncUtility.js',
    '/smooth-select.js',
    '/ui-enhance.js',
    '/manifest.json',
    '/logo.jpg',
    '/logo-192.png'
];

// Maps a request path to the canonical, non-redirecting path it should be
// fetched/cached under — "/login.html" and "/index.html" both resolve to a
// SHELL_URLS entry so a redirected Response is never fetched, cached, or
// (critically, for Safari) used to fulfill a navigation.
function canonicalPath(pathname) {
    if (pathname === '/index.html') return '/';
    var m = pathname.match(/^(.*)\.html?$/i);
    return m ? (m[1] || '/') : pathname;
}

// Cross-origin vendor scripts the pages depend on just to boot (bcrypt for
// offline login, the Supabase client, icons). Precached once at install and
// served cache-first after that — the one deliberate exception to "never
// touch cross-origin traffic" below, because without them the shell HTML
// loads but immediately breaks with no network to fetch them fresh.
var VENDOR_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/bcryptjs@2.4.3/dist/bcrypt.min.js',
    'https://unpkg.com/@supabase/supabase-js@2',
    'https://unpkg.com/lucide@latest',
    // Font Awesome powers the bottom-nav + button icons. Precache the stylesheet
    // and its solid/regular webfonts; the FONT_AWESOME_PREFIX rule in fetch()
    // also catches any other glyph file the CSS pulls, so icons render offline.
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2'
];

// Font Awesome (CSS + its webfont files) all live under this cdnjs prefix.
// Matching by prefix — not exact URL — means the stylesheet AND every glyph
// file it requests are cached the first time they load online, so the icons
// keep rendering with no network.
var FONT_AWESOME_PREFIX = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/';

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

// A service worker MUST NOT fulfill a NAVIGATION with a response whose
// `redirected` flag is set — Safari rejects it outright ("Response served by
// service worker has redirections"). Rebuild an identical but redirect-free
// Response from the body so the navigation can safely use it. Non-redirected
// responses (the normal case) pass straight through untouched.
function stripRedirect(response) {
    if (!response || !response.redirected) return Promise.resolve(response);
    return response.blob().then(function (body) {
        return new Response(body, {
            status: response.status || 200,
            statusText: response.statusText,
            headers: response.headers
        });
    }).catch(function () { return response; });
}

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            // Cache each URL independently (not addAll) so one missing/slow
            // file can't abort caching the rest — runtime caching fills any
            // gaps in on the next successful visit anyway.
            return Promise.all(
                SHELL_URLS.concat(VENDOR_URLS).map(function (url) {
                    return fetch(url, { mode: 'cors', cache: 'reload' }).then(function (response) {
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
    var isVendor = VENDOR_URLS.indexOf(request.url) !== -1
        || request.url.indexOf(FONT_AWESOME_PREFIX) === 0;

    // Cross-origin: only the fixed vendor allowlist (plus Font Awesome, matched
    // by prefix) is ever intercepted. Every other cross-origin call (Supabase /
    // Render / Gemini) goes straight to the network, untouched.
    if (url.origin !== self.location.origin) {
        if (!isVendor) return;
        event.respondWith(cacheFirst(request.url, { mode: 'cors', cache: 'reload' }, event));
        return;
    }

    // Same-origin PAGE navigation: NETWORK-FIRST (see v5 note up top). When
    // online we serve a fresh, canonical, redirect-free page; the cache is used
    // ONLY when the network fails (i.e. genuinely offline). This keeps the
    // risky cached-HTML path away from Safari entirely whenever there's a
    // network, while still letting the app open offline.
    if (isNavigation(request)) {
        event.respondWith(navigationNetworkFirst(url));
        return;
    }

    // Same-origin static asset (js/css/img/json): cache-first with background
    // revalidate — instant load, refreshed for next time. Never an /api/* GET.
    if (SAME_ORIGIN_ASSET_RE.test(url.pathname)) {
        var assetUrl = url.origin + canonicalPath(url.pathname) + url.search;
        event.respondWith(cacheFirst(assetUrl, { cache: 'reload' }, event));
        return;
    }

    // Anything else same-origin (e.g. a same-origin /api/* GET): untouched.
});

// Network-first page navigation with an offline cache fallback. Every branch
// resolves through stripRedirect so the navigation can never be fulfilled with
// a redirected response (the Safari crash).
function navigationNetworkFirst(url) {
    var lookupUrl = url.origin + canonicalPath(url.pathname) + url.search;
    return caches.open(CACHE_NAME).then(function (cache) {
        return fetch(lookupUrl, { cache: 'reload' }).then(function (response) {
            if (response && response.ok) {
                cache.put(lookupUrl, response.clone()).catch(function () {});
                return stripRedirect(response);
            }
            // Non-OK (404/500): prefer a cached copy if we have one.
            return cache.match(lookupUrl, { ignoreSearch: true }).then(function (cached) {
                return stripRedirect(cached || response);
            });
        }).catch(function () {
            // Network threw → offline. Serve the cached page, else the notice.
            return cache.match(lookupUrl, { ignoreSearch: true }).then(function (cached) {
                if (cached) return stripRedirect(cached);
                return new Response(OFFLINE_FALLBACK_HTML, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            });
        });
    });
}

// Cache-first with background revalidation, for static assets and the fixed
// vendor scripts. A cache HIT responds instantly (this is what makes offline
// opening possible) while a fresh copy is fetched in the background; a MISS
// falls back to the network. Not used for navigations — see above.
function cacheFirst(lookupUrl, fetchOpts, event) {
    return caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(lookupUrl, { ignoreSearch: true }).then(function (cached) {
            var networkFetch = fetch(lookupUrl, fetchOpts).then(function (response) {
                if (response && response.ok) cache.put(lookupUrl, response.clone()).catch(function () {});
                return response;
            }).catch(function () { return null; });

            if (cached) {
                event.waitUntil(networkFetch);
                return cached;
            }
            return networkFetch.then(function (response) {
                return response || new Response('', { status: 503 });
            });
        });
    });
}

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
