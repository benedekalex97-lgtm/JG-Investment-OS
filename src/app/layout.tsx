import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { CrmDataProvider } from "@/data/store";
import "./globals.css";

export const metadata: Metadata = {
  title: "JG Investment OS — v0.6",
  description: "Belső CRM pilot. Bejelentkezés szükséges.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="hu">
      <body className="min-h-screen bg-canvas antialiased">
        <CrmDataProvider>
          <AppShell>{children}</AppShell>
        </CrmDataProvider>
      </body>
    </html>
  );
}
