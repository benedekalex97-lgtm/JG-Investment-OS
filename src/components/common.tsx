"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { RESTRICTION_LABELS } from "@/domain/constants";
import { findStatus, type CrmConfig } from "@/domain/config";
import { customerName, statusOf } from "@/domain/logic";
import type { CrmStatus, Customer, DataSnapshot } from "@/domain/types";
import { Badge, LoadingState } from "./ui/primitives";

/** Betöltési állapot kezelése: amíg nincs snapshot, skeletont mutat. */
export function DataGate({ children }: { children: (data: DataSnapshot) => ReactNode }) {
  const { data } = useCrmData();
  if (!data) return <LoadingState />;
  return <>{children(data)}</>;
}

/** A rögzítő neve az azonosítóból (a felhasználólista a szerverről jön; ismeretlen azonosító esetén az azonosító látszik). */
export function useUserName(): (id: string) => string {
  const { users } = useCrmData();
  return (id) => users.find((u) => u.id === id)?.name ?? id;
}

/** Üres konfiguráció: amíg a szerver konfigurációja nem töltődött be, a felület nem talál ki státuszt/típust. */
const NO_CONFIG: CrmConfig = { statuses: [], taskTypes: [], taskInputs: [] };

/**
 * A CRM aktuális konfigurációja (v1.1): a szerver snapshotjával együtt érkezik az adatbázisból, így a kliens ugyanazt használja, mint
 * a szerver. Az adminmódosítás után a snapshot frissítése (refresh) a nézeteket is frissíti.
 */
export function useCrmConfig(): CrmConfig {
  const { data } = useCrmData();
  return data?.config ?? NO_CONFIG;
}

/** Státuszjelvény a katalógus nevével és színével; archivált státusznál jól látható jelzéssel. Ismeretlen kulcs: maga a kulcs. */
export function CrmStatusBadge({ status, config }: { status: CrmStatus; config: CrmConfig }) {
  const def = findStatus(config, status);
  return <Badge tone={def?.color ?? "neutral"}>{def?.label ?? status}{def && !def.isActive ? <span className="ml-1 font-normal">(archivált)</span> : null}</Badge>;
}

/** Választólista-felirat: archivált elemnél jelzéssel. */
export const optionLabel = (d: { label: string; isActive: boolean }) => (d.isActive ? d.label : `${d.label} (archivált)`);
export const TypeBadge = ({ type }: { type: Customer["type"] }) => <Badge tone="accent">{type === "company" ? "Cég" : "Magánszemély"}</Badge>;

/** Rövid, csak olvasható jelzés az aktív tiltakozásról/korlátozásról (nem compliance-panel). */
export const RestrictedBadge = ({ customer }: { customer: Customer }) => (customer.restriction ? <Badge tone="danger" className="shrink-0"><span title={`${RESTRICTION_LABELS[customer.restriction.kind]}: ${customer.restriction.note}`}>Megkeresés korlátozva</span></Badge> : null);
export { statusOf };

export function CustomerLink({ customer, id, data }: { customer?: Customer; id?: string; data?: DataSnapshot }) {
  const c = customer ?? data?.customers.find((x) => x.id === id);
  if (!c) return <span className="text-ink-muted">Ismeretlen ügyfél</span>;
  return <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent underline-offset-2 hover:underline">{customerName(c)}</Link>;
}
