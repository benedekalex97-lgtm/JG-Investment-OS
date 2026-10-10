"use client";

import { useEffect, useRef, useState } from "react";
import { ClosureBadge, ProcessTypeBadge, StatusBadge, userName } from "@/components/common";
import { ActivityFormModal, CloseProcessModal, ReopenModal, StatusChangeModal, TaskFormModal } from "@/components/forms";
import { Button } from "@/components/ui/primitives";
import { OUTREACH_CHANNEL_LABELS, PROCESS_SOURCE_LABELS, PROCESS_STATUS_LABELS, PHASE_LABELS } from "@/domain/constants";
import { contactName, lastActivity, nextTask } from "@/domain/logic";
import type { CustomerProcess, DataSnapshot } from "@/domain/types";
import { isActive, isMilestone, nextSteps, statusPhase } from "@/domain/workflow";
import { formatDateTime } from "@/lib/format";

/** Egy folyamat kártyája az ügyféladatlapon: státusz, következő teendő, utolsó aktivitás és a folyamat műveletei. */
export function ProcessCard({ process, data }: { process: CustomerProcess; data: DataSnapshot }) {
  const [modal, setModal] = useState<"status" | "close" | "reopen" | "task" | "activity" | null>(null);
  const contact = data.contacts.find((k) => k.id === process.companyContactId);
  const task = nextTask(data, { processId: process.id });
  const last = lastActivity(data, { processId: process.id });
  const active = isActive(process);
  const steps = nextSteps(process);
  const defaults = { customerId: process.customerId, processId: process.id, companyContactId: process.companyContactId };
  const close = () => setModal(null);
  // A pipeline-kártyáról érkezve (#folyamat-<id>) a folyamat automatikusan látható és fókuszált.
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (window.location.hash === `#folyamat-${process.id}`) {
      ref.current?.scrollIntoView({ block: "center" });
      ref.current?.focus({ preventScroll: true });
      if (ref.current) ref.current.dataset.focused = "true";
    }
  }, [process.id]);
  return (
    <li ref={ref} id={`folyamat-${process.id}`} tabIndex={-1} aria-label={`Folyamat: ${process.title}`} className="scroll-mt-4 space-y-2 px-4 py-4 outline-none data-[focused=true]:bg-accent-soft data-[focused=true]:ring-2 data-[focused=true]:ring-inset data-[focused=true]:ring-accent">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-words text-sm font-semibold">{process.title}</h3>
        <ProcessTypeBadge type={process.type} />
        <StatusBadge status={process.status} />
        {!active ? <ClosureBadge closure={process.closure} /> : null}
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-[13px] text-ink-muted sm:grid-cols-2">
        <div><dt className="inline font-medium">Fázis: </dt><dd className="inline">{PHASE_LABELS[statusPhase(process.status)]}</dd></div>
        <div><dt className="inline font-medium">Felelős: </dt><dd className="inline">{userName(process.ownerId)}</dd></div>
        <div><dt className="inline font-medium">Csatorna / forrás: </dt><dd className="inline">{OUTREACH_CHANNEL_LABELS[process.channel]} / {PROCESS_SOURCE_LABELS[process.source]}</dd></div>
        {contact ? <div><dt className="inline font-medium">Kapcsolattartó: </dt><dd className="inline">{contactName(contact)}</dd></div> : null}
        <div><dt className="inline font-medium">Következő teendő: </dt><dd className="inline">{active ? (task ? `${task.title} (${formatDateTime(task.dueAt)})` : "nincs nyitott teendő") : "—"}</dd></div>
        <div><dt className="inline font-medium">Utolsó aktivitás: </dt><dd className="inline">{last ? formatDateTime(last.occurredAt) : "—"}</dd></div>
        {!active && process.closure.closedAt ? <div><dt className="inline font-medium">Lezárva: </dt><dd className="inline">{formatDateTime(process.closure.closedAt)}{process.closure.closedBy ? ` · ${userName(process.closure.closedBy)}` : ""}{process.closure.reasonNote ? ` · ${process.closure.reasonNote}` : ""}</dd></div> : null}
      </dl>
      {active && steps.next ? (
        <p className="text-[13px] text-ink-muted">
          Következő lehetséges lépés: <strong>{PROCESS_STATUS_LABELS[steps.next]}</strong>
          {isMilestone(steps.next) ? " (szolgáltatói mérföldkő — igazolással rögzíthető, szimulált)" : ""}
          {steps.skipAhead.length || steps.back.length ? " · Előreugrás és visszalépés indoklással lehetséges." : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        {active ? (
          <>
            <Button size="sm" onClick={() => setModal("status")}>Státusz váltása</Button>
            <Button size="sm" variant="secondary" onClick={() => setModal("activity")}>Aktivitás rögzítése</Button>
            <Button size="sm" variant="secondary" onClick={() => setModal("task")}>Új feladat</Button>
            <Button size="sm" variant="secondary" onClick={() => setModal("close")}>Lezárás</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setModal("reopen")}>Újranyitás</Button>
        )}
      </div>
      <StatusChangeModal open={modal === "status"} onClose={close} process={process} />
      <CloseProcessModal open={modal === "close"} onClose={close} process={process} />
      <ReopenModal open={modal === "reopen"} onClose={close} process={process} />
      <TaskFormModal open={modal === "task"} onClose={close} defaults={defaults} />
      <ActivityFormModal open={modal === "activity"} onClose={close} defaults={defaults} />
    </li>
  );
}
