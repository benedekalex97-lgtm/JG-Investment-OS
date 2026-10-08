"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ActivityLine, CaseBadges, CustomerLink, DataGate, TaskLine } from "@/components/common";
import { ActivityFormModal, TaskFormModal } from "@/components/forms";
import { SelectInput, TextInput } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import { CASE_STAGES, CASE_STAGE_LABELS, CLOSURE_LABELS, CLOSURE_STATUSES, DEMO_USERS } from "@/domain/constants";
import { contactName } from "@/domain/logic";
import type { Case, DataSnapshot } from "@/domain/types";
import { formatDateTime, fromInputValue, toInputValue } from "@/lib/format";

function CaseDetail({ data, c }: { data: DataSnapshot; c: Case }) {
  const { repo } = useDemoData();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [next, setNext] = useState({ action: c.nextAction ?? "", due: toInputValue(c.nextActionDueAt) });
  const [modal, setModal] = useState<"task" | "activity" | null>(null);
  const customer = data.customers.find((x) => x.id === c.customerId);
  const contacts = customer?.type === "company" ? data.contacts.filter((k) => k.companyId === customer.id) : [];
  const tasks = data.tasks.filter((t) => t.caseId === c.id);
  const acts = data.activities.filter((a) => a.caseId === c.id).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

  const update = (patch: Parameters<typeof repo.updateCase>[1]) => {
    const r = repo.updateCase(c.id, patch);
    setErrors(r.ok ? {} : r.errors);
    return r.ok;
  };

  return (
    <>
      <PageHeader title={c.title} description={customer ? undefined : "Ismeretlen ügyfél"} actions={<><Button variant="secondary" onClick={() => setModal("activity")}>Tevékenység rögzítése</Button><Button onClick={() => setModal("task")}>Új feladat</Button></>} />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Ügy adatai" action={<CaseBadges c={c} />} />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <p className="text-sm sm:col-span-2">Ügyfél: <CustomerLink customer={customer} /> {customer ? <Link className="ml-2 text-[13px] text-ink-muted underline" href={`/customers/${customer.id}`}>profil megnyitása</Link> : null}</p>
            <SelectInput label="Szakasz" value={c.stage} onChange={(e) => update({ stage: e.target.value as Case["stage"] })}>
              {CASE_STAGES.map((s) => <option key={s} value={s}>{CASE_STAGE_LABELS[s]}</option>)}
            </SelectInput>
            <SelectInput label="Lezárás" value={c.closureStatus} onChange={(e) => update({ closureStatus: e.target.value as Case["closureStatus"] })}>
              {CLOSURE_STATUSES.map((s) => <option key={s} value={s}>{CLOSURE_LABELS[s]}</option>)}
            </SelectInput>
            <SelectInput label="Felelős" value={c.ownerId} onChange={(e) => update({ ownerId: e.target.value })}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </SelectInput>
            {customer?.type === "company" ? (
              <SelectInput label="Kapcsolattartó" value={c.companyContactId ?? ""} error={errors.companyContactId} onChange={(e) => update({ companyContactId: e.target.value || undefined })}>
                <option value="">— nincs kijelölve —</option>
                {contacts.map((k) => <option key={k.id} value={k.id}>{contactName(k)}</option>)}
              </SelectInput>
            ) : <p className="self-end text-[13px] text-ink-muted">Magánszemély ügyénél nem jelölhető ki céges kapcsolattartó.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Következő lépés és határidő" />
          <form className="grid gap-4 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); update({ nextAction: next.action.trim() || undefined, nextActionDueAt: fromInputValue(next.due) || undefined }); }}>
            <TextInput label="Következő lépés" value={next.action} onChange={(e) => setNext((s) => ({ ...s, action: e.target.value }))} />
            <TextInput label="Határidő" type="datetime-local" value={next.due} error={errors.nextActionDueAt} onChange={(e) => setNext((s) => ({ ...s, due: e.target.value }))} />
            <div><Button type="submit" variant="secondary">Következő lépés mentése</Button></div>
          </form>
          <p className="px-4 pb-4 text-[13px] text-ink-muted">Jelenleg: {c.nextAction ?? "nincs megadva"} · {formatDateTime(c.nextActionDueAt)}</p>
        </Card>

        <Card>
          <CardHeader title="Feladatok" count={tasks.length} />
          {tasks.length ? <ul className="divide-y divide-line">{tasks.map((t) => <TaskLine key={t.id} task={t} data={data} showCustomer={false} />)}</ul> : <EmptyState title="Ehhez az ügyhöz nincs feladat" />}
        </Card>
        <Card>
          <CardHeader title="Tevékenységek" count={acts.length} />
          {acts.length ? <ul className="divide-y divide-line">{acts.map((a) => <ActivityLine key={a.id} activity={a} data={data} showCustomer={false} />)}</ul> : <EmptyState title="Ehhez az ügyhöz nincs tevékenység" />}
        </Card>
      </div>
      <TaskFormModal open={modal === "task"} onClose={() => setModal(null)} defaults={{ customerId: c.customerId, caseId: c.id, companyContactId: c.companyContactId }} />
      <ActivityFormModal open={modal === "activity"} onClose={() => setModal(null)} defaults={{ customerId: c.customerId, caseId: c.id, companyContactId: c.companyContactId }} />
    </>
  );
}

export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <DataGate>
      {(data) => {
        const c = data.cases.find((x) => x.id === id);
        return c ? <CaseDetail data={data} c={c} /> : <ErrorState title="Az ügy nem található" message="Hibás hivatkozás, vagy a demóadat visszaállítása törölte." />;
      }}
    </DataGate>
  );
}
