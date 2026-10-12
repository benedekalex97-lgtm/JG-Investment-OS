"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import { ACTIVITY_LABELS, CRM_STATUS_LABELS, DEMO_USERS, RESTRICTION_LABELS, VERIFICATION_SOURCE_LABELS } from "@/domain/constants";
import { customerName, isDone, latestOutput, statusOf } from "@/domain/logic";
import type { Activity, CrmStatus, Customer, DataSnapshot, Task } from "@/domain/types";
import { formatDate, formatDateTime, fromDateInputValue, toDateInputValue } from "@/lib/format";
import { CloseTaskModal } from "./forms";
import { Badge, LoadingState, type Tone } from "./ui/primitives";

/** Betöltési állapot kezelése: amíg nincs snapshot, skeletont mutat. */
export function DataGate({ children }: { children: (data: DataSnapshot) => ReactNode }) {
  const { data } = useDemoData();
  if (!data) return <LoadingState />;
  return <>{children(data)}</>;
}

export const userName = (id: string) => DEMO_USERS.find((u) => u.id === id)?.name ?? id;

const CRM_TONE: Record<CrmStatus, Tone> = {
  waiting_for_contact: "neutral", contact: "info", relationship: "info", meeting: "accent", account_opening: "accent", capital_placed: "ok", lost: "danger",
};
export const CrmStatusBadge = ({ status }: { status: CrmStatus }) => <Badge tone={CRM_TONE[status]}>{CRM_STATUS_LABELS[status]}</Badge>;
export const TypeBadge = ({ type }: { type: Customer["type"] }) => <Badge tone="accent">{type === "company" ? "Cég" : "Magánszemély"}</Badge>;

/** Rövid, csak olvasható jelzés az aktív tiltakozásról/korlátozásról (nem compliance-panel). */
export const RestrictedBadge = ({ customer }: { customer: Customer }) => (customer.restriction ? <Badge tone="danger" className="shrink-0"><span title={`${RESTRICTION_LABELS[customer.restriction.kind]}: ${customer.restriction.note}`}>Megkeresés korlátozva</span></Badge> : null);
export { statusOf };

export function CustomerLink({ customer, id, data }: { customer?: Customer; id?: string; data?: DataSnapshot }) {
  const c = customer ?? data?.customers.find((x) => x.id === id);
  if (!c) return <span className="text-ink-muted">Ismeretlen ügyfél</span>;
  return <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent underline-offset-2 hover:underline">{customerName(c)}</Link>;
}

/**
 * Feladatsor (v0.5.1): kompakt - típus/név, határidő, a leírás egy sora; a részletek (Input, Output, határidő, lezárás) kinyithatók.
 * Az elvégzettként jelölés (checkbox) NEM zár le azonnal: a „Feladat lezárása” modált nyitja, ahol az Output kitöltése kötelező
 * (az Áttekintésen is, a megkerülés itt sem lehetséges). Az elvégzett feladat checkboxának kivétele újranyitja (az Output-előzmény megmarad).
 */
