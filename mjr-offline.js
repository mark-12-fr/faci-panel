/*
 * mjr-offline.js — registers the offline-capable service worker as early as
 * possible on EVERY page, independent of login state or push-notification
 * permission (mjr-notify.js only registers it later, gated on being logged
 * in). Without this, a user who never completes the notification-permission
 * flow would never get shell caching, and the app could never open offline
 * even after repeat visits.
 *
 * Registers immediately instead of waiting for window "load": waiting for
 * "load" delays the shell precache behind every image/font/vendor script on
 * the page, which matters if someone goes offline soon after their first
 * visit — before that precache has actually finished.
 *
 * Also actively checks for a newer SW version and reloads once one takes
 * over, instead of relying only on the browser's own update heuristic (which
 * only checks on navigation, at most once every 24h). Without this, a device
 * that registered an older/broken SW version could stay stuck on it
 * indefinitely with no way to notice a fix ever shipped.
 */
(function () {
    if (!('serviceWorker' in navigator)) return;

    var hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('/mjr-sw.js').then(function (reg) {
        try { reg.update(); } catch (e) {}
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                try { reg.update(); } catch (e) {}
            }
        });
        setInterval(function () {
            try { reg.update(); } catch (e) {}
        }, 60 * 60 * 1000);
    }).catch(function () {
        // Non-critical — the page still works online without it.
    });

    // A new SW taking control mid-session means an update was installed —
    // reload once so the page picks up whatever it fixed. Skip the very
    // first controllerchange (no controller -> first-ever SW claiming this
    // page), which fires on every brand-new visit and isn't an "update."
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController) { hadController = true; return; }
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
    });

    // Best-effort: ask the browser not to evict this app's offline cache
    // under storage pressure (relevant on iOS in particular, which is freer
    // about reclaiming Cache Storage than desktop browsers).
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(function () {});
    }
})();

/*
 * Offline READ cache — the companion to offlineSyncUtility.js (which queues
 * WRITES). The service worker caches the app shell (HTML/JS) but deliberately
 * never touches the Supabase/Render data calls, so without this a page opens
 * offline but shows nothing (empty student list, "..." semester). This wraps a
 * Supabase read: online it returns fresh rows AND snapshots them to
 * localStorage; offline (or if the request fails) it replays the last snapshot
 * so records / attendance / students / the section still render. Cache-on-
 * success keeps the copy fresh on every online visit.
 *
 * Stale-while-revalidate: when a snapshot already exists it is returned
 * IMMEDIATELY (no network wait — this is what makes every repeat load fast,
 * online or offline) while the network request refreshes the snapshot in the
 * background for the next load. Freshness is not lost: pages invalidate their
 * cache key right after a successful write (see the save handlers), so a
 * follow-up load always re-reads from Supabase.
 */
(function () {
    var PREFIX = 'faci_cache_';

    window.MJR_cacheGet = function (key) {
        try {
            var raw = localStorage.getItem(PREFIX + key);
            return raw == null ? undefined : JSON.parse(raw);
        } catch (e) { return undefined; }
    };

    window.MJR_cacheSet = function (key, val) {
        try { localStorage.setItem(PREFIX + key, JSON.stringify(val == null ? null : val)); } catch (e) {}
    };

    window.MJR_cacheInvalidate = function (key) {
        try { localStorage.removeItem(PREFIX + key); } catch (e) {}
    };

    // key: a stable string (include section/date so snapshots don't collide).
    // thenable: a Supabase query builder (or any promise resolving to {data,error}).
    // Always resolves to a Supabase-shaped { data, error } object.
    window.MJR_cachedQuery = async function (key, thenable) {
        var cached = window.MJR_cacheGet(key);
        if (cached !== undefined) {
            // Snapshot exists — render it right away, then refresh the copy in
            // the background so the NEXT load is both instant and fresh.
            if (navigator.onLine) {
                Promise.resolve(thenable).then(function (res) {
                    if (res && !res.error) {
                        window.MJR_cacheSet(key, res.data == null ? null : res.data);
                    }
                }).catch(function () {});
            }
            return { data: cached, error: null, fromCache: true };
        }
        if (navigator.onLine) {
            try {
                var res = await thenable;
                if (res && !res.error) {
                    window.MJR_cacheSet(key, res.data == null ? null : res.data);
                    return res;
                }
                // Query returned an error — prefer a cached snapshot if we have one.
                var onErr = window.MJR_cacheGet(key);
                if (onErr !== undefined) return { data: onErr, error: null, fromCache: true };
                return res;
            } catch (e) {
                var onThrow = window.MJR_cacheGet(key);
                if (onThrow !== undefined) return { data: onThrow, error: null, fromCache: true };
                return { data: null, error: { message: String((e && e.message) || e) } };
            }
        }
        // Offline: skip the network entirely and serve the last snapshot.
        var offline = window.MJR_cacheGet(key);
        if (offline !== undefined) return { data: offline, error: null, fromCache: true };
        return { data: null, error: { message: 'offline: no cached data for ' + key } };
    };
})();
