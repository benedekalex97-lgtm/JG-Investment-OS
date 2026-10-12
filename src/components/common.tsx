"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { ACTIVITY_LABELS, CRM_STATUS_LABELS, RESTRICTION_LABELS, VERIFICATION_SOURCE_LABELS } from "@/domain/constants";
import { customerName, inputText, isDone, latestOutput, outputText, statusOf } from "@/domain/logic";
import type { Activity, CrmStatus, Customer, DataSnapshot, Task } from "@/domain/types";
import { formatDate, formatDateTime, fromDateInputValue, toDateInputValue } from "@/lib/format";
import { CloseTaskModal } from "./forms";
import { Badge, LoadingState, type Tone } from "./ui/primitives";

/** Betöltési állapot kezelése: amíg nincs snapshot, skeletont mutat. */
export function DataGate({ children }: { children: (data: DataSnapshot) => ReactNode }) {
  const { data } = useCrmData();
  if (!data) return <LoadingState />;
  return <>{children(data)}</>;
}

/** A rögzítő neve az azonosítóból (a felhasználólista a szerverről jön; ismeretlen azonosító esetén az azonosító látszik). */
export function useUserName(): (id: string) => string {
  const { users } = useCrmData();
  return (id) => users.find((u) => u.id === id)?.name ?? id;
}

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
 * Feladatsor: kompakt - típus/név, határidő, az Input egy sora; a részletek (Input, Output, határidő, lezárás) kinyithatók.
 * Az elvégzettként jelölés (checkbox) NEM zár le azonnal: a „Feladat lezárása” modált nyitja, ahol az Output kiválasztása kötelező
 * (az Áttekintésen is, a megkerülés itt sem lehetséges). Az elvégzett feladat checkboxának kivétele újranyitja (az eredmény-előzmény megmarad).
 * Minden módosítás az adatbázisba mentődik; sikertelen mentésnél hibaüzenet látszik és az állapot nem változik.
 */
export function TaskRow({ task, data, showCustomer = false, showStatus = false }: { task: Task; data: DataSnapshot; showCustomer?: boolean; showStatus?: boolean }) {
  const { repo } = useCrmData();
  const userName = useUserName();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const detailsId = useId();
  const done = isDone(task);
  const overdue = !done && task.dueAt !== undefined && Date.parse(task.dueAt) < new Date().setHours(0, 0, 0, 0);
  const out = latestOutput(task);
  const earlier = (task.outputs ?? []).slice(0, -1);
  const input = inputText(task);

  const run = async (action: () => Promise<{ ok: boolean; errors?: Record<string, string> }>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await action();
    setBusy(false);
    if (!r.ok) setError(r.errors?._form ?? Object.values(r.errors ?? {})[0] ?? "A módosítás nem sikerült.");
  };
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
          <input
            type="checkbox"
            className="h-5 w-5 shrink-0 accent-accent"
            checked={done}
            disabled={busy}
            aria-label={`Elvégezve: ${task.title}`}
            onChange={(e) => (e.target.checked ? setClosing(true) : void run(() => repo.reopenTask(task.id)))}
          />
          <span className="min-w-0">
            <span className={done ? "block break-words text-sm text-ink-muted line-through" : "block break-words text-sm font-medium"}>{task.title}</span>
            {input ? <span className="block max-w-full truncate text-[13px] text-ink-muted">{input.split("\n")[0]}</span> : null}
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
      {error ? <p role="alert" className="pl-8 text-[13px] text-danger">{error}</p> : null}
      {open ? (
        <div id={detailsId} className="mt-2 space-y-3 rounded-md bg-canvas p-3 text-sm sm:ml-8">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs font-medium text-ink-muted">Feladat</dt><dd className="break-words">{task.title}</dd></div>
            <div><dt className="text-xs font-medium text-ink-muted">Státusz, amelyhez tartozik</dt><dd>{task.crmStatus ? CRM_STATUS_LABELS[task.crmStatus] : "Régi feladat (státusz nélkül)"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs font-medium text-ink-muted">Input</dt><dd className="whitespace-pre-wrap break-words">{input || "— nincs megadva —"}</dd></div>
            <div><dt className="text-xs font-medium text-ink-muted">Határidő</dt><dd>{task.dueAt ? formatDate(task.dueAt) : "Nincs"}</dd></div>
            <div><dt className="text-xs font-medium text-ink-muted">Lezárás időpontja</dt><dd>{done && task.completedAt ? formatDateTime(task.completedAt) : "—"}</dd></div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-ink-muted">Output</dt>
              <dd className="whitespace-pre-wrap break-words">
                {out ? outputText(out) : done ? <em>Korábbi feladat — eredmény nincs rögzítve</em> : "— még nincs lezárva —"}
                {out ? <span className="block text-[13px] text-ink-muted">Rögzítette: {userName(out.closedBy)} · {formatDateTime(out.closedAt)}</span> : null}
              </dd>
            </div>
          </dl>
          {earlier.length ? (
            <details>
              <summary className="min-h-9 cursor-pointer text-[13px] font-medium">Korábbi lezárások eredménye ({earlier.length})</summary>
              <ul className="mt-1 space-y-2">
                {[...earlier].reverse().map((o, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words text-[13px]">{outputText(o)}<span className="block text-ink-muted">{userName(o.closedBy)} · {formatDateTime(o.closedAt)}</span></li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs font-medium text-ink-muted">
              Határidő módosítása
              <input type="date" disabled={busy} value={toDateInputValue(task.dueAt)} onChange={(e) => void run(() => repo.setTaskDue(task.id, fromDateInputValue(e.target.value) || null))} className="mt-1 block min-h-11 rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
            </label>
            {task.dueAt ? <button type="button" disabled={busy} onClick={() => void run(() => repo.setTaskDue(task.id, null))} className="min-h-11 rounded-md px-2 text-[13px] font-medium text-accent underline underline-offset-2">Határidő törlése</button> : null}
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
  const userName = useUserName();
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
