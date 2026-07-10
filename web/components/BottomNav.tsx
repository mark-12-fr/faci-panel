// Fixed bottom navigation shared by every page. Uses plain <a> (full reload)
// to match the original multi-page navigation and keep each route's scoped CSS
// clean. Styled by each page's own `.bottom-nav` / `.nav-item` rules.

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
        <a
          key={item.key}
          href={item.href}
          className={`nav-item${active === item.key ? " active" : ""}`}
        >
          <i className={`fa-solid ${item.icon}`} />
          {item.label}
        </a>
      ))}
    </nav>
  );
}
