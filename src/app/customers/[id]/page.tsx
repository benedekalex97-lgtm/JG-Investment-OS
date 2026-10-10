"use client";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ActivityItem, DataGate, TaskRow, userName } from "@/components/common";
import { CustomerDetails } from "@/components/customer-details";
import { ActivityFormModal, ContactStatusModal, ProcessFormModal, RestrictionModal, TaskFormModal } from "@/components/forms";
import { ProcessCard } from "@/components/process-card";
import { FilterSelect } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import {
  ACTIVITY_LABELS, ACTIVITY_TYPES, CHANNEL_LABELS, CONTACT_PURPOSES, CONTACT_CHANNELS, CONTACTABILITY_LABELS, CONTACTABILITY_STATUSES,
  EVIDENCE_LABELS, EVIDENCE_STATUSES, OUTREACH_COMPLIANCE_NOTICE, PURPOSE_LABELS, RESTRICTION_LABELS,
} from "@/domain/constants";
import { customerName, getContactability } from "@/domain/logic";
import type { Customer, DataSnapshot } from "@/domain/types";
import { isActive } from "@/domain/workflow";
import { formatDate } from "@/lib/format";

function ContactabilityCard({ data, target, title }: { data: DataSnapshot; target: { customerId?: string; companyContactId?: string }; title: string }) {
  const { repo } = useDemoData();
  return (
    <details className="group">
      <summary className="min-h-11 cursor-pointer list-none px-4 py-3 text-sm font-semibold marker:hidden">
        {title} <span className="font-normal text-ink-muted">(megnyitás / bezárás)</span>
      </summary>
      <p className="px-4 pb-1 text-[13px] text-ink-muted">
        A megkereshetőség az ügyfélstátusztól független. Alapértelmezett: <strong>ismeretlen</strong>. Az „engedélyezett” itt kizárólag fiktív tesztállapot, nem jogi igazolás; a meglévő ügyfélkapcsolat önmagában nem marketingengedély. Nincs automatikus megkeresés.
      </p>
      <div className="overflow-x-auto p-4">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="text-xs uppercase tracking-wide text-ink-subtle">
            <tr><th scope="col" className="py-1 pr-3 font-medium">Cél</th><th scope="col" className="py-1 pr-3 font-medium">Csatorna</th><th scope="col" className="py-1 pr-3 font-medium">Státusz</th><th scope="col" className="py-1 font-medium">Bizonyíték</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {CONTACT_PURPOSES.flatMap((p) => CONTACT_CHANNELS.map((ch) => {
              const r = getContactability(data, target, p, ch);
              const label = `${PURPOSE_LABELS[p]} – ${CHANNEL_LABELS[ch]}`;
              const save = (status: typeof r.status, ev: typeof r.evidenceStatus) => repo.setContactability(target, p, ch, status, ev);
              return (
                <tr key={`${p}-${ch}`}>
                  <td className="py-2 pr-3">{PURPOSE_LABELS[p]}</td>
                  <td className="py-2 pr-3">{CHANNEL_LABELS[ch]}</td>
                  <td className="py-2 pr-3">
                    <select aria-label={`${label}: státusz`} value={r.status} onChange={(e) => save(e.target.value as typeof r.status, r.evidenceStatus)} className="min-h-11 rounded-md bg-surface px-2 ring-1 ring-control">
                      {CONTACTABILITY_STATUSES.map((s) => <option key={s} value={s}>{CONTACTABILITY_LABELS[s]}</option>)}
                    </select>
                  </td>
                  <td className="py-2">
                    <select aria-label={`${label}: bizonyíték`} value={r.evidenceStatus} onChange={(e) => save(r.status, e.target.value as typeof r.evidenceStatus)} className="min-h-11 rounded-md bg-surface px-2 ring-1 ring-control">
                      {EVIDENCE_STATUSES.map((s) => <option key={s} value={s}>{EVIDENCE_LABELS[s]}</option>)}
                    </select>
                  </td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ActivityTimeline({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const [processFilter, setProcessFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const processes = data.processes.filter((p) => p.customerId === customer.id);
  const rows = useMemo(
    () =>
      data.activities
        .filter((a) => a.customerId === customer.id)
        .filter((a) => !processFilter || (processFilter === "none" ? !a.processId : a.processId === processFilter))
        .filter((a) => !typeFilter || a.type === typeFilter)
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    [data.activities, customer.id, processFilter, typeFilter],
  );
  return (
    <Card id="aktivitas">
      <CardHeader title="Aktivitás" count={rows.length} />
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2">
        <FilterSelect label="Folyamat" value={processFilter} onChange={(e) => setProcessFilter(e.target.value)}>
          <option value="">Összes</option>
          <option value="none">Folyamaton kívüli</option>
          {processes.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </FilterSelect>
        <FilterSelect label="Eseménytípus" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">Összes</option>
          {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>)}
        </FilterSelect>
      </div>
      <p className="px-4 pt-3 text-[13px] text-ink-muted" role="status" aria-live="polite">{rows.length} esemény, a legújabb elöl</p>
      {rows.length ? <ol className="divide-y divide-line">{rows.map((a) => <ActivityItem key={a.id} activity={a} data={data} />)}</ol> : <EmptyState title="Nincs a szűrésnek megfelelő esemény" />}
    </Card>
  );
}

function Profile({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const [modal, setModal] = useState<"process" | "task" | "activity" | "status" | "restriction" | null>(null);
  const processes = data.processes.filter((p) => p.customerId === customer.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const active = processes.filter(isActive);
  const closed = processes.filter((p) => !isActive(p));
  const tasks = data.tasks.filter((t) => t.customerId === customer.id);
  const openTasks = tasks.filter((t) => t.status !== "done").sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const doneTasks = tasks.filter((t) => t.status === "done").sort((a, b) => Date.parse(b.completedAt ?? b.dueAt) - Date.parse(a.completedAt ?? a.dueAt));
  const close = () => setModal(null);

  return (
    <>
      <PageHeader
        title={customerName(customer)}
        description={customer.type === "individual" ? "Magánszemély ügyfél" : "Céges ügyfél"}
        actions={<><Button onClick={() => setModal("process")}>Új folyamat</Button><Button variant="secondary" onClick={() => setModal("task")}>Új feladat</Button><Button variant="secondary" onClick={() => setModal("activity")}>Aktivitás rögzítése</Button></>}
      />
      <div className="space-y-6">
        {customer.restriction ? (
          <div role="alert" className="rounded-lg bg-danger-soft p-4 text-sm text-danger ring-1 ring-danger/25">
            <p className="font-semibold">{RESTRICTION_LABELS[customer.restriction.kind]} rögzítve — kimenő megkeresés nem indítható</p>
            <p className="mt-1">{customer.restriction.note} ({formatDate(customer.restriction.recordedAt)}, {userName(customer.restriction.recordedBy)})</p>
          </div>
        ) : null}

        <CustomerDetails
          data={data}
          customer={customer}
          actions={
            <>
              <Button variant="secondary" onClick={() => setModal("status")}>Kapcsolati státusz módosítása</Button>
              <Button variant="secondary" onClick={() => setModal("restriction")}>{customer.restriction ? "Korlátozás kezelése" : "Tiltakozás / korlátozás rögzítése"}</Button>
            </>
          }
        />
        <Card>
          <p className="bg-warn-soft px-4 py-3 text-[13px] text-ink">{OUTREACH_COMPLIANCE_NOTICE}</p>
          <ContactabilityCard data={data} target={{ customerId: customer.id }} title="Megkereshetőség (demó)" />
        </Card>

        <Card id="folyamatok">
          <CardHeader title="Folyamatok" count={processes.length} action={<Button size="sm" onClick={() => setModal("process")}>Új folyamat</Button>} />
          {active.length ? <ul className="divide-y divide-line">{active.map((p) => <ProcessCard key={p.id} process={p} data={data} />)}</ul> : <EmptyState title="Nincs aktív folyamat" hint="Új érdeklődés esetén indíts új folyamatot; a korábbi folyamatok megmaradnak." />}
          {closed.length ? (
            <details open className="border-t border-line">
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">Lezárt folyamatok ({closed.length})</summary>
              <ul className="divide-y divide-line">{closed.map((p) => <ProcessCard key={p.id} process={p} data={data} />)}</ul>
            </details>
          ) : null}
        </Card>

        <Card id="feladatok-lista">
          <CardHeader title="Feladatok" count={openTasks.length} action={<Button size="sm" variant="secondary" onClick={() => setModal("task")}>Új feladat</Button>} />
          {openTasks.length ? <ul className="divide-y divide-line">{openTasks.map((t) => <TaskRow key={t.id} task={t} data={data} showCustomer={false} />)}</ul> : <EmptyState title="Nincs aktuális feladat" />}
          {doneTasks.length ? (
            <details className="border-t border-line">
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">Elvégzett feladatok ({doneTasks.length})</summary>
              <ul className="divide-y divide-line">{doneTasks.map((t) => <TaskRow key={t.id} task={t} data={data} showCustomer={false} />)}</ul>
            </details>
          ) : null}
        </Card>

        <ActivityTimeline data={data} customer={customer} />
      </div>
      <ProcessFormModal open={modal === "process"} onClose={close} customer={customer} />
      <TaskFormModal open={modal === "task"} onClose={close} defaults={{ customerId: customer.id }} />
      <ActivityFormModal open={modal === "activity"} onClose={close} defaults={{ customerId: customer.id }} />
      <ContactStatusModal open={modal === "status"} onClose={close} customer={customer} />
      <RestrictionModal open={modal === "restriction"} onClose={close} customer={customer} />
    </>
  );
}

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <DataGate>
      {(data) => {
        const customer = data.customers.find((c) => c.id === id);
        if (!customer) return <ErrorState title="Az ügyfél nem található" message="Lehet, hogy a demóadat visszaállítása törölte, vagy hibás a hivatkozás." />;
        return <Profile data={data} customer={customer} />;
      }}
    </DataGate>
  );
}
