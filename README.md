# 📋 Facilitator Dashboard

**The mobile-first companion portal for the AcadTrack academic management system.**

The **Facilitator Dashboard** is a Progressive Web App that lets facilitators manage their assigned section — submitting attendance, recording class activities, and monitoring student performance in real time. It shares a single source of truth with the [Teacher Management Portal](https://github.com/mark-12-fr/teacher-panel), so grades and records stay perfectly in sync.

🔗 **Live App:** [faci-panel.vercel.app](https://faci-panel.vercel.app)

---

## ✨ Key Features

- **Live Dashboard** — At-a-glance cards for total students, present count, modules, and activities for the assigned section, loaded in real time from the database.
- **Attendance Submission** — Mark and submit daily attendance for the facilitator's section.
- **Class Records** — Record and review module and activity submissions per student.
- **Synced Grading** — Grade weights (Written Work, Performance Tasks, Exam, Attendance) and passing marks are configured by the teacher and applied consistently here — no hardcoded values, so the facilitator and teacher panels never disagree.
- **Scoped Access** — Each facilitator only sees the students and data belonging to their assigned teacher/section.
- **Push Notifications** — Web Push (VAPID) notifications delivered through a service worker, working even when the tab is closed or the app is minimized.
- **Installable PWA** — Add-to-home-screen support with a custom manifest, app icons, splash screen, and offline-ready shell.
- **Session Tracking** — Heartbeat-based session logging keeps facilitator activity accountable.

---

## 🛠️ Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Backend / Data | [Supabase](https://supabase.com) (PostgreSQL, Auth, real-time queries) |
| Notifications | Web Push API + Service Worker (VAPID) |
| PWA | Web App Manifest, Service Worker |
| Icons | Font Awesome |
| Hosting | [Vercel](https://vercel.com) (`cleanUrls` routing) |

---

## 📂 Project Structure

```
faci-panel/
├── index.html         # Facilitator dashboard (stats overview)
├── login.html         # Authentication
├── profile.html       # Facilitator profile
├── attendance.html    # Attendance submission
├── record.html        # Class records (modules & activities)
├── grading.js         # Shared grade-weight loading & computation
├── faci-session.js    # Session heartbeat & activity logging
├── mjr-notify.js      # Web Push notification client
├── mjr-sw.js          # Push service worker
├── mjr-guard.js       # Client-side protection & clean-URL links
├── manifest.json      # PWA manifest
└── vercel.json        # Vercel routing config
```

---

## 🚀 Running Locally

This is a static site backed by Supabase. Any static file server works:

```bash
# clone, then from the project root:
npx serve .
# or
python3 -m http.server 8000
```

Then open the served URL (e.g. `http://localhost:8000/login.html`). The app talks to the configured Supabase project for data and authentication.

> **Note:** This is the facilitator-facing portal of AcadTrack. It is designed to be used alongside the Teacher Management Portal, which administers subjects, sections, and grade configurations.

---

## 👤 Author

**Mark Frizas** — Full-Stack Developer
[GitHub](https://github.com/mark-12-fr) · [LinkedIn](https://linkedin.com/in/mark-frizas-5034a6346/)
