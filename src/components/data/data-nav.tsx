"use client";

import type { ReactNode } from "react";
import { useCrmData } from "@/data/store";

/**
 * Az Adatkezelés aloldalai és a szükséges jogosultság (v1.1-től a Beállítások > Adatkezelés alatt; a régi /data útvonalak ide
 * irányítanak). A menü csak a jogosult pontokat mutatja; a szerver ettől függetlenül, a v1.0 adatkezelési jogok szerint tilt.
 */
export const DATA_TABS = [
  { href: "/settings/data/import", label: "Importálás", permission: "crm.customer.import" },
  { href: "/settings/data/export", label: "Exportálás", permission: "crm.customer.export" },
  { href: "/settings/data/history", label: "Importelőzmények", permission: "crm.import.history.read" },
] as const;

export const hasAnyDataPermission = (permissions: string[]) => DATA_TABS.some((t) => permissions.includes(t.permission));

/** Jogosultság-kapu a felületen: jogosulatlan felhasználó nem látja a funkciót (a szerveroldali tiltás ettől független és kötelező). */
export function PermissionGate({ permission, children }: { permission: string; children: ReactNode }) {
  const { permissions, phase } = useCrmData();
  if (phase !== "ready") return null;
  if (!permissions.includes(permission)) {
    return <p role="alert" className="rounded-md bg-warn-soft p-4 text-sm text-warn" data-testid="no-permission">Ehhez a művelethez nincs jogosultságod.</p>;
  }
  return <>{children}</>;
}
