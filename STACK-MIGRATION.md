# Stack Migration — React/Next.js → FastAPI → PostgreSQL

This repo is being converted from a static **HTML/CSS/JS + Supabase JS client**
app into a modern 3-tier stack using the same Supabase Postgres database.

Built by **MJR Vertext** (Mark Frizas, Rutz Cabrera, Jean Rose Banay).

```
┌─────────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  web/  (Next.js)    │ ──▶ │ backend/ (FastAPI)│ ──▶ │ Supabase PostgreSQL │
│  React + TypeScript │     │ async SQLAlchemy  │     │ (same DB as before) │
└─────────────────────┘     └──────────────────┘     └────────────────────┘
```

The original static files remain untouched in case of rollback.

## Layout
| Folder | What it is |
| --- | --- |
| `web/` | Next.js frontend (React + TypeScript) — migration target |
| `backend/` | FastAPI backend (Python, async SQLAlchemy) |
| *(root `*.html`, `*.js`)* | Legacy static app — currently live |

## What changed vs. the original
- **Frontend**: vanilla pages → React components. CSS ported verbatim, pixel-identical.
- **Backend**: browser-side Supabase calls → FastAPI with JWT auth, server-side scoping.
- **Database**: unchanged. FastAPI connects to the same Supabase Postgres.
- **Behavioural difference**: Supabase realtime live-refresh toast removed (browser no longer holds a Supabase client). All view/submit features are identical.

## Status
- ✅ **Facilitator panel** — fully ported (login, dashboard, attendance, records incl. photo→AI, profile)
- ✅ **Backend** — all endpoints implemented and tested
- ⏳ **Promotion** — deploy the Next.js + FastAPI stack to replace the legacy static site
