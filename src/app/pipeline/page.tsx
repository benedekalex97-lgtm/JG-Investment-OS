"use client";

import Link from "next/link";
import { useState } from "react";
import { ClosureBadge, CustomerLink, DataGate, ProcessTypeBadge, StatusBadge, userName } from "@/components/common";
import { StatusChangeModal } from "@/components/forms";
import { FilterSelect } from "@/components/ui/form";
import { Badge, Button, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { DEMO_USERS, PHASE_LABELS, PROCESS_TYPE_LABELS } from "@/domain/constants";
import { closedProcesses, customerName, lastActivity, nextTask, pipelineColumns, type PipelineColumn } from "@/domain/logic";
import type { CustomerProcess, DataSnapshot } from "@/domain/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";

/** Egy folyamat kártyája: a teljes kártya az ügyféladatlapra (és az adott folyamatra) visz; a státuszváltás külön gomb. */
function PipelineCard({ process, data, onChange }: { process: CustomerProcess; data: DataSnapshot; onChange: (id: string) => void }) {
  const customer = data.customers.find((c) => c.id === process.customerId);
  const task = nextTask(data, { processId: process.id });
  const last = lastActivity(data, { processId: process.id });
  const overdue = task ? Date.parse(task.dueAt) < new Date().setHours(0, 0, 0, 0) : false;
  const name = customer ? customerName(customer) : "Ismeretlen ügyfél";
  return (
    <li>
      <article className="relative space-y-1.5 rounded-lg bg-surface p-3 ring-1 ring-line transition-shadow focus-within:ring-2 focus-within:ring-accent hover:shadow-md">
        <h4 className="text-sm font-semibold">
          <Link
            href={`/customers/${process.customerId}#folyamat-${process.id}`}
            className="break-words text-ink after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-none"
            aria-label={`${name} — ${process.title}: ügyféladatlap megnyitása`}
          >
            {name}
          </Link>
        </h4>
        <p className="break-words text-[13px] text-ink">{process.title}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={process.status} />
          <ProcessTypeBadge type={process.type} />
        </div>
        <dl className="space-y-0.5 text-xs text-ink-muted">
          <div><dt className="inline font-medium">Felelős: </dt><dd className="inline">{userName(process.ownerId)}</dd></div>
          <div>
            <dt className="inline font-medium">Következő teendő: </dt>
            <dd className="inline">{task ? <>{task.title} · <span className={overdue ? "font-semibold text-danger" : undefined}>{formatDateTime(task.dueAt)}{overdue ? " (lejárt)" : ""}</span></> : "nincs"}</dd>
          </div>
          <div><dt className="inline font-medium">Utolsó aktivitás: </dt><dd className="inline">{last ? formatDate(last.occurredAt) : "—"}</dd></div>
        </dl>
        <div className="relative z-10 pt-1">
          <Button size="sm" variant="secondary" aria-label={`Státusz váltása: ${name} — ${process.title}`} onClick={() => onChange(process.id)}>Státusz váltása</Button>
        </div>
      </article>
    </li>
  );
}

function Column({ col, data, onChange }: { col: PipelineColumn; data: DataSnapshot; onChange: (id: string) => void }) {
  return (
    <section aria-label={`${col.label} (${col.processes.length})`} className={cn("flex w-[17rem] shrink-0 snap-start flex-col rounded-lg ring-1 ring-line", col.phase === "sales" ? "bg-accent-soft/50" : "bg-surface-muted/60")}>
      <header className="space-y-0.5 border-b border-line px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[13px] font-semibold leading-tight">{col.label}</h3>
          <Badge tone={col.processes.length ? (col.phase === "sales" ? "accent" : "info") : "neutral"} className="shrink-0"><span aria-label={`${col.processes.length} folyamat`}>{col.processes.length}</span></Badge>
        </div>
        <p className="text-[11px] text-ink-muted">
          {col.onlyFor ? PROCESS_TYPE_LABELS[col.onlyFor] : "mindkét típus"}{col.milestone ? " · szolgáltatói mérföldkő (szimulált)" : ""}
        </p>
      </header>
      {col.processes.length ? (
        <ul className="flex flex-1 flex-col gap-2 p-2">{col.processes.map((p) => <PipelineCard key={p.id} process={p} data={data} onChange={onChange} />)}</ul>
      ) : (
        <p className="p-3 text-center text-xs text-ink-subtle">Nincs folyamat</p>
      )}
    </section>
  );
}

function Board({ data }: { data: DataSnapshot }) {
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [changing, setChanging] = useState<string | null>(null);
  const filter = { query, ownerId: owner };
  const columns = pipelineColumns(data, filter);
  const all = pipelineColumns(data);
  const activeTotal = all.reduce((n, c) => n + c.processes.length, 0);
  const shown = columns.reduce((n, c) => n + c.processes.length, 0);
  const closed = closedProcesses(data, filter);
  const changingProcess = data.processes.find((p) => p.id === changing);

  if (activeTotal === 0 && closedProcesses(data).length === 0) {
    return (
      <Card>
        <EmptyState
          title="Még nincs aktív értékesítési folyamat."
          hint={data.customers.length === 0 ? "A folyamatok az ügyfelekhez tartoznak: előbb rögzíts egy ügyfelet." : "Új folyamatot az ügyféladatlapon, az „Új folyamat” művelettel indíthatsz."}
          action={<LinkButton href={data.customers.length === 0 ? "/customers/new" : "/customers"}>{data.customers.length === 0 ? "+ Első ügyfél hozzáadása" : "Ügyfelek megnyitása"}</LinkButton>}
        />
      </Card>
    );
  }

  const groups = (["outreach", "sales"] as const).map((phase) => ({ phase, cols: columns.filter((c) => c.phase === phase) }));
  return (
    <div className="space-y-6">
      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs font-medium text-ink-muted sm:col-span-2 lg:col-span-1">
            Keresés (ügyfél, folyamat, kapcsolattartó)
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
          </label>
          <FilterSelect label="Felelős" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Összes</option>
            {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </FilterSelect>
          <p className="self-end pb-2 text-[13px] text-ink-muted" role="status" aria-live="polite">{shown} aktív folyamat{query || owner ? ` (összesen ${activeTotal})` : ""}</p>
        </div>
      </Card>

      {shown === 0 && activeTotal > 0 ? <p className="rounded-md bg-surface p-4 text-sm text-ink-muted ring-1 ring-line">Nincs a szűrésnek megfelelő aktív folyamat.</p> : null}

      <div role="region" aria-label="Értékesítési pipeline (vízszintesen görgethető)" tabIndex={0} className="-mx-4 overflow-x-auto px-4 pb-3 focus-visible:outline-2 focus-visible:outline-accent sm:-mx-6 sm:px-6">
        <div className="flex w-max snap-x snap-proximity gap-6">
          {groups.map((g) => (
            <div key={g.phase} className="space-y-2">
              <h2 className="sticky left-0 text-sm font-semibold text-ink">{PHASE_LABELS[g.phase]}</h2>
              <div className="flex gap-3">{g.cols.map((c) => <Column key={c.status} col={c} data={data} onChange={setChanging} />)}</div>
            </div>
          ))}
        </div>
      </div>

      <Card id="lezart">
        <details>
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">Lezárt folyamatok ({closed.length})</summary>
          {closed.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {closed.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/customers/${p.customerId}#folyamat-${p.id}`} className="break-words text-sm font-medium text-accent hover:underline">{p.title}</Link>
                    <ClosureBadge closure={p.closure} />
                  </div>
                  <p className="text-[13px] text-ink-muted"><CustomerLink id={p.customerId} data={data} /> · Felelős: {userName(p.ownerId)}{p.closure.closedAt ? ` · Lezárva: ${formatDate(p.closure.closedAt)}` : ""}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-line p-4 text-sm text-ink-muted">Nincs lezárt folyamat a szűrésnek megfelelően.</p>
          )}
        </details>
      </Card>

      {changingProcess ? <StatusChangeModal open onClose={() => setChanging(null)} process={changingProcess} key={changingProcess.id} /> : null}
    </div>
  );
}

export default function PipelinePage() {
  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Az aktív ügyfélfolyamatok státusz szerint. Egy kártya egy konkrét folyamat; a kártyára kattintva az ügyféladatlap nyílik meg. A státuszváltás ugyanazokat a szabályokat (indoklás, szolgáltatói igazolás) követi, mint az adatlapon."
        actions={<LinkButton href="/customers/new" variant="secondary">+ Új ügyfél</LinkButton>}
      />
      <DataGate>{(data) => <Board data={data} />}</DataGate>
    </>
  );
}

