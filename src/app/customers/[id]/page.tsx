"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ActivityLine, CaseBadges, DataGate, LifecycleBadge, TaskLine, TypeBadge, userName } from "@/components/common";
import { ActivityFormModal, CaseFormModal, ContactFormModal, TaskFormModal } from "@/components/forms";
import { FilterSelect } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader, DescriptionList, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import {
  CHANNEL_LABELS, CONTACTABILITY_LABELS, CONTACTABILITY_STATUSES, CONTACT_CHANNELS, CONTACT_PURPOSES, DEMO_USERS, EVIDENCE_LABELS,
  EVIDENCE_STATUSES, LIFECYCLE_LABELS, LIFECYCLE_STATUSES, PURPOSE_LABELS, VERIFICATION_LABELS,
} from "@/domain/constants";
import { contactName, customerName, getContactability } from "@/domain/logic";
import type { CompanyContact, Customer, DataSnapshot } from "@/domain/types";
import { formatDate, formatDateTime } from "@/lib/format";

function ContactabilityCard({ data, target, title }: { data: DataSnapshot; target: { customerId?: string; companyContactId?: string }; title: string }) {
  const { repo } = useDemoData();
  return (
    <Card>
      <CardHeader title={title} />
      <p className="px-4 pt-3 text-[13px] text-ink-muted">
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
    </Card>
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
          {contacts.map((k) => (
            <li key={k.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="break-words text-sm font-medium">
                  {contactName(k)} {k.isPrimaryContact ? <Badge tone="accent" className="ml-1">Elsődleges</Badge> : null}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" aria-expanded={viewing === k.id} onClick={() => setViewing(viewing === k.id ? null : k.id)}>{viewing === k.id ? "Elrejt" : "Megtekintés"}</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(k)}>Szerkesztés</Button>
                </div>
              </div>
              <p className="break-all text-[13px] text-ink-muted">{[k.position, k.email, k.phone].filter(Boolean).join(" · ") || "Nincs megadott elérhetőség"}</p>
              {viewing === k.id ? (
                <div className="mt-3 space-y-3 rounded-md bg-canvas p-3">
                  <DescriptionList items={[
                    { label: "Beosztás", value: k.position }, { label: "E-mail", value: k.email }, { label: "Telefon", value: k.phone },
                    { label: "Felvéve", value: formatDate(k.createdAt) },
                  ]} />
                  <ContactabilityCard data={data} target={{ companyContactId: k.id }} title={`Megkereshetőség – ${contactName(k)}`} />
                  <p className="text-[13px] text-ink-muted">Kapcsolódó ügyek: {data.cases.filter((c) => c.companyContactId === k.id).map((c) => c.title).join(", ") || "nincs"}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ContactFormModal open={editing !== null} onClose={() => setEditing(null)} companyId={company.id} contact={editing && editing !== "new" ? editing : undefined} key={editing === null ? "closed" : editing === "new" ? "new" : editing.id} />
    </Card>
  );
}

function Profile({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const { repo } = useDemoData();
  const [modal, setModal] = useState<"case" | "task" | "activity" | null>(null);
  const contacts = data.contacts.filter((k) => k.companyId === customer.id);
  const cases = data.cases.filter((c) => c.customerId === customer.id);
  const tasks = data.tasks.filter((t) => t.customerId === customer.id).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const activities = data.activities.filter((a) => a.customerId === customer.id).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const primary = contacts.find((k) => k.isPrimaryContact);
  const defaults = { customerId: customer.id };

  const history = [
    ...activities.map((a) => ({ at: a.occurredAt, node: <ActivityLine key={a.id} activity={a} data={data} showCustomer={false} /> })),
    ...cases.map((c) => ({ at: c.createdAt, node: <li key={`c${c.id}`} className="px-4 py-3 text-sm">Ügy megnyitva: <Link href={`/cases/${c.id}`} className="font-medium text-accent hover:underline">{c.title}</Link><p className="text-[13px] text-ink-muted">{formatDateTime(c.createdAt)}</p></li> })),
    ...tasks.filter((t) => t.completedAt).map((t) => ({ at: t.completedAt as string, node: <li key={`t${t.id}`} className="px-4 py-3 text-sm">Feladat elvégezve: {t.title}<p className="text-[13px] text-ink-muted">{formatDateTime(t.completedAt)}</p></li> })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <>
      <PageHeader
        title={customerName(customer)}
        description={customer.type === "person" ? "Magánszemély ügyfél" : "Céges ügyfél"}
        actions={<><Button variant="secondary" onClick={() => setModal("activity")}>Tevékenység rögzítése</Button><Button variant="secondary" onClick={() => setModal("task")}>Új feladat</Button><Button onClick={() => setModal("case")}>Új ügy</Button></>}
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Alapadatok" action={<span className="flex gap-2"><TypeBadge type={customer.type} /><LifecycleBadge status={customer.lifecycleStatus} /></span>} />
          <DescriptionList items={[
            ...(customer.type === "person" ? [{ label: "Vezetéknév", value: customer.lastName }, { label: "Keresztnév", value: customer.firstName }] : [{ label: "Cégnév", value: customer.companyName }]),
            { label: "E-mail", value: customer.email }, { label: "Telefon", value: customer.phone },
            ...(primary ? [{ label: "Elsődleges kapcsolattartó", value: contactName(primary) }] : []),
            { label: "Forrás", value: customer.source }, { label: "Ellenőrzöttség", value: VERIFICATION_LABELS[customer.verificationStatus] },
            { label: "Létrehozva", value: formatDate(customer.createdAt) }, { label: "Módosítva", value: formatDate(customer.updatedAt) },
            ...(customer.type === "person" && customer.notes ? [{ label: "Jegyzet (demó)", value: customer.notes }] : []),
          ]} />
          <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
            <FilterSelect label="Ügyfélstátusz (demó)" value={customer.lifecycleStatus} onChange={(e) => repo.updateCustomerStatus(customer.id, e.target.value as Customer["lifecycleStatus"])}>
              {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
            </FilterSelect>
            <FilterSelect label="Felelős" value={customer.ownerId} onChange={(e) => repo.updateCustomerOwner(customer.id, e.target.value)}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </FilterSelect>
          </div>
        </Card>

        {customer.type === "company" ? <ContactsCard company={customer} contacts={contacts} data={data} /> : null}

        <ContactabilityCard data={data} target={{ customerId: customer.id }} title="Megkereshetőség" />

        <Card>
          <CardHeader title="Kapcsolódó ügyek" count={cases.length} />
          {cases.length ? (
            <ul className="divide-y divide-line">
              {cases.map((c) => {
                const k = contacts.find((x) => x.id === c.companyContactId);
                return (
                  <li key={c.id} className="space-y-1 px-4 py-3">
                    <Link href={`/cases/${c.id}`} className="break-words text-sm font-medium text-accent hover:underline">{c.title}</Link>
                    <CaseBadges c={c} />
                    <p className="text-[13px] text-ink-muted">Felelős: {userName(c.ownerId)}{k ? ` · Kapcsolattartó: ${contactName(k)}` : ""}</p>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyState title="Még nincs ügy" action={<Button size="sm" onClick={() => setModal("case")}>Új ügy</Button>} />}
        </Card>

        <Card>
          <CardHeader title="Feladatok" count={tasks.length} />
          {tasks.length ? <ul className="divide-y divide-line">{tasks.map((t) => <TaskLine key={t.id} task={t} data={data} showCustomer={false} />)}</ul> : <EmptyState title="Nincs feladat" />}
        </Card>

        <Card>
          <CardHeader title="Tevékenységek" count={activities.length} />
          {activities.length ? <ul className="divide-y divide-line">{activities.map((a) => <ActivityLine key={a.id} activity={a} data={data} showCustomer={false} />)}</ul> : <EmptyState title="Nincs rögzített tevékenység" />}
        </Card>

        <Card>
          <CardHeader title="Kapcsolattörténet" count={history.length} />
          {history.length ? <ol className="divide-y divide-line">{history.map((h) => h.node)}</ol> : <EmptyState title="Nincs kapcsolattörténet" />}
        </Card>
      </div>
      <CaseFormModal open={modal === "case"} onClose={() => setModal(null)} defaults={defaults} />
      <TaskFormModal open={modal === "task"} onClose={() => setModal(null)} defaults={defaults} />
      <ActivityFormModal open={modal === "activity"} onClose={() => setModal(null)} defaults={defaults} />
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
