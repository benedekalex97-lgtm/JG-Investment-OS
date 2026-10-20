"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DATA_TABS } from "@/components/data/data-nav";
import { LoadingState, PageHeader } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";

/** Adatkezelés kezdőpont: az első jogosult aloldalra visz; jogosultság nélkül egyértelmű üzenet. */
export default function DataHome() {
  const router = useRouter();
  const { permissions, phase } = useCrmData();
  const first = DATA_TABS.find((t) => permissions.includes(t.permission));
  useEffect(() => {
    if (phase === "ready" && first) router.replace(first.href);
  }, [phase, first, router]);
  if (phase === "ready" && !first) {
    return (
      <>
        <PageHeader title="Adatkezelés" />
        <p role="alert" className="rounded-md bg-warn-soft p-4 text-sm text-warn" data-testid="no-permission">Ehhez a művelethez nincs jogosultságod.</p>
      </>
    );
  }
  return <LoadingState />;
}
