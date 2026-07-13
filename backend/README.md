# AcadTrack Facilitator API (FastAPI)

The FastAPI backend for the Facilitator panel. Replaces the old Flask endpoints
and the Vercel `vision-analyze` serverless function. Talks to the **same
Supabase Postgres** database — no data migration.

Built by **MJR Vertext** (Mark Frizas, Rutz Cabrera, Jean Rose Banay).

```
Next.js (web/)  →  FastAPI (backend/)  →  Supabase PostgreSQL
```

## Stack
- FastAPI + Uvicorn
- SQLAlchemy 2 (async) + asyncpg
- JWT session auth (facilitator login → bearer token)
- bcrypt password verification (compatible with existing hashes)
- httpx (Groq / Gemini vision), pywebpush (VAPID)

## Run locally
```bash
cd backend
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # fill in DATABASE_URL + JWT_SECRET
uvicorn app.main:app --reload --port 5000
```
Interactive API docs: http://127.0.0.1:5000/docs

## Endpoints (all under `/api`)
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/faci/login` | account_id + password → JWT + faci info |
| GET | `/api/faci/me` | current facilitator profile |
| PATCH | `/api/faci/me` | update own profile (name, avatar, password) |
| POST | `/api/faci/heartbeat` | keep status Active / refresh last_login |
| GET | `/api/faci/section` | resolved assigned section |
| GET | `/api/faci/students` | students in the section |
| GET | `/api/faci/class-records` | class records for the section |
| POST | `/api/faci/class-records` | bulk upsert scores |
| GET | `/api/faci/attendance?date=` | attendance rows |
| POST | `/api/faci/attendance` | replace a day's attendance |
| GET | `/api/faci/subjects` | teacher's per-subject grade weights |
| GET | `/api/faci/teacher` | teacher profile |
| GET | `/api/faci/co-facilitators` | co-facilitators on the same section |
| POST | `/api/faci/session` / PATCH `/api/faci/session/{id}` | session time-in / time-out |
| GET/POST | `/api/faci/push/*` | web-push subscription |
| POST | `/api/vision-analyze` | photo → attendance letters / record scores |

## Deploy
Render. Start command:
```
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```
Set environment variables from `.env.example`.
