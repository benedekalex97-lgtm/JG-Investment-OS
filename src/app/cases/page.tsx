"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CaseBadges, CustomerLink, DataGate, userName } from "@/components/common";
import { CaseFormModal } from "@/components/forms";
import { FilterSelect } from "@/components/ui/form";
import { Button, Card, EmptyState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { CASE_STAGES, CASE_STAGE_LABELS, CLOSURE_LABELS, CLOSURE_STATUSES, DEMO_USERS } from "@/domain/constants";
import { contactName } from "@/domain/logic";
import { formatDateTime } from "@/lib/format";

function CasesView() {
  const params = useSearchParams();
  const [closure, setClosure] = useState(params.get("closure") ?? "");
  const [stage, setStage] = useState("");
  const [owner, setOwner] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Ügyek" description="Az ügy az ügyfélhez kapcsolódó önálló üzleti egység; a szakasz és a lezárás külön dimenzió." actions={<Button onClick={() => setOpen(true)}>Új ügy</Button>} />
      <DataGate>
        {(data) => {
          const rows = data.cases.filter((c) => (!closure || c.closureStatus === closure) && (!stage || c.stage === stage) && (!owner || c.ownerId === owner));
          return (
            <Card>
              <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3">
                <FilterSelect label="Lezárás" value={closure} onChange={(e) => setClosure(e.target.value)}>
                  <option value="">Összes</option>
                  {CLOSURE_STATUSES.map((s) => <option key={s} value={s}>{CLOSURE_LABELS[s]}</option>)}
                </FilterSelect>
                <FilterSelect label="Szakasz" value={stage} onChange={(e) => setStage(e.target.value)}>
                  <option value="">Összes</option>
                  {CASE_STAGES.map((s) => <option key={s} value={s}>{CASE_STAGE_LABELS[s]}</option>)}
                </FilterSelect>
                <FilterSelect label="Felelős" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">Összes</option>
                  {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </FilterSelect>
              </div>
              <p className="px-4 pt-3 text-[13px] text-ink-muted" role="status" aria-live="polite">{rows.length} ügy</p>
              {rows.length === 0 ? <EmptyState title="Nincs a szűrésnek megfelelő ügy" /> : (
                <ul className="divide-y divide-line">
                  {rows.map((c) => {
                    const k = data.contacts.find((x) => x.id === c.companyContactId);
                    return (
                      <li key={c.id} className="space-y-1 px-4 py-3">
                        <Link href={`/cases/${c.id}`} className="break-words text-sm font-medium text-accent hover:underline">{c.title}</Link>
                        <CaseBadges c={c} />
                        <p className="text-[13px] text-ink-muted">
                          <CustomerLink id={c.customerId} data={data} /> · Felelős: {userName(c.ownerId)}{k ? ` · Kapcsolattartó: ${contactName(k)}` : ""}
                          {c.nextAction ? ` · Következő lépés: ${c.nextAction} (${formatDateTime(c.nextActionDueAt)})` : ""}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          );
        }}
      </DataGate>
      <CaseFormModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default function CasesPage() {
  return <Suspense fallback={<LoadingState />}><CasesView /></Suspense>;
}
