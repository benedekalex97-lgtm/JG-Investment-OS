"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSettingsSections } from "@/components/settings/nav";
import { Card, ErrorState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { getJson } from "@/data/data-client";
import { formatDateTime } from "@/lib/format";

interface Overview {
  permissions: string[];
  users: { active: number; inactive: number; settingsAdmins: number; userAdmins: number; auditReaders: number } | null;
  lastChangeAt: string | null;
  catalogs: Record<"pipeline" | "taskTypes" | "taskInputs", { active: number; archived: number }>;
  imports: { commitEnabled: boolean; visible: boolean; last: { at: string | null; status: string } | null };
}

/**
 * Beállítások > Áttekintés (SET-001). Minden szám a szerver valós adatbázis- és rendszerállapotából jön (/api/settings/overview);
 * a felhasználói számokat csak adminisztratív joggal látja a felhasználó. Innen minden elérhető szakasz megnyitható.
 */
function Stats({ o }: { o: Overview }) {
  const stats: { label: string; value: string; hint?: string }[] = [];
  if (o.users) {
    stats.push({ label: "Aktív felhasználók", value: String(o.users.active), hint: o.users.inactive ? `${o.users.inactive} letiltott` : undefined });
    stats.push({ label: "Adminjoggal rendelkezők", value: String(Math.max(o.users.settingsAdmins, o.users.userAdmins)), hint: `beállítások: ${o.users.settingsAdmins} · felhasználók: ${o.users.userAdmins}` });
  }
  stats.push({ label: "Aktív Pipeline-státuszok", value: String(o.catalogs.pipeline.active), hint: o.catalogs.pipeline.archived ? `${o.catalogs.pipeline.archived} archivált` : undefined });
  stats.push({ label: "Aktív feladattípusok", value: String(o.catalogs.taskTypes.active), hint: o.catalogs.taskTypes.archived ? `${o.catalogs.taskTypes.archived} archivált` : undefined });
  if (o.users) stats.push({ label: "Utolsó konfigurációmódosítás", value: o.lastChangeAt ? formatDateTime(o.lastChangeAt) : "Még nem volt" });
  stats.push({
    label: "Adatimport",
    value: o.imports.commitEnabled ? "Véglegesítés engedélyezve" : "Véglegesítés kikapcsolva",
    hint: o.imports.visible ? (o.imports.last?.at ? `Utolsó import: ${formatDateTime(o.imports.last.at)} (${o.imports.last.status === "completed" ? "véglegesítve" : "előnézet"})` : "Még nem volt import") : "Az előnézet a jogosultaknak elérhető; a véglegesítés szerveroldali kapcsolója nem módosítható a felületről.",
  });
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Állapot">
      {stats.map((s) => (
        <li key={s.label} className="rounded-lg bg-surface p-4 ring-1 ring-line" data-testid="settings-stat">
          <p className="text-[13px] text-ink-muted">{s.label}</p>
          <p className="mt-1 break-words text-xl font-semibold tabular-nums text-ink">{s.value}</p>
          {s.hint ? <p className="mt-1 break-words text-xs text-ink-muted">{s.hint}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export default function SettingsOverviewPage() {
  const sections = useSettingsSections().filter((s) => s.href !== "/settings");
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      const r = await getJson<Overview>("/api/settings/overview");
      if (r.ok) setO(r.value); else setError(r.message);
    })();
  }, []);
  return (
    <>
      <PageHeader title="Beállítások" description="A CRM üzleti konfigurációja és a hozzáférések kezelése. Minden módosítás jogosultsághoz kötött és naplózott." />
      <div className="space-y-6">
        {error ? <ErrorState message={error} /> : o ? <Stats o={o} /> : <LoadingState />}
        <section aria-labelledby="szakaszok">
          <h2 id="szakaszok" className="mb-3 text-sm font-semibold text-ink">Szakaszok</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {sections.map((s) => {
              const Icon = s.icon;
              return (
                <li key={s.href}>
                  <Card className="h-full">
                    <Link href={s.href} className="flex h-full items-start gap-3 rounded-lg p-4 hover:bg-accent-soft/50">
                      <span className="mt-0.5 rounded-md bg-accent-soft p-2 text-accent"><Icon /></span>
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{s.group ? `${s.group} · ` : ""}{s.label}</span>
                        <span className="mt-0.5 block text-[13px] text-ink-muted">{s.description}</span>
                        <span className="mt-2 block text-[13px] font-medium text-accent">Megnyitás →</span>
                      </span>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
        <p className="text-[13px] text-ink-muted">
          A rendszerüzemeltetési műveletek (adatbázis-mentés és -visszaállítás, migráció, infrastruktúra és titkok) nem a CRM felületén érhetők el:
          ezeket kizárólag az üzemeltető végezheti a külön jogosult parancssori eszközzel.
        </p>
      </div>
    </>
  );
}
