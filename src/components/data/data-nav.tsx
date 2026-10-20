"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { cn } from "@/lib/cn";

/** Az Adatkezelés aloldalai és a szükséges jogosultság (a menü csak a jogosult pontokat mutatja; a szerver ettől függetlenül tilt). */
export const DATA_TABS = [
  { href: "/data/import", label: "Importálás", permission: "crm.customer.import" },
  { href: "/data/export", label: "Exportálás", permission: "crm.customer.export" },
  { href: "/data/history", label: "Importelőzmények", permission: "crm.import.history.read" },
] as const;

export const hasAnyDataPermission = (permissions: string[]) => DATA_TABS.some((t) => permissions.includes(t.permission));

export function DataTabs() {
  const path = usePathname();
  const { permissions } = useCrmData();
  const tabs = DATA_TABS.filter((t) => permissions.includes(t.permission));
  return (
    <nav aria-label="Adatkezelés" className="mb-6 border-b border-line">
      <ul className="-mb-px flex flex-wrap gap-1">
        {tabs.map((t) => {
          const active = path === t.href;
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={cn("flex min-h-11 items-center border-b-2 px-3 text-sm font-medium", active ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink")}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Jogosultság-kapu a felületen: jogosulatlan felhasználó nem látja a funkciót (a szerveroldali tiltás ettől független és kötelező). */
export function PermissionGate({ permission, children }: { permission: string; children: ReactNode }) {
  const { permissions, phase } = useCrmData();
  if (phase !== "ready") return null;
  if (!permissions.includes(permission)) {
    return <p role="alert" className="rounded-md bg-warn-soft p-4 text-sm text-warn" data-testid="no-permission">Ehhez a művelethez nincs jogosultságod.</p>;
  }
  return <>{children}</>;
}
