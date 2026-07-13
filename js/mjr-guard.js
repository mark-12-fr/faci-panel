/*
 * MJR client-side protection
 *
 * - Blocks the right-click context menu, F12, Ctrl+Shift+I/J/C, Ctrl+U,
 *   and Ctrl+S so casual users can't open DevTools or view source.
 * - Strips the .html extension from every internal <a href> so the
 *   hover preview / status bar no longer reveals the real filename.
 *   Vercel's cleanUrls handles the routing.
 * - Appends a daily-rotating hash token to the URL so links look
 *   different every day. The pathname stays intact, so refresh,
 *   back, and direct navigation keep working. OAuth callbacks
 *   (#access_token=...) are left alone.
 */
(function () {
    /* === 1. Block context menu and devtools shortcuts ===================== */
    function block(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        return false;
    }

    document.addEventListener('contextmenu', block, { capture: true });

    document.addEventListener('keydown', function (e) {
        const key = (e.key || '').toLowerCase();
        if (e.keyCode === 123 || key === 'f12') return block(e);
        if ((e.ctrlKey || e.metaKey) && key === 'u') return block(e);
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) {
            return block(e);
        }
        if ((e.ctrlKey || e.metaKey) && key === 's') return block(e);
    }, { capture: true });

    /* === 2. Strip .html from internal <a href> so hover preview is clean === */
    function cleanHref(href) {
        if (!href) return href;
        // Skip absolute URLs to other domains, mailto:, tel:, anchors, javascript:
        if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(href) || /^(mailto:|tel:|javascript:|#)/i.test(href)) {
            return href;
        }
        // Strip .html / .htm right before ?query or #hash or end
        return href.replace(/\.html?(?=$|[?#])/i, '');
    }

    function stripHtmlFromLinks(root) {
        const anchors = (root || document).querySelectorAll('a[href]');
        for (let i = 0; i < anchors.length; i++) {
            const a = anchors[i];
            const raw = a.getAttribute('href');
            const cleaned = cleanHref(raw);
            if (cleaned !== raw) a.setAttribute('href', cleaned);
        }
    }

    function watchForNewLinks() {
        if (typeof MutationObserver !== 'function') return;
        const obs = new MutationObserver(function (mutations) {
            for (let i = 0; i < mutations.length; i++) {
                const added = mutations[i].addedNodes;
                for (let j = 0; j < added.length; j++) {
                    const node = added[j];
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'A') {
                        const raw = node.getAttribute('href');
                        const cleaned = cleanHref(raw);
                        if (cleaned !== raw) node.setAttribute('href', cleaned);
                    } else if (node.querySelectorAll) {
                        stripHtmlFromLinks(node);
                    }
                }
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            stripHtmlFromLinks(document);
            watchForNewLinks();
        });
    } else {
        stripHtmlFromLinks(document);
        watchForNewLinks();
    }

    /* === 3. Append a daily-rotating hash token =========================== */
    function computeToken() {
        const seed = new Date().toISOString().slice(0, 10) + '|' + (window.location.pathname || '').toLowerCase();
        let h = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            h ^= seed.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        const a = (h >>> 0).toString(36);
        const b = ((h ^ 0xdeadbeef) >>> 0).toString(36);
        return (a + b).slice(0, 12);
    }

    function maskUrl() {
        try {
            const path = (window.location.pathname || '').toLowerCase();
            if (/\/(login|sign)(\.html?)?$/i.test(path)) return;

            const hash = window.location.hash || '';
            // Don't interfere with OAuth callbacks.
            if (hash.indexOf('access_token') !== -1) return;

            const token = computeToken();
            if (hash === '#' + token) return; // already masked with today's token

            window.history.replaceState({}, '', window.location.pathname + window.location.search + '#' + token);
        } catch (e) { /* never let URL masking break the page */ }
    }

    maskUrl();

    // Re-mask after a beat in case an OAuth handler cleared the hash
    // (handleOAuthRedirect in index.html runs in window.onload).
    if (document.readyState !== 'complete') {
        window.addEventListener('load', function () { setTimeout(maskUrl, 50); });
    }
})();
