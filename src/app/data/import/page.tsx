"use client";

import { DataTabs, PermissionGate } from "@/components/data/data-nav";
import { ImportWizard } from "@/components/data/import-wizard";
import { PageHeader } from "@/components/ui/primitives";

export default function ImportPage() {
  return (
    <>
      <PageHeader title="Adatkezelés" description="Ügyféladatok ellenőrzött importja Excel- vagy CSV-fájlból. Mentés csak az előnézet és a kifejezett jóváhagyás után történik." />
      <DataTabs />
      <PermissionGate permission="crm.customer.import">
        <ImportWizard />
      </PermissionGate>
    </>
  );
}
