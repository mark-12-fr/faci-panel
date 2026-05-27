/*
 * MJR Faci Session Tracker
 *
 * Records when a facilitator opens the web panel and when they leave.
 * Maintains a single row in `facilitator_logs` per browser session:
 *
 *   - time_in  is stamped once when the session starts.
 *   - time_out is refreshed on every heartbeat / page navigation / tab close
 *               so the latest value reflects when the facilitator was last
 *               active, even if they don't explicitly log out.
 *
 * The active log id lives in sessionStorage so a fresh browser launch
 * always starts a new row, while navigating across pages reuses it.
 */
(function () {
    const HEARTBEAT_MS = 30000;
    const LOG_TABLE = 'facilitator_logs';
    const LOG_ID_KEY = 'faci_log_id';
    const LOG_FACI_KEY = 'faci_log_faci_id';

    let heartbeatTimer = null;

    function getSupabase() {
        if (typeof window.supabaseClient !== 'undefined' && window.supabaseClient) {
            return window.supabaseClient;
        }
        if (typeof supabaseClient !== 'undefined' && supabaseClient) {
            return supabaseClient;
        }
        return null;
    }

    function getFaciId() {
        return localStorage.getItem('faci_id');
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function readSessionLog() {
        const id = sessionStorage.getItem(LOG_ID_KEY);
        const faci = sessionStorage.getItem(LOG_FACI_KEY);
        return id && faci ? { id, faci } : null;
    }

    function writeSessionLog(id, faciId) {
        sessionStorage.setItem(LOG_ID_KEY, String(id));
        sessionStorage.setItem(LOG_FACI_KEY, String(faciId));
    }

    function clearSessionLog() {
        sessionStorage.removeItem(LOG_ID_KEY);
        sessionStorage.removeItem(LOG_FACI_KEY);
    }

    async function openSession() {
        const sb = getSupabase();
        const faciId = getFaciId();
        if (!sb || !faciId) return null;

        try {
            const { data, error } = await sb
                .from(LOG_TABLE)
                .insert({ facilitator_id: faciId, time_in: nowIso() })
                .select('id')
                .single();
            if (error) throw error;
            if (data && data.id) {
                writeSessionLog(data.id, faciId);
                return data.id;
            }
        } catch (err) {
            console.error('Faci session: failed to open log', err);
        }
        return null;
    }

    async function touchSession() {
        const sb = getSupabase();
        const session = readSessionLog();
        if (!sb || !session) return;

        try {
            await sb.from(LOG_TABLE)
                .update({ time_out: nowIso() })
                .eq('id', session.id);
        } catch (err) {
            console.error('Faci session: heartbeat update failed', err);
        }
    }

    async function closeSessionBeacon() {
        const sb = getSupabase();
        const session = readSessionLog();
        if (!sb || !session) return;

        try {
            await sb.from(LOG_TABLE)
                .update({ time_out: nowIso() })
                .eq('id', session.id);
        } catch (err) {
            /* tab is closing; nothing to report to */
        }
    }

    async function ensureSession() {
        const faciId = getFaciId();
        if (!faciId) return;

        const session = readSessionLog();
        if (session && session.faci === faciId) {
            await touchSession();
            return;
        }

        if (session && session.faci !== faciId) {
            clearSessionLog();
        }
        await openSession();
    }

    function startHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(touchSession, HEARTBEAT_MS);
    }

    function bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                ensureSession();
            } else {
                touchSession();
            }
        });

        window.addEventListener('pagehide', closeSessionBeacon);
        window.addEventListener('beforeunload', closeSessionBeacon);
    }

    function wrapLogout() {
        const original = window.faciLogout;
        if (typeof original !== 'function' || original.__mjrSessionWrapped) return;

        const wrapped = async function () {
            await closeSessionBeacon();
            clearSessionLog();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            return original.apply(this, arguments);
        };
        wrapped.__mjrSessionWrapped = true;
        window.faciLogout = wrapped;
    }

    async function init() {
        if (!getFaciId()) return;
        await ensureSession();
        startHeartbeat();
        bindLifecycle();

        if (typeof window.faciLogout === 'function') {
            wrapLogout();
        } else {
            const observer = new MutationObserver(() => {
                if (typeof window.faciLogout === 'function') {
                    wrapLogout();
                    observer.disconnect();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
                wrapLogout();
                observer.disconnect();
            }, 4000);
        }
    }

    window.mjrFaciSession = {
        ensure: ensureSession,
        touch: touchSession,
        close: closeSessionBeacon,
        clear: clearSessionLog
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
