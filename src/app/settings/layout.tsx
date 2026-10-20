"use client";

import type { ReactNode } from "react";
import { hasAnySettingsAccess, SettingsNav } from "@/components/settings/nav";
import { PageHeader } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";

/** Beállítások (v1.1): közös keret az almenüvel. Jogosultság nélkül egyértelmű üzenet (közvetlen URL-lel sem érhető el adat). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { permissions, phase } = useCrmData();
  if (phase === "ready" && !hasAnySettingsAccess(permissions)) {
    return (
      <>
        <PageHeader title="Beállítások" />
        <p role="alert" className="rounded-md bg-warn-soft p-4 text-sm text-warn" data-testid="no-permission">Ehhez a művelethez nincs jogosultságod.</p>
      </>
    );
  }
  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <div className="mb-6 lg:mb-0"><SettingsNav /></div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
