/*
 * offlineSyncUtility.js — DISABLED (offline mode removed)
 *
 * Previously queued attendance / class-record writes to IndexedDB and
 * synced them to Supabase when back online. This caused stale cached
 * records to overwrite teacher-panel data, so offline sync has been
 * removed. The file is kept as a no-op stub so existing <script src>
 * references and service-worker precache lists don't break.
 */
(function () {
    window.__offlineSync = {
        init: function () {},
        isOnline: navigator.onLine,
        pendingCount: function () { return Promise.resolve(0); },
        queue: function () { return Promise.resolve(); },
        flush: function () { return Promise.resolve(); },
        destroy: function () {},
        saveLocalCreds: function () { return Promise.resolve(); },
        getLocalCreds: function () { return Promise.resolve(null); },
        onchange: null
    };
})();
