"""
main.py — AcadTrack Facilitator API (FastAPI).
=============================================
The FastAPI replacement for the old Flask `/api/faci/*` endpoints and the
Vercel `vision-analyze` serverless function. Talks to the same Supabase
Postgres database, so no data migration is needed.

Run locally:
    uvicorn app.main:app --reload --port 5000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import auth, data, push, session, vision

app = FastAPI(
    title="AcadTrack Facilitator API",
    version="1.0.0",
    description="Backend for the AcadTrack Facilitator panel (Next.js frontend).",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(data.router)
app.include_router(session.router)
app.include_router(push.router)
app.include_router(vision.router)


@app.get("/")
async def root():
    return {"status": "ok", "service": "AcadTrack Facilitator API"}


@app.get("/api/ping")
async def ping():
    return {"ok": True}
