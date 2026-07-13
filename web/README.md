# AcadTrack Facilitator — Frontend (Next.js)

The React/Next.js frontend for the Facilitator panel. Renders the exact same
UI/UX as the original static pages and calls the FastAPI backend (`../backend`)
for all data.

Built by **MJR Vertext** — presented at Innovex 2026, Indonesia.

```
Next.js (web/)  →  FastAPI (backend/)  →  Supabase PostgreSQL
```

## Stack
- Next.js 14 (App Router) + React 18 + TypeScript
- Self-hosted Inter (`@fontsource/inter`) + Font Awesome (no CDN)
- PWA: manifest + service worker (`public/mjr-sw.js`)

## Pages
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

## Configuration
- `NEXT_PUBLIC_API_BASE` — base URL of the FastAPI backend. Defaults to `http://127.0.0.1:5000`.
