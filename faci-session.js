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

    // If the teacher removed this facilitator's account, force a logout the
    // next time the app loads / regains focus / heartbeats. Only logs out on a
    // definitive "row not found" — never on a network error (avoids offline
    // false logouts).
    function forceLogout() {
        try {
            ['faci_id', 'faci_section', 'faci_name', 'faci_subject', 'faci_teacher_id'].forEach(function (k) {
                localStorage.removeItem(k);
            });
            clearSessionLog();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
        } catch (e) {}
        var path = 'login.html';
        try { window.location.replace(path); } catch (e) { window.location.href = path; }
    }

    let accountChecking = false;
    async function verifyAccountExists() {
        const sb = getSupabase();
        const faciId = getFaciId();
        if (!sb || !faciId || accountChecking) return;
        accountChecking = true;
        try {
            const { data, error } = await sb
                .from('facilitators')
                .select('id')
                .eq('id', faciId)
                .maybeSingle();
            if (!error && data === null) {
                forceLogout();
            }
        } catch (e) {
            // network/other error -> stay logged in
        } finally {
            accountChecking = false;
        }
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

    async function stampOut() {
        const sb = getSupabase();
        const session = readSessionLog();
        if (!sb || !session) return;

        try {
            await sb.from(LOG_TABLE)
                .update({ time_out: nowIso() })
                .eq('id', session.id);
        } catch (err) {}
    }

    async function ensureSession() {
        const faciId = getFaciId();
        if (!faciId) return;

        const session = readSessionLog();
        if (session && session.faci === faciId) {
            await stampOut();
            return;
        }

        if (session && session.faci !== faciId) {
            clearSessionLog();
        }
        await openSession();
    }

    function startHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(function () { stampOut(); verifyAccountExists(); }, HEARTBEAT_MS);
    }

    function bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                ensureSession();
                verifyAccountExists();
            } else {
                stampOut();
            }
        });

        window.addEventListener('pagehide', stampOut);
        window.addEventListener('beforeunload', stampOut);
    }

    function wrapLogout() {
        const original = window.faciLogout;
        if (typeof original !== 'function' || original.__mjrSessionWrapped) return;

        const wrapped = async function () {
            await stampOut();
            clearSessionLog();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            return original.apply(this, arguments);
        };
        wrapped.__mjrSessionWrapped = true;
        window.faciLogout = wrapped;
    }

    async function init() {
        if (!getFaciId()) return;
        await verifyAccountExists();   // logs out + redirects if the account was deleted
        if (!getFaciId()) return;      // forceLogout cleared it -> stop here
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
