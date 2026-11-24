"use client";

import { CatalogEditor } from "@/components/settings/catalog-editor";
import { SectionGate } from "@/components/settings/nav";
import { PageHeader } from "@/components/ui/primitives";

/** Beállítások > Érkezési csatornák (v1.2). */
export default function ChannelsSettingsPage() {
  return (
    <>
      <PageHeader title="Érkezési csatornák" description="Honnan érkezett az ügyfél (weboldal, ajánlás, levél stb.). A csatorna az új ügyfél felvételénél kötelező, az adatlapon szerkeszthető, a listában és az exportban szűrhető. Nem azonos az Adatforrással. Törlés helyett archiválás; az „Ismeretlen” rendszerelem nem archiválható." />
      <SectionGate permissions={["crm.settings.manage"]}><CatalogEditor kind="acquisition-channels" /></SectionGate>
    </>
  );
}
