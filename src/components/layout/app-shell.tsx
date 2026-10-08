"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import { cn } from "@/lib/cn";

export const NAV = [
  { href: "/", label: "Áttekintés" },
  { href: "/customers", label: "Ügyfelek" },
  { href: "/cases", label: "Ügyek" },
  { href: "/tasks", label: "Feladatok" },
  { href: "/activities", label: "Tevékenységek" },
] as const;

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

function NavLinks({ path, onNavigate, orientation }: { path: string; onNavigate?: () => void; orientation: "vertical" | "horizontal" }) {
  return (
    <ul className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : "flex-col")}>
      {NAV.map((n) => {
        const active = isActive(path, n.href);
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors",
                active ? "bg-on-carbon/10 text-on-carbon" : "text-on-carbon-muted hover:bg-on-carbon/5 hover:text-on-carbon",
              )}
            >
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand() {
  return (
    <Link href="/" className="block rounded-md px-3 py-1 text-on-carbon">
      <span className="block text-[15px] font-semibold tracking-tight">JG Investment OS</span>
      <span className="block text-xs text-on-carbon-muted">Foundation v0.1 · demó</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const { reset } = useDemoData();
  const current = NAV.find((n) => isActive(path, n.href))?.label ?? "";

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Ugrás a tartalomhoz
      </a>

      {/* Desktop oldalsáv */}
      <aside className="hidden bg-carbon p-3 lg:block">
        <div className="sticky top-3 flex h-[calc(100vh-1.5rem)] flex-col justify-between">
          <div className="space-y-6">
            <Brand />
            <nav aria-label="Fő navigáció"><NavLinks path={path} orientation="vertical" /></nav>
          </div>
          <p className="px-3 text-xs leading-relaxed text-on-carbon-muted">Csak demó. Fiktív adatok, nincs éles jogosultságkezelés.</p>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobil fejléc */}
        <div className="sticky top-0 z-30 bg-carbon lg:hidden">
          <div className="flex min-h-14 items-center justify-between px-3">
            <Brand />
            <button
              type="button"
              aria-expanded={open}
              aria-controls="mobile-nav"
              onClick={() => setOpen((v) => !v)}
              className="min-h-11 rounded-md px-3 text-sm font-medium text-on-carbon hover:bg-on-carbon/10"
            >
              {open ? "Bezár" : "Menü"}
            </button>
          </div>
          {open ? (
            <nav id="mobile-nav" aria-label="Fő navigáció (mobil)" className="border-t border-on-carbon/10 p-2">
              <NavLinks path={path} orientation="horizontal" onNavigate={() => setOpen(false)} />
            </nav>
          ) : null}
        </div>

        {/* Fejléc: oldaljelző + demó figyelmeztetés */}
        <div className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
            <p className="text-sm text-ink-muted">Aktuális oldal: <span className="font-medium text-ink">{current}</span></p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn">DEMÓ</span>
              <span>Fiktív adatok · a módosítások csak a böngészőfül munkamenetéig élnek</span>
              <button type="button" onClick={() => { if (window.confirm("Visszaállítod az eredeti demóadatokat?")) reset(); }} className="min-h-9 rounded-md px-2 font-medium text-accent underline underline-offset-2 hover:bg-accent-soft">
                Demóadat visszaállítása
              </button>
            </p>
          </div>
        </div>

        <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
