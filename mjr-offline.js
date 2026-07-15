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
