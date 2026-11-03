"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode, SVGProps } from "react";
import { useCrmData } from "@/data/store";
import { cn } from "@/lib/cn";

/**
 * Beállítások (v1.1, SET-001) szerkezete és jogosultsága. A menü csak azokat a szakaszokat mutatja, amelyekhez a felhasználónak joga
 * van; a szerver minden kérésnél ettől függetlenül, frissen ellenőriz (a felület nem biztonsági határ). Működés nélküli menüpont nincs.
 */
const Svg = ({ children, ...p }: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>{children}</svg>
);
export const SlidersIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></Svg>;
const UsersIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2" /></Svg>;
const ColumnsIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></Svg>;
const ListIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" /></Svg>;
const DatabaseIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" /><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" /></Svg>;
const HistoryIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 4v4h4M12 7.5V12l3 2" /></Svg>;
const HomeIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></Svg>;

export interface SettingsSection {
  href: string;
  label: string;
  description: string;
  /** A szakaszhoz szükséges jogok közül bármelyik (üres = bármely CRM-jog). */
  permissions: string[];
  group?: "Feladatkezelés" | "Adatkezelés";
  icon: (p: SVGProps<SVGSVGElement>) => ReactNode;
}

export const CRM_PERMISSION_KEYS = ["crm.customer.import", "crm.customer.export", "crm.import.history.read", "crm.settings.manage", "crm.users.manage", "crm.settings.audit.read"] as const;

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { href: "/settings", label: "Áttekintés", description: "A beállítások állapota és a szakaszok.", permissions: [], icon: HomeIcon },
  { href: "/settings/users", label: "Felhasználók és jogosultságok", description: "Meglévő felhasználók és a kiosztott CRM-jogosultságok kezelése.", permissions: ["crm.users.manage"], icon: UsersIcon },
  { href: "/settings/pipeline", label: "Pipeline-státuszok", description: "Státuszok neve, színe, sorrendje, archiválása.", permissions: ["crm.settings.manage"], icon: ColumnsIcon },
  { href: "/settings/tasks/types", label: "Feladattípusok", description: "Az új feladatnál választható típusok.", permissions: ["crm.settings.manage"], group: "Feladatkezelés", icon: ListIcon },
  { href: "/settings/tasks/inputs", label: "Input-opciók", description: "Az új feladat választható Input-értékei.", permissions: ["crm.settings.manage"], group: "Feladatkezelés", icon: ListIcon },
  { href: "/settings/data/import", label: "Importálás", description: "Ügyféladatok ellenőrzött importja Excel- vagy CSV-fájlból.", permissions: ["crm.customer.import"], group: "Adatkezelés", icon: DatabaseIcon },
  { href: "/settings/data/export", label: "Exportálás", description: "Szűrt ügyféllista letöltése (CSV/XLSX).", permissions: ["crm.customer.export"], group: "Adatkezelés", icon: DatabaseIcon },
  { href: "/settings/data/history", label: "Importelőzmények", description: "Az importok naplója személyes adat nélkül.", permissions: ["crm.import.history.read"], group: "Adatkezelés", icon: DatabaseIcon },
  { href: "/settings/audit", label: "Változásnapló", description: "Ki, mikor, milyen beállítást vagy jogosultságot módosított.", permissions: ["crm.settings.audit.read"], icon: HistoryIcon },
];

export const canSee = (s: SettingsSection, permissions: string[]) =>
  s.permissions.length === 0 ? CRM_PERMISSION_KEYS.some((p) => permissions.includes(p)) : s.permissions.some((p) => permissions.includes(p));
export const hasAnySettingsAccess = (permissions: string[]) => CRM_PERMISSION_KEYS.some((p) => permissions.includes(p));

export function useSettingsSections(): SettingsSection[] {
  const { permissions } = useCrmData();
  return SETTINGS_SECTIONS.filter((s) => canSee(s, permissions));
}

/** Beállítások almenü: mobilon vízszintesen görgethető sáv, desktopon oldalsó lista csoportokkal. Billentyűzettel bejárható linkek. */
export function SettingsNav() {
  const path = usePathname();
  const sections = useSettingsSections();
  const active = (href: string) => (href === "/settings" ? path === "/settings" : path === href || path.startsWith(`${href}/`));
  return (
    <nav aria-label="Beállítások" className="lg:sticky lg:top-4">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {sections.map((s, i) => {
          const header = s.group && s.group !== sections[i - 1]?.group ? s.group : undefined;
          const Icon = s.icon;
          return (
            <li key={s.href} className="shrink-0 lg:shrink">
              {header ? <p className="hidden px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle lg:block">{header}</p> : null}
              <Link href={s.href} aria-current={active(s.href) ? "page" : undefined}
                className={cn("flex min-h-11 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium ring-1 lg:whitespace-normal lg:ring-0",
                  s.group && "lg:pl-6",
                  active(s.href) ? "bg-accent-soft text-accent ring-accent/40" : "text-ink-muted ring-line hover:bg-surface-muted hover:text-ink")}>
                <Icon className="hidden shrink-0 lg:block" />
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Jogosultság-kapu egy beállítási szakaszhoz (a szerveroldali tiltás ettől független és kötelező). */
export function SectionGate({ permissions, children }: { permissions: string[]; children: ReactNode }) {
  const { permissions: mine, phase } = useCrmData();
  if (phase !== "ready") return null;
  if (!permissions.some((p) => mine.includes(p))) {
    return <p role="alert" className="rounded-md bg-warn-soft p-4 text-sm text-warn" data-testid="no-permission">Ehhez a művelethez nincs jogosultságod.</p>;
  }
  return <>{children}</>;
}
