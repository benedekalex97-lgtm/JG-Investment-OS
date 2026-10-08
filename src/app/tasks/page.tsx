"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CustomerLink, DataGate, TaskStatusBadge } from "@/components/common";
import { TaskFormModal } from "@/components/forms";
import { FilterSelect } from "@/components/ui/form";
import { Button, Card, EmptyState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import { DEMO_USERS, TASK_STATUSES, TASK_STATUS_LABELS } from "@/domain/constants";
import { overdueTasks, tasksDueToday } from "@/domain/logic";
import type { Task, TaskStatus } from "@/domain/types";
import { formatDateTime, fromInputValue, toInputValue } from "@/lib/format";

const VIEWS = [
  { id: "open", label: "Nyitott" }, { id: "today", label: "Mai" }, { id: "overdue", label: "Lejárt" }, { id: "done", label: "Elvégzett" }, { id: "all", label: "Összes" },
] as const;

function TaskRow({ task, caseTitle, data }: { task: Task; caseTitle?: string; data: Parameters<typeof CustomerLink>[0]["data"] }) {
  const { repo } = useDemoData();
  const [err, setErr] = useState("");
  const done = task.status === "done";
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5 accent-accent" checked={done} onChange={(e) => repo.setTaskStatus(task.id, e.target.checked ? "done" : "open")} />
          <span className={done ? "break-words text-sm text-ink-muted line-through" : "break-words text-sm font-medium"}>{task.title}</span>
        </label>
        <TaskStatusBadge status={task.status} />
      </div>
      <p className="text-[13px] text-ink-muted">
        <CustomerLink id={task.customerId} data={data} />
        {task.caseId ? <> · <Link className="underline underline-offset-2" href={`/cases/${task.caseId}`}>{caseTitle ?? "Ügy"}</Link></> : null}
        {" · "}Határidő: {formatDateTime(task.dueAt)}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <FilterSelect label="Állapot" value={task.status} onChange={(e) => repo.setTaskStatus(task.id, e.target.value as TaskStatus)}>
          {TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
        </FilterSelect>
        <FilterSelect label="Felelős" value={task.assigneeId} onChange={(e) => repo.updateTask(task.id, { assigneeId: e.target.value })}>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </FilterSelect>
        <label className="block text-xs font-medium text-ink-muted">
          Határidő módosítása
          <input type="datetime-local" value={toInputValue(task.dueAt)} aria-invalid={Boolean(err)} onChange={(e) => {
            const iso = fromInputValue(e.target.value);
            if (!iso) return setErr("Érvénytelen dátum");
            const r = repo.updateTask(task.id, { dueAt: iso });
            setErr(r.ok ? "" : Object.values(r.errors)[0]);
          }} className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
          {err ? <span role="alert" className="text-danger">{err}</span> : null}
        </label>
      </div>
    </li>
  );
}

function TasksView() {
  const params = useSearchParams();
  const initial = VIEWS.find((v) => v.id === params.get("view"))?.id ?? "open";
  const [view, setView] = useState<string>(initial);
  const [assignee, setAssignee] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Feladatok" description="Nyitott, folyamatban lévő és elvégzett feladatok a közös csapatnézetben." actions={<Button onClick={() => setOpen(true)}>Új feladat</Button>} />
      <DataGate>
        {(data) => {
          const now = new Date();
          const base =
            view === "today" ? tasksDueToday(data, now) : view === "overdue" ? overdueTasks(data, now)
            : view === "done" ? data.tasks.filter((t) => t.status === "done")
            : view === "open" ? data.tasks.filter((t) => t.status !== "done") : data.tasks;
          const rows = base.filter((t) => !assignee || t.assigneeId === assignee).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
          return (
            <Card>
              <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-end sm:justify-between">
                <div role="group" aria-label="Nézet" className="flex flex-wrap gap-2">
                  {VIEWS.map((v) => (
                    <Button key={v.id} size="sm" variant={view === v.id ? "primary" : "secondary"} aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</Button>
                  ))}
                </div>
                <FilterSelect label="Felelős" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="sm:w-56">
                  <option value="">Összes</option>
                  {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </FilterSelect>
              </div>
              <p className="px-4 pt-3 text-[13px] text-ink-muted" role="status" aria-live="polite">{rows.length} feladat</p>
              {rows.length === 0 ? <EmptyState title="Nincs feladat ebben a nézetben" /> : (
                <ul className="divide-y divide-line">
                  {rows.map((t) => <TaskRow key={t.id} task={t} data={data} caseTitle={data.cases.find((c) => c.id === t.caseId)?.title} />)}
                </ul>
              )}
            </Card>
          );
        }}
      </DataGate>
      <TaskFormModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default function TasksPage() {
  return <Suspense fallback={<LoadingState />}><TasksView /></Suspense>;
}
