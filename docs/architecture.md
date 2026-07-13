# AcadTrack — System Architecture

**Developer:** MJR Vertext — Mark Frizas, Rutz Cabrera, Jean Rose Banay\
**Presented at:** Innovex 2026, Indonesia\
**Live:** [faci-panel.vercel.app](https://faci-panel.vercel.app) (Facilitator) | [acadtrack.asia](https://www.acadtrack.asia) (Teacher)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [How the Facilitator Panel Works](#2-how-the-facilitator-panel-works)
3. [How the Teacher Panel Works](#3-how-the-teacher-panel-works)
4. [How the Two Panels Communicate](#4-how-the-two-panels-communicate)
5. [Data Flow for Key Features](#5-data-flow-for-key-features)
6. [Authentication Flow](#6-authentication-flow)
7. [Deployment Architecture](#7-deployment-architecture)
8. [Full Tech Stack Reference](#8-full-tech-stack-reference)

---

## 1. System Overview

AcadTrack is an **academic management system** composed of two independent web applications (Facilitator Panel and Teacher Panel) that share **one PostgreSQL database**. The facilitator panel gives co-teachers, assistants, and substitutes scoped access to their assigned section. The teacher panel gives educators full administrative control over all sections.

```
┌────────────────────────────────┐     ┌────────────────────────────────┐
│   FACILITATOR PANEL            │     │   TEACHER PANEL                │
│   (Static HTML or Next.js)     │     │   (Next.js + FastAPI)          │
│                                │     │                                │
│   Scoped access to assigned    │     │   Full CRUD control over       │
│   section only — attendance    │     │   sections, students,          │
│   submission, score entry,     │     │   grades, facilitators,        │
│   AI photo grading, push       │     │   subjects, AI assistant       │
├────────────────────────────────┤     ├────────────────────────────────┤
│  Frontend: Vercel              │     │  Frontend: Vercel              │
│  Backend:  Supabase (or Render)│     │  Backend:  Render              │
└──────────┬─────────────────────┘     └──────────┬─────────────────────┘
           │                                     │
           └──────────────┬──────────────────────┘
                          ▼
          ┌──────────────────────────────────────┐
          │        SUPABASE POSTGRESQL           │
          │                                      │
          │  sections  │  students               │
          │  class_records  │  attendance         │
          │  facilitators │  subjects             │
          │  profiles │  push_subscriptions       │
          │  facilitator_logs                     │
          └──────────────────────────────────────┘
```

**Why a separate facilitator panel?**

Facilitators (co-teachers, assistants, substitutes) should not have full teacher access. The facilitator panel enforces **scoped access** — each facilitator sees only their assigned section's students, can only submit attendance and record scores, and cannot modify settings, create accounts, or view other classes. This separation protects data integrity while enabling collaborative classroom management.

---

## 2. How the Facilitator Panel Works

### 2.1 Legacy Static App (Currently Live)

**Stack:** HTML5 + CSS3 + Vanilla JavaScript + Supabase JS Client

The legacy app is a **multi-page static site**. Each page is a standalone HTML file with inline JavaScript that connects directly to Supabase using the anon key.

**Pages:**

| Page | File | Purpose |
|------|------|---------|
| Login | `login.html` | Authenticate with account ID + password |
| Dashboard | `index.html` | Overview cards, class ranking, bottom drawers |
| Attendance | `attendance.html` | Mark P/A/L per student for a selected date |
| Class Records | `record.html` | Score grid + AI photo-to-score |
| Profile | `profile.html` | Avatar upload, co-facilitators, logout |

**How each page works:**

**Login (`login.html`):**
- Shows branded splash with spinner
- Auto-login if `localStorage.faci_id` exists
- **Two-path login**: Fast path queries Supabase `facilitators` table directly (avoids backend cold-start). Fallback POSTs to `api/faci/login` if bcrypt library didn't load.
- On success: stores faci session in localStorage, updates `last_login` and `status='Active'`, redirects to dashboard

**Dashboard (`index.html`):**
- Security guard checks localStorage for auth keys
- Fetches live facilitator profile from Supabase, sets greeting with facilitator name
- Resolves assigned section row (scoped by teacher_id to avoid cross-tenant conflicts)
- Loads per-subject grade weights from `subjects` table
- Calculates stats: total students, present count, submitted modules/activities
- Renders class performance ranking using the grading engine
- Bottom drawer system: tapping stat cards shows detailed lists

**Attendance (`attendance.html`):**
- Date picker (defaults to today, can't pick future)
- Student list fetched from Supabase `students` table for the section
- Each student card has Present/Absent/Late toggle buttons
- **Date lock**: if already submitted for that date, or date is in the past, buttons are disabled
- Submit: deletes all existing attendance rows for that date+section, then inserts new rows
- Realtime subscription: auto-reloads when teacher modifies attendance (with toast notification)

**Class Records (`record.html`):**
- One row per student with 25 module columns + 10 activity columns + AT/PT1/PT2/QE
- **Quarter carry-over**: if a field is empty in current quarter, shows previous quarter's value (read-only)
- Drawer editor: clicking student name opens bottom drawer with grouped score inputs
- **AI Photo-to-Record**: upload a photo of a completed activity, AI extracts scores, review modal shows results, Apply fills the record
- Submit: upserts class_records for each student

**Profile (`profile.html`):**
- Shows name, section, subject, role
- Avatar upload: file picker → resize to 150px → JPEG → stored in `facilitators.avatar_url`
- Lists co-facilitators in the same section
- Logout: stamps session out, clears localStorage, redirects to login

**Key JavaScript modules (`js/`):**

| File | Purpose |
|------|---------|
| `grading.js` | Grade computation engine — computes WW, PT, QE, AT, and final grade using per-subject weights from teacher. Exposes `MJR_weightsFor()`, `MJR_finalGrade()`, etc. on `window`. |
| `faci-session.js` | Session heartbeats — opens `facilitator_logs` row on page load, stamps it on unload, sends heartbeat every 30s. Also verifies account still exists (force logout if deleted). |
| `mjr-notify.js` | Push notification client — registers service worker, subscribes to VAPID push, stores subscription in `push_subscriptions`, shows toasts. Includes `MJR_markLocalSave()` and `MJR_isLikelyOwnChange()` to skip self-echo on realtime updates. |
| `mjr-guard.js` | Client-side protection — blocks right-click, F12, Ctrl+Shift+I, Ctrl+U, Ctrl+S. Strips `.html` from links (Vercel cleanUrls). Masks URL with daily hash. |
| `mjr-sw.js` | Service worker — installs with `skipWaiting()`, activates with `clients.claim()`. Receives push events and shows OS notifications with title/body/icon. |

### 2.2 Next.js Migration (In Progress)

**Stack:** React 18 + Next.js 14 (App Router) + TypeScript

Located in the `web/` directory. This is a **faithful port** of the static app with improved architecture.

**Key differences from static app:**
1. **API calls go to FastAPI** (JWT-authenticated) instead of direct Supabase queries
2. **No Supabase JS client in browser** — the anon key is no longer exposed
3. **Server-side auth** — FastAPI verifies JWT and enforces scoping
4. **React state management** — `useState`, `useEffect`, `useMemo` replace DOM manipulation
5. **No realtime toasts** — Supabase Realtime is not available since the browser has no Supabase client

**Page mapping:**

| Next.js Route | Legacy File | Component |
|---------------|-------------|-----------|
| `/login` | login.html | `app/login/page.tsx` |
| `/` | index.html | `app/page.tsx` |
| `/attendance` | attendance.html | `app/attendance/page.tsx` |
| `/record` | record.html | `app/record/page.tsx` |
| `/profile` | profile.html | `app/profile/page.tsx` |

**Shared components:**
- `BottomNav.tsx` — fixed bottom navigation bar (Home, Attendance, Records, Profile)
- `CustomAlert.tsx` — reusable alert overlay with `useAlert()` hook
- `Guard.tsx` — port of `mjr-guard.js` (blocks DevTools, masks URLs)

**Libraries compared:**

| Static App | Next.js Port |
|------------|-------------|
| `grading.js` (vanilla JS) | `lib/grading.ts` (TypeScript, same logic) |
| `faci-session.js` | `hooks/useFaciSession.ts` (React hook) |
| `mjr-notify.js` | `lib/notify.ts` (registers push via FastAPI) |
| `mjr-guard.js` | `components/Guard.tsx` (React component) |
| Supabase JS direct queries | `lib/api.ts` (FastAPI calls) |

### 2.3 Backend

**Stack:** FastAPI + Python 3.12 + Uvicorn + SQLAlchemy 2 (async) + asyncpg

Located in the `backend/` directory. A FastAPI app that provides **JWT-authenticated endpoints** for the Next.js faci-panel and serves as fallback for the static app.

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/faci/login` | account_id + password → JWT + faci info |
| GET | `/api/faci/me` | Current facilitator profile |
| PATCH | `/api/faci/me` | Update own profile (name, avatar, password) |
| POST | `/api/faci/heartbeat` | Keep status Active / refresh last_login |
| GET | `/api/faci/section` | Resolved assigned section |
| GET | `/api/faci/students` | Students in the section |
| GET | `/api/faci/class-records` | Class records for the section |
| POST | `/api/faci/class-records` | Bulk upsert scores |
| GET | `/api/faci/attendance?date=X` | Attendance rows |
| POST | `/api/faci/attendance` | Replace a day's attendance |
| GET | `/api/faci/subjects` | Teacher's grade weights |
| GET | `/api/faci/teacher` | Teacher profile |
| GET | `/api/faci/co-facilitators` | Other facilitators in same section |
| POST | `/api/faci/session` | Open session log (time_in) |
| PATCH | `/api/faci/session/{id}` | Close session log (time_out) |
| GET | `/api/faci/push/vapid-public-key` | VAPID public key |
| POST | `/api/faci/push/subscribe` | Register push subscription |
| POST | `/api/vision-analyze` | Photo → attendance letters / record scores |

**Auth:** HS256 JWT with bcrypt password verification. The `get_current_faci` dependency resolves the JWT, looks up the facilitator, and returns 401/404 if missing or deleted.

**Data scoping:** Every data endpoint resolves the facilitator's section + teacher_id server-side, preventing cross-tenant access even if the JWT is valid.

---

## 3. How the Teacher Panel Works

See the full architecture document in the [teacher-panel repository](https://github.com/mark-12-fr/teacher-panel) for complete details. Here's a summary:

**Frontend:** React 18 + Next.js 14 (TypeScript) — deployed on Vercel at [acadtrack.asia](https://www.acadtrack.asia)

**Backend:** FastAPI (Python) — deployed on Render

**Key capabilities:**
- Sections CRUD with student roster management
- Attendance tracking with date-lock
- Class records with 25 modules + 10 activities + AT/PT/QE
- Performance analytics with charts and ranking
- Grading system with configurable weights
- Facilitator management with bcrypt passwords
- AI assistant (Groq + Gemini)
- Push notifications to facilitators

---

## 4. How the Two Panels Communicate

### 4.1 Shared Database (Primary)

Both panels read from and write to the **exact same PostgreSQL tables**. There is no API-to-API communication — they share state through the database.

```
Teacher writes a score     →   class_records table updated
Facilitator reads scores   →   reads from same table → sees teacher's change

Facilitator marks attendance → attendance table updated
Teacher views attendance     → reads from same table → sees facilitator's change
```

**This is the fundamental architectural decision** — instead of building synchronization between two services, both panels simply connect to the same database. Changes are instantly visible on the next data fetch.

### 4.2 Supabase Realtime (Bidirectional Live Sync)

Both panels subscribe to PostgreSQL changes using Supabase Realtime:

**Facilitator panel sees teacher changes:**
- Attendance page listens on `public:attendance` → toast + auto-reload when teacher modifies
- Records page listens on `public:class_records` → toast + auto-reload when teacher modifies

**Teacher panel sees facilitator changes:**
- Attendance grid listens on `attendance` channel → auto-updates cells
- Class record grid listens on `class_records` channel → reloads scores
- Dashboard listens on multiple tables → updates stat cards
- Performance page listens on `class_records` → refreshes charts

**Self-echo prevention:** Both panels track their own writes via `MJR_markLocalSave()` (static) or debounce timers (Next.js) and skip realtime-triggered reloads for changes they just made.

### 4.3 Push Notifications (Offline Alerts)

Web Push (VAPID) adds an offline real-time layer:

```
Teacher edits attendance/score
  → Supabase Database Webhook (configured in Supabase Dashboard)
  → Triggers Vercel serverless function /api/push-notify (teacher-panel)
  → Queries push_subscriptions for facilitators in that section
  → Sends VAPID Web Push via web-push library
  → Facilitator's service worker (mjr-sw.js) receives push event
  → OS-level notification appears — even if the tab is closed
```

The facilitator registers for push via `MJR_setupPush('faci', faciId)` (static) or `setupPush()` (Next.js), which stores the browser's subscription in `push_subscriptions`.

### 4.4 How They Stay in Sync — Summary

| Mechanism | Direction | Latency | Requires Tab Open? |
|-----------|-----------|---------|-------------------|
| Shared database | Both ways | Immediate (next fetch) | No |
| Supabase Realtime | Both ways | <1 second | Yes |
| Push notifications | Teacher → Facilitator | 1-5 seconds | No (service worker) |
| Manual refresh | Both ways | User-initiated | N/A |

---

## 5. Data Flow for Key Features

### 5.1 Facilitator Login Flow

```
facilitator enters account_id + password on login.html

Fast Path:
  → Browser queries Supabase facilitators table WHERE account_id = ?
  → Browser runs bcrypt.compareSync(password, stored_hash)
  → If match → stores session in localStorage
  → Updates facilitators.last_login and status='Active' via Supabase

Fallback Path (if bcrypt not loaded):
  → POST /api/faci/login { account_id, password }
  → FastAPI queries facilitators table, verifies bcrypt
  → Returns JWT + faci info
  → Stores session in localStorage

Redirects to index.html (dashboard)
```

### 5.2 Attendance Submission Flow

```
Facilitator selects date, marks P/A/L for each student
  → Clicks "Submit Attendance"
  → POST /api/faci/attendance (or Supabase direct in legacy)
  → Backend: DELETE existing rows for this date+section+teacher_id
  → Backend: INSERT new attendance rows for all students
  → Supabase Realtime triggers on teacher panel
  → Teacher's attendance grid auto-updates (shows toast if teacher is on the page)

If date is in the past or already submitted:
  → All buttons are disabled (date lock)
  → Only the teacher can override locked dates from the teacher panel
```

### 5.3 AI Photo Grading Flow

```
Facilitator on record.html:
  → Clicks camera icon → selects photo (camera or gallery)
  → Photo is down-sampled to JPEG (max 1800px longest side)
  → POST /api/vision-analyze { type: "record", imageBase64, mimeType, roster, targetFields }
  → Backend (FastAPI):
      1. Check: GEMINI_API_KEY or GROQ_API_KEY configured?
      2. Try Gemini vision (primary) - prompt instructs AI to extract scores from photo
      3. If Gemini fails → fallback to Groq vision
      4. For "record" type with explicit fields → two-pass consensus (two Gemini calls, merge results)
      5. Parse and sanitize JSON output
  → Returns { success: true, data: { scores: [...], confidence: "high"|"medium"|"low" } }
  → Frontend shows review modal with extracted scores
  → Facilitator can edit any extracted value
  → On "Apply" → POST /api/faci/class-records with the scores
  → Scores now visible to teacher via Realtime
```

### 5.4 Score Carry-Over Flow

```
Facilitator opens class records for Quarter 2:
  → Frontend fetches all class_records for the section (all quarters)
  → For each student:
      1. Find current quarter's record row
      2. For each score field:
         - If current quarter has a value → show it (editable)
         - If empty → search most recent previous quarter's value → show it (read-only, marked "carried-over")
      3. Carried-over values are excluded when submitting
  → This ensures facilitators never lose previous scores while editing only new ones
```

### 5.5 Session Tracking Flow

```
Facilitator opens any page (after login):
  → faci-session.js executes
  → Inserts row into facilitator_logs with { facilitator_id, time_in: now() }
  → Stores log_id in sessionStorage
  
Every 30 seconds:
  → Sends heartbeat: { status: 'Active', last_login: now() }
  → Also verifies account still exists in facilitators table
  
On tab close / navigate away:
  → Updates facilitator_logs row: SET time_out = now()
  → Sets facilitators.status = 'Inactive'
  
On return to tab (visibilitychange → visible):
  → Opens new session log row
  → Sets facilitators.status = 'Active'
```

---

## 6. Authentication Flow

### 6.1 Legacy Static App Auth

```
Login page loaded
  → Check localStorage for existing session (faci_id, faci_section)
  → If found → skip login, go straight to dashboard
  
User enters account_id + password
  → Fast path: query Supabase facilitators table by account_id
       → bcrypt.compare(password, stored hash) in-browser
       → On match: store faci_id, faci_name, faci_section, etc. in localStorage
       → Update status='Active', last_login in Supabase
  → Fallback: POST to /api/faci/login (if bcrypt library didn't load)
       → Backend verifies hash, returns JWT + faci info
       → Store in localStorage
  → Redirect to index.html

Every other page:
  → Security guard: if faci_id or faci_section missing → redirect to login.html
```

### 6.2 Next.js Migration Auth

```
Login page loaded
  → Check localStorage for existing session (faci_id + faci_token)
  → If found → skip login, redirect to /

User enters account_id + password
  → POST /api/faci/login { account_id, password }
  → FastAPI: bcrypt verify → generate JWT (HS256, 30 days)
  → Returns { jwt, faci: { id, name, section, subject, teacher_id, avatar_url } }
  → Frontend calls saveSession(faci, jwt) → stores in localStorage
  → Redirect to /

Every API call:
  → lib/api.ts reads faci_token from localStorage
  → Attaches Authorization: Bearer <token> header
  → On 401: calls clearSession(), redirects to /login
```

---

## 7. Deployment Architecture

```
                    ┌──────────────────────────────────┐
                    │         Vercel (CDN)             │
                    │                                  │
                    │  faci-panel.vercel.app           │
                    │    → Static HTML (currently)     │
                    │    → Next.js (future)            │
                    │    → cleanUrls, auto-SSL         │
                    │                                  │
                    │  References: acadtrack.asia      │
                    │    (teacher panel, separate repo)│
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────┴───────────────────┐
                    │      Render (Free Tier)          │
                    │                                  │
                    │  faci-panel-api (optional):      │
                    │    → FastAPI + Uvicorn           │
                    │    → Spins down after 15min      │
                    │                                  │
                    │  teacher-panel-api (existing):   │
                    │    → teacher-panel-hej2.onrender.com│
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────┴───────────────────┐
                    │       Supabase (Managed)         │
                    │                                  │
                    │  PostgreSQL 15 + pgBouncer       │
                    │  Realtime subscriptions          │
                    │  Database Webhooks               │
                    └──────────────────────────────────┘
```

**Current live deployment (legacy static app):**
- Frontend served by Vercel (static HTML/JS files in repo root)
- Backend powered by Supabase JS client in the browser (direct database access with anon key)
- Push notifications registered directly to Supabase

**Migration target (Next.js + FastAPI):**
- Frontend served by Vercel (Next.js app in `web/`)
- Backend on Render (FastAPI in `backend/`)
- All database access through FastAPI (server-side auth, no exposed keys)
- Push notifications through FastAPI

---

## 8. Full Tech Stack Reference

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** (Legacy) | HTML5 + CSS3 + Vanilla JS | Current live app |
| **Frontend** (Legacy) | Supabase JS Client | Direct database access |
| **Frontend** (Legacy) | Web Push API + Service Worker | Push notifications |
| **Frontend** (Next.js) | React 18 + Next.js 14 + TypeScript | Migration target |
| **Frontend** (Next.js) | Font Awesome | UI icons |
| **Backend** | FastAPI + Python 3.12 | REST API |
| **Backend** | Uvicorn | ASGI server |
| **Backend** | SQLAlchemy 2 (async) | ORM |
| **Backend** | asyncpg | PostgreSQL driver |
| **Backend** | PyJWT + bcrypt | Auth |
| **Backend** | httpx | AI provider requests |
| **Backend** | pywebpush | Web Push (VAPID) |
| **Database** | Supabase PostgreSQL 15 | Data storage |
| **Database** | Supabase Realtime | Live sync |
| **AI Vision** | Gemini (primary) | Photo-to-score extraction |
| **AI Vision** | Groq (fallback) | Photo-to-score extraction |
| **Hosting** | Vercel | Frontend |
| **Hosting** | Render | Backend (free tier) |
| **Hosting** | Supabase | Database |
