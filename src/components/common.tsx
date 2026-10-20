"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { CRM_STATUS_LABELS, RESTRICTION_LABELS } from "@/domain/constants";
import { customerName, statusOf } from "@/domain/logic";
import type { CrmStatus, Customer, DataSnapshot } from "@/domain/types";
import { Badge, LoadingState, type Tone } from "./ui/primitives";

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

const CRM_TONE: Record<CrmStatus, Tone> = {
  waiting_for_contact: "neutral", contact: "info", relationship: "info", meeting: "accent", account_opening: "accent", capital_placed: "ok", lost: "danger",
};
export const CrmStatusBadge = ({ status }: { status: CrmStatus }) => <Badge tone={CRM_TONE[status]}>{CRM_STATUS_LABELS[status]}</Badge>;
export const TypeBadge = ({ type }: { type: Customer["type"] }) => <Badge tone="accent">{type === "company" ? "Cég" : "Magánszemély"}</Badge>;

/** Rövid, csak olvasható jelzés az aktív tiltakozásról/korlátozásról (nem compliance-panel). */
export const RestrictedBadge = ({ customer }: { customer: Customer }) => (customer.restriction ? <Badge tone="danger" className="shrink-0"><span title={`${RESTRICTION_LABELS[customer.restriction.kind]}: ${customer.restriction.note}`}>Megkeresés korlátozva</span></Badge> : null);
export { statusOf };

export function CustomerLink({ customer, id, data }: { customer?: Customer; id?: string; data?: DataSnapshot }) {
  const c = customer ?? data?.customers.find((x) => x.id === id);
  if (!c) return <span className="text-ink-muted">Ismeretlen ügyfél</span>;
  return <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent underline-offset-2 hover:underline">{customerName(c)}</Link>;
}
