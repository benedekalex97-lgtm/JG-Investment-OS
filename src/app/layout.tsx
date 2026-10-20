import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { TaskModalProvider } from "@/components/tasks";
import { CrmDataProvider } from "@/data/store";
import "./globals.css";

export const metadata: Metadata = {
  title: "JG Investment OS — v1.0",
  description: "Belső CRM pilot. Bejelentkezés szükséges.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="hu">
      <body className="min-h-screen bg-canvas antialiased">
        <CrmDataProvider>
          <TaskModalProvider>
            <AppShell>{children}</AppShell>
          </TaskModalProvider>
        </CrmDataProvider>
      </body>
    </html>
  );
}
