"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DataGate, LifecycleBadge, TypeBadge, userName } from "@/components/common";
import { FilterSelect } from "@/components/ui/form";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS, DEMO_USERS, LIFECYCLE_LABELS, LIFECYCLE_STATUSES } from "@/domain/constants";
import { customerName, matchingContacts, searchCustomers, type CustomerFilter } from "@/domain/logic";
import type { DataSnapshot } from "@/domain/types";

function CustomerTable({ data }: { data: DataSnapshot }) {
  const [f, setF] = useState<Required<CustomerFilter>>({ query: "", type: "", status: "", ownerId: "" });
  const rows = useMemo(
    () => searchCustomers(data, f).sort((a, b) => customerName(a).localeCompare(customerName(b), "hu")),
    [data, f],
  );
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-xs font-medium text-ink-muted sm:col-span-2 lg:col-span-1">
          Keresés (név, cégnév, kapcsolattartó)
          <input type="search" value={f.query} onChange={(e) => set("query", e.target.value)} placeholder="pl. Minta" className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
        </label>
        <FilterSelect label="Típus" value={f.type} onChange={(e) => set("type", e.target.value as typeof f.type)}>
          <option value="">Összes</option>
          {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>)}
        </FilterSelect>
        <FilterSelect label="Státusz" value={f.status} onChange={(e) => set("status", e.target.value as typeof f.status)}>
          <option value="">Összes</option>
          {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
        </FilterSelect>
        <FilterSelect label="Felelős" value={f.ownerId} onChange={(e) => set("ownerId", e.target.value)}>
          <option value="">Összes</option>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </FilterSelect>
      </div>
      <p className="px-4 pt-3 text-[13px] text-ink-muted" role="status" aria-live="polite">{rows.length} találat</p>
      {rows.length === 0 ? (
        <EmptyState title="Nincs a szűrésnek megfelelő ügyfél" hint="Módosítsd a keresést vagy a szűrőket." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Ügyfelek</caption>
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Név</th>
                <th scope="col" className="px-4 py-2 font-medium">Típus</th>
                <th scope="col" className="px-4 py-2 font-medium">Státusz</th>
                <th scope="col" className="px-4 py-2 font-medium">Felelős</th>
                <th scope="col" className="px-4 py-2 font-medium">Elérhetőség</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                const via = c.type === "company" ? matchingContacts(data, c.id, f.query) : [];
                return (
                  <tr key={c.id} className="align-top hover:bg-canvas">
                    <td className="max-w-xs px-4 py-3">
                      <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent hover:underline">{customerName(c)}</Link>
                      {via.length && !customerName(c).toLowerCase().includes(f.query.toLowerCase()) ? (
                        <p className="text-xs text-ink-muted">Találat kapcsolattartóra: {via.map((k) => `${k.lastName} ${k.firstName}`).join(", ")}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3"><TypeBadge type={c.type} /></td>
                    <td className="px-4 py-3"><LifecycleBadge status={c.lifecycleStatus} /></td>
                    <td className="px-4 py-3">{userName(c.ownerId)}</td>
                    <td className="break-all px-4 py-3 text-ink-muted">{c.email ?? c.phone ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function CustomersPage() {
  return (
    <>
      <PageHeader title="Ügyfelek" description="Magánszemélyek és cégek. A céges kapcsolattartók a cég profiljában kezelhetők, nem külön ügyfelek." actions={<LinkButton href="/customers/new">Új ügyfél</LinkButton>} />
      <DataGate>{(data) => <CustomerTable data={data} />}</DataGate>
    </>
  );
}
