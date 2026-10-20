"use client";

import { CatalogEditor } from "@/components/settings/catalog-editor";
import { SectionGate } from "@/components/settings/nav";
import { PageHeader } from "@/components/ui/primitives";

/** Beállítások > Pipeline-státuszok (SET-004). */
export default function PipelineSettingsPage() {
  return (
    <>
      <PageHeader title="Pipeline-státuszok" description="A státuszok megnevezése, színe és sorrendje mindenhol érvényes (Pipeline, ügyféllista, ügyféladatlap, szűrők, export). Törlés helyett archiválás: az ügyfelek nem kerülnek át automatikusan másik státuszba." />
      <SectionGate permissions={["crm.settings.manage"]}><CatalogEditor kind="pipeline" /></SectionGate>
    </>
  );
}
