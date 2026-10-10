"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ContactStatusBadge, DataGate, StatusBadge, TypeBadge, userName } from "@/components/common";
import { FilterSelect } from "@/components/ui/form";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import {
  CONTACT_STATUSES, CONTACT_STATUS_LABELS, CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS, DEMO_USERS, PROCESS_STATUS_DEFS, PROCESS_TYPES, PROCESS_TYPE_LABELS,
  RESTRICTION_LABELS,
} from "@/domain/constants";
import { activeProcessesOf, customerName, lastActivity, matchingContacts, nextTask, searchCustomers, type CustomerFilter } from "@/domain/logic";
import type { DataSnapshot } from "@/domain/types";
import { formatDate, formatDateTime } from "@/lib/format";

function CustomerTable({ data }: { data: DataSnapshot }) {
  const [f, setF] = useState<Required<CustomerFilter>>({ query: "", type: "", contactStatus: "", ownerId: "", processType: "", processStatus: "" });
  const rows = useMemo(() => searchCustomers(data, f).sort((a, b) => customerName(a).localeCompare(customerName(b), "hu")), [data, f]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Card>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-xs font-medium text-ink-muted sm:col-span-2 lg:col-span-3">
          Keresés (név, cégnév, kapcsolattartó)
          <input type="search" value={f.query} onChange={(e) => set("query", e.target.value)} placeholder="pl. Minta" className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
        </label>
        <FilterSelect label="Típus" value={f.type} onChange={(e) => set("type", e.target.value as typeof f.type)}>
          <option value="">Összes</option>
          {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>)}
        </FilterSelect>
        <FilterSelect label="Kapcsolati státusz" value={f.contactStatus} onChange={(e) => set("contactStatus", e.target.value as typeof f.contactStatus)}>
          <option value="">Összes</option>
          {CONTACT_STATUSES.map((s) => <option key={s} value={s}>{CONTACT_STATUS_LABELS[s]}</option>)}
        </FilterSelect>
        <FilterSelect label="Felelős" value={f.ownerId} onChange={(e) => set("ownerId", e.target.value)}>
          <option value="">Összes</option>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </FilterSelect>
        <FilterSelect label="Aktív folyamat típusa" value={f.processType} onChange={(e) => set("processType", e.target.value as typeof f.processType)}>
          <option value="">Összes</option>
          {PROCESS_TYPES.map((t) => <option key={t} value={t}>{PROCESS_TYPE_LABELS[t]}</option>)}
        </FilterSelect>
        <FilterSelect label="Aktív folyamat státusza" value={f.processStatus} onChange={(e) => set("processStatus", e.target.value as typeof f.processStatus)}>
          <option value="">Összes</option>
          {PROCESS_STATUS_DEFS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </FilterSelect>
      </div>
      <p className="px-4 pt-3 text-[13px] text-ink-muted" role="status" aria-live="polite">{rows.length} találat</p>
      {rows.length === 0 ? (
        <EmptyState title="Nincs a szűrésnek megfelelő ügyfél" hint="Módosítsd a keresést vagy a szűrőket." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">Ügyfelek</caption>
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                {["Név", "Típus", "Kapcsolati státusz", "Felelős", "Aktív folyamatok", "Utolsó aktivitás", "Következő teendő"].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                const via = c.type === "company" ? matchingContacts(data, c.id, f.query) : [];
                const active = activeProcessesOf(data, c.id);
                const last = lastActivity(data, { customerId: c.id });
                const task = nextTask(data, { customerId: c.id });
                return (
                  <tr key={c.id} className="align-top hover:bg-canvas">
                    <td className="max-w-xs px-4 py-3">
                      <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent hover:underline">{customerName(c)}</Link>
                      {c.restriction ? <p className="mt-1"><Badge tone="danger">{RESTRICTION_LABELS[c.restriction.kind]}</Badge></p> : null}
                      {via.length && !customerName(c).toLowerCase().includes(f.query.toLowerCase()) ? (
                        <p className="text-xs text-ink-muted">Találat kapcsolattartóra: {via.map((k) => `${k.lastName} ${k.firstName}`).join(", ")}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3"><TypeBadge type={c.type} /></td>
                    <td className="px-4 py-3"><ContactStatusBadge status={c.contactStatus} /></td>
                    <td className="px-4 py-3">{userName(c.ownerId)}</td>
                    <td className="px-4 py-3">
                      {active.length ? <ul className="space-y-1">{active.map((p) => <li key={p.id}><StatusBadge status={p.status} /></li>)}</ul> : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{last ? formatDate(last.occurredAt) : "—"}</td>
                    <td className="px-4 py-3 text-ink-muted">{task ? <>{task.title}<br /><span className="text-xs">{formatDateTime(task.dueAt)}</span></> : "—"}</td>
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
      <PageHeader title="Ügyfelek" description="Magánszemélyek és cégek. A folyamatok, feladatok és aktivitások az ügyféladatlapon élnek." actions={<LinkButton href="/customers/new">+ Új ügyfél</LinkButton>} />
      <DataGate>
        {(data) =>
          data.customers.length === 0 ? (
            <Card>
              <EmptyState
                title="Még nincs rögzített ügyfél."
                hint="Ez egy üres demó-CRM. Az adatok csak ebben a böngészőfülben élnek, ne rögzíts valós ügyféladatot."
                action={<LinkButton href="/customers/new">+ Első ügyfél hozzáadása</LinkButton>}
              />
            </Card>
          ) : (
            <CustomerTable data={data} />
          )
        }
      </DataGate>
    </>
  );
}