export function TaskRow({ task, data, showCustomer = false, showStatus = false }: { task: Task; data: DataSnapshot; showCustomer?: boolean; showStatus?: boolean }) {
  const { repo, currentUserId } = useDemoData();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const detailsId = useId();
  const done = isDone(task);
  const overdue = !done && task.dueAt !== undefined && Date.parse(task.dueAt) < new Date().setHours(0, 0, 0, 0);
  const out = latestOutput(task);
  const earlier = (task.outputs ?? []).slice(0, -1);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
          <input
            type="checkbox"
            className="h-5 w-5 shrink-0 accent-accent"
            checked={done}
            aria-label={`Elvégezve: ${task.title}`}
            onChange={(e) => (e.target.checked ? setClosing(true) : repo.setTaskStatus(task.id, "open", currentUserId))}
          />
          <span className="min-w-0">
            <span className={done ? "block break-words text-sm text-ink-muted line-through" : "block break-words text-sm font-medium"}>{task.title}</span>
            {task.description ? <span className="block max-w-full truncate text-[13px] text-ink-muted">{task.description.split("\n")[0]}</span> : null}
          </span>
        </label>
        {overdue ? <Badge tone="danger">Lejárt</Badge> : null}
        {showStatus && task.crmStatus ? <Badge>{CRM_STATUS_LABELS[task.crmStatus]}</Badge> : null}
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)} className="min-h-9 rounded-md px-2 text-[13px] font-medium text-accent underline underline-offset-2">Részletek</button>
      </div>
      <p className="pl-8 text-[13px] text-ink-muted">
        {task.dueAt ? `Határidő: ${formatDate(task.dueAt)}` : "Nincs határidő"}
        {showCustomer ? <> · <CustomerLink id={task.customerId} data={data} /></> : null}
        {done && task.completedAt ? ` · Elvégezve: ${formatDate(task.completedAt)}` : ""}
      </p>
      {open ? (
        <div id={detailsId} className="mt-2 space-y-3 rounded-md bg-canvas p-3 text-sm sm:ml-8">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs font-medium text-ink-muted">Feladat</dt><dd className="break-words">{task.title}</dd></div>
            <div><dt className="text-xs font-medium text-ink-muted">Státusz, amelyhez tartozik</dt><dd>{task.crmStatus ? CRM_STATUS_LABELS[task.crmStatus] : "Régi feladat (státusz nélkül)"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs font-medium text-ink-muted">Input</dt><dd className="whitespace-pre-wrap break-words">{task.description || "— nincs megadva —"}</dd></div>
            <div><dt className="text-xs font-medium text-ink-muted">Határidő</dt><dd>{task.dueAt ? formatDate(task.dueAt) : "Nincs"}</dd></div>
            <div><dt className="text-xs font-medium text-ink-muted">Lezárás időpontja</dt><dd>{done && task.completedAt ? formatDateTime(task.completedAt) : "—"}</dd></div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-ink-muted">Output</dt>
              <dd className="whitespace-pre-wrap break-words">
                {out ? out.text : done ? <em>Korábbi feladat — eredmény nincs rögzítve</em> : "— még nincs lezárva —"}
                {out ? <span className="block text-[13px] text-ink-muted">Rögzítette: {userName(out.closedBy)} · {formatDateTime(out.closedAt)}</span> : null}
              </dd>
            </div>
          </dl>
          {earlier.length ? (
            <details>
              <summary className="min-h-9 cursor-pointer text-[13px] font-medium">Korábbi lezárások eredménye ({earlier.length})</summary>
              <ul className="mt-1 space-y-2">
                {[...earlier].reverse().map((o, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words text-[13px]">{o.text}<span className="block text-ink-muted">{userName(o.closedBy)} · {formatDateTime(o.closedAt)}</span></li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs font-medium text-ink-muted">
              Határidő módosítása
              <input type="date" value={toDateInputValue(task.dueAt)} onChange={(e) => repo.updateTask(task.id, { dueAt: fromDateInputValue(e.target.value) || null }, currentUserId)} className="mt-1 block min-h-11 rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
            </label>
            {task.dueAt ? <button type="button" onClick={() => repo.updateTask(task.id, { dueAt: null }, currentUserId)} className="min-h-11 rounded-md px-2 text-[13px] font-medium text-accent underline underline-offset-2">Határidő törlése</button> : null}
          </div>
        </div>
      ) : null}
      <CloseTaskModal open={closing} onClose={() => setClosing(false)} task={task} />
    </li>
  );
}

const SYSTEM_TONE: Partial<Record<Activity["type"], Tone>> = { provider_milestone: "warn", contact_status_change: "accent", crm_status_change: "accent", restriction_change: "danger", process_closed: "ok" };

/** Naplósor (csak olvasható archívum/előzmény). */
export function ActivityItem({ activity, data }: { activity: Activity; data: DataSnapshot }) {
  const process = data.processes.find((x) => x.id === activity.processId);
  const m = activity.meta;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SYSTEM_TONE[activity.type] ?? "neutral"}>{ACTIVITY_LABELS[activity.type]}</Badge>
        <span className="text-[13px] text-ink-muted">{formatDateTime(activity.occurredAt)} · Rögzítette: {userName(activity.recordedBy)}</span>
      </div>
      <p className="mt-1 break-words text-sm">{activity.summary}</p>
      <p className="text-[13px] text-ink-muted">
        {process ? <>Régi folyamat: {process.title}</> : null}
        {m?.reason ? <> · Indok: {m.reason}</> : null}
        {m?.output ? <> · Eredmény: {m.output}</> : null}
        {m?.verification ? <> · Igazolás: {VERIFICATION_SOURCE_LABELS[m.verification.sourceCategory]}, rögzítve {formatDateTime(m.verification.recordedAt)} (szimulált)</> : null}
      </p>
    </li>
  );
}
