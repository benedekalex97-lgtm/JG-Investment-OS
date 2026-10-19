import { ACTIVITY_LABELS, CALL_OUTCOME_LABELS, CRM_STATUS_LABELS, TASK_OUTCOME_LABELS, VERIFICATION_SOURCE_LABELS } from "./constants";
import type { Activity, DataSnapshot, TaskOutcome } from "./types";

/**
 * Előzmények (v0.9): az ügyfél naplózott eseményei (Activity) időrendben, a legfrissebb elöl. Csak olvasó, megjelenítési leképezés:
 * a tárolt naplóbejegyzések nem módosulnak, és a régi bejegyzések nem kapnak utólag kitalált adatot (pl. Sikeres/Sikertelen minősítést).
 * Az ügyféljegyzetek (`note`) külön funkció, ezért itt nem jelennek meg.
 */
export type HistoryDetail = { label: string; value: string; multiline?: boolean };

export interface HistoryEntry {
  id: string;
  occurredAt: string;
  /** Az esemény megnevezése, pl. „Feladat lezárva — Sikeres”. */
  title: string;
  /** Lezárási minősítés (csak az új lezárásokon) - a visszafogott színjelzéshez. */
  outcome?: TaskOutcome;
  kind: "task" | "status" | "other";
  details: HistoryDetail[];
  recordedBy: string;
}

const isDue = (v: unknown): v is string | null => v === null || typeof v === "string";

/** A „Feladat …: <cím>” formájú régi összefoglalóból a cím (ha a feladat már nem található). */
const titleFromSummary = (summary: string) => {
  const i = summary.indexOf(": ");
  return i >= 0 ? summary.slice(i + 2) : "";
};

export function historyEntry(a: Activity, snap: Pick<DataSnapshot, "tasks" | "processes">, formatDate: (iso?: string) => string): HistoryEntry {
  const m = a.meta ?? {};
  const task = m.taskId ? snap.tasks.find((t) => t.id === m.taskId) : undefined;
  const base = { id: a.id, occurredAt: a.occurredAt, recordedBy: a.recordedBy };
  const taskLine = (fallback: string): HistoryDetail[] => {
    const title = task?.title ?? fallback;
    return title ? [{ label: "Feladat", value: title }] : [];
  };

  switch (a.type) {
    case "task_created":
      return { ...base, kind: "task", title: "Feladat létrehozva", details: taskLine(titleFromSummary(a.summary)) };
    case "task_completed": {
      const outcome = m.taskOutcome;
      // Régi (v0.8-ig) lezárás: nincs minősítés - nem találunk ki értéket, a régi Output (címke vagy szöveg) változatlanul látszik.
      const details: HistoryDetail[] = [...taskLine(outcome ? titleFromSummary(a.summary) : "")];
      if (m.output) details.push({ label: "Output", value: m.output, multiline: true });
      if (!outcome && !task && !m.output) details.push({ label: "Összefoglaló", value: a.summary });
      return { ...base, kind: "task", outcome, title: outcome ? `Feladat lezárva — ${TASK_OUTCOME_LABELS[outcome]}` : "Feladat lezárva", details };
    }
    case "task_updated": {
      if (m.taskChange === "rescheduled" || (m.taskChange === undefined && isDue(m.toDueAt))) {
        const details = [
          ...taskLine(titleFromSummary(a.summary)),
          { label: "Korábbi határidő", value: m.fromDueAt ? formatDate(m.fromDueAt) : "nem volt megadva" },
          { label: "Új határidő", value: m.toDueAt ? formatDate(m.toDueAt) : "törölve" },
        ];
        return { ...base, kind: "task", title: m.toDueAt ? "Feladat átidőzítve" : "Feladat határideje törölve", details };
      }
      if (m.taskChange === "reopened" || a.summary.startsWith("Feladat újranyitva")) {
        return { ...base, kind: "task", title: "Feladat újranyitva", details: taskLine(titleFromSummary(a.summary)) };
      }
      return { ...base, kind: "task", title: ACTIVITY_LABELS.task_updated, details: [{ label: "Összefoglaló", value: a.summary }] };
    }
    case "crm_status_change":
      return {
        ...base, kind: "status", title: ACTIVITY_LABELS.crm_status_change,
        details: m.fromCrmStatus && m.toCrmStatus
          ? [{ label: "Korábbi státusz", value: CRM_STATUS_LABELS[m.fromCrmStatus] }, { label: "Új státusz", value: CRM_STATUS_LABELS[m.toCrmStatus] }]
          : [{ label: "Összefoglaló", value: a.summary }],
      };
    default: {
      // Minden más (régi) naplózott esemény változatlan összefoglalóval, a megőrzött kiegészítő adatokkal.
      const details: HistoryDetail[] = [{ label: "Összefoglaló", value: a.summary, multiline: true }];
      const process = a.processId ? snap.processes.find((p) => p.id === a.processId) : undefined;
      if (process) details.push({ label: "Régi folyamat", value: process.title });
      if (a.callOutcome) details.push({ label: "Híváseredmény", value: CALL_OUTCOME_LABELS[a.callOutcome] });
      if (m.reason) details.push({ label: "Indok", value: m.reason });
      if (m.output) details.push({ label: "Eredmény", value: m.output, multiline: true });
      if (m.verification) details.push({ label: "Igazolás (szimulált)", value: VERIFICATION_SOURCE_LABELS[m.verification.sourceCategory] });
      const kind = a.type === "provider_milestone" || a.type === "contact_status_change" ? "status" : "other";
      return { ...base, kind, title: ACTIVITY_LABELS[a.type] ?? a.type, details };
    }
  }
}

/** Az ügyfél előzményei: minden naplózott esemény a jegyzetek kivételével, a legfrissebb elöl (azonos időpontnál azonosító szerint, determinisztikusan). */
export function customerHistory(snap: DataSnapshot, customerId: string, formatDate: (iso?: string) => string): HistoryEntry[] {
  return snap.activities
    .filter((a) => a.customerId === customerId && a.type !== "note")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((a) => historyEntry(a, snap, formatDate));
}
