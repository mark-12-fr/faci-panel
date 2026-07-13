# 📋 AcadTrack — Facilitator Dashboard

**The mobile-first companion portal for the AcadTrack academic management system.**

Built by **MJR Vertext** (Mark Frizas, Rutz Cabrera, Jean Rose Banay). Presented at Innovex 2026, Indonesia.

The **Facilitator Dashboard** is a Progressive Web App that lets facilitators manage their assigned section — submitting attendance, recording class activities, and monitoring student performance in real time. It shares a single source of truth with the [Teacher Management Portal](https://github.com/mark-12-fr/teacher-panel), so grades and records stay perfectly in sync.

🔗 **Live App:** [https://faci-panel.vercel.app](https://faci-panel.vercel.app)

---

## 🎯 Purpose

Facilitators (co-teachers, assistants, or substitutes) need access to student data without full administrative control. AcadTrack's Facilitator Dashboard bridges this gap:

- Gives facilitators **scoped access** — only their assigned section and students
- Enables **attendance submission** and **score recording** from mobile devices
- Syncs automatically with the teacher's grade book — no duplicate entry
- Maintains **accountability** through session logging and heartbeat tracking
- Supports **AI-assisted grading** via photo upload for faster scoring

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| **Live Dashboard** | At-a-glance cards for total students, present count, modules, activities |
| **Attendance Submission** | Mark and submit daily attendance with date-lock |
| **Class Records** | Record and review module/activity submissions per student |
| **Synced Grading** | Grade weights set by teacher applied consistently — no hardcoded values |
| **Photo-to-AI Grading** | Upload a photo; AI extracts scores and fills the record automatically |
| **Scoped Access** | Each facilitator only sees their assigned section's data |
| **Push Notifications** | Web Push (VAPID) delivered through a service worker |
| **Installable PWA** | Add-to-home-screen with manifest, icons, and splash screen |
| **Session Tracking** | Heartbeat-based logging for facilitator activity accountability |

---

## 🛠️ Tech Stack

```
┌─────────────────────────────────────────────────┐
│          Frontend (Vercel — static site)          │
│  HTML5 · CSS3 · Vanilla JavaScript · PWA         │
│  Service Worker · Web Push API · Font Awesome    │
└─────────────────────┬───────────────────────────┘
                      │ HTTPS / Supabase JS Client
                      ▼
┌─────────────────────────────────────────────────┐
│               Backend / Database                  │
│  Supabase PostgreSQL (Auth, real-time queries)   │
└─────────────────────────────────────────────────┘
```

**Frontend:** Pure HTML/CSS/JS static site, served via Vercel. No build step required. PWA-enabled with service worker for push notifications and offline shell.

**Note:** The `backend/` and `web/` directories contain an in-progress migration to **Next.js + FastAPI** (matching the teacher-panel stack). The legacy static app remains the live deployment until the migration is promoted.

---

## 📁 Project Structure

```
faci-panel/
├── index.html         # Facilitator dashboard (stats overview)
├── login.html         # Authentication
├── profile.html       # Facilitator profile
├── attendance.html    # Attendance submission
├── record.html        # Class records (modules & activities)
├── js/                # JavaScript modules
│   ├── grading.js     # Shared grade-weight loading & computation
│   ├── faci-session.js# Session heartbeat & activity logging
│   ├── mjr-notify.js  # Web Push notification client
│   ├── mjr-sw.js      # Push service worker
│   └── mjr-guard.js   # Client-side protection & clean-URL links
├── images/            # App icons and assets
├── api/               # Legacy Vercel serverless function
├── web/               # Next.js migration (in progress)
├── backend/           # FastAPI migration (in progress)
├── manifest.json      # PWA manifest
└── vercel.json        # Vercel routing config
```

---

## 🚀 Running Locally

This is a static site backed by Supabase. Any static file server works:

```bash
# from the project root:
npx serve .
# or
python3 -m http.server 8000
```

Open the served URL (e.g. `http://localhost:8000/login.html`).

---

## 🌐 Live Deployment

| Property | URL |
|----------|-----|
| Frontend | [https://faci-panel.vercel.app](https://faci-panel.vercel.app) |
| Teacher Portal | [https://www.acadtrack.asia](https://www.acadtrack.asia) |

---

## 👥 Team

**MJR Vertext** — presented at Innovex 2026, Indonesia

| Member | Role |
|--------|------|
| Mark Frizas | Full-Stack Developer |
| Rutz Cabrera | Frontend Developer |
| Jean Rose Banay | Backend Developer |

---

## 📄 License

MIT
