"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ActivityItem, DataGate, TaskRow, useUserName } from "@/components/common";
import { NewTaskModal } from "@/components/forms";
import { CustomerNotes } from "@/components/customer-notes";
import { ContactSidebar, CustomerHeader } from "@/components/customer-details";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState } from "@/components/ui/primitives";
import { CLOSURE_LABELS, CRM_STATUS_LABELS, PROCESS_STATUS_LABELS } from "@/domain/constants";
import { statusOf, tasksByStatus } from "@/domain/logic";
import type { Customer, DataSnapshot } from "@/domain/types";

/** Régi (v0.2/v0.3) adatok és napló: csak olvasható archívum, a meglévő adat megőrzéséhez. */
function ArchiveSection({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const userName = useUserName();
  const processes = data.processes.filter((p) => p.customerId === customer.id);
  const log = data.activities.filter((a) => a.customerId === customer.id && a.type !== "note").sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  if (!processes.length && !log.length) return null;
  return (
    <Card id="naplo">
      <details>
        <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">Napló és korábbi adatok (csak olvasható, {log.length} esemény{processes.length ? `, ${processes.length} régi folyamat` : ""})</summary>
        <div className="border-t border-line">
          {processes.length ? (
            <div className="p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Régi folyamatok (archív)</h3>
              <ul className="space-y-1 text-sm">
                {processes.map((p) => (
                  <li key={p.id} className="break-words">{p.title} · {PROCESS_STATUS_LABELS[p.status]} · {CLOSURE_LABELS[p.closure.state]} · {userName(p.ownerId)}</li>
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-ink-muted">A korábbi folyamatok adata megmaradt; a v0.5 felület nem kezeli, és nincs leképezve az új státuszokra.</p>
            </div>
          ) : null}
          {log.length ? <ol className="divide-y divide-line border-t border-line">{log.map((a) => <ActivityItem key={a.id} activity={a} data={data} />)}</ol> : null}
        </div>
      </details>
    </Card>
  );
}

function Profile({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const [newTask, setNewTask] = useState(false);
  const status = statusOf(customer);
  const view = tasksByStatus(data, customer);
  const hasEarlier = view.earlier.length > 0 || view.unassigned.length > 0;
  return (
    <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] lg:items-start lg:gap-6 lg:space-y-0">
      {/* DOM-sorrend = mobil sorrend: név+státusz, kapcsolati adatok, feladatok. Desktopon a kapcsolati adatok a jobb oldali sávba kerülnek. */}
      <CustomerHeader customer={customer} className="lg:col-span-2" />
      <ContactSidebar data={data} customer={customer} className="lg:sticky lg:top-4 lg:col-start-2 lg:row-start-2" />
      <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-2">

        <Card id="feladatok-lista">
          <CardHeader title={`Feladatok — ${CRM_STATUS_LABELS[status]}`} count={view.current.length} action={<Button size="sm" onClick={() => setNewTask(true)}>+ Feladat hozzáadása</Button>} />
          {view.current.length ? (
            <ul className="divide-y divide-line">{view.current.map((t) => <TaskRow key={t.id} task={t} data={data} />)}</ul>
          ) : (
            <EmptyState title="Ennél a státusznál még nincs feladat" hint="A hozzáadott feladat automatikusan az aktuális státuszhoz kapcsolódik." />
          )}
        </Card>

        {hasEarlier ? (
          <Card id="korabbi-feladatok">
            <details open={view.openEarlier > 0}>
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">
                Korábbi státuszok feladatai{" "}
                {view.openEarlier > 0 ? <Badge tone="warn">{view.openEarlier} nyitott</Badge> : <span className="font-normal text-ink-muted">(mind elvégezve)</span>}
              </summary>
              <div className="border-t border-line">
                {view.earlier.map((g) => (
                  <section key={g.status} aria-label={`Korábbi státusz: ${CRM_STATUS_LABELS[g.status]}`}>
                    <h3 className="bg-canvas px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{CRM_STATUS_LABELS[g.status]}</h3>
                    <ul className="divide-y divide-line">{g.tasks.map((t) => <TaskRow key={t.id} task={t} data={data} />)}</ul>
                  </section>
                ))}
                {view.unassigned.length ? (
                  <section aria-label="Státuszhoz nem rendelt (régi) feladatok">
                    <h3 className="bg-canvas px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Régi feladatok (státusz nélkül)</h3>
                    <ul className="divide-y divide-line">{view.unassigned.map((t) => <TaskRow key={t.id} task={t} data={data} />)}</ul>
                  </section>
                ) : null}
              </div>
            </details>
          </Card>
        ) : null}

        <CustomerNotes data={data} customer={customer} />
        <ArchiveSection data={data} customer={customer} />
      </div>
      <NewTaskModal open={newTask} onClose={() => setNewTask(false)} customerId={customer.id} statusLabel={CRM_STATUS_LABELS[status]} />
    </div>
  );
}

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <DataGate>
      {(data) => {
        const customer = data.customers.find((c) => c.id === id);
        if (!customer) return <ErrorState title="Az ügyfél nem található" message="Hibás lehet a hivatkozás, vagy az ügyfél nem létezik ebben az adatbázisban." />;
        return <Profile data={data} customer={customer} />;
      }}
    </DataGate>
  );
}

