import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { DemoDataProvider } from "@/data/store";
import "./globals.css";

export const metadata: Metadata = {
  title: "JG Investment OS — v0.5 (demó)",
  description: "Belső CRM demó fiktív adatokkal. Nem éles rendszer.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="hu">
      <body className="min-h-screen bg-canvas antialiased">
        <DemoDataProvider>
          <AppShell>{children}</AppShell>
        </DemoDataProvider>
      </body>
    </html>
  );
}
