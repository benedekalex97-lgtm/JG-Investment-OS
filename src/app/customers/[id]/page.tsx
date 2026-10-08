"use client";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ActivityItem, ContactStatusBadge, DataGate, TaskRow, TypeBadge, userName } from "@/components/common";
import { ActivityFormModal, ContactFormModal, ContactStatusModal, ProcessFormModal, RestrictionModal, TaskFormModal } from "@/components/forms";
import { ProcessCard } from "@/components/process-card";
import { FilterSelect } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader, DescriptionList, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import {
  ACTIVITY_LABELS, ACTIVITY_TYPES, CHANNEL_LABELS, CONTACT_PURPOSES, CONTACT_CHANNELS, CONTACTABILITY_LABELS, CONTACTABILITY_STATUSES, DEMO_USERS,
  EVIDENCE_LABELS, EVIDENCE_STATUSES, OUTREACH_COMPLIANCE_NOTICE, PURPOSE_LABELS, RESTRICTION_LABELS, VERIFICATION_LABELS,
} from "@/domain/constants";
import { contactName, customerName, getContactability } from "@/domain/logic";
import type { CompanyContact, Customer, DataSnapshot } from "@/domain/types";
import { isActive } from "@/domain/workflow";
import { formatDate, formatDateTime } from "@/lib/format";

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

function ContactsCard({ company, contacts, data }: { company: Customer; contacts: CompanyContact[]; data: DataSnapshot }) {
  const [editing, setEditing] = useState<CompanyContact | "new" | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Kapcsolattartók" count={contacts.length} action={<Button size="sm" onClick={() => setEditing("new")}>Kapcsolattartó hozzáadása</Button>} />
      {contacts.length === 0 ? (
        <EmptyState title="Ennek a cégnek még nincs kapcsolattartója" hint="Egy céghez 0..N kapcsolattartó tartozhat." />
      ) : (
        <ul className="divide-y divide-line">
          {contacts.map((k) => {
            const acts = data.activities.filter((a) => a.companyContactId === k.id);
            return (
              <li key={k.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="break-words text-sm font-medium">{contactName(k)} {k.isPrimaryContact ? <Badge tone="accent" className="ml-1">Elsődleges</Badge> : null}</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" aria-expanded={viewing === k.id} onClick={() => setViewing(viewing === k.id ? null : k.id)}>{viewing === k.id ? "Elrejt" : "Megtekintés"}</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(k)}>Szerkesztés</Button>
                  </div>
                </div>
                <p className="break-all text-[13px] text-ink-muted">{[k.position, k.email, k.phone].filter(Boolean).join(" · ") || "Nincs megadott elérhetőség"}</p>
                {viewing === k.id ? (
                  <div className="mt-3 space-y-3 rounded-md bg-canvas p-3">
                    <DescriptionList items={[{ label: "Beosztás", value: k.position }, { label: "E-mail", value: k.email }, { label: "Telefon", value: k.phone }, { label: "Felvéve", value: formatDate(k.createdAt) }]} />
                    <p className="text-[13px] text-ink-muted">Kapcsolódó folyamatok: {data.processes.filter((p) => p.companyContactId === k.id).map((p) => p.title).join(", ") || "nincs"}</p>
                    <p className="text-[13px] text-ink-muted">Kapcsolódó aktivitások: {acts.length}{acts[0] ? ` (legutóbbi: ${formatDateTime(acts[0].occurredAt)})` : ""}</p>
                    <ContactabilityCard data={data} target={{ companyContactId: k.id }} title={`Megkereshetőség – ${contactName(k)}`} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ContactFormModal open={editing !== null} onClose={() => setEditing(null)} companyId={company.id} contact={editing && editing !== "new" ? editing : undefined} key={editing === null ? "closed" : editing === "new" ? "new" : editing.id} />
    </Card>
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
  const { repo } = useDemoData();
  const [modal, setModal] = useState<"process" | "task" | "activity" | "status" | "restriction" | null>(null);
  const contacts = data.contacts.filter((k) => k.companyId === customer.id);
  const processes = data.processes.filter((p) => p.customerId === customer.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const active = processes.filter(isActive);
  const closed = processes.filter((p) => !isActive(p));
  const tasks = data.tasks.filter((t) => t.customerId === customer.id);
  const openTasks = tasks.filter((t) => t.status !== "done").sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const doneTasks = tasks.filter((t) => t.status === "done").sort((a, b) => Date.parse(b.completedAt ?? b.dueAt) - Date.parse(a.completedAt ?? a.dueAt));
  const primary = contacts.find((k) => k.isPrimaryContact);
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

        <Card>
          <CardHeader title="Ügyfél" action={<span className="flex flex-wrap gap-2"><TypeBadge type={customer.type} /><ContactStatusBadge status={customer.contactStatus} /></span>} />
          <DescriptionList items={[
            ...(customer.type === "individual" ? [{ label: "Vezetéknév", value: customer.lastName }, { label: "Keresztnév", value: customer.firstName }] : [{ label: "Cégnév", value: customer.companyName }]),
            { label: "E-mail", value: customer.email }, { label: "Telefon", value: customer.phone },
            ...(primary ? [{ label: "Elsődleges kapcsolattartó", value: contactName(primary) }] : []),
            { label: "Forrás", value: customer.source }, { label: "Ellenőrzöttség", value: VERIFICATION_LABELS[customer.verificationStatus] },
            { label: "Létrehozva", value: formatDate(customer.createdAt) }, { label: "Módosítva", value: formatDate(customer.updatedAt) },
            ...(customer.type === "individual" && customer.notes ? [{ label: "Jegyzet (demó)", value: customer.notes }] : []),
          ]} />
          <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
            <FilterSelect label="Felelős" value={customer.ownerId} onChange={(e) => repo.updateCustomerOwner(customer.id, e.target.value)}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </FilterSelect>
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="secondary" onClick={() => setModal("status")}>Kapcsolati státusz módosítása</Button>
              <Button variant="secondary" onClick={() => setModal("restriction")}>{customer.restriction ? "Korlátozás kezelése" : "Tiltakozás / korlátozás rögzítése"}</Button>
            </div>
          </div>
          <p className="border-t border-line bg-warn-soft px-4 py-3 text-[13px] text-ink">{OUTREACH_COMPLIANCE_NOTICE}</p>
          <div className="border-t border-line"><ContactabilityCard data={data} target={{ customerId: customer.id }} title="Megkereshetőség (demó)" /></div>
        </Card>

        {customer.type === "company" ? <ContactsCard company={customer} contacts={contacts} data={data} /> : null}

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
