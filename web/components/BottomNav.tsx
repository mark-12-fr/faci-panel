"use client";

// Fixed bottom navigation shared by every page. Uses next/link for smooth
// client-side navigation (no full page reload flash) while keeping the active
// item's icon spring and a press (tap) scale on every nav icon.

import Link from "next/link";

export type NavKey = "home" | "attendance" | "records" | "profile";

const ITEMS: { key: NavKey; href: string; icon: string; label: string }[] = [
  { key: "home", href: "/", icon: "fa-house", label: "Home" },
  { key: "attendance", href: "/attendance", icon: "fa-calendar-check", label: "Attendance" },
  { key: "records", href: "/record", icon: "fa-chart-column", label: "Records" },
  { key: "profile", href: "/profile", icon: "fa-circle-user", label: "Profile" },
];

export default function BottomNav({ active }: { active: NavKey }) {
  return (
    <nav className="bottom-nav">
      {ITEMS.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={`nav-item${active === item.key ? " active" : ""}`}
        >
          <i className={`fa-solid ${item.icon}`} />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
