# Vendored browser libraries

Served from our own origin instead of a public CDN so the app never waits on (or
breaks because of) a third-party host on first load: same-origin HTTP/2, precached
by the service worker, cached `immutable` (the version is in the filename).

| File | Source | Notes |
|------|--------|-------|
| `supabase-js-2.117.2.js` | `@supabase/supabase-js@2.117.2` → `dist/umd/supabase.js` | Exposes `window.supabase`. Byte-identical to the npm package. |

To upgrade: `npm pack @supabase/supabase-js@<version>`, copy `package/dist/umd/supabase.js` to
`vendor/supabase-js-<version>.js`, update the `<script src>` in each HTML page and the
`SHELL_URLS` entry in `mjr-sw.js`, and bump `CACHE_NAME` there.
