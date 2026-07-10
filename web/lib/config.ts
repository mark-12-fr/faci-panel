// Base URL of the FastAPI backend. Configurable per environment; falls back to
// the local dev server, mirroring the old `API_URL` localhost switch.
export const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "") || "http://127.0.0.1:5000";
