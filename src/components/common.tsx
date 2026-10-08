"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useDemoData } from "@/data/store";
import {
  ACTIVITY_LABELS, CASE_STAGE_LABELS, CLOSURE_LABELS, CUSTOMER_TYPE_LABELS, DEMO_USERS, LIFECYCLE_LABELS, TASK_STATUS_LABELS,
} from "@/domain/constants";
import { customerName } from "@/domain/logic";
import type { Activity, Case, ClosureStatus, Customer, LifecycleStatus, Task, TaskStatus } from "@/domain/types";
import { formatDate, formatDateTime } from "@/lib/format";
import { Badge, LoadingState, type Tone } from "./ui/primitives";
import type { DataSnapshot } from "@/domain/types";

/** Betöltési állapot kezelése: amíg nincs snapshot, skeletont mutat. */
export function DataGate({ children }: { children: (data: DataSnapshot) => ReactNode }) {
  const { data } = useDemoData();
  if (!data) return <LoadingState />;
  return <>{children(data)}</>;
}

export const userName = (id: string) => DEMO_USERS.find((u) => u.id === id)?.name ?? id;

const LIFECYCLE_TONE: Record<LifecycleStatus, Tone> = { prospect: "info", existing: "ok", former: "neutral", archived: "neutral" };
const TASK_TONE: Record<TaskStatus, Tone> = { open: "neutral", in_progress: "info", done: "ok" };
const CLOSURE_TONE: Record<ClosureStatus, Tone> = { open: "info", won: "ok", lost: "danger", cancelled: "neutral" };

export const LifecycleBadge = ({ status }: { status: LifecycleStatus }) => <Badge tone={LIFECYCLE_TONE[status]}>{LIFECYCLE_LABELS[status]}</Badge>;
export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => <Badge tone={TASK_TONE[status]}>{TASK_STATUS_LABELS[status]}</Badge>;
export const TypeBadge = ({ type }: { type: Customer["type"] }) => <Badge tone="accent">{CUSTOMER_TYPE_LABELS[type]}</Badge>;
export const CaseBadges = ({ c }: { c: Case }) => (
  <span className="flex flex-wrap gap-1.5">
    <Badge>{CASE_STAGE_LABELS[c.stage]}</Badge>
    <Badge tone={CLOSURE_TONE[c.closureStatus]}>{CLOSURE_LABELS[c.closureStatus]}</Badge>
  </span>
);

export function CustomerLink({ customer, id, data }: { customer?: Customer; id?: string; data?: DataSnapshot }) {
  const c = customer ?? data?.customers.find((x) => x.id === id);
  if (!c) return <span className="text-ink-muted">Ismeretlen ügyfél</span>;
  return <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent underline-offset-2 hover:underline">{customerName(c)}</Link>;
}

export function TaskLine({ task, data, showCustomer = true }: { task: Task; data: DataSnapshot; showCustomer?: boolean }) {
  const overdue = task.status !== "done" && Date.parse(task.dueAt) < new Date().setHours(0, 0, 0, 0);
  const c = data.cases.find((x) => x.id === task.caseId);
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={task.status === "done" ? "break-words text-sm text-ink-muted line-through" : "break-words text-sm font-medium"}>{task.title}</span>
        <TaskStatusBadge status={task.status} />
        {overdue ? <Badge tone="danger">Lejárt</Badge> : null}
      </div>
      <p className="text-[13px] text-ink-muted">
        Határidő: {formatDateTime(task.dueAt)} · {userName(task.assigneeId)}
        {showCustomer ? <> · <CustomerLink id={task.customerId} data={data} /></> : null}
        {c ? <> · <Link href={`/cases/${c.id}`} className="underline underline-offset-2">{c.title}</Link></> : null}
      </p>
    </li>
  );
}

export function ActivityLine({ activity, data, showCustomer = true }: { activity: Activity; data: DataSnapshot; showCustomer?: boolean }) {
  const k = data.contacts.find((x) => x.id === activity.companyContactId);
  const c = data.cases.find((x) => x.id === activity.caseId);
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{ACTIVITY_LABELS[activity.type]}</Badge>
        <span className="text-[13px] text-ink-muted">{formatDateTime(activity.occurredAt)} · {userName(activity.ownerId)}</span>
      </div>
      <p className="break-words text-sm">{activity.summary}</p>
      <p className="text-[13px] text-ink-muted">
        {showCustomer ? <CustomerLink id={activity.customerId} data={data} /> : null}
        {k ? <> · Kapcsolattartó: {k.lastName} {k.firstName}</> : null}
        {c ? <> · <Link href={`/cases/${c.id}`} className="underline underline-offset-2">{c.title}</Link></> : null}
      </p>
    </li>
  );
}

export { formatDate };
