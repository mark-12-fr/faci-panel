/*
 * offlineSyncUtility.js — IndexedDB-backed offline queue for AcadTrack Faci Portal
 *
 * Exposes:
 *   window.__offlineSync
 *     .init()             — open DB, register listeners, flush any leftover queue
 *     .isOnline           — boolean
 *     .pendingCount()     — Promise<number>
 *     .queue(type, data)  — {attendance, class_record}
 *     .flush()            — process queue now
 *     .destroy()          — remove listeners (cleanup)
 *     .onchange           — callback(array) fired when queue changes
 *
 * Sync uses Supabase REST API directly (no extra backend needed).
 * Record is deleted from queue ONLY after a successful 2xx response.
 */

(function () {
    var DB_NAME = 'acadtrack-offline';
    var DB_VERSION = 1;
    var STORE = 'sync_queue';
    var _db = null;
    var _listeners = [];
    var _onchange = null;

    function openDB() {
        return new Promise(function (resolve, reject) {
            if (_db) return resolve(_db);
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function getAll() {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readonly');
                var store = tx.objectStore(STORE);
                var req = store.getAll();
                req.onsuccess = function () { resolve(req.result || []); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function addItem(item) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var store = tx.objectStore(STORE);
                item.createdAt = Date.now();
                item.retryCount = 0;
                item.lastError = null;
                var req = store.add(item);
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function deleteItem(id) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var store = tx.objectStore(STORE);
                var req = store.delete(id);
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function updateRetry(id, errMsg) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var store = tx.objectStore(STORE);
                var getReq = store.get(id);
                getReq.onsuccess = function () {
                    var item = getReq.result;
                    if (!item) return resolve();
                    item.retryCount = (item.retryCount || 0) + 1;
                    item.lastError = errMsg;
                    store.put(item);
                    resolve();
                };
                getReq.onerror = function () { reject(getReq.error); };
            });
        });
    }

    function supabaseRestUrl(table) {
        return 'https://njzvuwkepaasnsvuujgx.supabase.co/rest/v1/' + table;
    }

    function supabaseHeaders() {
        var key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qenZ1d2tlcGFhc25zdnV1amd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1OTk5MTgsImV4cCI6MjA5MzE3NTkxOH0.tFh2d3ZIZYMWk-7HHckCbkwbTJ7uQ9onGeTaaUlkeH0';
        return {
            'apikey': key,
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        };
    }

    function syncRecord(item) {
        var table = item.type === 'attendance' ? 'attendance' : 'class_records';
        var url = supabaseRestUrl(table);
        var headers = supabaseHeaders();

        // For class_records upsert, include Prefer: resolution=merge-duplicates
        if (item.type === 'class_record') {
            headers['Prefer'] = 'resolution=merge-duplicates';
        }

        return fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(Array.isArray(item.payload) ? item.payload : [item.payload])
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (body) {
                    throw new Error('HTTP ' + res.status + ': ' + (body || res.statusText));
                });
            }
            return res;
        });
    }

    function notifyChange() {
        if (typeof _onchange === 'function') {
            getAll().then(function (items) { _onchange(items); });
        }
    }

    var FLUSHING = false;

    function flush() {
        if (FLUSHING) return Promise.resolve();
        FLUSHING = true;

        return getAll().then(function (items) {
            if (!items.length) { FLUSHING = false; return; }

            // Process one at a time, oldest first
            function processOne(index) {
                if (index >= items.length) {
                    FLUSHING = false;
                    notifyChange();
                    return;
                }

                var item = items[index];

                // Skip items that have exceeded max retries (5)
                if ((item.retryCount || 0) >= 5) {
                    processOne(index + 1);
                    return;
                }

                return syncRecord(item).then(function () {
                    // Success — delete from queue
                    return deleteItem(item.id).then(function () {
                        notifyChange();
                        processOne(index + 1);
                    });
                }).catch(function (err) {
                    // Failure — update retry count and move on
                    return updateRetry(item.id, err.message).then(function () {
                        processOne(index + 1);
                    });
                });
            }

            return processOne(0);
        }).catch(function () {
            FLUSHING = false;
        });
    }

    function queue(type, payload) {
        return addItem({ type: type, payload: payload }).then(function () {
            notifyChange();
            // If online, try to flush immediately
            if (navigator.onLine) {
                flush();
            }
        });
    }

    function pendingCount() {
        return getAll().then(function (items) { return items.length; });
    }

    function init() {
        return openDB().then(function () {
            // Register network listeners
            function onOnline() { flush(); }
            function onOffline() { notifyChange(); }

            window.addEventListener('online', onOnline);
            window.addEventListener('offline', onOffline);
            _listeners = [onOnline, onOffline];

            // Flush any leftover queue from previous session
            if (navigator.onLine) {
                flush();
            }

            notifyChange();
        });
    }

    function destroy() {
        _listeners.forEach(function (fn) {
            window.removeEventListener('online', fn);
            window.removeEventListener('offline', fn);
        });
        _listeners = [];
        _onchange = null;
    }

    window.__offlineSync = {
        init: init,
        get isOnline() { return navigator.onLine; },
        pendingCount: pendingCount,
        queue: queue,
        flush: flush,
        destroy: destroy,
        get onchange() { return _onchange; },
        set onchange(fn) { _onchange = fn; }
    };

    // Auto-init when DOM is ready
    function autoInit() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () {
                window.__offlineSync.init();
            });
        } else {
            window.__offlineSync.init();
        }
    }

    if (typeof indexedDB !== 'undefined') {
        autoInit();
    }
})();
