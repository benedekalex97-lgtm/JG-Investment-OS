"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import {
  ACTIVITY_LABELS, CALL_OUTCOME_LABELS, CLOSURE_LABELS, CONTACT_STATUS_LABELS, CUSTOMER_TYPE_LABELS, DEMO_USERS, NO_RESULT_REASON_LABELS,
  PROCESS_STATUS_LABELS, PROCESS_TYPE_LABELS, TASK_STATUS_LABELS, VERIFICATION_SOURCE_LABELS,
} from "@/domain/constants";
import { customerName } from "@/domain/logic";
import type { Activity, ContactStatus, Customer, CustomerProcess, DataSnapshot, ProcessStatus, Task } from "@/domain/types";
import { statusPhase } from "@/domain/workflow";
import { formatDateTime, fromInputValue, toInputValue } from "@/lib/format";
import { FilterSelect } from "./ui/form";
import { Badge, LoadingState, type Tone } from "./ui/primitives";

/** Betöltési állapot kezelése: amíg nincs snapshot, skeletont mutat. */
export function DataGate({ children }: { children: (data: DataSnapshot) => ReactNode }) {
  const { data } = useDemoData();
  if (!data) return <LoadingState />;
  return <>{children(data)}</>;
}

export const userName = (id: string) => DEMO_USERS.find((u) => u.id === id)?.name ?? id;

const CONTACT_TONE: Record<ContactStatus, Tone> = { prospect: "info", existing_verified: "ok", former_verified: "neutral", archived: "neutral" };
export const ContactStatusBadge = ({ status }: { status: ContactStatus }) => <Badge tone={CONTACT_TONE[status]}>{CONTACT_STATUS_LABELS[status]}</Badge>;
export const TypeBadge = ({ type }: { type: Customer["type"] }) => <Badge tone="accent">{CUSTOMER_TYPE_LABELS[type]}</Badge>;
export const ProcessTypeBadge = ({ type }: { type: CustomerProcess["type"] }) => <Badge>{PROCESS_TYPE_LABELS[type]}</Badge>;
export const StatusBadge = ({ status }: { status: ProcessStatus }) => <Badge tone={statusPhase(status) === "sales" ? "accent" : "info"}>{PROCESS_STATUS_LABELS[status]}</Badge>;
export const TaskStatusBadge = ({ status }: { status: Task["status"] }) => <Badge tone={status === "done" ? "ok" : status === "in_progress" ? "info" : "neutral"}>{TASK_STATUS_LABELS[status]}</Badge>;
export function ClosureBadge({ closure }: { closure: CustomerProcess["closure"] }) {
  const tone: Tone = closure.state === "active" ? "info" : closure.state === "closed_success" ? "ok" : "neutral";
  return <Badge tone={tone}>{CLOSURE_LABELS[closure.state]}{closure.reason ? `: ${NO_RESULT_REASON_LABELS[closure.reason]}` : ""}</Badge>;
}

export function CustomerLink({ customer, id, data }: { customer?: Customer; id?: string; data?: DataSnapshot }) {
  const c = customer ?? data?.customers.find((x) => x.id === id);
  if (!c) return <span className="text-ink-muted">Ismeretlen ügyfél</span>;
  return <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent underline-offset-2 hover:underline">{customerName(c)}</Link>;
}

/** Feladatsor: elvégzés pipával, határidő és felelős módosítása; minden változás naplózódik. */
export function TaskRow({ task, data, showCustomer = true }: { task: Task; data: DataSnapshot; showCustomer?: boolean }) {
  const { repo, currentUserId } = useDemoData();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const done = task.status === "done";
  const overdue = !done && Date.parse(task.dueAt) < new Date().setHours(0, 0, 0, 0);
  const process = data.processes.find((p) => p.id === task.processId);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5 accent-accent" checked={done} aria-label={`Elvégzett: ${task.title}`} onChange={(e) => repo.setTaskStatus(task.id, e.target.checked ? "done" : "open", currentUserId)} />
          <span className={done ? "break-words text-sm text-ink-muted line-through" : "break-words text-sm font-medium"}>{task.title}</span>
        </label>
        <TaskStatusBadge status={task.status} />
        {overdue ? <Badge tone="danger">Lejárt</Badge> : null}
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="ml-auto min-h-9 rounded-md px-2 text-[13px] font-medium text-accent underline underline-offset-2">{open ? "Bezár" : "Módosítás"}</button>
      </div>
      <p className="text-[13px] text-ink-muted">
        Határidő: {formatDateTime(task.dueAt)} · {userName(task.assigneeId)}
        {showCustomer ? <> · <CustomerLink id={task.customerId} data={data} /></> : null}
        {process ? <> · {process.title}</> : null}
      </p>
      {open ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <FilterSelect label="Állapot" value={task.status} onChange={(e) => repo.setTaskStatus(task.id, e.target.value as Task["status"], currentUserId)}>
            {(["open", "in_progress", "done"] as const).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
          </FilterSelect>
          <FilterSelect label="Felelős" value={task.assigneeId} onChange={(e) => repo.updateTask(task.id, { assigneeId: e.target.value }, currentUserId)}>
            {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </FilterSelect>
          <label className="block text-xs font-medium text-ink-muted">
            Határidő
            <input type="datetime-local" value={toInputValue(task.dueAt)} aria-invalid={Boolean(err)} onChange={(e) => {
              const iso = fromInputValue(e.target.value);
              if (!iso) return setErr("Érvénytelen dátum");
              const r = repo.updateTask(task.id, { dueAt: iso }, currentUserId);
              setErr(r.ok ? "" : Object.values(r.errors)[0]);
            }} className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
            {err ? <span role="alert" className="text-danger">{err}</span> : null}
          </label>
        </div>
      ) : null}
    </li>
  );
}

const SYSTEM_TONE: Partial<Record<Activity["type"], Tone>> = { provider_milestone: "warn", contact_status_change: "accent", restriction_change: "danger", process_closed: "ok" };

/** Egységes aktivitássor (idővonal-elem). */
export function ActivityItem({ activity, data, showCustomer = false }: { activity: Activity; data: DataSnapshot; showCustomer?: boolean }) {
  const contact = data.contacts.find((x) => x.id === activity.companyContactId);
  const process = data.processes.find((x) => x.id === activity.processId);
  const m = activity.meta;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SYSTEM_TONE[activity.type] ?? (["call", "note", "meeting", "follow_up"].includes(activity.type) ? "accent" : "neutral")}>{ACTIVITY_LABELS[activity.type]}</Badge>
        {activity.callOutcome ? <Badge tone={activity.callOutcome === "interested" || activity.callOutcome === "consultation_scheduled" ? "ok" : "neutral"}>{CALL_OUTCOME_LABELS[activity.callOutcome]}</Badge> : null}
        <span className="text-[13px] text-ink-muted">{formatDateTime(activity.occurredAt)} · Rögzítette: {userName(activity.recordedBy)}</span>
      </div>
      <p className="mt-1 break-words text-sm">{activity.summary}</p>
      <p className="text-[13px] text-ink-muted">
        {showCustomer ? <><CustomerLink id={activity.customerId} data={data} /> · </> : null}
        {contact ? <>Kapcsolattartó: {contact.lastName} {contact.firstName} · </> : null}
        {process ? <>Folyamat: {process.title}</> : null}
        {m?.reason ? <> · Indok: {m.reason}</> : null}
        {m?.verification ? <> · Igazolás: {VERIFICATION_SOURCE_LABELS[m.verification.sourceCategory]}, rögzítve {formatDateTime(m.verification.recordedAt)} (szimulált)</> : null}
      </p>
    </li>
  );
}
