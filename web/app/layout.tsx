import type { Metadata, Viewport } from "next";

// Self-hosted fonts + icons (no CDN / CSP concerns, reproducible builds).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./globals.css";

import Guard from "@/components/Guard";

export const metadata: Metadata = {
  title: "Facilitator | Management System",
  description: "AcadTrack Facilitator panel",
  manifest: "/manifest.json",
  icons: {
    icon: "/logo.jpg",
    apple: "/logo.jpg",
  },
};

export const viewport: Viewport = {
  themeColor: "#3b82f6",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Guard />
        {children}
      </body>
    </html>
  );
}
