# AcadTrack Facilitator — Web (Next.js)

The React/Next.js frontend for the Facilitator panel. It renders the exact same
UI/UX as the original static pages and calls the FastAPI backend (`../backend`)
for all data.

```
Next.js (web/)  →  FastAPI (../backend)  →  Supabase PostgreSQL
```

## Stack
- Next.js 14 (App Router) + React 18 + TypeScript
- Self-hosted Inter (`@fontsource/inter`) + Font Awesome (no CDN)
- PWA: manifest + service worker (`public/mjr-sw.js`)

## Pages (parity with the legacy app)
| Route | Legacy file | Notes |
| --- | --- | --- |
| `/login` | login.html | splash, remember-me, auto-login |
| `/` | index.html | dashboard: stat cards + 6 drawers + class ranking |
| `/attendance` | attendance.html | date lock, mark, submit (delete+insert) |
| `/record` | record.html | grade grid, drawer editor, photo→AI review, save |
| `/profile` | profile.html | avatar upload, co-facilitators, logout |

## Run locally
```bash
cd web
npm install
cp .env.local.example .env.local   # point NEXT_PUBLIC_API_BASE at the backend
npm run dev                        # http://localhost:3000
```
Start the backend first (see `../backend/README.md`).

## Configuration
`NEXT_PUBLIC_API_BASE` — base URL of the FastAPI backend. Defaults to
`http://127.0.0.1:5000` when unset.

## Notes on fidelity
- The CSS for each page is ported verbatim from the original `<style>` blocks,
  scoped under a per-page wrapper class so the look is identical.
- Navigation between the top-level pages uses full-page loads (as the original
  multi-page app did), which also keeps each route's scoped CSS clean.
- Data now flows through FastAPI (JWT-authenticated) instead of talking to
  Supabase directly from the browser — the same features, a cleaner 3-tier
  architecture.
- The only behavioural change: the old Supabase **realtime** live-refresh (a
  toast when the teacher edits data in another tab) is not wired up, since the
  browser no longer holds a Supabase client. Viewing/submitting is unchanged;
  data refreshes on load and after each submit.
