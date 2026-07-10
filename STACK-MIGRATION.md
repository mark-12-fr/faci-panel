# Stack Migration — React/Next.js → FastAPI → PostgreSQL

This repo is being converted from a static **HTML/CSS/JS + Flask + Vercel
functions** app into a modern 3-tier stack, **without changing the UI/UX or the
features**, and reusing the existing Supabase Postgres database (no data
migration).

```
┌─────────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  web/  (Next.js)    │ ──▶ │ backend/ (FastAPI)│ ──▶ │ Supabase PostgreSQL │
│  React + TypeScript │     │ async SQLAlchemy  │     │ (same DB as before) │
└─────────────────────┘     └──────────────────┘     └────────────────────┘
```

The original static files remain in the repo untouched until the new stack is
promoted, so nothing breaks in the meantime.

## Layout
| Folder | What it is |
| --- | --- |
| `web/` | Next.js frontend (see `web/README.md`) |
| `backend/` | FastAPI backend (see `backend/README.md`) |
| *(root `*.html`, `*.js`)* | the original app, kept for reference/rollback |

> The chosen "subfolders" layout used `web/` + `backend/`. `backend/` is used
> instead of `api/` because the repo already has an `api/` folder (the legacy
> Vercel `vision-analyze` function), which the old app still needs.

## What changed vs. the original
- **Frontend**: vanilla pages → React components. Each page's CSS is carried
  over verbatim (scoped per route), so the look is pixel-identical. Behaviour is
  reimplemented with React hooks.
- **Backend**: Flask `/api/faci/*` + the Vercel `vision-analyze` function →
  one FastAPI app. Facilitator auth now issues a **JWT**; every data endpoint is
  authenticated and scopes to the facilitator's own section/teacher server-side.
- **Database**: unchanged. FastAPI connects to the same Supabase Postgres via
  `DATABASE_URL`. SQLAlchemy models map 1:1 to the live schema.
- **Only behavioural difference**: the Supabase realtime live-refresh toast is
  not reconnected (the browser no longer holds a Supabase client). All view and
  submit features are identical.

## Running the new stack locally
```bash
# 1) Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # set DATABASE_URL (Supabase) + JWT_SECRET
uvicorn app.main:app --reload --port 5000

# 2) Frontend (new terminal)
cd web
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_BASE=http://127.0.0.1:5000
npm run dev                        # http://localhost:3000
```

## Deployment
- **Backend** → Render (same service that ran Flask). Start command:
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT`. Set the env vars from
  `backend/.env.example`.
- **Frontend** → Vercel. Set `NEXT_PUBLIC_API_BASE` to the backend URL.

## Verification done
- Backend imports + OpenAPI generation pass; `web` production build passes.
- Section-scoping logic validated against the **live** Supabase data.
- Full end-to-end suite (login → JWT → me/section/students/records/attendance/
  session, upsert + delete-insert idempotency, field validation) run green
  against a real Postgres instance.

## Status
- ✅ **Facilitator panel** — fully ported (login, dashboard, attendance,
  records incl. photo→AI, profile).
- ⏳ **Teacher panel** — next, following the same pattern.
