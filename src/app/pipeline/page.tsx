"use client";

import Link from "next/link";
import { DataGate, RestrictedBadge, TypeBadge } from "@/components/common";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { crmPipeline, customerName, nextTask, type PipelineColumn } from "@/domain/logic";
import type { DataSnapshot } from "@/domain/types";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";

/** Egy ügyfél = egy kártya: név, (a státusz az oszlop), következő nyitott feladat. A kártya az ügyféladatlapra visz. */
function CustomerCard({ customer, data }: { customer: DataSnapshot["customers"][number]; data: DataSnapshot }) {
  const task = nextTask(data, { customerId: customer.id });
  return (
    <li>
      <article className="relative space-y-1 rounded-lg bg-surface p-3 ring-1 ring-line transition-shadow focus-within:ring-2 focus-within:ring-accent hover:shadow-md">
        <h4 className="text-sm font-semibold">
          <Link href={`/customers/${customer.id}`} className="break-words text-ink after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-none">{customerName(customer)}</Link>
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <TypeBadge type={customer.type} />
          <RestrictedBadge customer={customer} />
        </div>
        <p className="break-words text-xs text-ink-muted">
          Következő feladat: {task ? <>{task.title}{task.dueAt ? ` · ${formatDate(task.dueAt)}` : ""}</> : "nincs"}
        </p>
      </article>
    </li>
  );
}

function Column({ col, data }: { col: PipelineColumn; data: DataSnapshot }) {
  return (
    <section aria-label={`${col.label} (${col.customers.length})`} className={cn("flex w-[16rem] shrink-0 snap-start flex-col rounded-lg ring-1 ring-line", col.status === "lost" ? "bg-surface-muted/60" : "bg-accent-soft/40")}>
      <header className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <h3 className="text-[13px] font-semibold leading-tight">{col.label}</h3>
        <Badge tone={col.customers.length ? "accent" : "neutral"} className="shrink-0"><span aria-label={`${col.customers.length} ügyfél`}>{col.customers.length}</span></Badge>
      </header>
      {col.customers.length ? (
        <ul className="flex flex-1 flex-col gap-2 p-2">{col.customers.map((c) => <CustomerCard key={c.id} customer={c} data={data} />)}</ul>
      ) : (
        <p className="p-3 text-center text-xs text-ink-subtle">Nincs ügyfél</p>
      )}
    </section>
  );
}

/** v0.9: az ügyfélkeresés a közös fejléc globális keresőjébe került; a pipeline az összes ügyfelet mutatja. */
function Board({ data }: { data: DataSnapshot }) {
  const columns = crmPipeline(data);
  if (data.customers.length === 0) {
    return (
      <Card>
        <EmptyState title="Még nincs rögzített ügyfél." hint="A pipeline az ügyfelek kapcsolati státuszát mutatja: előbb rögzíts egy ügyfelet." action={<LinkButton href="/customers/new">+ Első ügyfél hozzáadása</LinkButton>} />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">{data.customers.length} ügyfél</p>
      <div role="region" aria-label="Pipeline (vízszintesen görgethető)" tabIndex={0} className="-mx-4 overflow-x-auto px-4 pb-3 focus-visible:outline-2 focus-visible:outline-accent sm:-mx-6 sm:px-6">
        <div className="flex w-max snap-x snap-proximity gap-3">{columns.map((c) => <Column key={c.status} col={c} data={data} />)}</div>
      </div>
    </div>
  );
}

export default function PipelinePage() {
  return (
    <>
      <PageHeader title="Pipeline" description="Az ügyfelek kapcsolati státusz szerint: egy ügyfél egy kártya. A kártyára kattintva az ügyféladatlap nyílik meg, ahol a státusz módosítható." actions={<LinkButton href="/customers/new" variant="secondary">+ Új ügyfél</LinkButton>} />
      <DataGate>{(data) => <Board data={data} />}</DataGate>
    </>
  );
}
