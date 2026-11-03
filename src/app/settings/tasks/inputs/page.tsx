"use client";

import { CatalogEditor } from "@/components/settings/catalog-editor";
import { SectionGate } from "@/components/settings/nav";
import { PageHeader } from "@/components/ui/primitives";

/** Beállítások > Feladatkezelés > Input-opciók (SET-006). */
export default function TaskInputsPage() {
  return (
    <>
      <PageHeader title="Input-opciók" description="Az új feladat választható Input-értékei. Rövid megjegyzés csak a megjegyzést engedő opciókhoz adható. A feladat lezárásának szabad szöveges Outputja továbbra is kötelező." />
      <SectionGate permissions={["crm.settings.manage"]}><CatalogEditor kind="task-inputs" /></SectionGate>
    </>
  );
}
