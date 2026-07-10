# AcadTrack Facilitator API (FastAPI)

The FastAPI backend for the React/Next.js Facilitator panel. It replaces the
old Flask `/api/faci/*` endpoints **and** the Vercel `vision-analyze` serverless
function, and talks to the **same Supabase Postgres** database — so there is no
data migration.

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
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then fill in DATABASE_URL + JWT_SECRET
uvicorn app.main:app --reload --port 5000
```
Interactive API docs: http://127.0.0.1:5000/docs

## Configuration
See `.env.example`. The only strictly-required values are `DATABASE_URL`
(your Supabase Postgres connection string, scheme `postgresql+asyncpg`) and
`JWT_SECRET`. AI-vision and push keys are optional — those features degrade
gracefully when unset, exactly as before.

## Endpoints (all under `/api`)
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/faci/login` | account_id + password → JWT + faci info |
| GET | `/api/faci/me` | current facilitator (also the "account still exists?" check) |
| PATCH | `/api/faci/me` | update own profile (name, avatar, password) |
| POST | `/api/faci/heartbeat` | keep status Active / refresh last_login |
| GET | `/api/faci/section` | resolved assigned section |
| GET | `/api/faci/students` | students in the section |
| GET | `/api/faci/class-records` | class records for the section |
| POST | `/api/faci/class-records` | bulk upsert scores |
| GET | `/api/faci/attendance?date=` | attendance rows (all, or one day) |
| POST | `/api/faci/attendance` | replace a day's attendance |
| GET | `/api/faci/subjects` | teacher's per-subject grade weights |
| GET | `/api/faci/teacher` | teacher profile |
| GET | `/api/faci/co-facilitators` | co-facilitators on the same section |
| POST | `/api/faci/session` / PATCH `/api/faci/session/{id}` | session time-in / time-out |
| GET | `/api/faci/push/vapid-public-key`, POST `/api/faci/push/subscribe` | web-push |
| POST | `/api/vision-analyze` | photo → attendance letters / record scores |

## Deploy
Works on the same Render service the old Flask app used. Start command:
```
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```
Set the environment variables from `.env.example` in the Render dashboard.
