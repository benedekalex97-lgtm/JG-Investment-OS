"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CrmStatusBadge, DataGate, optionLabel, RestrictedBadge, TypeBadge } from "@/components/common";
import { FilterSelect } from "@/components/ui/form";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS } from "@/domain/constants";
import { ordered } from "@/domain/config";
import { customerMatches, customerName, nextTask, searchCustomers, statusOf, type CustomerFilter } from "@/domain/logic";
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
          Keresés (név, cégnév, kapcsolati személy, telefonszám, e-mail)
          <input type="search" value={f.query} onChange={(e) => set("query", e.target.value)} className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
        </label>
        <FilterSelect label="Típus" value={f.type} onChange={(e) => set("type", e.target.value as typeof f.type)}>
          <option value="">Összes</option>
          {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>)}
        </FilterSelect>
        <FilterSelect label="Kapcsolati státusz" value={f.crmStatus} onChange={(e) => set("crmStatus", e.target.value as typeof f.crmStatus)}>
          <option value="">Összes</option>
          {ordered(data.config.statuses).map((s) => <option key={s.key} value={s.key}>{optionLabel(s)}</option>)}
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
                const why = f.query.trim() ? customerMatches(data, c, f.query).filter((m) => m.field !== "name") : [];
                const task = nextTask(data, { customerId: c.id });
                return (
                  <tr key={c.id} className="align-top hover:bg-canvas">
                    <td className="max-w-xs px-4 py-3">
                      <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent hover:underline">{customerName(c)}</Link>
                      {c.restriction ? <p className="mt-1"><RestrictedBadge customer={c} /></p> : null}
                      {why.length ? <p className="break-all text-xs text-ink-muted">Egyezés — {why.slice(0, 2).map((m) => `${m.label}: ${m.value}`).join(" · ")}</p> : null}
                    </td>
                    <td className="px-4 py-3"><TypeBadge type={c.type} /></td>
                    <td className="px-4 py-3"><CrmStatusBadge status={statusOf(c)} config={data.config} /></td>
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

/** A törlés után ide visszatérve rövid visszajelzés (CRM-006); az URL-ből azonnal eltávolítjuk. */
function RemovedNotice() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("eltavolitva") !== "1") return;
    url.searchParams.delete("eltavolitva");
    window.history.replaceState(null, "", url.pathname + url.search);
    const t = setTimeout(() => setShown(true), 0);
    return () => clearTimeout(t);
  }, []);
  return shown ? <p role="status" className="mb-4 rounded-md bg-ok-soft p-3 text-sm text-ok">Az ügyfél eltávolítva az aktív CRM-ből. A kapcsolódó adatok megmaradtak.</p> : null;
}

export default function CustomersPage() {
  return (
    <>
      <RemovedNotice />
      <PageHeader title="Ügyfelek" description="Magánszemélyek és cégek. Minden ügyfélnek egy aktuális kapcsolati státusza és státuszhoz tartozó feladatai vannak." actions={<LinkButton href="/customers/new">+ Új ügyfél</LinkButton>} />
      <DataGate>
        {(data) =>
          data.customers.length === 0 ? (
            <Card>
              <EmptyState title="Még nincs rögzített ügyfél." hint="Az adatbázis még üres. Az adat mentése tartós; fiktív/előnézeti környezetben ne rögzíts valós ügyféladatot." action={<LinkButton href="/customers/new">+ Első ügyfél hozzáadása</LinkButton>} />
            </Card>
          ) : (
            <CustomerTable data={data} />
          )
        }
      </DataGate>
    </>
  );
}
