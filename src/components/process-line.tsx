"use client";

import Link from "next/link";
import { CustomerLink, StatusBadge, userName } from "@/components/common";
import { PROCESS_TYPE_LABELS } from "@/domain/constants";
import { lastActivity, nextTask } from "@/domain/logic";
import type { CustomerProcess, DataSnapshot } from "@/domain/types";
import { formatDateTime } from "@/lib/format";

/** Folyamatsor az Áttekintés munkapultjához: ügyfél, státusz, felelős, következő teendő. */
export function ProcessLine({ process, data }: { process: CustomerProcess; data: DataSnapshot }) {
  const task = nextTask(data, { processId: process.id });
  const last = lastActivity(data, { processId: process.id });
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/customers/${process.customerId}#folyamat-${process.id}`} className="break-words text-sm font-medium text-accent hover:underline">{process.title}</Link>
        <StatusBadge status={process.status} />
      </div>
      <p className="text-[13px] text-ink-muted">
        <CustomerLink id={process.customerId} data={data} /> · {PROCESS_TYPE_LABELS[process.type]} · Felelős: {userName(process.ownerId)}
        {task ? <> · Következő teendő: {task.title} ({formatDateTime(task.dueAt)})</> : <> · Nincs nyitott teendő</>}
        {last ? <> · Utolsó aktivitás: {formatDateTime(last.occurredAt)}</> : null}
      </p>
    </li>
  );
}
