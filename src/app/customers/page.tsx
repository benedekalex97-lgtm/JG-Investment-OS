"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CrmStatusBadge, DataGate, RestrictedBadge, TypeBadge } from "@/components/common";
import { FilterSelect } from "@/components/ui/form";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { CRM_STATUSES, CRM_STATUS_LABELS, CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS } from "@/domain/constants";
import { customerName, matchingContacts, nextTask, searchCustomers, statusOf, type CustomerFilter } from "@/domain/logic";
import type { DataSnapshot } from "@/domain/types";
import { formatDate } from "@/lib/format";

function CustomerTable({ data }: { data: DataSnapshot }) {
  const [f, setF] = useState<Required<CustomerFilter>>({ query: "", type: "", crmStatus: "" });
  const rows = useMemo(() => searchCustomers(data, f).sort((a, b) => customerName(a).localeCompare(customerName(b), "hu")), [data, f]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3">
        <label className="block text-xs font-medium text-ink-muted sm:col-span-3">
          Keresés (név, cégnév, kapcsolati személy)
          <input type="search" value={f.query} onChange={(e) => set("query", e.target.value)} className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
        </label>
        <FilterSelect label="Típus" value={f.type} onChange={(e) => set("type", e.target.value as typeof f.type)}>
          <option value="">Összes</option>
          {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>)}
        </FilterSelect>
        <FilterSelect label="Kapcsolati státusz" value={f.crmStatus} onChange={(e) => set("crmStatus", e.target.value as typeof f.crmStatus)}>
          <option value="">Összes</option>
          {CRM_STATUSES.map((s) => <option key={s} value={s}>{CRM_STATUS_LABELS[s]}</option>)}
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
              <tr>{["Név", "Típus", "Kapcsolati státusz", "Következő feladat"].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                const via = c.type === "company" ? matchingContacts(data, c.id, f.query) : [];
                const task = nextTask(data, { customerId: c.id });
                return (
                  <tr key={c.id} className="align-top hover:bg-canvas">
                    <td className="max-w-xs px-4 py-3">
                      <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent hover:underline">{customerName(c)}</Link>
                      {c.restriction ? <p className="mt-1"><RestrictedBadge customer={c} /></p> : null}
                      {via.length && !customerName(c).toLowerCase().includes(f.query.toLowerCase()) ? <p className="text-xs text-ink-muted">Találat kapcsolati személyre: {via.map((k) => `${k.lastName} ${k.firstName}`.trim()).join(", ")}</p> : null}
                    </td>
                    <td className="px-4 py-3"><TypeBadge type={c.type} /></td>
                    <td className="px-4 py-3"><CrmStatusBadge status={statusOf(c)} /></td>
                    <td className="px-4 py-3 text-ink-muted">{task ? <>{task.title}{task.dueAt ? <><br /><span className="text-xs">{formatDate(task.dueAt)}</span></> : null}</> : "—"}</td>
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
      <PageHeader title="Ügyfelek" description="Magánszemélyek és cégek. Minden ügyfélnek egy aktuális kapcsolati státusza és státuszhoz tartozó feladatai vannak." actions={<LinkButton href="/customers/new">+ Új ügyfél</LinkButton>} />
      <DataGate>
        {(data) =>
          data.customers.length === 0 ? (
            <Card>
              <EmptyState title="Még nincs rögzített ügyfél." hint="Ez egy üres demó-CRM. Az adatok csak ebben a böngészőfülben élnek, ne rögzíts valós ügyféladatot." action={<LinkButton href="/customers/new">+ Első ügyfél hozzáadása</LinkButton>} />
            </Card>
          ) : (
            <CustomerTable data={data} />
          )
        }
      </DataGate>
    </>
  );
}
