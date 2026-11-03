"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingState } from "@/components/ui/primitives";

/** Beállítások > Feladatkezelés: az első alszakaszra (Feladattípusok) visz. */
export default function TasksSettingsHome() {
  const router = useRouter();
  useEffect(() => { router.replace("/settings/tasks/types"); }, [router]);
  return <LoadingState />;
}
