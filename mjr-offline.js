/*
 * mjr-offline.js — registers the offline-capable service worker as early as
 * possible on EVERY page, independent of login state or push-notification
 * permission (mjr-notify.js only registers it later, gated on being logged
 * in). Without this, a user who never completes the notification-permission
 * flow would never get shell caching, and the app could never open offline
 * even after repeat visits.
 */
(function () {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/mjr-sw.js').catch(function () {
            // Non-critical — the page still works online without it.
        });
    });
})();
