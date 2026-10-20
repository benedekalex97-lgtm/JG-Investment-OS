"use client";

import { CatalogEditor } from "@/components/settings/catalog-editor";
import { SectionGate } from "@/components/settings/nav";
import { PageHeader } from "@/components/ui/primitives";

/** Beállítások > Feladatkezelés > Feladattípusok (SET-005). */
export default function TaskTypesPage() {
  return (
    <>
      <PageHeader title="Feladattípusok" description="Az új feladatnál választható típusok. A már létrehozott feladatok a létrehozáskori nevüket megtartják; az archivált típus új feladathoz nem választható. A lezárás (Sikeres/Sikertelen, kötelező Output) változatlan." />
      <SectionGate permissions={["crm.settings.manage"]}><CatalogEditor kind="task-types" /></SectionGate>
    </>
  );
}
