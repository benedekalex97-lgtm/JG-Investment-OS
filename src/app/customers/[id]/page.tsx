"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ActivityItem, DataGate, TaskRow } from "@/components/common";
import { CrmStatusBadge } from "@/components/common";
import { AddTaskForm, RestrictionModal } from "@/components/forms";
import { CustomerDetails } from "@/components/customer-details";
import { StatusPanel } from "@/components/status-panel";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import {
  CHANNEL_LABELS, CLOSURE_LABELS, CONTACTABILITY_LABELS, CONTACTABILITY_STATUSES, CONTACT_CHANNELS, CONTACT_PURPOSES, CRM_STATUS_LABELS, EVIDENCE_LABELS,
  EVIDENCE_STATUSES, OUTREACH_COMPLIANCE_NOTICE, PROCESS_STATUS_LABELS, PURPOSE_LABELS, RESTRICTION_LABELS,
} from "@/domain/constants";
import { customerName, getContactability, statusOf, tasksByStatus } from "@/domain/logic";
import type { Customer, DataSnapshot } from "@/domain/types";
import { formatDate } from "@/lib/format";
import { userName } from "@/components/common";

function ContactabilityCard({ data, target, title }: { data: DataSnapshot; target: { customerId?: string; companyContactId?: string }; title: string }) {
  const { repo } = useDemoData();
  return (
    <div>
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
    </div>
  );
}


/** Megkeresési információk és korlátozás: elérhető, de összecsukva - nem uralja a képernyőt. */
function ComplianceSection({ data, customer, onRestriction }: { data: DataSnapshot; customer: Customer; onRestriction: () => void }) {
  return (
    <Card id="megkeresesi-informaciok">
      <details>
        <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">Megkeresési információk és korlátozás</summary>
        <div className="space-y-3 border-t border-line pt-3">
          <p className="mx-4 rounded-md bg-warn-soft p-3 text-[13px] text-ink">{OUTREACH_COMPLIANCE_NOTICE}</p>
          <div className="px-4"><Button variant="secondary" onClick={onRestriction}>{customer.restriction ? "Korlátozás kezelése" : "Tiltakozás / korlátozás rögzítése"}</Button></div>
          <ContactabilityCard data={data} target={{ customerId: customer.id }} title="Megkereshetőség (demó)" />
        </div>
      </details>
    </Card>
  );
}

/** Régi (v0.2/v0.3) adatok és napló: csak olvasható archívum, a meglévő adat megőrzéséhez. */
function ArchiveSection({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const processes = data.processes.filter((p) => p.customerId === customer.id);
  const log = data.activities.filter((a) => a.customerId === customer.id).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
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
  const [restriction, setRestriction] = useState(false);
  const status = statusOf(customer);
  const view = tasksByStatus(data, customer);
  const hasEarlier = view.earlier.length > 0 || view.unassigned.length > 0;
  return (
    <>
      <PageHeader title={customerName(customer)} description={customer.type === "company" ? "Cég" : "Magánszemély"} actions={<CrmStatusBadge status={status} />} />
      <div className="space-y-6">
        {customer.restriction ? (
          <div role="alert" className="rounded-lg bg-danger-soft p-4 text-sm text-danger ring-1 ring-danger/25">
            <p className="font-semibold">{RESTRICTION_LABELS[customer.restriction.kind]} rögzítve — kimenő kapcsolatfelvételi státusz nem választható</p>
            <p className="mt-1">{customer.restriction.note} ({formatDate(customer.restriction.recordedAt)}, {userName(customer.restriction.recordedBy)})</p>
          </div>
        ) : null}

        <CustomerDetails data={data} customer={customer} />
        <StatusPanel customer={customer} />

        <Card id="feladatok-lista">
          <CardHeader title={`Feladatok — ${CRM_STATUS_LABELS[status]}`} count={view.current.length} />
          {view.current.length ? (
            <ul className="divide-y divide-line">{view.current.map((t) => <TaskRow key={t.id} task={t} data={data} />)}</ul>
          ) : (
            <EmptyState title="Ennél a státusznál még nincs feladat" hint="A hozzáadott feladat automatikusan az aktuális státuszhoz kapcsolódik." />
          )}
          <AddTaskForm customerId={customer.id} statusLabel={CRM_STATUS_LABELS[status]} />
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

        <ComplianceSection data={data} customer={customer} onRestriction={() => setRestriction(true)} />
        <ArchiveSection data={data} customer={customer} />
      </div>
      <RestrictionModal open={restriction} onClose={() => setRestriction(false)} customer={customer} />
    </>
  );
}

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <DataGate>
      {(data) => {
        const customer = data.customers.find((c) => c.id === id);
        if (!customer) return <ErrorState title="Az ügyfél nem található" message="Lehet, hogy a demóadat törlése eltávolította, vagy hibás a hivatkozás." />;
        return <Profile data={data} customer={customer} />;
      }}
    </DataGate>
  );
}
